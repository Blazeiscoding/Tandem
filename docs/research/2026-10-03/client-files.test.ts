import { resolveObjectURL } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient } from "@slackoss/client-core";
const evidence: Record<string, unknown> = {
  revision: "cd3af584ba46adace45465cb5e5c66afb238b01c",
  scope:
    "Real disposable HTTP/WebSocket/SQLite/filesystem; actual production attachment cache. Search result not rendered in browser.",
};
let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let ownerToken: string;
let readerToken: string;
let general: string;
let ownedPath: string;
const paths: { path: string; removed: boolean }[] = [];
beforeEach(async () => {
  ownedPath = mkdtempSync(join(tmpdir(), "tandem-research-20261003-client-"));
  paths.push({ path: ownedPath, removed: false });
  server = await createWorkspaceServer({
    dataDir: ownedPath,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    retentionDays: 1,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const a = await new Api(base).register({
    handle: "owner",
    displayName: "Synthetic owner",
    password: "syntheticPassword123",
  });
  const b = await new Api(base).register({
    handle: "reader",
    displayName: "Synthetic reader",
    password: "syntheticPassword123",
  });
  ownerToken = a.token;
  readerToken = b.token;
  owner = new Api(base, a.token);
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  general = Object.values(client.state.channels).find((channel) => channel.name === "general")!.id;
});
afterEach(async () => {
  client?.destroy();
  await server?.stop();
  const absolute = resolve(ownedPath);
  if (
    dirname(absolute) !== resolve(tmpdir()) ||
    !basename(absolute).startsWith("tandem-research-20261003-client-")
  )
    throw new Error("Refused cleanup of an unowned fixture path");
  rmSync(absolute, { recursive: true, force: true });
  paths[paths.length - 1]!.removed = true;
});
afterAll(() => {
  evidence.fixtures = paths;
  writeFileSync(
    new URL("./client-files-evidence.json", import.meta.url),
    JSON.stringify(evidence, null, 2) + "\n",
  );
});
async function attached() {
  const form = new FormData();
  form.append(
    "file",
    new Blob(["Synthetic formerly available bytes"], { type: "text/plain" }),
    "synthetic-notes.txt",
  );
  const response = await fetch(`${owner.baseUrl}/api/channels/${general}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: form,
  });
  expect(response.status).toBe(201);
  const { file } = (await response.json()) as { file: { id: string } };
  const { message } = await owner.sendMessage(general, {
    text: "attachmentneedle",
    fileIds: [file.id],
  });
  await expect.poll(() => client.state.lastSeq >= message.seq).toBe(true);
  return { file, message };
}
async function serverFileStatus(id: string) {
  const result = await fetch(`${owner.baseUrl}/api/files/${id}`, {
    headers: { authorization: `Bearer ${readerToken}` },
  });
  await result.arrayBuffer();
  return result.status;
}
describe("F07 residual attachment paths", () => {
  it("diagnostic: an attachment obtained through search stays cached after message deletion", async () => {
    const { file, message } = await attached();
    const result = await client.api.search("attachmentneedle");
    expect(result.messages.find((m) => m.id === message.id)?.files[0]?.id).toBe(file.id);
    expect(client.state.timelines[general]).toBeUndefined();
    const oldUrl = await client.files.get(file.id);
    const seq = client.state.lastSeq;
    await owner.deleteMessage(message.id);
    await expect.poll(() => client.state.lastSeq > seq).toBe(true);
    const fresh = await serverFileStatus(file.id);
    expect(fresh).toBe(404);
    expect(client.files.peek(file.id)).toBe(oldUrl);
    expect(await resolveObjectURL(oldUrl)!.text()).toBe("Synthetic formerly available bytes");
    evidence.searchDeletion = {
      searchReturnedActualFile: true,
      timelineLoaded: false,
      freshServerStatus: fresh,
      cachedUrlStillReturned: client.files.peek(file.id) === oldUrl,
      cachedBytesStillReadable: await resolveObjectURL(oldUrl)!.text(),
    };
  });
  it("diagnostic: retention removes a loaded message but leaves its known-owner attachment cached", async () => {
    const { file, message } = await attached();
    await client.loadTimeline(general);
    const oldUrl = await client.files.get(file.id);
    const db = (server.store as unknown as { db: { exec: (sql: string) => void } }).db;
    db.exec("UPDATE messages SET created_at = created_at - 172800000");
    expect(server.applyRetention()).toBe(1);
    await expect.poll(() => client.state.removedHistory[general] > 0).toBe(true);
    expect(client.state.timelines[general]!.items.some((m) => m.id === message.id)).toBe(false);
    const fresh = await serverFileStatus(file.id);
    expect(fresh).toBe(404);
    expect(client.files.peek(file.id)).toBe(oldUrl);
    expect(await resolveObjectURL(oldUrl)!.text()).toBe("Synthetic formerly available bytes");
    evidence.retention = {
      productionMaintenanceRemoved: 1,
      messageRemovedFromTimeline: true,
      freshServerStatus: fresh,
      cachedUrlStillReturned: true,
      cachedBytesStillReadable: await resolveObjectURL(oldUrl)!.text(),
    };
  });
  it("control: deletion invalidates the attachment when its owner was loaded in timeline", async () => {
    const { file, message } = await attached();
    await client.loadTimeline(general);
    const oldUrl = await client.files.get(file.id);
    await owner.deleteMessage(message.id);
    await expect.poll(() => client.files.peek(file.id)).toBeUndefined();
    expect(resolveObjectURL(oldUrl)).toBeUndefined();
    evidence.loadedDeletionControl = {
      cachedUrlRemoved: true,
      cachedBlobRevoked: true,
      freshServerStatus: await serverFileStatus(file.id),
    };
  });
});
