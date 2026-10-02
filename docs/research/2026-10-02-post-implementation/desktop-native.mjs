/** Hidden native probes against the fresh package; no existing sign-ins/data. */
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(join(root, "package.json"));
const { _electron } = require("@playwright/test");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  windowsHide: true,
  encoding: "utf8",
}).trim();
const directory = await mkdtemp(join(tmpdir(), "tandem-desktop-post-native-"));
function assertOwned() {
  const within = relative(resolve(tmpdir()), resolve(directory));
  if (
    !within ||
    within.startsWith("..") ||
    isAbsolute(within) ||
    !directory.includes("tandem-desktop-post-native-")
  )
    throw new Error("Unsafe native fixture directory");
}
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function poll(fn, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(75);
  }
  throw new Error(`Timed out: ${description}`);
}
const { ELECTRON_RUN_AS_NODE: ignored, ...inherited } = process.env;
const apps = [];
const report = {
  revision,
  capturedAt: new Date().toISOString(),
  scope:
    "Packaged hidden Electron probes with synthetic data; native dialog responses instrumented, no actual installation/registry changes",
  probes: [],
};
async function launch(name, options = {}) {
  const data = join(directory, name);
  await mkdir(data, { recursive: true });
  const app = await _electron.launch({
    executablePath:
      options.executablePath ?? join(root, "apps/desktop/release/win-unpacked/Tandem.exe"),
    args: options.args ?? [],
    timeout: 20000,
    env: {
      ...inherited,
      TANDEM_TEST: "1",
      TANDEM_TEST_MEDIA: "0",
      TANDEM_USER_DATA_DIR: data,
      ...options.env,
    },
  });
  apps.push({ app, process: app.process(), data });
  return { app, data };
}
async function killAll() {
  for (const { process } of apps)
    if (process.exitCode === null && process.pid)
      spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  await pause(250);
}
try {
  assertOwned();
  const { app, data } = await launch("package");
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.slackoss?.storageGet === "function", undefined, {
    timeout: 15000,
  });
  report.runtime = await app.evaluate(() => process.versions);
  report.packaged = await app.evaluate(({ app }) => app.isPackaged);
  await app.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.desktopPostDialogs = [];
    globalThis.desktopPostLoads = 0;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.desktopPostDialogs.push({ message: options.message, buttons: options.buttons });
      return { response: 0, checkboxChecked: false };
    };
    BrowserWindow.getAllWindows()[0].webContents.on(
      "did-finish-load",
      () => globalThis.desktopPostLoads++,
    );
  });
  const synthetic = [
    {
      url: "http://127.0.0.1:1",
      token: "post-audit-not-a-secret",
      workspaceName: "Synthetic only",
      handle: "post-audit",
      lastUsedAt: 1,
    },
  ];
  await page.evaluate((servers) => window.slackoss.storageSet("servers", servers), synthetic);
  const primaryRead = await page.evaluate(() => window.slackoss.storageGet("servers"));
  const foreignId = await app.evaluate(
    async ({ BrowserWindow }, preload) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await window.loadURL("about:blank");
      return window.webContents.id;
    },
    join(root, "apps/desktop/release/win-unpacked/resources/app.asar/out/preload/index.cjs"),
  );
  let foreign;
  await poll(() => {
    foreign = app
      .windows()
      .find((candidate) => candidate !== page && candidate.url() === "about:blank");
    return !!foreign;
  }, "foreign native window");
  const guards = await foreign.evaluate(async () => {
    const rejected = async (fn) => {
      try {
        await fn();
        return "ACCEPTED";
      } catch (error) {
        return error.message;
      }
    };
    return {
      href: location.href,
      read: await rejected(() => window.slackoss.storageGet("servers")),
      write: await rejected(() =>
        window.slackoss.storageSet("desktop-post-foreign", "untrusted-write"),
      ),
      hosting: await rejected(() => window.slackoss.hostingStatus()),
      download: await rejected(() => window.slackoss.downloadFile("not-a-url")),
    };
  });
  const disk = JSON.parse(await readFile(join(data, "settings.json"), "utf8"));
  report.probes.push({
    name: "inbound-ipc-fix",
    primarySyntheticReadWorks: primaryRead[0]?.token === "post-audit-not-a-secret",
    foreign: guards,
    foreignWritePersisted: Object.hasOwn(disk, "desktop-post-foreign"),
    credentialsEncryptedAtRest: disk.servers?.kind === "gatherline.saved-servers",
    limitation:
      "Foreign BrowserWindow is harness-created with the real preload; no ordinary remote/UI creation path demonstrated",
  });
  await foreign.evaluate(() => {
    window.desktopPostEvents = [];
    window.slackoss.onDraftsChanged((key, stored) =>
      window.desktopPostEvents.push({ kind: "drafts", key, stored }),
    );
    window.slackoss.onOutboxChanged((key, stored) =>
      window.desktopPostEvents.push({ kind: "outbox", key, stored }),
    );
  });
  await page.evaluate(async () => {
    await window.slackoss.storageMergeDrafts(
      "desktop-post-drafts",
      { put: { "audit-channel": "synthetic private draft text" }, remove: [] },
      false,
    );
    await window.slackoss.storageMergeOutbox(
      "desktop-post-outbox",
      {
        put: [
          {
            nonce: "synthetic-nonce",
            channelId: "audit-channel",
            threadRootId: null,
            text: "synthetic unsent message text",
            userId: "audit-user",
            createdAt: Date.now(),
            attachments: [],
            rev: Date.now() * 1000,
          },
        ],
        remove: [],
      },
      false,
    );
  });
  await poll(() => foreign.evaluate(() => window.desktopPostEvents.length >= 2), "outbound events");
  report.probes.push({
    name: "outbound-ipc-audience",
    foreignEvents: await foreign.evaluate(() => window.desktopPostEvents),
    limitation:
      "Same native-only prerequisite as the inbound control; proves all-window event fanout, not remote exploitability",
  });
  await app.evaluate(
    ({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.id === id)
        ?.destroy(),
    foreignId,
  );
  const invalidKeys = await page.evaluate(async () => {
    const errors = [];
    for (const key of ["", "x".repeat(1025), "bad\nkey"])
      try {
        await window.slackoss.storageGet(key);
        errors.push("ACCEPTED");
      } catch (error) {
        errors.push(error.message);
      }
    return errors;
  });
  report.probes.push({ name: "storage-key-controls", errors: invalidKeys });
  const hosted = await page.evaluate(() =>
    window.slackoss.hostingStart({ workspaceName: "DesktopPostAudit", port: 0 }),
  );
  const base = `http://127.0.0.1:${hosted.port}`;
  const registered = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handle: "desktop-post-audit",
      displayName: "Synthetic native audit",
      password: "post-audit-not-a-secret-password",
    }),
  }).then((response) => response.json());
  if (!registered.token) throw new Error("Synthetic local registration failed");
  const auth = { authorization: `Bearer ${registered.token}`, "content-type": "application/json" };
  const channel = await fetch(`${base}/api/channels`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "public", name: "audit-destination" }),
  }).then((response) => response.json());
  if (!channel.channel?.id) throw new Error("Synthetic destination creation failed");
  await page.evaluate((server) => window.slackoss.storageSet("servers", [server]), {
    url: base,
    token: registered.token,
    workspaceName: "DesktopPostAudit",
    handle: "desktop-post-audit",
    lastUsedAt: Date.now(),
  });
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("textarea"), undefined, {
    timeout: 15000,
  });
  await page.evaluate(
    ({ base, channelId }) => {
      const state = { ...history.state, tandem: { server: base, channelId, threadRootId: null } };
      history.replaceState(state, "", `${location.pathname}?desktopPostRoute=kept#/c/${channelId}`);
      dispatchEvent(new PopStateEvent("popstate", { state }));
    },
    { base, channelId: channel.channel.id },
  );
  await pause(250);
  const savedButton = page.getByRole("button", { name: "Saved messages", exact: true });
  await savedButton.click();
  await poll(
    () => savedButton.getAttribute("aria-pressed").then((value) => value === "true"),
    "Saved messages opened through UI",
  );
  const readPlace = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "({href:location.href,state:history.state,visibleTextarea:!!document.querySelector('textarea'),savedButtonPressed:document.querySelector('button[aria-label=\"Saved messages\"]')?.getAttribute('aria-pressed')})",
      ),
    );
  const before = await readPlace();
  const observations = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "(()=>{const button=document.querySelector('button[aria-label=\"Saved messages\"]');if(button?.getAttribute('aria-pressed')!=='true')button?.click();})()",
      ),
    );
    await poll(
      () => readPlace().then((place) => place.savedButtonPressed === "true"),
      "Saved messages reopened through UI",
    );
    const beforeAttempt = await readPlace();
    const loads = await app.evaluate(() => globalThis.desktopPostLoads);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    );
    await poll(
      () =>
        app.evaluate(async ({ BrowserWindow }, previous) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!contents || globalThis.desktopPostLoads <= previous || contents.isCrashed())
            return false;
          return contents
            .executeJavaScript(
              "!!document.querySelector('textarea') && !!document.querySelector('button[aria-label=\"Saved messages\"]')",
            )
            .catch(() => false);
        }, loads),
      `crash ${attempt} recovery`,
      15000,
    );
    await pause(150);
    observations.push({
      attempt,
      before: beforeAttempt,
      renderer: await app.evaluate(async ({ BrowserWindow }) => ({
        url: BrowserWindow.getAllWindows()[0].webContents.getURL(),
        page: await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          "({hash:location.hash,search:location.search,state:history.state,savedButtonPressed:document.querySelector('button[aria-label=\"Saved messages\"]')?.getAttribute('aria-pressed')})",
        ),
      })),
      dialogs: await app.evaluate(() => globalThis.desktopPostDialogs),
      hostedHealthStatus: await fetch(`${base}/api/health`).then((response) => response.status),
    });
  }
  report.probes.push({
    name: "four-crashes-and-manual-retry-route",
    before,
    observations,
    limitation:
      "Native dialog Try again response is supplied by the harness. Real human dialog interaction/installer operation is not tested. No latency benchmark claims.",
  });
  await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.slackoss.hostingStop()"),
  );
  await app.close();
  // Failed initial load: source output with a preinstalled pending dialog stub,
  // so this process can never open a dialog on the user's desktop.
  const pnpm = join(root, "node_modules/.pnpm");
  const electronName = (await readdir(pnpm)).find((name) => name.startsWith("electron@"));
  const bootstrap = join(directory, "failed-load.cjs");
  await writeFile(
    bootstrap,
    `const {app,dialog}=require('electron');globalThis.desktopPostDialogs=[];globalThis.desktopPostFailedLoads=[];dialog.showMessageBox=(...args)=>{const options=args.at(-1);globalThis.desktopPostDialogs.push({message:options.message,buttons:options.buttons});return new Promise(()=>{});};app.on('browser-window-created',(_event,window)=>{window.hide();window.webContents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>globalThis.desktopPostFailedLoads.push({code,description,isMainFrame}));});import(${JSON.stringify(pathToFileURL(join(root, "apps/desktop/out/main/index.js")).href)}).catch(error=>{console.error(error.message);app.exit(1);});\n`,
  );
  const failed = await launch("failed-load", {
    executablePath: join(pnpm, electronName, "node_modules/electron/dist/electron.exe"),
    args: [bootstrap],
    env: { ELECTRON_RENDERER_URL: "http://127.0.0.1:1/desktop-post-failed-load" },
  });
  await failed.app.firstWindow();
  await poll(
    () => failed.app.evaluate(() => globalThis.desktopPostDialogs.length > 0),
    "bounded failed-load recovery dialog",
    10000,
  );
  report.probes.push({
    name: "failed-load-recovery",
    observed: await failed.app.evaluate(() => ({
      failures: globalThis.desktopPostFailedLoads,
      dialogs: globalThis.desktopPostDialogs,
    })),
    limitation:
      "Current source output rather than package; synthetic blocked local port and pending native-dialog stub",
  });
} finally {
  await killAll();
  assertOwned();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  report.disposableDataCleaned = await stat(directory).then(
    () => false,
    () => true,
  );
}
await writeFile(join(here, "desktop-native.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    report: "docs/research/2026-10-02-post-implementation/desktop-native.json",
    probes: report.probes.length,
    cleaned: report.disposableDataCleaned,
  }),
);
