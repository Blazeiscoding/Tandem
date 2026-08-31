import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type Channel,
  type Message,
  type ReadySnapshot,
  type ServerToClient,
  type User,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";

let server: WorkspaceServer;
let base: string;
let dataDir: string;

beforeAll(async () => {
  // A real directory (not :memory:) so file uploads are exercised too.
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-test-"));
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    workspaceName: "Test Workspace",
    mdns: false,
    logger: process.env.TEST_LOG === "1",
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function api<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

function connectWs(token: string, lastSeq: number | null = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: ServerToClient[] = [];
  const waiters: ((msg: ServerToClient) => void)[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerToClient;
    received.push(msg);
    waiters.splice(0).forEach((w) => w(msg));
  });
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", token, lastSeq, protocolVersion: PROTOCOL_VERSION }));
  });
  const next = (predicate: (m: ServerToClient) => boolean, timeoutMs = 3000) =>
    new Promise<ServerToClient>((resolvePromise, reject) => {
      const hit = received.find(predicate);
      if (hit) return resolvePromise(hit);
      const timer = setTimeout(() => reject(new Error("ws wait timeout")), timeoutMs);
      const check = (m: ServerToClient) => {
        if (predicate(m)) {
          clearTimeout(timer);
          resolvePromise(m);
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  return { ws, received, next };
}

let aliceToken: string;
let alice: User;
let bobToken: string;
let bob: User;

describe("workspace server", () => {
  it("reports server info before setup", async () => {
    const { data } = await api<{ workspaceName: string; userCount: number }>("/api/server-info");
    expect(data.workspaceName).toBe("Test Workspace");
    expect(data.userCount).toBe(0);
  });

  it("makes the first registered user the owner and bootstraps #general", async () => {
    const { status, data } = await api<{ token: string; user: User }>("/api/auth/register", {
      body: { handle: "alice", displayName: "Alice", password: "password123" },
    });
    expect(status).toBe(201);
    expect(data.user.role).toBe("owner");
    aliceToken = data.token;
    alice = data.user;

    const channels = await api<{ channels: Channel[] }>("/api/channels", { token: aliceToken });
    expect(channels.data.channels.map((c) => c.name)).toContain("general");
  });

  it("lets a second user register and auto-join #general", async () => {
    const { status, data } = await api<{ token: string; user: User }>("/api/auth/register", {
      body: { handle: "bob", displayName: "Bob", password: "password123" },
    });
    expect(status).toBe(201);
    expect(data.user.role).toBe("member");
    bobToken = data.token;
    bob = data.user;
  });

  it("rejects bad logins and accepts good ones", async () => {
    const bad = await api("/api/auth/login", { body: { handle: "alice", password: "wrong-pass" } });
    expect(bad.status).toBe(401);
    const good = await api<{ token: string }>("/api/auth/login", {
      body: { handle: "alice", password: "password123" },
    });
    expect(good.status).toBe(200);
  });

  it("delivers messages over WS in realtime with nonce echo", async () => {
    const a = connectWs(aliceToken);
    const b = connectWs(bobToken);
    const readyA = (await a.next((m) => m.type === "ready")) as ReadySnapshot;
    await b.next((m) => m.type === "ready");
    const general = readyA.channels.find((c) => c.name === "general")!;

    const sent = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "hello <@" + bob.id + ">!", nonce: "n-1" },
    });
    expect(sent.status).toBe(201);
    expect(sent.data.message.seq).toBeGreaterThan(0);

    const evt = await b.next(
      (m) => m.type === "event" && m.envelope.event.type === "message.created",
    );
    if (evt.type !== "event" || evt.envelope.event.type !== "message.created") throw new Error();
    expect(evt.envelope.event.message.text).toContain("hello");
    expect(evt.envelope.event.message.nonce).toBe("n-1");
    expect(evt.envelope.seq).toBe(evt.envelope.event.message.seq);

    a.ws.close();
    b.ws.close();
  });

  it("replays missed events on reconnect", async () => {
    // Bob is offline; Alice keeps talking.
    const general = server.store.getChannelByName("general")!;
    await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "while you were away" },
    });

    const b = connectWs(bobToken, 1); // way behind: everything after seq 1 replays
    await b.next((m) => m.type === "ready");
    const replayed = await b.next(
      (m) =>
        m.type === "event" &&
        m.envelope.event.type === "message.created" &&
        m.envelope.event.message.text === "while you were away",
    );
    expect(replayed.type).toBe("event");
    b.ws.close();
  });

  it("keeps private channels invisible to non-members", async () => {
    const created = await api<{ channel: Channel }>("/api/channels", {
      token: aliceToken,
      body: { type: "private", name: "secret-plans" },
    });
    expect(created.status).toBe(201);

    const bobView = await api<{ channels: Channel[] }>("/api/channels", { token: bobToken });
    expect(bobView.data.channels.map((c) => c.name)).not.toContain("secret-plans");

    const denied = await api(`/api/channels/${created.data.channel.id}/messages`, {
      token: bobToken,
    });
    expect(denied.status).toBe(404);
  });

  it("dedupes DMs on the same member pair", async () => {
    const dm1 = await api<{ channel: Channel }>("/api/channels", {
      token: aliceToken,
      body: { type: "dm", memberIds: [bob.id] },
    });
    const dm2 = await api<{ channel: Channel }>("/api/channels", {
      token: bobToken,
      body: { type: "dm", memberIds: [alice.id] },
    });
    expect(dm1.data.channel.id).toBe(dm2.data.channel.id);
    expect(dm1.data.channel.memberIds).toHaveLength(2);
  });

  it("supports threads, edits, deletes, and reactions", async () => {
    const general = server.store.getChannelByName("general")!;
    const root = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "thread root" },
    });
    const reply = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: bobToken,
      body: { text: "thread reply", threadRootId: root.data.message.id },
    });
    expect(reply.status).toBe(201);

    const history = await api<{ messages: Message[] }>(
      `/api/channels/${general.id}/messages`,
      { token: aliceToken },
    );
    const rootInHistory = history.data.messages.find((m) => m.id === root.data.message.id)!;
    expect(rootInHistory.replyCount).toBe(1);
    // Replies don't appear in the top-level history.
    expect(history.data.messages.find((m) => m.id === reply.data.message.id)).toBeUndefined();

    const edited = await api<{ message: Message }>(`/api/messages/${root.data.message.id}`, {
      method: "PATCH",
      token: aliceToken,
      body: { text: "thread root (edited)" },
    });
    expect(edited.data.message.editedAt).not.toBeNull();

    const foreignEdit = await api(`/api/messages/${root.data.message.id}`, {
      method: "PATCH",
      token: bobToken,
      body: { text: "hijack" },
    });
    expect(foreignEdit.status).toBe(403);

    const react = await api(
      `/api/messages/${root.data.message.id}/reactions/${encodeURIComponent("👍")}`,
      { method: "PUT", token: bobToken },
    );
    expect(react.status).toBe(200);
    const afterReact = await api<{ messages: Message[] }>(
      `/api/channels/${general.id}/messages`,
      { token: aliceToken },
    );
    const withReaction = afterReact.data.messages.find((m) => m.id === root.data.message.id)!;
    expect(withReaction.reactions).toEqual([{ emoji: "👍", userIds: [bob.id] }]);

    const del = await api(`/api/messages/${reply.data.message.id}`, {
      method: "DELETE",
      token: bobToken,
    });
    expect(del.status).toBe(200);
  });

  it("searches messages with FTS and respects channel access", async () => {
    const general = server.store.getChannelByName("general")!;
    await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "the quarterly zebra report is ready" },
    });
    const secret = server.store.getChannelByName("secret-plans")!;
    await api(`/api/channels/${secret.id}/messages`, {
      token: aliceToken,
      body: { text: "secret zebra heist" },
    });

    const bobSearch = await api<{ messages: Message[] }>("/api/search?q=zebra", {
      token: bobToken,
    });
    expect(bobSearch.data.messages).toHaveLength(1);
    expect(bobSearch.data.messages[0]!.text).toContain("quarterly");

    const aliceSearch = await api<{ messages: Message[] }>("/api/search?q=zebra", {
      token: aliceToken,
    });
    expect(aliceSearch.data.messages).toHaveLength(2);
  });

  it("uploads a file, attaches it to a message, and gates access by channel", async () => {
    const general = server.store.getChannelByName("general")!;

    // A 1x1 red PNG — real bytes, so the header parser has something to measure.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "red-dot.png");

    const uploadRes = await fetch(`${base}/api/channels/${general.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}` },
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const { file } = (await uploadRes.json()) as { file: { id: string; width: number; height: number; size: number } };
    expect(file.width).toBe(1);
    expect(file.height).toBe(1);
    expect(file.size).toBe(png.byteLength);

    const sent = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "", fileIds: [file.id] },
    });
    expect(sent.status).toBe(201);
    expect(sent.data.message.files).toHaveLength(1);
    expect(sent.data.message.files[0]!.name).toBe("red-dot.png");

    // Bob is in #general, so he can fetch the bytes.
    const download = await fetch(`${base}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await download.arrayBuffer()).equals(png)).toBe(true);

    // Anonymous requests get nothing.
    expect((await fetch(`${base}/api/files/${file.id}`)).status).toBe(401);

    // Deleting the message removes the blob too.
    const del = await api(`/api/messages/${sent.data.message.id}`, {
      method: "DELETE",
      token: aliceToken,
    });
    expect(del.status).toBe(200);
    const afterDelete = await fetch(`${base}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(afterDelete.status).toBe(404);
  });

  it("rejects an empty message with no attachments", async () => {
    const general = server.store.getChannelByName("general")!;
    const res = await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "   " },
    });
    expect(res.status).toBe(400);
  });

  it("keeps uploads out of channels the user cannot see", async () => {
    const secret = server.store.getChannelByName("secret-plans")!;
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("classified")], { type: "text/plain" }), "plan.txt");
    const res = await fetch(`${base}/api/channels/${secret.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobToken}` },
      body: form,
    });
    expect(res.status).toBe(404);
  });

  it("marks channels read", async () => {
    const general = server.store.getChannelByName("general")!;
    const res = await api(`/api/channels/${general.id}/read`, {
      token: bobToken,
      body: { seq: 999 },
    });
    expect(res.status).toBe(200);
  });

  it("enforces invite-only registration when enabled", async () => {
    server.store.setMeta("invite_only", "1");
    const noInvite = await api("/api/auth/register", {
      body: { handle: "carol", displayName: "Carol", password: "password123" },
    });
    expect(noInvite.status).toBe(403);

    const invite = await api<{ invite: { code: string } }>("/api/invites", {
      token: aliceToken,
      body: {},
    });
    const withInvite = await api("/api/auth/register", {
      body: {
        handle: "carol",
        displayName: "Carol",
        password: "password123",
        inviteCode: invite.data.invite.code,
      },
    });
    expect(withInvite.status).toBe(201);
    server.store.setMeta("invite_only", "0");
  });
});
