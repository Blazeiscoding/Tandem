import type { Channel, ID, Message, User } from "./entities.js";

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
  | { type: "typing"; channelId: ID; userId: ID }
  | { type: "presence"; userId: ID; presence: Presence }
  /** Private to one user's own sockets, so their devices stay in step. */
  | { type: "saved"; messageId: ID; saved: boolean };

export type Presence = "online" | "away" | "offline";

/** Sent by the server immediately after a successful WS hello. */
export interface ReadySnapshot {
  type: "ready";
  seq: number;
  self: User;
  users: User[];
  channels: Channel[];
  memberships: { channelId: ID; lastReadSeq: number }[];
  /** Latest message seq per channel the user belongs to, for unread badges. */
  channelLastSeq: Record<ID, number>;
  presence: Record<ID, Presence>;
  /** Message ids this user has saved for later. */
  savedMessageIds: ID[];
  workspaceName: string;
}

/** Everything the server can push over the socket. */
export type ServerToClient =
  | ReadySnapshot
  | { type: "event"; envelope: EventEnvelope }
  | { type: "ephemeral"; event: EphemeralEvent }
  /** lastSeq was pruned from the log — client must drop caches and re-sync. */
  | { type: "resync" }
  | { type: "error"; code: "auth_failed" | "protocol_mismatch"; message: string }
  | { type: "pong" };

export type ClientToServer =
  | { type: "hello"; token: string; lastSeq: number | null; protocolVersion: number }
  | { type: "typing"; channelId: ID }
  | { type: "ping" };
