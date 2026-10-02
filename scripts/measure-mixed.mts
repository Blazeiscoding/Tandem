/**
 * A mixed workload on one server, repeatable enough to compare two builds
 * (IMP-07). People post in several channels while others search, devices
 * drop and reconnect, and maintenance runs, all at once, on a workspace
 * seeded from `--seed`. Every post must reach every connected device, every
 * search must answer, every reconnect must catch up; the fixture is checked
 * before anything is timed, and a run with errors says so rather than
 * reporting the speed of failing.
 *
 * Uses Node's own WebSocket, so it needs nothing the root does not have.
 *
 * Writes one JSON artifact: the source revision, seed and parameters, the
 * machine and runtime, then per measure the samples, p50/p95/p99, spread
 * across rounds and errors; plus how long the event loop went unserved and
 * memory before and after. Run with the server package's tsx:
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-mixed.mts \
 *     [--seed=1] [--people=12] [--devices=2] [--history=20000] [--rounds=3] \
 *     [--seconds=8] [--out=mixed.json]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { PROTOCOL_VERSION, type ServerToClient } from "../packages/protocol/src/index.js";
import { createWorkspaceServer, type WorkspaceServer } from "../packages/server/src/index.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const params = {
  seed: arg("seed", 1),
  people: arg("people", 12),
  devices: arg("devices", 2),
  history: arg("history", 20_000),
  rounds: arg("rounds", 3),
  seconds: arg("seconds", 8),
};
const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];

/** A small seeded generator, so a seed always makes the same workspace and workload. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = generator(params.seed);
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;

const WORDS =
  "the release plan design review ship friday numbers quarterly budget customer bug fix deploy staging meeting notes draft proposal roadmap sprint retro launch onboarding migration database search thread reply".split(
    " ",
  );
const SEARCHED = ["release", "budget", "deploy", "roadmap", "migration", "zeppelin"];
const sentence = (length: number) =>
  Array.from({ length }, () => pick(WORDS)).join(" ") + (random() < 0.001 ? " zeppelin" : "");

/** The body of a successful response; anything else is an error for the run. */
async function succeeded<T = unknown>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Samples of one measure, and what failed while taking them. */
class Measure {
  readonly rounds: number[][] = [];
  errors = 0;
  readonly firstErrors: string[] = [];
  round() {
    this.rounds.push([]);
  }
  add(ms: number) {
    this.rounds.at(-1)!.push(ms);
  }
  fail(error: unknown) {
    this.errors++;
    if (this.firstErrors.length < 3)
      this.firstErrors.push(error instanceof Error ? error.message : String(error));
  }
  summary() {
    const all = this.rounds.flat().sort((a, b) => a - b);
    const at = (q: number, xs = all) =>
      xs.length ? +xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!.toFixed(2) : null;
    const p95s = this.rounds.map(
      (r) =>
        at(
          0.95,
          [...r].sort((a, b) => a - b),
        ) ?? 0,
    );
    const mean = p95s.reduce((s, x) => s + x, 0) / Math.max(1, p95s.length);
    return {
      samples: all.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: all.length ? +all.at(-1)!.toFixed(2) : null,
      p95ByRound: p95s,
      // Spread of the rounds' p95 around their mean: how far one run can be trusted.
      p95SpreadPct:
        p95s.length > 1 ? +(((Math.max(...p95s) - Math.min(...p95s)) / mean) * 100).toFixed(1) : 0,
      errors: this.errors,
      ...(this.firstErrors.length ? { firstErrors: this.firstErrors } : {}),
    };
  }
}

function revision() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return { revision: head, dirty };
  } catch {
    return { revision: process.env.GITHUB_SHA ?? "unknown", dirty: null };
  }
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "gatherline-mixed-")));
let server: WorkspaceServer | undefined;
const sockets: WebSocket[] = [];
const measures = {
  post: new Measure(),
  fanout: new Measure(),
  search: new Measure(),
  reconnect: new Measure(),
  maintenance: new Measure(),
};
const loop: { p50: number; p99: number; max: number }[] = [];
try {
  server = await createWorkspaceServer({
    dataDir: join(dir, "workspace"),
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    retentionDays: 365,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, token: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  // People, channels everyone is in, and seeded history.
  const people: { token: string; id: string }[] = [];
  for (let i = 0; i < params.people; i++) {
    const { token, user } = await succeeded<{ token: string; user: { id: string } }>(
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: `person${i}`,
          displayName: `Person ${i}`,
          password: "password123",
        }),
      }),
    );
    people.push({ token, id: user.id });
  }
  const store = server.store;
  const channels = [store.getChannelByName("general")!.id];
  for (const name of ["design", "engineering", "support"]) {
    const { channel } = await succeeded<{ channel: { id: string } }>(
      await post("/api/channels", people[0]!.token, { type: "public", name }),
    );
    channels.push(channel.id);
  }
  for (const channelId of channels)
    for (const person of people) store.addMember(channelId, person.id);
  const realNow = Date.now.bind(Date);
  const start = realNow() - 180 * 24 * 3600_000;
  const step = (180 * 24 * 3600_000) / params.history;
  for (let batch = 0; batch < params.history; batch += 1000) {
    store.transaction(() => {
      for (let i = batch; i < Math.min(params.history, batch + 1000); i++) {
        Date.now = () => Math.floor(start + i * step);
        const channelId = pick(channels);
        const message = store.createMessage({
          channelId,
          userId: pick(people).id,
          text: sentence(8 + Math.floor(random() * 30)),
          threadRootId: null,
          nonce: null,
        });
        store.stampMessageSeq(message.id, channelId, 1_000_000 + i);
      }
    });
  }
  Date.now = realNow;

  // Every device of every person, connected and caught up.
  type Device = { ws: WebSocket; person: number; seen: Map<string, number>; seq: number };
  const connect = (person: number, lastSeq: number | null) =>
    new Promise<Device>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/ws");
      sockets.push(ws);
      const device: Device = { ws, person, seen: new Map(), seq: lastSeq ?? 0 };
      const timer = setTimeout(() => reject(new Error("not caught up within 10 s")), 10_000);
      ws.addEventListener("message", (message) => {
        const frame = JSON.parse(String(message.data)) as ServerToClient;
        if (frame.type === "event") {
          device.seq = Math.max(device.seq, frame.envelope.seq);
          if (frame.envelope.event.type === "message.created")
            device.seen.set(frame.envelope.event.message.text, performance.now());
        } else if (frame.type === "synced") {
          // Caught up: the snapshot, then everything since `lastSeq`.
          device.seq = Math.max(device.seq, frame.seq);
          clearTimeout(timer);
          resolve(device);
        }
      });
      ws.addEventListener("error", () => reject(new Error("socket error")));
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({
            type: "hello",
            token: people[person]!.token,
            lastSeq,
            syncVersion: 1,
            protocolVersion: PROTOCOL_VERSION,
          }),
        ),
      );
    });
  const devices: Device[] = [];
  for (let p = 0; p < params.people; p++)
    for (let d = 0; d < params.devices; d++) devices.push(await connect(p, null));

  // Checked before anything is timed: a post reaches every device, a search answers.
  const check = `fixture check ${realNow()}`;
  await succeeded(
    await post(`/api/channels/${channels[0]}/messages`, people[0]!.token, { text: check }),
  );
  const deadline = realNow() + 5_000;
  while (devices.some((d) => !d.seen.has(check)) && realNow() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  if (devices.some((d) => !d.seen.has(check)))
    throw new Error("fixture check: a post did not reach every device");
  const found = await succeeded<{ messages: unknown[] }>(
    await fetch(`${base}/api/search?q=release`, {
      headers: { authorization: `Bearer ${people[0]!.token}` },
    }),
  );
  if (found.messages.length === 0) throw new Error("fixture check: search found nothing seeded");

  const memoryBefore = process.memoryUsage();
  let posted = 0;
  for (let round = 0; round < params.rounds; round++) {
    for (const m of Object.values(measures)) m.round();
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const until = realNow() + params.seconds * 1000;
    const waiting: Promise<void>[] = [];

    const chatter = async (person: number) => {
      while (realNow() < until) {
        const text = `round ${round} post ${posted++} ${sentence(10)}`;
        const sent = performance.now();
        try {
          await succeeded(
            await post(`/api/channels/${pick(channels)}/messages`, people[person]!.token, { text }),
          );
          measures.post.add(performance.now() - sent);
          waiting.push(
            (async () => {
              const giveUp = realNow() + 10_000;
              while (devices.some((d) => !d.seen.has(text)) && realNow() < giveUp)
                await new Promise((r) => setTimeout(r, 5));
              if (devices.some((d) => !d.seen.has(text)))
                measures.fanout.fail(new Error("a post did not reach every device in 10 s"));
              else measures.fanout.add(Math.max(...devices.map((d) => d.seen.get(text)!)) - sent);
            })(),
          );
        } catch (error) {
          measures.post.fail(error);
        }
        await new Promise((r) => setTimeout(r, 40 + random() * 80));
      }
    };
    const searcher = async (person: number) => {
      while (realNow() < until) {
        const sent = performance.now();
        try {
          await succeeded(
            await fetch(`${base}/api/search?q=${encodeURIComponent(pick(SEARCHED))}`, {
              headers: { authorization: `Bearer ${people[person]!.token}` },
            }),
          );
          measures.search.add(performance.now() - sent);
        } catch (error) {
          measures.search.fail(error);
        }
        await new Promise((r) => setTimeout(r, 100 + random() * 200));
      }
    };
    // A device of its own drops and comes back, catching up from where it was.
    const roamer = async (person: number) => {
      let device = await connect(person, null);
      while (realNow() < until) {
        await new Promise((r) => setTimeout(r, 500 + random() * 1000));
        const lastSeq = device.seq;
        device.ws.close();
        const sent = performance.now();
        try {
          device = await connect(person, lastSeq);
          measures.reconnect.add(performance.now() - sent);
        } catch (error) {
          measures.reconnect.fail(error);
        }
      }
      device.ws.close();
    };
    const maintenance = async () => {
      await new Promise((r) => setTimeout(r, (params.seconds * 1000) / 2));
      const sent = performance.now();
      try {
        server!.applyRetention();
        await server!.flushFileDeletions();
        measures.maintenance.add(performance.now() - sent);
      } catch (error) {
        measures.maintenance.fail(error);
      }
    };
    await Promise.all([
      ...[0, 1, 2, 3].map(chatter),
      ...[4, 5].map(searcher),
      ...[6, 7].map(roamer),
      maintenance(),
    ]);
    await Promise.all(waiting);
    delay.disable();
    loop.push({
      p50: +(delay.percentile(50) / 1e6).toFixed(2),
      p99: +(delay.percentile(99) / 1e6).toFixed(2),
      max: +(delay.max / 1e6).toFixed(2),
    });
  }
  const memoryAfter = process.memoryUsage();

  const result = {
    measure: "mixed chat/search/reconnect/maintenance (IMP-07)",
    ...revision(),
    params,
    machine: {
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
      os: `${platform()} ${release()} ${arch()}`,
    },
    runtime: { node: process.version },
    cache: "warm: one process, fixture seeded before timing",
    devices: devices.length,
    results: Object.fromEntries(Object.entries(measures).map(([k, m]) => [k, m.summary()])),
    // Sampled every millisecond, so an idle loop reads about 1 ms.
    eventLoopDelayMsByRound: loop,
    memoryMiB: {
      rssBefore: +(memoryBefore.rss / 2 ** 20).toFixed(1),
      rssAfter: +(memoryAfter.rss / 2 ** 20).toFixed(1),
      heapUsedAfter: +(memoryAfter.heapUsed / 2 ** 20).toFixed(1),
    },
    errors: Object.values(measures).reduce((n, m) => n + m.errors, 0),
  };
  const json = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, json + "\n");
  console.log(json);
  if (result.errors > 0) process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
  await server?.stop().catch(() => {});
  // Only the folder this run made, under the system's temporary folder.
  if (dir.startsWith(realpathSync(tmpdir()) + sep) && dir.includes("gatherline-mixed-"))
    rmSync(dir, { recursive: true, force: true });
}
