import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupWorkspace,
  restoreWorkspace,
  verifyBackup,
  type BackupManifest,
} from "../src/backup.js";
import { SCHEMA_VERSION } from "../src/db.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer | undefined;
let root: string;
let dataDir: string;
let base: string;

async function api(path: string, token?: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function start() {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    workspaceName: "Backed Up",
  });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "slackoss-backup-"));
  dataDir = join(root, "data");
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.stop();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A workspace with something of every kind worth losing. */
async function populate() {
  const owner = (
    await api("/api/auth/register", undefined, "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body;
  const code = (await api("/api/invites", owner.token, "POST", { maxUses: 5 })).body.invite.code;
  const guest = (
    await api("/api/auth/register", undefined, "POST", {
      handle: "guest",
      displayName: "Guest",
      password: "password123",
      inviteCode: code,
    })
  ).body;
  const general = server!.store.getChannelByName("general")!.id;
  const private_ = (
    await api("/api/channels", owner.token, "POST", { type: "private", name: "leadership" })
  ).body.channel;
  await api(`/api/channels/${private_.id}/invite-member`, owner.token, "POST", {
    userId: guest.user.id,
  });
  await api(`/api/friends/${guest.user.id}`, owner.token, "POST");
  await api(`/api/friends/${owner.user.id}`, guest.token, "PUT");
  await api(`/api/channels/${general}/messages`, owner.token, "POST", {
    text: "kept across a restore",
  });
  await api(`/api/channels/${private_.id}/scheduled`, owner.token, "POST", {
    text: "still queued",
    sendAt: Date.now() + 3_600_000,
  });

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3, 4, 5])]), "attachment.bin");
  const uploaded = await fetch(`${base}/api/channels/${general}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
    body: form,
  });
  const { file } = (await uploaded.json()) as { file: { id: string } };
  await api(`/api/channels/${general}/messages`, owner.token, "POST", {
    text: "with a file",
    fileIds: [file.id],
  });
  return { owner, guest, general, private: private_, fileId: file.id };
}

describe("backup and restore", () => {
  it("refuses to certify a snapshot whose attachment has disappeared", async () => {
    const world = await populate();
    await server!.stop();
    rmSync(join(dataDir, "files", world.fileId));
    const out = join(root, "incomplete");
    await expect(backupWorkspace({ dataDir, out })).rejects.toThrow();
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
  });

  it("uses the copied database for counts when the live workspace changes before capture", async () => {
    const world = await populate();
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "VACUUM INTO ?") {
        server!.store.createChannel({
          type: "public",
          name: "during-backup",
          creatorId: world.owner.user.id,
          memberIds: [world.owner.user.id],
        });
      }
      return prepare.call(this, sql);
    });
    const out = join(root, "live-backup");
    const manifest = await backupWorkspace({ dataDir, out });
    expect(manifest.counts.channels).toBe(3);
    await expect(verifyBackup(out)).resolves.toMatchObject({ counts: { channels: 3 } });
  });

  it("rejects missing inventory entries even when the listed checksums all match", async () => {
    await populate();
    await server!.stop();
    const out = join(root, "backup");
    const manifest = await backupWorkspace({ dataDir, out });
    writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...manifest, files: [] }));
    const before = readFileSync(join(dataDir, "workspace.db"));
    await expect(restoreWorkspace({ backupDir: out, dataDir })).rejects.toThrow(
      /attachment.*missing/,
    );
    expect(readFileSync(join(dataDir, "workspace.db"))).toEqual(before);
  });

  it.each(["../escape", "..\\escape", "C:\\escape", "file:stream"])(
    "rejects unsafe attachment paths: %s",
    async (name) => {
      await populate();
      await server!.stop();
      const out = join(root, "backup");
      const manifest = await backupWorkspace({ dataDir, out });
      manifest.files[0]!.name = name;
      writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
      await expect(restoreWorkspace({ backupDir: out, dataDir })).rejects.toThrow(/manifest/);
    },
  );

  it("checks the actual schema even if a manifest claims an older version", async () => {
    await populate();
    await server!.stop();
    const out = join(root, "backup");
    const manifest: BackupManifest = await backupWorkspace({ dataDir, out });
    const db = new DatabaseSync(join(out, "workspace.db"));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const bytes = readFileSync(join(out, "workspace.db"));
    manifest.database = {
      name: "workspace.db",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyBackup(out)).rejects.toThrow(/newer server/);
  });

  it("rejects overlapping directories without moving the workspace", async () => {
    await populate();
    await server!.stop();
    const before = readFileSync(join(dataDir, "workspace.db"));
    await expect(backupWorkspace({ dataDir, out: join(dataDir, "backup") })).rejects.toThrow(
      /separate/,
    );
    await expect(restoreWorkspace({ backupDir: dataDir, dataDir })).rejects.toThrow(/separate/);
    await expect(restoreWorkspace({ backupDir: dataDir, dataDir: root })).rejects.toThrow(
      /separate/,
    );
    expect(readFileSync(join(dataDir, "workspace.db"))).toEqual(before);
  });

  it("preserves accounts, messages, attachments, memberships, friendships and queued work", async () => {
    const world = await populate();
    const out = join(root, "backup");
    await server!.stop();
    const manifest = await backupWorkspace({ dataDir, out });
    expect(manifest.counts.users).toBe(2);
    expect(manifest.files).toHaveLength(1);

    // Lose the workspace entirely, then bring it back from the backup alone.
    rmSync(dataDir, { recursive: true, force: true });
    const { supersededDir } = await restoreWorkspace({ backupDir: out, dataDir });
    expect(supersededDir).toBeNull();
    await start();

    const login = (
      await api("/api/auth/login", undefined, "POST", { handle: "guest", password: "password123" })
    ).body;
    expect(login.user.id).toBe(world.guest.user.id);
    const messages = (await api(`/api/channels/${world.general}/messages`, login.token)).body
      .messages;
    expect(messages.map((m: { text: string }) => m.text)).toContain("kept across a restore");
    // The guest kept private-channel membership, so this is not a 404.
    expect((await api(`/api/channels/${world.private.id}/messages`, login.token)).status).toBe(200);

    const owner = (
      await api("/api/auth/login", undefined, "POST", { handle: "owner", password: "password123" })
    ).body;
    expect((await api("/api/scheduled", owner.token)).body.scheduled).toHaveLength(1);
    expect((await api("/api/friends", owner.token)).body.friends).toEqual([
      expect.objectContaining({ userId: world.guest.user.id, status: "accepted" }),
    ]);
    const blob = await fetch(`${base}/api/files/${world.fileId}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("refuses a damaged backup before touching the workspace", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });
    const before = readFileSync(join(dataDir, "workspace.db"));

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      files: { name: string }[];
    };
    writeFileSync(join(out, "files", manifest.files[0]!.name), "tampered");
    await expect(verifyBackup(out)).rejects.toThrow(/checksum/);
    await expect(restoreWorkspace({ backupDir: out, dataDir })).rejects.toThrow(/checksum/);
    expect(readFileSync(join(dataDir, "workspace.db"))).toEqual(before);
  });

  it("refuses a backup written by a newer server", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    const manifest = await backupWorkspace({ dataDir, out });
    writeFileSync(
      join(out, "manifest.json"),
      JSON.stringify({ ...manifest, schemaVersion: manifest.schemaVersion + 5 }),
    );
    await expect(verifyBackup(out)).rejects.toThrow(/newer server/);
  });

  it("keeps the superseded workspace rather than deleting it", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });
    const { supersededDir } = await restoreWorkspace({ backupDir: out, dataDir });
    expect(supersededDir).not.toBeNull();
    expect(readFileSync(join(supersededDir!, "workspace.db")).length).toBeGreaterThan(0);
  });

  it("will not write a backup into a directory that already holds something", async () => {
    await populate();
    const out = join(root, "backup");
    await server!.stop();
    await backupWorkspace({ dataDir, out });
    await expect(backupWorkspace({ dataDir, out })).rejects.toThrow(/not empty/);
  });
});
