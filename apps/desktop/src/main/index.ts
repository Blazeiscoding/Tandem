import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} from "electron";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { Bonjour, type Service } from "bonjour-service";
import { DEEP_LINK_PROTOCOLS, DEFAULT_PORT, MDNS_SERVICE_TYPE } from "@slackoss/protocol";
import { createWorkspaceServer } from "@slackoss/server";
import createBackupWorker from "./backupWorker?nodeWorker";
import type { BackupJob, BackupReply } from "./backupWorker.js";
import { createSettingsStorage } from "./settings.js";
import { createHostingController } from "./hosting.js";
import { loginItemOptions, loginItemProblem, openedAtLogin } from "./loginItem.js";
import {
  findCloudflared,
  openConfiguredAddress,
  openNamedTunnel,
  openQuickTunnel,
  probeHealth,
  resolvePublicAddress,
  validatePublicAddress,
  type PublicAddressConfig,
} from "./tunnel.js";

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

/**
 * The saved address, kept in memory because hosting status is read far more
 * often than it changes and a settings read cannot block a snapshot. Loaded
 * once at startup and updated by whoever writes it.
 */
let savedPublicAddress: string | null = null;

/** Read again on the same schedule, so a corrected setting needs no restart. */
let publicAddressLookup: { at: number; config: PublicAddressConfig } | null = null;
function publicAddressConfig(): PublicAddressConfig {
  if (!publicAddressLookup || Date.now() - publicAddressLookup.at > 5_000)
    publicAddressLookup = { at: Date.now(), config: resolvePublicAddress(savedPublicAddress) };
  return publicAddressLookup.config;
}

/** Opening to all needs no cloudflared when something else already carries the address. */
function publicAddressCarriedElsewhere(): boolean {
  const config = publicAddressConfig();
  return !!config && !("error" in config) && config.carrier === "elsewhere";
}

/** What the hosting status reports about the stable address, for display and editing. */
function publicAddressStatus(): {
  setting?: string;
  locked?: boolean;
  url?: string;
  managed?: boolean;
  error?: string;
} {
  const config = publicAddressConfig();
  // A saved address the app can change, against one the environment fixed.
  const fromEnvironment = !savedPublicAddress;
  const setting =
    savedPublicAddress ??
    (config && !("error" in config) && config.carrier === "elsewhere" ? config.publicUrl : null);
  return {
    ...(setting ? { setting } : {}),
    ...(setting && fromEnvironment ? { locked: true } : {}),
    ...(config && "error" in config ? { error: config.error } : {}),
    ...(config && !("error" in config)
      ? { url: config.publicUrl, ...(config.carrier === "gatherline" ? { managed: true } : {}) }
      : {}),
  };
}

/**
 * Runs a backup, check or restore on a worker thread, so the window and the
 * hosted server keep answering while SQLite copies or checks the database.
 */
function inWorker<T>(job: BackupJob): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = createBackupWorker({ workerData: job });
    let settled = false;
    worker.once("message", (reply: BackupReply) => {
      settled = true;
      if (reply.ok) resolve(reply.result as T);
      else reject(new Error(reply.message));
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`The backup stopped before it finished (exit code ${code}).`));
    });
  });
}

const hosting = createHostingController({
  dataRoot: join(app.getPath("userData"), "hosted"),
  defaultPort: DEFAULT_PORT,
  lanUrls,
  settings,
  backupWorkspace: (options) => inWorker({ kind: "backup", ...options }),
  verifyBackup: (dir) => inWorker({ kind: "verify", dir }),
  restoreWorkspace: (options) => inWorker({ kind: "restore", ...options }),
  freeBytes: async (dir) => {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  },
  openFolder: (path) => shell.openPath(path),
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
    const configured = publicAddressConfig();
    // An external carrier may already be forwarding this port, and an app-owned
    // connector may have survived an ungraceful exit. Never leave registration
    // open while any stable public address is configured.
    if (configured && !("error" in configured)) server.setInviteOnly(true);
    return {
      port: server.port,
      instanceId: server.instanceId,
      workspaceId: () => server.store.getMeta("workspace_id") ?? null,
      workspaceName: () => server.store.getMeta("workspace_name") ?? workspaceName ?? "",
      setWorkspaceName: (name) => server.setWorkspaceName(name),
      reannounce: () => server.reannounce(),
      connectedPeople: () => server.connectedPeople(),
      onConnectedChange: (listener) => server.onConnectedChange(listener),
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
  verifyLoopback: async (port, instanceId) =>
    // Only a reply from something that is not this run proves the port leads
    // elsewhere. A probe that cannot connect at all proves nothing, and must
    // not produce a warning naming a program that may not be there.
    (await probeHealth(
      `http://127.0.0.1:${port}/api/health`,
      AbortSignal.timeout(3_000),
      instanceId,
    )) !== "something-else",
  tunnelAvailable: () => cloudflared() !== null || publicAddressCarriedElsewhere(),
  publicAddress: publicAddressStatus,
  savePublicAddress: async (address) => {
    try {
      await writeSetting("publicAddress", address);
    } catch {
      // Filesystem errors can contain the Windows account name and profile
      // path. Give the renderer a useful message without leaking either.
      throw new Error(
        "Gatherline could not save the public address. Check that its settings folder is writable, then try again.",
      );
    }
    savedPublicAddress = address;
    publicAddressLookup = null;
  },
  openTunnel: (port, signal, instanceId) => {
    cloudflaredLookup = null;
    publicAddressLookup = null;
    const configured = publicAddressConfig();
    if (configured && "error" in configured) throw new Error(configured.error);
    if (configured && !instanceId)
      throw new Error("The hosted workspace cannot verify its public address. Restart hosting.");
    // Nothing to install or start when something else already carries the
    // address here; the workspace only has to answer at it.
    if (configured?.carrier === "elsewhere")
      return openConfiguredAddress({ ...configured, port, signal, instanceId: instanceId! });
    const command = cloudflared();
    if (!command)
      throw new Error(
        "Open to all needs Cloudflare's free cloudflared tool. Install it, then try again.",
      );
    if (configured)
      return openNamedTunnel({ ...configured, command, port, signal, instanceId: instanceId! });
    return openQuickTunnel({ command, port, signal, instanceId });
  },
});

ipcMain.handle("hosting:status", () => hostingStatus());
// Unreadable settings mean no remembered workspace, not a failed call: the
// join screen simply shows no resume offer.
ipcMain.handle("hosting:lastHosted", () => hosting.lastHosted());
ipcMain.handle("hosting:list", () => hosting.list());
ipcMain.handle("hosting:forget", (_e, folder: unknown) => hosting.forget(folder));
ipcMain.handle("hosting:rename", (_e, request: unknown) => hosting.rename(request));
// The window names a listed workspace; the controller finds its folder.
ipcMain.handle("hosting:openFolder", (_e, folder: unknown) => hosting.openFolder(folder));
ipcMain.handle("hosting:setPort", (_e, request: unknown) => hosting.setPort(request));
/**
 * Turns a workspace's scheduled backups on, changes them, or turns them off.
 * Only the system's folder dialog chooses where they go: the window can ask
 * for one, but never names a path itself.
 */
ipcMain.handle(
  "hosting:setAutoBackup",
  async (event, folder: unknown, schedule: unknown, chooseFolder: unknown) => {
    if (quitting) throw new Error("Gatherline is shutting down.");
    if (schedule === null) return hosting.setAutoBackup({ folder, schedule: null });
    const { everyDays, keep } = (schedule ?? {}) as Record<string, unknown>;
    let destination: string | undefined;
    if (chooseFolder === true) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: "Choose where to keep the backups",
        buttonLabel: "Back up here",
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      };
      const choice = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      // Choosing no folder changes nothing.
      if (choice.canceled || !choice.filePaths[0]) return undefined;
      destination = choice.filePaths[0];
    }
    const saved = await hosting.setAutoBackup({
      folder,
      schedule: { everyDays, keep, ...(destination ? { destination } : {}) },
    });
    // A workspace not backed up yet is due at once, so the first backup is made
    // now, where the host can see it happen, rather than in a quarter of an hour.
    void hosting.runDueBackups();
    return saved;
  },
);
ipcMain.handle("hosting:setStartOnLaunch", (_e, folder: unknown) =>
  hosting.setStartOnLaunch(folder),
);

// ---------- starting with the computer ----------

/**
 * The OS opens only an installed app at sign-in: a copy run from source would
 * register Electron itself. Linux has no single place for it that Electron
 * manages, so it is offered on Windows and macOS.
 */
const loginItemAvailable =
  app.isPackaged && (process.platform === "win32" || process.platform === "darwin");
/** Tests must never register the real app with the OS; they get this instead. */
let testOpenAtLogin = false;

function openAtLogin(): boolean | null {
  if (!loginItemAvailable) return null;
  if (isTest) return testOpenAtLogin;
  return app.getLoginItemSettings(loginItemOptions(process.platform)).openAtLogin;
}

ipcMain.handle("hosting:openAtLogin", () => openAtLogin());
ipcMain.handle("hosting:setOpenAtLogin", (_e, open: unknown) => {
  if (typeof open !== "boolean")
    throw new Error("Say whether to open at sign-in with true or false.");
  if (!loginItemAvailable)
    throw new Error("Opening at sign-in needs Gatherline installed on Windows or macOS.");
  if (isTest) {
    testOpenAtLogin = open;
    return openAtLogin();
  }
  const options = loginItemOptions(process.platform);
  app.setLoginItemSettings({ openAtLogin: open, ...options });
  const problem = loginItemProblem(process.platform, open, app.getLoginItemSettings(options));
  if (problem) throw new Error(problem);
  return openAtLogin();
});

/** This computer's own network addresses, to notice when they change. */
function addressKey(): string {
  return lanUrls(0).sort().join(" ");
}

/**
 * A workspace announces itself on the interfaces there were when it started,
 * and the host dialog lists the addresses there were when it last looked.
 * After a wake, or a move to another network, both are redone. There is no
 * event for a network change, so the addresses are compared every few seconds.
 */
function followNetworkChanges(): void {
  let known = addressKey();
  powerMonitor.on("resume", () => {
    known = addressKey();
    hosting.networkChanged();
  });
  setInterval(() => {
    const now = addressKey();
    if (now === known) return;
    known = now;
    hosting.networkChanged();
  }, 10_000).unref();
}
ipcMain.handle("hosting:restore", async (event) => {
  if (quitting) throw new Error("Gatherline is shutting down.");
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Choose the folder of a backup to restore",
    buttonLabel: "Restore",
    properties: ["openDirectory"] as "openDirectory"[],
  };
  const choice = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (choice.canceled || !choice.filePaths[0]) return null;
  return hosting.restore({ backupDir: choice.filePaths[0] });
});
ipcMain.handle("hosting:backup", async (event, folder: unknown) => {
  if (quitting) throw new Error("Gatherline is shutting down.");
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Choose where to save the backup",
    buttonLabel: "Back up here",
    properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
  };
  const choice = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  // Choosing no folder is not a failure: nothing happens.
  if (choice.canceled || !choice.filePaths[0]) return null;
  return hosting.backup({ folder, destination: choice.filePaths[0] });
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
ipcMain.handle("hosting:setPublicAddress", async (_e, value: unknown) => {
  if (typeof value !== "string") throw new Error("Enter the address as text.");
  const address = value.trim();
  // Refuse here rather than saving something Open to all would only reject
  // later, when the setting is out of sight.
  const saving = address ? validatePublicAddress(address) : null;
  // The controller serializes this with opening/closing, secures registration
  // before an external carrier can be trusted, and clears errors from the old
  // carrier only after persistence succeeds.
  await hosting.setPublicAddress(saving);
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
          ? `Hosting ${status.workspaceName} · ${status.openToAll?.phase === "open" ? "open to all" : `port ${status.port}`}${
              status.connected !== undefined ? ` · ${status.connected} connected` : ""
            }`
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

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  // Unreadable settings mean no saved address, not a failed launch. The
  // environment can still supply one, and Manage hosting can save a new one.
  const stored = await settings.get("publicAddress").catch(() => null);
  savedPublicAddress = typeof stored === "string" && stored.trim() ? stored.trim() : null;
  publicAddressLookup = null;
  const initial = deepLinkFromArgv(process.argv);
  if (initial && !pendingDeepLink) pendingDeepLink = initial;
  createTray();
  followNetworkChanges();
  // Scheduled backups: once the app has settled, then every quarter hour.
  setTimeout(() => void hosting.runDueBackups(), 60_000).unref();
  setInterval(() => void hosting.runDueBackups(), 15 * 60_000).unref();
  // Opened by the OS at sign-in, with a workspace hosting and a tray to reach
  // it by, Gatherline stays out of the way. Otherwise the window opens, and
  // hosting starts meanwhile: it enters "starting" long before the window asks.
  const loginSettings = loginItemAvailable && !isTest ? app.getLoginItemSettings() : {};
  if (openedAtLogin(process.platform, process.argv, loginSettings)) {
    const hosted = await hosting.startForLaunch().catch(() => null);
    if (!hosted?.running || !tray) createWindow();
  } else {
    void hosting.startForLaunch().catch(() => {});
    createWindow();
  }
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
