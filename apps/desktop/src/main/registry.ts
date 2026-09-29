import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { holdWorkspace } from "@slackoss/server/ownership";

/**
 * A workspace this computer hosts, as the settings file remembers it. The
 * folder is fixed when the entry is made and never follows the name, so two
 * workspaces can share a name and a rename moves nothing.
 */
export interface HostedWorkspace {
  /** The server's `workspace_id`. Null until a folder adopted without one has started. */
  id: string | null;
  /** A single name under the hosted folder. */
  folder: string;
  /** What the server called itself when it last started. The server is the authority. */
  name: string;
  port: number;
  /**
   * Whether someone chose `port`. A chosen port is kept even when it is busy,
   * and the workspace does not start; an automatic one may move to a free port.
   * Absent in entries saved before this was recorded.
   */
  portChosen?: boolean;
  lastHostedAt: number;
  /** When a backup of it last finished, if one has. */
  lastBackupAt?: number;
  /** Backing it up by itself, into a folder the host chose, keeping the newest few. */
  autoBackup?: AutoBackup;
  /**
   * When it was restored from a backup, until someone puts it back in use.
   * Until then it starts only on its own, for looking inside: nothing queued
   * is sent, no app is called, and only this computer can reach it.
   */
  restoredHold?: number;
}

/** How often, and where, a workspace is backed up without being asked. */
export interface AutoBackup {
  /** An absolute path the host chose in the system's folder dialog. */
  destination: string;
  /** 1 for daily, 7 for weekly. */
  everyDays: 1 | 7;
  /** How many of its own backups to keep there; older ones are removed. */
  keep: number;
  /**
   * When this schedule last made a backup into its destination. Absent until
   * it has, so a new or changed destination is due at once, whatever other
   * backups the workspace has had elsewhere.
   */
  lastAt?: number;
}

/** A schedule as stored, or undefined when it is not one this version can follow. */
export function parseAutoBackup(value: unknown): AutoBackup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { destination, everyDays, keep, lastAt } = value as Record<string, unknown>;
  if (typeof destination !== "string" || !isAbsolute(destination)) return undefined;
  if (everyDays !== 1 && everyDays !== 7) return undefined;
  if (typeof keep !== "number" || !Number.isInteger(keep) || keep < 1 || keep > 60)
    return undefined;
  const schedule: AutoBackup = { destination, everyDays, keep };
  // A time it cannot read only makes the next backup due sooner.
  if (typeof lastAt === "number" && Number.isFinite(lastAt) && lastAt >= 0)
    schedule.lastAt = lastAt;
  return schedule;
}

/** The settings key the registry lives under. */
export const REGISTRY_KEY = "hostedWorkspaces";

/**
 * Plain lowercase letters, digits and hyphens, one path segment. A hand-edited
 * entry cannot point outside the hosted folder, and every folder earlier
 * versions made already fits.
 */
const FOLDER = /^[a-z0-9-]{1,64}$/;

/** A present registry must never be mistaken for a missing, migratable one. */
export class RegistryFormatError extends Error {
  constructor(kind: "newer" | "unsupported" | "invalid") {
    super(
      kind === "newer"
        ? "The hosted workspace list was saved by a newer version of Gatherline. Update Gatherline to open it; the list was not changed."
        : kind === "unsupported"
          ? "The hosted workspace list has a version this Gatherline cannot read. Use a compatible version; the list was not changed."
          : "The hosted workspace list in settings is invalid. Restore or repair the settings file before hosting; the list was not changed.",
    );
    this.name = "RegistryFormatError";
  }
}

/** The folder earlier versions derived from a typed name. Kept so upgrades find it. */
export function legacyFolder(workspaceName: string): string {
  return (
    workspaceName
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "workspace"
  );
}

/** A folder for a new workspace, unrelated to its name. */
export function newFolder(): string {
  return `w-${randomUUID().replaceAll("-", "")}`;
}

/**
 * Reads the registry back. Only `undefined` means the key is absent and may
 * be migrated from legacy folders. A present registry with an unreadable
 * format fails closed; malformed individual version-1 entries are dropped so
 * the rest stays usable.
 */
export function parseRegistry(value: unknown): HostedWorkspace[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RegistryFormatError("invalid");
  const { version, workspaces } = value as Record<string, unknown>;
  if (version !== 1)
    throw new RegistryFormatError(
      typeof version === "number" && version > 1 ? "newer" : "unsupported",
    );
  if (!Array.isArray(workspaces)) throw new RegistryFormatError("invalid");
  const folders = new Set<string>();
  const ids = new Set<string>();
  const entries: HostedWorkspace[] = [];
  for (const raw of workspaces) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const {
      id,
      folder,
      name,
      port,
      portChosen,
      lastHostedAt,
      lastBackupAt,
      autoBackup,
      restoredHold,
    } = raw as Record<string, unknown>;
    if (typeof folder !== "string" || !FOLDER.test(folder) || folders.has(folder)) continue;
    if (id !== null && (typeof id !== "string" || !id || ids.has(id))) continue;
    if (typeof name !== "string" || !name.trim() || name.length > 80) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) continue;
    if (typeof lastHostedAt !== "number" || !Number.isFinite(lastHostedAt)) continue;
    folders.add(folder);
    if (id) ids.add(id);
    entries.push({
      id,
      folder,
      name,
      port,
      ...(typeof portChosen === "boolean" ? { portChosen } : {}),
      lastHostedAt,
      ...(typeof lastBackupAt === "number" && Number.isFinite(lastBackupAt)
        ? { lastBackupAt }
        : {}),
      ...(parseAutoBackup(autoBackup) ? { autoBackup: parseAutoBackup(autoBackup) } : {}),
      // Anything present holds it: a hold that cannot be read is still a hold.
      ...(restoredHold !== undefined
        ? {
            restoredHold:
              typeof restoredHold === "number" && Number.isFinite(restoredHold) ? restoredHold : 0,
          }
        : {}),
    });
  }
  return entries;
}

export function serializeRegistry(entries: HostedWorkspace[]) {
  return { version: 1, workspaces: entries };
}

/**
 * The identity and name a workspace's database holds, read without the server
 * running. Null when there is no database there or it cannot be read.
 */
export function readWorkspace(dataDir: string): { id: string | null; name: string | null } | null {
  const file = join(dataDir, "workspace.db");
  if (!existsSync(file)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const meta = (key: string) =>
      (
        db!.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
          { value: string } | undefined
      )?.value ?? null;
    return { id: meta("workspace_id"), name: meta("workspace_name") };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Writes a new name into a stopped workspace's database, the one place its
 * name is kept. Nothing else in the database changes, and no schema upgrade
 * runs. Throws when there is no database there or it cannot be written.
 */
export function writeWorkspaceName(dataDir: string, name: string): void {
  const file = join(dataDir, "workspace.db");
  // Opening a file that is not there would create an empty database.
  if (!existsSync(file)) throw new Error("There is no workspace database in that folder.");
  // A server started by hand on the same folder would go on under the old name
  // and could write it back, so the rename is refused while one has it.
  const hold = holdWorkspace(dataDir, "a rename");
  try {
    const db = new DatabaseSync(file);
    try {
      // A backup reading the file gets a moment to finish rather than failing
      // the rename at once.
      db.exec("PRAGMA busy_timeout = 2000");
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('workspace_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(name);
    } finally {
      db.close();
    }
  } finally {
    hold.release();
  }
}

/**
 * Adds an entry for every folder under `dataRoot` that holds a database and
 * that no entry names yet: the folders earlier versions made, or any the
 * registry lost. Folders stay where they are. `lastHosted` is what earlier
 * versions remembered; its folder becomes the most recent entry, on its port.
 * Returns the entries to add, and the folders that could not be read.
 */
export async function adoptFolders(options: {
  dataRoot: string;
  known: HostedWorkspace[];
  lastHosted: { workspaceName: string; port: number } | null;
  defaultPort: number;
  now: number;
  read?: typeof readWorkspace;
}): Promise<{ adopted: HostedWorkspace[]; unreadable: string[] }> {
  const read = options.read ?? readWorkspace;
  let names: string[];
  try {
    names = (await readdir(options.dataRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { adopted: [], unreadable: [] };
  }
  const named = new Set(options.known.map((entry) => entry.folder));
  const ids = new Set(options.known.flatMap((entry) => (entry.id ? [entry.id] : [])));
  const remembered = options.lastHosted ? legacyFolder(options.lastHosted.workspaceName) : null;
  const adopted: HostedWorkspace[] = [];
  const unreadable: string[] = [];
  for (const folder of names.sort()) {
    if (!FOLDER.test(folder) || named.has(folder)) continue;
    const dataDir = join(options.dataRoot, folder);
    if (!existsSync(join(dataDir, "workspace.db"))) continue;
    const found = read(dataDir);
    if (!found) {
      unreadable.push(folder);
      continue;
    }
    // A copy of a folder already listed is the same workspace twice. Starting
    // both would give two servers one identity, so the copy is left alone.
    if (found.id && ids.has(found.id)) continue;
    if (found.id) ids.add(found.id);
    const last = folder === remembered;
    adopted.push({
      id: found.id,
      folder,
      name: found.name?.trim().slice(0, 80) || folder,
      port: last ? options.lastHosted!.port : options.defaultPort,
      lastHostedAt: last
        ? options.now
        : await stat(join(dataDir, "workspace.db")).then(
            (info) => Math.min(info.mtimeMs, options.now - 1),
            () => 0,
          ),
    });
  }
  return { adopted, unreadable };
}
