import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  escapeMrkdwn,
  type Message,
  type ServerToClient,
  type User,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { isPrivateAddress } from "../src/outbound.js";

/** One request the stub app received, unpacked for assertions. */
interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Stands in for the third-party app a command or subscription points at. */
class StubApp {
  server: Server;
  port = 0;
  received: Received[] = [];
  /** Answers the next request; set per test. */
  handler: (req: Received) => { status?: number; body: string; contentType?: string } = () => ({
    body: "",
  });

  constructor() {
    this.server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const entry: Received = {
          url: req.url ?? "",
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, String(v ?? "")]),
          ),
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.received.push(entry);
        const out = this.handler(entry);
        res.writeHead(out.status ?? 200, {
          "content-type": out.contentType ?? "application/json",
        });
        res.end(out.body);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  url(path = "/"): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let server: WorkspaceServer;
let base: string;
let dataDir: string;
let stub: StubApp;
let aliceToken: string;
let alice: User;
let bobToken: string;
let bob: User;
let channelId: string;

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

function connectWs(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: ServerToClient[] = [];
  const waiters: ((msg: ServerToClient) => void)[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerToClient;
    received.push(msg);
    waiters.splice(0).forEach((w) => w(msg));
  });
  ws.on("open", () => {
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    );
  });
  const next = (predicate: (m: ServerToClient) => boolean, timeoutMs = 3000) =>
    new Promise<ServerToClient>((resolve, reject) => {
      const hit = received.find(predicate);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error("ws wait timeout")), timeoutMs);
      const check = (m: ServerToClient) => {
        if (predicate(m)) {
          clearTimeout(timer);
          resolve(m);
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  return { ws, received, next };
}

/** Waits for something the server does asynchronously, without a fixed sleep. */
async function eventually(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition never became true");
}

async function newApp(
  name: string,
): Promise<{ id: string; botUser: User; signingSecret: string; token: string }> {
  const { data } = await api<{
    app: { id: string };
    botUser: User;
    signingSecret: string;
    token: string;
  }>("/api/apps", { token: aliceToken, body: { name } });
  return {
    id: data.app.id,
    botUser: data.botUser,
    signingSecret: data.signingSecret,
    token: data.token,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-integrations-"));
  stub = new StubApp();
  await stub.start();
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    workspaceName: "Integration Test",
    mdns: false,
    // The stub app lives on loopback, which the SSRF guard blocks by default —
    // exactly what a LAN-hosted bot looks like, so this is the flag a real
    // self-hoster would set. The guard itself is covered separately below.
    allowPrivateHooks: true,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;

  const a = await api<{ token: string; user: User }>("/api/auth/register", {
    body: { handle: "alice", displayName: "Alice", password: "password123" },
  });
  aliceToken = a.data.token;
  alice = a.data.user;
  const b = await api<{ token: string; user: User }>("/api/auth/register", {
    body: { handle: "bob", displayName: "Bob", password: "password123" },
  });
  bobToken = b.data.token;
  bob = b.data.user;
  channelId = server.store.getChannelByName("general")!.id;
  server.store.addMember(channelId, bob.id);
});

afterAll(async () => {
  await server.stop();
  await stub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the SSRF guard", () => {
  it("recognises the address ranges an integration URL must not reach", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1", // the same loopback wearing an IPv6 hat
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses a private endpoint unless the host opted in", async () => {
    const guardedDir = mkdtempSync(join(tmpdir(), "slackoss-guarded-"));
    const guarded = await createWorkspaceServer({
      dataDir: guardedDir,
      port: 0,
      mdns: false,
      logger: false,
    });
    const guardedBase = `http://127.0.0.1:${guarded.port}`;
    const reg = await fetch(`${guardedBase}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    const { token } = (await reg.json()) as { token: string };
    const created = await fetch(`${guardedBase}/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Local Bot" }),
    });
    const { app } = (await created.json()) as { app: { id: string } };

    const res = await fetch(`${guardedBase}/api/apps/${app.id}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: stub.url("/events") }),
    });
    const body = (await res.json()) as { error: string; message: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe("blocked_host");
    expect(body.message).toContain("allow-private-hooks");

    await guarded.stop();
    rmSync(guardedDir, { recursive: true, force: true });
  });

  it("rejects a URL that is not http(s), or that carries credentials", async () => {
    const created = await newApp("Scheme Bot");
    for (const url of ["file:///etc/passwd", "http://user:pass@example.com/hook"]) {
      const res = await api(`/api/apps/${created.id}/commands`, {
        token: aliceToken,
        body: { command: "nope", url },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("slash commands", () => {
  it("answers built-ins without any app installed", async () => {
    const res = await api<{ ok: boolean }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/shrug well then" },
    });
    expect(res.status).toBe(200);
    const messages = server.store.listMessages({ channelId, limit: 1 });
    // Stored pre-escaped for the renderer; the UI test pins how it displays.
    // Stored escaped for the renderer; the ui package pins how that displays.
    expect(messages[0]!.text).toBe(`well then ${escapeMrkdwn("¯\\_(ツ)_/¯")}`);
    expect(messages[0]!.userId).toBe(alice.id);
  });

  it("tells you when a command does not exist", async () => {
    const res = await api<{ error: string }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/definitely-not-real" },
    });
    expect(res.status).toBe(404);
    expect(res.data.error).toBe("unknown_command");
  });

  it("sends Slack's form payload and shows the reply privately", async () => {
    const created = await newApp("Deploy Bot");
    const made = await api(`/api/apps/${created.id}/commands`, {
      token: aliceToken,
      body: { command: "/deploy", url: stub.url("/deploy"), description: "Ship it" },
    });
    expect(made.status).toBe(201);

    stub.received.length = 0;
    stub.handler = () => ({ body: JSON.stringify({ text: "deploying *staging*" }) });

    const a = connectWs(aliceToken);
    const b = connectWs(bobToken);
    await a.next((m) => m.type === "ready");
    await b.next((m) => m.type === "ready");

    const res = await api<{ ok: boolean }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/deploy staging now" },
    });
    expect(res.data.ok).toBe(true);

    const sent = stub.received[0]!;
    expect(sent.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(sent.body);
    expect(form.get("command")).toBe("/deploy");
    expect(form.get("text")).toBe("staging now");
    expect(form.get("channel_id")).toBe(channelId);
    expect(form.get("channel_name")).toBe("general");
    expect(form.get("user_id")).toBe(alice.id);
    expect(form.get("user_name")).toBe("alice");
    expect(form.get("response_url")).toContain("/api/commands/response/");

    // Signed the way Slack signs, under both header names.
    const ts = sent.headers["x-slack-request-timestamp"]!;
    const expected = `v0=${createHmac("sha256", created.signingSecret)
      .update(`v0:${ts}:${sent.body}`)
      .digest("hex")}`;
    expect(sent.headers["x-slack-signature"]).toBe(expected);
    expect(sent.headers["x-slackoss-signature"]).toBe(expected);

    const ephemeral = (await a.next(
      (m) => m.type === "ephemeral" && m.event.type === "ephemeral.message",
    )) as { type: "ephemeral"; event: { type: "ephemeral.message"; text: string; userId: string } };
    expect(ephemeral.event.text).toBe("deploying *staging*");
    expect(ephemeral.event.userId).toBe(created.botUser.id);

    // Private means private: it is not in the channel, and Bob never saw it.
    expect(
      server.store.listMessages({ channelId, limit: 5 }).some((m) => m.text.includes("deploying")),
    ).toBe(false);
    expect(
      b.received.some((m) => m.type === "ephemeral" && m.event.type === "ephemeral.message"),
    ).toBe(false);

    a.ws.close();
    b.ws.close();
  });

  it("posts to the whole channel when the app says in_channel", async () => {
    stub.handler = () => ({
      body: JSON.stringify({ response_type: "in_channel", text: "build 412 is green" }),
    });
    await api(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/deploy prod" },
    });
    const latest = server.store.listMessages({ channelId, limit: 1 })[0]!;
    expect(latest.text).toBe("build 412 is green");
    expect(server.store.getUser(latest.userId)!.isBot).toBe(true);
  });

  it("accepts a late reply on the response_url, then stops accepting them", async () => {
    let responseUrl = "";
    stub.handler = (req) => {
      responseUrl = new URLSearchParams(req.body).get("response_url") ?? "";
      return { body: "" }; // acknowledged silently, answer to follow
    };
    await api(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/deploy later" },
    });
    expect(responseUrl).toContain("/api/commands/response/");

    const post = (text: string) =>
      fetch(responseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response_type: "in_channel", text }),
      });

    expect((await post("done, took 61s")).status).toBe(200);
    await eventually(
      () => server.store.listMessages({ channelId, limit: 1 })[0]!.text === "done, took 61s",
    );

    // Slack allows five; the sixth is gone.
    for (let i = 0; i < 4; i++) await post(`extra ${i}`);
    expect((await post("too late")).status).toBe(404);
  });

  it("reports a failing endpoint to the person who typed the command", async () => {
    stub.handler = () => ({ status: 500, body: "boom" });
    const a = connectWs(aliceToken);
    await a.next((m) => m.type === "ready");

    const res = await api<{ ok: boolean; error: string }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/deploy broken" },
    });
    expect(res.data.error).toBe("command_failed");

    const note = (await a.next(
      (m) => m.type === "ephemeral" && m.event.type === "ephemeral.message",
    )) as { type: "ephemeral"; event: { text: string } };
    expect(note.event.text).toContain("500");
    a.ws.close();
  });

  it("refuses to register a command name twice, or over a built-in", async () => {
    const other = await newApp("Rival Bot");
    const clash = await api<{ error: string }>(`/api/apps/${other.id}/commands`, {
      token: aliceToken,
      body: { command: "deploy", url: stub.url("/x") },
    });
    expect(clash.status).toBe(409);
    const builtin = await api<{ error: string }>(`/api/apps/${other.id}/commands`, {
      token: aliceToken,
      body: { command: "/shrug", url: stub.url("/x") },
    });
    expect(builtin.status).toBe(409);
  });

  it("keeps command management to admins", async () => {
    const created = await newApp("Members Cannot");
    const denied = await api(`/api/apps/${created.id}/commands`, {
      token: bobToken,
      body: { command: "nope", url: stub.url("/x") },
    });
    expect(denied.status).toBe(403);
  });
});

describe("outgoing event subscriptions", () => {
  it("requires the url_verification handshake before subscribing", async () => {
    const created = await newApp("Events Bot");

    stub.handler = () => ({ body: JSON.stringify({ challenge: "wrong" }) });
    const refused = await api<{ error: string }>(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/events") },
    });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe("challenge_failed");

    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    const accepted = await api(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/events"), eventTypes: ["message.created"] },
    });
    expect(accepted.status).toBe(201);
  });

  it("delivers signed events for channels the bot is in, and never its own", async () => {
    const created = await newApp("Echo Bot");
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    const sub = await api<{ subscription: { id: string } }>(
      `/api/apps/${created.id}/subscriptions`,
      { token: aliceToken, body: { url: stub.url("/echo"), eventTypes: ["message.created"] } },
    );
    expect(sub.status).toBe(201);
    stub.handler = () => ({ body: "" });

    // Not a member yet: the app must not learn about the channel's traffic.
    stub.received.length = 0;
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "before the bot joined" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.received.filter((r) => r.url === "/echo")).toHaveLength(0);

    server.store.addMember(channelId, created.botUser.id);
    stub.received.length = 0;
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "hello robot" },
    });
    await eventually(() => stub.received.some((r) => r.url === "/echo"));

    const delivered = stub.received.find((r) => r.url === "/echo")!;
    const payload = JSON.parse(delivered.body) as {
      type: string;
      event: { type: string; text: string; channel: string; user: string; ts: string };
      slackoss: { type: string; seq: number };
    };
    expect(payload.type).toBe("event_callback");
    expect(payload.event.type).toBe("message");
    expect(payload.event.text).toBe("hello robot");
    expect(payload.event.channel).toBe(channelId);
    expect(payload.event.user).toBe(alice.id);
    expect(payload.slackoss.type).toBe("message.created");

    const ts = delivered.headers["x-slackoss-request-timestamp"]!;
    expect(delivered.headers["x-slackoss-signature"]).toBe(
      `v0=${createHmac("sha256", created.signingSecret).update(`v0:${ts}:${delivered.body}`).digest("hex")}`,
    );

    // The bot's own message must not come straight back to it — that is the
    // loop every chat integration eventually causes.
    stub.received.length = 0;
    const own = await api<{ ok: boolean }>("/api/chat.postMessage", {
      token: created.token,
      body: { channel: channelId, text: "I am the bot" },
    });
    expect(own.data.ok).toBe(true);
    // Then a message from a person, which must still arrive — proving the
    // silence above is the loop guard and not a broken subscription.
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "and I am not" },
    });
    await eventually(() => stub.received.some((r) => r.body.includes("and I am not")));
    expect(stub.received.some((r) => r.body.includes("I am the bot"))).toBe(false);
  });

  it("only sends the event types a subscription asked for", async () => {
    const created = await newApp("Reactions Only");
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    await api(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/reactions"), eventTypes: ["reaction.added"] },
    });
    stub.handler = () => ({ body: "" });
    server.store.addMember(channelId, created.botUser.id);

    stub.received.length = 0;
    const posted = await api<{ message: { id: string } }>(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "react to me" },
    });
    await fetch(
      `${base}/api/messages/${posted.data.message.id}/reactions/${encodeURIComponent("🎉")}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${aliceToken}` },
      },
    );
    await eventually(() => stub.received.some((r) => r.url === "/reactions"));

    const bodies = stub.received.filter((r) => r.url === "/reactions").map((r) => r.body);
    expect(bodies.every((b) => !b.includes("react to me"))).toBe(true);
    const event = JSON.parse(bodies[0]!) as { event: { type: string; reaction: string } };
    expect(event.event.type).toBe("reaction_added");
    expect(event.event.reaction).toBe("🎉");
  });

  it("stops delivering once the app is deleted", async () => {
    const created = await newApp("Short Lived");
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    await api(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/gone") },
    });
    stub.handler = () => ({ body: "" });
    server.store.addMember(channelId, created.botUser.id);

    await api(`/api/apps/${created.id}`, { token: aliceToken, method: "DELETE" });
    stub.received.length = 0;
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "after deletion" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.received.filter((r) => r.url === "/gone")).toHaveLength(0);
  });
});

describe("interactive buttons", () => {
  /** Accepts the interactivity URL by echoing the verification challenge. */
  const acceptVerification = () => {
    stub.handler = (req) => {
      const body = JSON.parse(req.body) as { challenge?: string };
      return { body: JSON.stringify({ challenge: body.challenge }) };
    };
  };

  it("carries a Block Kit actions block through to a pressable button", async () => {
    const created = await newApp("Deploy Bot");
    acceptVerification();
    const set = await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/interactions") },
    });
    expect(set.status).toBe(200);

    const posted = await api<{ ok: boolean; ts: string; message: Message }>(
      "/api/chat.postMessage",
      {
        token: created.token,
        body: {
          channel: channelId,
          text: "Deploy 412 to production?",
          blocks: [
            {
              type: "actions",
              block_id: "deploy",
              elements: [
                {
                  type: "button",
                  action_id: "approve",
                  text: { type: "plain_text", text: "Approve" },
                  style: "primary",
                  value: "412",
                },
                {
                  type: "button",
                  action_id: "docs",
                  text: { type: "plain_text", text: "Docs" },
                  url: "https://example.com/docs",
                },
                // Not a button, and not something we can draw: dropped rather
                // than shown as something that does nothing.
                { type: "static_select", action_id: "pick" },
                // A button that would hand someone a javascript: URL to click.
                {
                  type: "button",
                  action_id: "sneaky",
                  text: { type: "plain_text", text: "Click" },
                  url: "javascript:alert(1)",
                },
              ],
            },
          ],
        },
      },
    );
    expect(posted.data.message.actions.map((a) => a.actionId)).toEqual([
      "approve",
      "docs",
      "sneaky",
    ]);
    expect(posted.data.message.actions[0]).toMatchObject({
      blockId: "deploy",
      text: "Approve",
      style: "primary",
      value: "412",
      url: null,
    });
    expect(posted.data.message.actions[1]!.url).toBe("https://example.com/docs");
    // The javascript: URL is dropped, so that button calls the app instead of
    // handing the browser a scheme it should never follow.
    expect(posted.data.message.actions[2]!.url).toBeNull();

    // Pressing it delivers Slack's block_actions payload, signed as Slack signs.
    stub.received.length = 0;
    stub.handler = () => ({
      body: JSON.stringify({ replace_original: true, text: "Approved by Bob" }),
    });
    const pressed = await api<{ ok: boolean }>(`/api/messages/${posted.data.ts}/actions`, {
      token: bobToken,
      body: { actionId: "approve" },
    });
    expect(pressed.data.ok).toBe(true);

    const delivered = stub.received[0]!;
    expect(delivered.url).toBe("/interactions");
    const ts = delivered.headers["x-slack-request-timestamp"]!;
    expect(delivered.headers["x-slack-signature"]).toBe(
      `v0=${createHmac("sha256", created.signingSecret).update(`v0:${ts}:${delivered.body}`).digest("hex")}`,
    );
    const payload = JSON.parse(new URLSearchParams(delivered.body).get("payload")!) as {
      type: string;
      user: { id: string };
      actions: { action_id: string; value: string; style?: string }[];
      response_url: string;
      message: { ts: string };
    };
    expect(payload.type).toBe("block_actions");
    expect(payload.user.id).toBe(bob.id);
    expect(payload.actions[0]).toMatchObject({
      action_id: "approve",
      value: "412",
      style: "primary",
    });
    expect(payload.message.ts).toBe(posted.data.ts);

    // replace_original rewrote the message it sat on, and took the buttons.
    const after = await api<{ messages: Message[] }>(`/api/channels/${channelId}/messages`, {
      token: bobToken,
    });
    const updated = after.data.messages.find((m) => m.id === posted.data.ts)!;
    expect(updated.text).toBe("Approved by Bob");
    expect(updated.actions).toEqual([]);

    // And the button is gone for good: pressing it again finds nothing.
    const again = await api<{ error?: string }>(`/api/messages/${posted.data.ts}/actions`, {
      token: bobToken,
      body: { actionId: "approve" },
    });
    expect(again.status).toBe(404);
  });

  it("refuses a button on a message the presser cannot see", async () => {
    const created = await newApp("Private Bot");
    acceptVerification();
    await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/interactions") },
    });
    const { data: madeChannel } = await api<{ channel: { id: string } }>("/api/channels", {
      token: aliceToken,
      body: { type: "private", name: "war-room" },
    });
    server.store.addMember(madeChannel.channel.id, created.botUser.id);

    const posted = await api<{ ts: string }>("/api/chat.postMessage", {
      token: created.token,
      body: {
        channel: madeChannel.channel.id,
        text: "ship it?",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", action_id: "yes", text: { type: "plain_text", text: "Ship" } },
            ],
          },
        ],
      },
    });

    stub.received.length = 0;
    const pressed = await api(`/api/messages/${posted.data.ts}/actions`, {
      token: bobToken,
      body: { actionId: "yes" },
    });
    expect(pressed.status).toBe(404);
    // Nothing was sent onward on behalf of someone who cannot see the message.
    expect(stub.received).toHaveLength(0);
  });

  it("does not accept an interactivity URL that will not answer the handshake", async () => {
    const created = await newApp("Silent Bot");
    stub.handler = () => ({ body: "" });
    const set = await api<{ error: string }>(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/nope") },
    });
    expect(set.status).toBe(400);
    expect(set.data.error).toBe("challenge_failed");
  });
});
