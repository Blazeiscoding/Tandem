import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  createWorkspaceServer,
  type WorkspaceServer,
} from "../../../../packages/server/src/server.ts";
import { backupWorkspace, restoreWorkspace } from "../../../../packages/server/src/backup.ts";

// Ordinary disposable workspaces. Delay only publication's second rename,
// exposing the already-unlocked interval without changing product source.
const root = await mkdtemp(join(tmpdir(), "tandem-next-restore-"));
const target = join(root, "target");
const source = join(root, "source");
const backup = join(root, "backup");
const normalTarget = join(root, "normal-target");
const servers: WorkspaceServer[] = [];
const originalRename = fs.promises.rename;
const result: Record<string, unknown> = {
  fixture: "restore-publication-gap",
  platform: process.platform,
};
async function start(dataDir: string, workspaceName: string) {
  const server = await createWorkspaceServer({
    dataDir,
    workspaceName,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  servers.push(server);
  return server;
}
async function register(server: WorkspaceServer, handle: string) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handle,
      displayName: "Synthetic Fixture",
      password: "fixture-password-123",
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { token: string; user: { id: string } };
}
try {
  const old = await start(target, "Original Workspace");
  await register(old, "original");
  const originalId = old.store.getMeta("workspace_id");
  await old.stop();
  const replacement = await start(source, "Replacement Workspace");
  await register(replacement, "replacement");
  const replacementId = replacement.store.getMeta("workspace_id");
  await replacement.stop();
  await backupWorkspace({ dataDir: source, out: backup });
  const heldOriginal = await start(target, "Original Workspace");
  try {
    await restoreWorkspace({ backupDir: backup, dataDir: target });
    throw new Error("An already-held target must be refused");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "workspace_in_use");
    result.heldTargetRejected = true;
    result.heldTargetIdentityPreserved = heldOriginal.store.getMeta("workspace_id") === originalId;
  }
  await heldOriginal.stop();
  const normal = await restoreWorkspace({ backupDir: backup, dataDir: normalTarget });
  assert.equal(normal.supersededDir, null);
  const normallyRestored = await start(normalTarget, "Ignored Existing Name");
  result.normalRestoreIdentityMatches =
    normallyRestored.store.getMeta("workspace_id") === replacementId;
  result.normalRestoreUsers = normallyRestored.store.listUsers().map((user) => user.handle);
  assert.equal(result.normalRestoreIdentityMatches, true);
  await normallyRestored.stop();
  let concurrent: WorkspaceServer | null = null;
  fs.promises.rename = async (from, to) => {
    if (String(from).startsWith(target + ".restoring-") && String(to) === target) {
      assert.equal(fs.existsSync(target), false);
      concurrent = await start(target, "Concurrent Fresh Workspace");
      await register(concurrent, "concurrent");
      result.concurrentStartAdmitted = true;
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await restoreWorkspace({ backupDir: backup, dataDir: target });
    result.restore = "resolved";
  } catch (error) {
    result.restore = "rejected";
    result.errorCode = (error as NodeJS.ErrnoException).code ?? null;
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(result.concurrentStartAdmitted, true, "The publication hook must have run");
  assert.equal(result.restore, "rejected");
  assert.ok(concurrent);
  result.targetNameAfterRejectedRestore = concurrent.store.getMeta("workspace_name");
  result.targetIdChanged = concurrent.store.getMeta("workspace_id") !== originalId;
  result.targetUsers = concurrent.store.listUsers().map((user) => user.handle);
  result.originalMovedAside = fs
    .readdirSync(root)
    .some((name) => name.startsWith("target.superseded-"));
  assert.equal(result.targetIdChanged, true);
  assert.equal(result.originalMovedAside, true);
  console.log(JSON.stringify(result, null, 2));
  await writeFile(
    new URL("restore-gap.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
} finally {
  fs.promises.rename = originalRename;
  syncBuiltinESMExports();
  for (const server of servers) await server.stop();
  const safeRoot = resolve(root);
  assert.equal(dirname(safeRoot).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(basename(safeRoot).startsWith("tandem-next-restore-"));
  await rm(safeRoot, { recursive: true, force: true });
}
