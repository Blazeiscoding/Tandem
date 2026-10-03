/** Normal desktop close and last-keystroke probes, disposable synthetic profiles only. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { readAsarFile } = await import(pathToFileURL(join(root, "scripts/build-identity.mjs")));
const require = createRequire(join(root, "package.json"));
const { _electron } = require("@playwright/test");
const directory = await mkdtemp(join(tmpdir(), "tandem-desktop-close-"));
const apps = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
  capturedAt: new Date().toISOString(),
  scope:
    "Fresh unpacked Windows app, hidden test mode, normal quit/window close, synthetic sign-ins/workspaces; native confirmation responses instrumented",
  traceMode: !process.argv.includes("--no-trace"),
  cases: [],
};
function owned(path) {
  const within = relative(resolve(tmpdir()), resolve(path));
  assert(
    within &&
      !within.startsWith("..") &&
      !isAbsolute(within) &&
      path.includes("tandem-desktop-close-"),
  );
}
const { ELECTRON_RUN_AS_NODE: ignored, ...inherited } = process.env;
async function launch(name) {
  const data = join(directory, name);
  await mkdir(data, { recursive: true });
  const app = await _electron.launch({
    executablePath: join(root, "apps/desktop/release/win-unpacked/Tandem.exe"),
    env: { ...inherited, TANDEM_TEST: "1", TANDEM_TEST_MEDIA: "0", TANDEM_USER_DATA_DIR: data },
    timeout: 20000,
  });
  const process = app.process();
  const trace = [];
  let pending = "";
  process.stdout.on("data", (chunk) => {
    const lines = (pending + chunk.toString("utf8")).split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines)
      if (line.startsWith("DESKTOP_CLOSE_TRACE ")) trace.push(JSON.parse(line.slice(20)));
  });
  apps.push({ app, process });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.slackoss?.hostingStart === "function");
  return { data, app, page, process, trace };
}
async function seed({ app, page }) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const hosted = await page.evaluate(() =>
    window.slackoss.hostingStart({ workspaceName: "Close audit synthetic", port: 0 }),
  );
  const url = `http://127.0.0.1:${hosted.port}`;
  const response = await fetch(`${url}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handle: "closeaudit",
      displayName: "Synthetic audit",
      password: "synthetic-close-audit-password",
    }),
  });
  assert.equal(response.status, 201);
  const registered = await response.json();
  assert(registered.token);
  await page.evaluate((server) => window.slackoss.storageSet("servers", [server]), {
    url,
    token: registered.token,
    workspaceName: "Close audit synthetic",
    handle: "closeaudit",
    lastUsedAt: Date.now(),
  });
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("textarea"));
  return hosted;
}
async function traceClose({ app }) {
  await app.evaluate(({ app, ipcMain }) => {
    const note = (kind, details = {}) =>
      process.stdout.write("DESKTOP_CLOSE_TRACE " + JSON.stringify({ kind, ...details }) + "\n");
    const original = ipcMain._invokeHandlers.get("storage:mergeDrafts");
    ipcMain.removeHandler("storage:mergeDrafts");
    ipcMain.handle("storage:mergeDrafts", async (...args) => {
      note("draft-invoke-start", { key: args[1] });
      try {
        const result = await original(...args);
        note("draft-invoke-complete");
        return result;
      } catch (error) {
        note("draft-invoke-error", { message: error.message });
        throw error;
      }
    });
    app.on("before-quit", () => note("before-quit"));
    app.on("will-quit", () => note("will-quit"));
  });
}
async function settings(data) {
  return JSON.parse(await readFile(join(data, "settings.json"), "utf8"));
}
try {
  owned(directory);
  report.artifactIdentity = JSON.parse(
    readAsarFile(
      join(root, "apps/desktop/release/win-unpacked/resources/app.asar"),
      "out/build.json",
    ),
  );
  assert.equal(report.artifactIdentity.revision, report.revision);
  for (const mode of [
    "wait-for-persistence",
    "quit-immediately",
    "quit-immediately-repeat",
    "plain-close-immediately",
    "explicit-pagehide-then-quit",
    "explicit-pagehide-await-persistence",
  ]) {
    const run = await launch(mode);
    report.runtime ??= await run.app.evaluate(() => process.versions);
    await seed(run);
    if (mode === "plain-close-immediately")
      await run.page.evaluate(() => window.slackoss.hostingStop());
    if (report.traceMode) await traceClose(run);
    const marker = `close-audit-final-keystroke-${mode}`;
    await run.page.locator("textarea").fill(marker);
    assert.equal(await run.page.locator("textarea").inputValue(), marker);
    if (mode === "explicit-pagehide-await-persistence")
      await run.page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
    if (mode === "wait-for-persistence" || mode === "explicit-pagehide-await-persistence") {
      const deadline = Date.now() + 10000;
      while (!JSON.stringify(await settings(run.data)).includes(marker) && Date.now() < deadline)
        await pause(25);
      assert(JSON.stringify(await settings(run.data)).includes(marker));
    }
    const before = JSON.stringify(await settings(run.data)).includes(marker);
    const finished = run.app.waitForEvent("close");
    await run.app.evaluate(async ({ app, BrowserWindow }, mode) => {
      if (mode === "explicit-pagehide-then-quit")
        await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          "dispatchEvent(new PageTransitionEvent('pagehide'))",
        );
      if (mode === "plain-close-immediately") BrowserWindow.getAllWindows()[0].close();
      else app.quit();
    }, mode);
    await finished;
    const saved = await settings(run.data);
    const after = JSON.stringify(saved).includes(marker);
    report.cases.push({
      mode,
      visibleBeforeClose: true,
      persistedBeforeClose: before,
      persistedAfterCleanExit: after,
      draftKeys: Object.keys(saved).filter((key) => key.endsWith(":drafts")),
      exitCode: run.process.exitCode,
      trace: run.trace,
    });
  }
  const output = report.traceMode
    ? "desktop-native-close.json"
    : "desktop-native-close-uninstrumented.json";
  await writeFile(join(here, output), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({ revision: report.revision, cases: report.cases }, null, 2) + "\n",
  );
} finally {
  for (const { process: proc } of apps) {
    if (proc.exitCode === null && proc.pid)
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  }
  await pause(200);
  owned(directory);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
