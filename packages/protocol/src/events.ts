import type {
  Channel,
  ChannelPrefs,
  Friendship,
  ID,
  Message,
  ModalView,
  User,
} from "./entities.js";
import type { HuddleSignal } from "./huddle.js";

/**
 * Durable workspace events. Every mutation appends one to the event log and
 * gets a monotonically increasing `seq`. Clients track `lastSeq` and replay
 * missed events on reconnect.
 */
export type WorkspaceEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "message.deleted"; channelId: ID; messageId: ID; threadRootId: ID | null }
  | { type: "reaction.added"; channelId: ID; messageId: ID; emoji: string; userId: ID }
  | { type: "reaction.removed"; channelId: ID; messageId: ID; emoji: string; userId: ID }
  | { type: "pin.added"; channelId: ID; messageId: ID; userId: ID }
  | { type: "pin.removed"; channelId: ID; messageId: ID }
  | { type: "channel.created"; channel: Channel }
  | { type: "channel.updated"; channel: Channel }
  | { type: "member.joined"; channelId: ID; userId: ID }
  | { type: "member.left"; channelId: ID; userId: ID }
  | { type: "user.joined"; user: User }
  | { type: "user.updated"; user: User };

export interface EventEnvelope {
  seq: number;
  event: WorkspaceEvent;
}

/** Ephemeral events — never logged, never replayed. */
export type EphemeralEvent =
  | {
      type: "channel.access";
      channelId: ID;
      channel: Channel | null;
      membership: { lastReadSeq: number; prefs: ChannelPrefs } | null;
    }
  | { type: "friends"; friends: Friendship[] }
  | { type: "typing"; channelId: ID; userId: ID }
  | { type: "presence"; userId: ID; presence: Presence }
  /** Private to one user's own sockets, so their devices stay in step. */
  | { type: "saved"; messageId: ID; saved: boolean }
  | { type: "prefs"; channelId: ID; prefs: ChannelPrefs }
  /** Who is in a channel's huddle right now. */
  | { type: "huddle.participants"; channelId: ID; userIds: ID[] }
  /** A relayed WebRTC handshake payload from one peer. */
  | { type: "huddle.signal"; channelId: ID; from: ID; signal: HuddleSignal }
  /**
   * A reply only the recipient sees — how a slash command answers privately.
   * It is never stored, so it disappears on reload, exactly like Slack's.
   */
  | {
      type: "ephemeral.message";
      channelId: ID;
      /** Local id, so the client can key and dismiss it. */
      id: ID;
      /** The bot (or user) it is shown as coming from. */
      userId: ID;
      text: string;
      createdAt: number;
    }
  /**
   * An app is asking this one person to fill in a form. Like an ephemeral
   * message it is not stored: closing the app loses it, which is what a modal
   * that has not been submitted should do.
   */
  | { type: "view.open"; view: ModalView };

export type Presence = "online" | "away" | "offline";

/** Sent by the server immediately after a successful WS hello. */
export interface ReadySnapshot {
  type: "ready";
  seq: number;
  /** Present for syncVersion 1: null replaces history; otherwise replay follows from this cursor. */
  replayFrom?: number | null;
  self: User;
  users: User[];
  channels: Channel[];
  memberships: { channelId: ID; lastReadSeq: number; prefs: ChannelPrefs }[];
  /** Latest message seq per channel the user belongs to, for unread badges. */
  channelLastSeq: Record<ID, number>;
  presence: Record<ID, Presence>;
  /** Message ids this user has saved for later. */
  savedMessageIds: ID[];
  /** Live huddles the user can see: channelId -> participant ids. */
  huddles: Record<ID, ID[]>;
  workspaceName: string;
  friends?: Friendship[];
}

/** Everything the server can push over the socket. */
export type ServerToClient =
  | ReadySnapshot
  | { type: "synced"; seq: number }
  | { type: "event"; envelope: EventEnvelope }
  | { type: "ephemeral"; event: EphemeralEvent }
  /** lastSeq was pruned from the log — client must drop caches and re-sync. */
  | { type: "resync" }
  | { type: "error"; code: "auth_failed" | "protocol_mismatch"; message: string }
  | { type: "pong" };

export type ClientToServer =
  | {
      type: "hello";
      token: string;
      lastSeq: number | null;
      protocolVersion: number;
      syncVersion?: 1;
    }
  | { type: "typing"; channelId: ID }
  | { type: "huddle.join"; channelId: ID }
  | { type: "huddle.leave"; channelId: ID }
  | { type: "huddle.signal"; channelId: ID; to: ID; signal: HuddleSignal }
  | { type: "ping" };
