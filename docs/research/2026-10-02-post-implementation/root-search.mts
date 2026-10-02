/**
 * What a search costs, by the shape of the query (OPT-11). Search filters a
 * walk of every message, newest first, until it has a page; how far it walks
 * depends on how many messages match and where they are.
 *
 * Seeds `--messages` messages (200,000 by default) over two years, from 50
 * authors and one who rarely writes: 70% in #general, 20% in #random, 1% in
 * each of five small channels, and 2.5% each in a private channel the reader
 * is in and one they are not. "the" is in 60% of messages, "deploy" in 5%,
 * "zebra" in 0.01%, and "classified" only in the channel the reader cannot
 * see; 2% carry a link and 1% a file, named for a budget, a photo, a
 * contract, notes or logs in turn, so free text and `type:` find them by
 * name and kind (IMP-02).
 *
 * It checks that nothing from the hidden channel is returned, then times one
 * page (21 rows, as the route asks for 20) of each query through the store and
 * prints how SQLite runs it. Run with the server package's tsx:
 *
 *   pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-post-implementation/root-search.mts [--messages=200000] [--out=root-search.json]
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join, dirname, basename } from "node:path";
import { execSync } from "node:child_process";
import { parseSearchQuery } from "../../../packages/protocol/src/search.js";
import { openDb } from "../../../packages/server/src/db.js";
import { Store } from "../../../packages/server/src/store.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const count = arg("messages", 200_000);
const SAMPLES = 15;
const DAY = 86_400_000;
const END = Date.UTC(2026, 8, 30);
const START = END - 730 * DAY;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const researchTempRoot = realpathSync(tmpdir());
const dir = realpathSync(mkdtempSync(join(researchTempRoot, "tandem-post-search-")));
const db = openDb(join(dir, "workspace.db"));
const store = new Store(db);
try {
  const seeding = performance.now();
  db.exec("BEGIN");
  const addUser = db.prepare(
    `INSERT INTO users (id, handle, display_name, password_hash, salt, created_at)
     VALUES (?, ?, ?, '', '', 0)`,
  );
  const addChannel = db.prepare(
    "INSERT INTO channels (id, type, name, creator_id, created_at) VALUES (?, ?, ?, 'U00', 0)",
  );
  const join_ = db.prepare(
    "INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, 0)",
  );
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const attach = db.prepare(
    `INSERT INTO files (id, channel_id, user_id, message_id, name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 10, ?)`,
  );
  const files: [name: string, mime: string][] = [
    ["Q3 budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["site photo.jpg", "image/jpeg"],
    ["contract.pdf", "application/pdf"],
    ["notes.txt", "text/plain"],
    ["logs.zip", "application/zip"],
  ];
  const people = Array.from({ length: 50 }, (_, i) => `U${String(i).padStart(2, "0")}`);
  for (const id of people) addUser.run(id, id.toLowerCase(), id);
  addUser.run("URARE", "rare", "Rare");
  const reader = people[1]!;
  const channels: [string, string, string][] = [
    ["CGEN", "public", "general"],
    ["CRND", "public", "random"],
    ...[0, 1, 2, 3, 4].map((i) => [`CSM${i}`, "public", `small-${i}`] as [string, string, string]),
    ["CTEAM", "private", "team"],
    ["CSECRET", "private", "secret"],
  ];
  for (const [id, type, name] of channels) addChannel.run(id, type, name);
  join_.run("CTEAM", reader);
  join_.run("CSECRET", people[2]!);
  let rng = 7;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < count; i++) {
    const r = random();
    const channel =
      r < 0.7
        ? "CGEN"
        : r < 0.9
          ? "CRND"
          : r < 0.95
            ? `CSM${Math.floor((r - 0.9) / 0.01)}`
            : r < 0.975
              ? "CTEAM"
              : "CSECRET";
    const words = [`message ${i}`];
    if (random() < 0.6) words.push("the");
    if (random() < 0.05) words.push("deploy");
    if (i % 10_000 === 5_000) words.push("zebra");
    if (channel === "CSECRET" && random() < 0.5) words.push("classified");
    if (random() < 0.02) words.push("https://example.com/page");
    const at = START + Math.floor((i / count) * (END - START));
    const id = `M${String(at).padStart(14, "0")}${String(i).padStart(7, "0")}`;
    const author = i % 2000 === 0 ? "URARE" : people[i % 50]!;
    insert.run(id, channel, author, words.join(" "), i + 1, at);
    if (i % 100 === 50) {
      const [name, mime] = files[((i / 100) % files.length) | 0]!;
      attach.run(`F${i}`, channel, author, id, name, mime, at);
    }
  }
  db.exec("COMMIT");
  let head = "";
  try {
    head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    head = "unknown";
  }
  console.log(
    `${count.toLocaleString()} messages seeded in ${((performance.now() - seeding) / 1000).toFixed(1)} s. ` +
      `${head}, ${cpus()[0]?.model ?? "cpu"}, ${cpus().length} threads, ` +
      `${Math.round(totalmem() / 2 ** 30)} GB, Node ${process.version}, ${process.platform}.\n`,
  );

  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const baseline: unknown[] = [];
  const queries: [string, { channelId?: string; cursor?: boolean }?][] = [
    ["the"],
    ["the", { cursor: true }],
    ["deploy"],
    ["zebra"],
    ["classified"],
    ["from:@rare"],
    ["in:#small-3"],
    ["the in:#small-3"],
    ["has:file"],
    ["has:link"],
    [`after:${day(END - 30 * DAY)}`],
    [`before:${day(START + 30 * DAY)}`],
    [`zebra before:${day(START + 30 * DAY)}`],
    ["deploy", { channelId: "CSM2" }],
    ["budget"],
    ["contract pdf"],
    ["invoice"],
    ["type:pdf"],
    ["type:image the"],
    ["budget type:spreadsheet"],
  ];
  console.log("query                              rows   p50 ms   p95 ms");
  for (const [text, options] of queries) {
    const parsed = parseSearchQuery(text, { timeZone: "UTC" });
    let cursor: string | undefined;
    if (options?.cursor) cursor = store.searchMessages(reader, parsed, 21).at(-1)?.id;
    const opts = { cursor, channelId: options?.channelId };
    const found = store.searchMessages(reader, parsed, 21, opts);
    if (found.some((m) => m.channelId === "CSECRET"))
      throw new Error(`${text} returned a hidden channel's message`);
    for (let warm = 0; warm < 5; warm++) store.searchMessages(reader, parsed, 21, opts);
    const times: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = performance.now();
      store.searchMessages(reader, parsed, 21, opts);
      times.push(performance.now() - t);
    }
    baseline.push({
      text,
      options,
      rows: found.length,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      samples: times,
    });
    const label = `${text}${options?.cursor ? " (page 2)" : ""}${options?.channelId ? " (in one channel)" : ""}`;
    console.log(
      `${label.padEnd(34)} ${String(found.length).padStart(4)} ${percentile(times, 50).toFixed(1).padStart(8)} ${percentile(times, 95).toFixed(1).padStart(8)}`,
    );
  }
  // Disposable query experiment: compare production hydration with an SQL
  // UNION of FTS and filename matches. No application source is changed.
  // Independent fixture reference checks filters, visibility and exact order.
  const originalRows = db
    .prepare(
      "SELECT m.*, u.handle, c.name AS channel_name, c.type AS channel_type FROM messages m JOIN users u ON u.id=m.user_id JOIN channels c ON c.id=m.channel_id ORDER BY m.id",
    )
    .all() as any[];
  const attached = db
    .prepare("SELECT message_id,name,mime FROM files WHERE message_id IS NOT NULL")
    .all() as any[];
  const filesByMessage = new Map<string, any[]>();
  for (const file of attached)
    filesByMessage.set(file.message_id, [...(filesByMessage.get(file.message_id) ?? []), file]);
  const cases: [string, { channelId?: string; cursor?: string }?][] = [
    ["zebra"],
    ["classified"],
    ["invoice"],
    ["budget"],
    ["contract pdf"],
    ["zebra", { channelId: "CSM2" }],
    ["zebra", { cursor: originalRows[Math.floor(count / 2)]!.id }],
    ["deploy in:#small-3"],
    ["zebra from:@rare"],
    ["zebra from:@u00"],
    ["zebra before:2025-01-01"],
    ["contract type:pdf"],
    ["the"],
    ["the in:#small-3"],
    ["the before:2025-01-01"],
  ];
  const candidate = (
    q: ReturnType<typeof parseSearchQuery>,
    opts: { channelId?: string; cursor?: string },
    inspect = false,
  ) => {
    if (q.has.length) throw Error("unsupported experiment has: filter");
    const filters = [
      "m.deleted_at IS NULL",
      "(c.type='public' OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=?))",
    ];
    const params: any[] = ["U01"];
    if (opts.cursor) {
      filters.push("m.id<?");
      params.push(opts.cursor);
    }
    if (opts.channelId) {
      filters.push("m.channel_id=?");
      params.push(opts.channelId);
    }
    if (q.from.length) {
      filters.push(`u.handle IN (${q.from.map(() => "?").join(",")})`);
      params.push(...q.from);
    }
    if (q.in.length) {
      filters.push(`c.name IN (${q.in.map(() => "?").join(",")})`);
      params.push(...q.in);
    }
    if (q.before !== null) {
      filters.push("m.created_at<?");
      params.push(q.before);
    }
    if (q.after !== null) {
      filters.push("m.created_at>=?");
      params.push(q.after);
    }
    if (q.types.length) {
      if (q.types.join() !== "pdf") throw Error("unsupported experiment type");
      filters.push(
        "EXISTS(SELECT 1 FROM files f WHERE f.message_id=m.id AND (lower(f.mime) LIKE 'application/pdf' OR lower(f.name) LIKE '%.pdf'))",
      );
    }
    const names = q.terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
    const fts = q.terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
    const sql = `WITH matching(id) AS (
      SELECT mf.id FROM messages_fts JOIN messages mf ON mf.rowid=messages_fts.rowid WHERE messages_fts MATCH ?
      ${names.length ? `UNION SELECT f.message_id FROM files f WHERE f.message_id IS NOT NULL AND ${names.map(() => "f.name LIKE ? ESCAPE '\\'").join(" AND ")}` : ""}
    ) SELECT m.* FROM messages m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.user_id
    WHERE m.id IN(SELECT id FROM matching) AND ${filters.join(" AND ")} ORDER BY m.id DESC LIMIT 21`;
    const bound = [fts, ...names.map((t) => `%${t.replaceAll(/[\\%_]/g, "\\$&")}%`), ...params];
    return {
      sql,
      bound,
      execute: () => (store as any).hydrateMessages(db.prepare(sql).all(...bound)),
      plan: inspect ? db.prepare("EXPLAIN QUERY PLAN " + sql).all(...bound) : undefined,
    };
  };
  const experiment: unknown[] = [];
  const inspectProduction = (
    q: ReturnType<typeof parseSearchQuery>,
    opts: { channelId?: string; cursor?: string },
  ) => {
    const prepare = db.prepare.bind(db);
    const plans: unknown[] = [];
    (db as any).prepare = (sql: string) => {
      const statement = prepare(sql);
      for (const method of ["all", "get"] as const) {
        const execute = statement[method].bind(statement);
        (statement as any)[method] = (...args: any[]) => {
          plans.push({
            sql,
            method,
            args,
            plan: prepare("EXPLAIN QUERY PLAN " + sql).all(...args),
          });
          return execute(...args);
        };
      }
      return statement;
    };
    try {
      return { actual: store.searchMessages(reader, q, 21, opts), plans };
    } finally {
      (db as any).prepare = prepare;
    }
  };
  for (const [text, opts = {}] of cases) {
    const q = parseSearchQuery(text, { timeZone: "UTC" });
    const ref = originalRows
      .filter((r) => {
        if (r.deleted_at !== null || (r.channel_type !== "public" && r.channel_id !== "CTEAM"))
          return false;
        if (opts.cursor && r.id >= opts.cursor) return false;
        if (opts.channelId && r.channel_id !== opts.channelId) return false;
        if (q.from.length && !q.from.includes(r.handle)) return false;
        if (q.in.length && !q.in.includes(r.channel_name)) return false;
        if (q.before !== null && r.created_at >= q.before) return false;
        if (q.after !== null && r.created_at < q.after) return false;
        const own = filesByMessage.get(r.id) ?? [];
        if (
          q.types.includes("pdf") &&
          !own.some(
            (f) =>
              f.mime.toLowerCase() === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
          )
        )
          return false;
        const names = q.terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
        return (
          q.terms.every((t) =>
            r.text
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .includes(t.toLowerCase()),
          ) ||
          (names.length > 0 &&
            own.some((f) => names.every((t) => f.name.toLowerCase().includes(t.toLowerCase()))))
        );
      })
      .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
      .slice(0, 21)
      .map((r) => r.id);
    const probe = candidate(q, opts, true);
    const { actual, plans: productionPlans } = inspectProduction(q, opts);
    const result = probe.execute();
    if (JSON.stringify(actual.map((m) => m.id)) !== JSON.stringify(ref))
      throw Error("production mismatch " + text);
    if (JSON.stringify(result) !== JSON.stringify(actual))
      throw Error("candidate hydration/content/order mismatch " + text);
    const currentTimes: number[] = [],
      candidateTimes: number[] = [];
    for (let warm = 0; warm < 5; warm++) {
      store.searchMessages(reader, q, 21, opts);
      candidate(q, opts).execute();
    }
    for (let i = 0; i < SAMPLES; i++) {
      const first = () => {
        const t = performance.now();
        store.searchMessages(reader, q, 21, opts);
        currentTimes.push(performance.now() - t);
      };
      const second = () => {
        const t = performance.now();
        candidate(q, opts).execute();
        candidateTimes.push(performance.now() - t);
      };
      if (i % 2) {
        second();
        first();
      } else {
        first();
        second();
      }
    }
    const summary = (times: number[]) => ({
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      samples: times,
    });
    experiment.push({
      text,
      opts,
      exactReference: true,
      fullHydratedEquality: true,
      rows: actual.length,
      production: summary(currentTimes),
      unionCandidate: summary(candidateTimes),
      productionPlans,
      candidatePlan: probe.plan,
    });
  }
  const result = {
    revision: execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),
    capturedAt: new Date().toISOString(),
    experimentVariant:
      "message-ID UNION; paired five-call warmups; construction/prepare/hydration included",
    machine: {
      cpu: cpus()[0]?.model,
      logicalCores: cpus().length,
      memoryGiB: totalmem() / 2 ** 30,
      platform: process.platform,
      node: process.version,
    },
    fixture: {
      messages: count,
      seed: 7,
      fileDensity: "1%",
      fileKinds: files,
      cache: "warm",
      samples: SAMPLES,
      limits:
        "Single quiet Windows host; no migration; candidate keeps current hydration, constructs SQL and reparses on every call; reference uses simple ASCII words present in this synthetic fixture. Reference/plans outside timing; fifteen-sample p95 is maximum observed, not a robust tail estimate. No low-spec, DM, multi-file, deleted-message, reordered-rowid or Electron-main claim.",
    },
    baseline,
    experiment,
  };
  writeFileSync(
    new URL(
      process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "root-search.json",
      import.meta.url,
    ),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    "Saved root-search.json; " + experiment.length + " exact-reference comparisons passed.",
  );
} finally {
  db.close();
  if (
    dirname(realpathSync(dir)) !== researchTempRoot ||
    !basename(dir).startsWith("tandem-post-search-")
  )
    throw new Error("Refusing unowned cleanup");
  rmSync(dir, { recursive: true, force: true });
}
