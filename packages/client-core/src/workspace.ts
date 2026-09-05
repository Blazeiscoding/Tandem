import { createStore, type StoreApi } from "zustand/vanilla";
import {
  PROTOCOL_VERSION,
  type Channel,
  type ChannelPrefs,
  type EphemeralEvent,
  type EventEnvelope,
  type Friendship,
  type ID,
  type Message,
  type Presence,
  type ReadySnapshot,
  type SendMessageBody,
  type ServerToClient,
  type User,
} from "@slackoss/protocol";
import { Api, ApiError, type CommandHint } from "./api.js";
import { FileCache } from "./fileCache.js";
import { HuddleSession, type HuddleState } from "./huddle.js";

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "auth_failed" | "closed";

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
  text: string;
  userId: ID;
  createdAt: number;
  failed: boolean;
  attachments: LocalAttachment[];
  /** 0–1 while uploading attachments; null once the message itself is in flight. */
  uploadProgress: number | null;
}

export interface ChannelTimeline {
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
  self: User | null;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  /** channelId -> my lastReadSeq (only channels I'm a member of). */
  memberships: Record<ID, number>;
  /** channelId -> my notification settings for it. */
  prefs: Record<ID, ChannelPrefs>;
  /** channelId -> seq of the newest message in it. */
  channelLastSeq: Record<ID, number>;
  presence: Record<ID, Presence>;
  /** channelId -> userId -> typing-expires-at (ms). */
  typing: Record<ID, Record<ID, number>>;
  lastSeq: number;
  timelines: Record<ID, ChannelTimeline>;
  /** threadRootId -> replies oldest → newest. */
  threads: Record<ID, Message[]>;
  pending: PendingMessage[];
  /** Message ids this user saved for later. */
  saved: Record<ID, true>;
  /** channelId -> unsent composer text, restored when you come back. */
  drafts: Record<ID, string>;
  /** channelId -> who is in that channel's huddle right now. */
  huddles: Record<ID, ID[]>;
  /** Private replies per channel, newest last. */
  ephemerals: Record<ID, EphemeralMessage[]>;
  /** Commands that can be typed here; loaded once after connecting. */
  commands: CommandHint[];
  /** The huddle this client is in, if any. */
  huddle: HuddleState | null;
}

const initialState: WorkspaceState = {
  friends: [],
  status: "connecting",
  workspaceName: "",
  self: null,
  users: {},
  channels: {},
  memberships: {},
  prefs: {},
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
  ephemerals: {},
  commands: [],
};

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
  onIncomingMessage: ((msg: Message) => void) | null = null;

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
    this.stopped = false;
    this.openSocket(this.state.lastSeq > 0 ? this.state.lastSeq : null);
    this.typingSweep ??= setInterval(() => this.sweepTyping(), 2000);
  }

  destroy(): void {
    this.stopped = true;
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
        }),
      );
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerToClient;
      this.handleServerMessage(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.leaveHuddle();
      if (this.stopped || this.state.status === "auth_failed") return;
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
      case "event":
        this.applyEvent(msg.envelope);
        break;
      case "ephemeral":
        this.applyEphemeral(msg.event);
        break;
      case "resync":
        // Too far behind — drop local caches and start clean.
        this.store.setState({ ...initialState, status: "connecting" });
        this.ws?.close();
        this.reconnectDelay = 1000;
        this.openSocket(null);
        break;
      case "error":
        if (msg.code === "auth_failed") this.store.setState({ status: "auth_failed" });
        break;
      case "pong":
        break;
    }
  }

  private applyReady(snap: ReadySnapshot): void {
    this.reconnectDelay = 1000;
    const users: Record<ID, User> = {};
    for (const u of snap.users) users[u.id] = u;
    const channels: Record<ID, Channel> = {};
    for (const c of snap.channels) channels[c.id] = c;
    const memberships: Record<ID, number> = {};
    const prefs: Record<ID, ChannelPrefs> = {};
    for (const m of snap.memberships) {
      memberships[m.channelId] = m.lastReadSeq;
      prefs[m.channelId] = m.prefs;
    }
    const saved: Record<ID, true> = {};
    for (const id of snap.savedMessageIds) saved[id] = true;

    this.store.setState((prev) => ({
      status: "online",
      workspaceName: snap.workspaceName,
      self: snap.self,
      users,
      channels,
      memberships,
      prefs,
      channelLastSeq: snap.channelLastSeq,
      presence: snap.presence,
      saved,
      huddles: snap.huddles,
      friends: snap.friends ?? [],
      lastSeq: Math.max(prev.lastSeq, snap.seq),
      // Keep loaded timelines — replayed events patch them incrementally.
      timelines: prev.timelines,
      threads: prev.threads,
      pending: prev.pending,
      drafts: prev.drafts,
      huddle: prev.huddle,
      typing: {},
    }));
  }

  private applyEvent(envelope: EventEnvelope): void {
    const { event, seq } = envelope;
    const s = this.store.getState();
    if (seq <= s.lastSeq && s.lastSeq !== 0) return; // duplicate delivery
    const patch: Partial<WorkspaceState> = { lastSeq: seq };

    switch (event.type) {
      case "message.created": {
        const message = { ...event.message, seq };
        patch.channelLastSeq = { ...s.channelLastSeq, [message.channelId]: seq };
        // The real message replaces our optimistic one — release its previews.
        const settled = s.pending.find((p) => p.nonce === message.nonce);
        if (settled) {
          for (const a of settled.attachments) {
            if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
          }
          this.retryFiles.delete(settled.nonce);
          patch.pending = s.pending.filter((p) => p.nonce !== message.nonce);
        }
        if (message.threadRootId) {
          const replies = s.threads[message.threadRootId];
          if (replies) {
            patch.threads = { ...s.threads, [message.threadRootId]: sortedInsert(replies, message) };
          }
          // Bump replyCount on the root in its timeline.
          const tl = s.timelines[message.channelId];
          if (tl?.loaded) {
            patch.timelines = {
              ...s.timelines,
              [message.channelId]: {
                ...tl,
                items: tl.items.map((m) =>
                  m.id === message.threadRootId ? { ...m, replyCount: m.replyCount + 1 } : m,
                ),
              },
            };
          }
        } else {
          const tl = s.timelines[message.channelId];
          // Appending to an anchored view would fake adjacency across a gap.
          if (tl?.loaded && !tl.hasMoreNewer) {
            patch.timelines = {
              ...s.timelines,
              [message.channelId]: windowTimeline(
                { ...tl, items: sortedInsert(tl.items, message) },
                "oldest",
              ),
            };
          }
        }
        if (message.userId !== s.self?.id) this.onIncomingMessage?.(message);
        // Clear the sender's typing indicator immediately.
        const chTyping = s.typing[message.channelId];
        if (chTyping?.[message.userId]) {
          const { [message.userId]: _gone, ...rest } = chTyping;
          patch.typing = { ...s.typing, [message.channelId]: rest };
        }
        break;
      }
      case "message.updated": {
        patch.timelines = this.patchMessage(s, event.message.channelId, event.message.id, () => ({
          ...event.message,
        }));
        patch.threads = this.patchThreadMessage(s, event.message.id, () => ({ ...event.message }));
        break;
      }
      case "message.deleted": {
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
        const setPinned = (m: Message): Message => ({ ...m, pinned });
        patch.timelines = this.patchMessage(s, event.channelId, event.messageId, setPinned);
        patch.threads = this.patchThreadMessage(s, event.messageId, setPinned);
        break;
      }
      case "channel.created":
      case "channel.updated": {
        patch.channels = { ...s.channels, [event.channel.id]: event.channel };
        if (event.type === "channel.created" && event.channel.memberIds?.includes(s.self?.id ?? "")) {
          patch.memberships = { ...s.memberships, [event.channel.id]: 0 };
        }
        break;
      }
      case "member.joined": {
        if (event.userId === s.self?.id) {
          patch.memberships = { ...s.memberships, [event.channelId]: s.memberships[event.channelId] ?? 0 };
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
        patch.users = { ...s.users, [event.user.id]: event.user };
        if (event.user.id === s.self?.id) patch.self = event.user;
        break;
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
    const s = this.store.getState();
    if (event.type === "presence") {
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
    } else if (event.type === "prefs") {
      this.store.setState({ prefs: { ...s.prefs, [event.channelId]: event.prefs } });
    } else if (event.type === "saved") {
      const saved = { ...s.saved };
      if (event.saved) saved[event.messageId] = true;
      else delete saved[event.messageId];
      this.store.setState({ saved });
    } else if (event.type === "ephemeral.message") {
      this.addEphemeral({
        id: event.id,
        channelId: event.channelId,
        userId: event.userId,
        text: event.text,
        createdAt: event.createdAt,
      });
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

  /** Load the initial page (or older pages) of a channel's timeline. */
  async loadTimeline(channelId: ID, opts: { older?: boolean } = {}): Promise<void> {
    const tl = this.state.timelines[channelId];
    if (tl?.loaded && !opts.older) return;
    if (opts.older && (!tl?.hasMore || tl.items.length === 0)) return;

    const before = opts.older ? tl!.items[0]!.id : undefined;
    const { messages } = await this.api.listMessages(channelId, { before, limit: 50 });
    const page = [...messages].reverse(); // API returns newest-first

    this.store.setState((s) => {
      const existing = s.timelines[channelId];
      const items = opts.older
        ? [...page, ...(existing?.items ?? [])]
        : page.reduce(sortedInsert, existing?.items ?? []);
      return {
        timelines: {
          ...s.timelines,
          [channelId]: windowTimeline(
            {
              items,
              hasMore: messages.length === 50,
              // loadTimeline always lands at the tail.
              hasMoreNewer: opts.older ? (existing?.hasMoreNewer ?? false) : false,
              loaded: true,
            },
            // Paging up drops the far end, which is now hundreds of messages
            // below the viewport, not the history being read.
            opts.older ? "newest" : "oldest",
          ),
        },
      };
    });
  }

  /**
   * Replaces the timeline with a window centred on `messageId`, for jumping to
   * a search hit or a pinned message.
   */
  async jumpToMessage(channelId: ID, messageId: ID): Promise<void> {
    const existing = this.state.timelines[channelId];
    // Already on screen in a tail view — nothing to reload.
    if (existing?.loaded && !existing.hasMoreNewer && existing.items.some((m) => m.id === messageId)) {
      return;
    }
    const { messages, hasMoreOlder, hasMoreNewer } = await this.api.listMessagesAround(
      channelId,
      messageId,
    );
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
  }

  /** Pages forward from an anchored view back toward the newest messages. */
  async loadNewer(channelId: ID): Promise<void> {
    const tl = this.state.timelines[channelId];
    if (!tl?.loaded || !tl.hasMoreNewer || tl.items.length === 0) return;
    const newest = tl.items[tl.items.length - 1]!;
    const { messages } = await this.api.listMessagesAfter(channelId, newest.id, 50);
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
  }

  /** Drops an anchored view and returns to the live tail. */
  async jumpToLatest(channelId: ID): Promise<void> {
    this.store.setState((s) => {
      const { [channelId]: _dropped, ...rest } = s.timelines;
      return { timelines: rest };
    });
    await this.loadTimeline(channelId);
  }

  async loadThread(threadRootId: ID, channelId: ID): Promise<void> {
    const { messages } = await this.api.listMessages(channelId, { threadRootId, limit: 200 });
    this.store.setState((s) => ({
      threads: { ...s.threads, [threadRootId]: [...messages].reverse() },
    }));
  }

  /** Files held for a retry, keyed by nonce — never exposed to the store. */
  private retryFiles = new Map<string, File[]>();

  /**
   * Optimistic send: the message (and local image previews) appear instantly,
   * then attachments upload and the server event reconciles it by nonce.
   */
  send(
    channelId: ID,
    text: string,
    opts: { threadRootId?: ID; files?: File[] } = {},
  ): void {
    const self = this.state.self;
    if (!self) return;
    const files = opts.files ?? [];
    if (!text.trim() && files.length === 0) return;

    // A leading "/word" is a command, not a message. The trailing space or end
    // of line matters: it keeps a pasted path like /Users/me/notes.txt a
    // perfectly ordinary message.
    if (files.length === 0 && /^\/[a-zA-Z0-9_-]+(\s|$)/.test(text.trim())) {
      void this.runCommand(channelId, text.trim(), opts.threadRootId);
      return;
    }

    const nonce = `${self.id}-${Date.now()}-${++this.nonceCounter}`;
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
      text,
      userId: self.id,
      createdAt: Date.now(),
      failed: false,
      attachments,
      uploadProgress: files.length > 0 ? 0 : null,
    };
    this.store.setState((s) => ({ pending: [...s.pending, pendingMsg] }));
    if (files.length > 0) this.retryFiles.set(nonce, files);

    void this.deliver(channelId, text, files, nonce, opts.threadRootId);
  }

  private async deliver(
    channelId: ID,
    text: string,
    files: File[],
    nonce: string,
    threadRootId?: ID,
  ): Promise<void> {
    const setProgress = (fraction: number) =>
      this.store.setState((s) => ({
        pending: s.pending.map((p) =>
          p.nonce === nonce ? { ...p, uploadProgress: fraction } : p,
        ),
      }));

    try {
      const fileIds: ID[] = [];
      for (const [i, file] of files.entries()) {
        const { file: uploaded } = await this.api.uploadFile(channelId, file, file.name, {
          onProgress: (fraction) => setProgress((i + fraction) / files.length),
        });
        fileIds.push(uploaded.id);
      }
      if (files.length > 0) setProgress(1);

      const body: SendMessageBody = {
        text,
        nonce,
        ...(threadRootId ? { threadRootId } : {}),
        ...(fileIds.length > 0 ? { fileIds } : {}),
      };
      await this.api.sendMessage(channelId, body);
      this.retryFiles.delete(nonce);
    } catch {
      this.store.setState((s) => ({
        pending: s.pending.map((p) =>
          p.nonce === nonce ? { ...p, failed: true, uploadProgress: null } : p,
        ),
      }));
    }
  }

  retrySend(nonce: string): void {
    const p = this.state.pending.find((p) => p.nonce === nonce);
    if (!p) return;
    // send() makes fresh preview URLs from the same File objects.
    const files = this.retryFiles.get(nonce) ?? [];
    this.dropPending(nonce);
    this.send(p.channelId, p.text, {
      threadRootId: p.threadRootId ?? undefined,
      files,
    });
  }

  discardSend(nonce: string): void {
    this.dropPending(nonce);
  }

  private dropPending(nonce: string): void {
    const p = this.state.pending.find((x) => x.nonce === nonce);
    if (p) {
      for (const a of p.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    this.retryFiles.delete(nonce);
    this.store.setState((s) => ({ pending: s.pending.filter((x) => x.nonce !== nonce) }));
  }

  /** Optimistic reaction toggle. */
  toggleReaction(message: Message, emoji: string): void {
    const selfId = this.state.self?.id;
    if (!selfId) return;
    const has = message.reactions.some((g) => g.emoji === emoji && g.userIds.includes(selfId));
    void (has
      ? this.api.removeReaction(message.id, emoji)
      : this.api.addReaction(message.id, emoji));
  }

  /** Optimistic pin toggle — the channel-wide event confirms it. */
  togglePin(message: Message): void {
    const next = !message.pinned;
    const apply = (m: Message): Message => ({ ...m, pinned: next });
    this.store.setState((s) => ({
      timelines: this.patchMessage(s, message.channelId, message.id, apply),
      threads: this.patchThreadMessage(s, message.id, apply),
    }));
    void (next ? this.api.pinMessage(message.id) : this.api.unpinMessage(message.id)).catch(() => {
      const revert = (m: Message): Message => ({ ...m, pinned: !next });
      this.store.setState((s) => ({
        timelines: this.patchMessage(s, message.channelId, message.id, revert),
        threads: this.patchThreadMessage(s, message.id, revert),
      }));
    });
  }

  /** Optimistic save-for-later toggle; other devices get the ephemeral echo. */
  toggleSaved(messageId: ID): void {
    const isSaved = !!this.state.saved[messageId];
    this.store.setState((s) => {
      const saved = { ...s.saved };
      if (isSaved) delete saved[messageId];
      else saved[messageId] = true;
      return { saved };
    });
    void (isSaved ? this.api.unsaveMessage(messageId) : this.api.saveMessage(messageId)).catch(
      () => {
        this.store.setState((s) => {
          const saved = { ...s.saved };
          if (isSaved) saved[messageId] = true;
          else delete saved[messageId];
          return { saved };
        });
      },
    );
  }

  /** Optimistic notification-preference change for one channel. */
  setChannelPrefs(channelId: ID, patch: Partial<ChannelPrefs>): void {
    const before = this.state.prefs[channelId] ?? { notifyLevel: "mentions", muted: false };
    const next = { ...before, ...patch };
    this.store.setState((s) => ({ prefs: { ...s.prefs, [channelId]: next } }));
    void this.api.setChannelPrefs(channelId, patch).catch(() => {
      this.store.setState((s) => ({ prefs: { ...s.prefs, [channelId]: before } }));
    });
  }

  /** Snooze notifications for `minutes`, or pass null to clear Do Not Disturb. */
  snoozeNotifications(minutes: number | null): void {
    const dndUntil = minutes === null ? null : Date.now() + minutes * 60_000;
    const self = this.state.self;
    if (self) this.store.setState({ self: { ...self, dndUntil } });
    void this.api.updateMe({ dndUntil }).catch(() => {
      if (self) this.store.setState({ self });
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

    const session = new HuddleSession(channelId, selfId, {
      send: (msg) => this.sendSocket(msg),
    }, config);
    this.session = session;
    try {
      await session.startLocalAudio();
    } catch (err) {
      session.destroy();
      if (this.session === session) this.session = null;
      throw err;
    }
    if (attempt !== this.huddleAttempt) { session.destroy(); return; }
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

  markRead(channelId: ID): void {
    const seq = this.state.channelLastSeq[channelId] ?? 0;
    const current = this.state.memberships[channelId] ?? 0;
    if (seq <= current) return;
    this.store.setState((s) => ({ memberships: { ...s.memberships, [channelId]: seq } }));
    void this.api.markRead(channelId, seq).catch(() => {});
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
