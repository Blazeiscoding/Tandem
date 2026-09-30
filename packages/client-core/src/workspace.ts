import { createStore, type StoreApi } from "zustand/vanilla";
import {
  PROTOCOL_VERSION,
  SEND_RETRY_WINDOW_MS,
  type Channel,
  type ChannelPrefs,
  type EphemeralEvent,
  type EventEnvelope,
  type Friendship,
  type ID,
  type Message,
  type ModalView,
  type Presence,
  type ReadySnapshot,
  type SendMessageBody,
  type ServerToClient,
  type ThreadFollow,
  type User,
} from "@slackoss/protocol";
import { Api, ApiError, type CommandHint } from "./api.js";
import { FileCache } from "./fileCache.js";
import { HuddleSession, type HuddleState } from "./huddle.js";

export type ConnectionStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  | "auth_failed"
  | "protocol_mismatch"
  /** The server will refuse this account until its password is replaced. */
  | "password_change_required"
  | "closed";

/** A file shown in the composer or in an optimistic message, before the server has it. */
export interface LocalAttachment {
  name: string;
  size: number;
  mime: string;
  /** Object URL for instant local preview of images. */
  previewUrl: string | null;
}

export interface PendingMessage {
  nonce: string;
  channelId: ID;
  threadRootId: ID | null;
  /** A reply the author also chose to show in the channel. */
  broadcast?: boolean;
  text: string;
  userId: ID;
  createdAt: number;
  failed: boolean;
  /** Why it did not send, in words the author can act on. Null while in flight. */
  failureReason: string | null;
  /**
   * The server answered and turned this send down. Unlike a send whose outcome
   * is unknown, only the author's Retry sends it again, even after a restart.
   */
  refused?: boolean;
  attachments: LocalAttachment[];
  /** 0–1 while uploading attachments; null once the message itself is in flight. */
  uploadProgress: number | null;
}

/**
 * An outbox entry as it survives a restart. File objects cannot be serialized,
 * so only their descriptions travel; see `restoreOutbox` for what that means.
 */
export interface StoredPending {
  nonce: string;
  channelId: ID;
  threadRootId: ID | null;
  broadcast?: boolean;
  text: string;
  userId: ID;
  createdAt: number;
  attachments: { name: string; size: number; mime: string }[];
  /**
   * What the author was told when the server refused this send. Present only
   * for a known refusal, which comes back failed and waits for Retry; a send
   * whose outcome is unknown has none and is sent again, under the same nonce.
   */
  refusal?: string;
}

/**
 * How many unsent messages one account can have waiting at once. A send past
 * this is refused before the composer lets go of it, rather than being kept
 * only in memory where a restart would lose it.
 */
export const OUTBOX_LIMIT = 50;

const MISSING_ATTACHMENTS =
  "The attached files were not kept when the app closed. Attach them again to send this.";

/** How one choice (a pin, a save, the snooze) is read, shown and sent; see `choose`. */
interface ChoiceIo<V> {
  current: () => V;
  show: (value: V) => void;
  /** Resolves with what the server now has, when it says; otherwise it has `value`. */
  send: (value: V) => Promise<V | void>;
}

interface Choice<V> {
  io: ChoiceIo<V>;
  /** The latest choice, shown while any request is unanswered. */
  latest: V;
  /** What the server last said, by an answer or an echo, in the order heard. */
  confirmed: V;
  unanswered: number;
  /** Requests sent since this began, or since the last one was sent again. */
  sent: number;
  /** Which of those carried the latest choice, and whether it was accepted. */
  latestSent: number;
  latestAccepted: boolean;
  /** The server said something other than the latest choice meanwhile. */
  contested: boolean;
  resent: boolean;
}

const STALE_SEND =
  `Not sent again on its own: this was written more than ${SEND_RETRY_WINDOW_MS / 86_400_000} days ago ` +
  "and may have been posted already. Retry to send it anyway, or discard it.";

/**
 * Whether a failed send was answered and refused by the server, as opposed to
 * lost on the way or refused for reasons that pass (signing in, rate limits,
 * a server fault), after which sending the same request again is safe.
 */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 408, 429].includes(error.status)
  );
}

/** Turns a send failure into something the author can act on. */
function sendFailureReason(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Could not reach the workspace. It will be sent when you try again.";
  }
  switch (error.code) {
    case "channel_archived":
      return "This conversation is archived.";
    case "channel_not_found":
      return "You no longer have access to this conversation.";
    case "bad_thread_root":
      return "The message this replies to is gone.";
    case "invalid_attachments":
      return "The attached files are no longer available.";
    case "attachments_scheduled":
      return "One of the attached files is part of a scheduled message.";
    case "storage_quota_exceeded":
      return "Workspace attachment storage is full. Ask the host to free space or raise the limit, then retry.";
    case "nonce_conflict":
    case "message_deleted":
      return "This was already sent once. Discard it to clear it.";
    case "account_deactivated":
      return "This account is deactivated.";
    default:
      return error.status >= 500
        ? "The workspace had a problem saving this."
        : "This message was refused.";
  }
}

export interface ChannelTimeline {
  /** Channel message watermark represented by this loaded tail, not future arrivals. */
  readThroughSeq?: number;
  /** Oldest → newest, top-level messages only. */
  items: Message[];
  /** More history exists before the first loaded message. */
  hasMore: boolean;
  /**
   * True when the view is anchored mid-history (after a jump) rather than at
   * the tail. Live messages are not appended while this holds, since they are
   * not actually adjacent to what is on screen.
   */
  hasMoreNewer: boolean;
  loaded: boolean;
}

export interface ThreadPage {
  channelId: ID;
  root: Message | null;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const THREAD_WINDOW = 300;

/** Apply only events newer than a history response when reconciling that response. */
function updateThread(
  rootId: ID,
  root: Message | null,
  items: Message[],
  envelopes: EventEnvelope[],
  anchored: boolean,
) {
  for (const { event } of envelopes) {
    const patch = (id: ID, change: (message: Message) => Message) => {
      if (root?.id === id) root = change(root);
      if (items.some((message) => message.id === id))
        items = items.map((message) => (message.id === id ? change(message) : message));
    };
    if (event.type === "message.created" && event.message.threadRootId === rootId) {
      if (!items.some((message) => message.id === event.message.id)) {
        if (root) root = { ...root, replyCount: root.replyCount + 1 };
        if (!anchored) items = sortedInsert(items, event.message);
      }
    } else if (event.type === "message.updated") {
      patch(event.message.id, () => event.message);
    } else if (event.type === "message.deleted") {
      if (event.messageId === rootId) {
        root = null;
        items = [];
      } else if (event.threadRootId === rootId) {
        if (root) root = { ...root, replyCount: Math.max(0, root.replyCount - 1) };
        items = items.filter((message) => message.id !== event.messageId);
      }
    } else if (event.type === "pin.added" || event.type === "pin.removed") {
      patch(event.messageId, (message) => ({ ...message, pinned: event.type === "pin.added" }));
    } else if (event.type === "reaction.added" || event.type === "reaction.removed") {
      patch(event.messageId, (message) => {
        const old = message.reactions.find((group) => group.emoji === event.emoji)?.userIds ?? [];
        const userIds =
          event.type === "reaction.added"
            ? [...new Set([...old, event.userId])]
            : old.filter((id) => id !== event.userId);
        const reactions = message.reactions.filter((group) => group.emoji !== event.emoji);
        if (userIds.length) reactions.push({ emoji: event.emoji, userIds });
        return { ...message, reactions };
      });
    }
  }
  return { root, items };
}

/**
 * A reply only this client can see — a slash command's private answer, or a
 * local note about one that failed. Never persisted; a reload clears them.
 */
export interface EphemeralMessage {
  id: ID;
  channelId: ID;
  /** The bot it is shown as coming from, or "" for a note from the app itself. */
  userId: ID;
  text: string;
  createdAt: number;
}

export interface WorkspaceState {
  friends: Friendship[];
  status: ConnectionStatus;
  workspaceName: string;
  /** Authenticated storage identity; null when an older server does not expose it. */
  workspaceId: ID | null;
  self: User | null;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  /** channelId -> my lastReadSeq (only channels I'm a member of). */
  memberships: Record<ID, number>;
  /**
   * channelId -> how far replies count as read in a thread I have no cursor
   * for (`repliesReadSeq`). Null for a server that reads replies with the
   * channel's cursor, as servers did before replies were read by thread.
   */
  repliesRead: Record<ID, number> | null;
  /** channelId -> my notification settings for it, including choices still being saved. */
  prefs: Record<ID, ChannelPrefs>;
  /**
   * channelId -> a notification choice not yet saved, or one the server
   * refused. `failed` is what was chosen and not saved, kept so it can be
   * tried again; `prefs` meanwhile shows what the server has.
   */
  prefsWrites: Record<ID, { saving: boolean; failed: Partial<ChannelPrefs> | null }>;
  /** channelId -> seq of the newest message in it. */
  channelLastSeq: Record<ID, number>;
  presence: Record<ID, Presence>;
  /** channelId -> userId -> typing-expires-at (ms). */
  typing: Record<ID, Record<ID, number>>;
  lastSeq: number;
  timelines: Record<ID, ChannelTimeline>;
  /** threadRootId -> replies oldest → newest. */
  threads: Record<ID, Message[]>;
  threadPages: Record<ID, ThreadPage>;
  pending: PendingMessage[];
  /** Message ids this user saved for later. */
  saved: Record<ID, true>;
  /** channelId -> unread messages there that name this user. */
  mentionCounts: Record<ID, number>;
  /** threadRootId -> this account's follow state and read cursor for it. */
  threadFollows: Record<ID, ThreadFollow>;
  /** channelId -> unsent composer text, restored when you come back. */
  drafts: Record<ID, string>;
  /** channelId -> who is in that channel's huddle right now. */
  huddles: Record<ID, ID[]>;
  /** Private replies per channel, newest last. */
  ephemerals: Record<ID, EphemeralMessage[]>;
  /** A form an app has asked this person to fill in, or null. */
  modal: ModalView | null;
  /** Commands that can be typed here; loaded once after connecting. */
  commands: CommandHint[];
  /** The huddle this client is in, if any. */
  huddle: HuddleState | null;
}

const initialState: WorkspaceState = {
  friends: [],
  status: "connecting",
  workspaceName: "",
  workspaceId: null,
  self: null,
  users: {},
  channels: {},
  memberships: {},
  repliesRead: null,
  prefs: {},
  prefsWrites: {},
  channelLastSeq: {},
  presence: {},
  typing: {},
  lastSeq: 0,
  timelines: {},
  threads: {},
  threadPages: {},
  pending: [],
  saved: {},
  threadFollows: {},
  mentionCounts: {},
  drafts: {},
  huddles: {},
  huddle: null,
  ephemerals: {},
  modal: null,
  commands: [],
};

/** Followed threads with replies this account has not read. */
export function unreadThreadCount(threadFollows: Record<ID, ThreadFollow>): number {
  return Object.values(threadFollows).filter((f) => f.following && f.lastSeq > f.lastReadSeq)
    .length;
}

/**
 * Whether this account has read a message; the server's count of unread
 * messages is the same rule. The channel's cursor reads what the channel
 * shows. A reply is read through its thread: by the thread's cursor, or, in a
 * thread this account has no cursor for, as far as the membership's
 * `repliesRead`. A reply also sent to the channel is read by either cursor.
 */
export function isMessageRead(
  message: Pick<Message, "channelId" | "seq" | "threadRootId" | "broadcast">,
  state: Pick<WorkspaceState, "memberships" | "threadFollows" | "repliesRead">,
): boolean {
  const channelRead = state.memberships[message.channelId] ?? 0;
  if (!message.threadRootId) return message.seq <= channelRead;
  const threadRead = state.threadFollows[message.threadRootId]?.lastReadSeq;
  // A server that reads replies with the channel's cursor too.
  if (!state.repliesRead) return message.seq <= Math.max(channelRead, threadRead ?? 0);
  if (message.broadcast && message.seq <= channelRead) return true;
  return message.seq <= (threadRead ?? state.repliesRead[message.channelId] ?? 0);
}

function sortedInsert(items: Message[], msg: Message): Message[] {
  // Messages almost always arrive in order — fast path append.
  if (items.length === 0 || items[items.length - 1]!.id < msg.id) return [...items, msg];
  if (items.some((m) => m.id === msg.id)) return items.map((m) => (m.id === msg.id ? msg : m));
  const out = [...items, msg];
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * The most messages one channel keeps loaded, and therefore the most rows the
 * timeline ever renders. History is unbounded on the server, so without a cap
 * a long scrollback — or a long sitting in a busy channel — grows one flat list
 * until every keystroke restyles thousands of nodes.
 */
const MAX_TIMELINE_ITEMS = 300;
const HISTORY_CACHE_LIMIT = 20;

/**
 * Trims a timeline back to the cap from one end, and marks that end pageable
 * again so scrolling back toward it refetches what was dropped. Six pages is
 * several screens either way, so the trim happens far outside the viewport.
 */
function windowTimeline(timeline: ChannelTimeline, drop: "oldest" | "newest"): ChannelTimeline {
  const excess = timeline.items.length - MAX_TIMELINE_ITEMS;
  if (excess <= 0) return timeline;
  return drop === "oldest"
    ? { ...timeline, items: timeline.items.slice(excess), hasMore: true }
    : { ...timeline, items: timeline.items.slice(0, MAX_TIMELINE_ITEMS), hasMoreNewer: true };
}

/**
 * A live connection to one workspace server: typed REST + resilient WebSocket
 * + a Zustand store holding the local replica the UI renders from.
 */
export class WorkspaceClient {
  readonly store: StoreApi<WorkspaceState>;
  readonly api: Api;
  readonly files: FileCache;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private typingSweep: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private nonceCounter = 0;
  /** Called when a message.created lands from someone else — the app hooks notifications here. */
  /**
   * A message from someone else has landed. `live` is false while replaying
   * what was missed during a disconnect, which `@here` has to know about.
   */
  onIncomingMessage: ((msg: Message, context: { live: boolean }) => void) | null = null;

  /**
   * The server's seq when this connection opened. Everything at or below it
   * already happened; everything above it is arriving as it is sent.
   */
  private connectedAtSeq = 0;
  private historyEpoch = 0;
  private reloadChannels = new Set<ID>();
  private reloadThreads = new Map<ID, ID>();
  private threadLoads = new Map<ID, { events: EventEnvelope[]; overflow: boolean }>();
  private messageJump = 0;
  private timelineRequests = new Map<ID, object>();
  /**
   * Live messages that arrived while a conversation's first or newest page was
   * on its way. The server may have read that page before they existed, and a
   * timeline not loaded yet has nowhere to put them, so they wait for the page
   * that request brings and join it when it lands.
   */
  private timelineHolds = new Map<ID, { ticket: object; messages: Message[] }>();
  private timelineRecency = new Map<ID, true>();
  private threadRecency = new Map<ID, true>();
  private activeConversation: ID | null = null;
  private activeThread: ID | null = null;
  private pendingReads = new Map<ID, number>();
  /**
   * Conversations deliberately left unread. Automatic acknowledgement skips
   * them, or looking at what you just marked unread would immediately read it
   * again. Leaving the conversation lifts the hold, so coming back reads it.
   */
  private readHold = new Set<ID>();
  private threadReadHold = new Set<ID>();
  private readRequests = new Map<ID, AbortController>();
  private readRetryTimer: ReturnType<typeof setInterval> | null = null;
  private acknowledgedMessages = new Set<ID>();

  constructor(
    public readonly baseUrl: string,
    private token: string,
  ) {
    this.api = new Api(baseUrl, token);
    this.files = new FileCache(this.api);
    this.store = createStore<WorkspaceState>(() => ({ ...initialState }));
  }

  get state(): WorkspaceState {
    return this.store.getState();
  }

  connect(): void {
    if (this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopped = false;
    this.openSocket(this.state.lastSeq > 0 ? this.state.lastSeq : null);
    this.typingSweep ??= setInterval(() => this.sweepTyping(), 2000);
    this.readRetryTimer ??= setInterval(() => this.flushReads(), 5000);
  }

  destroy(): void {
    this.stopped = true;
    this.historyEpoch++;
    this.clearReadRequests();
    if (this.readRetryTimer) clearInterval(this.readRetryTimer);
    this.readRetryTimer = null;
    // Release the microphone before the socket goes, so no call is left open.
    this.leaveHuddle();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.typingSweep) clearInterval(this.typingSweep);
    this.typingSweep = null;
    this.ws?.close();
    this.ws = null;
    for (const p of this.state.pending) {
      for (const a of p.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    this.files.dispose();
    this.retryFiles.clear();
    this.uploadedFiles.clear();
    this.store.setState({ status: "closed" });
  }

  private openSocket(lastSeq: number | null): void {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          token: this.token,
          lastSeq,
          protocolVersion: PROTOCOL_VERSION,
          syncVersion: 1,
        }),
      );
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws || this.stopped) return;
      try {
        const msg = JSON.parse(String(e.data)) as ServerToClient;
        this.handleServerMessage(msg);
      } catch {
        ws.close(4000, "invalid server message");
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.leaveHuddle();
      if (event.code === 4003) this.store.setState({ status: "auth_failed" });
      if (event.code === 4002) this.store.setState({ status: "protocol_mismatch" });
      if (event.code === 4004) this.store.setState({ status: "password_change_required" });
      // Retrying only makes sense for a refusal that might stop. These will not
      // until somebody does something, so reconnecting would be a loop that
      // never ends and never says why.
      if (
        this.stopped ||
        this.state.status === "auth_failed" ||
        this.state.status === "protocol_mismatch" ||
        this.state.status === "password_change_required"
      )
        return;
      this.store.setState({ status: "reconnecting" });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.openSocket(this.state.lastSeq > 0 ? this.state.lastSeq : null);
      }, this.reconnectDelay);
    };

    ws.onerror = () => ws.close();
  }

  private handleServerMessage(msg: ServerToClient): void {
    switch (msg.type) {
      case "ready":
        this.applyReady(msg);
        break;
      case "synced":
        this.store.setState((s) => ({ lastSeq: Math.max(s.lastSeq, msg.seq), status: "online" }));
        this.flushReads();
        break;
      case "event":
        this.applyEvent(msg.envelope);
        break;
      case "ephemeral":
        this.applyEphemeral(msg.event);
        break;
      case "resync":
        // Compatibility with servers that predate replayFrom/synced.
        this.resetHistory();
        this.store.setState({ lastSeq: 0, status: "connecting" });
        this.ws?.close();
        this.reconnectDelay = 1000;
        this.openSocket(null);
        break;
      case "error":
        if (msg.code === "auth_failed") this.store.setState({ status: "auth_failed" });
        if (msg.code === "protocol_mismatch") this.store.setState({ status: "protocol_mismatch" });
        if (msg.code === "password_change_required") {
          this.store.setState({ status: "password_change_required" });
        }
        break;
      case "pong":
        break;
    }
  }

  private applyReady(snap: ReadySnapshot): void {
    // A replaced server must not inherit this connection's private drafts or
    // outbox, even if a copied session token happens to work there. Keep the
    // old identity intact so unmount can flush its work before signing in again.
    if (
      this.state.self &&
      (this.state.self.id !== snap.self.id ||
        (this.state.workspaceId && snap.workspaceId && this.state.workspaceId !== snap.workspaceId))
    ) {
      this.destroy();
      this.store.setState({ status: "auth_failed" });
      return;
    }
    this.reconnectDelay = 1000;
    // Anything the server had already recorded when we connected is history,
    // however soon after it reaches us.
    this.connectedAtSeq = snap.seq;
    const visible = new Set(snap.channels.map((c) => c.id));
    for (const id of Object.keys(this.state.channels)) {
      if (!visible.has(id)) this.removeChannel(id);
    }
    const reset = snap.replayFrom === null || this.state.lastSeq > snap.seq;
    if (reset) this.resetHistory();
    const users: Record<ID, User> = {};
    for (const u of snap.users) users[u.id] = u;
    const channels: Record<ID, Channel> = {};
    for (const c of snap.channels) channels[c.id] = c;
    const memberships: Record<ID, number> = {};
    const prefs: Record<ID, ChannelPrefs> = {};
    const repliesRead: Record<ID, number> | null = snap.memberships.some(
      (m) => m.repliesReadSeq !== undefined,
    )
      ? {}
      : null;
    for (const m of snap.memberships) {
      const pending = this.pendingReads.get(m.channelId) ?? 0;
      if (pending <= m.lastReadSeq || pending > snap.seq) this.pendingReads.delete(m.channelId);
      memberships[m.channelId] = Math.max(m.lastReadSeq, this.pendingReads.get(m.channelId) ?? 0);
      if (repliesRead) repliesRead[m.channelId] = m.repliesReadSeq ?? 0;
      prefs[m.channelId] = m.prefs;
    }
    const saved: Record<ID, true> = {};
    for (const id of snap.savedMessageIds) saved[id] = true;
    // A server older than v15 does not know about following. Keeping what we
    // already had would show follow state it can no longer honour, so drop it.
    const threadFollows: Record<ID, ThreadFollow> = {};
    for (const follow of snap.threadFollows ?? []) threadFollows[follow.rootId] = follow;

    this.store.setState((prev) => ({
      status: snap.replayFrom === undefined ? "online" : "connecting",
      workspaceName: snap.workspaceName,
      workspaceId: snap.workspaceId ?? prev.workspaceId,
      self: snap.self,
      users,
      channels,
      memberships,
      repliesRead,
      prefs,
      channelLastSeq: snap.channelLastSeq,
      presence: snap.presence,
      threadFollows,
      mentionCounts: snap.mentionCounts ?? {},
      saved,
      huddles: snap.huddles,
      friends: snap.friends ?? [],
      lastSeq: reset || prev.lastSeq === 0 ? snap.seq : (snap.replayFrom ?? prev.lastSeq),
      // Keep loaded timelines — replayed events patch them incrementally.
      timelines: prev.timelines,
      threads: prev.threads,
      pending: prev.pending,
      drafts: prev.drafts,
      huddle: prev.huddle,
      typing: {},
    }));
    // The snapshot is the server's word; choices still being saved go on top.
    for (const [channelId, write] of this.prefsWrites) {
      if (!prefs[channelId]) {
        this.prefsWrites.delete(channelId);
        continue;
      }
      write.confirmed = prefs[channelId];
      this.publishPrefs(channelId);
    }
    for (const id of [...this.reloadChannels]) {
      this.reloadChannels.delete(id);
      if (channels[id]) void this.loadTimeline(id).catch(() => {});
    }
    for (const [rootId, channelId] of [...this.reloadThreads]) {
      this.reloadThreads.delete(rootId);
      if (channels[channelId]) void this.loadThread(rootId, channelId).catch(() => {});
    }
  }

  private resetHistory(): void {
    this.historyEpoch++;
    this.timelineRequests.clear();
    this.timelineHolds.clear();
    this.timelineRecency.clear();
    this.threadRecency.clear();
    this.clearReadRequests();
    for (const [id, timeline] of Object.entries(this.state.timelines)) {
      if (timeline.loaded) this.reloadChannels.add(id);
    }
    for (const [rootId, replies] of Object.entries(this.state.threads)) {
      const channelId =
        this.state.threadPages[rootId]?.channelId ??
        replies[0]?.channelId ??
        Object.entries(this.state.timelines).find(([, t]) =>
          t.items.some((m) => m.id === rootId),
        )?.[0];
      if (channelId) this.reloadThreads.set(rootId, channelId);
    }
    this.acknowledgedMessages.clear();
    this.threadLoads.clear();
    this.store.setState({
      timelines: {},
      threads: {},
      threadPages: {},
      typing: {},
      ephemerals: {},
      modal: null,
    });
  }

  private removeChannel(channelId: ID): void {
    this.timelineRequests.delete(channelId);
    this.timelineHolds.delete(channelId);
    this.timelineRecency.delete(channelId);
    this.pendingReads.delete(channelId);
    this.readRequests.get(channelId)?.abort();
    this.readRequests.delete(channelId);
    this.historyEpoch++;
    if (this.session?.channelId === channelId) this.leaveHuddle();
    const state = this.state;
    const roots = new Set(state.timelines[channelId]?.items.map((m) => m.id) ?? []);
    for (const [id, page] of Object.entries(state.threadPages))
      if (page.channelId === channelId) roots.add(id);
    // A choice for a channel this account can no longer see has nowhere to go.
    this.prefsWrites.delete(channelId);
    for (const id of roots) {
      this.threadLoads.delete(id);
      this.threadRecency.delete(id);
    }
    for (const [id, replies] of Object.entries(state.threads)) {
      if (replies.some((m) => m.channelId === channelId)) roots.add(id);
    }
    const fileIds = [
      ...(state.timelines[channelId]?.items ?? []),
      ...Object.values(state.threadPages).flatMap((page) =>
        page.channelId === channelId && page.root ? [page.root] : [],
      ),
      ...Object.values(state.threads)
        .flat()
        .filter((m) => m.channelId === channelId),
    ].flatMap((m) => m.files.map((f) => f.id));
    for (const id of fileIds) this.files.invalidate(id);
    const without = <T>(values: Record<ID, T>) =>
      Object.fromEntries(Object.entries(values).filter(([id]) => id !== channelId));
    this.store.setState({
      channels: without(state.channels),
      memberships: without(state.memberships),
      repliesRead: state.repliesRead && without(state.repliesRead),
      prefs: without(state.prefs),
      prefsWrites: without(state.prefsWrites),
      timelines: without(state.timelines),
      channelLastSeq: without(state.channelLastSeq),
      typing: without(state.typing),
      huddles: without(state.huddles),
      ephemerals: without(state.ephemerals),
      threads: Object.fromEntries(
        Object.entries(state.threads).filter(
          ([id, replies]) => !roots.has(id) && !replies.some((m) => m.channelId === channelId),
        ),
      ),
      threadPages: Object.fromEntries(
        Object.entries(state.threadPages).filter(([, page]) => page.channelId !== channelId),
      ),
      saved: Object.fromEntries(Object.entries(state.saved).filter(([id]) => !roots.has(id))),
      modal: null,
    });
  }

  private applyEvent(envelope: EventEnvelope, fromHttp = false): void {
    const { event, seq } = envelope;
    const s = this.store.getState();
    if (!fromHttp && seq <= s.lastSeq && s.lastSeq !== 0) return;
    const patch: Partial<WorkspaceState> = fromHttp ? {} : { lastSeq: seq };
    // Snapshot metadata is already current; replay only changes message caches.
    if (!fromHttp && seq <= this.connectedAtSeq && /^(channel|member|user)\./.test(event.type)) {
      this.store.setState(patch);
      return;
    }

    switch (event.type) {
      case "message.created": {
        const message = { ...event.message, seq };
        if (!s.channels[message.channelId]) break;
        if (!fromHttp && this.acknowledgedMessages.delete(message.id)) break;
        if (
          fromHttp &&
          !s.pending.some((p) => p.userId === message.userId && p.nonce === message.nonce)
        )
          return;
        if (fromHttp && seq > s.lastSeq) this.acknowledgedMessages.add(message.id);
        // A reply belongs to its thread; only what the channel shows moves its badge.
        if (!message.threadRootId || message.broadcast)
          patch.channelLastSeq = {
            ...s.channelLastSeq,
            [message.channelId]: Math.max(s.channelLastSeq[message.channelId] ?? 0, seq),
          };
        // The real message replaces our optimistic one — release its previews.
        const settled = s.pending.find(
          (p) => p.userId === message.userId && p.nonce === message.nonce,
        );
        if (settled) {
          for (const a of settled.attachments) {
            if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
          }
          this.retryFiles.delete(settled.nonce);
          this.uploadedFiles.delete(settled.nonce);
          patch.pending = s.pending.filter((p) => p.nonce !== message.nonce);
        }
        const appendToTimeline = (from: WorkspaceState["timelines"]) => {
          const tl = from[message.channelId];
          // A page on its way may predate this message; it joins that page too.
          this.timelineHolds.get(message.channelId)?.messages.push(message);
          // Appending to an anchored view would fake adjacency across a gap.
          if (!tl?.loaded || tl.hasMoreNewer) return undefined;
          return {
            ...from,
            [message.channelId]: windowTimeline(
              {
                ...tl,
                items: sortedInsert(tl.items, message),
                readThroughSeq: Math.max(tl.readThroughSeq ?? 0, seq),
              },
              "oldest",
            ),
          };
        };
        if (message.threadRootId) {
          const replies = s.threads[message.threadRootId];
          if (replies) {
            patch.threads = {
              ...s.threads,
              [message.threadRootId]: sortedInsert(replies, message),
            };
          }
          // Bump replyCount on the root in its timeline.
          const tl = s.timelines[message.channelId];
          if (tl?.loaded) {
            patch.timelines = {
              ...s.timelines,
              [message.channelId]: {
                ...tl,
                readThroughSeq:
                  !tl.hasMoreNewer && tl.items.some((m) => m.id === message.threadRootId)
                    ? Math.max(tl.readThroughSeq ?? 0, seq)
                    : tl.readThroughSeq,
                items: tl.items.map((m) =>
                  m.id === message.threadRootId ? { ...m, replyCount: m.replyCount + 1 } : m,
                ),
              },
            };
          }
          // Sent to the channel as well, so it also belongs in the timeline.
          if (message.broadcast) {
            const appended = appendToTimeline(patch.timelines ?? s.timelines);
            if (appended) patch.timelines = appended;
          }
        } else {
          const appended = appendToTimeline(s.timelines);
          if (appended) patch.timelines = appended;
        }
        if (message.userId !== s.self?.id) {
          this.onIncomingMessage?.(message, { live: seq > this.connectedAtSeq });
        }
        // Clear the sender's typing indicator immediately.
        const chTyping = s.typing[message.channelId];
        if (chTyping?.[message.userId]) {
          const { [message.userId]: _gone, ...rest } = chTyping;
          patch.typing = { ...s.typing, [message.channelId]: rest };
        }
        break;
      }
      case "message.updated": {
        const hold = this.timelineHolds.get(event.message.channelId);
        if (hold)
          hold.messages = hold.messages.map((m) =>
            m.id === event.message.id ? { ...m, ...event.message } : m,
          );
        patch.timelines = this.patchMessage(s, event.message.channelId, event.message.id, () => ({
          ...event.message,
        }));
        patch.threads = this.patchThreadMessage(s, event.message.id, () => ({ ...event.message }));
        break;
      }
      case "message.deleted": {
        const hold = this.timelineHolds.get(event.channelId);
        if (hold) hold.messages = hold.messages.filter((m) => m.id !== event.messageId);
        const tl = s.timelines[event.channelId];
        if (tl?.loaded) {
          patch.timelines = {
            ...s.timelines,
            [event.channelId]: {
              ...tl,
              items: tl.items
                .filter((m) => m.id !== event.messageId)
                .map((m) =>
                  m.id === event.threadRootId
                    ? { ...m, replyCount: Math.max(0, m.replyCount - 1) }
                    : m,
                ),
            },
          };
        }
        const threads = { ...s.threads };
        let threadsChanged = false;
        for (const [rootId, replies] of Object.entries(threads)) {
          if (replies.some((m) => m.id === event.messageId)) {
            threads[rootId] = replies.filter((m) => m.id !== event.messageId);
            threadsChanged = true;
          }
        }
        if (event.messageId in threads) {
          delete threads[event.messageId];
          threadsChanged = true;
        }
        if (threadsChanged) patch.threads = threads;
        break;
      }
      case "reaction.added":
      case "reaction.removed": {
        const apply = (m: Message): Message => {
          const groups = m.reactions.filter((g) => g.emoji !== event.emoji);
          const existing = m.reactions.find((g) => g.emoji === event.emoji);
          let userIds = existing?.userIds ?? [];
          userIds =
            event.type === "reaction.added"
              ? [...new Set([...userIds, event.userId])]
              : userIds.filter((id) => id !== event.userId);
          if (userIds.length > 0) groups.push({ emoji: event.emoji, userIds });
          return { ...m, reactions: groups };
        };
        patch.timelines = this.patchMessage(s, event.channelId, event.messageId, apply);
        patch.threads = this.patchThreadMessage(s, event.messageId, apply);
        break;
      }
      case "pin.added":
      case "pin.removed": {
        const pinned = event.type === "pin.added";
        // A pin chosen here and not yet answered stays as chosen; see `choose`.
        if (this.heardChoice(`pin:${event.messageId}`, pinned)) break;
        const setPinned = (m: Message): Message => ({ ...m, pinned });
        patch.timelines = this.patchMessage(s, event.channelId, event.messageId, setPinned);
        patch.threads = this.patchThreadMessage(s, event.messageId, setPinned);
        break;
      }
      case "channel.created":
      case "channel.updated": {
        patch.channels = { ...s.channels, [event.channel.id]: event.channel };
        if (
          event.type === "channel.created" &&
          event.channel.memberIds?.includes(s.self?.id ?? "")
        ) {
          patch.memberships = { ...s.memberships, [event.channel.id]: 0 };
          patch.repliesRead = joined(s.repliesRead, event.channel.id, seq);
        }
        break;
      }
      case "member.joined": {
        if (event.userId === s.self?.id) {
          patch.memberships = {
            ...s.memberships,
            [event.channelId]: s.memberships[event.channelId] ?? 0,
          };
          if (!(event.channelId in s.memberships))
            patch.repliesRead = joined(s.repliesRead, event.channelId, seq);
        }
        const ch = s.channels[event.channelId];
        if (ch?.memberIds && !ch.memberIds.includes(event.userId)) {
          patch.channels = {
            ...s.channels,
            [ch.id]: { ...ch, memberIds: [...ch.memberIds, event.userId] },
          };
        }
        break;
      }
      case "member.left": {
        if (event.userId === s.self?.id) {
          const { [event.channelId]: _gone, ...rest } = s.memberships;
          patch.memberships = rest;
          if (s.repliesRead) {
            const { [event.channelId]: _floor, ...repliesRead } = s.repliesRead;
            patch.repliesRead = repliesRead;
          }
          // Notification settings belong to the membership, which a rejoin
          // starts afresh, and a choice still being saved has nowhere to go.
          const { [event.channelId]: _prefs, ...prefs } = s.prefs;
          const { [event.channelId]: _write, ...prefsWrites } = s.prefsWrites;
          patch.prefs = prefs;
          patch.prefsWrites = prefsWrites;
          this.prefsWrites.delete(event.channelId);
        }
        const ch = s.channels[event.channelId];
        if (ch?.memberIds) {
          patch.channels = {
            ...s.channels,
            [ch.id]: { ...ch, memberIds: ch.memberIds.filter((id) => id !== event.userId) },
          };
        }
        break;
      }
      case "user.joined":
      case "user.updated": {
        let user = event.user;
        // A snooze chosen here and not yet answered stays as chosen; see `choose`.
        if (user.id === s.self?.id && this.heardChoice("dnd", user.dndUntil))
          user = { ...user, dndUntil: s.self.dndUntil };
        patch.users = { ...s.users, [user.id]: user };
        if (user.id === s.self?.id) patch.self = user;
        break;
      }
    }

    const channelId =
      "message" in event ? event.message.channelId : "channelId" in event ? event.channelId : null;
    if (channelId && /^(message|reaction|pin)\./.test(event.type)) {
      for (const [rootId, page] of Object.entries(s.threadPages)) {
        if (page.channelId !== channelId) continue;
        const load = this.threadLoads.get(rootId);
        if (load) {
          if (load.events.length < 2000) load.events.push(envelope);
          else load.overflow = true;
        }
        const items = s.threads[rootId] ?? [];
        const next = updateThread(rootId, page.root, items, [envelope], page.hasMoreNewer);
        patch.threads = {
          ...(patch.threads ?? s.threads),
          [rootId]: next.items.slice(-THREAD_WINDOW),
        };
        patch.threadPages = {
          ...(patch.threadPages ?? s.threadPages),
          [rootId]: {
            ...page,
            root: next.root,
            hasMoreOlder: page.hasMoreOlder || next.items.length > THREAD_WINDOW,
          },
        };
      }
    }
    this.store.setState(patch);
  }

  private patchMessage(
    s: WorkspaceState,
    channelId: ID,
    messageId: ID,
    fn: (m: Message) => Message,
  ): Record<ID, ChannelTimeline> {
    const tl = s.timelines[channelId];
    if (!tl?.loaded) return s.timelines;
    return {
      ...s.timelines,
      [channelId]: { ...tl, items: tl.items.map((m) => (m.id === messageId ? fn(m) : m)) },
    };
  }

  private patchThreadMessage(
    s: WorkspaceState,
    messageId: ID,
    fn: (m: Message) => Message,
  ): Record<ID, Message[]> {
    let changed = false;
    const out: Record<ID, Message[]> = {};
    for (const [rootId, replies] of Object.entries(s.threads)) {
      if (replies.some((m) => m.id === messageId)) {
        out[rootId] = replies.map((m) => (m.id === messageId ? fn(m) : m));
        changed = true;
      } else {
        out[rootId] = replies;
      }
    }
    return changed ? out : s.threads;
  }

  private applyEphemeral(event: EphemeralEvent): void {
    if (event.type === "friends") {
      this.store.setState({ friends: event.friends });
      return;
    }
    if (event.type === "workspace.renamed") {
      this.store.setState({ workspaceName: event.workspaceName });
      return;
    }
    const s = this.store.getState();
    if (event.type === "channel.access") {
      if (!event.channel) {
        this.removeChannel(event.channelId);
        return;
      }
      const memberships = { ...s.memberships };
      const repliesRead = s.repliesRead && { ...s.repliesRead };
      const prefs = { ...s.prefs };
      const prefsWrites = { ...s.prefsWrites };
      if (event.membership) {
        memberships[event.channelId] = event.membership.lastReadSeq;
        if (repliesRead)
          repliesRead[event.channelId] =
            event.membership.repliesReadSeq ?? repliesRead[event.channelId] ?? 0;
        prefs[event.channelId] = event.membership.prefs;
      } else {
        delete memberships[event.channelId];
        if (repliesRead) delete repliesRead[event.channelId];
        delete prefs[event.channelId];
        delete prefsWrites[event.channelId];
        this.prefsWrites.delete(event.channelId);
      }
      this.store.setState({
        channels: { ...s.channels, [event.channelId]: event.channel },
        memberships,
        repliesRead,
        prefs,
        prefsWrites,
      });
      const write = this.prefsWrites.get(event.channelId);
      if (write && event.membership) {
        write.confirmed = event.membership.prefs;
        this.publishPrefs(event.channelId);
      }
    } else if (event.type === "presence") {
      this.store.setState({ presence: { ...s.presence, [event.userId]: event.presence } });
    } else if (event.type === "huddle.participants") {
      const huddles = { ...s.huddles };
      if (event.userIds.length > 0) huddles[event.channelId] = event.userIds;
      else delete huddles[event.channelId];
      this.store.setState({ huddles });
      // Reconcile our own mesh against the new roster.
      if (this.session?.channelId === event.channelId) {
        this.session.syncParticipants(event.userIds);
        this.publishHuddleState();
      }
    } else if (event.type === "huddle.signal") {
      if (this.session?.channelId === event.channelId) {
        void this.session.handleSignal(event.from, event.signal);
      }
    } else if (event.type === "channel.read") {
      if (!(event.channelId in s.memberships)) return;
      // While a conversation is deliberately unread, an acknowledgement still
      // in flight when it was marked must not raise the cursor back.
      if (this.readHold.has(event.channelId)) return;
      const pending = this.pendingReads.get(event.channelId) ?? 0;
      if (pending <= event.seq) this.pendingReads.delete(event.channelId);
      this.store.setState({
        memberships: {
          ...s.memberships,
          [event.channelId]: Math.max(s.memberships[event.channelId] ?? 0, event.seq),
        },
      });
    } else if (event.type === "prefs") {
      const write = this.prefsWrites.get(event.channelId);
      if (write) {
        // What this or another device saved; a choice still being saved from
        // here stays on top until its own answer comes back.
        write.confirmed = event.prefs;
        this.publishPrefs(event.channelId);
      } else {
        this.store.setState({ prefs: { ...s.prefs, [event.channelId]: event.prefs } });
      }
    } else if (event.type === "saved") {
      if (this.heardChoice(`save:${event.messageId}`, event.saved)) return;
      const saved = { ...s.saved };
      if (event.saved) saved[event.messageId] = true;
      else delete saved[event.messageId];
      this.store.setState({ saved });
    } else if (event.type === "mentions") {
      this.store.setState({ mentionCounts: event.counts });
    } else if (event.type === "channel.unread") {
      this.pendingReads.delete(event.channelId);
      this.store.setState({
        memberships: { ...s.memberships, [event.channelId]: event.seq },
      });
    } else if (event.type === "thread.follow") {
      this.applyThreadFollow(event.state);
    } else if (event.type === "ephemeral.message") {
      this.addEphemeral({
        id: event.id,
        channelId: event.channelId,
        userId: event.userId,
        text: event.text,
        createdAt: event.createdAt,
      });
    } else if (event.type === "view.open") {
      // One at a time: a second form arriving would have nowhere to go anyway.
      this.store.setState({ modal: event.view });
    } else if (event.type === "typing") {
      if (event.userId === s.self?.id) return;
      this.store.setState({
        typing: {
          ...s.typing,
          [event.channelId]: { ...s.typing[event.channelId], [event.userId]: Date.now() + 5000 },
        },
      });
    }
  }

  private sweepTyping(): void {
    const s = this.store.getState();
    const now = Date.now();
    let changed = false;
    const typing: WorkspaceState["typing"] = {};
    for (const [chId, byUser] of Object.entries(s.typing)) {
      const kept = Object.fromEntries(Object.entries(byUser).filter(([, exp]) => exp > now));
      if (Object.keys(kept).length !== Object.keys(byUser).length) changed = true;
      if (Object.keys(kept).length > 0) typing[chId] = kept;
    }
    if (changed) this.store.setState({ typing });
  }

  // ---------- actions ----------

  /** Closes the form without answering it; the app is told nothing, as in Slack. */
  dismissModal(): void {
    this.store.setState({ modal: null });
  }

  /**
   * Sends the filled-in form. Field errors come back keyed by block so the UI
   * can put each one under the field it belongs to; the form stays open then.
   */
  async submitModal(
    values: Record<string, Record<string, string>>,
  ): Promise<{ ok: boolean; errors?: Record<string, string>; message?: string }> {
    const modal = this.state.modal;
    if (!modal) return { ok: true };
    const result = await this.api.submitView(modal.id, values);
    if (result.ok) this.store.setState({ modal: null });
    return result;
  }

  /** Visible history is protected while inactive caches are evicted by recency. */
  focusConversation(channelId: ID | null): void {
    for (const held of this.readHold) if (held !== channelId) this.readHold.delete(held);
    this.activeConversation = channelId;
    if (channelId) this.touchHistory("timeline", channelId);
  }

  focusThread(rootId: ID | null): void {
    for (const held of this.threadReadHold) if (held !== rootId) this.threadReadHold.delete(held);
    this.activeThread = rootId;
    if (rootId) this.touchHistory("thread", rootId);
  }

  private touchHistory(kind: "timeline" | "thread", id: ID): void {
    const recency = kind === "timeline" ? this.timelineRecency : this.threadRecency;
    recency.delete(id);
    recency.set(id, true);
    const state = this.state;
    const victims = (ids: ID[], order: Map<ID, true>, protectedIds: (ID | null)[]) => {
      const present = new Set(ids);
      for (const key of order.keys())
        if (!present.has(key) && !protectedIds.includes(key)) order.delete(key);
      const candidates = [...ids.filter((key) => !order.has(key)), ...order.keys()].filter(
        (key) => ids.includes(key) && !protectedIds.includes(key),
      );
      return candidates.slice(0, Math.max(0, ids.length - HISTORY_CACHE_LIMIT));
    };
    const timelineVictims = victims(Object.keys(state.timelines), this.timelineRecency, [
      this.activeConversation,
      kind === "timeline" ? id : null,
    ]);
    const threadVictims = victims(
      [...new Set([...Object.keys(state.threads), ...Object.keys(state.threadPages)])],
      this.threadRecency,
      [this.activeThread, kind === "thread" ? id : null],
    );
    if (!timelineVictims.length && !threadVictims.length) return;
    const timelines = { ...state.timelines };
    const threads = { ...state.threads };
    const threadPages = { ...state.threadPages };
    for (const victim of timelineVictims) {
      delete timelines[victim];
      this.timelineRecency.delete(victim);
      this.timelineRequests.delete(victim);
      this.timelineHolds.delete(victim);
      this.reloadChannels.delete(victim);
    }
    for (const victim of threadVictims) {
      delete threads[victim];
      delete threadPages[victim];
      this.threadRecency.delete(victim);
      this.threadLoads.delete(victim);
      this.reloadThreads.delete(victim);
    }
    // Drafts, pending sends and retained attachment previews are independent of history.
    this.store.setState({ timelines, threads, threadPages });
  }

  /** Each conversation accepts only its most recently requested history window. */
  private beginTimelineRequest(channelId: ID): object {
    const ticket = {};
    this.timelineRequests.set(channelId, ticket);
    return ticket;
  }

  async loadTimeline(
    channelId: ID,
    opts: { older?: boolean; latest?: boolean } = {},
  ): Promise<void> {
    const epoch = this.historyEpoch;
    const tl = this.state.timelines[channelId];
    if (tl?.loaded) this.touchHistory("timeline", channelId);
    if (tl?.loaded && !opts.older && !opts.latest) return;
    if (opts.older && (!tl?.hasMore || tl.items.length === 0)) return;
    const ticket = this.beginTimelineRequest(channelId);
    if (!opts.older) this.timelineHolds.set(channelId, { ticket, messages: [] });
    const releaseHold = () => {
      const hold = this.timelineHolds.get(channelId);
      if (hold?.ticket !== ticket) return [];
      this.timelineHolds.delete(channelId);
      return hold.messages;
    };

    const before = opts.older ? tl!.items[0]!.id : undefined;
    let answer: Awaited<ReturnType<Api["listMessages"]>>;
    try {
      answer = await this.api.listMessages(channelId, { before, limit: 50 });
    } catch (err) {
      releaseHold();
      throw err;
    }
    const { messages, readThroughSeq } = answer;
    const held = releaseHold();
    if (
      this.stopped ||
      epoch !== this.historyEpoch ||
      this.timelineRequests.get(channelId) !== ticket ||
      !this.state.channels[channelId]
    )
      return;
    const page = [...messages].reverse(); // API returns newest-first

    this.store.setState((s) => {
      const existing = s.timelines[channelId];
      const items = opts.older
        ? [...page, ...(existing?.items ?? [])]
        : held.reduce(
            sortedInsert,
            page.reduce(sortedInsert, opts.latest ? [] : (existing?.items ?? [])),
          );
      return {
        timelines: {
          ...s.timelines,
          [channelId]: windowTimeline(
            {
              items,
              hasMore: messages.length === 50,
              // loadTimeline always lands at the tail.
              hasMoreNewer: opts.older ? (existing?.hasMoreNewer ?? false) : false,
              readThroughSeq: opts.older
                ? existing?.readThroughSeq
                : Math.max(existing?.readThroughSeq ?? 0, readThroughSeq ?? page.at(-1)?.seq ?? 0),
              loaded: true,
            },
            // Paging up drops the far end, which is now hundreds of messages
            // below the viewport, not the history being read.
            opts.older ? "newest" : "oldest",
          ),
        },
      };
    });
    this.touchHistory("timeline", channelId);
  }

  /**
   * Replaces the timeline with a window centred on `messageId`, for jumping to
   * a search hit or a pinned message.
   */
  async jumpToMessage(channelId: ID, messageId: ID): Promise<ID | null | undefined> {
    const ticket = ++this.messageJump;
    const timelineTicket = this.beginTimelineRequest(channelId);
    const epoch = this.historyEpoch;
    const existing = this.state.timelines[channelId];
    if (existing) this.touchHistory("timeline", channelId);
    // Already on screen in a tail view — nothing to reload.
    if (
      existing?.loaded &&
      !existing.hasMoreNewer &&
      existing.items.some((m) => m.id === messageId)
    ) {
      return null;
    }
    const { messages, hasMoreOlder, hasMoreNewer, threadRootId } =
      await this.api.listMessagesAround(channelId, messageId);
    if (
      this.stopped ||
      epoch !== this.historyEpoch ||
      ticket !== this.messageJump ||
      this.timelineRequests.get(channelId) !== timelineTicket ||
      !this.state.channels[channelId]
    )
      return;
    this.store.setState((s) => ({
      timelines: {
        ...s.timelines,
        [channelId]: {
          items: [...messages].reverse(),
          hasMore: hasMoreOlder,
          hasMoreNewer,
          loaded: true,
        },
      },
    }));
    this.touchHistory("timeline", channelId);
    return threadRootId ?? null;
  }

  cancelMessageJump(): void {
    this.messageJump++;
  }

  /** Pages forward from an anchored view back toward the newest messages. */
  async loadNewer(channelId: ID): Promise<void> {
    const epoch = this.historyEpoch;
    const tl = this.state.timelines[channelId];
    if (!tl?.loaded || !tl.hasMoreNewer || tl.items.length === 0) return;
    const ticket = this.beginTimelineRequest(channelId);
    const newest = tl.items[tl.items.length - 1]!;
    const { messages } = await this.api.listMessagesAfter(channelId, newest.id, 50);
    if (
      this.stopped ||
      epoch !== this.historyEpoch ||
      this.timelineRequests.get(channelId) !== ticket ||
      !this.state.channels[channelId]
    )
      return;
    this.store.setState((s) => {
      const current = s.timelines[channelId];
      if (!current) return {};
      return {
        timelines: {
          ...s.timelines,
          [channelId]: windowTimeline(
            {
              ...current,
              items: [...current.items, ...[...messages].reverse()],
              hasMoreNewer: messages.length === 50,
            },
            "oldest",
          ),
        },
      };
    });
    this.touchHistory("timeline", channelId);
  }

  /** Keeps the current window visible until the live tail has loaded successfully. */
  async jumpToLatest(channelId: ID): Promise<void> {
    this.cancelMessageJump();
    await this.loadTimeline(channelId, { latest: true });
  }

  async loadThread(
    threadRootId: ID,
    channelId: ID,
    direction: "latest" | "older" | "newer" = "latest",
    around?: ID,
  ): Promise<void> {
    const previous = this.state.threadPages[threadRootId];
    const items = this.state.threads[threadRootId] ?? [];
    if (
      direction !== "latest" &&
      (previous?.loading ||
        !items.length ||
        (direction === "older" ? !previous?.hasMoreOlder : !previous?.hasMoreNewer))
    )
      return;
    const epoch = this.historyEpoch;
    const request = { events: [] as EventEnvelope[], overflow: false };
    this.threadLoads.set(threadRootId, request);
    this.store.setState((s) => ({
      threads: { ...s.threads, [threadRootId]: items },
      threadPages: {
        ...s.threadPages,
        [threadRootId]: {
          channelId,
          root:
            previous?.root ??
            s.timelines[channelId]?.items.find((m) => m.id === threadRootId) ??
            null,
          hasMoreOlder: previous?.hasMoreOlder ?? false,
          hasMoreNewer: previous?.hasMoreNewer ?? false,
          loaded: previous?.loaded ?? false,
          loading: true,
          error: null,
        },
      },
    }));
    const current = () =>
      !this.stopped &&
      epoch === this.historyEpoch &&
      !!this.state.channels[channelId] &&
      this.threadLoads.get(threadRootId) === request;
    this.touchHistory("thread", threadRootId);
    try {
      const response = await this.api.threadHistory(channelId, threadRootId, {
        ...(direction === "older"
          ? { before: items[0]!.id }
          : direction === "newer"
            ? { after: items.at(-1)!.id }
            : around
              ? { around }
              : {}),
        limit: 50,
      });
      if (!current()) return;
      if (request.overflow) throw new Error("Thread changed too quickly to reconcile this page");
      const next = updateThread(
        threadRootId,
        response.root,
        response.messages,
        request.events.filter((e) => e.seq > response.seq),
        response.hasMoreNewer,
      );
      let merged =
        direction === "latest"
          ? next.items
          : [
              ...new Map(
                [...next.items, ...(this.state.threads[threadRootId] ?? [])].map((m) => [m.id, m]),
              ).values(),
            ].sort((a, b) => a.id.localeCompare(b.id));
      let hasMoreOlder =
        direction === "newer"
          ? this.state.threadPages[threadRootId]!.hasMoreOlder
          : response.hasMoreOlder;
      let hasMoreNewer =
        direction === "older"
          ? this.state.threadPages[threadRootId]!.hasMoreNewer
          : response.hasMoreNewer;
      if (merged.length > THREAD_WINDOW) {
        if (direction === "older") {
          merged = merged.slice(0, THREAD_WINDOW);
          hasMoreNewer = true;
        } else {
          merged = merged.slice(-THREAD_WINDOW);
          hasMoreOlder = true;
        }
      }
      if (!next.root) merged = [];
      this.store.setState((s) => ({
        threads: { ...s.threads, [threadRootId]: merged },
        threadPages: {
          ...s.threadPages,
          [threadRootId]: {
            channelId,
            root: next.root,
            hasMoreOlder,
            hasMoreNewer,
            loading: false,
            loaded: true,
            error: null,
          },
        },
      }));
    } catch (error) {
      if (!current()) return;
      this.store.setState((s) => ({
        threadPages: {
          ...s.threadPages,
          [threadRootId]: {
            ...s.threadPages[threadRootId]!,
            loading: false,
            ...(error instanceof ApiError && error.status === 404
              ? { root: null, loaded: true }
              : {}),
            error:
              error instanceof ApiError && error.status === 404
                ? "This thread is no longer available."
                : "Could not load replies. Try again.",
          },
        },
      }));
    } finally {
      if (this.threadLoads.get(threadRootId) === request) this.threadLoads.delete(threadRootId);
    }
  }

  /** Files held for a retry, keyed by nonce — never exposed to the store. */
  private retryFiles = new Map<string, File[]>();
  private uploadedFiles = new Map<string, ID[]>();

  /**
   * Optimistic send: the message (and local image previews) appear instantly,
   * then attachments upload and the server event reconciles it by nonce.
   * Returns false, having taken nothing, when there is nothing to send or
   * `OUTBOX_LIMIT` messages are already waiting; the caller keeps the draft.
   */
  send(
    channelId: ID,
    text: string,
    opts: { threadRootId?: ID; files?: File[]; alsoSendToChannel?: boolean } = {},
  ): boolean {
    const self = this.state.self;
    if (!self) return false;
    const files = opts.files ?? [];
    if (!text.trim() && files.length === 0) return false;

    // A leading "/word" is a command, not a message. The trailing space or end
    // of line matters: it keeps a pasted path like /Users/me/notes.txt a
    // perfectly ordinary message.
    if (files.length === 0 && /^\/[a-zA-Z0-9_-]+(\s|$)/.test(text.trim())) {
      void this.runCommand(channelId, text.trim(), opts.threadRootId);
      return true;
    }
    if (this.outboxFull()) return false;

    // getRandomValues also works on plain HTTP LAN origins, unlike randomUUID.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const attachments: LocalAttachment[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      mime: f.type,
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    }));
    const pendingMsg: PendingMessage = {
      nonce,
      channelId,
      threadRootId: opts.threadRootId ?? null,
      broadcast: !!opts.threadRootId && !!opts.alsoSendToChannel,
      text,
      userId: self.id,
      createdAt: Date.now(),
      failed: false,
      failureReason: null,
      attachments,
      uploadProgress: files.length > 0 ? 0 : null,
    };
    this.store.setState((s) => ({ pending: [...s.pending, pendingMsg] }));
    if (files.length > 0) this.retryFiles.set(nonce, files);

    void this.deliver(channelId, text, files, nonce, opts.threadRootId, opts.alsoSendToChannel);
    return true;
  }

  /** True when this account already has `OUTBOX_LIMIT` messages waiting to send. */
  outboxFull(): boolean {
    const self = this.state.self?.id;
    return this.state.pending.filter((p) => p.userId === self).length >= OUTBOX_LIMIT;
  }

  private async deliver(
    channelId: ID,
    text: string,
    files: File[],
    nonce: string,
    threadRootId?: ID,
    alsoSendToChannel?: boolean,
  ): Promise<void> {
    const setProgress = (fraction: number) =>
      this.store.setState((s) => ({
        pending: s.pending.map((p) => (p.nonce === nonce ? { ...p, uploadProgress: fraction } : p)),
      }));

    try {
      const fileIds = this.uploadedFiles.get(nonce) ?? [];
      this.uploadedFiles.set(nonce, fileIds);
      for (const [i, file] of files.entries()) {
        if (i < fileIds.length) continue;
        if (!this.stillSending(nonce)) return;
        const { file: uploaded } = await this.api.uploadFile(channelId, file, file.name, {
          onProgress: (fraction) => setProgress((i + fraction) / files.length),
        });
        fileIds.push(uploaded.id);
      }
      if (!this.stillSending(nonce)) return;
      if (files.length > 0) setProgress(1);

      const body: SendMessageBody = {
        text,
        nonce,
        ...(threadRootId ? { threadRootId } : {}),
        ...(threadRootId && alsoSendToChannel ? { alsoSendToChannel: true } : {}),
        ...(fileIds.length > 0 ? { fileIds } : {}),
      };
      const { message } = await this.api.sendMessage(channelId, body);
      if (!this.stopped && this.state.status !== "auth_failed") {
        this.applyEvent({ seq: message.seq, event: { type: "message.created", message } }, true);
      }
    } catch (error) {
      const refused = isRefusal(error);
      // A refusal taken on from another window stays until its author's Retry;
      // not reaching the server from here says nothing new about it.
      if (!refused && this.state.pending.some((p) => p.nonce === nonce && p.refused)) return;
      this.failPending(nonce, sendFailureReason(error), refused);
    }
  }

  /** Whether a send is still wanted: not discarded, delivered or refused meanwhile. */
  private stillSending(nonce: string): boolean {
    return !this.stopped && this.state.pending.some((p) => p.nonce === nonce && !p.refused);
  }

  private failPending(nonce: string, failureReason: string, refused = false): void {
    this.store.setState((s) => ({
      pending: s.pending.map((p) =>
        p.nonce === nonce
          ? { ...p, failed: true, failureReason, refused, uploadProgress: null }
          : p,
      ),
    }));
  }

  retrySend(nonce: string): void {
    const p = this.state.pending.find((p) => p.nonce === nonce);
    if (!p?.failed) return;
    const files = this.retryFiles.get(nonce) ?? [];
    // Sending now would post the words without the files the author chose.
    if (p.attachments.length > 0 && files.length !== p.attachments.length) {
      this.failPending(nonce, MISSING_ATTACHMENTS);
      return;
    }
    this.store.setState((s) => ({
      pending: s.pending.map((item) =>
        item.nonce === nonce
          ? { ...item, failed: false, failureReason: null, refused: false }
          : item,
      ),
    }));
    void this.deliver(p.channelId, p.text, files, nonce, p.threadRootId ?? undefined, p.broadcast);
  }

  /**
   * The whole outbox in a form that survives a restart: every send accepted
   * stays, and a known refusal keeps its reason. Preview URLs are not kept.
   */
  outboxSnapshot(): StoredPending[] {
    return this.state.pending.map((p) => ({
      nonce: p.nonce,
      channelId: p.channelId,
      threadRootId: p.threadRootId,
      broadcast: p.broadcast,
      text: p.text,
      userId: p.userId,
      createdAt: p.createdAt,
      attachments: p.attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
      ...(p.failed && p.refused ? { refusal: p.failureReason ?? "This message was refused." } : {}),
    }));
  }

  /**
   * Puts back work the author had already committed to sending. Re-delivery is
   * safe because the server settles a repeated request key onto the same
   * message, so a send that did reach the server before the restart cannot
   * become a second one. Once retention has removed that message, the server
   * remembers its key only for a while, so a send older than
   * `SEND_RETRY_WINDOW_MS` is not sent again on its own: it waits, saying so,
   * for its author's Retry.
   * Attachments do not survive a restart, so those entries stop and say so
   * instead of posting the words without the files. A send the server refused
   * stays refused until the author chooses Retry: whatever made it refuse may
   * have changed since, and that is theirs to decide. Nothing is dropped for
   * being one too many; every entry here was accepted once.
   */
  restoreOutbox(entries: StoredPending[]): void {
    const self = this.state.self;
    if (!self) return;
    const now = Date.now();
    const restored = entries
      .filter((e) => e.userId === self.id && !this.state.pending.some((p) => p.nonce === e.nonce))
      .map(({ refusal, ...e }): PendingMessage => {
        const reason =
          refusal ??
          (e.attachments.length > 0
            ? MISSING_ATTACHMENTS
            : now - e.createdAt > SEND_RETRY_WINDOW_MS
              ? STALE_SEND
              : null);
        return {
          ...e,
          failed: reason !== null,
          failureReason: reason,
          refused: refusal !== undefined,
          attachments: e.attachments.map((a) => ({ ...a, previewUrl: null })),
          uploadProgress: null,
        };
      });
    if (restored.length === 0) return;
    this.store.setState((s) => ({ pending: [...s.pending, ...restored] }));
    for (const entry of restored) {
      if (entry.failed) continue;
      void this.deliver(
        entry.channelId,
        entry.text,
        [],
        entry.nonce,
        entry.threadRootId ?? undefined,
        entry.broadcast,
      );
    }
  }

  discardSend(nonce: string): void {
    this.dropPending(nonce);
  }

  /**
   * Takes on the refusal another window on this account was given for the
   * same send, so this one stops sending it too and waits for its author's
   * Retry instead of trying again on its own.
   */
  adoptRefusal(nonce: string, reason: string): void {
    const p = this.state.pending.find((x) => x.nonce === nonce);
    if (!p || p.refused) return;
    this.failPending(nonce, reason, true);
  }

  private dropPending(nonce: string): void {
    const p = this.state.pending.find((x) => x.nonce === nonce);
    if (p) {
      for (const a of p.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    this.retryFiles.delete(nonce);
    this.uploadedFiles.delete(nonce);
    this.store.setState((s) => ({ pending: s.pending.filter((x) => x.nonce !== nonce) }));
  }

  /**
   * Optimistic reaction toggle. Resolves false when the server refused it, so
   * the caller can say so; a refusal never rejects, because these are called
   * from click handlers that have nowhere to put an exception.
   */
  async toggleReaction(message: Message, emoji: string): Promise<boolean> {
    const selfId = this.state.self?.id;
    if (!selfId) return false;
    const has = message.reactions.some((g) => g.emoji === emoji && g.userIds.includes(selfId));
    try {
      await (has
        ? this.api.removeReaction(message.id, emoji)
        : this.api.addReaction(message.id, emoji));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The choices being made about one thing each (a message's pin, its save,
   * the snooze) while any request for it is unanswered.
   */
  private choices = new Map<string, Choice<unknown>>();

  /**
   * Makes one choice about one thing. Every request goes out at once, so one
   * that is stuck cannot hold up the next, and what is shown is the latest
   * choice while any is unanswered. When the last answer is in:
   *
   * - The latest choice was accepted: it is shown. If other requests for the
   *   same thing overlapped it, or the server said otherwise meanwhile, it is
   *   sent once more, on its own, so the server ends with it whatever order
   *   the requests reached it in.
   * - It was refused: what the server last said is shown, by an answer or an
   *   echo, whichever was heard last; not the opposite of the refused choice.
   *
   * Resolves with whether this request was accepted.
   */
  private choose<V>(key: string, value: V, io: ChoiceIo<V>): Promise<boolean> {
    let choice = this.choices.get(key) as Choice<V> | undefined;
    if (!choice) {
      choice = {
        io,
        latest: value,
        confirmed: io.current(),
        unanswered: 0,
        sent: 0,
        latestSent: 0,
        latestAccepted: false,
        contested: false,
        resent: false,
      };
      this.choices.set(key, choice as Choice<unknown>);
    }
    choice.latest = value;
    choice.resent = false;
    io.show(value);
    return this.sendChoice(key, choice);
  }

  private async sendChoice<V>(key: string, choice: Choice<V>): Promise<boolean> {
    const value = choice.latest;
    const sent = ++choice.sent;
    choice.latestSent = sent;
    choice.unanswered++;
    let accepted = false;
    try {
      const answer = await choice.io.send(value);
      accepted = true;
      choice.confirmed = answer === undefined ? value : answer;
    } catch {
      // Refused or lost: what the server has is whatever it last said.
    }
    if (sent === choice.latestSent) choice.latestAccepted = accepted;
    choice.unanswered--;
    if (choice.unanswered > 0 || this.choices.get(key) !== choice) return accepted;
    if (choice.latestAccepted && (choice.sent > 1 || choice.contested) && !choice.resent) {
      choice.resent = true;
      choice.sent = 0;
      choice.contested = false;
      void this.sendChoice(key, choice);
      return accepted;
    }
    this.choices.delete(key);
    choice.io.show(choice.latestAccepted ? choice.latest : choice.confirmed);
    return accepted;
  }

  /**
   * What the server now has, heard from it rather than answered. True while
   * a choice about it here is unanswered: it is then kept, not shown, since
   * it may be the server's word on an earlier request of this device's.
   */
  private heardChoice(key: string, value: unknown): boolean {
    const choice = this.choices.get(key);
    if (!choice) return false;
    choice.confirmed = value;
    if (value !== choice.latest) choice.contested = true;
    return true;
  }

  /** Optimistic pin toggle; the channel-wide event confirms it. */
  togglePin(message: Message): Promise<boolean> {
    const show = (pinned: boolean) => {
      const apply = (m: Message): Message => (m.pinned === pinned ? m : { ...m, pinned });
      this.store.setState((s) => ({
        timelines: this.patchMessage(s, message.channelId, message.id, apply),
        threads: this.patchThreadMessage(s, message.id, apply),
      }));
    };
    return this.choose(`pin:${message.id}`, !message.pinned, {
      current: () => message.pinned,
      show,
      send: async (pinned) => {
        await (pinned ? this.api.pinMessage(message.id) : this.api.unpinMessage(message.id));
      },
    });
  }

  /**
   * Optimistic save-for-later toggle; this account's devices get the echo.
   * Pass `save` to repeat an earlier intent, so trying a refused save again
   * saves even if the state has changed elsewhere since, rather than flipping.
   */
  toggleSaved(messageId: ID, save = !this.state.saved[messageId]): Promise<boolean> {
    return this.choose(`save:${messageId}`, save, {
      current: () => !!this.state.saved[messageId],
      show: (on) =>
        this.store.setState((s) => {
          if (!!s.saved[messageId] === on) return {};
          const saved = { ...s.saved };
          if (on) saved[messageId] = true;
          else delete saved[messageId];
          return { saved };
        }),
      send: async (on) => {
        await (on ? this.api.saveMessage(messageId) : this.api.unsaveMessage(messageId));
      },
    });
  }

  /**
   * Follow updates can arrive from this device and another at once. The
   * revision decides, so a stale echo cannot undo a newer choice.
   */
  private applyThreadFollow(state: ThreadFollow): void {
    this.store.setState((s) => {
      const known = s.threadFollows[state.rootId];
      if (known && known.revision > state.revision) return {};
      return { threadFollows: { ...s.threadFollows, [state.rootId]: state } };
    });
  }

  /** Optimistic follow toggle for a thread; other devices get the echo. */
  setThreadFollow(rootId: ID, following: boolean): void {
    const before = this.state.threadFollows[rootId];
    if (before?.following === following) return;
    const channelId = before?.channelId ?? this.threadRoot(rootId)?.channelId;
    if (!channelId) return;
    const tail = this.threadTailSeq(rootId);
    this.writeThreadFollow(
      {
        rootId,
        channelId,
        following,
        // Following from here means caught up to whatever is loaded.
        lastReadSeq: following ? Math.max(before?.lastReadSeq ?? 0, tail) : 0,
        lastSeq: Math.max(before?.lastSeq ?? 0, tail),
        revision: (before?.revision ?? 0) + 1,
      },
      () => this.api.setThreadFollow(rootId, following),
    );
  }

  /**
   * Shows a thread's new state at once, then the server's. If the server
   * refuses, this puts back exactly what was there, including "no row at all",
   * but only while nothing has replaced this state since: a later read, follow
   * or unread, or the server's word, is newer than the request that failed.
   */
  private writeThreadFollow(
    next: ThreadFollow,
    request: () => Promise<{ state: ThreadFollow }>,
    onRefused?: () => void,
  ): void {
    const before = this.state.threadFollows[next.rootId];
    this.applyThreadFollow(next);
    void request()
      .then(({ state }) => this.applyThreadFollow(state))
      .catch(() => {
        if (this.state.threadFollows[next.rootId] !== next) return;
        onRefused?.();
        this.store.setState((s) => {
          const threadFollows = { ...s.threadFollows };
          if (before) threadFollows[next.rootId] = before;
          else delete threadFollows[next.rootId];
          return { threadFollows };
        });
      });
  }

  /**
   * Marks a thread read up to its loaded tail. This is the only cursor that
   * reading a thread moves: the channel's stays put, so unseen channel
   * messages and mentions stay unread. A thread you do not follow keeps its
   * cursor too, without following it.
   */
  markThreadRead(rootId: ID, opts: { explicit?: boolean } = {}): void {
    if (opts.explicit) this.threadReadHold.delete(rootId);
    else if (this.threadReadHold.has(rootId)) return;
    const before = this.state.threadFollows[rootId];
    const channelId = before?.channelId ?? this.threadRoot(rootId)?.channelId;
    if (!channelId) return;
    const seq = this.threadTailSeq(rootId);
    if (seq <= (before?.lastReadSeq ?? 0)) return;
    this.writeThreadFollow(
      {
        rootId,
        channelId,
        following: before?.following ?? false,
        lastReadSeq: seq,
        lastSeq: Math.max(before?.lastSeq ?? 0, seq),
        revision: (before?.revision ?? 0) + 1,
      },
      () => this.api.markThreadRead(rootId, seq),
    );
  }

  /** The root message of a thread, from its open panel or a loaded timeline. */
  private threadRoot(rootId: ID): Message | undefined {
    const page = this.state.threadPages[rootId];
    if (page?.root) return page.root;
    for (const timeline of Object.values(this.state.timelines)) {
      const found = timeline.items.find((m) => m.id === rootId);
      if (found) return found;
    }
    return undefined;
  }

  /** The newest seq this client has loaded for a thread, root included. */
  private threadTailSeq(rootId: ID): number {
    const replies = this.state.threads[rootId] ?? [];
    const root = this.threadRoot(rootId);
    let seq = root?.seq ?? 0;
    for (const reply of replies) if (reply.seq > seq) seq = reply.seq;
    return seq;
  }

  /**
   * Notification choices per channel that the server has not answered yet.
   * One request per channel is in flight at a time, so the server applies
   * them in the order they were made; what is chosen meanwhile waits in
   * `queued`, merged. `confirmed` is the server's last word, from the
   * snapshot, an echo or an answer, and what is shown is it with the
   * in-flight and queued choices on top.
   */
  private prefsWrites = new Map<
    ID,
    {
      confirmed: ChannelPrefs;
      inFlight: Partial<ChannelPrefs> | null;
      queued: Partial<ChannelPrefs> | null;
      failed: Partial<ChannelPrefs> | null;
    }
  >();

  /**
   * Shows a notification choice for one channel at once, then saves it. If
   * the server refuses, the channel shows what the server has, and the
   * choice is kept in `prefsWrites` to try again, unless a later choice has
   * already replaced it: an earlier request failing never undoes a later one.
   */
  setChannelPrefs(channelId: ID, patch: Partial<ChannelPrefs>): void {
    let write = this.prefsWrites.get(channelId);
    if (!write) {
      write = {
        confirmed: this.state.prefs[channelId] ?? { notifyLevel: "mentions", muted: false },
        inFlight: null,
        queued: null,
        failed: null,
      };
      this.prefsWrites.set(channelId, write);
    }
    write.queued = { ...write.queued, ...patch };
    // A new choice about the same setting replaces the one that failed.
    if (write.failed) write.failed = omitKeys(write.failed, Object.keys(patch));
    if (!write.inFlight) this.sendPrefs(channelId);
    else this.publishPrefs(channelId);
  }

  /** Tries again to save the notification choice for a channel that failed. */
  retryChannelPrefs(channelId: ID): void {
    const failed = this.prefsWrites.get(channelId)?.failed;
    if (failed && Object.keys(failed).length > 0) this.setChannelPrefs(channelId, failed);
  }

  private sendPrefs(channelId: ID): void {
    const write = this.prefsWrites.get(channelId);
    if (!write?.queued) return;
    const patch = write.queued;
    write.queued = null;
    write.inFlight = patch;
    this.publishPrefs(channelId);
    const settle = (answer: ChannelPrefs | null) => {
      // Gone, or started over, while this was out: nothing here to settle.
      if (this.prefsWrites.get(channelId) !== write) return;
      write.inFlight = null;
      if (answer) write.confirmed = answer;
      else {
        // What a later choice has replaced is no loss to report.
        const lost = omitKeys(patch, Object.keys(write.queued ?? {}));
        if (Object.keys(lost).length > 0) write.failed = { ...write.failed, ...lost };
      }
      if (write.queued) this.sendPrefs(channelId);
      else this.publishPrefs(channelId);
    };
    this.api.setChannelPrefs(channelId, patch).then(
      ({ prefs }) => settle(prefs),
      () => settle(null),
    );
  }

  private publishPrefs(channelId: ID): void {
    const write = this.prefsWrites.get(channelId);
    if (!write) return;
    const shown = { ...write.confirmed, ...write.inFlight, ...write.queued };
    const saving = write.inFlight !== null || write.queued !== null;
    const failed = write.failed && Object.keys(write.failed).length > 0 ? write.failed : null;
    if (!saving && !failed) this.prefsWrites.delete(channelId);
    this.store.setState((s) => {
      const prefsWrites = { ...s.prefsWrites };
      if (saving || failed) prefsWrites[channelId] = { saving, failed };
      else delete prefsWrites[channelId];
      return { prefs: { ...s.prefs, [channelId]: shown }, prefsWrites };
    });
  }

  /** Snooze notifications for `minutes`, or pass null to clear Do Not Disturb. */
  snoozeNotifications(minutes: number | null): void {
    this.snoozeNotificationsUntil(minutes === null ? null : Date.now() + minutes * 60_000);
  }

  /**
   * Pause notifications until an epoch ms time; null resumes them now. The
   * server ends with the latest snooze chosen here, whatever order the
   * requests reach it in; if that one is refused, only the snooze goes back,
   * to what the server last said, and the rest of the profile is left as it
   * now is. See `choose`.
   */
  snoozeNotificationsUntil(dndUntil: number | null): void {
    if (!this.state.self) return;
    void this.choose("dnd", dndUntil, {
      current: () => this.state.self?.dndUntil ?? null,
      show: (until) => {
        const self = this.state.self;
        if (self && self.dndUntil !== until)
          this.store.setState({ self: { ...self, dndUntil: until } });
      },
      send: async (until) => (await this.api.updateMe({ dndUntil: until })).user.dndUntil,
    });
  }

  /** True while notifications are snoozed. */
  isSnoozed(now = Date.now()): boolean {
    const until = this.state.self?.dndUntil ?? null;
    return until !== null && until > now;
  }

  // ---------- huddles ----------

  private session: HuddleSession | null = null;
  private huddleAttempt = 0;

  /** Mirrors the live session into the store so React can render it. */
  private publishHuddleState(): void {
    this.store.setState({ huddle: this.session?.state() ?? null });
  }

  /**
   * Joins the channel's huddle, starting one if nobody is in it. Throws if the
   * microphone is unavailable, leaving no half-joined room behind.
   */
  async joinHuddle(channelId: ID): Promise<void> {
    this.leaveHuddle();
    const attempt = this.huddleAttempt;
    const selfId = this.state.self?.id;
    if (!selfId) return;

    const config = await this.api.rtcConfig();
    if (attempt !== this.huddleAttempt) return;

    const session = new HuddleSession(
      channelId,
      selfId,
      {
        send: (msg) => this.sendSocket(msg),
      },
      config,
    );
    this.session = session;
    try {
      await session.startLocalAudio();
    } catch (err) {
      session.destroy();
      if (this.session === session) this.session = null;
      throw err;
    }
    if (attempt !== this.huddleAttempt) {
      session.destroy();
      return;
    }
    session.onChange = () => this.publishHuddleState();
    this.session = session;

    this.sendSocket({ type: "huddle.join", channelId });
    // Dial whoever is already there; later arrivals come via participants events.
    session.syncParticipants(this.state.huddles[channelId] ?? []);
    this.publishHuddleState();
  }

  leaveHuddle(): void {
    this.huddleAttempt++;
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.sendSocket({ type: "huddle.leave", channelId: session.channelId });
    session.destroy();
    this.publishHuddleState();
  }

  toggleMic(): void {
    this.session?.toggleMic();
  }

  async toggleScreenShare(): Promise<void> {
    await this.session?.toggleScreenShare();
  }

  async toggleCamera(): Promise<void> {
    await this.session?.toggleCamera();
  }

  private sendSocket(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  setDraft(channelId: ID, text: string): void {
    this.store.setState((s) => {
      const drafts = { ...s.drafts };
      if (text.trim()) drafts[channelId] = text;
      else delete drafts[channelId];
      return { drafts };
    });
  }

  /** Seeds drafts restored from disk at startup. */
  hydrateDrafts(drafts: Record<ID, string>): void {
    this.store.setState({ drafts });
  }

  /**
   * `explicit` marks someone actually asking for this, rather than the visible
   * timeline acknowledging itself. Only the former overrides a deliberate
   * unread, so looking at a conversation cannot undo one but choosing to read
   * it can.
   */
  markRead(
    channelId: ID,
    seq = this.state.channelLastSeq[channelId] ?? 0,
    opts: { explicit?: boolean } = {},
  ): void {
    if (opts.explicit) this.readHold.delete(channelId);
    else if (this.readHold.has(channelId)) return;
    if (!(channelId in this.state.memberships) || !Number.isSafeInteger(seq) || seq < 0) return;
    const current = this.state.memberships[channelId] ?? 0;
    if (seq <= current) return;
    this.pendingReads.set(channelId, Math.max(this.pendingReads.get(channelId) ?? 0, seq));
    this.store.setState((s) => ({ memberships: { ...s.memberships, [channelId]: seq } }));
    this.flushReads();
  }

  /**
   * Leaves a message and everything after it unread. Any acknowledgement
   * already on its way is abandoned first, so it cannot land afterwards and
   * undo this.
   */
  markUnread(channelId: ID, seq: number): void {
    if (!(channelId in this.state.memberships) || !Number.isSafeInteger(seq) || seq < 1) return;
    this.readRequests.get(channelId)?.abort();
    this.readRequests.delete(channelId);
    this.pendingReads.delete(channelId);
    this.readHold.add(channelId);
    const before = this.state.memberships[channelId] ?? 0;
    this.store.setState((s) => ({ memberships: { ...s.memberships, [channelId]: seq - 1 } }));
    void this.api.markUnread(channelId, seq).catch(() => {
      // A read or another mark unread since has moved the cursor, and is newer.
      if (this.state.memberships[channelId] !== seq - 1) return;
      this.readHold.delete(channelId);
      this.store.setState((s) => ({ memberships: { ...s.memberships, [channelId]: before } }));
    });
  }

  /** The same for one thread, which also follows it. */
  markThreadUnread(rootId: ID, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 1) return;
    const before = this.state.threadFollows[rootId];
    const channelId = before?.channelId ?? this.threadRoot(rootId)?.channelId;
    if (!channelId) return;
    this.threadReadHold.add(rootId);
    this.writeThreadFollow(
      {
        rootId,
        channelId,
        following: true,
        lastReadSeq: seq - 1,
        lastSeq: Math.max(before?.lastSeq ?? 0, this.threadTailSeq(rootId)),
        revision: (before?.revision ?? 0) + 1,
      },
      () => this.api.markThreadUnread(rootId, seq),
      () => this.threadReadHold.delete(rootId),
    );
  }

  private clearReadRequests(): void {
    for (const controller of this.readRequests.values()) controller.abort();
    this.readRequests.clear();
    this.pendingReads.clear();
    // Holds deliberately survive a resync: a reconnect long enough to discard
    // history must not quietly read what someone marked unread.
  }

  private flushReads(): void {
    if (this.stopped || this.state.status !== "online") return;
    for (const [channelId, seq] of this.pendingReads) {
      if (!(channelId in this.state.memberships)) {
        this.pendingReads.delete(channelId);
        continue;
      }
      if (this.readRequests.has(channelId)) continue;
      const controller = new AbortController();
      this.readRequests.set(channelId, controller);
      void this.api
        .markRead(channelId, seq, controller.signal)
        .then((result) => {
          if (
            controller.signal.aborted ||
            this.stopped ||
            this.readRequests.get(channelId) !== controller
          )
            return;
          const acknowledged = result.seq ?? seq;
          if ((this.pendingReads.get(channelId) ?? 0) <= acknowledged)
            this.pendingReads.delete(channelId);
          this.applyEphemeral({ type: "channel.read", channelId, seq: acknowledged });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && (error.status === 403 || error.status === 404))
            this.pendingReads.delete(channelId);
          // Network failures retain the largest pending cursor for reconnect or the retry timer.
        })
        .finally(() => {
          if (this.readRequests.get(channelId) === controller) this.readRequests.delete(channelId);
        });
    }
  }

  /**
   * Runs a slash command. Anything it has to say comes back over the socket as
   * an ephemeral, so the only thing handled here is the command not working at
   * all — which is still worth telling the person who typed it.
   */
  private async runCommand(channelId: ID, text: string, threadRootId?: ID): Promise<void> {
    try {
      await this.api.runCommand(channelId, {
        text,
        ...(threadRootId ? { threadRootId } : {}),
      });
    } catch (err) {
      const name = /^\/([a-zA-Z0-9_-]+)/.exec(text)?.[1] ?? "";
      const message =
        err instanceof ApiError && err.code === "unknown_command"
          ? `\`/${name}\` is not a command here.`
          : `\`/${name}\` could not run: ${err instanceof ApiError ? err.message : "the server did not answer"}.`;
      this.addEphemeral({
        id: `local-${Date.now()}-${++this.nonceCounter}`,
        channelId,
        userId: "",
        text: message,
        createdAt: Date.now(),
      });
    }
  }

  private addEphemeral(message: EphemeralMessage): void {
    this.store.setState((s) => ({
      ephemerals: {
        ...s.ephemerals,
        [message.channelId]: [...(s.ephemerals[message.channelId] ?? []), message],
      },
    }));
  }

  dismissEphemeral(channelId: ID, id: ID): void {
    this.store.setState((s) => {
      const kept = (s.ephemerals[channelId] ?? []).filter((e) => e.id !== id);
      const ephemerals = { ...s.ephemerals };
      if (kept.length > 0) ephemerals[channelId] = kept;
      else delete ephemerals[channelId];
      return { ephemerals };
    });
  }

  /** Loads the `/` hint list. Failure is silent: hints are a convenience. */
  async loadCommands(): Promise<void> {
    try {
      const { commands } = await this.api.listCommands();
      this.store.setState({ commands });
    } catch {
      /* an older server, or no permission — the composer simply shows no hints */
    }
  }

  sendTyping(channelId: ID): void {
    this.sendSocket({ type: "typing", channelId });
  }

  async openDm(userIds: ID[]): Promise<Channel> {
    const { channel } = await this.api.createChannel({
      type: userIds.length === 1 ? "dm" : "group_dm",
      memberIds: userIds,
    } as never);
    this.store.setState((s) => ({
      channels: { ...s.channels, [channel.id]: channel },
      memberships: { ...s.memberships, [channel.id]: s.memberships[channel.id] ?? 0 },
      repliesRead:
        channel.id in s.memberships ? s.repliesRead : joined(s.repliesRead, channel.id, s.lastSeq),
    }));
    return channel;
  }

  unreadCount(channelId: ID): boolean {
    const s = this.state;
    const last = s.channelLastSeq[channelId] ?? 0;
    const read = s.memberships[channelId] ?? 0;
    return last > read;
  }
}

/**
 * `repliesRead` after joining a channel at `seq`: its replies until then are
 * not this account's to catch up on, as the server counts them on joining.
 */
function joined(repliesRead: Record<ID, number> | null, channelId: ID, seq: number) {
  return repliesRead && { ...repliesRead, [channelId]: seq };
}

/** A copy of `values` without the given keys. */
function omitKeys<T extends object>(values: T, keys: string[]): Partial<T> {
  const out: Partial<T> = { ...values };
  for (const key of keys) delete out[key as keyof T];
  return out;
}
