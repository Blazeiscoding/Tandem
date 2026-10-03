import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { createWorkspaceServer } from "../../../packages/server/src/server.js";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/index.js";

// All workspaces are in memory. Only this owned report is written to disk.
const requireServer = createRequire(
  new URL("../../../packages/server/package.json", import.meta.url),
);
const WebSocket = requireServer("ws");
const report: any = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  node: process.version,
  platform: process.platform,
  startedAt: new Date().toISOString(),
  cases: {},
};

async function start(extra: any = {}) {
  const server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    allowPrivateHooks: true,
    ...extra,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(7000),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const owner = await api("POST", "/api/auth/register", undefined, {
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  assert.equal(owner.status, 201);
  return {
    server,
    base,
    api,
    owner: owner.body,
    general: server.store.getChannelByName("general")!.id,
  };
}

async function replay(base: string, token: string, lastSeq: number) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  const frames: any[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("replay timed out")), 5000);
      ws.on("error", reject);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "hello",
            token,
            lastSeq,
            protocolVersion: PROTOCOL_VERSION,
            syncVersion: 1,
          }),
        ),
      );
      ws.on("message", (raw: any) => {
        const frame = JSON.parse(String(raw));
        frames.push(frame);
        if (frame.type === "synced") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return frames;
  } finally {
    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.terminate();
    });
  }
}

async function actionRedaction() {
  const { server, base, api, owner, general } = await start({ retentionDays: 1 });
  try {
    const app = await api("POST", "/api/apps", owner.token, { name: "Probe App" });
    assert.equal(app.status, 201);
    const baseline = server.store.currentSeq();
    const marker = "Meeting RSVP";
    const send = async () => {
      const post = await api("POST", "/api/chat.postMessage", app.body.token, {
        channel: general,
        text: "body to remove",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: marker },
                action_id: "approve",
                value: marker,
                url: "https://example.invalid/meeting-details",
              },
            ],
          },
        ],
      });
      assert.equal(post.body.ok, true);
      return post.body.ts as string;
    };
    const deletedId = await send();
    assert.equal((await api("DELETE", `/api/messages/${deletedId}`, owner.token)).status, 200);
    const db = (server.store as any).db;
    const deletedRow = db
      .prepare("SELECT text, actions, deleted_at FROM messages WHERE id = ?")
      .get(deletedId);
    assert.equal(deletedRow.text, "");
    assert.ok(deletedRow.deleted_at);
    assert.ok(deletedRow.actions.includes(marker));
    const deleteFrames = await replay(base, owner.token, baseline);
    const deletedCreate = deleteFrames.find(
      (f) =>
        f.type === "event" &&
        f.envelope.event.type === "message.created" &&
        f.envelope.event.message.id === deletedId,
    );
    assert.equal(deletedCreate.envelope.event.message.text, "");
    assert.deepEqual(deletedCreate.envelope.event.message.files, []);
    assert.equal(deletedCreate.envelope.event.message.actions[0].value, marker);
    assert.ok(
      deleteFrames.some(
        (f) =>
          f.type === "event" &&
          f.envelope.event.type === "message.deleted" &&
          f.envelope.event.messageId === deletedId,
      ),
    );
    const retentionId = await send();
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(
      Date.now() - 2 * 86400_000,
      retentionId,
    );
    assert.equal(server.applyRetention(), 1);
    assert.equal(server.store.getMessage(retentionId), null);
    const retentionFrames = await replay(base, owner.token, baseline);
    const purgedCreate = retentionFrames.find(
      (f) =>
        f.type === "event" &&
        f.envelope.event.type === "message.created" &&
        f.envelope.event.message.id === retentionId,
    );
    assert.equal(purgedCreate.envelope.event.message.text, "");
    assert.equal(purgedCreate.envelope.event.message.actions[0].value, marker);
    const history = await api("GET", `/api/channels/${general}/messages`, owner.token);
    assert.ok(!history.body.messages.some((m: any) => [deletedId, retentionId].includes(m.id)));
    return {
      diagnosticPass: true,
      deletedRowRetainsActions: true,
      deletedSocketReplayAction: deletedCreate.envelope.event.message.actions[0],
      purgedSocketReplayAction: purgedCreate.envelope.event.message.actions[0],
      deletionAndRetentionHideHistory: true,
      existingTextAndFileRedactionPass: true,
      replayFrameCounts: [deleteFrames.length, retentionFrames.length],
    };
  } finally {
    await server.stop();
  }
}

async function scheduledCopies() {
  const { server, api, owner, general } = await start({ retentionDays: 1 });
  try {
    const db = (server.store as any).db;
    const send = async (text: string, nonce: string) => {
      const scheduled = await api("POST", `/api/channels/${general}/scheduled`, owner.token, {
        text,
        nonce,
        sendAt: Date.now() + 3600_000,
      });
      assert.equal(scheduled.status, 201);
      const id = scheduled.body.scheduled.id;
      server.store.rescheduleMessage(id, Date.now() - 1000);
      server.flushScheduled();
      const delivered = server.store.getScheduled(id)!;
      assert.equal(delivered.status, "sent");
      assert.ok(delivered.messageId);
      return delivered;
    };
    const removed = await send("The meeting starts at ten.", "del");
    assert.equal(
      (await api("DELETE", `/api/messages/${removed.messageId}`, owner.token)).status,
      200,
    );
    const afterDelete = server.store.getScheduled(removed.id)!;
    assert.equal(afterDelete.text, "The meeting starts at ten.");
    const edited = await send("The venue is the small room.", "edit");
    const changed = await api("PATCH", `/api/messages/${edited.messageId}`, owner.token, {
      text: "The venue is the large room.",
      expectedText: "The venue is the small room.",
    });
    assert.equal(changed.status, 200);
    const afterEdit = server.store.getScheduled(edited.id)!;
    assert.equal(afterEdit.text, "The venue is the small room.");
    assert.equal(server.store.getMessage(edited.messageId!)!.text, "The venue is the large room.");
    const expired = await send("Bring the agenda to the meeting.", "ret");
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(
      Date.now() - 2 * 86400_000,
      expired.messageId,
    );
    db.prepare("UPDATE scheduled_messages SET send_at = ? WHERE id = ?").run(
      Date.now() - 2 * 86400_000,
      expired.id,
    );
    assert.equal(server.applyRetention(), 1);
    const afterRetention = server.store.getScheduled(expired.id)!;
    assert.equal(afterRetention.text, "Bring the agenda to the meeting.");
    assert.equal(afterRetention.messageId, null);
    assert.equal(server.store.getMessage(expired.messageId!), null);
    const visible = await api("GET", "/api/scheduled", owner.token);
    assert.deepEqual(visible.body.scheduled, []);
    // The unchanged production seven-day prune retains both recent sent rows.
    server.store.pruneScheduled(Date.now() - 7 * 86400_000);
    assert.ok(server.store.getScheduled(removed.id));
    assert.ok(server.store.getScheduled(expired.id));
    return {
      diagnosticPass: true,
      afterDelete: { status: afterDelete.status, text: afterDelete.text },
      afterEdit: { scheduleText: afterEdit.text, visibleMessageText: changed.body.message.text },
      afterRetention: {
        status: afterRetention.status,
        text: afterRetention.text,
        messageId: afterRetention.messageId,
      },
      apiOmitsBothSentRows: true,
      productionSevenDayPruneRetainsBoth: true,
    };
  } finally {
    await server.stop();
  }
}

async function duplicateSubmission() {
  const pending: ServerResponse[] = [];
  const payloads: any[] = [];
  let trigger = "";
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (req.url === "/command") {
        trigger = new URLSearchParams(raw).get("trigger_id")!;
        res.end("");
      } else if (raw.startsWith("{")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ challenge: JSON.parse(raw).challenge }));
      } else {
        payloads.push(JSON.parse(new URLSearchParams(raw).get("payload")!));
        pending.push(res);
      }
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubBase = `http://127.0.0.1:${(stub.address() as any).port}`;
  const { server, api, owner, general } = await start();
  const deadline = Date.now() + 2500;
  try {
    const app = (await api("POST", "/api/apps", owner.token, { name: "Submission App" })).body;
    assert.equal(
      (
        await api("PUT", `/api/apps/${app.app.id}/interactivity`, owner.token, {
          url: stubBase + "/interactive",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api("POST", `/api/apps/${app.app.id}/commands`, owner.token, {
          command: "/probe",
          url: stubBase + "/command",
        })
      ).status,
      201,
    );
    assert.equal(
      (await api("POST", `/api/channels/${general}/commands`, owner.token, { text: "/probe" }))
        .status,
      200,
    );
    assert.ok(trigger);
    const opened = await api("POST", "/api/views.open", app.token, {
      trigger_id: trigger,
      view: {
        title: "Probe",
        callback_id: "write-once",
        blocks: [
          {
            type: "input",
            block_id: "b",
            label: "Answer",
            element: { type: "plain_text_input", action_id: "a" },
          },
        ],
      },
    });
    assert.equal(opened.body.ok, true);
    const path = `/api/views/${opened.body.view.id}/submit`;
    const first = api("POST", path, owner.token, { values: { b: { a: "synthetic answer" } } });
    const second = api("POST", path, owner.token, { values: { b: { a: "synthetic answer" } } });
    while (payloads.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    for (const res of pending) res.end("");
    const results = await Promise.all([first, second]);
    assert.equal(payloads.length, 2);
    assert.ok(results.every((r) => r.status === 200 && r.body.ok));
    assert.equal(payloads[0].view.id, payloads[1].view.id);
    assert.deepEqual(payloads[0].view.state.values, payloads[1].view.state.values);
    const repeated = await api("POST", path, owner.token, {
      values: { b: { a: "synthetic answer" } },
    });
    assert.equal(repeated.status, 404);
    return {
      diagnosticPass: true,
      sameViewConcurrentCallbacks: payloads.length,
      results,
      sequentialReplayStatus: repeated.status,
      defaultAdmissionLimitsEnabled: true,
      rateLimitsAreNotSameViewExclusion: true,
    };
  } finally {
    for (const res of pending) if (!res.writableEnded) res.end("");
    await server.stop();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
}

async function replacedDeletedMessage() {
  let waiting: ServerResponse | undefined;
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (raw.startsWith("{")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ challenge: JSON.parse(raw).challenge }));
      } else waiting = res;
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { server, api, owner, general } = await start();
  try {
    const created = await api("POST", "/api/apps", owner.token, { name: "RSVP App" });
    const app = created.body;
    const wired = await api("PUT", `/api/apps/${app.app.id}/interactivity`, owner.token, {
      url: `http://127.0.0.1:${(stub.address() as any).port}/interactive`,
    });
    assert.equal(wired.status, 200);
    const posted = await api("POST", "/api/chat.postMessage", app.token, {
      channel: general,
      text: "Please confirm attendance.",
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "rsvp",
              text: { type: "plain_text", text: "Attend" },
              value: "attending",
            },
          ],
        },
      ],
    });
    assert.equal(posted.body.ok, true);
    const original = posted.body.ts;
    const action = api("POST", `/api/messages/${original}/actions`, owner.token, {
      actionId: "rsvp",
    });
    const deadline = Date.now() + 2000;
    while (!waiting && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(waiting);
    assert.equal((await api("DELETE", `/api/messages/${original}`, owner.token)).status, 200);
    assert.equal(server.store.getMessage(original), null);
    waiting.setHeader("content-type", "application/json");
    waiting.end(
      JSON.stringify({
        replace_original: true,
        response_type: "in_channel",
        text: "RSVP recorded.",
      }),
    );
    const result = await action;
    assert.equal(result.body.ok, true);
    const replacement = server.store
      .listMessages({ channelId: general, limit: 20 })
      .find((m) => m.text === "RSVP recorded.");
    assert.ok(replacement);
    assert.notEqual(replacement.id, original);
    return {
      diagnosticPass: true,
      actionHttpStatus: result.status,
      actionResult: result.body,
      originalStillDeleted: server.store.getMessage(original) === null,
      replacementDirectiveCreatedAnotherMessage: true,
      newMessageText: replacement.text,
    };
  } finally {
    if (waiting && !waiting.writableEnded) waiting.end("");
    await server.stop();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
}

{
  for (const [name, run] of Object.entries({
    actions: actionRedaction,
    scheduled: scheduledCopies,
    submission: duplicateSubmission,
    replacement: replacedDeletedMessage,
  })) {
    const before = Date.now();
    try {
      report.cases[name] = { ...(await run()), durationMs: Date.now() - before };
    } catch (err) {
      report.cases[name] = {
        diagnosticPass: false,
        error: String(err),
        stack: (err as Error).stack,
      };
    }
    console.log(name, JSON.stringify(report.cases[name]));
  }
  report.completedAt = new Date().toISOString();
  writeFileSync(
    new URL("server-results.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (Object.values(report.cases).some((result: any) => result.diagnosticPass === false))
    process.exitCode = 1;
}
