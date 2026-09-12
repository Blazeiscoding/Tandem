import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openDb,
  openDbAtVersion,
  SCHEMA_VERSION,
  UPGRADE_BACKUP_DIR,
  UPGRADE_BACKUPS_KEPT,
} from "../src/db.js";
import { createWorkspaceServer } from "../src/server.js";

let dir: string;
let file: string;
const copiesDir = () => join(dir, UPGRADE_BACKUP_DIR);
const copies = () => (existsSync(copiesDir()) ? readdirSync(copiesDir()).sort() : []);

const versionOf = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

/** A workspace as an older release left it, holding something worth keeping. */
function olderWorkspace(version = SCHEMA_VERSION - 2) {
  const db = openDbAtVersion(file, version);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "workspace_name",
    "Before the upgrade",
  );
  db.close();
  return version;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slackoss-upgrade-"));
  file = join(dir, "workspace.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("upgrading a workspace", () => {
  it("copies it first, as it was, and then upgrades it", async () => {
    const from = olderWorkspace();
    let reported = "";
    const db = openDb(file, undefined, { onUpgradeBackup: (path) => (reported = path) });
    db.close();

    expect(versionOf(file)).toBe(SCHEMA_VERSION);
    expect(copies()).toHaveLength(1);
    expect(reported).toBe(join(copiesDir(), copies()[0]!));
    // What rolling back needs: the old schema, and the data that was in it.
    expect(versionOf(reported)).toBe(from);
    const copy = new DatabaseSync(reported, { readOnly: true });
    try {
      expect(
        copy.prepare("SELECT value FROM meta WHERE key = 'workspace_name'").get(),
      ).toMatchObject({ value: "Before the upgrade" });
    } finally {
      copy.close();
    }
  });

  it("takes no copy of a workspace that is new, or already current", () => {
    openDb(file).close();
    expect(copies()).toEqual([]);
    openDb(file).close();
    expect(copies()).toEqual([]);
  });

  it("keeps only the most recent copies", () => {
    mkdirSync(copiesDir(), { recursive: true });
    for (let day = 1; day <= UPGRADE_BACKUPS_KEPT + 1; day++) {
      writeFileSync(
        join(copiesDir(), `workspace-v${day}-before-v${day + 1}-2020-01-0${day}T00-00-00-000Z.db`),
        "",
      );
    }
    // Something else a person put in there is theirs, not ours to delete.
    writeFileSync(join(copiesDir(), "my-own-backup.db"), "");
    olderWorkspace();
    openDb(file).close();

    const kept = copies().filter((name) => name.startsWith("workspace-"));
    expect(kept).toHaveLength(UPGRADE_BACKUPS_KEPT);
    // The one just taken survives; the oldest ones are what go.
    expect(kept.some((name) => name.includes(`before-v${SCHEMA_VERSION}-`))).toBe(true);
    expect(kept.some((name) => name.includes("2020-01-01"))).toBe(false);
    expect(kept.some((name) => name.includes("2020-01-02"))).toBe(false);
    expect(copies()).toContain("my-own-backup.db");
  });

  it("refuses to upgrade when the copy cannot be made, and changes nothing", () => {
    const from = olderWorkspace();
    // A file where the directory should go: the copy has nowhere to be written.
    writeFileSync(copiesDir(), "in the way");

    expect(() => openDb(file)).toThrow(/has not been upgraded and nothing has changed/);
    expect(versionOf(file)).toBe(from);
    // And nothing is left holding the file, which on Windows would stop the
    // host from moving the workspace aside to deal with it.
    renameSync(file, `${file}.moved`);
    expect(existsSync(`${file}.moved`)).toBe(true);
  });

  it("can be told not to, by someone who has just taken their own backup", () => {
    olderWorkspace();
    openDb(file, undefined, { backupBeforeUpgrade: false }).close();
    expect(versionOf(file)).toBe(SCHEMA_VERSION);
    expect(copies()).toEqual([]);
  });

  it("says where the copy went when a server upgrades on start", async () => {
    olderWorkspace();
    const server = await createWorkspaceServer({
      dataDir: dir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
    });
    try {
      expect(server.upgradeBackup).not.toBeNull();
      expect(existsSync(server.upgradeBackup!)).toBe(true);
    } finally {
      await server.stop();
    }
    const again = await createWorkspaceServer({
      dataDir: dir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
    });
    try {
      expect(again.upgradeBackup).toBeNull();
    } finally {
      await again.stop();
    }
  });
});
