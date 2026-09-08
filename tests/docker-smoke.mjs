import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const name = `slackoss-test-${randomUUID()}`;
const volume = `${name}-data`;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", windowsHide: true }).trim();
const sockets = [];
let base;
async function waitFor(check, label) {
  for (let n = 0; n < 100; n++) {
    if (await check().catch(() => false)) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
async function api(path, token, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
}
try {
  docker("volume", "create", volume);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-p",
    "127.0.0.1::8543",
    "-v",
    `${volume}:/data`,
    "slackoss:local",
    "--name",
    "Docker Smoke",
    "--invite-only",
  );
  base = `http://${docker("port", name, "8543/tcp").split(/\r?\n/)[0]}`;
  await waitFor(async () => (await fetch(base + "/api/health")).ok, "healthy server");
  assert.notEqual(docker("exec", name, "id", "-u"), "0");
  assert.match(await (await fetch(base)).text(), /<div id="root">/);
  const idle = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name);
  // Published ports reach the server through Docker's bridge, so claim the
  // workspace with the same startup secret a remote administrator needs.
  const claimCode = docker("logs", name).match(/Claim code: (\S+)/)?.[1];
  assert(claimCode, "server printed its initial workspace claim code");
  const owner = await api("/api/auth/register", null, {
    handle: "owner",
    displayName: "Owner",
    password: "test-password",
    claimCode,
  });
  const invite = await api("/api/invites", owner.token, { maxUses: 1 });
  const guest = await api("/api/auth/register", null, {
    handle: "guest",
    displayName: "Guest",
    password: "test-password",
    inviteCode: invite.invite.code,
  });
  await api(`/api/friends/${guest.user.id}`, owner.token, undefined, "POST");
  await api(`/api/friends/${owner.user.id}`, guest.token, undefined, "PUT");
  const { channels } = await api("/api/channels", owner.token);
  const channel = channels.find((c) => c.name === "general");
  const received = Array(20).fill(0);
  await Promise.all(
    received.map(
      (_, index) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(base.replace("http", "ws") + "/ws");
          sockets.push(ws);
          ws.onopen = () =>
            ws.send(
              JSON.stringify({
                type: "hello",
                token: guest.token,
                lastSeq: null,
                protocolVersion: 1,
              }),
            );
          ws.onerror = reject;
          ws.onmessage = ({ data }) => {
            const frame = JSON.parse(data);
            if (frame.type === "ready") resolve();
            if (frame.type === "event" && frame.envelope.event.type === "message.created")
              received[index]++;
          };
        }),
    ),
  );
  const timings = [];
  for (let i = 0; i < 300; i++) {
    const started = performance.now();
    await api(`/api/channels/${channel.id}/messages`, owner.token, {
      text: `Load message ${i}`,
      nonce: `smoke-${i}`,
    });
    timings.push(performance.now() - started);
  }
  await waitFor(async () => received.every((n) => n === 300), "all 6,000 message deliveries");
  const loaded = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name);
  for (const ws of sockets) ws.close();
  docker("restart", name);
  base = `http://${docker("port", name, "8543/tcp").split(/\r?\n/)[0]}`;
  await waitFor(async () => (await fetch(base + "/api/health")).ok, "restart");
  const login = await api("/api/auth/login", null, { handle: "owner", password: "test-password" });
  assert.equal((await api("/api/friends", login.token)).friends[0].status, "accepted");
  assert.equal(
    (await api(`/api/channels/${channel.id}/messages`, login.token)).messages[0].text,
    "Load message 299",
  );
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        sockets: 20,
        messages: 300,
        deliveries: 6000,
        cpuLimit: 1,
        memoryLimitMiB: 256,
        idleMemory: idle,
        afterLoadMemory: loaded,
        postLatencyP50Ms: +timings[150].toFixed(2),
        postLatencyP95Ms: +timings[285].toFixed(2),
        restartPersistence: true,
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.error(docker("logs", "--tail", "12", name));
  throw err;
} finally {
  for (const ws of sockets) ws.close();
  // Only this run's randomly named container and disposable volume are removed.
  try {
    docker("rm", "-f", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
}
