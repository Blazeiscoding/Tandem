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
];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
