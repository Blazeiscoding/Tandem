/** Current production controllers over owned settings/SQLite identities and loopback resources. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const viteRequire = createRequire(desktopRequire.resolve("vite"));
const { build } = viteRequire("esbuild");
const directory = await mkdtemp(join(tmpdir(), "tandem-desktop-lifecycle-"));
const resources = [];
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  }).trim(),
  capturedAt: new Date().toISOString(),
  runtime: process.versions.node,
  scope:
    "Source controllers bundled unchanged; real disposable settings/SQLite metadata/loopback HTTP resources, injected close failures, no Cloudflare or live queued integrations",
  cases: [],
};
function owned(path) {
  const within = relative(resolve(tmpdir()), resolve(path));
  assert(
    within &&
      !within.startsWith("..") &&
      !isAbsolute(within) &&
      path.includes("tandem-desktop-lifecycle-"),
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listener(kind) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", syntheticKind: kind }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const resource = {
    server,
    port: server.address().port,
    live: true,
    closeCalls: 0,
    failNext: false,
    close: async () => {
      resource.closeCalls++;
      if (resource.failNext) {
        resource.failNext = false;
        throw new Error("Injected resource could not finish stopping");
      }
      if (!resource.live) return;
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      resource.live = false;
    },
  };
  resources.push(resource);
  return resource;
}
async function alive(resource) {
  return fetch(`http://127.0.0.1:${resource.port}/api/health`).then(
    (response) => response.status === 200,
    () => false,
  );
}
async function identity(dir, id = "synthetic-held-workspace") {
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "workspace.db"));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("workspace_id", id);
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("workspace_name", "Synthetic held workspace");
  db.close();
}
let createHostingController;
let createSettingsStorage;
async function harness(name, extra = {}) {
  const profile = join(directory, name);
  await mkdir(profile, { recursive: true });
  const settings = createSettingsStorage(join(profile, "settings.json"), {
    isAvailable: () => false,
    encryptString: () => {
      throw new Error("Credentials are not used by this fixture");
    },
    decryptString: () => {
      throw new Error("Credentials are not used by this fixture");
    },
  });
  const h = { profile, settings, starts: [], servers: [], inviteOnly: false, controller: null };
  h.controller = createHostingController({
    dataRoot: join(profile, "hosted"),
    defaultPort: 8543,
    settings,
    lanUrls: () => [],
    startServer: async (request) => {
      h.starts.push({ ...request, dataDir: relative(profile, request.dataDir) });
      const resource = await listener("workspace-adapter");
      h.servers.push(resource);
      return {
        port: resource.port,
        instanceId: "synthetic-run",
        workspaceId: () => "synthetic-held-workspace",
        workspaceName: () => "Synthetic held workspace",
        stop: () => resource.close(),
        setPublicUrl: () => {},
        setTrustLoopbackProxy: () => {},
        setIceServers: () => {},
        inviteOnly: () => h.inviteOnly,
        setInviteOnly: (value) => {
          h.inviteOnly = value;
        },
        accountCount: () => 1,
      };
    },
    ...extra,
  });
  return h;
}
try {
  owned(directory);
  await build({
    entryPoints: {
      hosting: join(root, "apps/desktop/src/main/hosting.ts"),
      settings: join(root, "apps/desktop/src/main/settings.ts"),
    },
    outdir: join(directory, "bundled"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  ({ createHostingController } = await import(
    pathToFileURL(join(directory, "bundled/hosting.mjs"))
  ));
  ({ createSettingsStorage } = await import(
    pathToFileURL(join(directory, "bundled/settings.mjs"))
  ));
  // The row is a restored, held workspace. Damage only one unrelated metadata field.
  for (const [name, mutation] of [
    ["held-row-valid-control", {}],
    ["held-row-unreadable-hold-control", { restoredHold: "unreadable" }],
    ["held-row-invalid-port", { port: 65536 }],
    ["held-row-invalid-name", { name: "" }],
    ["held-row-invalid-last-used", { lastHostedAt: "unreadable" }],
  ]) {
    const h = await harness(name);
    await identity(join(h.profile, "hosted", "held-copy"));
    await h.settings.set("hostedWorkspaces", {
      version: 1,
      workspaces: [
        {
          id: "synthetic-held-workspace",
          folder: "held-copy",
          name: "Synthetic held workspace",
          port: 8543,
          lastHostedAt: 1,
          restoredHold: 2,
          ...mutation,
        },
      ],
    });
    const listed = await h.controller.list();
    const started = await h.controller.start({ folder: "held-copy" });
    const saved = await h.settings.get("hostedWorkspaces", { strict: true });
    report.cases.push({
      name,
      listedAsRestored: listed.workspaces[0].restored,
      isolated: started.isolated === true,
      startExplicitlyActivated: false,
      actualStartIsolated: h.starts[0].isolated === true,
      persistedHoldPresent: Object.hasOwn(saved.workspaces[0], "restoredHold"),
    });
    const shouldHold = name.endsWith("control");
    assert.equal(started.isolated === true, shouldHold);
    await h.controller.shutdown();
  }
  // A current top-level unknown version is refused, rather than adopted.
  {
    const h = await harness("newer-registry-control");
    await identity(join(h.profile, "hosted", "held-copy"));
    await h.settings.set("hostedWorkspaces", { version: 2, workspaces: [] });
    await assert.rejects(h.controller.list(), /newer version/);
    assert.equal((await h.settings.get("hostedWorkspaces")).version, 2);
    report.cases.push({
      name: "newer-registry-control",
      refused: true,
      originalVersionPreserved: true,
      starts: h.starts.length,
    });
  }
  // Cancelling an opening must retain ownership if the new connector cannot close.
  for (const failClose of [false, true]) {
    const started = deferred();
    const opened = deferred();
    const connectors = [];
    const h = await harness(`cancel-connector-${failClose}`, {
      openTunnel: async () => {
        const resource = await listener("connector-adapter");
        const connector = {
          url: "https://synthetic.trycloudflare.com",
          close: () => resource.close(),
          onUnexpectedExit: () => {},
          resource,
        };
        connectors.push(connector);
        if (connectors.length === 1) {
          resource.failNext = failClose;
          started.resolve();
          await opened.promise;
        }
        return connector;
      },
    });
    await h.controller.start({ workspaceName: "Synthetic tunnel", port: 0 });
    const opening = h.controller.openToAll({ inviteOnly: false });
    const failed = opening.then(
      () => null,
      (error) => error.message,
    );
    await started.promise;
    const closing = h.controller.endOpenToAll();
    opened.resolve();
    const openingError = await failed;
    await closing;
    const statusAfterCancel = h.controller.status();
    const policyAfterCancel = h.inviteOnly;
    const liveAfterCancel = await alive(connectors[0].resource);
    await h.controller.openToAll({ inviteOnly: false });
    const liveAfterRetry = await Promise.all(
      connectors.map((connector) => alive(connector.resource)),
    );
    await h.controller.shutdown();
    const first = connectors[0].resource;
    report.cases.push({
      name: failClose ? "cancelled-connector-close-failure" : "cancelled-connector-control",
      openingError,
      statusAfterCancelPublicLink: statusAfterCancel.openToAll ?? null,
      connectorAliveAfterCancel: liveAfterCancel,
      connectorLivenessAfterRetry: liveAfterRetry,
      orphanAliveAfterShutdown: await alive(first),
      firstCloseCallsAfterShutdown: first.closeCalls,
      policyAfterCancel,
    });
    assert.equal(liveAfterCancel, failClose);
    assert.equal(first.closeCalls, 1);
  }
  // Rejecting a restored copy's accidental usual port also needs retryable ownership.
  {
    const resource = await listener("rejected-isolated-port");
    resource.failNext = true;
    const h = await harness("isolated-port-stop-failure", {
      defaultPort: resource.port,
      startServer: async () => ({ port: resource.port, stop: () => resource.close() }),
    });
    await identity(join(h.profile, "hosted", "held-copy"));
    await h.settings.set("hostedWorkspaces", {
      version: 1,
      workspaces: [
        {
          id: "synthetic-held-workspace",
          folder: "held-copy",
          name: "Synthetic held workspace",
          port: resource.port,
          lastHostedAt: 1,
          restoredHold: 2,
        },
      ],
    });
    await assert.rejects(h.controller.start({ folder: "held-copy" }), /could not finish stopping/);
    const status = h.controller.status();
    await h.controller.shutdown();
    report.cases.push({
      name: "isolated-port-stop-failure",
      selectedUsualPort: resource.port,
      statusAfterFailedStart: { phase: status.phase, running: status.running },
      actualResourceAliveAfterShutdown: await alive(resource),
      closeCallsAfterShutdown: resource.closeCalls,
    });
    assert.equal(status.running, false);
    assert.equal(resource.closeCalls, 1);
    assert(await alive(resource));
  }
  // The normal running-server stop path correctly retains the failed resource.
  {
    const h = await harness("normal-stop-retry-control");
    await h.controller.start({ workspaceName: "Synthetic stop control", port: 0 });
    h.servers[0].failNext = true;
    await assert.rejects(h.controller.shutdown(), /could not finish stopping/);
    const retained = h.controller.status().running;
    await h.controller.shutdown();
    report.cases.push({
      name: "normal-stop-retry-control",
      retainedAfterFailure: retained,
      aliveAfterSuccessfulRetry: await alive(h.servers[0]),
      closeCalls: h.servers[0].closeCalls,
    });
    assert(retained);
    assert.equal(h.servers[0].closeCalls, 2);
  }
  await writeFile(
    join(here, "desktop-lifecycle-fixtures.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    JSON.stringify({ revision: report.revision, cases: report.cases }, null, 2) + "\n",
  );
} finally {
  for (const resource of resources) {
    resource.failNext = false;
    await resource.close();
  }
  owned(directory);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
