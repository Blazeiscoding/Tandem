/** All ids are ULID-style sortable strings. */
export type ID = string;

export type Role = "owner" | "admin" | "member";

export interface User {
  id: ID;
  handle: string;
  displayName: string;
  role: Role;
  statusText: string;
  statusEmoji: string;
  isBot: boolean;
  deactivated: boolean;
  /** Epoch ms until which notifications are snoozed, or null when available. */
  dndUntil: number | null;
  createdAt: number;
}

export type ChannelType = "public" | "private" | "dm" | "group_dm";

export interface Channel {
  id: ID;
  type: ChannelType;
  /** Empty for dm/group_dm — clients derive the title from member names. */
  name: string;
  topic: string;
  description: string;
  creatorId: ID;
  archived: boolean;
  createdAt: number;
  /** Present on dm/group_dm so clients can render the counterpart(s). */
  memberIds?: ID[];
}

/** How loudly one channel should notify this user. */
export type NotifyLevel = "all" | "mentions" | "nothing";

export interface ChannelPrefs {
  notifyLevel: NotifyLevel;
  /** Muted channels never notify and stay quiet in the sidebar. */
  muted: boolean;
}

export interface ChannelMembership extends ChannelPrefs {
  channelId: ID;
  userId: ID;
  lastReadSeq: number;
  joinedAt: number;
}

export interface ReactionGroup {
  emoji: string;
  userIds: ID[];
}

export interface FileMeta {
  id: ID;
  name: string;
  mime: string;
  size: number;
  /** Present for images the server could measure — lets clients reserve space before load. */
  width: number | null;
  height: number | null;
}

export interface Message {
  id: ID;
  channelId: ID;
  userId: ID;
  /**
   * Slack-mrkdwn-compatible text: *bold*, _italic_, `code`, ```blocks```,
   * <@USER_ID> mentions, <#CHANNEL_ID> channel links, plain URLs.
   */
  text: string;
  threadRootId: ID | null;
  /**
   * Event-log seq of this message's message.created event; used for unread math.
   * Note: inside a live `message.created` event payload this can be 0 — clients
   * must set it from the envelope's seq when applying the event.
   */
  seq: number;
  createdAt: number;
  editedAt: number | null;
  /** Client-generated idempotency key; lets the sender reconcile optimistic messages. */
  nonce: string | null;
  replyCount: number;
  reactions: ReactionGroup[];
  files: FileMeta[];
  /** Pinned messages are shown to the whole channel. */
  pinned: boolean;
}

export interface Invite {
  code: string;
  createdBy: ID;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
}

/** Unauthenticated probe of a server — what the Join screen shows. */
export interface ServerInfo {
  app: "slackoss";
  protocolVersion: number;
  serverVersion: string;
  workspaceName: string;
  userCount: number;
  /** True once an owner exists; joining then requires an invite code. */
  requiresInvite: boolean;
}

export const PROTOCOL_VERSION = 1;

/** A message queued to be posted at a future time. */
export interface ScheduledMessage {
  id: ID;
  channelId: ID;
  userId: ID;
  text: string;
  threadRootId: ID | null;
  fileIds: ID[];
  sendAt: number;
  createdAt: number;
}

/** An integration: a bot user plus the tokens and hooks that drive it. */
export interface App {
  id: ID;
  name: string;
  botUserId: ID;
  createdBy: ID;
  createdAt: number;
}

export interface Webhook {
  id: ID;
  appId: ID;
  channelId: ID;
  createdAt: number;
}

/**
 * A `/command` an app answers. Running it POSTs a Slack-shaped form body to
 * `url`; whatever comes back is shown to the person who typed it.
 */
export interface SlashCommand {
  id: ID;
  appId: ID;
  /** Stored without the leading slash, lowercase. */
  command: string;
  url: string;
  description: string;
  /** Shown after the command name in the hint list, e.g. "[staging|prod]". */
  usageHint: string;
  createdAt: number;
}

/** An outgoing subscription: the server POSTs matching events to `url`. */
export interface EventSubscription {
  id: ID;
  appId: ID;
  url: string;
  /** Native event types delivered; empty means every type the app can see. */
  eventTypes: string[];
  createdAt: number;
}
