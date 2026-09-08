import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { Bonjour, type Service } from "bonjour-service";
import { DEEP_LINK_PROTOCOL, DEFAULT_PORT, MDNS_SERVICE_TYPE } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const isTest = process.env.SLACKOSS_TEST === "1";
// Branding must not move existing settings, credentials, or hosted databases.
const legacyUserData = app.getPath("userData");
app.setName("Gatherline");
app.setPath("userData", process.env.SLACKOSS_USER_DATA_DIR ?? legacyUserData);
let mainWindow: BrowserWindow | null = null;

if ((isDev || isTest) && process.env.SLACKOSS_TEST_MEDIA === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  // Fake mic/camera so huddles can be exercised without real hardware.
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

// ---------- slackoss:// deep links ----------

/** Held until a window exists to receive it (cold start via a link). */
let pendingDeepLink: string | null = null;

function deliverDeepLink(url: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    pendingDeepLink = url;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send("deeplink", url);
}

function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.startsWith(`${DEEP_LINK_PROTOCOL}://`)) ?? null;
}

// A second launch must hand its link to the running instance, not open a
// second window with its own embedded server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) deliverDeepLink(url);
    else {
      const win = BrowserWindow.getAllWindows()[0];
      win?.focus();
    }
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
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [
    join(import.meta.dirname, "../.."),
  ]);
} else if (!isTest) {
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
}

ipcMain.handle("deeplink:consume", () => {
  const url = pendingDeepLink;
  pendingDeepLink = null;
  return url;
});

// ---------- settings storage (plain JSON in userData) ----------

const settingsPath = () => join(app.getPath("userData"), "settings.json");
let settingsCache: Record<string, unknown> | null = null;
let settingsRead: Promise<Record<string, unknown>> | null = null;
let settingsWrite: Promise<void> = Promise.resolve();

async function readSettings(): Promise<Record<string, unknown>> {
  if (settingsCache) return settingsCache;
  if (settingsRead) return settingsRead;
  settingsRead = (async () => {
    try {
      settingsCache = JSON.parse(await readFile(settingsPath(), "utf8")) as Record<string, unknown>;
    } catch {
      settingsCache = {};
    }
    return settingsCache;
  })();
  return settingsRead;
}

ipcMain.handle("storage:get", async (_e, key: string) => {
  await settingsWrite.catch(() => {});
  const s = await readSettings();
  return s[key] ?? null;
});

ipcMain.handle("storage:set", (_e, key: string, value: unknown) => {
  // Serialize independent draft/settings writes. Publish the new cache only
  // after replacing the file, so a failed save cannot look persisted to readers.
  settingsWrite = settingsWrite
    .catch(() => {})
    .then(async () => {
      const s = await readSettings();
      const next = { ...s, [key]: value };
      await mkdir(app.getPath("userData"), { recursive: true });
      const temporary = `${settingsPath()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2));
      await rename(temporary, settingsPath());
      settingsCache = next;
    });
  return settingsWrite;
});

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

let hosted: WorkspaceServer | null = null;
let hostedName: string | null = null;

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
  return hosted
    ? { running: true, port: hosted.port, lanUrls: lanUrls(hosted.port) }
    : { running: false };
}

ipcMain.handle("hosting:status", () => hostingStatus());

ipcMain.handle("hosting:start", async (_e, opts: { workspaceName: string; port?: number }) => {
  if (hosted) return hostingStatus();
  const slug =
    opts.workspaceName
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "workspace";
  const dataDir = join(app.getPath("userData"), "hosted", slug);
  const start = (port: number) =>
    createWorkspaceServer({
      dataDir,
      port,
      workspaceName: opts.workspaceName,
      mdns: true,
      webDistPath: app.isPackaged
        ? join(process.resourcesPath, "web")
        : join(import.meta.dirname, "../../../web/dist"),
    });

  try {
    hosted = await start(opts.port ?? DEFAULT_PORT);
  } catch (err) {
    // Something else already has the default port (often another workspace on
    // this machine). Take any free one — mDNS advertises whatever we land on.
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    hosted = await start(0);
  }
  hostedName = opts.workspaceName;
  const s = await readSettings();
  s["lastHosted"] = { workspaceName: opts.workspaceName, port: hosted.port };
  await writeFile(settingsPath(), JSON.stringify(s, null, 2));
  return hostingStatus();
});

ipcMain.handle("hosting:stop", async () => {
  await hosted?.stop();
  hosted = null;
  hostedName = null;
});

// ---------- window ----------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    show: !isTest,
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#111820",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#111820",
      symbolColor: "#b1c0cd",
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

  // Huddles need the microphone, and screen share needs display capture.
  // Grant those to our own renderer; refuse everything else.
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
          (permission === "media" || permission === "display-capture"),
      );
    },
  );
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) => {
    return (
      wc === mainWindow?.webContents &&
      trustedRenderer(details.requestingUrl ?? wc.getURL()) &&
      (permission === "media" || permission === "display-capture")
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
  createWindow();
  startDiscovery();
  // A cold start from a link arrives in argv rather than as an event.
  const initial = deepLinkFromArgv(process.argv);
  if (initial) pendingDeepLink = initial;

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Keep serving while hosting a workspace, even with the window closed (Windows/Linux tray-less v1: quit unless hosting).
  if (process.platform !== "darwin" && !hosted) app.quit();
});

let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (hosted) {
    event.preventDefault();
    void hosted.stop().finally(() => {
      bonjour.destroy();
      app.quit();
    });
  } else bonjour.destroy();
});
