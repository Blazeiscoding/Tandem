import { describe, expect, it } from "vitest";
import type { Channel, Message, User } from "@slackoss/protocol";
import { decideNotification, notificationBody } from "../src/notify.js";
import type { WorkspaceState } from "../src/index.js";

const me: User = {
  id: "U_ME",
  handle: "me",
  displayName: "Me",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const them: User = { ...me, id: "U_THEM", handle: "them", displayName: "Them" };

const channel = (type: Channel["type"], id = "C1"): Channel => ({
  id,
  type,
  name: type === "public" || type === "private" ? "general" : "",
  topic: "",
  description: "",
  creatorId: them.id,
  archived: false,
  createdAt: 0,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: "M1",
  channelId: "C1",
  userId: them.id,
  text: "hello there",
  threadRootId: null,
  seq: 1,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  ...over,
});

function state(over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    status: "online",
    workspaceName: "W",
    self: me,
    users: { [me.id]: me, [them.id]: them },
    channels: { C1: channel("public") },
    memberships: { C1: 0 },
    prefs: { C1: { notifyLevel: "mentions", muted: false } },
    channelLastSeq: {},
    presence: {},
    typing: {},
    lastSeq: 0,
    timelines: {},
    threads: {},
    pending: [],
    saved: {},
    drafts: {},
    huddles: {},
    huddle: null,
    ...over,
  };
}

describe("decideNotification", () => {
  it("stays quiet for your own messages", () => {
    const d = decideNotification(state(), message({ userId: me.id }));
    expect(d).toEqual({ notify: false, reason: "own-message" });
  });

  it("stays quiet for channels you are not in", () => {
    const d = decideNotification(state({ memberships: {} }), message());
    expect(d).toEqual({ notify: false, reason: "not-a-member" });
  });

  it("at the default level, notifies only on a mention", () => {
    expect(decideNotification(state(), message()).notify).toBe(false);
    const mention = message({ text: `morning <@${me.id}>` });
    expect(decideNotification(state(), mention)).toEqual({ notify: true, reason: "mention" });
  });

  it("notifies on every message when the channel is set to all", () => {
    const s = state({ prefs: { C1: { notifyLevel: "all", muted: false } } });
    expect(decideNotification(s, message())).toEqual({ notify: true, reason: "all" });
  });

  it("stays quiet at level nothing, even for a mention", () => {
    const s = state({ prefs: { C1: { notifyLevel: "nothing", muted: false } } });
    const mention = message({ text: `oi <@${me.id}>` });
    expect(decideNotification(s, mention)).toEqual({ notify: false, reason: "level" });
  });

  it("mute beats every level", () => {
    const s = state({ prefs: { C1: { notifyLevel: "all", muted: true } } });
    expect(decideNotification(s, message())).toEqual({ notify: false, reason: "muted" });
  });

  it("notifies on DMs without needing a mention", () => {
    const s = state({ channels: { C1: channel("dm") } });
    expect(decideNotification(s, message())).toEqual({ notify: true, reason: "dm" });
  });

  it("honours Do Not Disturb while it lasts, and stops when it expires", () => {
    const now = 1_000_000;
    const snoozed = state({
      self: { ...me, dndUntil: now + 60_000 },
      channels: { C1: channel("dm") },
    });
    expect(decideNotification(snoozed, message(), now)).toEqual({ notify: false, reason: "dnd" });

    const expired = state({
      self: { ...me, dndUntil: now - 1 },
      channels: { C1: channel("dm") },
    });
    expect(decideNotification(expired, message(), now).notify).toBe(true);
  });

  it("falls back to mentions-only when a channel has no stored preference", () => {
    const s = state({ prefs: {} });
    expect(decideNotification(s, message()).notify).toBe(false);
    expect(decideNotification(s, message({ text: `<@${me.id}> ping` })).notify).toBe(true);
  });
});

describe("notificationBody", () => {
  it("renders mentions as readable names", () => {
    const body = notificationBody(state(), message({ text: `hi <@${me.id}> and <@U_NOBODY>` }));
    expect(body).toBe("hi @Me and @someone");
  });

  it("describes attachments when there is no text", () => {
    const withFile = message({
      text: "",
      files: [{ id: "F1", name: "a.png", mime: "image/png", size: 1, width: 1, height: 1 }],
    });
    expect(notificationBody(state(), withFile)).toBe("Sent a file");
  });
});
