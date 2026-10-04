import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient } from "@slackoss/client-core";

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const account = await new Api(base).register({
    handle: "researchowner",
    displayName: "Research Owner",
    password: "password123",
  });
  owner = new Api(base, account.token);
  client = new WorkspaceClient(base, account.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find(
    (channel) => channel.name === "general",
  )!.id;
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
});

async function root() {
  const { message } = await owner.sendMessage(channelId, { text: "Research root" });
  await client.loadThread(message.id, channelId);
  return message;
}

describe("new client latest-intent diagnostics", () => {
  it("reordered Follow then Unfollow ends followed despite the author's latest unfollow", async () => {
    const message = await root();
    const original = client.api.setThreadFollow.bind(client.api);
    const release = deferred<void>();
    const following = vi
      .spyOn(client.api, "setThreadFollow")
      .mockImplementation(async (id, value) => {
        if (value) await release.promise;
        return original(id, value);
      });
    client.setThreadFollow(message.id, true);
    expect(client.state.threadFollows[message.id]?.following).toBe(true);
    client.setThreadFollow(message.id, false);
    expect(client.state.threadFollows[message.id]?.following).toBe(false);
    await following.mock.results[1]!.value;
    await expect
      .poll(() => server.store.threadFollow(client.state.self!.id, message.id)?.following)
      .toBe(false);
    release.resolve();
    await following.mock.results[0]!.value;
    await expect.poll(() => client.state.threadFollows[message.id]?.following).toBe(true);
    expect(server.store.threadFollow(client.state.self!.id, message.id)?.following).toBe(true);
  });

  it("ordinary sequential Follow then Unfollow ends unfollowed", async () => {
    const message = await root();
    const following = vi.spyOn(client.api, "setThreadFollow");
    client.setThreadFollow(message.id, true);
    await following.mock.results[0]!.value;
    await expect.poll(() => client.state.threadFollows[message.id]?.following).toBe(true);
    client.setThreadFollow(message.id, false);
    await following.mock.results[1]!.value;
    await expect.poll(() => client.state.threadFollows[message.id]?.following).toBe(false);
    expect(server.store.threadFollow(client.state.self!.id, message.id)?.following).toBe(false);
  });

  it("an older repeated mark-unread failure rolls back a newer successful identical mark", async () => {
    const message = await root();
    const read = vi.spyOn(client.api, "markRead");
    client.markRead(channelId, message.seq, { explicit: true });
    await read.mock.results[0]!.value;
    expect(client.state.memberships[channelId]).toBe(message.seq);
    const failure = deferred<Awaited<ReturnType<typeof client.api.markUnread>>>();
    const mark = vi.spyOn(client.api, "markUnread").mockImplementationOnce(() => failure.promise);
    client.markUnread(channelId, message.seq);
    client.markUnread(channelId, message.seq);
    await mark.mock.results[1]!.value;
    expect(client.state.memberships[channelId]).toBe(message.seq - 1);
    expect(
      server.store
        .memberships(client.state.self!.id)
        .find((membership) => membership.channelId === channelId)?.lastReadSeq,
    ).toBe(message.seq - 1);
    failure.reject(new Error("Injected failure of older mark"));
    await expect.poll(() => client.state.memberships[channelId]).toBe(message.seq);
    expect(
      server.store
        .memberships(client.state.self!.id)
        .find((membership) => membership.channelId === channelId)?.lastReadSeq,
    ).toBe(message.seq - 1);
  });
});
