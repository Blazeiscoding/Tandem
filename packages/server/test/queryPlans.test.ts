import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb, openDbAtVersion, SCHEMA_VERSION } from "../src/db.js";

/**
 * Which index SQLite reads a query through, checked on a database with the
 * shape that exposed the problem: an old thread, then many newer messages in
 * the same channel. No ANALYZE, as the server never runs it. The timings behind
 * these are in scripts/measure-thread-index.mts.
 */
let db: DatabaseSync;

function plan(sql: string, ...params: (string | number)[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map((row) => row.detail)
    .join("; ");
}

function seed(target: DatabaseSync) {
  target.exec(`
    INSERT INTO users (id, handle, display_name, password_hash, salt, created_at)
      VALUES ('U1', 'owner', 'Owner', '', '', 0);
    INSERT INTO channels (id, type, name, creator_id, created_at)
      VALUES ('C1', 'public', 'general', 'U1', 0);
  `);
  const insert = target.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, created_at)
     VALUES (?, 'C1', 'U1', 'hello', ?, 0)`,
  );
  target.exec("BEGIN");
  insert.run("M0000", null);
  for (let i = 1; i <= 20; i++) insert.run(`M${String(i).padStart(4, "0")}`, "M0000");
  for (let i = 21; i < 2000; i++) insert.run(`M${String(i).padStart(4, "0")}`, null);
  target.exec("COMMIT");
}

beforeEach(() => {
  db = openDb(":memory:");
  seed(db);
});

afterEach(() => db.close());

describe("reading a thread's pages", () => {
  it("goes through (thread_root_id, id), not past every newer message in the channel", () => {
    const newest = plan(
      `SELECT * FROM messages WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 30`,
      "C1",
      "M0000",
    );
    expect(newest).toContain("idx_messages_thread_page");
    expect(newest).not.toContain("idx_messages_channel");
    // Ordered by the index itself, so nothing is sorted afterwards.
    expect(newest).not.toContain("TEMP B-TREE");

    const hasMore = plan(
      `SELECT 1 FROM messages WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL
       AND id > ? LIMIT 1`,
      "C1",
      "M0000",
      "M0010",
    );
    expect(hasMore).toContain("idx_messages_thread_page");
  });

  it("still answers what the single-column index used to", () => {
    // Reply counts for a page of roots, and whether a root has replies.
    expect(
      plan(
        `SELECT thread_root_id, COUNT(*) c FROM messages
         WHERE thread_root_id IN (?, ?) AND deleted_at IS NULL GROUP BY thread_root_id`,
        "M0000",
        "M0021",
      ),
    ).toContain("idx_messages_thread_page");
    expect(
      plan(
        `SELECT m.id FROM messages m WHERE m.id = ? AND EXISTS (
           SELECT 1 FROM messages r WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL)`,
        "M0000",
      ),
    ).toContain("idx_messages_thread_page");
  });

  it("replaces the old index when a workspace is upgraded, keeping its messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "slackoss-query-plans-"));
    try {
      const file = join(dir, "workspace.db");
      const older = openDbAtVersion(file, SCHEMA_VERSION - 1);
      seed(older);
      older.close();

      const upgraded = openDb(file, undefined, { backupBeforeUpgrade: false });
      try {
        const names = (
          upgraded
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'",
            )
            .all() as { name: string }[]
        ).map((row) => row.name);
        expect(names).toContain("idx_messages_thread_page");
        expect(names).not.toContain("idx_messages_thread");
        expect(upgraded.prepare("SELECT COUNT(*) AS n FROM messages").get()).toMatchObject({
          n: 2000,
        });
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
