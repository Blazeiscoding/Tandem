import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient, unreadThreadCount } from "../src/index.js";

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
  await client.loadTimeline(channelId);
  client.focusConversation(channelId);
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
});

/** Posts as the other account and waits for it to arrive on the socket. */
async function incoming(text: string, threadRootId?: string) {
  const { message } = await owner.sendMessage(channelId, { text, nonce: text, threadRootId });
  await expect
    .poll(() =>
      threadRootId
        ? client.state.threads[threadRootId]?.some((m) => m.id === message.id)
        : client.state.timelines[channelId]?.items.some((m) => m.id === message.id),
    )
    .toBe(true);
  return message;
}

const lastRead = () => client.state.memberships[channelId] ?? 0;

describe("mark unread", () => {
  it("holds a conversation unread against the automatic acknowledgement behind it", async () => {
    const first = await incoming("First");
    const second = await incoming("Second");
    client.markRead(channelId, second.seq);
    await expect.poll(lastRead).toBe(second.seq);

    client.markUnread(channelId, second.seq);
    expect(lastRead()).toBe(second.seq - 1);

    // The timeline keeps acknowledging its visible tail; the hold ignores it.
    client.markRead(channelId, second.seq);
    expect(lastRead()).toBe(second.seq - 1);
    await expect
      .poll(async () => (await owner.listChannels()) && client.state.memberships[channelId])
      .toBe(second.seq - 1);
    expect(first.seq).toBeLessThan(second.seq);
  });

  it("lifts the hold once the conversation is left, so coming back reads it", async () => {
    const message = await incoming("Later");
    client.markRead(channelId, message.seq);
    client.markUnread(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);

    client.focusConversation(null);
    client.focusConversation(channelId);
    client.markRead(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq);
  });

  it("lets an explicit read through clear the hold, unlike the timeline's own", async () => {
    const message = await incoming("Read me on purpose");
    client.markUnread(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq - 1);

    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);

    client.markRead(channelId, message.seq, { explicit: true });
    await expect.poll(lastRead).toBe(message.seq);
  });

  it("keeps the hold across a resync that discards loaded history", async () => {
    const message = await incoming("Survives resync");
    client.markUnread(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq - 1);

    (client as unknown as { resetHistory: () => void }).resetHistory();
    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);
  });

  it("puts the cursor back when the server refuses", async () => {
    const message = await incoming("Rejected");
    client.markRead(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq);

    vi.spyOn(client.api, "markUnread").mockRejectedValue(new Error("offline"));
    client.markUnread(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);
    await expect.poll(lastRead).toBe(message.seq);

    // The failed hold was released, so ordinary reading works again.
    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq);
  });

  it("marks a thread unread without touching the channel, and counts it", async () => {
    const root = await incoming("Thread root");
    await client.loadThread(root.id, channelId, "latest");
    const reply = await incoming("A reply", root.id);
    client.focusThread(root.id);
    client.markThreadRead(root.id);
    await expect.poll(() => unreadThreadCount(client.state.threadFollows)).toBe(0);

    const channelCursor = lastRead();
    client.markThreadUnread(root.id, reply.seq);
    await expect.poll(() => unreadThreadCount(client.state.threadFollows)).toBe(1);
    expect(lastRead()).toBe(channelCursor);

    // Reading the thread again is held until the panel is left.
    client.markThreadRead(root.id);
    expect(unreadThreadCount(client.state.threadFollows)).toBe(1);
    client.focusThread(null);
    client.focusThread(root.id);
    client.markThreadRead(root.id);
    await expect.poll(() => unreadThreadCount(client.state.threadFollows)).toBe(0);
  });
});
