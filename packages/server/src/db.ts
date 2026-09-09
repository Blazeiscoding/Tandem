import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export function openDb(path: string, upTo = MIGRATIONS.length): DatabaseSync {
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
