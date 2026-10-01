import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, WorkspaceClient } from "@slackoss/client-core";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";

/** Diagnostic assertions describe the reviewed behavior, not intended fixes. */
const observations: Record<string, unknown>[] = [];
let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;
let readerId: string;
let readerToken: string;
const extraClients: WorkspaceClient[] = [];
const releases: (() => void)[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const unauthenticated = new Api(baseUrl);
  const account = await unauthenticated.register({
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  const reader = await unauthenticated.register({
    handle: "reader",
    displayName: "Reader",
    password: "password123",
  });
  owner = new Api(baseUrl, account.token);
  readerId = reader.user.id;
  readerToken = reader.token;
  client = new WorkspaceClient(baseUrl, reader.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find(
    (channel) => channel.name === "general",
  )!.id;
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  client?.destroy();
  for (const extra of extraClients.splice(0)) extra.destroy();
  await server?.stop();
  vi.restoreAllMocks();
});

afterAll(() => {
  writeFileSync(
    new URL("client-state-evidence.json", import.meta.url),
    JSON.stringify(
      {
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        runtime: { node: process.version, platform: process.platform },
        scope:
          "Current production source, in-memory real HTTP/WebSocket server; no comparative latency measurement.",
        observations,
      },
      null,
      2,
    ) + "\n",
  );
});

describe("current-source state/lifecycle diagnostics", () => {
  it("real unrelated socket events replace every same-channel thread cache reference", async () => {
    const first = (await owner.sendMessage(channelId, { text: "first root" })).message;
    const second = (await owner.sendMessage(channelId, { text: "second root" })).message;
    await owner.sendMessage(channelId, { text: "first reply", threadRootId: first.id });
    await owner.sendMessage(channelId, { text: "second reply", threadRootId: second.id });
    await expect.poll(() => client.state.lastSeq).toBe(server.store.currentSeq());
    await client.loadThread(first.id, channelId);
    await client.loadThread(second.id, channelId);
    const before = client.state;
    const unrelated = (await owner.sendMessage(channelId, { text: "unrelated top-level" })).message;
    await expect.poll(() => client.state.lastSeq).toBe(unrelated.seq);
    const after = client.state;
    const rows = [first.id, second.id].map((rootId) => ({
      rootId,
      repliesReferenceChanged: before.threads[rootId] !== after.threads[rootId],
      pageReferenceChanged: before.threadPages[rootId] !== after.threadPages[rootId],
      repliesContentUnchanged:
        JSON.stringify(before.threads[rootId]) === JSON.stringify(after.threads[rootId]),
    }));
    expect(
      rows.every(
        (row) =>
          row.repliesReferenceChanged && row.pageReferenceChanged && row.repliesContentUnchanged,
      ),
    ).toBe(true);
    observations.push({
      name: "unrelated_thread_cache_references",
      transport: "real HTTP and WebSocket",
      rows,
    });
  });

  it("equivalent unloaded history reads overlap and destruction does not abort their fetch signals", async () => {
    await owner.sendMessage(channelId, { text: "history fixture" });
    const originalFetch = globalThis.fetch;
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    const transfers: { signal: AbortSignal | null; delivered: boolean }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const url = String(args[0]);
      if (!url.includes(`/api/channels/${channelId}/messages`)) return originalFetch(...args);
      const transfer = {
        signal: (args[1]?.signal as AbortSignal | undefined) ?? null,
        delivered: false,
      };
      transfers.push(transfer);
      const response = await originalFetch(...args);
      // Hold delivery after the real HTTP response. Preserve the actual fetch signal.
      await gate.promise;
      transfer.delivered = true;
      return response;
    });
    const first = client.loadTimeline(channelId);
    const second = client.loadTimeline(channelId);
    await expect.poll(() => transfers.length).toBe(2);
    client.destroy();
    const abortedAtDestroy = transfers.map(({ signal }) => signal?.aborted ?? null);
    expect(abortedAtDestroy).toEqual([false, false]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(client.state.timelines[channelId]).toBeUndefined();
    observations.push({
      name: "duplicate_history_and_destroy_signals",
      equivalentRequests: transfers.length,
      abortedAtDestroy,
      responsesDeliveredAfterDestroy: transfers.filter((transfer) => transfer.delivered).length,
      lateResponseInstalled: Boolean(client.state.timelines[channelId]),
      limitation:
        "Real HTTP response acquired before a delivery gate; verifies caller signals and late-response guards, not wasted body-transfer bytes.",
    });
  });

  it("real ephemeral socket frames grow beyond the history cap and retain duplicate IDs", async () => {
    const unique = 1_000;
    const text = "private diagnostic answer " + "x".repeat(1_000);
    for (let i = 0; i < unique; i++)
      server.gateway.sendToUser(readerId, {
        type: "ephemeral.message",
        channelId,
        id: `PRIVATE-${i}`,
        userId: readerId,
        text,
        createdAt: Date.now(),
      });
    await expect.poll(() => client.state.ephemerals[channelId]?.length).toBe(unique);
    for (let i = 0; i < 5; i++)
      server.gateway.sendToUser(readerId, {
        type: "ephemeral.message",
        channelId,
        id: "PRIVATE-0",
        userId: readerId,
        text,
        createdAt: Date.now(),
      });
    await expect.poll(() => client.state.ephemerals[channelId]?.length).toBe(unique + 5);
    const held = client.state.ephemerals[channelId]!;
    expect(held.filter((entry) => entry.id === "PRIVATE-0")).toHaveLength(6);
    observations.push({
      name: "ephemeral_growth",
      transport: "real gateway sender and reader socket; no external command service",
      uniqueFrames: unique,
      repeatedFrames: 5,
      retainedItems: held.length,
      retainedTextUtf8Bytes: Buffer.byteLength(held.map((entry) => entry.text).join("")),
      duplicateIdRows: held.filter((entry) => entry.id === "PRIVATE-0").length,
      limitation:
        "Injected at production gateway's private-response boundary; no end-to-end slash-command provider call or renderer memory timing.",
    });
  });

  it("pin choices overlap real writes and schedule a repair write even after client destruction", async () => {
    const message = (await owner.sendMessage(channelId, { text: "pin lifetime fixture" })).message;
    await client.loadTimeline(channelId);
    const originalPin = client.api.pinMessage.bind(client.api);
    const originalUnpin = client.api.unpinMessage.bind(client.api);
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    let pinCalls = 0;
    let unpinCalls = 0;
    vi.spyOn(client.api, "pinMessage").mockImplementation(async (id) => {
      pinCalls++;
      if (pinCalls === 1) await gate.promise;
      return originalPin(id);
    });
    vi.spyOn(client.api, "unpinMessage").mockImplementation(async (id) => {
      unpinCalls++;
      return originalUnpin(id);
    });
    const earlier = client.togglePin(message);
    const later = client.togglePin({ ...message, pinned: true });
    await expect.poll(() => unpinCalls).toBe(1);
    await later;
    const observedBeforeFirstReleased = {
      pinCalls,
      unpinCalls,
      stopped: client.state.status === "closed",
    };
    client.destroy();
    gate.resolve();
    await earlier;
    await expect.poll(() => unpinCalls).toBe(2);
    await expect.poll(() => server.store.getMessage(message.id)?.pinned).toBe(false);
    observations.push({
      name: "choice_overlap_and_post_destroy_repair",
      transport: "real writes; first pin delayed before forwarding",
      observedBeforeFirstReleased,
      totalPinCalls: pinCalls,
      totalUnpinCalls: unpinCalls,
      repairRequestAfterDestroy: true,
      serverEndsPinned: server.store.getMessage(message.id)?.pinned,
      limitation:
        "Intentional API forwarding gate; confirms lifecycle/concurrency boundary, not an ordinary final-state convergence failure or an auth bypass.",
    });
  });

  it("a destroyed client's repair overrides the newer pin chosen by its replacement client", async () => {
    const message = (await owner.sendMessage(channelId, { text: "replacement intent fixture" }))
      .message;
    await client.loadTimeline(channelId);
    const originalPin = client.api.pinMessage.bind(client.api);
    const originalUnpin = client.api.unpinMessage.bind(client.api);
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    let oldPinCalls = 0;
    let oldUnpinCalls = 0;
    vi.spyOn(client.api, "pinMessage").mockImplementation(async (id) => {
      oldPinCalls++;
      if (oldPinCalls === 1) await gate.promise;
      return originalPin(id);
    });
    vi.spyOn(client.api, "unpinMessage").mockImplementation(async (id) => {
      oldUnpinCalls++;
      return originalUnpin(id);
    });
    const earlier = client.togglePin(message);
    await client.togglePin({ ...message, pinned: true });
    client.destroy();
    const replacement = new WorkspaceClient(client.baseUrl, readerToken);
    extraClients.push(replacement);
    replacement.connect();
    await expect.poll(() => replacement.state.status).toBe("online");
    await replacement.loadTimeline(channelId);
    expect(await replacement.togglePin(message)).toBe(true);
    expect(server.store.getMessage(message.id)?.pinned).toBe(true);
    gate.resolve();
    await earlier;
    await expect.poll(() => oldUnpinCalls).toBe(2);
    await expect.poll(() => server.store.getMessage(message.id)?.pinned).toBe(false);
    await expect
      .poll(
        () =>
          replacement.state.timelines[channelId]?.items.find((item) => item.id === message.id)
            ?.pinned,
      )
      .toBe(false);
    observations.push({
      name: "destroyed_choice_overrides_replacement_intent",
      transport:
        "same account/token, real replacement connection and real HTTP writes; first old write gated before forwarding",
      replacementPinnedBeforeRelease: true,
      serverPinnedAfterOldRepair: server.store.getMessage(message.id)?.pinned,
      replacementShowsPinnedAfterOldRepair: replacement.state.timelines[channelId]?.items.find(
        (item) => item.id === message.id,
      )?.pinned,
      oldPinCalls,
      oldUnpinCalls,
      limitation:
        "Account token intentionally stays valid across workspace close/reopen; no logout or authorization bypass.",
    });
  });

  it("logout revokes the token so post-destroy repair attempts cannot mutate the message", async () => {
    const message = (await owner.sendMessage(channelId, { text: "logout control fixture" }))
      .message;
    await client.loadTimeline(channelId);
    const originalPin = client.api.pinMessage.bind(client.api);
    const originalUnpin = client.api.unpinMessage.bind(client.api);
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    let oldUnpinCalls = 0;
    let repairFinished = false;
    vi.spyOn(client.api, "pinMessage").mockImplementation(async (id) => {
      await gate.promise;
      return originalPin(id);
    });
    vi.spyOn(client.api, "unpinMessage").mockImplementation(async (id) => {
      oldUnpinCalls++;
      try {
        return await originalUnpin(id);
      } finally {
        if (oldUnpinCalls === 2) repairFinished = true;
      }
    });
    const earlier = client.togglePin(message);
    await client.togglePin({ ...message, pinned: true });
    await client.api.logout();
    client.destroy();
    await owner.pinMessage(message.id);
    gate.resolve();
    await earlier;
    await expect.poll(() => repairFinished).toBe(true);
    expect(server.store.getMessage(message.id)?.pinned).toBe(true);
    observations.push({
      name: "logout_revocation_control",
      realLogout: true,
      postDestroyRepairAttempts: oldUnpinCalls - 1,
      serverPinPreserved: server.store.getMessage(message.id)?.pinned,
      interpretation:
        "Callback still tries a repair after logout, but server session revocation rejects it; no auth bypass.",
    });
  });
});
