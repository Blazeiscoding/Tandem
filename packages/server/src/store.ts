import type { DatabaseSync } from "node:sqlite";
import type {
  App,
  Channel,
  ChannelPrefs,
  ChannelType,
  FileMeta,
  Friendship,
  ID,
  Invite,
  Message,
  MessageAction,
  ReactionGroup,
  NotifyLevel,
  ParsedSearch,
  Role,
  ScheduledMessage,
  SessionInfo,
  User,
  EventSubscription,
  SlashCommand,
  Webhook,
  WorkspaceEvent,
  EventEnvelope,
} from "@slackoss/protocol";
import { ulid, inviteCode } from "./ids.js";

interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  password_hash: string;
  salt: string;
  role: string;
  status_text: string;
  status_emoji: string;
  is_bot: number;
  deactivated: number;
  dnd_until: number | null;
  created_at: number;
}

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  topic: string;
  description: string;
  creator_id: string;
  archived: number;
  dm_key: string | null;
  last_msg_seq: number;
  created_at: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  text: string;
  thread_root_id: string | null;
  nonce: string | null;
  seq: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  actions: string;
}

/**
 * Buttons come back out of one JSON column. A row written by a future version,
 * or corrupted somehow, costs its buttons rather than the whole message.
 */
function parseActions(raw: string | null): MessageAction[] {
  if (!raw || raw === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageAction[]) : [];
  } catch {
    return [];
  }
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    role: r.role as Role,
    statusText: r.status_text,
    statusEmoji: r.status_emoji,
    isBot: r.is_bot === 1,
    deactivated: r.deactivated === 1,
    dndUntil: r.dnd_until,
    createdAt: r.created_at,
  };
}

/** How long a session survives without being used. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export class Store {
  constructor(private db: DatabaseSync) {}

  /** Only synchronous database work belongs here; publish events after this returns. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  messageRequest(userId: ID, nonce: string): { messageId: ID; requestHash: string | null } | null {
    return (
      (this.db
        .prepare(
          "SELECT message_id AS messageId, request_hash AS requestHash FROM message_requests WHERE user_id = ? AND nonce = ?",
        )
        .get(userId, nonce) as { messageId: ID; requestHash: string | null } | undefined) ?? null
    );
  }

  recordMessageRequest(userId: ID, nonce: string, messageId: ID, requestHash: string): void {
    this.db
      .prepare(
        "INSERT INTO message_requests (user_id, nonce, message_id, request_hash) VALUES (?, ?, ?, ?)",
      )
      .run(userId, nonce, messageId, requestHash);
  }

  listFriends(userId: ID): Friendship[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM friendships WHERE user_low = ? OR user_high = ? ORDER BY created_at DESC`,
      )
      .all(userId, userId) as unknown as {
      user_low: string;
      user_high: string;
      requested_by: string;
      accepted: number;
      created_at: number;
    }[];
    return rows.map((r) => ({
      userId: r.user_low === userId ? r.user_high : r.user_low,
      status: r.accepted ? "accepted" : r.requested_by === userId ? "outgoing" : "incoming",
      createdAt: r.created_at,
    }));
  }

  requestFriend(userId: ID, otherId: ID): void {
    const [low, high] = [userId, otherId].sort();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO friendships (user_low, user_high, requested_by, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(low!, high!, userId, Date.now());
  }

  acceptFriend(userId: ID, otherId: ID): boolean {
    const [low, high] = [userId, otherId].sort();
    return (
      this.db
        .prepare(
          `UPDATE friendships SET accepted = 1 WHERE user_low = ? AND user_high = ? AND requested_by = ?`,
        )
        .run(low!, high!, otherId).changes > 0
    );
  }

  removeFriend(userId: ID, otherId: ID): void {
    const [low, high] = [userId, otherId].sort();
    this.db
      .prepare(`DELETE FROM friendships WHERE user_low = ? AND user_high = ?`)
      .run(low!, high!);
  }

  // ---------- meta ----------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // ---------- users ----------

  userCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) c FROM users WHERE is_bot = 0").get() as {
      c: number;
    };
    return r.c;
  }

  createUser(input: {
    handle: string;
    displayName: string;
    passwordHash: string;
    salt: string;
    role: Role;
  }): User {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, handle, display_name, password_hash, salt, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.handle, input.displayName, input.passwordHash, input.salt, input.role, now);
    return this.getUser(id)!;
  }

  getUser(id: ID): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  getUserAuthByHandle(handle: string): (User & { passwordHash: string; salt: string }) | null {
    const r = this.db.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as
      UserRow | undefined;
    if (!r) return null;
    return { ...toUser(r), passwordHash: r.password_hash, salt: r.salt };
  }

  listUsers(): User[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY handle")
      .all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  updateUser(
    id: ID,
    patch: {
      displayName?: string;
      statusText?: string;
      statusEmoji?: string;
      dndUntil?: number | null;
      role?: Role;
      deactivated?: boolean;
    },
  ): User {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(patch.displayName);
    }
    if (patch.statusText !== undefined) {
      sets.push("status_text = ?");
      params.push(patch.statusText);
    }
    if (patch.statusEmoji !== undefined) {
      sets.push("status_emoji = ?");
      params.push(patch.statusEmoji);
    }
    if (patch.dndUntil !== undefined) {
      sets.push("dnd_until = ?");
      params.push(patch.dndUntil);
    }
    if (patch.role !== undefined) {
      sets.push("role = ?");
      params.push(patch.role);
    }
    if (patch.deactivated !== undefined) {
      sets.push("deactivated = ?");
      params.push(patch.deactivated ? 1 : 0);
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
        .run(...(params as (string | number | null)[]), id);
    }
    return this.getUser(id)!;
  }

  // ---------- sessions ----------

  createSession(tokenHash: string, userId: ID, userAgent = "", ttlMs = SESSION_TTL_MS): ID {
    const now = Date.now();
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, id, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, now, now, id, userAgent.slice(0, 200), now + ttlMs);
    return id;
  }

  /**
   * The account behind a token, if the session is still alive.
   *
   * Expiry slides forward on every use: a session in daily use never asks its
   * owner to sign in again, while one abandoned on a borrowed machine stops
   * working on its own.
   */
  getSessionUser(tokenHash: string, ttlMs = SESSION_TTL_MS): User | null {
    const now = Date.now();
    const r = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND u.deactivated = 0 AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as UserRow | undefined;
    if (!r) return null;
    this.db
      .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
      .run(now, now + ttlMs, tokenHash);
    return toUser(r);
  }

  /** One person's signed-in devices, newest first. */
  listSessions(userId: ID): Omit<SessionInfo, "current">[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions
         WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
      )
      .all(userId, Date.now()) as unknown as {
      id: string;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
      user_agent: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      userAgent: r.user_agent,
    }));
  }

  /**
   * Ends sessions and reports which tokens they were, so their live sockets can
   * be closed too. A revoked session that keeps receiving messages is not revoked.
   */
  revokeSessions(userId: ID, opts: { id?: ID; exceptTokenHash?: string } = {}): string[] {
    const where = ["user_id = ?"];
    const params: string[] = [userId];
    if (opts.id !== undefined) {
      where.push("id = ?");
      params.push(opts.id);
    }
    if (opts.exceptTokenHash !== undefined) {
      where.push("token_hash != ?");
      params.push(opts.exceptTokenHash);
    }
    const clause = where.join(" AND ");
    const rows = this.db
      .prepare(`SELECT token_hash FROM sessions WHERE ${clause}`)
      .all(...params) as unknown as { token_hash: string }[];
    this.db.prepare(`DELETE FROM sessions WHERE ${clause}`).run(...params);
    return rows.map((r) => r.token_hash);
  }

  /** The listable id of the session behind a token, so it can mark itself. */
  sessionIdFor(tokenHash: string): ID | null {
    const r = this.db.prepare("SELECT id FROM sessions WHERE token_hash = ?").get(tokenHash) as
      { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Drops sessions nobody can use any more. */
  pruneSessions(now = Date.now()): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Checks a live socket without extending a session merely for receiving traffic. */
  isSessionActive(tokenHash: string, userId: ID): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND u.deactivated = 0`,
        )
        .get(tokenHash, userId, Date.now()) !== undefined
    );
  }

  /**
   * Signs someone out everywhere. Deactivating an account has to do this:
   * a token already in someone's hands keeps working otherwise, which is
   * exactly the case deactivation exists for.
   */
  deleteSessionsFor(userId: ID): number {
    return this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes as number;
  }

  /** Replaces someone's password. Their sessions are the caller's to revoke. */
  setPassword(userId: ID, passwordHash: string, salt: string): void {
    this.db
      .prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
      .run(passwordHash, salt, userId);
  }

  /** When each account was last seen, for the admin list. */
  lastSeenByUser(): Record<ID, number> {
    const rows = this.db
      .prepare("SELECT user_id, MAX(last_seen_at) AS seen FROM sessions GROUP BY user_id")
      .all() as unknown as { user_id: string; seen: number }[];
    return Object.fromEntries(rows.map((r) => [r.user_id, r.seen]));
  }

  // ---------- channels ----------

  private toChannel(r: ChannelRow): Channel {
    const ch: Channel = {
      id: r.id,
      type: r.type as ChannelType,
      name: r.name,
      topic: r.topic,
      description: r.description,
      creatorId: r.creator_id,
      archived: r.archived === 1,
      createdAt: r.created_at,
    };
    if (ch.type === "dm" || ch.type === "group_dm") {
      ch.memberIds = this.memberIds(r.id);
    }
    return ch;
  }

  createChannel(input: {
    type: ChannelType;
    name?: string;
    topic?: string;
    description?: string;
    creatorId: ID;
    memberIds: ID[]; // including creator
    dmKey?: string;
  }): Channel {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channels (id, type, name, topic, description, creator_id, dm_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.name ?? "",
        input.topic ?? "",
        input.description ?? "",
        input.creatorId,
        input.dmKey ?? null,
        now,
      );
    const level: NotifyLevel =
      input.type === "dm" || input.type === "group_dm" ? "all" : "mentions";
    for (const uid of input.memberIds) this.addMember(id, uid, level);
    return this.getChannel(id)!;
  }

  getChannel(id: ID): Channel | null {
    const r = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
      ChannelRow | undefined;
    return r ? this.toChannel(r) : null;
  }

  getChannelByName(name: string): Channel | null {
    const r = this.db
      .prepare("SELECT * FROM channels WHERE name = ? AND type IN ('public','private')")
      .get(name) as ChannelRow | undefined;
    return r ? this.toChannel(r) : null;
  }

  findDmByKey(dmKey: string): Channel | null {
    const r = this.db.prepare("SELECT * FROM channels WHERE dm_key = ?").get(dmKey) as
      ChannelRow | undefined;
    return r ? this.toChannel(r) : null;
  }

  updateChannel(
    id: ID,
    patch: { name?: string; topic?: string; description?: string; archived?: boolean },
  ): Channel {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.topic !== undefined) {
      sets.push("topic = ?");
      params.push(patch.topic);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.archived !== undefined) {
      sets.push("archived = ?");
      params.push(patch.archived ? 1 : 0);
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`)
        .run(...(params as string[]), id);
    }
    return this.getChannel(id)!;
  }

  /** Public channels + non-public channels the user belongs to. */
  listChannelsVisibleTo(userId: ID): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.* FROM channels c
         LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
         WHERE c.type = 'public' OR m.user_id IS NOT NULL
         ORDER BY c.name`,
      )
      .all(userId) as unknown as ChannelRow[];
    return rows.map((r) => this.toChannel(r));
  }

  listPublicChannelIds(): ID[] {
    const rows = this.db.prepare("SELECT id FROM channels WHERE type = 'public'").all() as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  // ---------- membership ----------

  addMember(channelId: ID, userId: ID, notifyLevel: NotifyLevel = "mentions"): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, notify_level)
         VALUES (?, ?, ?, ?)`,
      )
      .run(channelId, userId, Date.now(), notifyLevel);
    return res.changes > 0;
  }

  removeMember(channelId: ID, userId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .run(channelId, userId);
    return res.changes > 0;
  }

  isMember(channelId: ID, userId: ID): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .get(channelId, userId);
  }

  memberIds(channelId: ID): ID[] {
    const rows = this.db
      .prepare("SELECT user_id FROM channel_members WHERE channel_id = ?")
      .all(channelId) as { user_id: string }[];
    return rows.map((r) => r.user_id);
  }

  memberships(userId: ID): { channelId: ID; lastReadSeq: number; prefs: ChannelPrefs }[] {
    const rows = this.db
      .prepare(
        `SELECT channel_id, last_read_seq, notify_level, muted
         FROM channel_members WHERE user_id = ?`,
      )
      .all(userId) as {
      channel_id: string;
      last_read_seq: number;
      notify_level: string;
      muted: number;
    }[];
    return rows.map((r) => ({
      channelId: r.channel_id,
      lastReadSeq: r.last_read_seq,
      prefs: { notifyLevel: r.notify_level as NotifyLevel, muted: r.muted === 1 },
    }));
  }

  getChannelPrefs(channelId: ID, userId: ID): ChannelPrefs | null {
    const r = this.db
      .prepare(
        "SELECT notify_level, muted FROM channel_members WHERE channel_id = ? AND user_id = ?",
      )
      .get(channelId, userId) as { notify_level: string; muted: number } | undefined;
    if (!r) return null;
    return { notifyLevel: r.notify_level as NotifyLevel, muted: r.muted === 1 };
  }

  setChannelPrefs(
    channelId: ID,
    userId: ID,
    patch: { notifyLevel?: NotifyLevel; muted?: boolean },
  ): ChannelPrefs | null {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.notifyLevel !== undefined) {
      sets.push("notify_level = ?");
      params.push(patch.notifyLevel);
    }
    if (patch.muted !== undefined) {
      sets.push("muted = ?");
      params.push(patch.muted ? 1 : 0);
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE channel_members SET ${sets.join(", ")} WHERE channel_id = ? AND user_id = ?`,
        )
        .run(...params, channelId, userId);
    }
    return this.getChannelPrefs(channelId, userId);
  }

  markRead(channelId: ID, userId: ID, seq: number): number {
    const row = this.db
      .prepare(
        "UPDATE channel_members SET last_read_seq = MAX(last_read_seq, ?) WHERE channel_id = ? AND user_id = ? RETURNING last_read_seq",
      )
      .get(Math.min(seq, this.currentSeq()), channelId, userId) as
      { last_read_seq: number } | undefined;
    return row?.last_read_seq ?? 0;
  }

  lastMessageSeq(channelId: ID): number {
    const row = this.db.prepare("SELECT last_msg_seq FROM channels WHERE id = ?").get(channelId) as
      { last_msg_seq: number } | undefined;
    return row?.last_msg_seq ?? 0;
  }

  /** channelId -> last message seq, for every channel the user can see. */
  channelLastSeqMap(userId: ID): Record<ID, number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.id, c.last_msg_seq FROM channels c
         LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
         WHERE c.type = 'public' OR m.user_id IS NOT NULL`,
      )
      .all(userId) as { id: string; last_msg_seq: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = r.last_msg_seq;
    return out;
  }

  /** True if the user may read the channel (public, or member of non-public). */
  canAccess(channelId: ID, userId: ID): boolean {
    const r = this.db.prepare("SELECT type FROM channels WHERE id = ?").get(channelId) as
      { type: string } | undefined;
    if (!r) return false;
    if (r.type === "public") return true;
    return this.isMember(channelId, userId);
  }

  // ---------- messages ----------

  createMessage(input: {
    channelId: ID;
    userId: ID;
    text: string;
    threadRootId: ID | null;
    nonce: string | null;
    actions?: MessageAction[];
  }): Message {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, nonce, created_at, actions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.text,
        input.threadRootId,
        input.nonce,
        Date.now(),
        JSON.stringify(input.actions ?? []),
      );
    return this.getMessage(id)!;
  }

  /** Drops a message's buttons, for an app that has answered and moved on. */
  clearMessageActions(id: ID): void {
    this.db.prepare("UPDATE messages SET actions = '[]' WHERE id = ?").run(id);
  }

  /** Called after the event log assigns a seq to message.created. */
  stampMessageSeq(messageId: ID, channelId: ID, seq: number): void {
    this.db.prepare("UPDATE messages SET seq = ? WHERE id = ?").run(seq, messageId);
    this.db
      .prepare("UPDATE channels SET last_msg_seq = MAX(last_msg_seq, ?) WHERE id = ?")
      .run(seq, channelId);
  }

  getMessage(id: ID): Message | null {
    const r = this.db
      .prepare("SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL")
      .get(id) as MessageRow | undefined;
    if (!r) return null;
    return this.hydrateMessages([r])[0]!;
  }

  editMessage(id: ID, text: string): Message {
    this.db
      .prepare("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?")
      .run(text, Date.now(), id);
    return this.getMessage(id)!;
  }

  deleteMessage(id: ID): void {
    // Soft-delete, and blank the text so it drops out of the FTS index.
    this.db
      .prepare("UPDATE messages SET deleted_at = ?, text = '' WHERE id = ?")
      .run(Date.now(), id);
    this.db.prepare("DELETE FROM reactions WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM pins WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM saved_items WHERE message_id = ?").run(id);
  }

  /** Newest-first page of top-level channel messages (or thread replies). */
  listMessages(opts: { channelId: ID; before?: ID; limit: number; threadRootId?: ID }): Message[] {
    let rows: MessageRow[];
    if (opts.threadRootId) {
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL ${opts.before ? "AND id < ?" : ""}
           ORDER BY id DESC LIMIT ?`,
        )
        .all(
          ...([opts.channelId, opts.threadRootId, opts.before, opts.limit].filter(
            (x) => x !== undefined,
          ) as (string | number)[]),
        ) as unknown as MessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL ${opts.before ? "AND id < ?" : ""}
           ORDER BY id DESC LIMIT ?`,
        )
        .all(
          ...([opts.channelId, opts.before, opts.limit].filter((x) => x !== undefined) as (
            string | number
          )[]),
        ) as unknown as MessageRow[];
    }
    return this.hydrateMessages(rows);
  }

  /** Thread pages are oldest-first and contain only direct replies to this root. */
  threadHistory(
    channelId: ID,
    rootId: ID,
    opts: { before?: ID; after?: ID; around?: ID; limit: number },
  ): { messages: Message[]; hasMoreOlder: boolean; hasMoreNewer: boolean } {
    if (opts.around) {
      const olderLimit = Math.floor((opts.limit - 1) / 2);
      const older = this.threadHistory(channelId, rootId, {
        before: opts.around,
        limit: olderLimit,
      });
      const newer = this.threadHistory(channelId, rootId, {
        after: opts.around,
        limit: opts.limit - 1 - olderLimit,
      });
      const target = this.getMessage(opts.around);
      return {
        messages: [
          ...older.messages,
          ...(target?.channelId === channelId && target.threadRootId === rootId ? [target] : []),
          ...newer.messages,
        ],
        hasMoreOlder: older.hasMoreOlder,
        hasMoreNewer: newer.hasMoreNewer,
      };
    }
    const cursor = opts.before ?? opts.after;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL
       ${cursor ? `AND id ${opts.after ? ">" : "<"} ?` : ""}
       ORDER BY id ${opts.after ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(channelId, rootId, ...(cursor ? [cursor] : []), opts.limit) as unknown as MessageRow[];
    if (!opts.after) rows.reverse();
    const first = rows[0]?.id ?? cursor;
    const last = rows.at(-1)?.id ?? cursor;
    const exists = (direction: "<" | ">", id?: ID) =>
      !!id &&
      this.db
        .prepare(
          `SELECT 1 FROM messages WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL AND id ${direction} ? LIMIT 1`,
        )
        .get(channelId, rootId, id) !== undefined;
    return {
      messages: this.hydrateMessages(rows),
      hasMoreOlder: exists("<", first),
      hasMoreNewer: exists(">", last),
    };
  }

  /**
   * A window of messages centred on one message, for jumping to a search hit
   * or a pinned message. Returns newest-first like listMessages, plus whether
   * more exist on either side so the client knows it is not at the tail.
   */
  listMessagesAround(
    channelId: ID,
    messageId: ID,
    limit: number,
  ): { messages: Message[]; hasMoreOlder: boolean; hasMoreNewer: boolean } {
    const half = Math.max(1, Math.floor(limit / 2));

    // Ask for one extra on each side purely to detect whether more exist.
    const olderRows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(channelId, messageId, half + 1) as unknown as MessageRow[];
    const newerRows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(channelId, messageId, half + 1) as unknown as MessageRow[];
    const targetRow = this.db
      .prepare(
        "SELECT * FROM messages WHERE id = ? AND channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL",
      )
      .get(messageId, channelId) as MessageRow | undefined;

    const hasMoreOlder = olderRows.length > half;
    const hasMoreNewer = newerRows.length > half;
    const older = olderRows.slice(0, half);
    const newer = newerRows.slice(0, half).reverse(); // newest-first

    const rows = [...newer, ...(targetRow ? [targetRow] : []), ...older];
    return { messages: this.hydrateMessages(rows), hasMoreOlder, hasMoreNewer };
  }

  /** Page forward from a message, for scrolling back down toward the tail. */
  listMessagesAfter(channelId: ID, afterId: ID, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(channelId, afterId, limit) as unknown as MessageRow[];
    // Callers expect newest-first.
    return this.hydrateMessages(rows.reverse());
  }

  private hydrateMessages(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");

    const reactionRows = this.db
      .prepare(
        `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`,
      )
      .all(...ids) as { message_id: string; emoji: string; user_id: string }[];
    const reactionsByMsg = new Map<string, ReactionGroup[]>();
    for (const rr of reactionRows) {
      let groups = reactionsByMsg.get(rr.message_id);
      if (!groups) reactionsByMsg.set(rr.message_id, (groups = []));
      let g = groups.find((g) => g.emoji === rr.emoji);
      if (!g) groups.push((g = { emoji: rr.emoji, userIds: [] }));
      g.userIds.push(rr.user_id);
    }

    const replyRows = this.db
      .prepare(
        `SELECT thread_root_id, COUNT(*) c FROM messages
         WHERE thread_root_id IN (${ph}) AND deleted_at IS NULL GROUP BY thread_root_id`,
      )
      .all(...ids) as { thread_root_id: string; c: number }[];
    const replyCounts = new Map(replyRows.map((r) => [r.thread_root_id, r.c]));

    const pinRows = this.db
      .prepare(`SELECT message_id FROM pins WHERE message_id IN (${ph})`)
      .all(...ids) as { message_id: string }[];
    const pinned = new Set(pinRows.map((r) => r.message_id));

    const fileRows = this.db
      .prepare(
        `SELECT id, message_id, name, mime, size, width, height FROM files
         WHERE message_id IN (${ph}) ORDER BY created_at`,
      )
      .all(...ids) as unknown as (FileMeta & { message_id: string })[];
    const filesByMsg = new Map<string, FileMeta[]>();
    for (const f of fileRows) {
      const { message_id, ...meta } = f;
      const list = filesByMsg.get(message_id);
      if (list) list.push(meta);
      else filesByMsg.set(message_id, [meta]);
    }

    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      text: r.text,
      threadRootId: r.thread_root_id,
      seq: r.seq,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      nonce: r.nonce,
      replyCount: replyCounts.get(r.id) ?? 0,
      reactions: reactionsByMsg.get(r.id) ?? [],
      files: filesByMsg.get(r.id) ?? [],
      pinned: pinned.has(r.id),
      actions: parseActions(r.actions),
    }));
  }

  // ---------- files ----------

  createFile(input: {
    id?: ID;
    channelId: ID;
    userId: ID;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
  }): FileMeta {
    const id = input.id ?? ulid();
    this.db
      .prepare(
        `INSERT INTO files (id, channel_id, user_id, name, mime, size, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.name,
        input.mime,
        input.size,
        input.width,
        input.height,
        Date.now(),
      );
    return {
      id,
      name: input.name,
      mime: input.mime,
      size: input.size,
      width: input.width,
      height: input.height,
    };
  }

  getFile(id: ID): (FileMeta & { channelId: ID; userId: ID }) | null {
    const r = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
      | {
          id: string;
          channel_id: string;
          user_id: string;
          name: string;
          mime: string;
          size: number;
          width: number | null;
          height: number | null;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      width: r.width,
      height: r.height,
    };
  }

  /** Binds uploads to their message. Only the uploader's own unattached files in this channel. */
  attachFiles(fileIds: ID[], messageId: ID, channelId: ID, userId: ID): boolean {
    const stmt = this.db.prepare(
      `UPDATE files SET message_id = ?
       WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL`,
    );
    for (const fileId of fileIds) {
      if (stmt.run(messageId, fileId, userId, channelId).changes !== 1) return false;
    }
    return true;
  }

  /** File ids belonging to a message — used to delete blobs when the message goes. */
  fileIdsForMessage(messageId: ID): ID[] {
    const rows = this.db.prepare("SELECT id FROM files WHERE message_id = ?").all(messageId) as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  deleteFiles(fileIds: ID[]): void {
    const stmt = this.db.prepare("DELETE FROM files WHERE id = ?");
    for (const id of fileIds) stmt.run(id);
  }

  queueFileDeletions(fileIds: ID[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO pending_file_deletions (file_id) VALUES (?)",
    );
    for (const id of fileIds) stmt.run(id);
  }

  pendingFileDeletions(): ID[] {
    return (
      this.db.prepare("SELECT file_id FROM pending_file_deletions LIMIT 100").all() as unknown as {
        file_id: string;
      }[]
    ).map((row) => row.file_id);
  }

  completeFileDeletion(fileId: ID): void {
    this.db.prepare("DELETE FROM pending_file_deletions WHERE file_id = ?").run(fileId);
  }

  // ---------- reactions ----------

  addReaction(messageId: ID, userId: ID, emoji: string): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(messageId, userId, emoji, Date.now());
    return res.changes > 0;
  }

  removeReaction(messageId: ID, userId: ID, emoji: string): boolean {
    const res = this.db
      .prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
      .run(messageId, userId, emoji);
    return res.changes > 0;
  }

  // ---------- pins & saved items ----------

  addPin(channelId: ID, messageId: ID, userId: ID): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO pins (channel_id, message_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(channelId, messageId, userId, Date.now());
    return res.changes > 0;
  }

  removePin(messageId: ID): boolean {
    const res = this.db.prepare("DELETE FROM pins WHERE message_id = ?").run(messageId);
    return res.changes > 0;
  }

  /** Pinned messages in a channel, newest pin first. */
  listPins(channelId: ID): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM pins p JOIN messages m ON m.id = p.message_id
         WHERE p.channel_id = ? AND m.deleted_at IS NULL
         ORDER BY p.created_at DESC`,
      )
      .all(channelId) as unknown as MessageRow[];
    return this.hydrateMessages(rows);
  }

  addSaved(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO saved_items (user_id, message_id, created_at) VALUES (?, ?, ?)",
      )
      .run(userId, messageId, Date.now());
    return res.changes > 0;
  }

  removeSaved(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM saved_items WHERE user_id = ? AND message_id = ?")
      .run(userId, messageId);
    return res.changes > 0;
  }

  savedMessageIds(userId: ID): ID[] {
    const rows = this.db
      .prepare(
        `SELECT s.message_id FROM saved_items s JOIN messages m ON m.id = s.message_id
         WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC`,
      )
      .all(userId) as { message_id: string }[];
    return rows.map((r) => r.message_id);
  }

  /** Saved messages the user can still reach, newest save first. */
  listSaved(userId: ID): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM saved_items s
         JOIN messages m ON m.id = s.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE s.user_id = ? AND m.deleted_at IS NULL AND (
           c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
         )
         ORDER BY s.created_at DESC`,
      )
      .all(userId, userId) as unknown as MessageRow[];
    return this.hydrateMessages(rows);
  }

  // ---------- scheduled messages ----------

  scheduleMessage(input: {
    channelId: ID;
    userId: ID;
    text: string;
    threadRootId: ID | null;
    fileIds: ID[];
    sendAt: number;
  }): ScheduledMessage {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO scheduled_messages
           (id, channel_id, user_id, text, thread_root_id, file_ids, send_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.text,
        input.threadRootId,
        JSON.stringify(input.fileIds),
        input.sendAt,
        now,
      );
    return this.getScheduled(id)!;
  }

  private toScheduled(r: {
    id: string;
    channel_id: string;
    user_id: string;
    text: string;
    thread_root_id: string | null;
    file_ids: string;
    send_at: number;
    created_at: number;
    status: string;
    failure_reason: string | null;
    attempts: number;
    message_id: string | null;
  }): ScheduledMessage {
    let fileIds: ID[] = [];
    try {
      fileIds = JSON.parse(r.file_ids) as ID[];
    } catch {
      /* a corrupt row should not sink the whole list */
    }
    return {
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      text: r.text,
      threadRootId: r.thread_root_id,
      fileIds,
      sendAt: r.send_at,
      createdAt: r.created_at,
      status: r.status as ScheduledMessage["status"],
      failureReason: r.failure_reason,
      attempts: r.attempts,
      messageId: r.message_id,
    };
  }

  getScheduled(id: ID): ScheduledMessage | null {
    const r = this.db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(id) as
      Parameters<Store["toScheduled"]>[0] | undefined;
    return r ? this.toScheduled(r) : null;
  }

  /** One user's outstanding messages, soonest first. Delivered ones are done. */
  listScheduled(userId: ID): ScheduledMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM scheduled_messages WHERE user_id = ? AND status != 'sent' ORDER BY send_at",
      )
      .all(userId) as unknown as Parameters<Store["toScheduled"]>[0][];
    return rows.map((r) => this.toScheduled(r));
  }

  /**
   * Messages now due, across all users. Held ones come back every flush so a
   * reversible obstacle — an archived channel, lost membership, a deactivated
   * author — sends the message once it clears. The caller re-checks those
   * conditions: the queue lives on the server, so without that check a message
   * could post itself in the name of someone whose access was taken away
   * yesterday.
   */
  dueScheduled(now = Date.now()): ScheduledMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_messages
         WHERE send_at <= ? AND status IN ('queued', 'held')
         ORDER BY send_at`,
      )
      .all(now) as unknown as Parameters<Store["toScheduled"]>[0][];
    return rows.map((r) => this.toScheduled(r));
  }

  /** Delivery, written inside the posting transaction so neither can happen alone. */
  markScheduledSent(id: ID, messageId: ID): void {
    this.db
      .prepare(
        "UPDATE scheduled_messages SET status = 'sent', message_id = ?, failure_reason = NULL WHERE id = ?",
      )
      .run(messageId, id);
  }

  /** A reason that may clear on its own. The next flush tries again. */
  holdScheduled(id: ID, reason: string): void {
    this.db
      .prepare("UPDATE scheduled_messages SET status = 'held', failure_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  /** Terminal. Only an explicit reschedule puts it back in the queue. */
  failScheduled(id: ID, reason: string): void {
    this.db
      .prepare("UPDATE scheduled_messages SET status = 'failed', failure_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  /** Counts one delivery attempt and returns the new total, so retries stay bounded. */
  countScheduledAttempt(id: ID): number {
    this.db.prepare("UPDATE scheduled_messages SET attempts = attempts + 1 WHERE id = ?").run(id);
    return (
      (
        this.db.prepare("SELECT attempts FROM scheduled_messages WHERE id = ?").get(id) as
          { attempts: number } | undefined
      )?.attempts ?? 0
    );
  }

  /** Puts a held or failed message back in the queue at a new time. */
  rescheduleMessage(id: ID, sendAt: number): void {
    this.db
      .prepare(
        `UPDATE scheduled_messages
         SET send_at = ?, status = 'queued', failure_reason = NULL, attempts = 0
         WHERE id = ? AND status != 'sent'`,
      )
      .run(sendAt, id);
  }

  /** Delivered rows are kept as proof of completion, then aged out. */
  pruneScheduled(before: number): void {
    this.db
      .prepare("DELETE FROM scheduled_messages WHERE status = 'sent' AND send_at < ?")
      .run(before);
  }

  /** True when every id is one of this user's own unattached uploads in this channel. */
  unattachedFiles(fileIds: ID[], channelId: ID, userId: ID): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM files WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL",
    );
    return fileIds.every((id) => stmt.get(id, userId, channelId) !== undefined);
  }

  deleteScheduled(id: ID): boolean {
    const res = this.db.prepare("DELETE FROM scheduled_messages WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // ---------- apps, tokens and webhooks ----------

  /** Creates the bot user that an app posts as. */
  createBotUser(handle: string, displayName: string, passwordHash: string, salt: string): User {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO users (id, handle, display_name, password_hash, salt, role, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, 'member', 1, ?)`,
      )
      .run(id, handle, displayName, passwordHash, salt, Date.now());
    return this.getUser(id)!;
  }

  createApp(input: { name: string; botUserId: ID; createdBy: ID; signingSecret: string }): App {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO apps (id, name, bot_user_id, created_by, created_at, signing_secret) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.botUserId, input.createdBy, now, input.signingSecret);
    return {
      id,
      name: input.name,
      botUserId: input.botUserId,
      createdBy: input.createdBy,
      createdAt: now,
      interactivityUrl: "",
    };
  }

  /** Where this app's button clicks go. Empty leaves its buttons inert. */
  setInteractivityUrl(id: ID, url: string): boolean {
    return (
      this.db.prepare("UPDATE apps SET interactivity_url = ? WHERE id = ?").run(url, id).changes > 0
    );
  }

  /** The app a bot user posts as, for tracing a message back to its owner. */
  appForBotUser(botUserId: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE bot_user_id = ?").get(botUserId) as
      Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  /**
   * The key an app signs with. Admin-visible by design — the receiving end
   * needs it to verify, exactly as Slack shows a signing secret in app config.
   */
  appSigningSecret(id: ID): string | null {
    const r = this.db.prepare("SELECT signing_secret FROM apps WHERE id = ?").get(id) as
      { signing_secret: string } | undefined;
    return r?.signing_secret ?? null;
  }

  private toApp(r: {
    id: string;
    name: string;
    bot_user_id: string;
    created_by: string;
    created_at: number;
    interactivity_url?: string;
  }): App {
    return {
      id: r.id,
      name: r.name,
      botUserId: r.bot_user_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      interactivityUrl: r.interactivity_url ?? "",
    };
  }

  getApp(id: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as
      Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  listApps(): App[] {
    const rows = this.db
      .prepare("SELECT * FROM apps ORDER BY created_at DESC")
      .all() as unknown as Parameters<Store["toApp"]>[0][];
    return rows.map((r) => this.toApp(r));
  }

  deleteApp(id: ID): void {
    // Tokens and hooks are meaningless without their app.
    this.db.prepare("DELETE FROM slash_commands WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM event_subscriptions WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM webhooks WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM app_tokens WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
  }

  addAppToken(appId: ID, tokenHash: string): void {
    this.db
      .prepare("INSERT INTO app_tokens (token_hash, app_id, created_at) VALUES (?, ?, ?)")
      .run(tokenHash, appId, Date.now());
  }

  /** The app a bot token belongs to, or null if it is unknown. */
  /**
   * The app a bot token belongs to. A deactivated bot user is refused here as
   * well as at the login form: silencing a misbehaving integration should not
   * mean deleting it and losing its configuration.
   */
  appForToken(tokenHash: string): App | null {
    const r = this.db
      .prepare(
        `SELECT a.* FROM app_tokens t
         JOIN apps a ON a.id = t.app_id
         JOIN users u ON u.id = a.bot_user_id
         WHERE t.token_hash = ? AND u.deactivated = 0`,
      )
      .get(tokenHash) as Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  createWebhook(input: { appId: ID; channelId: ID; tokenHash: string }): Webhook {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO webhooks (id, app_id, channel_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.channelId, input.tokenHash, now);
    return { id, appId: input.appId, channelId: input.channelId, createdAt: now };
  }

  /** Resolves an incoming webhook secret to its app and target channel. */
  webhookForToken(tokenHash: string): { webhook: Webhook; app: App } | null {
    const r = this.db.prepare("SELECT * FROM webhooks WHERE token_hash = ?").get(tokenHash) as
      { id: string; app_id: string; channel_id: string; created_at: number } | undefined;
    if (!r) return null;
    const app = this.getApp(r.app_id);
    // Same as a bot token: a deactivated bot's webhooks go quiet too.
    if (!app || this.getUser(app.botUserId)?.deactivated) return null;
    return {
      webhook: { id: r.id, appId: r.app_id, channelId: r.channel_id, createdAt: r.created_at },
      app,
    };
  }

  listWebhooks(appId: ID): Webhook[] {
    const rows = this.db
      .prepare("SELECT * FROM webhooks WHERE app_id = ? ORDER BY created_at")
      .all(appId) as unknown as {
      id: string;
      app_id: string;
      channel_id: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      appId: r.app_id,
      channelId: r.channel_id,
      createdAt: r.created_at,
    }));
  }

  deleteWebhook(id: ID): boolean {
    return this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
  }

  // ---------- slash commands ----------

  private toCommand(r: {
    id: string;
    app_id: string;
    command: string;
    url: string;
    description: string;
    usage_hint: string;
    created_at: number;
  }): SlashCommand {
    return {
      id: r.id,
      appId: r.app_id,
      command: r.command,
      url: r.url,
      description: r.description,
      usageHint: r.usage_hint,
      createdAt: r.created_at,
    };
  }

  createSlashCommand(input: {
    appId: ID;
    command: string;
    url: string;
    description: string;
    usageHint: string;
  }): SlashCommand {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO slash_commands (id, app_id, command, url, description, usage_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.command, input.url, input.description, input.usageHint, now);
    return { id, ...input, createdAt: now };
  }

  /** Looks a command up by the word the user typed, without its slash. */
  slashCommandByName(command: string): { command: SlashCommand; app: App } | null {
    const r = this.db.prepare("SELECT * FROM slash_commands WHERE command = ?").get(command) as
      Parameters<Store["toCommand"]>[0] | undefined;
    if (!r) return null;
    const app = this.getApp(r.app_id);
    return app ? { command: this.toCommand(r), app } : null;
  }

  listSlashCommands(appId: ID): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands WHERE app_id = ? ORDER BY command")
      .all(appId) as unknown as Parameters<Store["toCommand"]>[0][];
    return rows.map((r) => this.toCommand(r));
  }

  /** Every command in the workspace — what the composer's hint list shows. */
  listAllSlashCommands(): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands ORDER BY command")
      .all() as unknown as Parameters<Store["toCommand"]>[0][];
    return rows.map((r) => this.toCommand(r));
  }

  deleteSlashCommand(id: ID): boolean {
    return this.db.prepare("DELETE FROM slash_commands WHERE id = ?").run(id).changes > 0;
  }

  // ---------- outgoing event subscriptions ----------

  private toSubscription(r: {
    id: string;
    app_id: string;
    url: string;
    event_types: string;
    created_at: number;
  }): EventSubscription {
    return {
      id: r.id,
      appId: r.app_id,
      url: r.url,
      eventTypes: JSON.parse(r.event_types) as string[],
      createdAt: r.created_at,
    };
  }

  createSubscription(input: { appId: ID; url: string; eventTypes: string[] }): EventSubscription {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO event_subscriptions (id, app_id, url, event_types, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.url, JSON.stringify(input.eventTypes), now);
    return { id, ...input, createdAt: now };
  }

  listSubscriptions(appId: ID): EventSubscription[] {
    const rows = this.db
      .prepare("SELECT * FROM event_subscriptions WHERE app_id = ? ORDER BY created_at")
      .all(appId) as unknown as Parameters<Store["toSubscription"]>[0][];
    return rows.map((r) => this.toSubscription(r));
  }

  /** Every subscription plus its app, so delivery needs one query per event. */
  listAllSubscriptions(): { subscription: EventSubscription; app: App }[] {
    const rows = this.db
      .prepare(
        "SELECT s.*, a.id AS a_id, a.name AS a_name, a.bot_user_id, a.created_by, a.created_at AS a_created_at" +
          " FROM event_subscriptions s JOIN apps a ON a.id = s.app_id",
      )
      .all() as unknown as (Parameters<Store["toSubscription"]>[0] & {
      a_id: string;
      a_name: string;
      bot_user_id: string;
      created_by: string;
      a_created_at: number;
    })[];
    return rows.map((r) => ({
      subscription: this.toSubscription(r),
      app: this.toApp({
        id: r.a_id,
        name: r.a_name,
        bot_user_id: r.bot_user_id,
        created_by: r.created_by,
        created_at: r.a_created_at,
      }),
    }));
  }

  deleteSubscription(id: ID): boolean {
    return this.db.prepare("DELETE FROM event_subscriptions WHERE id = ?").run(id).changes > 0;
  }

  // ---------- invites ----------

  createInvite(input: { createdBy: ID; expiresAt: number | null; maxUses: number | null }): Invite {
    const code = inviteCode();
    this.db
      .prepare(
        "INSERT INTO invites (code, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)",
      )
      .run(code, input.createdBy, Date.now(), input.expiresAt, input.maxUses);
    return this.getInvite(code)!;
  }

  getInvite(code: string): Invite | null {
    const r = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as
      | {
          code: string;
          created_by: string;
          created_at: number;
          expires_at: number | null;
          max_uses: number | null;
          uses: number;
        }
      | undefined;
    if (!r) return null;
    return {
      code: r.code,
      createdBy: r.created_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxUses: r.max_uses,
      uses: r.uses,
    };
  }

  /** Validates and consumes one use. Returns false if invalid/expired/exhausted. */
  consumeInvite(code: string): boolean {
    const inv = this.getInvite(code);
    if (!inv) return false;
    if (inv.expiresAt !== null && Date.now() > inv.expiresAt) return false;
    if (inv.maxUses !== null && inv.uses >= inv.maxUses) return false;
    this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(code);
    return true;
  }

  // ---------- event log ----------

  appendEvent(event: WorkspaceEvent, channelId: ID | null): EventEnvelope {
    const res = this.db
      .prepare("INSERT INTO events (channel_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(channelId, event.type, JSON.stringify(event), Date.now());
    return { seq: Number(res.lastInsertRowid), event };
  }

  currentSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) s FROM events").get() as { s: number };
    return r.s;
  }

  minSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MIN(seq), 0) s FROM events").get() as { s: number };
    return r.s;
  }

  /** Events after `afterSeq` visible to the user. Null = too far behind, client must resync. */
  eventsSince(afterSeq: number, userId: ID, limit = 2000): EventEnvelope[] | null {
    const min = this.minSeq();
    if (min > 0 && afterSeq < min - 1) return null;
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.payload FROM events e
         LEFT JOIN channels c ON c.id = e.channel_id
         WHERE e.seq > ? AND (
           e.channel_id IS NULL
           OR c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = e.channel_id AND m.user_id = ?)
         )
         ORDER BY e.seq LIMIT ?`,
      )
      .all(afterSeq, userId, limit + 1) as { seq: number; payload: string }[];
    if (rows.length > limit) return null;
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as WorkspaceEvent }));
  }

  pruneEvents(keep = 20000): void {
    this.db
      .prepare("DELETE FROM events WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM events) - ?")
      .run(keep);
  }

  // ---------- search ----------

  /**
   * Full-text search restricted to what the user can see, with modifier
   * filters (from:/in:/has:/before:/after:) applied as plain SQL. Free-text
   * terms go to FTS5; a query with only modifiers skips FTS entirely.
   */
  searchMessages(
    userId: ID,
    query: ParsedSearch,
    limit: number,
    opts: { cursor?: ID; channelId?: ID } = {},
  ): Message[] {
    const where: string[] = ["m.deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (opts.cursor) {
      where.push("m.id < ?");
      params.push(opts.cursor);
    }
    if (opts.channelId) {
      where.push("m.channel_id = ?");
      params.push(opts.channelId);
    }

    if (query.terms.length > 0) {
      // Quote every term so user input can never break FTS5 syntax.
      const fts = query.terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
      where.push("m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
      params.push(fts);
    }
    if (query.from.length > 0) {
      where.push(`u.handle IN (${query.from.map(() => "?").join(",")})`);
      params.push(...query.from);
    }
    if (query.in.length > 0) {
      where.push(`c.name IN (${query.in.map(() => "?").join(",")})`);
      params.push(...query.in);
    }
    if (query.has.includes("link")) {
      // Parenthesised: this sits inside an AND-joined list.
      where.push("(m.text LIKE '%http://%' OR m.text LIKE '%https://%')");
    }
    if (query.has.includes("file")) {
      where.push("EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id)");
    }
    if (query.before !== null) {
      where.push("m.created_at < ?");
      params.push(query.before);
    }
    if (query.after !== null) {
      where.push("m.created_at >= ?");
      params.push(query.after);
    }

    // Visibility is never optional, whatever the modifiers say.
    where.push(
      `(c.type = 'public' OR EXISTS (
         SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
       ))`,
    );
    params.push(userId);

    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN channels c ON c.id = m.channel_id
         JOIN users u ON u.id = m.user_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as MessageRow[];
    return this.hydrateMessages(rows);
  }
}
