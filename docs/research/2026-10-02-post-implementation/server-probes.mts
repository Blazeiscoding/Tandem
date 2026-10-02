/** Current-source, owned-fixture diagnostics. From the repository root:
 * pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-post-implementation/server-probes.mts
 * Native timers/transports are unchanged. Named method fault injection is local
 * to bounded child processes. Deadlines are not latency benchmarks.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as sqliteConstants } from "node:sqlite";
import {
  createWorkspaceServer,
  type WorkspaceServer,
} from "../../../packages/server/src/server.ts";
import { hashToken } from "../../../packages/server/src/auth.ts";
import { WorkspaceClient } from "../../../packages/client-core/src/workspace.ts";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const modes = [
  "gateway_message_failure",
  "gateway_sqlite_message_failure",
  "gateway_heartbeat_failure",
  "gateway_heartbeat_control",
  "retry_retention",
  "retry_order",
  "revocation_effect",
  "integration_work_counts",
  "private_publication_counts",
  "current_closures",
  "delivery_queue_recovery",
] as const;
type Mode = (typeof modes)[number];
const emit = (v: object) => process.stdout.write(`AUDIT ${JSON.stringify(v)}\n`);
function check(v: unknown, label: string): asserts v {
  if (!v) throw new Error(`Probe assertion: ${label}`);
}
function inside(root: string, target: string) {
  const r = relative(resolve(root), resolve(target));
  return !!r && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}
async function until(read: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() >= end) throw new Error(`Probe deadline: ${label}`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}
const start = (directory: string, options: object = {}) =>
  createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    ...options,
  });
function seed(server: WorkspaceServer, n = 2) {
  const people = Array.from({ length: n }, (_, i) =>
    server.store.createUser({
      handle: `person-${i}`,
      displayName: `Person ${i}`,
      passwordHash: "",
      salt: "",
      role: i === 0 ? "owner" : "member",
    }),
  );
  const tokens = people.map((person) => {
    const token = randomUUID();
    server.store.createSession(hashToken(token), person.id);
    return token;
  });
  const channel = server.store.createChannel({
    type: "private",
    name: "probe-private",
    creatorId: people[0]!.id,
    memberIds: people.map((p) => p.id),
  });
  return { people, tokens, channel };
}
async function http(
  server: WorkspaceServer,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, body: (await r.json()) as any };
}
function subscribe(server: WorkspaceServer, ownerId: string, url: string, name = "probe") {
  const bot = server.store.createBotUser(`bot-${name}`, name, "", "");
  const app = server.store.createApp({
    name,
    botUserId: bot.id,
    createdBy: ownerId,
    signingSecret: "disposable-probe-secret",
  });
  const sub = server.store.createSubscription({ appId: app.id, url, eventTypes: [] });
  return { bot, app, sub };
}
const snapshot = (s: WorkspaceServer, appId: string) =>
  s.store.listSubscriptions(appId)[0]!.delivery!;
async function socket(server: WorkspaceServer, token: string) {
  const frames: any[] = [];
  const closes: number[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  ws.addEventListener("close", (e) => closes.push(e.code));
  ws.addEventListener("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token,
        lastSeq: null,
        syncVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await until(() => frames.some((f) => f.type === "synced"), "socket synced");
  return { ws, frames, closes };
}
async function endpoint(holdAfter = Infinity) {
  const arrivals: any[] = [];
  const e = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      arrivals.push(JSON.parse(text));
      if (arrivals.length <= holdAfter) res.end("ok");
    });
  });
  await new Promise<void>((r) => e.listen(0, "127.0.0.1", r));
  return {
    arrivals,
    url: `http://127.0.0.1:${(e.address() as { port: number }).port}/events`,
    async close() {
      e.closeAllConnections();
      await new Promise<void>((r) => e.close(() => r()));
    },
  };
}
async function probe(mode: Mode, directory: string) {
  if (mode.startsWith("gateway_")) {
    const server = await start(directory);
    const { tokens } = seed(server);
    const watcher = await socket(server, tokens[0]!);
    const isMessage = mode.includes("message_failure");
    emit({
      phase: "armed",
      mode,
      authenticatedSocket: true,
      productionTrigger: isMessage
        ? "actual WebSocket message callback"
        : "unaltered 30000ms Gateway heartbeat interval",
      injection:
        mode === "gateway_sqlite_message_failure"
          ? "actual SQLite authorizer refuses READ sessions, without replacing Store methods"
          : mode === "gateway_heartbeat_control"
            ? "none"
            : "named Store.isSessionActive read fault",
    });
    if (mode === "gateway_sqlite_message_failure") {
      (server.store as any).db.setAuthorizer((action: number, table: string | null) =>
        action === sqliteConstants.SQLITE_READ && table === "sessions"
          ? sqliteConstants.SQLITE_DENY
          : sqliteConstants.SQLITE_OK,
      );
    } else if (mode !== "gateway_heartbeat_control")
      server.store.isSessionActive = () => {
        throw new Error(`AUDIT_${mode.toUpperCase()}_SESSION_READ`);
      };
    if (isMessage) watcher.ws.send(JSON.stringify({ type: "ping" }));
    await new Promise<void>((r) => setTimeout(r, isMessage ? 1000 : 31_200));
    const health = await http(server, tokens[0]!, "/api/health");
    await server.stop();
    emit({ phase: "result", healthStatus: health.status, mode, socketCloseCodes: watcher.closes });
    return;
  }
  const isolated = mode === "retry_retention" || mode === "integration_work_counts";
  const server = await start(directory, { isolated, allowPrivateHooks: true });
  const { people, tokens, channel } = seed(
    server,
    mode === "current_closures" || mode === "private_publication_counts" ? 50 : 2,
  );
  let sink: Awaited<ReturnType<typeof endpoint>> | undefined;
  let client: WorkspaceClient | undefined;
  try {
    if (mode === "retry_retention") {
      const now = Date.now(),
        old = now - 8 * 24 * 3600_000;
      const { app, sub } = subscribe(server, people[0]!.id, "https://example.invalid/events");
      let seq = 0;
      server.store.transaction(() => {
        for (let batch = 0; batch < 2; batch++) {
          for (let i = 0; i < 500; i++)
            check(
              server.store.enqueueEventDelivery(sub.id, null, ++seq, JSON.stringify({ seq }), old),
              "old enqueue",
            );
          server.store.abandonEventBacklog(sub.id, "synthetic historical outage", old);
        }
        for (let i = 0; i < 500; i++)
          check(
            server.store.enqueueEventDelivery(sub.id, null, ++seq, JSON.stringify({ seq }), now),
            "fresh enqueue",
          );
      });
      const before = snapshot(server, app.id);
      const accepted = await http(server, tokens[0]!, `/api/subscriptions/${sub.id}/retry`, "POST");
      const waiting = snapshot(server, app.id);
      server.store.pruneEventDeliveries(now - 7 * 24 * 3600_000);
      const after = snapshot(server, app.id);
      check(
        accepted.status === 200 &&
          accepted.body.waiting === 1000 &&
          waiting.retrying === 1000 &&
          after.retrying === 0 &&
          after.pending === 500 &&
          after.dropped === 0,
        "accepted waiting retries expire silently",
      );
      // Control: fresh failed retries do not pass the same retention cutoff.
      const control = subscribe(
        server,
        people[0]!.id,
        "https://example.invalid/control",
        "control",
      );
      server.store.transaction(() => {
        for (let i = 0; i < 500; i++)
          server.store.enqueueEventDelivery(control.sub.id, null, i + 1, "{}", now);
        server.store.abandonEventBacklog(control.sub.id, "fresh outage", now);
        for (let i = 0; i < 500; i++)
          server.store.enqueueEventDelivery(control.sub.id, null, i + 501, "{}", now);
      });
      server.store.retryFailedEventDeliveries(control.sub.id, now);
      server.store.pruneEventDeliveries(now - 7 * 24 * 3600_000);
      const freshControl = snapshot(server, control.app.id);
      check(freshControl.retrying === 500, "fresh control retains requested retries");
      emit({
        phase: "result",
        mode,
        before,
        accepted,
        waiting,
        after,
        freshControl,
        lostAcceptedRetries: 1000,
        trigger:
          "real retry HTTP; directly invoke the unaltered hourly maintenance Store function with production 7-day cutoff; no fake timers",
      });
    } else if (mode === "retry_order") {
      sink = await endpoint(5);
      const { app, sub } = subscribe(server, people[0]!.id, sink.url);
      server.store.transaction(() => {
        for (let seq = 1; seq <= 3; seq++)
          server.store.enqueueEventDelivery(
            sub.id,
            null,
            seq,
            JSON.stringify({ seq, historical: true }),
            0,
          );
        server.store.abandonEventBacklog(sub.id, "historical failed rows");
        for (let seq = 4; seq <= 503; seq++)
          server.store.enqueueEventDelivery(
            sub.id,
            null,
            seq,
            JSON.stringify({ seq, historical: false }),
            0,
          );
      });
      const accepted = await http(server, tokens[0]!, `/api/subscriptions/${sub.id}/retry`, "POST");
      await until(() => sink!.arrivals.length >= 6, "first ordered delivery observations");
      const received = sink.arrivals.slice(0, 6);
      check(
        accepted.status === 200 && received[0].seq === 4 && received[1].seq === 1,
        "full queue sends newer before old retry",
      );
      emit({
        phase: "result",
        mode,
        accepted,
        received,
        queue: snapshot(server, app.id),
        orderInversions: received
          .slice(1)
          .flatMap((v, i) => (v.seq < received[i].seq ? [[received[i].seq, v.seq]] : [])),
        transport:
          "production HTTP retry endpoint and delivery pump to actual loopback HTTP; synthetic queue payloads; sixth response held to bound work",
      });
    } else if (mode === "revocation_effect") {
      const base = `http://127.0.0.1:${server.port}`;
      client = new WorkspaceClient(base, tokens[1]!);
      client.connect();
      await until(() => client!.state.status === "online", "reader online");
      const sent = await http(server, tokens[0]!, `/api/channels/${channel.id}/messages`, "POST", {
        text: "synthetic private content",
      });
      check(sent.status === 201, "private send");
      await client.loadTimeline(channel.id);
      const memberships = server.store.memberships.bind(server.store);
      let injectedReads = 0;
      server.store.memberships = (id) => {
        if (id === people[1]!.id) {
          injectedReads++;
          throw new Error("AUDIT_ACCESS_EFFECT_MEMBERSHIP_READ");
        }
        return memberships(id);
      };
      const removed = await http(
        server,
        tokens[0]!,
        `/api/channels/${channel.id}/members/${people[1]!.id}`,
        "DELETE",
      );
      server.store.memberships = memberships;
      const denied = await http(server, tokens[1]!, `/api/channels/${channel.id}/messages`);
      // A later global frame is a positive live-connection control.
      const beforeSeq = client.state.lastSeq;
      const updated = await http(server, tokens[0]!, "/api/me", "PATCH", {
        displayName: "Owner changed",
      });
      check(updated.status === 200, "later global update");
      await until(() => client!.state.lastSeq > beforeSeq, "later global event arrives");
      const stale = {
        clientStatus: client.state.status,
        cachedChannel: !!client.state.channels[channel.id],
        cachedMembership: channel.id in client.state.memberships,
        cachedText: client.state.timelines[channel.id]?.items.map((m) => m.text) ?? [],
        lastSeq: client.state.lastSeq,
      };
      check(
        removed.status === 200 &&
          injectedReads === 1 &&
          denied.status === 404 &&
          stale.cachedChannel &&
          stale.cachedText.includes("synthetic private content"),
        "failed access notification leaves connected cache stale but HTTP access denied",
      );
      server.gateway.resynchronize();
      await until(
        () => client!.state.status === "online" && !client!.state.channels[channel.id],
        "reconnect removes revoked cache",
        6000,
      );
      const healed = {
        cachedChannel: !!client.state.channels[channel.id],
        cachedTimeline: !!client.state.timelines[channel.id],
        status: client.state.status,
      };
      check(!healed.cachedTimeline, "reconnect removes timeline");
      emit({
        phase: "result",
        mode,
        removed,
        denied,
        injectedReads,
        stale,
        healed,
        scope:
          "actual WorkspaceClient/HTTP/native WebSocket; one local Store.memberships read failure during afterCommit access effect. Already-delivered cached data remains until reconnect; no new server access or private-data leak claimed",
      });
    } else if (mode === "integration_work_counts") {
      const rows: any[] = [];
      const { bot, app, sub } = subscribe(server, people[0]!.id, "https://example.invalid/events");
      server.store.addMember(channel.id, bot.id);
      const isMember = server.store.isMember.bind(server.store),
        getMeta = server.store.getMeta.bind(server.store),
        queue = server.store.enqueueEventDelivery.bind(server.store),
        stringify = JSON.stringify;
      for (const total of [1, 10, 100]) {
        const present = server.store.listSubscriptions(app.id).length;
        for (let i = present; i < total; i++)
          server.store.createSubscription({
            appId: app.id,
            url: "https://example.invalid/events",
            eventTypes: [],
          });
        let eligibilityReads = 0,
          workspaceMetaReads = 0,
          serializations = 0,
          enqueueCalls = 0;
        server.store.isMember = (channelId, userId) => {
          if (userId === bot.id) eligibilityReads++;
          return isMember(channelId, userId);
        };
        server.store.getMeta = (key) => {
          if (key === "workspace_id") workspaceMetaReads++;
          return getMeta(key);
        };
        server.store.enqueueEventDelivery = (...args) => {
          enqueueCalls++;
          return queue(...args);
        };
        JSON.stringify = ((value: any, ...args: any[]) => {
          if (value?.type === "event_callback") serializations++;
          return (stringify as any)(value, ...args);
        }) as typeof JSON.stringify;
        try {
          const response = await http(
            server,
            tokens[0]!,
            `/api/channels/${channel.id}/messages`,
            "POST",
            { text: `count ${total}` },
          );
          check(response.status === 201, "count send");
        } finally {
          server.store.isMember = isMember;
          server.store.getMeta = getMeta;
          server.store.enqueueEventDelivery = queue;
          JSON.stringify = stringify;
        }
        check(
          eligibilityReads === total &&
            workspaceMetaReads === total &&
            serializations === total &&
            enqueueCalls === total,
          "per-subscription duplicated work counts",
        );
        rows.push({
          subscriptions: total,
          distinctBots: 1,
          eligibilityReads,
          workspaceMetaReads,
          sameEnvelopeSerializations: serializations,
          enqueueCalls,
        });
      }
      emit({
        phase: "result",
        mode,
        rows,
        method:
          "actual HTTP POST; delegating method and JSON.stringify counters; one synthetic bot with N eligible subscriptions; isolated outbound; counts only",
      });
    } else if (mode === "private_publication_counts") {
      const publicChannel = server.store.createChannel({
        type: "public",
        name: "probe-public",
        creatorId: people[0]!.id,
        memberIds: people.map((p) => p.id),
      });
      const rows: any[] = [];
      const watchers: Awaited<ReturnType<typeof socket>>[] = [];
      for (const scenario of [
        { name: "private_offline", target: channel, online: 0 },
        { name: "public_offline_control", target: publicChannel, online: 0 },
        { name: "private_two_online", target: channel, online: 2 },
      ]) {
        if (scenario.online)
          for (const token of tokens.slice(1, 3)) watchers.push(await socket(server, token));
        const root = (
          await http(server, tokens[0]!, `/api/channels/${scenario.target.id}/messages`, "POST", {
            text: "root",
          })
        ).body.message;
        const ids = [root.id];
        for (let i = 0; i < 20; i++)
          ids.push(
            (
              await http(
                server,
                tokens[0]!,
                `/api/channels/${scenario.target.id}/messages`,
                "POST",
                { text: `reply ${i}`, threadRootId: root.id },
              )
            ).body.message.id,
          );
        const members = server.store.memberIds.bind(server.store),
          counts = server.store.unreadMentionCounts.bind(server.store);
        let memberListReads = 0,
          memberIdsMaterialized = 0,
          recounts = 0;
        server.store.memberIds = (id) => {
          const found = members(id);
          memberListReads++;
          memberIdsMaterialized += found.length;
          return found;
        };
        server.store.unreadMentionCounts = (id) => {
          recounts++;
          return counts(id);
        };
        let deleted;
        try {
          deleted = await http(server, tokens[0]!, `/api/messages/${root.id}`, "DELETE");
        } finally {
          server.store.memberIds = members;
          server.store.unreadMentionCounts = counts;
        }
        check(deleted.status === 200, "batch deletion accepted");
        for (const w of watchers)
          await until(
            () =>
              w.frames.filter(
                (f) =>
                  f.type === "event" &&
                  f.envelope.event.type === "message.deleted" &&
                  ids.includes(f.envelope.event.messageId),
              ).length === 21,
            "all private deletion frames received",
          );
        const expectedReads =
          scenario.name === "public_offline_control" ? 0 : scenario.online ? 22 : 21;
        check(
          memberListReads === expectedReads && recounts === scenario.online,
          "current private/public batch audience work counts",
        );
        rows.push({
          scenario: scenario.name,
          channelMembers: 50,
          connectedMembers: scenario.online,
          deletedMessages: 21,
          memberListReads,
          memberIdsMaterialized,
          mentionRecounts: recounts,
          deleteHttp: deleted.status,
        });
      }
      for (const w of watchers) w.ws.close();
      emit({
        phase: "result",
        mode,
        rows,
        method:
          "real HTTP posts/deletions and native sockets; delegating memberIds/unreadMentionCounts counters; measured private batch fanout against public offline control; counts only",
      });
    } else if (mode === "current_closures") {
      // REV-02: a hundred failing filesystem removals do not starve a real upload.
      const failing = Array.from({ length: 100 }, (_, i) => `00${String(i).padStart(24, "0")}`);
      for (const id of failing) mkdirSync(join(directory, "files", id));
      server.store.queueFileDeletions(failing);
      const form = new FormData();
      form.append("file", new Blob(["healthy owned probe"]), "healthy.txt");
      const upload = await fetch(
        `http://127.0.0.1:${server.port}/api/channels/${channel.id}/files`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${tokens[0]}` },
          body: form,
          signal: AbortSignal.timeout(5000),
        },
      );
      const file = ((await upload.json()) as any).file;
      check(upload.status === 201, "healthy upload");
      server.store.transaction(() => {
        server.store.deleteFiles([file.id]);
        server.store.queueFileDeletions([file.id]);
      });
      await server.flushFileDeletions();
      await until(
        () => !existsSync(join(directory, "files", file.id)),
        "healthy removal passes failing entries",
      );
      const cleanup = server.store.fileDeletionCounts();
      check(cleanup.retrying === 100 && cleanup.waiting === 0, "failed entries deferred");
      // REV-06/10: private-channel fanout and durable frames with an actual reader.
      const watcher = await socket(server, tokens[1]!);
      const root = (
        await http(server, tokens[0]!, `/api/channels/${channel.id}/messages`, "POST", {
          text: `mention <@${people[1]!.id}>`,
        })
      ).body.message;
      for (let i = 0; i < 20; i++)
        check(
          (
            await http(server, tokens[0]!, `/api/channels/${channel.id}/messages`, "POST", {
              text: `reply ${i}`,
              threadRootId: root.id,
            })
          ).status === 201,
          "reply send",
        );
      const counts = server.store.unreadMentionCounts.bind(server.store),
        sessions = server.store.isSessionActive.bind(server.store);
      let recounts = 0,
        sessionReads = 0;
      server.store.unreadMentionCounts = (...args) => {
        recounts++;
        throw new Error("AUDIT_CONTAINED_RECOUNT");
      };
      server.store.isSessionActive = (...args) => {
        sessionReads++;
        return sessions(...args);
      };
      const deleted = await http(server, tokens[0]!, `/api/messages/${root.id}`, "DELETE");
      server.store.unreadMentionCounts = counts;
      server.store.isSessionActive = sessions;
      await until(
        () =>
          watcher.frames.filter(
            (f) => f.type === "event" && f.envelope.event.type === "message.deleted",
          ).length === 21,
        "all delete frames despite recount failure",
      );
      check(
        deleted.status === 200 && recounts === 1 && watcher.closes.length === 0,
        "committed publication contained and one recount per connected account",
      );
      // REV-06 session scope: a second device on the same token costs one read per fanout.
      const second = await socket(server, tokens[1]!);
      sessionReads = 0;
      server.store.isSessionActive = (...args) => {
        sessionReads++;
        return sessions(...args);
      };
      const ordinary = await http(
        server,
        tokens[0]!,
        `/api/channels/${channel.id}/messages`,
        "POST",
        { text: "ordinary no mention" },
      );
      server.store.isSessionActive = sessions;
      check(ordinary.status === 201 && sessionReads === 1, "one session read reaches two devices");
      emit({
        phase: "result",
        mode,
        cleanup,
        healthyBlobGone: true,
        deleteHttp: deleted.status,
        deleteFrames: 21,
        recounts,
        twoDeviceSessionReads: sessionReads,
        socketCloses: watcher.closes,
        scope:
          "real filesystem upload/unlink failure; real HTTP deletion and native sockets; targeted injected recount only",
      });
      watcher.ws.close();
      second.ws.close();
    } else if (mode === "delivery_queue_recovery") {
      sink = await endpoint();
      const { app, sub } = subscribe(server, people[0]!.id, sink.url);
      server.store.enqueueEventDelivery(sub.id, null, 1, JSON.stringify({ seq: 1 }), 0);
      const due = server.store.dueEventDeliveries.bind(server.store);
      let failedReads = 0;
      server.store.dueEventDeliveries = () => {
        failedReads++;
        throw new Error("AUDIT_NATIVE_DELIVERY_READ");
      };
      await until(() => failedReads > 0, "unaltered five-second delivery timer", 7000);
      const during = await http(server, tokens[0]!, "/api/admin/status");
      const retained = snapshot(server, app.id);
      const health = await http(server, tokens[0]!, "/api/health");
      server.store.dueEventDeliveries = due;
      await until(() => sink!.arrivals.length === 1, "next native delivery tick recovers", 7000);
      await until(() => snapshot(server, app.id).pending === 0, "completion recorded");
      const after = await http(server, tokens[0]!, "/api/admin/status");
      check(
        health.status === 200 &&
          retained.pending === 1 &&
          during.body.backgroundFailures.some((v: any) => v.queue === "event deliveries") &&
          !after.body.backgroundFailures.some((v: any) => v.queue === "event deliveries"),
        "native contained failure retains queue and clears after recovery",
      );
      emit({
        phase: "result",
        mode,
        healthStatus: health.status,
        failedReads,
        retained,
        backgroundDuring: during.body.backgroundFailures,
        backgroundAfter: after.body.backgroundFailures,
        received: sink.arrivals,
        trigger:
          "unaltered production 5000ms interval; one local Store read fault; actual loopback outbound recovers on next interval",
      });
    }
  } finally {
    client?.destroy();
    await server.stop();
    await sink?.close();
  }
}

if (process.argv.includes("--child")) {
  const mode = process.argv[process.argv.indexOf("--child") + 1] as Mode;
  check(modes.includes(mode), "known mode");
  await probe(mode, resolve(process.argv[process.argv.indexOf("--data-dir") + 1]!));
} else {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    windowsHide: true,
    encoding: "utf8",
  }).trim();
  const only = process.argv.includes("--only")
    ? (process.argv[process.argv.indexOf("--only") + 1] as Mode)
    : undefined;
  check(only === undefined || modes.includes(only), "known selected mode");
  const selected = only ? [only] : [...modes];
  const previous =
    only && existsSync(join(here, "server-results.json"))
      ? JSON.parse(readFileSync(join(here, "server-results.json"), "utf8"))
      : undefined;
  check(!previous || previous.revision === revision, "selected rerun uses same source revision");
  const temp = resolve(tmpdir()),
    root = resolve(mkdtempSync(join(temp, "tandem-server-post-"))),
    ownership = randomUUID();
  check(
    inside(temp, root) && basename(root).startsWith("tandem-server-post-"),
    "verified disposable root",
  );
  writeFileSync(join(root, ".owned"), ownership);
  const results: any[] = previous ? previous.results.filter((r: any) => r.mode !== only) : [];
  const harnessCorrections: any[] = previous?.harnessCorrections ?? [];
  if (previous)
    for (const result of previous.results.filter(
      (r: any) => r.mode === only && !r.assertionsPassed,
    ))
      harnessCorrections.push({
        note: "Initial harness used /api/users/me instead of /api/me for its positive connection control; corrected and reran this case only. The failed assertion is not a product finding.",
        result,
      });
  async function run(mode: Mode) {
    const directory = resolve(join(root, mode));
    check(inside(root, directory), "child inside owned root");
    mkdirSync(directory);
    const result = await new Promise<any>((done) => {
      const child = spawn(
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
      child.stdout!.on("data", (v) => (stdout += v));
      child.stderr!.on("data", (v) => (stderr += v));
      child.once("error", (e) => (stderr += String(e)));
      const deadline = setTimeout(
        () => {
          timedOut = true;
          child.kill();
        },
        mode.includes("heartbeat") ? 38_000 : 22_000,
      );
      child.once("close", (exitCode, signal) => {
        clearTimeout(deadline);
        done({
          mode,
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          records: stdout
            .split(/\r?\n/)
            .filter((s) => s.startsWith("AUDIT "))
            .map((s) => JSON.parse(s.slice(6))),
        });
      });
    });
    result.expectedUncaughtExit =
      mode === "gateway_message_failure" ||
      mode === "gateway_sqlite_message_failure" ||
      mode === "gateway_heartbeat_failure";
    result.assertionsPassed =
      !result.timedOut &&
      (result.expectedUncaughtExit
        ? result.exitCode !== 0 &&
          result.stderr.includes(
            mode === "gateway_sqlite_message_failure"
              ? "access to sessions."
              : `AUDIT_${mode.toUpperCase()}_SESSION_READ`,
          )
        : result.exitCode === 0 && result.records.some((r: any) => r.phase === "result"));
    results.push(result);
    writeFileSync(join(here, `server-${mode}.log`), result.stdout + "\nSTDERR:\n" + result.stderr);
    process.stdout.write(
      `${mode}: ${result.assertionsPassed ? "observed as asserted" : "PROBE ERROR"}\n`,
    );
  }
  try {
    // The only simultaneous cases wait on native 30s intervals in separate fixtures.
    const heartbeat = Promise.all(selected.filter((m) => m.includes("heartbeat")).map(run));
    for (const mode of selected.filter((m) => !m.includes("heartbeat"))) await run(mode);
    await heartbeat;
    const endingRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      windowsHide: true,
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(here, "server-results.json"),
      JSON.stringify(
        {
          revision,
          endingRevision,
          generatedAt: new Date().toISOString(),
          runtime: { node: process.version, platform: process.platform },
          timingClaim: "none; work counts and correctness/fault consequences only",
          fixtures: "synthetic owned disposable local workspaces; no live data",
          harnessCorrections,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    check(revision === endingRevision, "revision remained pinned");
    check(
      results.every((r) => r.assertionsPassed),
      "every diagnostic observed expected behavior",
    );
  } finally {
    check(
      inside(temp, root) &&
        isAbsolute(root) &&
        basename(root).startsWith("tandem-server-post-") &&
        readFileSync(join(root, ".owned"), "utf8") === ownership,
      "verify absolute ownership before recursive Windows cleanup",
    );
    rmSync(root, { recursive: true, force: true });
  }
}
