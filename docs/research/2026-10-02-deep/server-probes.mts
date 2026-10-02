/**
 * Current-source fault/count diagnostics. Run from the repository root:
 * pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-deep/server-probes.mts
 *
 * Native timers are not replaced. Only named Store methods are fault-injected
 * in disposable child processes. No production source or live data is changed.
 * Elapsed times are diagnostic deadlines, not performance measurements.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createWorkspaceServer,
  type WorkspaceServer,
} from "../../../packages/server/src/server.ts";
import { hashToken } from "../../../packages/server/src/auth.ts";
import { openDb } from "../../../packages/server/src/db.ts";
import { Store } from "../../../packages/server/src/store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const modes = [
  "schedule_timer_failure",
  "schedule_immediate_failure",
  "delivery_timer_failure",
  "schedule_timer_control",
  "cleanup_fairness",
  "retry_capacity",
  "endpoint_independence",
  "deletion_publication",
  "retention_boundary",
] as const;
type Mode = (typeof modes)[number];
const emit = (value: object) => process.stdout.write(`AUDIT ${JSON.stringify(value)}\n`);
const tick = () => new Promise<void>((done) => setImmediate(done));
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return !!rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Probe assertion: ${message}`);
}
async function until(predicate: () => boolean, label: string, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Probe deadline: ${label}`);
    await new Promise<void>((done) => setTimeout(done, 10));
  }
}
async function start(directory: string, options: object = {}) {
  return createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    ...options,
  });
}
function seed(server: WorkspaceServer, members = 1) {
  const people = Array.from({ length: members }, (_, index) =>
    server.store.createUser({
      handle: `audit-${index}`,
      displayName: `Audit ${index}`,
      passwordHash: "",
      salt: "",
      role: index === 0 ? "owner" : "member",
    }),
  );
  const owner = people[0]!;
  const channel = server.store.createChannel({
    type: "private",
    name: "audit-private",
    creatorId: owner.id,
    memberIds: people.map((p) => p.id),
  });
  const token = randomUUID();
  server.store.createSession(hashToken(token), owner.id);
  return { owner, channel, token, people };
}
async function request(
  server: WorkspaceServer,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: (await response.json()) as any };
}
function app(server: WorkspaceServer, ownerId: string, name: string, url: string) {
  const bot = server.store.createBotUser(`bot-${name}`, name, "", "");
  const owner = server.store.createApp({
    name,
    botUserId: bot.id,
    createdBy: ownerId,
    signingSecret: "disposable-probe-secret",
  });
  const subscription = server.store.createSubscription({ appId: owner.id, url, eventTypes: [] });
  return { owner, bot, subscription };
}
function queueSnapshot(directory: string) {
  const path = join(directory, "workspace.db");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      schedules: db
        .prepare("SELECT status, COUNT(*) AS n FROM scheduled_messages GROUP BY status")
        .all(),
      messages: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL").get(),
      deliveries: db.prepare("SELECT COUNT(*) AS n FROM event_deliveries").get(),
      pendingDeletes: db.prepare("SELECT COUNT(*) AS n FROM pending_file_deletions").get(),
      integrity: db.prepare("PRAGMA quick_check").all(),
    };
  } finally {
    db.close();
  }
}

async function child(mode: Mode, directory: string) {
  if (
    mode === "schedule_timer_failure" ||
    mode === "schedule_immediate_failure" ||
    mode === "delivery_timer_failure" ||
    mode === "schedule_timer_control"
  ) {
    const server = await start(directory, { scheduledLimits: { batch: 1 } });
    const { owner, channel } = seed(server);
    await server.flushEventDeliveries();
    const scheduled = server.store.scheduleMessage({
      channelId: channel.id,
      userId: owner.id,
      text: "disposable scheduled probe",
      threadRootId: null,
      fileIds: [],
      sendAt: Date.now() - 1,
    });
    emit({ phase: "ready", mode, port: server.port, scheduledStatus: scheduled.status });
    if (mode === "schedule_timer_failure") {
      server.store.dueScheduled = () => {
        throw new Error("AUDIT_NATIVE_SCHEDULE_TIMER_READ_FAILURE");
      };
      emit({
        phase: "armed",
        trigger: "unaltered production 15000ms interval",
        injection: "Store.dueScheduled throws",
      });
    } else if (mode === "delivery_timer_failure") {
      server.store.dueEventDeliveries = () => {
        throw new Error("AUDIT_NATIVE_DELIVERY_TIMER_READ_FAILURE");
      };
      emit({
        phase: "armed",
        trigger: "unaltered production 5000ms interval",
        injection: "Store.dueEventDeliveries throws",
      });
    } else if (mode === "schedule_immediate_failure") {
      server.store.scheduleMessage({
        channelId: channel.id,
        userId: owner.id,
        text: "second disposable schedule",
        threadRootId: null,
        fileIds: [],
        sendAt: Date.now() - 1,
      });
      const due = server.store.dueScheduled.bind(server.store);
      let calls = 0;
      server.store.dueScheduled = (...args) => {
        if (++calls === 2) throw new Error("AUDIT_NATIVE_SCHEDULE_IMMEDIATE_READ_FAILURE");
        return due(...args);
      };
      // One successful explicit turn schedules the production setImmediate.
      server.flushScheduled();
      emit({
        phase: "armed",
        trigger: "production setImmediate after full successful batch",
        directEntryReturned: true,
        firstScheduleStatus: server.store.getScheduled(scheduled.id)?.status,
      });
    } else {
      await until(
        () => server.store.getScheduled(scheduled.id)?.status === "sent",
        "native timer control",
        25000,
      );
      emit({
        phase: "result",
        healthy: true,
        nativeTimerPosted: true,
        scheduledStatus: server.store.getScheduled(scheduled.id)?.status,
      });
      await server.stop();
      return;
    }
    // The native timers keep the child alive. No uncaughtException or rejection
    // handler is installed: the parent captures the real default Node exit.
    await new Promise(() => {});
    return;
  }

  if (mode === "cleanup_fairness") {
    let server = await start(directory, { maxStorageBytes: 100 });
    const { token, channel } = seed(server);
    await server.flushFileDeletions();
    const badIds = Array.from({ length: 100 }, (_, index) => String(index).padStart(26, "0"));
    for (const id of badIds) mkdirSync(join(directory, "files", id));
    const form = new FormData();
    form.append("file", new Blob(["healthy cleanup bytes"]), "audit.txt");
    const upload = await fetch(`http://127.0.0.1:${server.port}/api/channels/${channel.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const uploaded = (await upload.json()) as any;
    check(upload.status === 201, "healthy blob uploaded");
    const healthyId = uploaded.file.id as string;
    server.store.transaction(() => {
      server.store.queueFileDeletions(badIds);
      server.store.deleteFiles([healthyId]);
      server.store.queueFileDeletions([healthyId]);
    });
    const observations: object[] = [];
    const observe = async (phase: string) => {
      const status = await request(server, token, "/api/admin/status");
      const state = queueSnapshot(directory)!;
      observations.push({
        phase,
        pending: state.pendingDeletes,
        healthyExists: existsSync(join(directory, "files", healthyId)),
        countedBytes: status.body.attachments.bytes,
      });
    };
    for (let round = 1; round <= 3; round++) {
      await server.flushFileDeletions();
      await observe(`flush-${round}`);
    }
    await server.stop();
    server = await start(directory, { maxStorageBytes: 100 });
    await server.flushFileDeletions();
    await observe("restart-and-flush");
    for (const id of badIds) rmdirSync(join(directory, "files", id)); // Only our empty directories.
    await server.flushFileDeletions();
    await observe("repair-first-flush");
    await server.flushFileDeletions();
    await observe("repair-second-flush");
    check(
      observations.slice(0, 4).every((v: any) => v.healthyExists && v.pending.n === 101),
      "blocked entries starve healthy file across restart",
    );
    check(
      (observations.at(-1) as any).countedBytes === 0 &&
        !(observations.at(-1) as any).healthyExists,
      "repair eventually releases bytes",
    );
    emit({
      phase: "result",
      mode,
      failure: "valid-ID directories produce real unlink failure; no filesystem mock",
      observations,
    });
    await server.stop();
    return;
  }

  if (mode === "retry_capacity") {
    const server = await start(directory, { isolated: true });
    try {
      const { owner, token } = seed(server);
      const subscription = app(
        server,
        owner.id,
        "retry",
        "http://127.0.0.1:1/not-contacted",
      ).subscription;
      let seq = 1000;
      const phases: object[] = [];
      for (let round = 0; round < 3; round++) {
        server.store.transaction(() => {
          for (let i = 0; i < Store.MAX_PENDING_DELIVERIES; i++)
            check(
              server.store.enqueueEventDelivery(subscription.id, null, seq++, "{}"),
              "normal admission accepts each slot",
            );
          if (round < 2)
            server.store.abandonEventBacklog(subscription.id, "disposable terminal failure");
        });
        phases.push({
          phase: `fill-${round}`,
          counts: server.store.operationalCounts().deliveries,
        });
      }
      const retried = await request(
        server,
        token,
        `/api/subscriptions/${subscription.id}/retry`,
        "POST",
      );
      const after = server.store.operationalCounts().deliveries;
      check(
        retried.status === 200 && retried.body.retried === 1000 && after.waiting === 1500,
        "HTTP retry bypasses per-subscription waiting ceiling",
      );
      emit({
        phase: "result",
        mode,
        trigger: "actual authenticated HTTP retry; isolated mode prevents outbound network",
        configuredPendingCeiling: Store.MAX_PENDING_DELIVERIES,
        phases,
        http: retried,
        after,
      });
    } finally {
      await server.stop();
    }
    return;
  }

  if (mode === "endpoint_independence") {
    const received: { endpoint: string; event: number }[] = [];
    const held: import("node:http").ServerResponse[] = [];
    const endpoint = createServer((req, res) => {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        received.push({ endpoint: req.url!, event: JSON.parse(text).event });
        if (req.url === "/slow") held.push(res);
        else res.end("ok");
      });
    });
    await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
    const endpointPort = (endpoint.address() as any).port;
    const server = await start(directory, { allowPrivateHooks: true });
    try {
      const { owner } = seed(server);
      await server.flushEventDeliveries();
      const slow = app(
        server,
        owner.id,
        "slow",
        `http://127.0.0.1:${endpointPort}/slow`,
      ).subscription;
      const fast = app(
        server,
        owner.id,
        "fast",
        `http://127.0.0.1:${endpointPort}/fast`,
      ).subscription;
      server.store.enqueueEventDelivery(slow.id, null, 1, '{"event":1}');
      server.store.enqueueEventDelivery(fast.id, null, 2, '{"event":2}');
      server.store.enqueueEventDelivery(fast.id, null, 3, '{"event":3}');
      const draining = server.flushEventDeliveries();
      await until(
        () => held.length === 1 && received.some((v) => v.endpoint === "/fast"),
        "both endpoints received first batch",
      );
      await until(
        () => server.store.listSubscriptions(fast.appId)[0]?.delivery?.pending === 1,
        "first fast delivery acknowledged",
      );
      const reusedPromise = server.flushEventDeliveries() === draining;
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      const whileHeld = {
        received: [...received],
        healthyServer: health.status,
        fastPending: server.store.listSubscriptions(fast.appId)[0]?.delivery?.pending,
        reusedPromise,
        slowStillHeld: !held[0]!.writableEnded,
      };
      check(
        whileHeld.fastPending === 1 &&
          whileHeld.reusedPromise &&
          whileHeld.received.filter((v) => v.endpoint === "/fast").length === 1 &&
          whileHeld.slowStillHeld,
        "fast second event blocked by unrelated active endpoint",
      );
      held[0]!.end("ok");
      await draining;
      check(
        received
          .filter((v) => v.endpoint === "/fast")
          .map((v) => v.event)
          .join(",") === "2,3",
        "release allows ordered fast completion",
      );
      emit({
        phase: "result",
        mode,
        transport: "real loopback HTTP with one deliberately held response; no timer replacement",
        whileHeld,
        afterRelease: [...received],
        remaining: server.store.operationalCounts().deliveries,
      });
    } finally {
      for (const response of held) if (!response.writableEnded) response.end("cleanup");
      await server.stop();
      endpoint.closeAllConnections();
      await new Promise<void>((done) => endpoint.close(() => done()));
    }
    return;
  }

  if (mode === "deletion_publication") {
    const server = await start(directory);
    try {
      const { channel, owner, token } = seed(server, 50);
      const makeThread = () =>
        server.store.transaction(() => {
          const root = server.store.createMessage({
            channelId: channel.id,
            userId: owner.id,
            text: "root without mentions",
            threadRootId: null,
            nonce: null,
          });
          for (let i = 0; i < 20; i++)
            server.store.createMessage({
              channelId: channel.id,
              userId: owner.id,
              text: "reply without mentions",
              threadRootId: root.id,
              nonce: null,
            });
          return root;
        });
      const root = makeThread();
      let countCalls = 0,
        publications = 0;
      const counts = server.store.unreadMentionCounts.bind(server.store);
      const publish = server.gateway.publish.bind(server.gateway);
      server.store.unreadMentionCounts = (...args) => {
        countCalls++;
        return counts(...args);
      };
      server.gateway.publish = (...args) => {
        publications++;
        return publish(...args);
      };
      const response = await request(server, token, `/api/messages/${root.id}`, "DELETE");
      check(
        response.status === 200 && countCalls === 1050 && publications === 21,
        "one thread deletion repeats recount per message per account",
      );
      const amplification = {
        http: response.status,
        deletedMessages: 21,
        members: 50,
        liveUsers: server.gateway.onlineUserIds().length,
        countCalls,
        publications,
      };
      const another = makeThread();
      const beforeSeq = server.store.currentSeq();
      server.store.unreadMentionCounts = () => {
        throw new Error("AUDIT_POST_COMMIT_RECOUNT_FAILURE");
      };
      const failed = await request(server, token, `/api/messages/${another.id}`, "DELETE");
      const deletedDespiteFailure =
        !server.store.getMessage(another.id) &&
        server.store.threadReplyIds(another.id).length === 0;
      const durableDeletionEvents = server.store.currentSeq() - beforeSeq;
      server.store.unreadMentionCounts = counts;
      const retry = await request(server, token, `/api/messages/${another.id}`, "DELETE");
      check(
        failed.status === 500 &&
          deletedDespiteFailure &&
          durableDeletionEvents === 21 &&
          retry.status === 404,
        "post-commit publication failure changes API acknowledgement",
      );
      emit({
        phase: "result",
        mode,
        amplification,
        postCommitFailure: {
          injection: "Store.unreadMentionCounts throws after committed deletion",
          failedHttp: failed.status,
          deletedDespiteFailure,
          durableDeletionEvents,
          retryHttp: retry.status,
        },
      });
    } finally {
      await server.stop();
    }
    return;
  }

  if (mode === "retention_boundary") {
    const db = openDb(":memory:");
    const store = new Store(db);
    try {
      const owner = store.createUser({
        handle: "audit",
        displayName: "Audit",
        passwordHash: "",
        salt: "",
        role: "owner",
      });
      const channel = store.createChannel({
        type: "private",
        name: "audit",
        creatorId: owner.id,
        memberIds: [owner.id],
      });
      const add = db.prepare(
        "INSERT INTO messages (id,channel_id,user_id,text,thread_root_id,created_at) VALUES (?,?,?,'disposable old text',?,0)",
      );
      store.transaction(() => {
        add.run("ROOT", channel.id, owner.id, null);
        for (let i = 0; i < 6000; i++)
          add.run(`REPLY${String(i).padStart(6, "0")}`, channel.id, owner.id, "ROOT");
      });
      const queryPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT m.id FROM messages m WHERE m.thread_root_id IS NULL AND m.created_at < 1 AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_root_id = m.id AND r.created_at >= 1) ORDER BY m.id LIMIT 2000`,
        )
        .all();
      let rollback = false;
      try {
        store.transaction(() => {
          store.purgeMessagesBefore(1);
          throw new Error("AUDIT_RETENTION_ROLLBACK");
        });
      } catch {
        rollback = true;
      }
      const afterRollback = db.prepare("SELECT COUNT(*) AS n FROM messages").get()!;
      const removed = store.transaction(() => store.purgeMessagesBefore(1));
      check(
        afterRollback.n === 6001 && removed.messages === 6001,
        "whole-thread exception and transaction rollback verified",
      );
      emit({
        phase: "result",
        mode,
        knownDocumentedException: true,
        nominalMessageBudget: 5000,
        actualRowsRemoved: removed.messages,
        roots: removed.roots.length,
        rollback,
        afterRollback,
        queryPlan,
        timingClaim: "none",
      });
    } finally {
      db.close();
    }
    return;
  }
  throw new Error(`Unknown child mode ${mode}`);
}

async function run() {
  const root = resolve(mkdtempSync(join(tmpdir(), "tandem-server-deep-")));
  const temp = resolve(tmpdir());
  const ownership = randomUUID();
  check(
    inside(temp, root) && basename(root).startsWith("tandem-server-deep-"),
    "temporary root verified before use",
  );
  writeFileSync(join(root, ".server-probe-owned"), ownership);
  const results: any[] = [];
  let revision = "unknown";
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {}
  const execute = async (mode: Mode) => {
    const directory = resolve(join(root, mode));
    check(inside(root, directory), "child target stays inside owned root");
    mkdirSync(directory);
    const outcome = await new Promise<any>((done) => {
      const proc = spawn(
        process.execPath,
        [
          ...process.execArgv,
          fileURLToPath(import.meta.url),
          "--child",
          mode,
          "--data-dir",
          directory,
        ],
        {
          cwd: repo,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      let stdout = "",
        stderr = "",
        timedOut = false;
      proc.stdout.on("data", (data) => (stdout += String(data)));
      proc.stderr.on("data", (data) => (stderr += String(data)));
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, 40000);
      proc.once("error", (error) => (stderr += String(error)));
      proc.once("close", (code, signal) => {
        clearTimeout(timeout);
        const records = stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("AUDIT "))
          .map((line) => JSON.parse(line.slice(6)));
        done({
          mode,
          exitCode: code,
          signal,
          timedOut,
          records,
          stdout,
          stderr,
          databaseAfterExit: queueSnapshot(directory),
        });
      });
    });
    writeFileSync(
      join(here, `server-${mode}.log`),
      outcome.stdout + "\n--- STDERR ---\n" + outcome.stderr,
    );
    results.push(outcome);
    process.stdout.write(
      `${mode}: exit ${outcome.exitCode}${outcome.timedOut ? " (TIMEOUT)" : ""}\n`,
    );
  };
  try {
    // Native failure/control children run together; this is not a latency benchmark.
    await Promise.all(modes.slice(0, 4).map(execute));
    for (const mode of modes.slice(4)) await execute(mode);
  } finally {
    writeFileSync(
      join(here, "server-results.json"),
      JSON.stringify(
        {
          revision,
          generatedAt: new Date().toISOString(),
          runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
          },
          method:
            "native timers and real HTTP/socket filesystem operations; isolated named Store fault injection; all fixtures disposable",
          timingsTrusted: false,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    const finalTarget = resolve(root);
    check(
      inside(temp, finalTarget) &&
        basename(finalTarget).startsWith("tandem-server-deep-") &&
        readFileSync(join(finalTarget, ".server-probe-owned"), "utf8") === ownership,
      "recursive cleanup target and ownership verified",
    );
    rmSync(finalTarget, { recursive: true, force: true });
  }
  const problems = results.filter(
    (value) =>
      value.timedOut ||
      (value.mode.endsWith("failure") ? value.exitCode !== 1 : value.exitCode !== 0),
  );
  check(
    problems.length === 0,
    `unexpected child result: ${problems.map((value) => value.mode).join(",")}`,
  );
}

if (process.argv.includes("--child")) {
  const mode = process.argv[process.argv.indexOf("--child") + 1] as Mode;
  const directory = resolve(process.argv[process.argv.indexOf("--data-dir") + 1]!);
  await child(mode, directory);
} else {
  await run();
}
