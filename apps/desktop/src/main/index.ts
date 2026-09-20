import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} from "electron";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { Bonjour, type Service } from "bonjour-service";
import { DEEP_LINK_PROTOCOLS, DEFAULT_PORT, MDNS_SERVICE_TYPE } from "@slackoss/protocol";
import { createWorkspaceServer } from "@slackoss/server";
import { createSettingsStorage } from "./settings.js";
import { createHostingController, parseLastHosted } from "./hosting.js";
import { findCloudflared, openQuickTunnel } from "./tunnel.js";

const isDev = !!process.env.ELECTRON_RENDERER_URL;
/** Gatherline name first, previous SLACKOSS_ name still read. */
const appEnv = (name: string): string | undefined =>
  process.env[`GATHERLINE_${name}`] ?? process.env[`SLACKOSS_${name}`];
const isTest = appEnv("TEST") === "1";
// Branding must not move existing settings, credentials, or hosted databases.
const legacyUserData = app.getPath("userData");
app.setName("Gatherline");
app.setPath("userData", appEnv("USER_DATA_DIR") ?? legacyUserData);
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let rendererReady = false;
let quitting = false;
let quitReady = false;
let quitTask: Promise<void> | null = null;

ipcMain.handle("file:download", (event, value: unknown) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || typeof value !== "string")
    throw new Error("Invalid download request");
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    !/\/api\/files\/[0-9A-HJKMNP-TV-Z]{26}$/.test(url.pathname) ||
    !/^[a-f0-9]{64}$/.test(url.searchParams.get("download") ?? "") ||
    [...url.searchParams.keys()].some((key) => key !== "download")
  )
    throw new Error("Invalid download URL");
  mainWindow.webContents.downloadURL(url.toString());
});

if ((isDev || isTest) && appEnv("TEST_MEDIA") === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  // Fake mic/camera so huddles can be exercised without real hardware.
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

// ---------- gatherline:// deep links (slackoss:// still opens) ----------

/** Held until a window exists to receive it (cold start via a link). */
let pendingDeepLink: string | null = null;

function deliverDeepLink(url: string): void {
  pendingDeepLink = url;
  const win = showMainWindow();
  if (win && rendererReady) {
    pendingDeepLink = null;
    win.webContents.send("deeplink", url);
  }
}

function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => DEEP_LINK_PROTOCOLS.some((p) => a.startsWith(`${p}://`))) ?? null;
}

// A second launch must hand its link to the running instance, not open a
// second window with its own embedded server.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) deliverDeepLink(url);
    else showMainWindow();
  });
}

// macOS delivers links through this event rather than argv.
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

if (!isTest && isDev && process.platform === "win32") {
  // In dev the executable is electron.exe, so the protocol must point at it
  // plus this project's entry, or Windows would launch a bare Electron.
  for (const protocol of DEEP_LINK_PROTOCOLS) {
    app.setAsDefaultProtocolClient(protocol, process.execPath, [
      join(import.meta.dirname, "../.."),
    ]);
  }
} else if (!isTest) {
  for (const protocol of DEEP_LINK_PROTOCOLS) {
    app.setAsDefaultProtocolClient(protocol);
  }
}

// A notification clicked while the window is minimized, or closed to the tray
// while hosting, brings the window back as well as opening its message.
ipcMain.handle("window:reveal", (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;
  showMainWindow();
});

ipcMain.handle("deeplink:consume", (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return null;
  rendererReady = true;
  const url = pendingDeepLink;
  pendingDeepLink = null;
  return url;
});

// ---------- settings and OS-protected saved sign-ins ----------

const settings = createSettingsStorage(join(app.getPath("userData"), "settings.json"), {
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
});

ipcMain.handle("storage:get", (_e, key: string, options?: { strict?: boolean }) =>
  settings.get(key, options),
);

const writeSetting = (key: string, value: unknown) => settings.set(key, value);
ipcMain.handle("storage:set", (_e, key: string, value: unknown) => writeSetting(key, value));

// ---------- LAN discovery (mDNS browse) ----------

const bonjour = new Bonjour();
const discovered = new Map<string, Service>();

function publishDiscovered(): void {
  const servers = [...discovered.values()].map((s) => ({
    name: (s.txt as Record<string, string>)?.name ?? s.name,
    host: pickAddress(s.addresses ?? []),
    port: s.port,
    serverVersion: (s.txt as Record<string, string>)?.ver ?? "?",
  }));
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lan:servers", servers);
  }
}

function pickAddress(addresses: string[]): string {
  return addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? addresses[0] ?? "";
}

function startDiscovery(): void {
  const browser = bonjour.find({ type: MDNS_SERVICE_TYPE });
  browser.on("up", (service) => {
    discovered.set(service.fqdn, service);
    publishDiscovered();
  });
  browser.on("down", (service) => {
    discovered.delete(service.fqdn);
    publishDiscovered();
  });
}

ipcMain.handle("lan:snapshot", () => {
  return [...discovered.values()].map((s) => ({
    name: (s.txt as Record<string, string>)?.name ?? s.name,
    host: pickAddress(s.addresses ?? []),
    port: s.port,
    serverVersion: (s.txt as Record<string, string>)?.ver ?? "?",
  }));
});

// ---------- "Open to LAN" hosting (server runs in this process) ----------

function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(`${iface.address}:${port}`);
    }
  }
  return out;
}

function hostingStatus() {
  return { ...hosting.status(), backgroundAvailable: !!tray && !tray.isDestroyed() };
}

/** Looked up again at most every few seconds, so installing it takes effect without a restart. */
let cloudflaredLookup: { at: number; path: string | null } | null = null;
function cloudflared(): string | null {
  if (!cloudflaredLookup || Date.now() - cloudflaredLookup.at > 5_000)
    cloudflaredLookup = { at: Date.now(), path: findCloudflared() };
  return cloudflaredLookup.path;
}

const hosting = createHostingController({
  dataRoot: join(app.getPath("userData"), "hosted"),
  defaultPort: DEFAULT_PORT,
  lanUrls,
  saveLastHosted: (value) => writeSetting("lastHosted", value),
  onChange: publishHostingStatus,
  startServer: async ({ dataDir, port, workspaceName }) => {
    const server = await createWorkspaceServer({
      dataDir,
      port,
      workspaceName,
      mdns: true,
      webDistPath: app.isPackaged
        ? join(process.resourcesPath, "web")
        : join(import.meta.dirname, "../../../web/dist"),
    });
    return {
      port: server.port,
      stop: () => server.stop(),
      setPublicUrl: (url) => server.setPublicUrl(url),
      // cloudflared reaches this embedded server from loopback. Believe its
      // visitor address only while the controller owns a live connector.
      setTrustLoopbackProxy: (enabled) => server.setTrustLoopbackProxy(enabled),
      setIceServers: (servers) => server.setIceServers(servers),
      inviteOnly: () => server.inviteOnly(),
      setInviteOnly: (value) => server.setInviteOnly(value),
      accountCount: () => server.store.userCount(),
    };
  },
  tunnelAvailable: () => cloudflared() !== null,
  openTunnel: (port, signal) => {
    cloudflaredLookup = null;
    const command = cloudflared();
    if (!command)
      throw new Error(
        "Open to all needs Cloudflare's free cloudflared tool. Install it, then try again.",
      );
    return openQuickTunnel({ command, port, signal });
  },
});

ipcMain.handle("hosting:status", () => hostingStatus());
ipcMain.handle("hosting:lastHosted", async () => {
  // Unreadable settings mean no remembered workspace, not a failed call:
  // the join screen simply shows no resume offer.
  const stored = await settings.get("lastHosted").catch(() => null);
  return parseLastHosted(stored);
});
ipcMain.handle("hosting:start", async (_e, opts: unknown) => {
  if (quitting) throw new Error("Gatherline is shutting down. Try again after reopening it.");
  if (trayStopPending)
    throw new Error("Finish the stop-hosting confirmation before starting a workspace.");
  await hosting.start(opts);
  return hostingStatus();
});
ipcMain.handle("hosting:stop", () => hosting.stop());
ipcMain.handle("hosting:openToAll", async (_e, opts: unknown) => {
  if (quitting) throw new Error("Gatherline is shutting down.");
  await hosting.openToAll(opts);
  return hostingStatus();
});
ipcMain.handle("hosting:endOpenToAll", async () => {
  await hosting.endOpenToAll();
  return hostingStatus();
});
ipcMain.handle("hosting:setInviteOnly", async (_e, value: unknown) => {
  await hosting.setInviteOnly(value);
  return hostingStatus();
});

function publishHostingStatus(): void {
  const status = hostingStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("hosting:changed", status);
  }
  updateTray();
}

function showMainWindow(): BrowserWindow | null {
  if (!app.isReady() || quitting) return null;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  if (!isTest) win.show();
  win.focus();
  return win;
}

async function confirmStop(forQuit: boolean): Promise<boolean> {
  const choice = await dialog.showMessageBox({
    type: "question",
    title: forQuit ? "Stop hosting and quit?" : "Stop hosting?",
    message: forQuit
      ? "Quit Gatherline and stop the hosted workspace?"
      : "Stop the hosted workspace?",
    detail:
      "Teammates will be disconnected until you start hosting again. Stored messages and files stay on this computer.",
    buttons: ["Cancel", forQuit ? "Stop hosting and quit" : "Stop hosting"],
    defaultId: 0,
    cancelId: 0,
  });
  return choice.response === 1;
}

let trayStopPending = false;
async function stopFromTray(): Promise<void> {
  if (trayStopPending || quitting) return;
  trayStopPending = true;
  updateTray();
  try {
    if (await confirmStop(false)) await hosting.stop();
  } catch {
    showMainWindow();
    await dialog.showMessageBox({
      type: "error",
      message: "The workspace could not be stopped. Open hosting controls and try again.",
    });
  } finally {
    trayStopPending = false;
    updateTray();
  }
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const status = hosting.status();
  const label =
    status.phase === "starting"
      ? "Starting workspace…"
      : status.phase === "stopping"
        ? "Stopping workspace…"
        : status.running
          ? `Hosting ${status.workspaceName} · ${status.openToAll?.phase === "open" ? "open to all" : `port ${status.port}`}`
          : "Not hosting";
  tray.setToolTip(`Gatherline — ${label}`.slice(0, 127));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Gatherline",
        click: () => {
          showMainWindow();
        },
      },
      { label: label.replaceAll("&", "&&"), enabled: false },
      {
        label: "Stop hosting…",
        enabled: status.phase === "running" && !quitting && !trayStopPending,
        click: () => {
          void stopFromTray().catch(() => {});
        },
      },
      { type: "separator" },
      {
        label: status.phase === "stopped" ? "Quit Gatherline" : "Stop hosting and quit…",
        enabled: !quitting && !trayStopPending,
        click: () => app.quit(),
      },
    ]),
  );
}

function createTray(): void {
  try {
    const file = process.platform === "win32" ? "icon.ico" : "icon.png";
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, "tray", file)
      : join(import.meta.dirname, "../../build", file);
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("Tray icon is missing.");
    tray = new Tray(
      process.platform === "win32" ? iconPath : icon.resize({ width: 18, height: 18 }),
    );
    tray.on("click", () => {
      showMainWindow();
    });
    tray.on("double-click", () => {
      showMainWindow();
    });
    updateTray();
  } catch {
    tray?.destroy();
    tray = null;
    // A desktop without tray support keeps a hosted window in the taskbar.
  }
}

// ---------- window ----------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    show: !isTest,
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    // The ground and ink-dim colours of packages/ui/src/theme.css: the window
    // shows this before the page paints, and the overlay sits on top of the page.
    backgroundColor: "#191d29",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#191d29",
      symbolColor: "#c1c8db",
      height: 40,
    },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  const win = mainWindow;
  rendererReady = false;
  win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rendererReady = false;
  });
  win.on("close", (event) => {
    if (quitReady) return;
    if (quitting || hosting.status().phase !== "stopped") {
      event.preventDefault();
      if (hostingStatus().backgroundAvailable) win.hide();
      else win.minimize();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
      rendererReady = false;
    }
  });

  // Huddles need the microphone, screen share needs display capture, and
  // notifications need their own permission: refused, the renderer's
  // Notification reports "denied" and never shows. Grant those to our own
  // renderer; refuse everything else.
  const allowed = new Set(["media", "display-capture", "notifications"]);
  const rendererUrl = isDev
    ? process.env.ELECTRON_RENDERER_URL!
    : pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href;
  const trustedRenderer = (url: string) => {
    try {
      const parsed = new URL(url);
      const expected = new URL(rendererUrl);
      return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
    } catch {
      return false;
    }
  };
  mainWindow.webContents.session.setPermissionRequestHandler(
    (wc, permission, callback, details) => {
      callback(
        wc === mainWindow?.webContents &&
          details.isMainFrame &&
          trustedRenderer(details.requestingUrl) &&
          allowed.has(permission),
      );
    },
  );
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) => {
    return (
      wc === mainWindow?.webContents &&
      trustedRenderer(details.requestingUrl ?? wc.getURL()) &&
      allowed.has(permission)
    );
  });
  mainWindow.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!request.frame || !trustedRenderer(request.frame.url)) {
        callback({});
        return;
      }
      try {
        const screens = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (screens.length === 0) {
          callback({});
          return;
        }
        const choice = await dialog.showMessageBox(mainWindow!, {
          type: "question",
          title: "Share your screen",
          message: "Choose a screen to share with this huddle",
          detail: "Everyone in the huddle will see everything on the selected screen.",
          buttons: ["Cancel", ...screens.map((screen) => screen.name)],
          defaultId: 0,
          cancelId: 0,
        });
        const selected = screens[choice.response - 1];
        callback(selected ? { video: selected } : {});
      } catch {
        callback({});
      }
    },
    { useSystemPicker: true },
  );
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  // External links open in the OS browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  if (!primaryInstance) return;
  const initial = deepLinkFromArgv(process.argv);
  if (initial && !pendingDeepLink) pendingDeepLink = initial;
  createTray();
  createWindow();
  startDiscovery();
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS keeps an app with no windows running either way; the dock reopens it.
  if (process.platform === "darwin") return;
  if (hosting.status().phase === "stopped") app.quit();
  // A server with nothing on screen and no tray to reach it by would be invisible.
  else if (!quitting && !tray) showMainWindow();
});

app.on("before-quit", (event) => {
  if (quitReady || !primaryInstance) return;
  event.preventDefault();
  if (quitTask || trayStopPending) return;
  quitting = true;
  updateTray();
  quitTask = (async () => {
    if (hosting.status().phase !== "stopped" && !(await confirmStop(true))) {
      quitting = false;
      updateTray();
      return;
    }
    await hosting.shutdown();
    quitReady = true;
    tray?.destroy();
    tray = null;
    bonjour.destroy();
    app.quit();
  })()
    .catch(async () => {
      const choice = await dialog.showMessageBox({
        type: "error",
        title: "The workspace could not finish stopping",
        message: "Keep Gatherline open, or quit without waiting for the remaining work?",
        detail:
          "Shutdown failed. Quitting anyway ends the process immediately and may lose unfinished changes. Existing workspace data is not deleted.",
        buttons: ["Keep open", "Quit anyway"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response === 1) {
        tray?.destroy();
        // Only the user's explicit response to a failed shutdown may bypass draining.
        app.exit(1);
      } else {
        quitting = false;
        showMainWindow();
        updateTray();
      }
    })
    .finally(() => {
      quitTask = null;
      if (!quitReady && quitting) {
        quitting = false;
        showMainWindow();
        updateTray();
      }
    });
  void quitTask.catch(() => {});
});
