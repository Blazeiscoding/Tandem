/**
 * How long database work holds up the event loop the desktop app's window
 * shares with its embedded server. The server runs in Electron's main
 * process, so while a synchronous SQLite call runs, the window cannot be moved
 * or resized smoothly and no IPC call is answered.
 *
 * Seeds a workspace with `--messages` messages (50,000 by default), half of
 * them older than the retention window, then times the longest single stall
 * during each piece of work. Run with the server package's tsx:
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-stall.mts
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  backupWorkspace,
  createWorkspaceServer,
  verifyBackup,
  type WorkspaceServer,
} from "../packages/server/src/index.js";

const count = Number(
  process.argv.find((a) => a.startsWith("--messages="))?.split("=")[1] ?? 50_000,
);
const WORDS =
  "the release plan design review ship friday numbers quarterly budget customer bug fix deploy staging meeting notes draft proposal roadmap sprint retro launch onboarding migration database search thread reply".split(
    " ",
  );
const sentence = (i: number) => {
  const length = 12 + (i % 30);
  const words: string[] = [];
  for (let w = 0; w < length; w++) words.push(WORDS[(i * 7 + w * 13) % WORDS.length]!);
  // One message in a thousand says something unusual, as a search usually looks for.
  if (i % 1000 === 0) words.push("zeppelin");
  return words.join(" ");
};

/** Runs `work`, returning how long it took and the longest the loop went unserved. */
async function measure(label: string, work: () => unknown): Promise<void> {
  let last = performance.now();
  let longest = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  await work();
  const took = performance.now() - started;
  // One more beat, so a stall at the very end is counted.
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(beat);
  longest = Math.max(longest, performance.now() - last - 5);
  console.log(
    `${label.padEnd(44)} took ${took.toFixed(0).padStart(6)} ms, longest stall ${longest.toFixed(0).padStart(5)} ms`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "gatherline-stall-"));
const dataDir = join(dir, "workspace");
const retentionDays = 30;
let server: WorkspaceServer | undefined;
try {
  const options = {
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  } as const;
  server = await createWorkspaceServer(options);
  const base = () => `http://127.0.0.1:${server!.port}`;
  const owner = (await (
    await fetch(`${base()}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    })
  ).json()) as { token: string; user: { id: string } };

  // Five channels, a tenth of messages replies, half older than the window.
  const store = server.store;
  const channels = [store.getChannelByName("general")!.id];
  for (const name of ["design", "engineering", "support", "random"]) {
    const res = await fetch(`${base()}/api/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ type: "public", name }),
    });
    channels.push(((await res.json()) as { channel: { id: string } }).channel.id);
  }
  const realNow = Date.now.bind(Date);
  const start = realNow() - 2 * retentionDays * 24 * 3600_000;
  const step = (2 * retentionDays * 24 * 3600_000) / count;
  const seeded = performance.now();
  let roots: string[] = [];
  for (let batch = 0; batch < count; batch += 1000) {
    store.transaction(() => {
      for (let i = batch; i < Math.min(count, batch + 1000); i++) {
        Date.now = () => Math.floor(start + i * step);
        const channelId = channels[i % channels.length]!;
        const reply = i % 10 === 9 && roots.length > 0;
        const message = store.createMessage({
          channelId,
          userId: owner.user.id,
          text: sentence(i),
          threadRootId: reply ? roots[roots.length - 1]! : null,
          nonce: null,
        });
        // Posting stamps each message with its place in the event log.
        store.stampMessageSeq(message.id, channelId, 1_000_000 + i);
        if (!reply) roots.push(message.id);
      }
    });
    roots = roots.slice(-50);
  }
  Date.now = realNow;
  const bytes = statSync(join(dataDir, "workspace.db")).size;
  console.log(
    `Seeded ${count.toLocaleString()} messages in ${((performance.now() - seeded) / 1000).toFixed(1)} s; database ${(bytes / 1024 / 1024).toFixed(1)} MB\n`,
  );

  // Someone else, in every channel, who has read all but the last few hundred.
  const reader = (await (
    await fetch(`${base()}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "reader", displayName: "Reader", password: "password123" }),
    })
  ).json()) as { token: string };
  const asReader = (path: string, body?: unknown) =>
    fetch(base() + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${reader.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json());
  for (const channelId of channels) {
    if (channelId !== channels[0]) await asReader(`/api/channels/${channelId}/join`, {});
    await asReader(`/api/channels/${channelId}/read`, { seq: 1_000_000 + count - 300 });
  }
  const get = (path: string) => asReader(path);
  await measure("Searching for a word in every message", () => get("/api/search?q=release"));
  await measure("Searching for a word in one in a thousand", () => get("/api/search?q=zeppelin"));
  await measure("Searching for a phrase", () => get('/api/search?q="design%20review"'));
  await measure("Opening a channel's newest page", () =>
    get(`/api/channels/${channels[1]}/messages`),
  );
  await measure("Activity, unread", () => get("/api/activity?mode=unread"));
  await measure("Backing up while running", () =>
    backupWorkspace({ dataDir, out: join(dir, "backup") }),
  );
  await measure("Verifying that backup", () => verifyBackup(join(dir, "backup")));
  await measure(
    "Backing up on a worker thread",
    () =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL("./measure-stall-worker.mts", import.meta.url), {
          workerData: { dataDir, out: join(dir, "backup-worker") },
          execArgv: ["--import", "tsx"],
        });
        worker.once("message", () => resolve());
        worker.once("error", reject);
      }),
  );
  await measure("Stopping", () => server!.stop());
  server = undefined;
  await measure("Starting on the seeded workspace", async () => {
    server = await createWorkspaceServer(options);
  });
  await server!.stop();
  server = undefined;
  await measure(`Starting with ${retentionDays}-day retention (first sweep)`, async () => {
    server = await createWorkspaceServer({ ...options, retentionDays });
  });
  await measure("One further retention sweep", () => server!.applyRetention());
} finally {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}
