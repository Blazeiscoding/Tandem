import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveObjectURL } from "node:buffer";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, WorkspaceClient } from "@slackoss/client-core";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import {
  EPHEMERAL_CUT_NOTE,
  EPHEMERAL_LIMITS,
} from "../../../packages/client-core/src/workspace.js";

const observations: Record<string, unknown>[] = [];
const cleanups: { checkedOwnedPath: boolean; removed: boolean }[] = [];
const clients: WorkspaceClient[] = [];
const releases: (() => void)[] = [];
let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;
let readerToken: string;
let readerId: string;
let dataDir: string;

function deferred<T>() {
  let resume!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (resume = resolve));
  return { promise, resume };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "tandem-post-client-"));
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const registration = new Api(baseUrl);
  const first = await registration.register({
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  const reader = await registration.register({
    handle: "reader",
    displayName: "Reader",
    password: "password123",
  });
  owner = new Api(baseUrl, first.token);
  readerToken = reader.token;
  readerId = reader.user.id;
  client = new WorkspaceClient(baseUrl, readerToken);
  clients.push(client);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
});

afterEach(async () => {
  for (const resume of releases.splice(0)) resume();
  for (const c of clients.splice(0)) c.destroy();
  await server?.stop();
  vi.restoreAllMocks();
  if (dataDir) {
    const actual = realpathSync(dataDir);
    const temporaryRoot = realpathSync(tmpdir());
    if (
      actual !== resolve(dataDir) ||
      dirname(actual) !== temporaryRoot ||
      !basename(actual).startsWith("tandem-post-client-")
    )
      throw new Error("Temporary deletion ownership check failed");
    rmSync(actual, { recursive: true, force: true });
    cleanups.push({ checkedOwnedPath: true, removed: true });
  }
});
afterAll(() => {
  writeFileSync(
    new URL("client-state-evidence.json", import.meta.url),
    JSON.stringify(
      {
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        runtime: { node: process.version, platform: process.platform },
        scope:
          "Production WorkspaceClient, real loopback HTTP/WebSocket, owned temporary SQLite/files. Counts and reference checks only. Explicit gates or state seeding are identified per probe.",
        temporaryFixtures: cleanups,
        observations,
      },
      null,
      2,
    ) + "\n",
  );
});

async function upload(channel: string, text: string) {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), "synthetic-diagnostic.txt");
  // Api.uploadFile uses browser XHR. The equivalent actual authenticated HTTP route is used in Node.
  const response = await fetch(`${owner.baseUrl}/api/channels/${channel}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
    body: form,
  });
  expect(response.ok).toBe(true);
  return ((await response.json()) as { file: { id: string } }).file;
}

describe("current implementation closure and new boundaries", () => {
  it("unrelated actual socket events keep both thread references; a reply changes only its thread", async () => {
    const first = (await owner.sendMessage(channelId, { text: "first root" })).message;
    const second = (await owner.sendMessage(channelId, { text: "second root" })).message;
    await owner.sendMessage(channelId, { text: "first reply", threadRootId: first.id });
    await owner.sendMessage(channelId, { text: "second reply", threadRootId: second.id });
    await expect.poll(() => client.state.lastSeq).toBe(server.store.currentSeq());
    await client.loadThread(first.id, channelId);
    await client.loadThread(second.id, channelId);
    const before = client.state;
    const outside = (await owner.sendMessage(channelId, { text: "outside both threads" })).message;
    await expect.poll(() => client.state.lastSeq).toBe(outside.seq);
    const unrelated = [first.id, second.id].map((id) => ({
      repliesSame: client.state.threads[id] === before.threads[id],
      pageSame: client.state.threadPages[id] === before.threadPages[id],
    }));
    expect(unrelated.every((r) => r.repliesSame && r.pageSame)).toBe(true);
    const later = client.state;
    const reply = (
      await owner.sendMessage(channelId, { text: "another first reply", threadRootId: first.id })
    ).message;
    await expect.poll(() => client.state.lastSeq).toBe(reply.seq);
    expect(client.state.threads[first.id]).not.toBe(later.threads[first.id]);
    expect(client.state.threads[second.id]).toBe(later.threads[second.id]);
    observations.push({
      name: "REV03_thread_references",
      classification: "corrected behavior verified",
      unrelated,
      affectedThreadOnlyChanged: true,
      transport: "real HTTP/WebSocket",
    });
  });

  it("identical tail loads share real HTTP and destruction aborts the caller signal", async () => {
    await owner.sendMessage(channelId, { text: "history fixture" });
    const originalFetch = globalThis.fetch;
    const gate = deferred<void>();
    releases.push(() => gate.resume());
    const transfers: { signal?: AbortSignal; responseAcquired: boolean }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      if (!String(args[0]).includes(`/api/channels/${channelId}/messages?`))
        return originalFetch(...args);
      const transfer = {
        signal: args[1]?.signal as AbortSignal | undefined,
        responseAcquired: false,
      };
      transfers.push(transfer);
      const response = await originalFetch(...args);
      transfer.responseAcquired = true;
      await gate.promise;
      return response;
    });
    const first = client.loadTimeline(channelId);
    const second = client.loadTimeline(channelId);
    await expect.poll(() => transfers[0]?.responseAcquired).toBe(true);
    expect(transfers).toHaveLength(1);
    client.destroy();
    expect(transfers[0]!.signal?.aborted).toBe(true);
    gate.resume();
    await Promise.all([first, second]);
    expect(client.state.timelines[channelId]).toBeUndefined();
    observations.push({
      name: "REV05_history_share_and_abort",
      classification: "corrected behavior verified",
      equivalentRequests: transfers.length,
      callerSignalAborted: true,
      lateTimelineInstalled: false,
      limitation:
        "Response acquired before gate; caller abort and late-result rejection verified, not avoided body-transfer bytes.",
    });
  });

  it("a destroyed client starts neither queued choice nor repair after its replacement pins", async () => {
    const message = (await owner.sendMessage(channelId, { text: "choice fixture" })).message;
    await client.loadTimeline(channelId);
    const gate = deferred<void>();
    releases.push(() => gate.resume());
    const pin = client.api.pinMessage.bind(client.api);
    let pinCalls = 0;
    let unpinCalls = 0;
    vi.spyOn(client.api, "pinMessage").mockImplementation(async (id) => {
      pinCalls++;
      await gate.promise;
      return pin(id);
    });
    vi.spyOn(client.api, "unpinMessage").mockImplementation(async (id) => {
      unpinCalls++;
      return owner.unpinMessage(id);
    });
    const first = client.togglePin(
      client.state.timelines[channelId]!.items.find((m) => m.id === message.id)!,
    );
    const queued = client.togglePin(
      client.state.timelines[channelId]!.items.find((m) => m.id === message.id)!,
    );
    expect(pinCalls).toBe(1);
    expect(unpinCalls).toBe(0);
    client.destroy();
    const replacement = new WorkspaceClient(client.baseUrl, readerToken);
    clients.push(replacement);
    replacement.connect();
    await expect.poll(() => replacement.state.status).toBe("online");
    await replacement.loadTimeline(channelId);
    await replacement.togglePin(
      replacement.state.timelines[channelId]!.items.find((m) => m.id === message.id)!,
    );
    gate.resume();
    await Promise.all([first, queued]);
    await expect
      .poll(
        () =>
          replacement.state.timelines[channelId]!.items.find((m) => m.id === message.id)?.pinned,
      )
      .toBe(true);
    expect({ pinCalls, unpinCalls }).toEqual({ pinCalls: 1, unpinCalls: 0 });
    observations.push({
      name: "REV11_choice_lifetime",
      classification: "corrected behavior verified",
      pinCallsFromOld: pinCalls,
      queuedOrRepairUnpinCallsFromOld: unpinCalls,
      replacementPinned: true,
      limitation:
        "Pin path with real still-valid session, first request held before forwarding. Save/DND/permutation breadth is covered by repository regressions, not independently repeated here. Already-delivered writes remain outside local cancellation.",
    });
  });

  it("private answer bytes and repeated IDs stay bounded on actual wire frames", async () => {
    const text = "x".repeat(50_000);
    for (let i = 0; i < 32; i++)
      server.gateway.sendToUser(readerId, {
        type: "ephemeral.message",
        id: `post-answer-${i}`,
        channelId,
        userId: readerId,
        text,
        createdAt: i + 1,
      });
    for (let i = 0; i < 5; i++)
      server.gateway.sendToUser(readerId, {
        type: "ephemeral.message",
        id: "post-answer-31",
        channelId,
        userId: readerId,
        text: "updated last answer",
        createdAt: 40 + i,
      });
    await expect
      .poll(() => client.state.ephemerals[channelId]?.at(-1)?.text)
      .toBe("updated last answer");
    const kept = Object.values(client.state.ephemerals).flat();
    const chars = kept.reduce((n, m) => n + m.text.length, 0);
    expect(kept.length).toBeLessThanOrEqual(EPHEMERAL_LIMITS.perConversation);
    expect(chars).toBeLessThanOrEqual(EPHEMERAL_LIMITS.totalChars);
    expect(
      kept.every((m) => m.text.length <= EPHEMERAL_LIMITS.answerChars + EPHEMERAL_CUT_NOTE.length),
    ).toBe(true);
    expect(kept.filter((m) => m.id === "post-answer-31")).toHaveLength(1);
    observations.push({
      name: "REV04_private_answer_bounds",
      classification: "corrected behavior verified",
      frames: 37,
      kept: kept.length,
      chars,
      repeatedRows: 1,
      droppedNoticeCount: client.state.ephemeralsDropped[channelId],
      maxAnswerCharsIncludingCutNote: Math.max(...kept.map((m) => m.text.length)),
      transport:
        "server gateway sends actual socket frames; synthetic command output bypasses command execution",
    });
  });

  it("repeated forward-page calls replace identical transfers instead of sharing them", async () => {
    const messages = [];
    for (let i = 0; i < 4; i++)
      messages.push((await owner.sendMessage(channelId, { text: `forward ${i}` })).message);
    await expect.poll(() => client.state.lastSeq).toBe(server.store.currentSeq());
    client.store.setState({
      timelines: {
        [channelId]: { loaded: true, items: [messages[0]!], hasMore: false, hasMoreNewer: true },
      },
    });
    const originalFetch = globalThis.fetch;
    const gate = deferred<void>();
    releases.push(() => gate.resume());
    const transfers: { signal?: AbortSignal; responseAcquired: boolean }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      if (!String(args[0]).includes(`/messages/after/${messages[0]!.id}`))
        return originalFetch(...args);
      const transfer = {
        signal: args[1]?.signal as AbortSignal | undefined,
        responseAcquired: false,
      };
      transfers.push(transfer);
      const response = await originalFetch(...args);
      transfer.responseAcquired = true;
      await gate.promise;
      return response;
    });
    const first = client.loadNewer(channelId);
    await expect.poll(() => transfers[0]?.responseAcquired).toBe(true);
    const second = client.loadNewer(channelId);
    await expect.poll(() => transfers[1]?.responseAcquired).toBe(true);
    expect(transfers).toHaveLength(2);
    expect(transfers[0]!.signal?.aborted).toBe(true);
    gate.resume();
    await Promise.all([first, second]);
    expect(client.state.timelines[channelId]!.items.map((m) => m.id)).toEqual(
      messages.map((m) => m.id),
    );
    observations.push({
      name: "identical_forward_history_not_shared",
      classification: "new confirmed optimization gap",
      identicalRequests: transfers.length,
      firstSignalAborted: true,
      duplicateInstalledRows: false,
      limitation:
        "Explicit client anchored-window seed with real message IDs and real HTTP responses. No rapid-click production UI journey or body-cost timing measured.",
    });
  });

  it("a deleted attachment remains downloadable from the client blob cache", async () => {
    const file = await upload(channelId, "synthetic deleted attachment bytes");
    const message = (
      await owner.sendMessage(channelId, { text: "attachment to delete", fileIds: [file.id] })
    ).message;
    await client.loadTimeline(channelId);
    client.files.retain(file.id);
    const cached = await client.files.get(file.id);
    client.files.release(file.id);
    expect(await resolveObjectURL(cached)!.text()).toBe("synthetic deleted attachment bytes");
    await owner.deleteMessage(message.id);
    await expect
      .poll(() => client.state.timelines[channelId]!.items.some((m) => m.id === message.id))
      .toBe(false);
    const denied = await fetch(`${client.baseUrl}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });
    expect(denied.status).toBe(404);
    expect(client.files.peek(file.id)).toBe(cached);
    expect(await client.files.get(file.id)).toBe(cached);
    observations.push({
      name: "deleted_attachment_cache_retention",
      classification: "new confirmed cleanup gap",
      serverStatusAfterDelete: denied.status,
      messageRemovedFromTimeline: true,
      blobUrlRetained: true,
      cachedBytesStillReadable: true,
      limitation:
        "Downloaded bytes cannot be retroactively unrevealed; no authorization bypass or remote exploit. Cache entry remains resident and can be returned locally after the message's real deletion event.",
    });
  });

  it("revoked private-channel file cache is purged only when history carries its metadata", async () => {
    const { channel } = await owner.createChannel({ type: "private", name: "diagnostic-private" });
    await owner.inviteMember(channel.id, readerId);
    await expect.poll(() => Boolean(client.state.channels[channel.id])).toBe(true);
    const file = await upload(channel.id, "synthetic formerly private bytes");
    await owner.sendMessage(channel.id, { text: "private attachment", fileIds: [file.id] });
    await client.loadTimeline(channel.id);
    const cached = await client.files.get(file.id);
    // Equivalent metadata state after inactive history eviction: FileCache itself has no channel index.
    client.store.setState((s) => ({
      timelines: Object.fromEntries(
        Object.entries(s.timelines).filter(([id]) => id !== channel.id),
      ),
    }));
    await owner.removeChannelMember(channel.id, readerId);
    await expect.poll(() => Boolean(client.state.channels[channel.id])).toBe(false);
    const denied = await fetch(`${client.baseUrl}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });
    expect([403, 404]).toContain(denied.status);
    expect(client.files.peek(file.id)).toBe(cached);
    expect(await client.files.get(file.id)).toBe(cached);
    observations.push({
      name: "revoked_channel_cache_without_history",
      classification: "new confirmed cleanup gap",
      serverStatusAfterRevocation: denied.status,
      channelRemovedFromState: true,
      cachedFileReturnedAfterRevocation: true,
      limitation:
        "History absence seeded directly to isolate real revocation/metadata dependency; actual 20-page eviction browser journey not repeated. Already-downloaded bytes are not a server authorization bypass.",
    });
  });
});
