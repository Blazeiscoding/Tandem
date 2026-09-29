import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    status_text TEXT NOT NULL DEFAULT '',
    status_emoji TEXT NOT NULL DEFAULT '',
    is_bot INTEGER NOT NULL DEFAULT 0,
    deactivated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    creator_id TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    dm_key TEXT UNIQUE,
    last_msg_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX idx_members_user ON channel_members(user_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    thread_root_id TEXT,
    nonce TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER
  );
  CREATE INDEX idx_messages_channel ON messages(channel_id, id);
  CREATE INDEX idx_messages_thread ON messages(thread_root_id);

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');

  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  `,

  // v2 — file attachments
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    message_id TEXT REFERENCES messages(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_files_message ON files(message_id);
  CREATE INDEX idx_files_channel ON files(channel_id);
  `,

  // v3 — pins (shared per channel) and saved items (private per user)
  `
  CREATE TABLE pins (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, message_id)
  );

  CREATE TABLE saved_items (
    user_id TEXT NOT NULL REFERENCES users(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  );
  `,

  // v4 — per-channel notification preferences and Do Not Disturb
  `
  ALTER TABLE channel_members ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'mentions';
  ALTER TABLE channel_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN dnd_until INTEGER;
  `,

  // v5 — messages queued to send later
  `
  CREATE TABLE scheduled_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    thread_root_id TEXT,
    file_ids TEXT NOT NULL DEFAULT '[]',
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_scheduled_due ON scheduled_messages(send_at);
  CREATE INDEX idx_scheduled_user ON scheduled_messages(user_id);
  `,

  // v6 — apps: bot users, API tokens and incoming webhooks
  `
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bot_user_id TEXT NOT NULL REFERENCES users(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE app_tokens (
    token_hash TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    channel_id TEXT NOT NULL REFERENCES channels(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_webhooks_app ON webhooks(app_id);
  `,

  // v7 — slash commands and outgoing event subscriptions
  `
  -- Signs outbound requests so a receiver can prove they came from us. Unlike
  -- bot tokens this is stored in the clear: HMAC needs the key itself.
  ALTER TABLE apps ADD COLUMN signing_secret TEXT NOT NULL DEFAULT '';
  UPDATE apps SET signing_secret = lower(hex(randomblob(32)));

  CREATE TABLE slash_commands (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    command TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    usage_hint TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_commands_app ON slash_commands(app_id);

  CREATE TABLE event_subscriptions (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    url TEXT NOT NULL,
    event_types TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_subscriptions_app ON event_subscriptions(app_id);
  `,
  // v8 — workspace-local friend requests, one row per unordered pair.
  `
  CREATE TABLE friendships (
    user_low TEXT NOT NULL REFERENCES users(id),
    user_high TEXT NOT NULL REFERENCES users(id),
    requested_by TEXT NOT NULL REFERENCES users(id),
    accepted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_low, user_high),
    CHECK (user_low < user_high),
    CHECK (requested_by = user_low OR requested_by = user_high)
  );
  CREATE INDEX idx_friends_high ON friendships(user_high);
  `,

  // v9 — interactive buttons: what an app attached to a message, and where a
  // click on one is delivered.
  `
  ALTER TABLE messages ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE apps ADD COLUMN interactivity_url TEXT NOT NULL DEFAULT '';
  `,
  // v10 — stable send keys. Preserve old duplicate messages, reserving their first key.
  `
  CREATE TABLE message_requests (
    user_id TEXT NOT NULL REFERENCES users(id),
    nonce TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id),
    request_hash TEXT,
    PRIMARY KEY (user_id, nonce)
  );
  INSERT INTO message_requests (user_id, nonce, message_id)
    SELECT user_id, nonce, MIN(id) FROM messages WHERE nonce IS NOT NULL GROUP BY user_id, nonce;
  `,
  // v11 — scheduled delivery records an outcome instead of vanishing.
  `
  ALTER TABLE scheduled_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'queued';
  ALTER TABLE scheduled_messages ADD COLUMN failure_reason TEXT;
  ALTER TABLE scheduled_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE scheduled_messages ADD COLUMN message_id TEXT;
  DROP INDEX idx_scheduled_due;
  CREATE INDEX idx_scheduled_due ON scheduled_messages(status, send_at);
  `,
  // v12 — sessions become listable, revocable one at a time, and expiring.
  `
  ALTER TABLE sessions ADD COLUMN id TEXT;
  ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
  UPDATE sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
  UPDATE sessions SET expires_at = last_seen_at + 2592000000 WHERE expires_at = 0;
  CREATE UNIQUE INDEX idx_sessions_id ON sessions(id);
  `,
  // v13 — blob removal survives process exit and temporary filesystem errors.
  `
  CREATE TABLE pending_file_deletions (
    file_id TEXT PRIMARY KEY
  );
  `,
  // v14 — retain scheduling request identities even after cancellation/pruning.
  `
  CREATE TABLE scheduled_requests (
    user_id TEXT NOT NULL REFERENCES users(id),
    nonce TEXT NOT NULL,
    scheduled_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    PRIMARY KEY (user_id, nonce)
  );
  `,
  // v15 — account-scoped thread following and independent read cursors.
  `
  CREATE TABLE thread_follows (
    user_id TEXT NOT NULL REFERENCES users(id),
    root_id TEXT NOT NULL REFERENCES messages(id),
    following INTEGER NOT NULL DEFAULT 1,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL,
    PRIMARY KEY (user_id, root_id)
  );
  CREATE INDEX idx_thread_follows_user ON thread_follows(user_id, following);
  CREATE INDEX idx_thread_follows_root ON thread_follows(root_id);
  `,
  // v16 — replies their author chose to send to the channel as well.
  `
  ALTER TABLE messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0;
  `,
  // v17 — a password someone else chose, which its owner must replace.
  `
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  `,
  // v18 — delegated authority belongs to membership, so leaving clears it.
  `
  ALTER TABLE channel_members ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0;
  `,
  // v19 — single-use tickets that let a browser stream a download to disk.
  `
  CREATE TABLE download_tokens (
    token_hash TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_download_tokens_expiry ON download_tokens(expires_at);
  CREATE INDEX idx_download_tokens_user ON download_tokens(user_id, expires_at);
  CREATE INDEX idx_download_tokens_file ON download_tokens(file_id);
  CREATE INDEX idx_download_tokens_session ON download_tokens(session_hash);
  `,
  // v20 — durable, ordered delivery for outgoing integration events.
  `
  CREATE TABLE event_deliveries (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    failed_at INTEGER,
    last_error TEXT,
    UNIQUE (subscription_id, event_seq)
  );
  CREATE INDEX idx_event_deliveries_due
    ON event_deliveries(failed_at, next_attempt_at, event_seq);
  CREATE INDEX idx_event_deliveries_channel ON event_deliveries(channel_id);
  CREATE TRIGGER discard_revoked_event_deliveries AFTER DELETE ON channel_members
  BEGIN
    DELETE FROM event_deliveries
    WHERE channel_id = OLD.channel_id AND subscription_id IN (
      SELECT s.id FROM event_subscriptions s
      JOIN apps a ON a.id = s.app_id
      WHERE a.bot_user_id = OLD.user_id
    );
  END;
  `,
  // v21 — an endpoint that stays down must not grow its queue without end.
  `
  ALTER TABLE event_subscriptions ADD COLUMN dropped_count INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_event_deliveries_backlog
    ON event_deliveries(subscription_id, failed_at);
  `,
  // v22 — deleting a message has to reach the copy of its text in the event log.
  // Without a way to find those rows, the words someone deleted stay readable on
  // disk until the log is pruned, which can be months.
  `
  ALTER TABLE events ADD COLUMN message_id TEXT;
  UPDATE events SET message_id = json_extract(payload, '$.message.id')
    WHERE type IN ('message.created', 'message.updated');
  UPDATE events SET message_id = json_extract(payload, '$.messageId')
    WHERE type = 'message.deleted';
  CREATE INDEX idx_events_message ON events(message_id);
  `,
  // v23 — an invite that has got out has to be withdrawable. Kept rather than
  // deleted, so the list can still say a link existed and who withdrew it.
  `
  ALTER TABLE invites ADD COLUMN revoked_at INTEGER;
  ALTER TABLE invites ADD COLUMN revoked_by TEXT;
  CREATE INDEX idx_invites_created ON invites(created_at);
  `,
  // v24 — who changed what, for the administrative actions a workspace has to be
  // able to account for. No foreign keys: a record outlives what it describes.
  `
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // v25 — creating invite codes is something a member is given, not something
  // every member has. Owners and admins can regardless of this column.
  `
  ALTER TABLE users ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 0;
  `,
  // v26 — a file waiting in a scheduled message belongs to that message alone,
  // held by a key rather than found by scanning JSON, so a second schedule or
  // an ordinary send cannot take it. A scheduled reply also remembers whether
  // it was to be shown in the channel. Outstanding rows claim their files in
  // the order they were queued; a file two of them named goes to the first.
  `
  ALTER TABLE scheduled_messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE scheduled_files (
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    scheduled_id TEXT NOT NULL REFERENCES scheduled_messages(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_scheduled_files_item ON scheduled_files(scheduled_id);
  INSERT OR IGNORE INTO scheduled_files (file_id, scheduled_id)
    SELECT j.value, s.id
    FROM scheduled_messages s,
      json_each(CASE WHEN json_valid(s.file_ids) AND json_type(s.file_ids) = 'array'
        THEN s.file_ids ELSE '[]' END) j
    WHERE s.status != 'sent'
      AND EXISTS (SELECT 1 FROM files f WHERE f.id = j.value AND f.message_id IS NULL)
    ORDER BY s.created_at, s.id;
  `,
  // v27 — a held scheduled message waits for its obstacle to clear, or for its
  // next attempt, instead of being checked again on every tick.
  `
  ALTER TABLE scheduled_messages ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_scheduled_held ON scheduled_messages(status, next_attempt_at);
  `,
];

/** The schema this build understands. A workspace above it cannot be opened. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Builds a database at an older schema level, for testing that upgrades from
 * historical versions still work. Reading the same migration list the product
 * does is the point: a fixture written by hand drifts away from it silently.
 */
export function openDbAtVersion(path: string, version: number): DatabaseSync {
  if (version > MIGRATIONS.length) throw new Error(`No schema v${version} exists`);
  return openDb(path, version);
}

/** Where copies taken before an upgrade go, beside the workspace they came from. */
export const UPGRADE_BACKUP_DIR = "pre-upgrade";
/** How many of those copies are kept. Each is a whole database. */
export const UPGRADE_BACKUPS_KEPT = 3;

export interface OpenDbOptions {
  /**
   * Copy an existing workspace before migrating it. On by default. Turning it
   * off is for someone who has just taken their own backup and has no room for
   * a second copy, not for everyday use.
   */
  backupBeforeUpgrade?: boolean;
  /** Told where the copy went, once it has been written. */
  onUpgradeBackup?: (file: string) => void;
}

/**
 * A consistent copy of the database as it is before any migration touches it.
 *
 * A migration runs in a transaction, so one that fails leaves the old schema
 * behind. What a transaction cannot undo is a migration that succeeds and is
 * wrong, or an upgrade someone wants to walk back a week later: rolling back
 * means the old application with the old data, and without a copy there is no
 * old data to roll back to. This is that copy, taken before the first change,
 * with nothing asked of the host.
 *
 * `VACUUM INTO` writes a snapshot including anything still in the write-ahead
 * log. Attachments are not copied: no migration touches them.
 */
function backupBeforeUpgrade(db: DatabaseSync, path: string, from: number, to: number): string {
  const dir = join(dirname(path), UPGRADE_BACKUP_DIR);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const file = join(dir, `workspace-v${from}-before-v${to}-${stamp}.db`);
  try {
    mkdirSync(dir, { recursive: true });
    db.prepare("VACUUM INTO ?").run(file);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const { user_version } = copy.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (user_version !== from) throw new Error("the copy has the wrong schema version");
    } finally {
      copy.close();
    }
  } catch (err) {
    // Best effort. Whatever stopped the copy can stop this too — on Linux a
    // file where the directory should be makes even removing a missing file
    // fail — and the reason worth reporting is the first one.
    try {
      rmSync(file, { force: true });
    } catch {
      // Nothing was written that needs removing, or it cannot be removed.
    }
    throw new Error(
      `Could not back up this workspace before upgrading it, so it has not been upgraded ` +
        `and nothing has changed. ${(err as Error).message}. Free some disk space and start ` +
        `again, or take a backup yourself and start with --skip-upgrade-backup.`,
    );
  }
  // Only the most recent few. One copy per upgrade is what rolling back the
  // last few needs; keeping every one would fill the disk a database at a time.
  // Ordered by when each was taken, which the name records.
  const taken = (name: string) => /-before-v\d+-(.+)\.db$/.exec(name)?.[1] ?? "";
  const copies = readdirSync(dir)
    .filter((name) => /^workspace-v\d+-before-v\d+-.+\.db$/.test(name))
    .sort((a, b) => taken(a).localeCompare(taken(b)));
  for (const old of copies.slice(0, Math.max(0, copies.length - UPGRADE_BACKUPS_KEPT))) {
    rmSync(join(dir, old), { force: true });
  }
  return file;
}

export function openDb(
  path: string,
  upTo = MIGRATIONS.length,
  options: OpenDbOptions = {},
): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (user_version > MIGRATIONS.length) {
    db.close();
    throw new Error(
      "This workspace was created by a newer server version. Upgrade the server before opening it.",
    );
  }
  // Version 0 is a file that has only just been created: nothing to lose yet.
  if (
    path !== ":memory:" &&
    user_version > 0 &&
    user_version < upTo &&
    options.backupBeforeUpgrade !== false
  ) {
    let file: string;
    try {
      file = backupBeforeUpgrade(db, path, user_version, upTo);
    } catch (err) {
      db.close();
      throw err;
    }
    options.onUpgradeBackup?.(file);
  }
  for (let v = user_version; v < upTo; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      // Leave nothing holding the file: on Windows a leaked handle blocks the
      // caller from even moving the workspace aside to recover it.
      db.close();
      throw err;
    }
  }
  return db;
}
