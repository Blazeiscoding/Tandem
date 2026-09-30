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

/**
 * Requests for one thing reaching the server out of order, or all failing
 * (RECHECK-05). The server ends with the latest choice, and so does the
 * screen; when every attempt fails, the screen goes back to what the server
 * has, not to the opposite of the last choice.
 */
describe("choices that reach the server out of order, or not at all", () => {
  type Held = "pinMessage" | "unpinMessage" | "saveMessage" | "unsaveMessage" | "updateMe";
  /** Holds the next call to `method` until the test forwards it to the server, or fails it. */
  function holdNext(method: Held) {
    let forward = () => {};
    let fail = () => {};
    const real = (client.api[method] as (...args: unknown[]) => Promise<unknown>).bind(client.api);
    vi.spyOn(client.api, method).mockImplementationOnce(
      ((...args: unknown[]) =>
        new Promise((resolve, reject) => {
          forward = () => void real(...args).then(resolve, reject);
          fail = () => reject(new Error("offline"));
        })) as never,
    );
    return { forward: () => forward(), fail: () => fail() };
  }

  async function postedMessage() {
    await client.loadTimeline(channelId);
    const { message } = await owner.sendMessage(channelId, { text: "choose", nonce: "choose" });
    await expect
      .poll(() => client.state.timelines[channelId]?.items.some((m) => m.id === message.id))
      .toBe(true);
    return message;
  }
  const shownPinned = (id: string) =>
    client.state.timelines[channelId]!.items.find((m) => m.id === id)!.pinned;
  const serverPinned = async (id: string) =>
    (await owner.listPins(channelId)).messages.some((m) => m.id === id);
  const serverSaved = async (id: string) =>
    (await elsewhere.listSaved()).messages.some((m) => m.id === id);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it("ends unpinned when pin, then unpin, reach the server the other way round", async () => {
    const message = await postedMessage();
    const pin = holdNext("pinMessage");
    void client.togglePin(message);
    await client.togglePin({ ...message, pinned: true });
    expect(await serverPinned(message.id)).toBe(false);
    // The pin arrives last, and on its own would leave it pinned.
    pin.forward();
    await expect.poll(() => serverPinned(message.id)).toBe(false);
    await settle();
    expect(await serverPinned(message.id)).toBe(false);
    expect(shownPinned(message.id)).toBe(false);
  });

  it("ends not saved when save, then unsave, reach the server the other way round", async () => {
    const message = await postedMessage();
    const save = holdNext("saveMessage");
    void client.toggleSaved(message.id, true);
    await client.toggleSaved(message.id, false);
    save.forward();
    await settle();
    await expect.poll(() => serverSaved(message.id)).toBe(false);
    expect(client.state.saved[message.id]).toBeUndefined();
  });

  it("ends on the later snooze when an earlier one reaches the server after it", async () => {
    const soon = Date.now() + 60_000;
    const later = Date.now() + 3_600_000;
    const first = holdNext("updateMe");
    client.snoozeNotificationsUntil(soon);
    client.snoozeNotificationsUntil(later);
    await expect.poll(async () => (await elsewhere.me()).user.dndUntil).toBe(later);
    first.forward();
    await settle();
    await expect.poll(async () => (await elsewhere.me()).user.dndUntil).toBe(later);
    expect(client.state.self?.dndUntil).toBe(later);
  });

  it("goes back to not pinned when both a pin and the unpin after it fail", async () => {
    const message = await postedMessage();
    vi.spyOn(client.api, "pinMessage").mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(client.api, "unpinMessage").mockRejectedValueOnce(new Error("offline"));
    const pinning = client.togglePin(message);
    const unpinning = client.togglePin({ ...message, pinned: true });
    expect(await Promise.all([pinning, unpinning])).toEqual([false, false]);
    // It used to show pinned: the opposite of the unpin that failed.
    expect(shownPinned(message.id)).toBe(false);
    expect(await serverPinned(message.id)).toBe(false);
  });

  it("goes back to not saved when both a save and the unsave after it fail", async () => {
    const message = await postedMessage();
    vi.spyOn(client.api, "saveMessage").mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(client.api, "unsaveMessage").mockRejectedValueOnce(new Error("offline"));
    const saving = client.toggleSaved(message.id, true);
    const unsaving = client.toggleSaved(message.id, false);
    expect(await Promise.all([saving, unsaving])).toEqual([false, false]);
    expect(client.state.saved[message.id]).toBeUndefined();
    expect(await serverSaved(message.id)).toBe(false);
  });

  it("shows what the server kept when the pin lands and the unpin after it fails", async () => {
    const message = await postedMessage();
    vi.spyOn(client.api, "unpinMessage").mockRejectedValueOnce(new Error("offline"));
    expect(await client.togglePin(message)).toBe(true);
    expect(await client.togglePin({ ...message, pinned: true })).toBe(false);
    expect(shownPinned(message.id)).toBe(true);
    expect(await serverPinned(message.id)).toBe(true);
  });

  it("does not let the echo of an earlier choice flip the screen while a later one is unanswered", async () => {
    const message = await postedMessage();
    const unpin = holdNext("unpinMessage");
    await client.togglePin(message);
    const unpinning = client.togglePin({ ...message, pinned: true });
    // The pin's own echo arrives now; the unpin is still unanswered.
    await settle();
    expect(shownPinned(message.id)).toBe(false);
    unpin.forward();
    expect(await unpinning).toBe(true);
    await settle();
    expect(shownPinned(message.id)).toBe(false);
    expect(await serverPinned(message.id)).toBe(false);
  });

  it("still shows another member's pin made while nothing here is unanswered", async () => {
    const message = await postedMessage();
    await owner.pinMessage(message.id);
    await expect.poll(() => shownPinned(message.id)).toBe(true);
    await owner.unpinMessage(message.id);
    await expect.poll(() => shownPinned(message.id)).toBe(false);
  });

  it("ends on the latest choice after reconnecting while it was unanswered", async () => {
    const message = await postedMessage();
    const pin = holdNext("pinMessage");
    const pinning = client.togglePin(message);
    const connection = client as unknown as { ws: WebSocket };
    connection.ws.close();
    await expect.poll(() => client.state.status).toBe("online");
    pin.forward();
    expect(await pinning).toBe(true);
    await settle();
    expect(await serverPinned(message.id)).toBe(true);
    expect(shownPinned(message.id)).toBe(true);
  });
});
