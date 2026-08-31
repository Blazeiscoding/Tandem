import type { DatabaseSync } from "node:sqlite";
import type {
  Channel,
  ChannelType,
  FileMeta,
  ID,
  Invite,
  Message,
  ReactionGroup,
  Role,
  User,
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
    createdAt: r.created_at,
  };
}

export class Store {
  constructor(private db: DatabaseSync) {}

  // ---------- meta ----------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
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
      | UserRow
      | undefined;
    if (!r) return null;
    return { ...toUser(r), passwordHash: r.password_hash, salt: r.salt };
  }

  listUsers(): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY handle").all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  updateUser(
    id: ID,
    patch: { displayName?: string; statusText?: string; statusEmoji?: string },
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
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
        .run(...(params as string[]), id);
    }
    return this.getUser(id)!;
  }

  // ---------- sessions ----------

  createSession(tokenHash: string, userId: ID): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(tokenHash, userId, now, now);
  }

  getSessionUser(tokenHash: string): User | null {
    const r = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND u.deactivated = 0`,
      )
      .get(tokenHash) as UserRow | undefined;
    if (!r) return null;
    this.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(Date.now(), tokenHash);
    return toUser(r);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
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
    for (const uid of input.memberIds) this.addMember(id, uid);
    return this.getChannel(id)!;
  }

  getChannel(id: ID): Channel | null {
    const r = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
      | ChannelRow
      | undefined;
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
      | ChannelRow
      | undefined;
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

  addMember(channelId: ID, userId: ID): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)",
      )
      .run(channelId, userId, Date.now());
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

  memberships(userId: ID): { channelId: ID; lastReadSeq: number }[] {
    const rows = this.db
      .prepare("SELECT channel_id, last_read_seq FROM channel_members WHERE user_id = ?")
      .all(userId) as { channel_id: string; last_read_seq: number }[];
    return rows.map((r) => ({ channelId: r.channel_id, lastReadSeq: r.last_read_seq }));
  }

  markRead(channelId: ID, userId: ID, seq: number): void {
    this.db
      .prepare(
        "UPDATE channel_members SET last_read_seq = MAX(last_read_seq, ?) WHERE channel_id = ? AND user_id = ?",
      )
      .run(seq, channelId, userId);
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
      | { type: string }
      | undefined;
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
  }): Message {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, nonce, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.text,
        input.threadRootId,
        input.nonce,
        Date.now(),
      );
    return this.getMessage(id)!;
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
    this.db.prepare("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?").run(
      text,
      Date.now(),
      id,
    );
    return this.getMessage(id)!;
  }

  deleteMessage(id: ID): void {
    // Soft-delete, and blank the text so it drops out of the FTS index.
    this.db
      .prepare("UPDATE messages SET deleted_at = ?, text = '' WHERE id = ?")
      .run(Date.now(), id);
    this.db.prepare("DELETE FROM reactions WHERE message_id = ?").run(id);
  }

  /** Newest-first page of top-level channel messages (or thread replies). */
  listMessages(opts: {
    channelId: ID;
    before?: ID;
    limit: number;
    threadRootId?: ID;
  }): Message[] {
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
            | string
            | number
          )[]),
        ) as unknown as MessageRow[];
    }
    return this.hydrateMessages(rows);
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
    }));
  }

  // ---------- files ----------

  createFile(input: {
    channelId: ID;
    userId: ID;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
  }): FileMeta {
    const id = ulid();
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
  attachFiles(fileIds: ID[], messageId: ID, channelId: ID, userId: ID): void {
    const stmt = this.db.prepare(
      `UPDATE files SET message_id = ?
       WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL`,
    );
    for (const fileId of fileIds) stmt.run(messageId, fileId, userId, channelId);
  }

  /** File ids belonging to a message — used to delete blobs when the message goes. */
  fileIdsForMessage(messageId: ID): ID[] {
    const rows = this.db
      .prepare("SELECT id FROM files WHERE message_id = ?")
      .all(messageId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  deleteFiles(fileIds: ID[]): void {
    const stmt = this.db.prepare("DELETE FROM files WHERE id = ?");
    for (const id of fileIds) stmt.run(id);
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
      .prepare(
        "DELETE FROM events WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM events) - ?",
      )
      .run(keep);
  }

  // ---------- search ----------

  searchMessages(userId: ID, query: string, limit: number): Message[] {
    // Quote each term so user input can never break FTS5 syntax.
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', '""')}"`)
      .join(" ");
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         JOIN channels c ON c.id = m.channel_id
         WHERE messages_fts MATCH ? AND m.deleted_at IS NULL AND (
           c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
         )
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, userId, limit) as unknown as MessageRow[];
    return this.hydrateMessages(rows);
  }
}
