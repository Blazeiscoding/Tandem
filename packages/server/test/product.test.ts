import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { parseIceServers } from "../src/rtc.js";

let server: WorkspaceServer | undefined;
let directory: string | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function start(maxFileSize?: number) {
  directory = mkdtempSync(join(tmpdir(), "slackoss-product-"));
  server = await createWorkspaceServer({
    dataDir: directory,
    port: 0,
    host: "127.0.0.1",
    mdns: false,
    inviteOnly: true,
    maxFileSize,
    iceServers: [{ urls: "turn:relay.example.org:3478", username: "team", credential: "secret" }],
  });
  return `http://127.0.0.1:${server.port}`;
}
async function request(base: string, path: string, token?: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}
const register = (base: string, handle: string, inviteCode?: string) =>
  request(base, "/api/auth/register", undefined, "POST", {
    handle,
    displayName: handle,
    password: "password123",
    inviteCode,
  });

describe("self-hosted product", () => {
  it("streams uploads and downloads and removes partial oversized files", async () => {
    const base = await start(2 * 1024 * 1024);
    const owner = (await register(base, "owner")).data;
    const channel = server!.store.getChannelByName("general")!;
    const body = new Uint8Array(1024 * 1024).fill(42);
    const form = new FormData();
    form.append("file", new Blob([body]), "payload.bin");
    const res = await fetch(`${base}/api/channels/${channel.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: form,
    });
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as { file: { id: string; size: number } };
    expect(file.size).toBe(body.length);
    const downloaded = await fetch(`${base}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(body);
    const oversized = new FormData();
    oversized.append("file", new Blob([new Uint8Array(3 * 1024 * 1024)]), "large.bin");
    const rejected = await fetch(`${base}/api/channels/${channel.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: oversized,
    });
    expect(rejected.status).toBe(413);
    expect(readdirSync(join(directory!, "files"))).toEqual([file.id]);
  });

  it("does not let bot tokens join private channels by posting", async () => {
    const base = await start();
    const owner = (await register(base, "owner")).data;
    const created = (await request(base, "/api/apps", owner.token, "POST", { name: "Build Bot" }))
      .data;
    const channel = (
      await request(base, "/api/channels", owner.token, "POST", {
        type: "private",
        name: "leadership",
      })
    ).data.channel;
    const result = await request(base, "/api/chat.postMessage", created.token, "POST", {
      channel: channel.id,
      text: "unauthorized",
    });
    expect(result.status).toBe(403);
    expect(server!.store.isMember(channel.id, created.app.botUserId)).toBe(false);
    server!.store.addMember(channel.id, created.app.botUserId);
    expect(
      (
        await request(base, "/api/chat.postMessage", created.token, "POST", {
          channel: channel.id,
          text: "authorized",
        })
      ).status,
    ).toBe(200);
  });
  it("keeps relay credentials authenticated and exposes a lightweight health check", async () => {
    const base = await start();
    expect((await request(base, "/api/health")).data).toEqual({ status: "ok" });
    expect((await request(base, "/api/rtc-config")).status).toBe(401);
    const owner = await register(base, "owner");
    expect(
      (await request(base, "/api/rtc-config", owner.data.token)).data.iceServers[0].credential,
    ).toBe("secret");
  });

  it("keeps friends private, requires recipient acceptance, and persists across restart", async () => {
    let base = await start();
    const owner = (await register(base, "owner")).data;
    const invite = (await request(base, "/api/invites", owner.token, "POST", { maxUses: 3 })).data
      .invite.code;
    const bob = (await register(base, "bobby", invite)).data;
    const eve = (await register(base, "evelyn", invite)).data;
    expect((await request(base, `/api/friends/${bob.user.id}`, undefined, "POST")).status).toBe(
      401,
    );
    expect((await request(base, `/api/friends/${owner.user.id}`, owner.token, "POST")).status).toBe(
      400,
    );
    await request(base, `/api/friends/${bob.user.id}`, owner.token, "POST");
    await request(base, `/api/friends/${bob.user.id}`, owner.token, "POST");
    expect((await request(base, "/api/friends", bob.token)).data.friends).toEqual([
      expect.objectContaining({ userId: owner.user.id, status: "incoming" }),
    ]);
    expect((await request(base, "/api/friends", eve.token)).data.friends).toEqual([]);
    expect((await request(base, `/api/friends/${bob.user.id}`, owner.token, "PUT")).status).toBe(
      404,
    );
    expect((await request(base, `/api/friends/${owner.user.id}`, bob.token, "PUT")).status).toBe(
      200,
    );
    await server!.stop();
    server = await createWorkspaceServer({
      dataDir: directory!,
      port: 0,
      host: "127.0.0.1",
      mdns: false,
    });
    base = `http://127.0.0.1:${server.port}`;
    expect((await request(base, "/api/friends", owner.token)).data.friends[0].status).toBe(
      "accepted",
    );
    await request(base, `/api/friends/${owner.user.id}`, bob.token, "DELETE");
    expect((await request(base, "/api/friends", owner.token)).data.friends).toEqual([]);
  });

  it("does not spend an invitation on a duplicate handle", async () => {
    const base = await start();
    const owner = (await register(base, "owner")).data;
    const invite = (await request(base, "/api/invites", owner.token, "POST", { maxUses: 1 })).data
      .invite.code;
    expect((await register(base, "owner", invite)).status).toBe(409);
    expect((await register(base, "bobby", invite)).status).toBe(201);
    expect((await register(base, "evelyn", invite)).status).toBe(403);
  });

  it("creates just one owner under concurrent first registrations", async () => {
    const base = await start();
    const results = await Promise.all([register(base, "alpha"), register(base, "bravo")]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(server!.store.listUsers().filter((u) => u.role === "owner")).toHaveLength(1);
  });

  it.each([null, { type: "hello", token: {}, protocolVersion: 1, lastSeq: null }])(
    "rejects malformed socket messages without crashing: %j",
    async (payload) => {
      const base = await start();
      const ws = new WebSocket(base.replace("http", "ws") + "/ws");
      const closed = new Promise<number>((resolve) => ws.on("close", resolve));
      ws.on("open", () => ws.send(JSON.stringify(payload)));
      expect(await closed).toBe(4000);
      expect((await request(base, "/api/health")).status).toBe(200);
    },
  );

  it("closes unauthenticated sockets during shutdown", async () => {
    const base = await start();
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    await new Promise<void>((resolve) => ws.on("open", resolve));
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    await server!.stop();
    server = undefined;
    await closed;
  });

  it("validates ICE configuration without reflecting secrets in errors", () => {
    expect(parseIceServers(undefined)).toEqual([]);
    expect(
      parseIceServers(
        '[{"urls":["stun:example.org","turn:example.org"],"username":"u","credential":"p"}]',
      ),
    ).toHaveLength(1);
    expect(() => parseIceServers('[{"urls":"https://invalid","credential":"secret"}]')).toThrow(
      "SLACKOSS_ICE_SERVERS must be",
    );
  });
  it("upgrades a workspace that predates message buttons", async () => {
    const base = await start();
    const owner = await request(base, "/api/auth/register", undefined, "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    });
    const channel = server!.store.getChannelByName("general")!;
    const posted = await request(
      base,
      `/api/channels/${channel.id}/messages`,
      owner.data.token,
      "POST",
      {
        text: "written before buttons existed",
        nonce: "old-1",
      },
    );
    expect(posted.status).toBe(201);
    const dir = directory!;
    await server!.stop();
    server = undefined;

    // Wind the schema back to what v8 shipped, data and all.
    const db = new DatabaseSync(join(dir, "workspace.db"));
    db.exec("ALTER TABLE messages DROP COLUMN actions");
    db.exec("ALTER TABLE apps DROP COLUMN interactivity_url");
    db.exec("PRAGMA user_version = 8");
    db.close();

    // Reopening migrates it forward without losing what was there.
    server = await createWorkspaceServer({ dataDir: dir, port: 0, host: "127.0.0.1", mdns: false });
    const reopened = `http://127.0.0.1:${server.port}`;
    const login = await request(reopened, "/api/auth/login", undefined, "POST", {
      handle: "owner",
      password: "password123",
    });
    const messages = await request(
      reopened,
      `/api/channels/${channel.id}/messages`,
      login.data.token,
    );
    const old = messages.data.messages.find((m: { nonce: string }) => m.nonce === "old-1");
    expect(old.text).toBe("written before buttons existed");
    expect(old.actions).toEqual([]);

    // And the new column is really there: writing one would fail without it.
    const after = await request(
      reopened,
      `/api/channels/${channel.id}/messages`,
      login.data.token,
      "POST",
      {
        text: "written after",
        nonce: "new-1",
      },
    );
    expect(after.status).toBe(201);
    expect(after.data.message.actions).toEqual([]);
  });
});
