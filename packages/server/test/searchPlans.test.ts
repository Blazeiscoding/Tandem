import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseSearchQuery } from "@slackoss/protocol";
import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";

/**
 * A search for a word in many messages walks the newest first, and one for a
 * rare word starts from its matches (OPT-11). Whichever way a search goes, a
 * page must hold exactly what one query over every match says, in the same
 * order, page after page.
 *
 * Messages are written in an order their ids do not follow, so the rowids the
 * walk bounds its matches by disagree with the ids it pages by, and the walk
 * and the point past which it gives up are made small enough to be crossed.
 */
const statics = Store as unknown as { SEARCH_FEW_MATCHES: number; SEARCH_WINDOW: number };
const defaults = { few: statics.SEARCH_FEW_MATCHES, window: statics.SEARCH_WINDOW };

let directory: string;
let db: DatabaseSync;
let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slackoss-search-plans-"));
  db = openDb(join(directory, "workspace.db"));
  store = new Store(db);
  statics.SEARCH_FEW_MATCHES = 8;
  statics.SEARCH_WINDOW = 40;
});

afterEach(() => {
  statics.SEARCH_FEW_MATCHES = defaults.few;
  statics.SEARCH_WINDOW = defaults.window;
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Every match, newest first, as one query over all of them reads it. */
function everyMatch(reader: string, text: string, opts: { channelId?: string } = {}): string[] {
  const q = parseSearchQuery(text, { timeZone: "UTC" });
  const where = ["m.deleted_at IS NULL"];
  const params: (string | number)[] = [];
  if (opts.channelId) where.push("m.channel_id = ?") && params.push(opts.channelId);
  if (q.terms.length) {
    where.push("m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    params.push(q.terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" "));
  }
  if (q.from.length) where.push("u.handle = ?") && params.push(q.from[0]!);
  if (q.in.length) where.push("c.name = ?") && params.push(q.in[0]!);
  if (q.has.includes("link")) where.push("m.text LIKE '%https://%'");
  if (q.before !== null) where.push("m.created_at < ?") && params.push(q.before);
  if (q.after !== null) where.push("m.created_at >= ?") && params.push(q.after);
  where.push(
    "(c.type = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))",
  );
  params.push(reader);
  return (
    db
      .prepare(
        `SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
         JOIN users u ON u.id = m.user_id WHERE ${where.join(" AND ")} ORDER BY m.id DESC`,
      )
      .all(...params) as { id: string }[]
  ).map((r) => r.id);
}

/** Every page the store gives, `size` at a time, as the route asks for them. */
function everyPage(reader: string, text: string, size: number, opts: { channelId?: string } = {}) {
  const parsed = parseSearchQuery(text, { timeZone: "UTC" });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const page = store.searchMessages(reader, parsed, size, { ...opts, cursor });
    ids.push(...page.map((m) => m.id));
    if (page.length < size) return ids;
    cursor = page.at(-1)!.id;
  }
  throw new Error("never ended");
}

function seed() {
  const people = ["ana", "ben", "cai"].map((handle) =>
    store.createUser({ handle, displayName: handle, passwordHash: "", salt: "", role: "member" }),
  );
  const ana = people[0]!;
  const ben = people[1]!;
  const general = store.createChannel({
    type: "public",
    name: "general",
    creatorId: ana.id,
    memberIds: [ana.id],
  });
  const small = store.createChannel({
    type: "public",
    name: "small",
    creatorId: ana.id,
    memberIds: [ana.id],
  });
  const team = store.createChannel({
    type: "private",
    name: "team",
    creatorId: ana.id,
    memberIds: [ana.id, ben.id],
  });
  const hidden = store.createChannel({
    type: "private",
    name: "hidden",
    creatorId: ben.id,
    memberIds: [ben.id],
  });
  const channels = [general.id, general.id, general.id, small.id, team.id, hidden.id];
  // Ids in time order, written in an order they do not follow.
  const order = Array.from({ length: 600 }, (_, i) => i);
  let rng = 3;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, seq, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of order) {
    const words = [`message ${n}`];
    if (n % 5 !== 0) words.push("common");
    if (n % 9 === 0) words.push("sometimes");
    if (n % 97 === 0) words.push("rare");
    if (n % 7 === 0) words.push("https://example.com");
    insert.run(
      `M${String(n).padStart(6, "0")}`,
      channels[n % channels.length]!,
      people[n % 3]!.id,
      words.join(" "),
      n + 1,
      Date.UTC(2026, 0, 1) + n * 3_600_000,
      n % 23 === 0 ? 1 : null,
    );
  }
  return { ana, ben, small };
}

describe("a search, whichever way it goes", () => {
  it("pages through exactly what one query over every match says", () => {
    const { ana, ben, small } = seed();
    const queries = [
      "common",
      "sometimes",
      "rare",
      "nothing-has-this",
      "common sometimes",
      "common in:#small",
      "common from:@ben",
      "common has:link",
      "common before:2026-01-10",
      "common after:2026-01-20",
      "sometimes after:2026-01-05 before:2026-01-25",
      "from:@cai",
    ];
    for (const reader of [ana.id, ben.id]) {
      for (const text of queries) {
        const expected = everyMatch(reader, text);
        for (const size of [1, 7, 50]) {
          expect(everyPage(reader, text, size), `${text}, ${size} a page`).toEqual(expected);
        }
        expect(
          everyPage(reader, text, 7, { channelId: small.id }),
          `${text} in one channel`,
        ).toEqual(everyMatch(reader, text, { channelId: small.id }));
      }
    }
    // Both ways were taken: a common word walked the newest, and the walk
    // ran out of window and read older ones from the matches.
    expect(everyMatch(ana.id, "common").length).toBeGreaterThan(statics.SEARCH_WINDOW);
    expect(everyMatch(ana.id, "rare").length).toBeLessThanOrEqual(statics.SEARCH_FEW_MATCHES);
  });

  it("never returns a message from a conversation the reader cannot see", () => {
    const { ana } = seed();
    const hidden = db.prepare("SELECT id FROM channels WHERE name = 'hidden'").get() as {
      id: string;
    };
    const parsed = parseSearchQuery("common", { timeZone: "UTC" });
    const found = store.searchMessages(ana.id, parsed, 1000);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((m) => m.channelId === hidden.id)).toBe(false);
  });

  it("still finds what is there with the defaults", () => {
    statics.SEARCH_FEW_MATCHES = defaults.few;
    statics.SEARCH_WINDOW = defaults.window;
    const { ana } = seed();
    expect(everyPage(ana.id, "common", 20)).toEqual(everyMatch(ana.id, "common"));
  });
});
