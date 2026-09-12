import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
let token: string;
let userId: string;
let channelId: string;

async function start(opts: { retentionDays?: number } = {}) {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    ...opts,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function api(path: string, method: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function signIn() {
  const registered = await api("/api/auth/register", "POST", {
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  token = registered.body.token;
  userId = registered.body.user.id;
  channelId = server!.store.getChannelByName("general")!.id;
}

async function post(text: string, extra: Record<string, unknown> = {}) {
  const { body } = await api(`/api/channels/${channelId}/messages`, "POST", { text, ...extra });
  return body.message as { id: string; channelId: string };
}

async function attach(name: string) {
  const form = new FormData();
  form.append("file", new Blob(["attachment bytes"]), name);
  const uploaded = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return ((await uploaded.json()) as { file: { id: string } }).file.id;
}

/** Everything the event log holds, as the raw text it is stored as. */
function loggedPayloads(): string {
  return JSON.stringify(server!.store.eventsSince(0, userId, 100_000) ?? []);
}

/**
 * Makes rows old. Only time can otherwise do this, and a test that waited a day
 * would not be a test. A second connection is how it reaches past the store's
 * own API; WAL lets the server's connection see the change.
 */
function backdate(days: number) {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    db.exec(`UPDATE messages SET created_at = created_at - ${days * 24 * 3600_000}`);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slackoss-retention-"));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("what deleting a message actually reaches", () => {
  beforeEach(async () => {
    await start();
    await signIn();
  });

  it("takes the words out of the event log, not just out of the channel", async () => {
    const secret = "the-sentence-i-regret-writing";
    const message = await post(secret);
    expect(loggedPayloads()).toContain(secret);

    expect((await api(`/api/messages/${message.id}`, "DELETE")).status).toBe(200);
    // The channel no longer shows it, which was never the hard part.
    expect(server!.store.getMessage(message.id)).toBeNull();
    // The log is where the copy lived on disk, readable by anyone who can read
    // the file, for as long as the log is kept.
    expect(loggedPayloads()).not.toContain(secret);
  });

  it("takes the attachment's name too, which often says as much", async () => {
    const fileId = await attach("severance-agreement-final.pdf");
    const message = await post("here it is", { fileIds: [fileId] });
    expect(loggedPayloads()).toContain("severance-agreement-final.pdf");

    await api(`/api/messages/${message.id}`, "DELETE");
    expect(loggedPayloads()).not.toContain("severance-agreement-final.pdf");
  });

  it("takes the first draft when someone edits instead of deleting", async () => {
    const wrong = "i think dana is the problem here";
    const message = await post(wrong);
    const edited = await api(`/api/messages/${message.id}`, "PATCH", {
      text: "i think the process is the problem here",
    });
    expect(edited.status).toBe(200);

    const log = loggedPayloads();
    expect(log).not.toContain(wrong);
    // The correction itself is still there; only what it replaced is gone.
    expect(log).toContain("i think the process is the problem here");
  });

  it("leaves the events themselves in place, so nobody is sent back for a snapshot", async () => {
    const before = server!.store.currentSeq();
    const message = await post("something to take back");
    await api(`/api/messages/${message.id}`, "DELETE");

    // A client that was away since `before` replays the posting and then the
    // deletion, and lands where it would have anyway. Removing the events
    // instead would leave a gap it would read as having fallen off the log.
    const replay = server!.store.eventsSince(before, userId) ?? [];
    const types = replay.map((e) => e.event.type);
    expect(types).toContain("message.created");
    expect(types).toContain("message.deleted");
    const created = replay.find((e) => e.event.type === "message.created")!;
    expect((created.event as any).message.id).toBe(message.id);
    expect((created.event as any).message.text).toBe("");
  });

  it("takes everyone's replies down with a thread root, and says so", async () => {
    const root = await post("the opening message");
    const reply = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "somebody else's answer",
      threadRootId: root.id,
    });
    expect(reply.status).toBe(201);

    await api(`/api/messages/${root.id}`, "DELETE");
    // Not a thread with a removed top: no thread at all. This is documented in
    // DEPLOYMENT.md because it is surprising, and pinned here because a change
    // to it would be a change to what deleting means.
    const thread = await api(`/api/channels/${channelId}/threads/${root.id}`, "GET");
    expect(thread.status).toBe(404);
    expect(thread.body.error).toBe("thread_not_found");
    expect((await api(`/api/threads/followed`, "GET")).body.threads).toEqual([]);
    // The reply's own words are still stored, out of anyone's reach.
    expect(server!.store.getMessage(reply.body.message.id)?.text).toBe("somebody else's answer");
  });

  it("takes the pins and saves that pointed at it", async () => {
    const message = await post("pin me");
    expect((await api(`/api/messages/${message.id}/pin`, "PUT")).status).toBe(200);
    expect((await api(`/api/messages/${message.id}/save`, "PUT")).status).toBe(200);
    expect((await api(`/api/channels/${channelId}/pins`, "GET")).body.messages).toHaveLength(1);

    await api(`/api/messages/${message.id}`, "DELETE");
    expect((await api(`/api/channels/${channelId}/pins`, "GET")).body.messages).toEqual([]);
    expect((await api("/api/saved", "GET")).body.messages).toEqual([]);
  });
});

describe("a retention window", () => {
  it("is off unless the host asks for one", async () => {
    await start();
    await signIn();
    const message = await post("from a long time ago");
    backdate(400);

    expect(server!.applyRetention()).toBe(0);
    expect(server!.store.getMessage(message.id)).not.toBeNull();
  });

  it("refuses a window that is not a number of days", async () => {
    await expect(
      createWorkspaceServer({
        dataDir: directory,
        host: "127.0.0.1",
        port: 0,
        mdns: false,
        retentionDays: -1,
      }),
    ).rejects.toThrow(/retentionDays/);
  });

  it("discards what is past the window and keeps what is not", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const old = await post("said last quarter");
    backdate(60);
    const recent = await post("said this morning");

    expect(server!.applyRetention()).toBe(1);
    expect(server!.store.getMessage(old.id)).toBeNull();
    expect(server!.store.getMessage(recent.id)).not.toBeNull();
  });

  it("leaves nothing of what it discards, in the log or on disk", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const secret = "a-number-nobody-should-still-have";
    const fileId = await attach("old-invoice.pdf");
    await post(secret, { fileIds: [fileId] });
    const blob = join(directory, "files", fileId);
    expect(existsSync(blob)).toBe(true);
    backdate(60);

    expect(server!.applyRetention()).toBe(1);
    await server!.flushFileDeletions();
    const log = loggedPayloads();
    expect(log).not.toContain(secret);
    expect(log).not.toContain("old-invoice.pdf");
    expect(existsSync(blob)).toBe(false);
  });

  it("keeps a thread whose newest reply is still inside the window", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const root = await post("started this long ago");
    backdate(60);
    const reply = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "still talking about it",
      threadRootId: root.id,
    });
    expect(reply.status).toBe(201);

    // A reply hanging under nothing reads as a broken database rather than as
    // a window doing its job, so the root waits for the conversation to end.
    expect(server!.applyRetention()).toBe(0);
    expect(server!.store.getMessage(root.id)).not.toBeNull();
  });

  it("takes a thread's replies with its root once the whole thing is past it", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    const root = await post("a conversation that finished");
    const reply = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "and here is the last word on it",
      threadRootId: root.id,
    });
    backdate(60);

    expect(server!.applyRetention()).toBe(2);
    expect(server!.store.getMessage(root.id)).toBeNull();
    expect(server!.store.getMessage(reply.body.message.id)).toBeNull();
  });

  it("does not send everyone back for a new snapshot when it runs", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    await post("old one");
    backdate(60);
    const cursor = server!.store.currentSeq();
    await post("new one");

    expect(server!.applyRetention()).toBe(1);
    // Null here would mean the client had fallen off the log, which a tidy-up
    // of year-old messages has no business causing.
    expect(server!.store.eventsSince(cursor, userId)).not.toBeNull();
  });

  it("leaves the workspace usable afterwards", async () => {
    await start({ retentionDays: 30 });
    await signIn();
    await post("ancient history");
    backdate(60);
    server!.applyRetention();

    // The rows it removed were referenced by six other tables; a foreign key it
    // missed would surface here rather than at the delete.
    const posted = await api(`/api/channels/${channelId}/messages`, "POST", {
      text: "carrying on",
    });
    expect(posted.status).toBe(201);
    const listed = await api(`/api/channels/${channelId}/messages`, "GET");
    expect(listed.body.messages.map((m: { text: string }) => m.text)).toContain("carrying on");
  });
});
