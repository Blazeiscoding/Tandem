/** Real current desktop startup adapter and server, over disposable loopback profiles. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
const ts = desktopRequire("typescript");
const directory = await mkdtemp(join(tmpdir(), "tandem-desktop-next-"));
const resources = [];
const controllers = [];
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
  capturedAt: new Date().toISOString(),
  runtime: process.versions.node,
  scope:
    "Current dirty source; unchanged AST-extracted desktop startup adapter; real server/SQLite/settings on owned loopback profiles. Injected SQLite write failure and held backup adapter, no native app or installer.",
  cases: [],
};

function owned(path) {
  const within = relative(resolve(tmpdir()), resolve(path));
  assert(
    within &&
      !within.startsWith("..") &&
      !isAbsolute(within) &&
      path.includes("tandem-desktop-next-"),
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function health(server) {
  try {
    return (
      await fetch(`http://127.0.0.1:${server.port}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      })
    ).status;
  } catch {
    return null;
  }
}
const source = await readFile(join(root, "apps/desktop/src/main/index.ts"), "utf8");
const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
let startup;
function find(node) {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText(tree) === "startServer" &&
    ts.isArrowFunction(node.initializer)
  )
    startup = node.initializer.getText(tree);
  ts.forEachChild(node, find);
}
find(tree);
assert(startup, "production startup adapter found");
// Only import.meta's source location is materialized. Dependency injection below
// confines the real listener to loopback and suppresses mDNS/logging in this fixture.
const adapterSource = startup.replaceAll(
  "import.meta.dirname",
  JSON.stringify(join(root, "apps/desktop/src/main")),
);
const entry = `import { createWorkspaceServer as realServer } from ${JSON.stringify(join(root, "packages/server/src/server.ts"))};
import { createHostingController } from ${JSON.stringify(join(root, "apps/desktop/src/main/hosting.ts"))};
import { createSettingsStorage } from ${JSON.stringify(join(root, "apps/desktop/src/main/settings.ts"))};
import { join } from 'node:path';
const app = { isPackaged: false };
export { realServer, createHostingController, createSettingsStorage };
export function startupAdapter(createWorkspaceServer, publicAddressConfig) { return (${adapterSource}); }
`;
try {
  owned(directory);
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: "desktop-next.ts", loader: "ts" },
    outfile: join(directory, "source.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
    banner: {
      js: `import {createRequire as _createRequire} from 'node:module';const require=_createRequire(${JSON.stringify(join(root, "apps/desktop/package.json"))});`,
    },
  });
  const { realServer, createHostingController, createSettingsStorage, startupAdapter } =
    await import(pathToFileURL(join(directory, "source.mjs")));
  const protector = {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  };
  async function profile(name) {
    const folder = join(directory, name);
    await mkdir(folder);
    return { folder, settings: createSettingsStorage(join(folder, "settings.json"), protector) };
  }
  async function seed(folder) {
    const initial = await realServer({
      dataDir: folder,
      port: 0,
      host: "127.0.0.1",
      mdns: false,
      logger: false,
    });
    const id = initial.store.getMeta("workspace_id");
    await initial.stop();
    return id;
  }
  function startReal(options) {
    return realServer({ ...options, host: "127.0.0.1", mdns: false, logger: false }).then(
      (server) => {
        resources.push(server);
        return server;
      },
    );
  }
  for (const fault of [false, true]) {
    const h = await profile(fault ? "invite-write-refused" : "invite-write-control");
    const dataRoot = join(h.folder, "hosted");
    const dataDir = join(dataRoot, "workspace");
    const id = await seed(dataDir);
    if (fault) {
      const db = new DatabaseSync(join(dataDir, "workspace.db"));
      db.exec(
        "CREATE TRIGGER refuse_invite_policy BEFORE INSERT ON meta WHEN NEW.key = 'invite_only' BEGIN SELECT RAISE(ABORT, 'Injected invite policy write refusal'); END",
      );
      db.close();
    }
    await h.settings.set("hostedWorkspaces", {
      version: 1,
      workspaces: [
        { id, folder: "workspace", name: "Synthetic workspace", port: 0, lastHostedAt: 1 },
      ],
    });
    const countBefore = resources.length;
    const controller = createHostingController({
      dataRoot,
      defaultPort: 8543,
      lanUrls: () => [],
      settings: h.settings,
      startServer: startupAdapter(startReal, () => ({
        carrier: "elsewhere",
        publicUrl: "https://synthetic.example.test",
      })),
    });
    controllers.push(controller);
    let error = null;
    try {
      await controller.start({ folder: "workspace" });
    } catch (reason) {
      error = reason.message;
    }
    const real = resources[countBefore];
    assert(real);
    const before = await health(real);
    const status = controller.status();
    await controller.shutdown();
    const after = await health(real);
    let heldAfterShutdown = false;
    try {
      const duplicate = await realServer({
        dataDir,
        port: 0,
        host: "127.0.0.1",
        mdns: false,
        logger: false,
      });
      await duplicate.stop();
    } catch (reason) {
      heldAfterShutdown = reason.code === "workspace_in_use";
    }
    report.cases.push({
      name: fault ? "post-listen-invite-policy-write-failure" : "normal-start-shutdown-control",
      startError: error,
      controllerStatusAfterStart: status,
      listenerBeforeShutdown: before,
      listenerAfterReportedShutdown: after,
      workspaceStillHeldAfterShutdown: heldAfterShutdown,
      actualInviteOnly: fault ? real.inviteOnly() : null,
    });
    assert.equal(before, 200);
    assert.equal(after, fault ? 200 : null);
    assert.equal(status.running, !fault);
    assert.equal(heldAfterShutdown, fault);
    if (fault) {
      assert(error.includes("Injected invite policy write refusal"));
      assert.equal(real.inviteOnly(), false);
    }
    await real.stop();
  }
  // A held backup is not bounded by the new server/connector cleanup timer:
  // shutdown joins the same controller queue before it can reach stopCurrent.
  {
    const h = await profile("held-backup-queue");
    const dataRoot = join(h.folder, "hosted");
    const dataDir = join(dataRoot, "workspace");
    const id = await seed(dataDir);
    await h.settings.set("hostedWorkspaces", {
      version: 1,
      workspaces: [
        { id, folder: "workspace", name: "Synthetic workspace", port: 0, lastHostedAt: 1 },
      ],
    });
    const gate = deferred();
    const reached = deferred();
    const destination = join(h.folder, "backups");
    await mkdir(destination);
    const controller = createHostingController({
      dataRoot,
      defaultPort: 8543,
      lanUrls: () => [],
      settings: h.settings,
      cleanupTimeoutMs: 20,
      startServer: startupAdapter(startReal, () => null),
      backupWorkspace: async () => {
        reached.resolve();
        await gate.promise;
        throw new Error("Injected held backup released");
      },
    });
    controllers.push(controller);
    await controller.start({ folder: "workspace" });
    const real = resources.at(-1);
    const backup = controller
      .backup({ folder: "workspace", destination })
      .catch((error) => error.message);
    await reached.promise;
    let settled = false;
    const stopping = controller.shutdown().then(() => {
      settled = true;
    });
    await new Promise((done) => setTimeout(done, 120));
    const beforeRelease = {
      shutdownSettled: settled,
      health: await health(real),
      phase: controller.status().phase,
      elapsedDeadlineMultiples: 6,
    };
    gate.resolve();
    await backup;
    await stopping;
    report.cases.push({
      name: "held-backup-blocks-before-cleanup-deadline",
      cleanupTimeoutMs: 20,
      observedBeforeBackupRelease: beforeRelease,
      healthAfterReleaseAndShutdown: await health(real),
    });
    assert.equal(beforeRelease.shutdownSettled, false);
    assert.equal(beforeRelease.health, 200);
    assert.equal(beforeRelease.phase, "running");
    assert.equal(await health(real), null);
  }
  await writeFile(join(here, "lifecycle-next.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  for (const resource of resources) await resource.stop().catch(() => {});
  for (const controller of controllers) await controller.shutdown().catch(() => {});
  owned(directory);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
