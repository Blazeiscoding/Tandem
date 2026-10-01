/** One bounded real WorkspaceClient/HTTP/native-WebSocket follow-on. */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer } from "../../../packages/server/src/server.ts";
import { hashToken } from "../../../packages/server/src/auth.ts";
import { Api } from "../../../packages/client-core/src/api.ts";
import { WorkspaceClient } from "../../../packages/client-core/src/workspace.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Probe assertion: ${message}`);
}
function inside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function until(read: () => boolean, message: string) {
  const deadline = Date.now() + 6000;
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`Probe deadline: ${message}`);
    await new Promise<void>((done) => setTimeout(done, 10));
  }
}

async function probe(directory: string) {
  const frames: any[] = [];
  let socketNumber = 0;
  const NativeWebSocket = globalThis.WebSocket;
  // Observation only: the inherited native socket sends/receives unchanged.
  class RecordedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const socket = ++socketNumber;
      this.addEventListener("message", (event) =>
        frames.push({ socket, message: JSON.parse(String(event.data)) }),
      );
    }
  }
  globalThis.WebSocket = RecordedWebSocket;
  const server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  });
  const owner = server.store.createUser({
    handle: "owner",
    displayName: "Owner",
    passwordHash: "",
    salt: "",
    role: "owner",
  });
  const reader = server.store.createUser({
    handle: "reader",
    displayName: "Reader",
    passwordHash: "",
    salt: "",
    role: "member",
  });
  const channel = server.store.createChannel({
    type: "private",
    name: "audit",
    creatorId: owner.id,
    memberIds: [owner.id, reader.id],
  });
  const ownerToken = randomUUID(),
    readerToken = randomUUID();
  server.store.createSession(hashToken(ownerToken), owner.id);
  server.store.createSession(hashToken(readerToken), reader.id);
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base, ownerToken);
  const client = new WorkspaceClient(base, readerToken);
  const counts = server.store.unreadMentionCounts.bind(server.store);
  try {
    client.connect();
    await until(() => client.state.status === "online", "reader connected");
    const root = (await api.sendMessage(channel.id, { text: "root to remove" })).message;
    const replies = [];
    for (let index = 0; index < 3; index++)
      replies.push(
        (await api.sendMessage(channel.id, { text: `reply ${index}`, threadRootId: root.id }))
          .message,
      );
    await until(
      () => client.state.lastSeq === server.store.currentSeq(),
      "initial events caught up",
    );
    await client.loadTimeline(channel.id);
    await client.loadThread(root.id, channel.id);
    check(
      client.state.timelines[channel.id]?.items.some((v) => v.id === root.id) &&
        client.state.threads[root.id]?.length === 3,
      "real HTTP caches root and three replies",
    );
    const beforeSeq = server.store.currentSeq();
    server.store.unreadMentionCounts = () => {
      throw new Error("AUDIT_POST_COMMIT_COUNT_FAILURE");
    };
    let deleteHttp = 0;
    try {
      await api.deleteMessage(root.id);
    } catch (error) {
      deleteHttp = (error as any).status;
    }
    server.store.unreadMentionCounts = counts;
    const deletionEnd = server.store.currentSeq();
    await until(() => client.state.lastSeq === beforeSeq + 1, "first deletion frame applied");
    const deletionFrames = frames.filter(
      (v) => v.message.type === "event" && v.message.envelope.event.type === "message.deleted",
    );
    check(
      deleteHttp === 500 && deletionEnd === beforeSeq + 4 && deletionFrames.length === 1,
      "four durable deletions but one transmitted frame",
    );
    const afterDeletion = {
      deleteHttp,
      serverDeletedRoot: server.store.getMessage(root.id) === null,
      durableDeletionEvents: deletionEnd - beforeSeq,
      transmittedDeletionEvents: deletionFrames.length,
      clientSeq: client.state.lastSeq,
      cachedRoot: client.state.timelines[channel.id]!.items.some((v) => v.id === root.id),
      cachedReplies: client.state.threads[root.id]?.length,
    };
    const later = (await api.sendMessage(channel.id, { text: "later normal message" })).message;
    await until(() => client.state.lastSeq === later.seq, "later normal event advances checkpoint");
    const skippedSeqs = Array.from({ length: 3 }, (_, index) => beforeSeq + index + 2);
    const laterCheckpoint = client.state.lastSeq;
    check(
      laterCheckpoint > deletionEnd &&
        skippedSeqs.every(
          (seq) =>
            !frames.some((v) => v.message.type === "event" && v.message.envelope.seq === seq),
        ),
      "checkpoint passes unpublished deletion range",
    );
    (client as any).ws.close(4001, "audit reconnect");
    await until(() => client.state.status === "reconnecting", "real socket close enters reconnect");
    await until(
      () => socketNumber === 2 && client.state.status === "online",
      "automatic reconnect completes",
    );
    const reconnectFrames = frames.filter((v) => v.socket === 2);
    const ready = reconnectFrames.find((v) => v.message.type === "ready")!.message;
    const afterReconnect = {
      socketsCreated: socketNumber,
      replayFrom: ready.replayFrom,
      snapshotSeq: ready.seq,
      clientSeq: client.state.lastSeq,
      replayedEvents: reconnectFrames.filter((v) => v.message.type === "event").length,
      cachedRoot: client.state.timelines[channel.id]!.items.some((v) => v.id === root.id),
      cachedReplies: client.state.threads[root.id]?.length,
    };
    check(
      afterReconnect.replayFrom === laterCheckpoint &&
        afterReconnect.replayedEvents === 0 &&
        afterReconnect.cachedRoot &&
        afterReconnect.cachedReplies === 2,
      "automatic reconnect preserves stale deleted content",
    );
    await client.loadTimeline(channel.id, { latest: true });
    const afterExplicitLatest = {
      cachedRoot: client.state.timelines[channel.id]!.items.some((v) => v.id === root.id),
      laterNormalMessageVisible: client.state.timelines[channel.id]!.items.some(
        (v) => v.id === later.id,
      ),
    };
    check(
      !afterExplicitLatest.cachedRoot && afterExplicitLatest.laterNormalMessageVisible,
      "explicit fresh history can recover timeline",
    );
    return {
      method:
        "actual WorkspaceClient with unmodified API/history/state/reconnect logic; observation-only native WebSocket subclass; isolated server count-read fault injection",
      afterDeletion,
      skippedSeqs,
      laterCheckpoint,
      afterReconnect,
      afterExplicitLatest,
      receivedFrames: frames,
      timingClaim: "none",
      scopeLimit:
        "automatic reconnect fails to recover this cache; explicit latest history can recover it, so absolute irrecoverability is not claimed",
    };
  } finally {
    server.store.unreadMentionCounts = counts;
    client.destroy();
    await server.stop();
    globalThis.WebSocket = NativeWebSocket;
  }
}

if (process.argv.includes("--child")) {
  const directory = resolve(process.argv[process.argv.indexOf("--data-dir") + 1]!);
  const result = await probe(directory);
  process.stdout.write(`AUDIT ${JSON.stringify(result)}\n`);
} else {
  const temp = resolve(tmpdir()),
    root = resolve(mkdtempSync(join(temp, "gatherline-server-gap-"))),
    ownership = randomUUID();
  check(
    inside(temp, root) && basename(root).startsWith("gatherline-server-gap-"),
    "owned root location checked",
  );
  writeFileSync(join(root, ".owned"), ownership);
  const directory = resolve(join(root, "workspace"));
  check(inside(root, directory), "fixture inside owned root");
  mkdirSync(directory);
  try {
    const result = await new Promise<any>((done) => {
      const child = spawn(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), "--child", "--data-dir", directory],
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
      child.stdout.on("data", (value) => (stdout += value));
      child.stderr.on("data", (value) => (stderr += value));
      child.once("error", (error) => (stderr += String(error)));
      const deadline = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 20000);
      child.once("close", (exitCode, signal) => {
        clearTimeout(deadline);
        done({
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          records: stdout
            .split(/\r?\n/)
            .filter((v) => v.startsWith("AUDIT "))
            .map((v) => JSON.parse(v.slice(6))),
        });
      });
    });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    writeFileSync(
      join(here, "server-publication-gap-results.json"),
      JSON.stringify(
        {
          revision,
          generatedAt: new Date().toISOString(),
          runtime: { node: process.version, platform: process.platform },
          result,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(here, "server-publication-gap.log"),
      result.stdout + "\n--- STDERR ---\n" + result.stderr,
    );
    check(
      result.exitCode === 0 && !result.timedOut && result.records.length === 1,
      "bounded child completes asserted reproduction",
    );
    process.stdout.write(
      JSON.stringify({
        exitCode: result.exitCode,
        afterDeletion: result.records[0].afterDeletion,
        afterReconnect: result.records[0].afterReconnect,
        afterExplicitLatest: result.records[0].afterExplicitLatest,
      }) + "\n",
    );
  } finally {
    const target = resolve(root);
    check(
      inside(temp, target) &&
        basename(target).startsWith("gatherline-server-gap-") &&
        readFileSync(join(target, ".owned"), "utf8") === ownership,
      "resolved recursive cleanup and ownership checked",
    );
    rmSync(target, { recursive: true, force: true });
  }
}
