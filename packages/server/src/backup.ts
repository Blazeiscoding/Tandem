import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SCHEMA_VERSION } from "./db.js";
import { holdWorkspace } from "./ownership.js";
import { SERVER_VERSION } from "./server.js";

/** What a backup directory contains, and what it must still look like on restore. */
export interface BackupManifest {
  format: 1;
  createdAt: number;
  serverVersion: string;
  /** The migration level of the captured database. */
  schemaVersion: number;
  workspaceName: string;
  counts: Record<string, number>;
  database: BackupEntry;
  files: BackupEntry[];
}

interface BackupEntry {
  name: string;
  bytes: number;
  sha256: string;
}

const MANIFEST = "manifest.json";
const DATABASE = "workspace.db";
const FILES = "files";
const COUNTED = [
  "users",
  "channels",
  "channel_members",
  "messages",
  "files",
  "friendships",
  "scheduled_messages",
] as const;

const entrySchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.object({
  format: z.literal(1),
  createdAt: z.number().int().nonnegative(),
  serverVersion: z.string(),
  schemaVersion: z.number().int().min(3),
  workspaceName: z.string(),
  counts: z
    .object(Object.fromEntries(COUNTED.map((name) => [name, z.number().int().nonnegative()])))
    .strict(),
  database: entrySchema.extend({ name: z.literal(DATABASE) }),
  files: z.array(entrySchema),
});

/** Resolve existing ancestors too, so junctions cannot hide overlapping directories. */
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonical(dirname(absolute)), relative(dirname(absolute), absolute));
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../"))
  );
}

async function separateDirectories(a: string, b: string): Promise<void> {
  const [left, right] = await Promise.all([canonical(a), canonical(b)]);
  if (contains(left, right) || contains(right, left)) {
    throw new Error(
      "Backup and workspace directories must be separate, with neither inside the other.",
    );
  }
}

async function regularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Backup contains a non-regular file: ${path}`);
}

function snapshotDetails(db: DatabaseSync) {
  const schemaVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (schemaVersion > SCHEMA_VERSION)
    throw new Error("This backup was written by a newer server. Upgrade before restoring it.");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'workspace_name'").get() as
    { value: string } | undefined;
  const files = db.prepare("SELECT id, size FROM files ORDER BY id").all() as unknown as {
    id: string;
    size: number;
  }[];
  return { schemaVersion, workspaceName: row?.value ?? "", counts: countRows(db), files };
}

async function checksum(path: string): Promise<BackupEntry> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { name: path, bytes: (await stat(path)).size, sha256: hash.digest("hex") };
}

function countRows(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    counts[table] = row.n;
  }
  return counts;
}

/**
 * Captures a workspace into `out`.
 *
 * The database is copied with `VACUUM INTO`, which writes a consistent snapshot
 * including anything still sitting in the write-ahead log — the reason a plain
 * file copy of a running workspace is not a backup. Attachments are copied
 * afterwards using the snapshot's file inventory. Concurrent deletion can make
 * a referenced blob unavailable; that fails the backup instead of certifying
 * an incomplete copy. Stop the server to guarantee a complete capture.
 */
export async function backupWorkspace(opts: {
  dataDir: string;
  out: string;
}): Promise<BackupManifest> {
  const dataDir = resolve(opts.dataDir);
  const out = resolve(opts.out);
  await separateDirectories(dataDir, out);
  const source = join(dataDir, DATABASE);
  if (!existsSync(source)) throw new Error(`No workspace database at ${source}`);
  if (existsSync(out) && (await readdir(out)).length > 0) {
    throw new Error(`${out} is not empty. Choose a new directory for the backup.`);
  }
  await mkdir(join(out, FILES), { recursive: true });

  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(join(out, DATABASE));
  } finally {
    db.close();
  }

  const snapshot = new DatabaseSync(join(out, DATABASE), { readOnly: true });
  let details: ReturnType<typeof snapshotDetails>;
  try {
    details = snapshotDetails(snapshot);
  } finally {
    snapshot.close();
  }

  const files: BackupEntry[] = [];
  const blobDir = join(dataDir, FILES);
  for (const file of details.files) {
    const name = entrySchema.shape.name.parse(file.id);
    const from = join(blobDir, name);
    await regularFile(from);
    await copyFile(from, join(out, FILES, name));
    const entry = { ...(await checksum(join(out, FILES, name))), name };
    if (entry.bytes !== file.size)
      throw new Error(`Backup is incomplete: ${name} has the wrong size.`);
    files.push(entry);
  }

  const manifest: BackupManifest = {
    format: 1,
    createdAt: Date.now(),
    serverVersion: SERVER_VERSION,
    schemaVersion: details.schemaVersion,
    workspaceName: details.workspaceName,
    counts: details.counts,
    database: { ...(await checksum(join(out, DATABASE))), name: DATABASE },
    files,
  };
  await writeFile(join(out, MANIFEST), JSON.stringify(manifest, null, 2));
  return verifyBackup(out);
}

/** Reads and checks a backup without touching any workspace. */
export async function verifyBackup(backupDir: string): Promise<BackupManifest> {
  const dir = resolve(backupDir);
  let raw: unknown;
  try {
    await regularFile(join(dir, MANIFEST));
    raw = JSON.parse(await readFile(join(dir, MANIFEST), "utf8"));
  } catch {
    throw new Error(`${dir} does not look like a backup: no readable ${MANIFEST}.`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Backup manifest is invalid or uses an unsupported format.");
  const manifest = parsed.data as BackupManifest;
  if (
    new Set(manifest.files.map((entry) => entry.name.toLowerCase())).size !== manifest.files.length
  ) {
    throw new Error("Backup manifest contains duplicate attachment names.");
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `This backup was written by a newer server (schema ${manifest.schemaVersion}, this build understands ${SCHEMA_VERSION}). Upgrade before restoring it.`,
    );
  }
  for (const entry of [manifest.database, ...manifest.files]) {
    const path = entry === manifest.database ? join(dir, DATABASE) : join(dir, FILES, entry.name);
    if (!existsSync(path)) throw new Error(`Backup is incomplete: ${entry.name} is missing.`);
    await regularFile(path);
    // Reject a files directory redirected through a symlink or junction as well.
    if (!contains(await realpath(dir), await realpath(path)))
      throw new Error("Backup file escapes its directory.");
    const actual = await checksum(path);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      throw new Error(`Backup is damaged: ${entry.name} does not match its checksum.`);
    }
  }

  // Read the copy itself, not just its bytes: a file can hash correctly and
  // still be a database this build would refuse to open.
  const db = new DatabaseSync(join(dir, DATABASE), { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`Backup database fails its integrity check: ${integrity.integrity_check}`);
    }
    const actual = snapshotDetails(db);
    if (
      actual.schemaVersion !== manifest.schemaVersion ||
      actual.workspaceName !== manifest.workspaceName
    ) {
      throw new Error("Backup database schema or workspace name does not match its manifest.");
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error("Backup database has broken references.");
    for (const table of COUNTED) {
      const expected = manifest.counts[table];
      if (actual.counts[table] !== expected) {
        throw new Error(
          `Backup database holds ${actual.counts[table]} ${table}, but its manifest claims ${expected}.`,
        );
      }
    }
    const inventory = new Map(manifest.files.map((entry) => [entry.name, entry]));
    for (const file of actual.files) {
      if (inventory.get(file.id)?.bytes !== file.size) {
        throw new Error(
          `Backup is incomplete: attachment ${file.id} is missing or has the wrong size.`,
        );
      }
    }
  } finally {
    db.close();
  }
  return manifest;
}

/** What a backup reaches or sets off outside itself once it is started. */
export interface BackupInventory {
  /** Each place apps are sent something, with what goes there. */
  appAddresses: { origin: string; uses: ("events" | "commands" | "buttons")[] }[];
  /** Messages waiting to be posted, and when the earliest is due. */
  scheduled: { waiting: number; earliestAt: number | null };
  /** App events accepted but not yet delivered. */
  undeliveredEvents: number;
  /** Sign-ins a restored copy accepts, including any ended after the backup. */
  sessions: number;
}

/**
 * Lists what starting this backup would reach or set off outside it. Call it
 * on a backup `verifyBackup` has passed. It opens the database read-only, and
 * reads a backup from an older schema as it is, without upgrading it.
 */
export function inventoryBackup(backupDir: string, now = Date.now()): BackupInventory {
  const db = new DatabaseSync(join(resolve(backupDir), DATABASE), { readOnly: true });
  try {
    const columns = (table: string) =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
      );
    const apps = columns("apps");
    const subscriptions = columns("event_subscriptions");
    const commands = columns("slash_commands");
    const queue = columns("scheduled_messages");
    const sessions = columns("sessions");
    const deliveries = columns("event_deliveries");

    const targets = [
      subscriptions.has("url") && `SELECT url, 'events' AS use FROM event_subscriptions`,
      commands.has("url") && `SELECT url, 'commands' AS use FROM slash_commands`,
      apps.has("interactivity_url") &&
        `SELECT interactivity_url AS url, 'buttons' AS use FROM apps WHERE interactivity_url != ''`,
    ].flatMap((sql) =>
      sql
        ? (db.prepare(sql).all() as { url: string; use: "events" | "commands" | "buttons" }[])
        : [],
    );
    const byOrigin = new Map<string, Set<"events" | "commands" | "buttons">>();
    for (const { url, use } of targets) {
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = url;
      }
      byOrigin.set(origin, (byOrigin.get(origin) ?? new Set()).add(use));
    }
    // Before v11 a scheduled message was deleted once sent, so every row waits.
    const scheduled = db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(send_at) AS earliest FROM scheduled_messages
         ${queue.has("status") ? "WHERE status IN ('queued', 'held')" : ""}`,
      )
      .get() as { n: number; earliest: number | null };
    const undeliveredEvents = deliveries.has("failed_at")
      ? (
          db
            .prepare("SELECT COUNT(*) AS n FROM event_deliveries WHERE failed_at IS NULL")
            .get() as { n: number }
        ).n
      : 0;
    // Before v12 sessions had no expiry. That upgrade gives each one 30 days
    // from when it was last seen, so count them the way it will.
    const liveSessions = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE ${
          sessions.has("expires_at") ? "expires_at" : "last_seen_at + 2592000000"
        } > ?`,
      )
      .get(now) as { n: number };
    return {
      appAddresses: [...byOrigin]
        .map(([origin, uses]) => ({ origin, uses: [...uses].sort() }))
        .sort((a, b) => a.origin.localeCompare(b.origin)),
      scheduled: { waiting: scheduled.n, earliestAt: scheduled.earliest },
      undeliveredEvents,
      sessions: liveSessions.n,
    };
  } finally {
    db.close();
  }
}

/**
 * Replaces `dataDir` with the contents of a backup.
 *
 * The backup is verified and staged beside the target first, so a damaged or
 * incompatible one is rejected while the existing workspace is still intact.
 * Whatever was there is moved aside rather than deleted — an operator who
 * restores the wrong backup should be able to undo it.
 */
export async function restoreWorkspace(opts: {
  backupDir: string;
  dataDir: string;
}): Promise<{ manifest: BackupManifest; supersededDir: string | null }> {
  const dataDir = resolve(opts.dataDir);
  const source = resolve(opts.backupDir);
  await separateDirectories(dataDir, source);
  const manifest = await verifyBackup(source);
  await mkdir(dirname(dataDir), { recursive: true });
  // A workspace something still has open cannot be replaced: the server would
  // go on writing to the copy moved aside, or on Windows stop the move. Held
  // while the backup is staged, so none starts on the old one meanwhile, and
  // let go just before the swap, since on Windows a folder with an open file
  // in it cannot be renamed.
  const hold = existsSync(dataDir) ? holdWorkspace(dataDir, "a restore") : null;
  const staged = await mkdtemp(`${dataDir}.restoring-`);

  let supersededDir: string | null = null;
  try {
    await mkdir(join(staged, FILES));
    await copyFile(join(source, DATABASE), join(staged, DATABASE));
    for (const entry of manifest.files) {
      await copyFile(join(source, FILES, entry.name), join(staged, FILES, entry.name));
    }
    await writeFile(join(staged, MANIFEST), JSON.stringify(manifest, null, 2));
    // Check the bytes we will install, not only the source before copying.
    await verifyBackup(staged);
    hold?.release();
    if (existsSync(dataDir)) {
      supersededDir = `${dataDir}.superseded-${Date.now()}`;
      await rename(dataDir, supersededDir);
    }
    await rename(staged, dataDir);
  } catch (err) {
    hold?.release();
    // Put the original back before reporting, so a failed swap changes nothing.
    if (supersededDir && !existsSync(dataDir)) await rename(supersededDir, dataDir);
    await rm(staged, { recursive: true, force: true });
    throw err;
  }
  return { manifest, supersededDir };
}
