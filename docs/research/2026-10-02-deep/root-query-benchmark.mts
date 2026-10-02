/**
 * Diagnostic index experiment against the current Store.searchMessages SQL.
 * Run from the repository root:
 * pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-deep/root-query-benchmark.mts
 * Writes only sibling evidence JSON and uniquely owned OS temporary fixtures.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSearchQuery } from "../../../packages/protocol/src/search.js";
import { openDb } from "../../../packages/server/src/db.js";
import { Store } from "../../../packages/server/src/store.js";

const SAMPLES = 25;
const WARMUPS = 5;
const LIMIT = 21;
const DAY = 86_400_000;
const END = Date.UTC(2026, 8, 30);
const START = END - 730 * DAY;
const OLD_BEFORE = START + 30 * DAY;
const FIXTURE_SEED = 7;
const startedAt = new Date().toISOString();
const started = performance.now();
const DEADLINE_MS = 120_000;
const reportPath = new URL("root-query-evidence.json", import.meta.url);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const counts = (
  process.argv.find((arg) => arg.startsWith("--messages="))?.slice(11) ?? "50000,200000"
)
  .split(",")
  .map(Number);
if (counts.some((count) => !Number.isInteger(count) || count < 1000 || count > 200_000)) {
  throw new Error(
    "--messages must contain comma-separated integer sizes between 1,000 and 200,000",
  );
}
const percentile = (values: number[], percentage: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((percentage / 100) * sorted.length))]!;
};
const digest = (values: string[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
const deadline = () => {
  if (performance.now() - started > DEADLINE_MS)
    throw new Error("Diagnostic exceeded its two-minute work budget");
};

type FixtureRow = { id: string; channelId: string; author: string; at: number; text: string };
type RecordedQuery = { sql: string; params: (string | number | null)[]; method: string };
type QueryShape = {
  name: string;
  text: string;
  matches: (row: FixtureRow) => boolean;
};
const queries: QueryShape[] = [
  { name: "rare_author", text: "from:@rare", matches: (row) => row.author === "URARE" },
  {
    name: "old_before_date",
    text: `before:${new Date(OLD_BEFORE).toISOString().slice(0, 10)}`,
    matches: (row) => row.at < OLD_BEFORE,
  },
  { name: "broad_text", text: "the", matches: (row) => row.text.split(" ").includes("the") },
  {
    name: "hidden_private_negative",
    text: "classified",
    matches: (row) => row.text.split(" ").includes("classified"),
  },
];

/** Preserve the existing search fixture's distributions and PRNG calls. */
function seed(db: ReturnType<typeof openDb>, count: number): FixtureRow[] {
  const rows: FixtureRow[] = [];
  const people = Array.from({ length: 50 }, (_, i) => `U${String(i).padStart(2, "0")}`);
  const addUser = db.prepare(
    "INSERT INTO users (id, handle, display_name, password_hash, salt, created_at) VALUES (?, ?, ?, '', '', 0)",
  );
  const addChannel = db.prepare(
    "INSERT INTO channels (id, type, name, creator_id, created_at) VALUES (?, ?, ?, 'U00', 0)",
  );
  const joinMember = db.prepare(
    "INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, 0)",
  );
  const insert = db.prepare(
    "INSERT INTO messages (id, channel_id, user_id, text, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const attach = db.prepare(
    "INSERT INTO files (id, channel_id, user_id, message_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, 'notes.txt', 'text/plain', 10, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const id of people) addUser.run(id, id.toLowerCase(), id);
    addUser.run("URARE", "rare", "Rare");
    const channels: [string, string, string][] = [
      ["CGEN", "public", "general"],
      ["CRND", "public", "random"],
      ...[0, 1, 2, 3, 4].map(
        (i) => [`CSM${i}`, "public", `small-${i}`] as [string, string, string],
      ),
      ["CTEAM", "private", "team"],
      ["CSECRET", "private", "secret"],
    ];
    for (const [id, type, name] of channels) addChannel.run(id, type, name);
    joinMember.run("CTEAM", "U01");
    joinMember.run("CSECRET", "U02");
    let rng = FIXTURE_SEED;
    const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < count; i++) {
      if (i % 5000 === 0) deadline();
      const r = random();
      const channelId =
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
      if (channelId === "CSECRET" && random() < 0.5) words.push("classified");
      if (random() < 0.02) words.push("https://example.com/page");
      const at = START + Math.floor((i / count) * (END - START));
      const id = `M${String(at).padStart(14, "0")}${String(i).padStart(7, "0")}`;
      const author = i % 2000 === 0 ? "URARE" : people[i % 50]!;
      const text = words.join(" ");
      insert.run(id, channelId, author, text, i + 1, at);
      if (i % 500 === 250) attach.run(`F${i}`, channelId, author, id, at);
      rows.push({ id, channelId, author, at, text });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rows;
}

function databaseSize(db: ReturnType<typeof openDb>, path: string) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const pageSize = Number(
    (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size,
  );
  const pages = Number(
    (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count,
  );
  const freePages = Number(
    (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
  );
  return {
    pageSize,
    pages,
    freePages,
    activePages: pages - freePages,
    activeBytes: (pages - freePages) * pageSize,
    allocatedBytes: pages * pageSize,
    databaseFileBytes: statSync(path).size,
  };
}

/** Capture the exact prepared SQL/arguments used by the unchanged Store. */
function captureQuery(db: ReturnType<typeof openDb>, run: () => unknown): RecordedQuery[] {
  const statements: RecordedQuery[] = [];
  const originalPrepare = db.prepare;
  db.prepare = function (sql: string) {
    const statement = originalPrepare.call(db, sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...params: (string | number | null)[]) => {
          if (/^\s*SELECT\b/i.test(sql) && (property === "get" || property === "all")) {
            statements.push({ sql, params, method: String(property) });
          }
          return Reflect.apply(value, target, params);
        };
      },
    });
  } as typeof db.prepare;
  try {
    run();
  } finally {
    db.prepare = originalPrepare;
  }
  return statements;
}

const workloads: Record<string, unknown>[] = [];
let completed = false;
try {
  for (const count of counts) {
    deadline();
    const tempRoot = realpathSync(tmpdir());
    const fixtureDir = mkdtempSync(join(tempRoot, "tandem-query-diag-"));
    const ownedDir = realpathSync(fixtureDir);
    const dbPath = join(ownedDir, "workspace.db");
    const db = openDb(dbPath);
    try {
      const store = new Store(db);
      const seedStart = performance.now();
      const rows = seed(db, count);
      const seedingMs = performance.now() - seedStart;
      const expected = new Map(
        queries.map((query) => [
          query.name,
          rows
            .filter((row) => row.channelId !== "CSECRET" && query.matches(row))
            .sort((a, b) => b.id.localeCompare(a.id))
            .slice(0, LIMIT)
            .map((row) => row.id),
        ]),
      );
      const allVisibleMatches = Object.fromEntries(
        queries.map((query) => [
          query.name,
          rows.filter((row) => row.channelId !== "CSECRET" && query.matches(row)).length,
        ]),
      );
      const parsed = new Map(
        queries.map((query) => [query.name, parseSearchQuery(query.text, { timeZone: "UTC" })]),
      );
      const run = (query: QueryShape) =>
        store.searchMessages("U01", parsed.get(query.name)!, LIMIT);
      const check = (query: QueryShape, answer: ReturnType<typeof run>) => {
        if (answer.some((message) => message.channelId === "CSECRET"))
          throw new Error(`${query.name} exposed hidden private content`);
        if (
          JSON.stringify(answer.map((message) => message.id)) !==
          JSON.stringify(expected.get(query.name))
        ) {
          throw new Error(
            `${query.name} result IDs/order differ from the independently seeded reference`,
          );
        }
      };
      const variants: Record<string, unknown>[] = [];
      const measureVariant = (name: string, indexName: string | null) => {
        const plans = queries.map((query) => {
          check(query, run(query));
          const statements = captureQuery(db, () => check(query, run(query)));
          return {
            name: query.name,
            text: query.text,
            statements: statements.map((statement) => ({
              ...statement,
              plan: db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.params),
            })),
          };
        });
        const uses = indexName
          ? plans
              .filter((query) =>
                query.statements.some((statement) =>
                  statement.plan.some((step) =>
                    String((step as { detail: string }).detail).includes(indexName),
                  ),
                ),
              )
              .map((query) => query.name)
          : [];
        const timings =
          !indexName || uses.length
            ? queries.map((query) => {
                for (let i = 0; i < WARMUPS; i++) check(query, run(query));
                const samplesMs: number[] = [];
                for (let i = 0; i < SAMPLES; i++) {
                  deadline();
                  const start = performance.now();
                  const answer = run(query);
                  samplesMs.push(performance.now() - start);
                  check(query, answer);
                }
                return {
                  name: query.name,
                  rows: expected.get(query.name)!.length,
                  exactIds: expected.get(query.name),
                  idsSha256: digest(expected.get(query.name)!),
                  samplesMs,
                  p50Ms: percentile(samplesMs, 50),
                  p95Ms: percentile(samplesMs, 95),
                  minMs: Math.min(...samplesMs),
                  maxMs: Math.max(...samplesMs),
                };
              })
            : [];
        const entry = {
          name,
          indexName,
          plannerUsesIndexFor: uses,
          candidateTimingSkipped: Boolean(indexName && !uses.length),
          plans,
          timings,
          size: databaseSize(db, dbPath),
        };
        variants.push(entry);
        for (const timing of timings)
          console.log(
            `${count} ${name} ${timing.name}: p50=${timing.p50Ms.toFixed(3)}ms p95=${timing.p95Ms.toFixed(3)}ms`,
          );
        return entry;
      };
      const baseline = measureVariant("baseline", null);
      for (const [indexName, columns] of [
        ["idx_diag_messages_author_page", "user_id, id DESC"],
        ["idx_diag_messages_time_page", "created_at, id DESC"],
      ]) {
        deadline();
        const buildStart = performance.now();
        db.exec(`CREATE INDEX ${indexName} ON messages(${columns})`);
        const buildMs = performance.now() - buildStart;
        const candidate = measureVariant(indexName, indexName);
        Object.assign(candidate, {
          indexSql: `CREATE INDEX ${indexName} ON messages(${columns})`,
          buildMs,
          indexActivePageGrowth: candidate.size.activePages - baseline.size.activePages,
          indexActiveByteGrowth: candidate.size.activeBytes - baseline.size.activeBytes,
          databaseFileByteGrowth:
            candidate.size.databaseFileBytes - baseline.size.databaseFileBytes,
        });
        try {
          Object.assign(candidate, {
            exactDbstatIndexPages: db
              .prepare("SELECT COUNT(*) AS pages, SUM(pgsize) AS bytes FROM dbstat WHERE name = ?")
              .get(indexName),
          });
        } catch {
          Object.assign(candidate, {
            exactDbstatIndexPages: null,
            pageGrowthInterpretation:
              "dbstat unavailable; active-page difference measures added live allocation, physical file size can retain freed pages",
          });
        }
        db.exec(`DROP INDEX ${indexName}`);
      }
      measureVariant("baseline_after_drop", null);
      workloads.push({
        messages: count,
        fixtureSeed: FIXTURE_SEED,
        seedingMs,
        fixtureSemantics:
          "scripts/measure-search.mts distributions and identical seed-7 PRNG sequence",
        allVisibleMatches,
        sqliteVersion: db.prepare("SELECT sqlite_version() AS version").get(),
        schemaVersion: db.prepare("PRAGMA user_version").get(),
        analyzeRun: false,
        warmups: WARMUPS,
        samplesPerQuery: SAMPLES,
        resultLimit: LIMIT,
        fixtureIdsSha256: digest(rows.map((row) => row.id)),
        variants,
      });
    } finally {
      db.close();
      // Only the unique directory created by this process may be removed.
      const resolvedTarget = resolve(ownedDir);
      const rel = relative(tempRoot, resolvedTarget);
      if (
        !isAbsolute(resolvedTarget) ||
        dirname(resolvedTarget) !== tempRoot ||
        !basename(resolvedTarget).startsWith("tandem-query-diag-") ||
        rel === "" ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel) ||
        realpathSync(resolvedTarget) !== ownedDir
      ) {
        throw new Error(
          `Refusing cleanup outside this process's owned temporary directory: ${resolvedTarget}`,
        );
      }
      rmSync(resolvedTarget, { recursive: true, force: true });
    }
  }
  completed = true;
} finally {
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        sourceRevision,
        startedAt,
        finishedAt: new Date().toISOString(),
        completed,
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          osRelease: release(),
          cpu: cpus()[0]?.model,
          cpuLogicalThreads: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        method:
          "Current openDb/Store SQLite source; isolated on-disk fixtures; warm synchronous Store search including hydration; no HTTP/render/main-loop or write-throughput measurements; indexes installed individually and timed only when actual SQL plans use them.",
        requestedWorkBudgetMs: DEADLINE_MS,
        elapsedMs: performance.now() - started,
        workloads,
      },
      null,
      2,
    ) + "\n",
  );
}
