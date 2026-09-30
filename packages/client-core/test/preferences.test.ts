import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import type { ChannelPrefs } from "@slackoss/protocol";
import { Api, WorkspaceClient } from "../src/index.js";

let server: WorkspaceServer;
let client: WorkspaceClient;
/** The same account on another device. */
let elsewhere: Api;
let owner: Api;
let base: string;
let channelId: string;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  elsewhere = new Api(base, b.token);
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
});

/** Holds the next preference request until the test says how it ends. */
function holdNextPrefsRequest() {
  let fail = () => {};
  let pass = () => {};
  const real = client.api.setChannelPrefs.bind(client.api);
  vi.spyOn(client.api, "setChannelPrefs").mockImplementationOnce(
    (id, body) =>
      new Promise((resolve, reject) => {
        fail = () => reject(new Error("offline"));
        pass = () => void real(id, body).then(resolve, reject);
      }),
  );
  return { fail: () => fail(), pass: () => pass() };
}

const shown = () => client.state.prefs[channelId];
const stored = (): ChannelPrefs | null => {
  const userId = client.state.self!.id;
  return server.store.getChannelPrefs(channelId, userId);
};

describe("a notification choice for a channel", () => {
  it("keeps a later choice when an earlier one fails", async () => {
    expect(shown()?.notifyLevel).toBe("mentions");
    const first = holdNextPrefsRequest();
    client.setChannelPrefs(channelId, { notifyLevel: "all" });
    client.setChannelPrefs(channelId, { notifyLevel: "nothing" });
    expect(shown()?.notifyLevel).toBe("nothing");

    // The first request fails after the second was chosen. It used to put
    // back what was there before the first: "mentions".
    first.fail();
    await expect.poll(() => stored()?.notifyLevel).toBe("nothing");
    await expect.poll(() => client.state.prefsWrites[channelId]).toBeUndefined();
    expect(shown()?.notifyLevel).toBe("nothing");
  });

  it("saves choices in the order they were made", async () => {
    const first = holdNextPrefsRequest();
    const sent = vi.spyOn(client.api, "setChannelPrefs");
    client.setChannelPrefs(channelId, { notifyLevel: "all" });
    client.setChannelPrefs(channelId, { notifyLevel: "nothing" });
    client.setChannelPrefs(channelId, { muted: true });
    // Nothing else goes out while the first is unanswered, so it cannot be
    // applied after the ones chosen later.
    expect(sent).toHaveBeenCalledTimes(1);
    expect(client.state.prefsWrites[channelId]).toEqual({ saving: true, failed: null });

    first.pass();
    await expect.poll(() => stored()).toEqual({ notifyLevel: "nothing", muted: true });
    // What was chosen meanwhile went as one request.
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]).toEqual([channelId, { notifyLevel: "nothing", muted: true }]);
    await expect.poll(() => client.state.prefsWrites[channelId]).toBeUndefined();
  });

  it("shows what the server has after a refusal, and keeps the choice to try again", async () => {
    const refused = holdNextPrefsRequest();
    client.setChannelPrefs(channelId, { muted: true });
    expect(shown()?.muted).toBe(true);
    refused.fail();

    await expect
      .poll(() => client.state.prefsWrites[channelId])
      .toEqual({ saving: false, failed: { muted: true } });
    expect(shown()?.muted).toBe(false);

    client.retryChannelPrefs(channelId);
    expect(shown()?.muted).toBe(true);
    await expect.poll(() => stored()?.muted).toBe(true);
    await expect.poll(() => client.state.prefsWrites[channelId]).toBeUndefined();
    expect(shown()?.muted).toBe(true);
  });

  it("keeps a choice being saved over another device's, and falls back to that one if it fails", async () => {
    const mine = holdNextPrefsRequest();
    client.setChannelPrefs(channelId, { notifyLevel: "all" });
    await elsewhere.setChannelPrefs(channelId, { notifyLevel: "nothing", muted: true });
    // The other device's echo arrives while this choice is still unanswered.
    await expect.poll(() => shown()?.muted).toBe(true);
    expect(shown()?.notifyLevel).toBe("all");

    mine.fail();
    await expect.poll(() => shown()).toEqual({ notifyLevel: "nothing", muted: true });
  });

  it("does not bring back a channel this account has left while a choice was out", async () => {
    const { channel } = await owner.createChannel({ name: "side-project", type: "public" });
    await elsewhere.joinChannel(channel.id);
    await expect.poll(() => client.state.memberships[channel.id]).toBeDefined();

    let fail = () => {};
    vi.spyOn(client.api, "setChannelPrefs").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("offline"));
        }),
    );
    client.setChannelPrefs(channel.id, { muted: true });
    await elsewhere.leaveChannel(channel.id);
    await expect.poll(() => client.state.prefs[channel.id]).toBeUndefined();

    fail();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.state.prefs[channel.id]).toBeUndefined();
    expect(client.state.prefsWrites[channel.id]).toBeUndefined();
  });
});

describe("Do Not Disturb", () => {
  it("keeps a later snooze when an earlier one fails, and nothing else in the profile moves", async () => {
    let fail = () => {};
    vi.spyOn(client.api, "updateMe").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("offline"));
        }),
    );
    const soon = Date.now() + 60_000;
    const later = Date.now() + 3_600_000;
    client.snoozeNotificationsUntil(soon);
    client.snoozeNotificationsUntil(later);
    await expect.poll(async () => (await elsewhere.me()).user.dndUntil).toBe(later);

    fail();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // It used to put the whole profile back as it was before the first.
    expect(client.state.self?.dndUntil).toBe(later);
  });

  it("goes back to what the server has when the latest snooze is refused", async () => {
    vi.spyOn(client.api, "updateMe").mockRejectedValueOnce(new Error("offline"));
    client.snoozeNotificationsUntil(Date.now() + 60_000);
    await expect.poll(() => client.state.self?.dndUntil).toBeNull();
  });
});

describe("toggles on a message", () => {
  async function postedMessage() {
    await client.loadTimeline(channelId);
    const { message } = await owner.sendMessage(channelId, { text: "keep this", nonce: "keep" });
    await expect
      .poll(() => client.state.timelines[channelId]?.items.some((m) => m.id === message.id))
      .toBe(true);
    return message;
  }
  const shownMessage = (id: string) =>
    client.state.timelines[channelId]!.items.find((m) => m.id === id)!;

  it("keeps the latest save choice when an earlier one fails", async () => {
    const message = await postedMessage();
    let fail = () => {};
    vi.spyOn(client.api, "saveMessage").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("offline"));
        }),
    );
    void client.toggleSaved(message.id, true);
    await client.toggleSaved(message.id, false);
    await client.toggleSaved(message.id, true);
    expect(client.state.saved[message.id]).toBe(true);

    fail();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // It used to put back what was there before the first: not saved.
    expect(client.state.saved[message.id]).toBe(true);
    expect((await elsewhere.listSaved()).messages.map((m) => m.id)).toContain(message.id);
  });

  it("keeps the latest pin choice when an earlier one fails", async () => {
    const message = await postedMessage();
    let fail = () => {};
    vi.spyOn(client.api, "pinMessage").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("offline"));
        }),
    );
    void client.togglePin(message);
    await client.togglePin({ ...message, pinned: true });
    await client.togglePin({ ...message, pinned: false });
    await expect.poll(() => shownMessage(message.id).pinned).toBe(true);

    fail();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shownMessage(message.id).pinned).toBe(true);
  });
});
