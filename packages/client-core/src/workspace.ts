import { createStore, type StoreApi } from "zustand/vanilla";
import {
  PROTOCOL_VERSION,
  type Channel,
  type EphemeralEvent,
  type EventEnvelope,
  type ID,
  type Message,
  type Presence,
  type ReadySnapshot,
  type SendMessageBody,
  type ServerToClient,
  type User,
} from "@slackoss/protocol";
import { Api } from "./api.js";
import { FileCache } from "./fileCache.js";

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
  hasMore: boolean;
  loaded: boolean;
}

export interface WorkspaceState {
  status: ConnectionStatus;
  workspaceName: string;
  self: User | null;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  /** channelId -> my lastReadSeq (only channels I'm a member of). */
  memberships: Record<ID, number>;
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
}

const initialState: WorkspaceState = {
  status: "connecting",
  workspaceName: "",
  self: null,
  users: {},
  channels: {},
  memberships: {},
  channelLastSeq: {},
  presence: {},
  typing: {},
  lastSeq: 0,
  timelines: {},
  threads: {},
  pending: [],
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
    for (const m of snap.memberships) memberships[m.channelId] = m.lastReadSeq;

    this.store.setState((prev) => ({
      status: "online",
      workspaceName: snap.workspaceName,
      self: snap.self,
      users,
      channels,
      memberships,
      channelLastSeq: snap.channelLastSeq,
      presence: snap.presence,
      lastSeq: Math.max(prev.lastSeq, snap.seq),
      // Keep loaded timelines — replayed events patch them incrementally.
      timelines: prev.timelines,
      threads: prev.threads,
      pending: prev.pending,
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
          if (tl?.loaded) {
            patch.timelines = {
              ...s.timelines,
              [message.channelId]: { ...tl, items: sortedInsert(tl.items, message) },
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
    const s = this.store.getState();
    if (event.type === "presence") {
      this.store.setState({ presence: { ...s.presence, [event.userId]: event.presence } });
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
          [channelId]: { items, hasMore: messages.length === 50, loaded: true },
        },
      };
    });
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

  markRead(channelId: ID): void {
    const seq = this.state.channelLastSeq[channelId] ?? 0;
    const current = this.state.memberships[channelId] ?? 0;
    if (seq <= current) return;
    this.store.setState((s) => ({ memberships: { ...s.memberships, [channelId]: seq } }));
    void this.api.markRead(channelId, seq).catch(() => {});
  }

  sendTyping(channelId: ID): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "typing", channelId }));
    }
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
