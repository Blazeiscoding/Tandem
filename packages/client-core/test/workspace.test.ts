import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient, normalizeServerUrl } from "../src/index.js";
import type { WorkspaceState } from "../src/index.js";

let server: WorkspaceServer;
let base: string;
let dataDir: string;
let aliceToken: string;
let bobToken: string;
let bobId: string;

/** Resolves once the store satisfies `predicate`, or rejects on timeout. */
function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
  timeoutMs = 5000,
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-client-"));
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    workspaceName: "Sync Test",
    mdns: false,
    // These build long channels by posting hundreds of messages in a loop,
    // which is exactly the flooding the limits exist to refuse. What is under
    // test here is the client's paging, not the server's rationing.
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;

  const api = new Api(base);
  aliceToken = (
    await api.register({ handle: "alice", displayName: "Alice", password: "password123" })
  ).token;
  const bob = await api.register({ handle: "bob", displayName: "Bob", password: "password123" });
  bobToken = bob.token;
  bobId = bob.user.id;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("WorkspaceClient", () => {
  it("syncs friend requests live and restores them on reconnect", async () => {
    const aliceClient = new WorkspaceClient(base, aliceToken);
    const bobClient = new WorkspaceClient(base, bobToken);
    aliceClient.connect();
    bobClient.connect();
    try {
      await Promise.all([
        until(aliceClient, (s) => s.status === "online"),
        until(bobClient, (s) => s.status === "online"),
      ]);
      await aliceClient.api.updateFriend(bobId, "request");
      await until(bobClient, (s) => s.friends[0]?.status === "incoming");
      await bobClient.api.updateFriend(aliceClient.state.self!.id, "accept");
      await until(aliceClient, (s) => s.friends[0]?.status === "accepted");
      bobClient.destroy();
      const reconnected = new WorkspaceClient(base, bobToken);
      reconnected.connect();
      try {
        await until(reconnected, (s) => s.friends[0]?.status === "accepted");
      } finally {
        reconnected.destroy();
      }
      await aliceClient.api.updateFriend(bobId, "remove");
      await until(aliceClient, (s) => s.friends.length === 0);
    } finally {
      aliceClient.destroy();
      bobClient.destroy();
    }
  });
  it("normalizes whatever address the user typed", () => {
    expect(normalizeServerUrl("192.168.1.4:8543")).toBe("http://192.168.1.4:8543");
    expect(normalizeServerUrl("192.168.1.4")).toBe("http://192.168.1.4:8543");
    expect(normalizeServerUrl("  chat.example.dev  ")).toBe("http://chat.example.dev:8543");
    expect(normalizeServerUrl("https://chat.example.dev")).toBe("https://chat.example.dev");
  });

  it("builds a local replica from the ready snapshot", async () => {
    const client = new WorkspaceClient(base, aliceToken);
    client.connect();
    const state = await until(client, (s) => s.status === "online", "connection");

    expect(state.workspaceName).toBe("Sync Test");
    expect(state.self?.handle).toBe("alice");
    expect(
      Object.values(state.users)
        .map((u) => u.handle)
        .sort(),
    ).toEqual(["alice", "bob"]);
    expect(Object.values(state.channels).some((c) => c.name === "general")).toBe(true);
    client.destroy();
  });

  it("shows a sent message immediately and reconciles it with the server's copy", async () => {
    const client = new WorkspaceClient(base, aliceToken);
    client.connect();
    await until(client, (s) => s.status === "online");
    const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
    await client.loadTimeline(general.id);

    client.send(general.id, "optimistic hello");
    // Visible as pending before any round trip.
    expect(client.state.pending).toHaveLength(1);
    expect(client.state.pending[0]!.text).toBe("optimistic hello");

    // The server event replaces it; no duplicate is left behind.
    await until(
      client,
      (s) =>
        s.pending.length === 0 &&
        (s.timelines[general.id]?.items ?? []).filter((m) => m.text === "optimistic hello")
          .length === 1,
      "reconciliation",
    );
    client.destroy();
  });

  it("replays what it missed while disconnected", async () => {
    const client = new WorkspaceClient(base, aliceToken);
    client.connect();
    await until(client, (s) => s.status === "online");
    const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
    await client.loadTimeline(general.id);
    const seqBefore = client.state.lastSeq;

    // Bob posts while this client is offline.
    client.destroy();
    await new Api(base, bobToken).sendMessage(general.id, { text: "you missed this" });

    const reconnected = new WorkspaceClient(base, aliceToken);
    // Resume from the earlier seq, the way a returning client would.
    reconnected.store.setState({ lastSeq: seqBefore });
    reconnected.connect();
    await until(reconnected, (s) => s.status === "online");
    await reconnected.loadTimeline(general.id);
    await until(
      reconnected,
      (s) => (s.timelines[general.id]?.items ?? []).some((m) => m.text === "you missed this"),
      "replayed message",
    );
    reconnected.destroy();
  });

  it("applies reactions, pins and saves from events", async () => {
    const client = new WorkspaceClient(base, aliceToken);
    client.connect();
    await until(client, (s) => s.status === "online");
    const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
    await client.loadTimeline(general.id);

    const { message } = await client.api.sendMessage(general.id, { text: "mark me up" });
    await until(
      client,
      (s) => (s.timelines[general.id]?.items ?? []).some((m) => m.id === message.id),
      "message arrival",
    );

    const find = (s: WorkspaceState) =>
      (s.timelines[general.id]?.items ?? []).find((m) => m.id === message.id);

    // Bob reacts; the reaction shows up here.
    await new Api(base, bobToken).addReaction(message.id, "🎯");
    const reacted = await until(client, (s) => (find(s)?.reactions.length ?? 0) > 0, "reaction");
    expect(find(reacted)!.reactions[0]).toEqual({ emoji: "🎯", userIds: [bobId] });

    client.togglePin(find(client.state)!);
    expect(find(client.state)!.pinned).toBe(true); // optimistic
    await until(client, (s) => find(s)!.pinned, "pin confirmed");

    client.toggleSaved(message.id);
    await until(client, (s) => !!s.saved[message.id], "saved");

    client.toggleSaved(message.id);
    await until(client, (s) => !s.saved[message.id], "unsaved");
    client.destroy();
  });

  it("tracks unread state against what the user has read", async () => {
    const client = new WorkspaceClient(base, aliceToken);
    client.connect();
    await until(client, (s) => s.status === "online");
    const general = Object.values(client.state.channels).find((c) => c.name === "general")!;

    await new Api(base, bobToken).sendMessage(general.id, { text: "unread ping" });
    await until(client, () => client.unreadCount(general.id), "unread flag");

    client.markRead(general.id);
    expect(client.unreadCount(general.id)).toBe(false);
    client.destroy();
  });

  it("keeps drafts per conversation", async () => {
    const client = new WorkspaceClient(base, aliceToken);
    client.setDraft("C1", "half-written");
    client.setDraft("C2", "another one");
    expect(client.state.drafts).toEqual({ C1: "half-written", C2: "another one" });

    client.setDraft("C1", "   ");
    expect(client.state.drafts).toEqual({ C2: "another one" });
    client.destroy();
  });
  it("keeps a bounded window of messages while scrolling a long channel", async () => {
    // A channel far longer than the window, so paging has to drop the far end.
    const api = new Api(base, aliceToken);
    const { channel } = await api.createChannel({ type: "public", name: "scrollback" });
    for (let i = 0; i < 400; i++) {
      await api.sendMessage(channel.id, { text: `history ${i}` });
    }

    const client = new WorkspaceClient(base, aliceToken);
    onTestFinished(() => client.destroy());
    client.connect();
    await until(client, (s) => s.status === "online");
    const window = () => client.state.timelines[channel.id]!;

    await client.loadTimeline(channel.id);
    expect(window().items).toHaveLength(50);

    // Five more pages fill the window exactly; nothing has been dropped yet.
    for (let i = 0; i < 5; i++) await client.loadTimeline(channel.id, { older: true });
    expect(window().items).toHaveLength(300);
    expect(window().hasMoreNewer).toBe(false);

    // Past that, the newest end goes and is marked pageable again.
    const newestBefore = window().items[299]!.id;
    await client.loadTimeline(channel.id, { older: true });
    expect(window().items).toHaveLength(300);
    expect(window().hasMoreNewer).toBe(true);
    expect(window().items[299]!.id < newestBefore).toBe(true);

    // Paging back down trades the other end, and stays bounded either way.
    await client.loadNewer(channel.id);
    expect(window().items).toHaveLength(300);
    expect(window().hasMore).toBe(true);
  }, 20_000); // Includes 400 real HTTP writes, not just the paging assertions.

  it("trims the oldest messages rather than growing forever at the tail", async () => {
    const api = new Api(base, aliceToken);
    const { channel } = await api.createChannel({ type: "public", name: "busy" });
    for (let i = 0; i < 320; i++) await api.sendMessage(channel.id, { text: `chatter ${i}` });

    const client = new WorkspaceClient(base, aliceToken);
    onTestFinished(() => client.destroy());
    client.connect();
    await until(client, (s) => s.status === "online");
    const window = () => client.state.timelines[channel.id]!;

    // A full window, sitting at the tail rather than anchored mid-history.
    await client.loadTimeline(channel.id);
    for (let i = 0; i < 5; i++) await client.loadTimeline(channel.id, { older: true });
    expect(window().items).toHaveLength(300);
    const oldestBefore = window().items[0]!.id;

    await new Api(base, bobToken).sendMessage(channel.id, { text: "one more" });
    await until(
      client,
      (s) => (s.timelines[channel.id]?.items ?? []).some((m) => m.text === "one more"),
      "live message",
    );
    expect(window().items).toHaveLength(300);
    expect(window().items[0]!.id > oldestBefore).toBe(true);
    expect(window().hasMore).toBe(true);
  }, 20_000);
});
