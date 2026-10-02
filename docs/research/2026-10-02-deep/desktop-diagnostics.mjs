/**
 * Read-only source/build diagnostics and disposable native Electron probes.
 * Usage: node docs/research/2026-10-02-deep/desktop-diagnostics.mjs inventory|typecheck|runtime
 * Reports contain synthetic credentials only; no existing user-data directory is opened.
 */
import { createRequire } from "node:module";
import { readFile, writeFile, readdir, stat, mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve, dirname, join, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir, platform, release, cpus, totalmem } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(join(root, "package.json"));
const mode = process.argv[2] ?? "inventory";
const posix = (value) => value.split(sep).join("/");
const rel = (value) => posix(relative(root, value));
const read = (path) => readFile(resolve(root, path), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  windowsHide: true,
  encoding: "utf8",
}).trim();
const report = {
  mode,
  capturedAt: new Date().toISOString(),
  sourceRevision,
  runtime: {
    node: process.version,
    platform: platform(),
    release: release(),
    architecture: process.arch,
  },
  hardware: { cpu: cpus()[0]?.model, logicalProcessors: cpus().length, memoryBytes: totalmem() },
};
const pnpm = resolve(root, "node_modules/.pnpm");
async function installedPackage(prefix, suffix) {
  const names = (await readdir(pnpm)).filter((name) => name.startsWith(prefix));
  if (names.length !== 1) throw new Error(`Expected one ${prefix} package; found ${names.length}`);
  return join(pnpm, names[0], "node_modules", suffix);
}
async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
function assertDisposable(directory) {
  const base = resolve(tmpdir());
  const target = resolve(directory);
  const within = relative(base, target);
  if (
    !within ||
    within.startsWith("..") ||
    isAbsolute(within) ||
    !target.includes("tandem-desktop-audit-")
  )
    throw new Error("Refusing cleanup outside the owned temporary directory");
}
async function cleanup(directory) {
  assertDisposable(directory);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (mode === "cleanup") {
  const directory = resolve(process.argv[3] ?? "");
  assertDisposable(directory);
  const bootstrap = await readFile(join(directory, "bootstrap.cjs"), "utf8");
  if (!bootstrap.includes("globalThis.desktopAuditUnhandled=[]"))
    throw new Error("Not the owned diagnostic bootstrap");
  await cleanup(directory);
  console.log(JSON.stringify({ cleanedOwnedDiagnosticDirectory: true }));
  process.exit(0);
}

if (mode === "inventory") {
  const ts = require("typescript");
  const main = resolve(root, "apps/desktop/out/main");
  const workerName = (await readdir(main)).find((name) => /^backupWorker-.*\.js$/.test(name));
  if (!workerName) throw new Error("Build desktop output before inventorying it");
  const seen = new Set();
  const modules = [];
  const externalImports = new Set();
  async function traverse(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const contents = await readFile(path, "utf8");
    const ast = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = [];
    const dynamicImports = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        dynamicImports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    modules.push({
      path: rel(path),
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
      imports,
      dynamicImports,
    });
    for (const specifier of imports) {
      if (specifier.startsWith(".")) await traverse(resolve(dirname(path), specifier));
      else externalImports.add(specifier);
    }
  }
  await traverse(join(main, workerName));
  report.backupWorker = {
    entry: rel(join(main, workerName)),
    bundledModuleBytes: modules.reduce((sum, module) => sum + module.bytes, 0),
    modules,
    externalImports: [...externalImports].sort(),
  };
  const sourceMain = await read("apps/desktop/src/main/index.ts");
  const handlers = [...sourceMain.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((match) => ({
    channel: match[1],
    line: sourceMain.slice(0, match.index).split("\n").length,
  }));
  report.ipcHandlers = handlers;
  report.lifecycleHooks = Object.fromEntries(
    [
      "render-process-gone",
      "did-fail-load",
      "unresponsive",
      "ready-to-show",
      "before-quit",
      "will-navigate",
      "will-frame-navigate",
      "will-redirect",
      "shutdown",
    ].map((hook) => [hook, sourceMain.includes(`"${hook}"`)]),
  );
  report.artifactIdentity = {};
  for (const directory of [
    "apps/desktop/out",
    "apps/web/dist",
    "apps/server-cli/dist",
    "apps/desktop/release/win-unpacked",
  ]) {
    const names = ["build-info.json", "build-manifest.json", "artifact-manifest.json"];
    report.artifactIdentity[directory] = { recognizedIdentityFiles: [] };
    for (const name of names)
      if (await exists(resolve(root, directory, name)))
        report.artifactIdentity[directory].recognizedIdentityFiles.push(name);
  }
  const archive = resolve(root, "apps/desktop/release/win-unpacked/resources/app.asar");
  if (await exists(archive)) {
    const asar = require(
      join(await installedPackage("@electron+asar@", "@electron/asar"), "lib/asar.js"),
    );
    const files = asar.listPackage(archive);
    const packages = new Map();
    const unexpectedRuntimeFiles = [];
    const workspaceSources = [];
    let archiveLogicalFileBytes = 0;
    for (const path of files) {
      const metadata = asar.statFile(archive, path.replace(/^[\\/]/, ""));
      if (typeof metadata.size !== "number") continue;
      archiveLogicalFileBytes += metadata.size;
      const match = path.replaceAll("\\", "/").match(/^\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
      if (!match) continue;
      const normalized = path.replaceAll("\\", "/").replace(/^\//, "");
      if (/\/data\/|\/\.turbo\/|\.db(?:-wal|-shm)?$/.test(normalized))
        unexpectedRuntimeFiles.push({ path: normalized, bytes: metadata.size });
      if (/^node_modules\/@slackoss\/[^/]+\/src\//.test(normalized))
        workspaceSources.push({ path: normalized, bytes: metadata.size });
      const row = packages.get(match[1]) ?? { name: match[1], bytes: 0, files: 0 };
      row.bytes += metadata.size;
      row.files++;
      packages.set(match[1], row);
    }
    report.existingPackagedArchive = {
      note: "Existing local archive; no artifact revision stamp means source freshness is unverified",
      bytes: (await stat(archive)).size,
      sha256: sha256(await readFile(archive)),
      logicalFileBytes: archiveLogicalFileBytes,
      packageCount: packages.size,
      packages: [...packages.values()].sort((a, b) => b.bytes - a.bytes),
      unexpectedRuntimeFiles,
      workspaceSources,
    };
  }
}

if (mode === "typecheck") {
  const ts = require("typescript");
  const paths = [
    "tests/e2e/web.spec.ts",
    "tests/e2e/desktop.spec.ts",
    "playwright.config.ts",
    "playwright.desktop.config.ts",
  ];
  const scripts = (await readdir(resolve(root, "scripts")))
    .filter((name) => name.endsWith(".mts"))
    .map((name) => `scripts/${name}`);
  const nodeTypes = resolve(root, "apps/desktop/node_modules/@types");
  const common = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    verbatimModuleSyntax: true,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: ["node"],
    typeRoots: [nodeTypes],
  };
  report.checks = [];
  for (const [name, files] of [
    ["e2e-and-configs", paths],
    ["measurement-scripts", scripts],
  ]) {
    const program = ts.createProgram(
      files.map((path) => resolve(root, path)),
      common,
    );
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const location =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;
      return {
        code: diagnostic.code,
        category: ts.DiagnosticCategory[diagnostic.category],
        path: diagnostic.file ? rel(diagnostic.file.fileName) : null,
        line: location ? location.line + 1 : null,
        column: location ? location.character + 1 : null,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      };
    });
    report.checks.push({
      name,
      files,
      options: { ...common, typeRoots: common.typeRoots.map(rel) },
      diagnostics,
      errorCount: diagnostics.filter((d) => d.category === "Error").length,
    });
  }
}

if (mode === "runtime") {
  const { _electron } = require("@playwright/test");
  const executablePath = join(await installedPackage("electron@", "electron"), "dist/electron.exe");
  const { ELECTRON_RUN_AS_NODE: ignored, ...inherited } = process.env;
  const directory = await mkdtemp(join(tmpdir(), "tandem-desktop-audit-"));
  assertDisposable(directory);
  const bootstrap = join(directory, "bootstrap.cjs");
  const mainModule = pathToFileURL(resolve(root, "apps/desktop/out/main/index.js")).href;
  const bootstrapSource = [
    `const {app} = require('electron');`,
    `globalThis.desktopAuditUnhandled=[];`,
    `process.on('unhandledRejection',error=>globalThis.desktopAuditUnhandled.push(String(error)));`,
    `app.on('browser-window-created',(_event,window)=>window.hide());`,
    `import(${JSON.stringify(mainModule)}).catch(error=>{console.error(error.message);app.exit(1);});`,
  ].join("\n");
  await writeFile(bootstrap, bootstrapSource);
  const allApps = [];
  const processes = new WeakMap();
  report.probes = [];
  report.outputUnderTest = {
    entry: "apps/desktop/out/main/index.js",
    sha256: sha256(await read("apps/desktop/out/main/index.js")),
    packaged: false,
    existingAsarWasNotLaunched: true,
  };
  async function launch(name, extraEnv = {}) {
    const userData = join(directory, name);
    await mkdir(userData, { recursive: true });
    const app = await _electron.launch({
      executablePath,
      args: [bootstrap],
      timeout: 20000,
      env: { ...inherited, TANDEM_TEST: "1", TANDEM_USER_DATA_DIR: userData, ...extraEnv },
    });
    allApps.push(app);
    processes.set(app, app.process());
    return app;
  }
  async function terminate(app) {
    const process = processes.get(app);
    const pid = process?.pid;
    if (pid && process.exitCode === null) {
      if (platform() === "win32")
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else process.kill("SIGKILL");
    }
    await delay(150);
  }
  try {
    const app = await launch("ipc");
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.slackoss?.storageGet === "function", undefined, {
      timeout: 15000,
    });
    report.electronRuntime = await app.evaluate(() => process.versions);
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get("storage:get");
      globalThis.desktopAuditIpcCalls = [];
      ipcMain.removeHandler("storage:get");
      ipcMain.handle("storage:get", (event, ...args) => {
        globalThis.desktopAuditIpcCalls.push({
          webContentsId: event.sender.id,
          senderFrameUrl: event.senderFrame?.url,
          mainFrame: event.senderFrame === event.sender.mainFrame,
          key: args[0],
        });
        return original(event, ...args);
      });
    });
    const credentials = [
      {
        url: "http://127.0.0.1:18543",
        token: "desktop-audit-not-a-secret",
        workspaceName: "Audit only",
        handle: "audit",
        lastUsedAt: 1,
      },
    ];
    await page.evaluate((value) => window.slackoss.storageSet("servers", value), credentials);
    const preload = resolve(root, "apps/desktop/out/preload/index.cjs");
    const auxiliary = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await window.loadURL("about:blank");
      return { id: window.webContents.id, url: window.webContents.getURL() };
    }, preload);
    let foreign;
    for (let attempt = 0; attempt < 40; attempt++) {
      foreign = app.windows().find((window) => window !== page && window.url() === "about:blank");
      if (foreign) break;
      await delay(50);
    }
    if (!foreign) throw new Error("Could not inspect hidden auxiliary window");
    const result = await foreign.evaluate(async () => ({
      href: location.href,
      bridgePresent: typeof window.slackoss === "object",
      savedCredentials: await window.slackoss.storageGet("servers"),
      hostingStatus: await window.slackoss.hostingStatus(),
      guardControl: await window.slackoss.downloadFile("desktop-audit-invalid-url").then(
        () => "unexpected success",
        (error) => error.message,
      ),
      storageWrite: await window.slackoss
        .storageSet("desktop-audit-foreign-write", "written-by-auxiliary-window")
        .then(() => "accepted"),
    }));
    result.primarySamePayloadControl = await page.evaluate(() =>
      window.slackoss.downloadFile("desktop-audit-invalid-url").then(
        () => "unexpected success",
        (error) => error.message,
      ),
    );
    result.primaryObservedForeignWrite = await page.evaluate(() =>
      window.slackoss.storageGet("desktop-audit-foreign-write"),
    );
    report.probes.push({
      name: "foreign-hidden-window-ipc",
      auxiliary,
      result,
      limitation:
        "Harness creates the auxiliary BrowserWindow with the real preload; this proves missing IPC sender authorization, not a remote renderer exploit or ordinary UI path",
    });
    const stored = JSON.parse(await readFile(join(directory, "ipc/settings.json"), "utf8"));
    report.probes.push({
      name: "credential-at-rest-control",
      encrypted: stored.servers?.kind === "tandem.saved-servers",
      plaintextTokenPresent: JSON.stringify(stored).includes("desktop-audit-not-a-secret"),
    });
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "desktop-audit-subframe";
      frame.src = "about:blank";
      document.body.append(frame);
    });
    let subframe;
    for (let attempt = 0; attempt < 40; attempt++) {
      subframe = page
        .frames()
        .find((frame) => frame !== page.mainFrame() && frame.url() === "about:blank");
      if (subframe) break;
      await delay(50);
    }
    if (!subframe) throw new Error("Could not inspect same-origin auxiliary frame");
    const frameResult = await subframe.evaluate(async () => ({
      href: location.href,
      ownBridgePresent: typeof window.slackoss === "object",
      parentBridgePresent: typeof window.parent.slackoss === "object",
      viaParent: await window.parent.slackoss.storageGet("desktop-audit-foreign-write"),
    }));
    report.probes.push({
      name: "same-origin-subframe-control",
      result: frameResult,
      limitation:
        "Same-origin child delegates to its parent's bridge; this is normal same-origin access, not proof of cross-origin access. Direct bridge is absent from child.",
    });
    report.observedStorageGetSenders = await app.evaluate(() => globalThis.desktopAuditIpcCalls);
    await page.evaluate(() => document.getElementById("desktop-audit-subframe")?.remove());
    await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.id === id)
          ?.destroy(),
      auxiliary.id,
    );
    await page.evaluate(() => window.slackoss.storageSet("desktop-audit-marker", "survives-crash"));
    const primaryId = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id,
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    );
    await delay(2000);
    const crashResult = await app.evaluate(({ BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().map((window) => ({
        id: window.webContents.id,
        crashed: window.webContents.isCrashed(),
        destroyed: window.isDestroyed(),
        url: window.webContents.getURL(),
      })),
      unhandled: globalThis.desktopAuditUnhandled,
    }));
    report.probes.push({
      name: "renderer-crash-recovery",
      primaryId,
      observationDelayMs: 2000,
      result: crashResult,
    });
    await terminate(app);
    const failed = await launch("failed-load", {
      ELECTRON_RENDERER_URL: "http://127.0.0.1:1/desktop-audit-unreachable",
    });
    await failed.firstWindow();
    await delay(2000);
    const failedResult = await failed.evaluate(({ BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().map((window) => ({
        id: window.webContents.id,
        url: window.webContents.getURL(),
        crashed: window.webContents.isCrashed(),
        loading: window.webContents.isLoading(),
      })),
      unhandled: globalThis.desktopAuditUnhandled,
    }));
    report.probes.push({
      name: "failed-renderer-load",
      target: "local blocked port, no outside request",
      observationDelayMs: 2000,
      result: failedResult,
    });
    await terminate(failed);
  } finally {
    for (const app of allApps) await terminate(app);
    await cleanup(directory);
    report.disposableDataCleaned = !(await exists(directory));
  }
}

if (!["inventory", "typecheck", "runtime"].includes(mode))
  throw new Error(`Unknown diagnostic mode ${mode}`);
const destination = join(here, `desktop-${mode}.json`);
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    mode,
    sourceRevision,
    report: rel(destination),
    probeCount: report.probes?.length,
    errorCounts: report.checks?.map((check) => ({ name: check.name, errors: check.errorCount })),
    workerBytes: report.backupWorker?.bundledModuleBytes,
    packagedBytes: report.existingPackagedArchive?.bytes,
  }),
);
