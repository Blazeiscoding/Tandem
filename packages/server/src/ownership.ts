import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

/** Held by whichever process has the workspace open for writing. */
export const WORKSPACE_LOCK = "workspace.lock";
/** Who holds it, for the message a second process is refused with. */
export const WORKSPACE_OWNER = "workspace.owner.json";

export interface WorkspaceOwner {
  /** What holds it: a server, a restore, an account recovery. */
  purpose: string;
  pid: number;
  hostname: string;
  startedAt: number;
  /** The port it serves on, once it is listening. */
  port: number | null;
}

/** Another process already has this workspace open for writing. */
export class WorkspaceInUseError extends Error {
  readonly code = "workspace_in_use";
  readonly dataDir: string;
  /** Null when the holder has not said who it is, or said it unreadably. */
  readonly owner: WorkspaceOwner | null;
  constructor(dataDir: string, owner: WorkspaceOwner | null) {
    super(
      `This workspace is already open in another process${describe(owner)}. ` +
        `Stop that one first, or use a different data directory. (${dataDir})`,
    );
    this.dataDir = dataDir;
    this.owner = owner;
  }
}

function describe(owner: WorkspaceOwner | null): string {
  if (!owner) return "";
  const parts = [`${owner.purpose}, process ${owner.pid} on ${owner.hostname}`];
  if (owner.port !== null) parts.push(`serving on port ${owner.port}`);
  parts.push(`since ${new Date(owner.startedAt).toISOString()}`);
  return ` (${parts.join(", ")})`;
}

export interface WorkspaceHold {
  /** Records the port once the server is listening, for anyone refused later. */
  describe(update: Partial<Pick<WorkspaceOwner, "port">>): void;
  /** Lets the workspace be opened again. Safe to call more than once. */
  release(): void;
}

/**
 * Takes the workspace in `dataDir` for this process alone, or throws
 * WorkspaceInUseError if another process, or another server in this one,
 * already has it.
 *
 * Two servers on one folder each keep their own count of its attachments and
 * run their own schedulers and clean-up, so each can pass a storage cap the
 * other has already reached. Refusing the second before it opens the database
 * is the only way to keep one owner's view of the folder true.
 *
 * The lock is SQLite's own file lock on a small database beside the workspace,
 * held by a write transaction that is never committed. That makes it the
 * operating system's to release: when the holder exits or crashes, the lock
 * goes with it, so there is no stale lock file to judge and no process id to
 * trust. It is taken on the file itself, so two spellings of the same folder,
 * or a link to it, find the same lock. It is advisory, and as reliable as file
 * locking on the filesystem holding the folder: a network share may not honour
 * it, and SQLite's documentation advises against keeping a database on one.
 *
 * Reading the workspace, as a backup does, needs no hold.
 */
export function holdWorkspace(dataDir: string, purpose: string): WorkspaceHold {
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true });
  const lock = new DatabaseSync(join(dir, WORKSPACE_LOCK));
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    // A write-ahead log would keep its locks in a shared-memory file; the
    // rollback journal keeps them on the database file, where they belong here.
    lock.exec("PRAGMA journal_mode = DELETE");
    lock.exec("BEGIN IMMEDIATE");
  } catch (err) {
    lock.close();
    if (/locked|busy/i.test((err as Error).message)) {
      throw new WorkspaceInUseError(dir, readOwner(dir));
    }
    throw err;
  }

  const owner: WorkspaceOwner = {
    purpose,
    pid: process.pid,
    hostname: hostname(),
    startedAt: Date.now(),
    port: null,
  };
  const ownerFile = join(dir, WORKSPACE_OWNER);
  const writeOwner = () => {
    // Only what someone refused needs to recognise the holder: no address a
    // stranger could use, and nothing secret.
    try {
      const staged = `${ownerFile}.${process.pid}.tmp`;
      writeFileSync(staged, JSON.stringify(owner));
      renameSync(staged, ownerFile);
    } catch {
      // The description is a courtesy; the lock is what keeps the workspace safe.
    }
  };
  writeOwner();

  let held = true;
  return {
    describe(update) {
      if (!held) return;
      Object.assign(owner, update);
      writeOwner();
    },
    release() {
      if (!held) return;
      held = false;
      try {
        rmSync(ownerFile, { force: true });
      } catch {
        // A leftover description is overwritten by the next holder.
      }
      try {
        lock.exec("ROLLBACK");
      } finally {
        lock.close();
      }
    },
  };
}

function readOwner(dir: string): WorkspaceOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, WORKSPACE_OWNER), "utf8")) as WorkspaceOwner;
    return typeof value.pid === "number" && typeof value.purpose === "string" ? value : null;
  } catch {
    return null;
  }
}
