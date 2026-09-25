import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createHostingController,
  parseLastHosted,
  type HostingSnapshot,
} from "../src/main/hosting.js";
import { parseRegistry, readWorkspace, type HostedWorkspace } from "../src/main/registry.js";
import type { Tunnel } from "../src/main/tunnel.js";

interface StartRequest {
  workspaceName?: string;
  port: number;
  dataDir: string;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A profile folder of its own, removed after the test. */
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), "gatherline-hosting-"));
  roots.push(root);
  return root;
}

/** A workspace database as the server leaves it, holding just its identity. */
function workspaceDb(dataDir: string, id: string | null, name: string): void {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "workspace.db"));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (id) db.prepare("INSERT INTO meta VALUES ('workspace_id', ?)").run(id);
  db.prepare("INSERT INTO meta VALUES ('workspace_name', ?)").run(name);
  db.close();
}

const NEW_FOLDER = /^w-[0-9a-f]{32}$/;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const inUse = () =>
  Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" });

/** A controller over fake servers, with hooks to hold or fail each step. */
function harness(
  options: {
    publicAccess?: boolean;
    publicAddress?: () => { setting?: string; url?: string; managed?: boolean; error?: string };
    savePublicAddress?: (address: string | null) => Promise<void> | void;
    verifyLoopback?: (port: number, instanceId?: string) => Promise<boolean>;
    /** Share a profile and settings with an earlier harness, as a second launch would. */
    root?: string;
    settings?: Map<string, unknown>;
  } = {},
) {
  const root = options.root ?? profile();
  const dataRoot = join(root, "hosted");
  type FakeTunnel = Tunnel & { close: Mock<() => Promise<void>>; drop(reason: string): void };
  const h = {
    starts: [] as StartRequest[],
    servers: [] as { port: number; stop: Mock<() => Promise<void>> }[],
    dataRoot,
    /** The settings file, as keys and values. */
    settings: options.settings ?? new Map<string, unknown>(),
    /** Each value written for earlier versions' `lastHosted`. */
    saved: [] as unknown[],
    /** What each fake server keeps in its database, by folder path. */
    databases: new Map<string, { id: string | null; name: string | null }>(),
    readFails: false,
    clock: 1000,
    /** Each backup the server was asked for, and the free space the disk reports. */
    backups: [] as { dataDir: string; out: string }[],
    free: Number.MAX_SAFE_INTEGER,
    changes: [] as HostingSnapshot[],
    /** Runs as each server binds; throw to fail that attempt, or return a promise to hold it. */
    beforeBind: (_port: number): Promise<void> | void => {},
    saveFails: false,
    notifyFails: false,
    accountCount: 1,
    inviteOnly: false,
    policyCalls: [] as boolean[],
    proxyTrust: [] as boolean[],
    publicUrls: [] as (string | null)[],
    savedPublicAddresses: [] as (string | null)[],
    iceServers: [] as { urls: string }[][],
    tunnelStarts: [] as { port: number; signal: AbortSignal; instanceId?: string }[],
    tunnels: [] as FakeTunnel[],
    events: [] as string[],
    beforeTunnel: (_port: number, _signal: AbortSignal): Promise<void> | void => {},
    controller: undefined as unknown as ReturnType<typeof createHostingController>,
  };
  /** The fake servers' databases first, then any real one a test wrote. */
  const inside = (dataDir: string) => h.databases.get(dataDir) ?? readWorkspace(dataDir);
  h.controller = createHostingController({
    dataRoot,
    defaultPort: 8543,
    lanUrls: (port) => [`192.168.1.20:${port}`],
    now: () => h.clock++,
    readWorkspace: inside,
    backupWorkspace: async (request) => {
      h.backups.push(request);
      return { files: [] };
    },
    freeBytes: async () => h.free,
    settings: {
      get: async (key, { strict } = {}) => {
        if (h.readFails && strict) throw new Error("Could not read settings.");
        return h.settings.has(key) ? h.settings.get(key) : null;
      },
      set: async (key, value) => {
        if (h.saveFails) throw new Error("settings file is read-only");
        h.settings.set(key, structuredClone(value));
        if (key === "lastHosted") h.saved.push(value);
      },
    },
    startServer: async (request) => {
      h.starts.push(request);
      await h.beforeBind(request.port);
      // The server keeps the name it has unless it is given one, as the real one does.
      const kept = inside(request.dataDir);
      const db = {
        id: kept?.id ?? `ws-${h.databases.size + 1}`,
        name: request.workspaceName ?? kept?.name ?? null,
      };
      h.databases.set(request.dataDir, db);
      const server = {
        port: request.port === 0 ? 50123 : request.port,
        instanceId: "workspace-run-1",
        workspaceId: () => db.id,
        workspaceName: () => db.name ?? "Unnamed",
        stop: vi.fn(async () => {}),
        ...(options.publicAccess
          ? {
              setTrustLoopbackProxy: (enabled: boolean) => h.proxyTrust.push(enabled),
              setPublicUrl: (url: string | null) => h.publicUrls.push(url),
              setIceServers: (servers: { urls: string }[]) => h.iceServers.push(servers),
              inviteOnly: () => h.inviteOnly,
              setInviteOnly: (value: boolean) => {
                h.events.push(`policy:${value}`);
                h.policyCalls.push(value);
                h.inviteOnly = value;
              },
              accountCount: () => h.accountCount,
            }
          : {}),
      };
      h.servers.push(server);
      return server;
    },
    onChange: () => {
      if (h.notifyFails) throw new Error("window already destroyed");
      h.changes.push(h.controller.status());
    },
    ...(options.publicAccess
      ? {
          tunnelAvailable: () => true,
          openTunnel: async (port: number, signal: AbortSignal, instanceId?: string) => {
            h.events.push("tunnel:open");
            h.tunnelStarts.push({ port, signal, instanceId });
            await h.beforeTunnel(port, signal);
            let listener: ((reason: string) => void) | undefined;
            const tunnel: FakeTunnel = {
              url: "https://rocket-team.trycloudflare.com",
              close: vi.fn(async () => {}),
              onUnexpectedExit: (next) => {
                listener = next;
              },
              drop: (reason) => listener?.(reason),
            };
            h.tunnels.push(tunnel);
            return tunnel;
          },
        }
      : {}),
    ...(options.publicAddress ? { publicAddress: options.publicAddress } : {}),
    ...(options.verifyLoopback ? { verifyLoopback: options.verifyLoopback } : {}),
    savePublicAddress: async (address: string | null) => {
      await options.savePublicAddress?.(address);
      h.savedPublicAddresses.push(address);
    },
  });
  return h;
}

/** The list of hosted workspaces as the settings file holds it. */
function registryOf(h: ReturnType<typeof harness>): HostedWorkspace[] {
  return parseRegistry(h.settings.get("hostedWorkspaces"));
}

describe("hosting a workspace from the desktop app", () => {
  it("starts a new workspace on the usual port, in a folder of its own, and lists it", async () => {
    const h = harness();
    const status = await h.controller.start({ workspaceName: "  Rocket Team " });
    const [entry] = registryOf(h);
    expect(entry).toEqual({
      id: "ws-1",
      folder: expect.stringMatching(NEW_FOLDER),
      name: "Rocket Team",
      port: 8543,
      lastHostedAt: expect.any(Number),
    });
    const dataDir = join(h.dataRoot, entry!.folder);
    expect(h.starts).toEqual([{ workspaceName: "Rocket Team", port: 8543, dataDir }]);
    expect(status).toEqual({
      running: true,
      phase: "running",
      workspaceName: "Rocket Team",
      folder: entry!.folder,
      dataDir,
      port: 8543,
      lanUrls: ["192.168.1.20:8543"],
    });
    // An earlier version would look for rocket-team, which is not this one.
    expect(h.saved).toEqual([null]);
    expect(h.changes.map((c) => c.phase)).toEqual(["starting", "running", "running"]);
  });

  it("gives names that differ only by punctuation or script workspaces of their own", async () => {
    const h = harness();
    for (const name of ["Team A", "Team-A", "team a!", "日本", "Команда"]) {
      await h.controller.start({ workspaceName: name });
      await h.controller.stop();
    }
    const folders = h.starts.map((start) => start.dataDir);
    expect(new Set(folders).size).toBe(5);
    // Each server was told its own name, so none renamed another.
    expect(registryOf(h).map((entry) => entry.name)).toEqual([
      "Team A",
      "Team-A",
      "team a!",
      "日本",
      "Команда",
    ]);
  });

  it("reopens a workspace by its entry, on its own port, without giving it a name", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team", port: 9001 });
    await h.controller.stop();
    const [entry] = registryOf(h);
    const status = await h.controller.start({ folder: entry!.folder });
    // No name is passed, so the server keeps the one it has.
    expect(h.starts[1]).toEqual({ port: 9001, dataDir: join(h.dataRoot, entry!.folder) });
    expect(status).toMatchObject({ running: true, workspaceName: "Rocket Team", port: 9001 });
    expect(await h.controller.lastHosted()).toEqual({
      folder: entry!.folder,
      workspaceName: "Rocket Team",
      port: 9001,
    });
  });

  it("refuses a request it cannot act on before touching anything", async () => {
    const h = harness();
    for (const bad of [
      undefined,
      null,
      "Rocket Team",
      ["Rocket Team"],
      {},
      { workspaceName: "" },
      { workspaceName: "   " },
      { workspaceName: "x".repeat(81) },
      { workspaceName: "Rocket\nTeam" },
      { workspaceName: "Rocket Team", port: 8543.5 },
      { workspaceName: "Rocket Team", port: -1 },
      { workspaceName: "Rocket Team", port: 65536 },
      { workspaceName: "Rocket Team", port: "8543" },
      { folder: 5 },
      { folder: "rocket-team", workspaceName: "Rocket Team" },
      { folder: "not-listed" },
    ]) {
      await expect(h.controller.start(bad)).rejects.toThrow();
    }
    expect(h.starts).toEqual([]);
    expect(h.changes).toEqual([]);
    expect(h.controller.status()).toEqual({ running: false, phase: "stopped" });
    // The longest name allowed is still allowed.
    await expect(h.controller.start({ workspaceName: "x".repeat(80) })).resolves.toMatchObject({
      running: true,
    });
  });

  it("moves to a free port only when the port was its own choice", async () => {
    const automatic = harness();
    automatic.beforeBind = (port) => {
      if (port === 8543) throw inUse();
    };
    const status = await automatic.controller.start({ workspaceName: "Rocket Team" });
    expect(automatic.starts.map((s) => s.port)).toEqual([8543, 0]);
    expect(status.port).toBe(50123);
    // Whatever took 8543 is still answering there, so say where this went.
    expect(status.warning).toMatch(/8543 was already in use.*on 50123/);

    const chosen = harness();
    chosen.beforeBind = (port) => {
      if (port === 9000) throw inUse();
    };
    await expect(
      chosen.controller.start({ workspaceName: "Rocket Team", port: 9000 }),
    ).rejects.toThrow(/EADDRINUSE/);
    expect(chosen.starts.map((s) => s.port)).toEqual([9000]);
    expect(chosen.controller.status()).toEqual({ running: false, phase: "stopped" });
  });

  it("reports a failed start once, and leaves nothing claiming to be hosted", async () => {
    const h = harness();
    h.beforeBind = () => {
      throw Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    };
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow("EACCES");
    // Not retried elsewhere, not remembered, and no lasting warning to repeat
    // what the caller has already been told.
    expect(h.starts).toHaveLength(1);
    expect(h.saved).toEqual([]);
    expect(h.controller.status()).toEqual({ running: false, phase: "stopped" });
    // A new workspace that never started is taken back out, folder and all.
    expect(registryOf(h)).toEqual([]);
    expect(readdirSync(h.dataRoot)).toEqual([]);
  });

  it("keeps a started workspace running when its settings cannot be saved, and saves them later", async () => {
    const h = harness();
    // Listed before it started, then unable to record where it ended up.
    h.beforeBind = () => {
      h.saveFails = true;
    };
    const status = await h.controller.start({ workspaceName: "Rocket Team" });
    expect(status).toMatchObject({
      running: true,
      phase: "running",
      warning: expect.stringMatching(/could not be saved/),
    });
    expect(h.servers[0]!.stop).not.toHaveBeenCalled();

    h.saveFails = false;
    const again = await h.controller.start({ workspaceName: "Rocket Team" });
    expect(h.starts).toHaveLength(1);
    expect(registryOf(h)).toEqual([expect.objectContaining({ id: "ws-1", port: 8543 })]);
    expect(again.warning).toBeUndefined();
  });

  it("says so when the port was bound but loopback reaches something else", async () => {
    // Windows lets a wildcard bind succeed beside an existing 127.0.0.1 one,
    // so there is no EADDRINUSE to catch: the port is held and still leads
    // somewhere else.
    const h = harness({ verifyLoopback: async () => false });

    const status = await h.controller.start({ workspaceName: "Rocket Team" });

    expect(status.port).toBe(8543);
    expect(status.warning).toMatch(/Another program is answering on http:\/\/127\.0\.0\.1:8543/);
    // The workspace is genuinely running, and still reachable where it is.
    expect(status.running).toBe(true);
    expect(status.warning).toContain("192.168.1.20:8543");
  });

  it("stays quiet when loopback reaches this run, or cannot be checked at all", async () => {
    const reaches = harness({ verifyLoopback: async () => true });
    expect(
      (await reaches.controller.start({ workspaceName: "Rocket Team" })).warning,
    ).toBeUndefined();

    // A probe that throws knows nothing about who owns the port. Warning on
    // that would cry wolf on every machine where the check cannot run.
    const broken = harness({
      verifyLoopback: async () => {
        throw new Error("fetch is unavailable");
      },
    });
    expect(
      (await broken.controller.start({ workspaceName: "Rocket Team" })).warning,
    ).toBeUndefined();

    const unchecked = harness();
    expect(
      (await unchecked.controller.start({ workspaceName: "Rocket Team" })).warning,
    ).toBeUndefined();
  });

  it("asks about the port it actually bound, and about this run", async () => {
    const asked: { port: number; instanceId?: string }[] = [];
    const h = harness({
      verifyLoopback: async (port, instanceId) => {
        asked.push({ port, instanceId });
        return true;
      },
    });
    h.beforeBind = (port) => {
      if (port === 8543) throw inUse();
    };

    await h.controller.start({ workspaceName: "Rocket Team" });

    // After a fallback the moved-port warning already says everything, so
    // loopback is not asked about a port nobody was told to use.
    expect(asked).toEqual([]);
  });

  it("keeps saying where the workspace moved to after the settings do save", async () => {
    const h = harness();
    h.beforeBind = (port) => {
      if (port === 8543) throw inUse();
      h.saveFails = true;
    };

    const status = await h.controller.start({ workspaceName: "Rocket Team" });
    // Two independent things are wrong, and neither replaces the other.
    expect(status.warning).toMatch(/8543 was already in use/);
    expect(status.warning).toMatch(/could not be saved/);

    // Saving succeeding says nothing about which port this run is listening
    // on, so it must not take that notice away.
    h.saveFails = false;
    const again = await h.controller.start({ workspaceName: "Rocket Team" });
    expect(again.warning).toMatch(/8543 was already in use/);
    expect(again.warning).not.toMatch(/could not be saved/);

    // Stopping ends the run the notice was about.
    await h.controller.stop();
    expect(h.controller.status().warning).toBeUndefined();
  });

  it("does not start a second server beside the one running", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).resolves.toMatchObject({
      running: true,
      port: 8543,
    });
    await expect(
      h.controller.start({ workspaceName: "Rocket Team", port: 0 }),
    ).resolves.toMatchObject({ port: 8543 });
    await expect(h.controller.start({ workspaceName: "Night Shift" })).rejects.toThrow(
      /Another workspace is already running/,
    );
    await expect(h.controller.start({ workspaceName: "Rocket Team", port: 9000 })).rejects.toThrow(
      /another port/,
    );
    expect(h.starts).toHaveLength(1);
  });

  it("takes start and stop requests one at a time, in the order they were made", async () => {
    const h = harness();
    const bind = deferred();
    h.beforeBind = () => bind.promise;
    const first = h.controller.start({ workspaceName: "Rocket Team" });
    const second = h.controller.start({ workspaceName: "Rocket Team" });
    const stopped = h.controller.stop();
    await vi.waitFor(() =>
      expect(h.controller.status()).toMatchObject({
        running: false,
        phase: "starting",
        workspaceName: "Rocket Team",
      }),
    );
    bind.resolve();
    await first;
    await second;
    await stopped;
    expect(h.starts).toHaveLength(1);
    expect(h.servers[0]!.stop).toHaveBeenCalledOnce();
    expect(h.controller.status()).toEqual({ running: false, phase: "stopped" });
  });

  it("keeps the server, and says so, when stopping it fails", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    h.servers[0]!.stop.mockRejectedValueOnce(new Error("drain failed"));
    await expect(h.controller.stop()).rejects.toThrow("drain failed");
    expect(h.controller.status()).toMatchObject({
      running: true,
      phase: "running",
      warning: expect.stringMatching(/could not finish stopping/),
    });
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow(
      /Finish stopping/,
    );

    await h.controller.stop();
    expect(h.controller.status()).toEqual({ running: false, phase: "stopped" });
    await h.controller.start({ workspaceName: "Rocket Team" });
    expect(h.starts).toHaveLength(2);
  });

  it("goes on hosting when telling the windows about a change throws", async () => {
    const h = harness();
    h.notifyFails = true;
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).resolves.toMatchObject({
      running: true,
    });
    await h.controller.stop();
    expect(h.servers[0]!.stop).toHaveBeenCalledOnce();
    expect(h.controller.status()).toEqual({ running: false, phase: "stopped" });
  });

  describe("opening the hosted workspace to all", () => {
    it("secures registration before opening, publishes the address, and closes cleanly", async () => {
      const h = harness({ publicAccess: true });
      await h.controller.start({ workspaceName: "Rocket Team" });

      const opened = await h.controller.openToAll({});
      expect(h.events.slice(0, 2)).toEqual(["policy:true", "tunnel:open"]);
      expect(h.tunnelStarts).toHaveLength(1);
      expect(h.publicUrls).toEqual(["https://rocket-team.trycloudflare.com"]);
      expect(h.proxyTrust).toEqual([true]);
      expect(h.iceServers.at(-1)).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
      expect(opened).toMatchObject({
        running: true,
        inviteOnly: true,
        openToAll: {
          phase: "open",
          url: "https://rocket-team.trycloudflare.com",
        },
      });

      // A repeated request changes the joining rule without launching a
      // second connector.
      await h.controller.openToAll({ inviteOnly: false });
      expect(h.tunnelStarts).toHaveLength(1);
      expect(h.controller.status().inviteOnly).toBe(false);

      const closed = await h.controller.endOpenToAll();
      expect(h.tunnels[0]!.close).toHaveBeenCalledOnce();
      expect(h.publicUrls.at(-1)).toBeNull();
      expect(h.proxyTrust).toEqual([true, false]);
      expect(h.iceServers.at(-1)).toEqual([]);
      expect(closed.openToAll).toBeUndefined();
      expect(closed.inviteOnly).toBe(false);
    });

    it("restores the previous joining rule when Cloudflare cannot open", async () => {
      const h = harness({ publicAccess: true });
      h.beforeTunnel = () => {
        throw new Error("Cloudflare is offline");
      };
      await h.controller.start({ workspaceName: "Rocket Team" });

      await expect(h.controller.openToAll({ inviteOnly: true })).rejects.toThrow(
        "Cloudflare is offline",
      );
      expect(h.policyCalls).toEqual([true, false]);
      expect(h.controller.status()).toMatchObject({
        running: true,
        inviteOnly: false,
        openToAllError: "Cloudflare is offline",
      });
    });

    it("waits for the owner account before exposing an ownerless workspace", async () => {
      const h = harness({ publicAccess: true });
      h.accountCount = 0;
      await h.controller.start({ workspaceName: "Rocket Team" });

      await expect(h.controller.openToAll({ inviteOnly: true })).rejects.toThrow(
        /Create your own account/,
      );
      expect(h.policyCalls).toEqual([]);
      expect(h.tunnelStarts).toEqual([]);
    });

    it("cancels an open queued before stop instead of creating a late public link", async () => {
      const h = harness({ publicAccess: true });
      const bound = deferred();
      h.beforeBind = () => bound.promise;
      const starting = h.controller.start({ workspaceName: "Rocket Team" });
      const opening = h.controller.openToAll({ inviteOnly: true });
      const openingResult = expect(opening).rejects.toThrow("cancelled");
      const stopping = h.controller.stop();

      bound.resolve();
      await starting;
      await openingResult;
      await stopping;
      expect(h.tunnelStarts).toEqual([]);
      expect(h.controller.status()).toEqual({
        running: false,
        phase: "stopped",
        tunnelAvailable: true,
      });
    });

    it("cancels every queued open when the app quits", async () => {
      const h = harness({ publicAccess: true });
      const bound = deferred();
      h.beforeBind = () => bound.promise;
      const starting = h.controller.start({ workspaceName: "Rocket Team" });
      const firstOpen = expect(h.controller.openToAll({ inviteOnly: true })).rejects.toThrow(
        "cancelled",
      );
      const secondOpen = expect(h.controller.openToAll({ inviteOnly: false })).rejects.toThrow(
        "cancelled",
      );
      const quitting = h.controller.shutdown();

      bound.resolve();
      await starting;
      await firstOpen;
      await secondOpen;
      await quitting;
      expect(h.tunnelStarts).toEqual([]);
      expect(h.controller.status()).toEqual({
        running: false,
        phase: "stopped",
        tunnelAvailable: true,
      });
    });

    it("aborts an active opening and restores the policy when the public link is closed", async () => {
      const h = harness({ publicAccess: true });
      h.beforeTunnel = (_port, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      await h.controller.start({ workspaceName: "Rocket Team" });
      const opening = h.controller.openToAll({ inviteOnly: true });
      const openingResult = expect(opening).rejects.toThrow("aborted");
      await vi.waitFor(() => expect(h.tunnelStarts).toHaveLength(1));

      const closing = h.controller.endOpenToAll();
      await openingResult;
      await closing;
      expect(h.policyCalls).toEqual([true, false]);
      expect(h.controller.status()).not.toHaveProperty("openToAll");
    });

    it("calls off an opening in progress when the app quits", async () => {
      const h = harness({ publicAccess: true });
      h.beforeTunnel = (_port, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      await h.controller.start({ workspaceName: "Rocket Team" });
      const opening = expect(h.controller.openToAll({ inviteOnly: true })).rejects.toThrow(
        "aborted",
      );
      await vi.waitFor(() => expect(h.tunnelStarts).toHaveLength(1));

      // Quitting does not wait out a tunnel Cloudflare may take a minute over.
      await h.controller.shutdown();
      await opening;
      expect(h.policyCalls).toEqual([true, false]);
      expect(h.servers[0]!.stop).toHaveBeenCalledOnce();
      expect(h.controller.status()).toEqual({
        running: false,
        phase: "stopped",
        tunnelAvailable: true,
      });
    });

    it("removes a dropped public address and reports why it ended", async () => {
      const h = harness({ publicAccess: true });
      await h.controller.start({ workspaceName: "Rocket Team" });
      await h.controller.openToAll({ inviteOnly: true });

      h.tunnels[0]!.drop("edge connection lost");
      expect(h.publicUrls.at(-1)).toBeNull();
      expect(h.proxyTrust).toEqual([true, false]);
      expect(h.iceServers.at(-1)).toEqual([]);
      expect(h.controller.status()).toMatchObject({
        openToAllError: expect.stringMatching(/edge connection lost/),
      });
      expect(h.controller.status().openToAll).toBeUndefined();
    });

    it("does not re-expose a server after stopping it has failed", async () => {
      const h = harness({ publicAccess: true });
      await h.controller.start({ workspaceName: "Rocket Team" });
      h.servers[0]!.stop.mockRejectedValueOnce(new Error("drain failed"));
      await expect(h.controller.stop()).rejects.toThrow("drain failed");

      await expect(h.controller.openToAll({ inviteOnly: true })).rejects.toThrow(/Finish stopping/);
      await expect(h.controller.setInviteOnly(true)).rejects.toThrow(/Finish stopping/);
      expect(h.tunnelStarts).toEqual([]);
    });

    it("keeps a public link visible when its process cannot be confirmed closed", async () => {
      const h = harness({ publicAccess: true });
      await h.controller.start({ workspaceName: "Rocket Team" });
      await h.controller.openToAll({ inviteOnly: true });
      h.tunnels[0]!.close.mockRejectedValueOnce(new Error("process still running"));

      await expect(h.controller.endOpenToAll()).rejects.toThrow("process still running");
      expect(h.controller.status()).toMatchObject({
        openToAll: { phase: "open" },
        openToAllError: expect.stringMatching(/could not finish closing/),
      });

      await expect(h.controller.endOpenToAll()).resolves.not.toHaveProperty("openToAll");
    });

    it("closes the public link before the workspace it points at stops", async () => {
      const h = harness({ publicAccess: true });
      await h.controller.start({ workspaceName: "Rocket Team" });
      await h.controller.openToAll({ inviteOnly: true });

      await h.controller.stop();
      expect(h.tunnels[0]!.close).toHaveBeenCalledOnce();
      expect(h.publicUrls).toEqual(["https://rocket-team.trycloudflare.com", null]);
      // A link outliving its workspace would only show Cloudflare's error page.
      expect(h.tunnels[0]!.close.mock.invocationCallOrder[0]!).toBeLessThan(
        h.servers[0]!.stop.mock.invocationCallOrder[0]!,
      );
      expect(h.controller.status()).toEqual({
        running: false,
        phase: "stopped",
        tunnelAvailable: true,
      });
    });

    it("ends the public link when the app quits", async () => {
      const h = harness({ publicAccess: true });
      await h.controller.start({ workspaceName: "Rocket Team" });
      await h.controller.openToAll({ inviteOnly: true });

      await h.controller.shutdown();
      expect(h.tunnels[0]!.close).toHaveBeenCalledOnce();
      expect(h.publicUrls.at(-1)).toBeNull();
      expect(h.servers[0]!.stop).toHaveBeenCalledOnce();
    });

    it("keeps the workspace up when its public link will not close on the way to stopping", async () => {
      const h = harness({ publicAccess: true });
      await h.controller.start({ workspaceName: "Rocket Team" });
      await h.controller.openToAll({ inviteOnly: true });
      h.tunnels[0]!.close.mockRejectedValueOnce(new Error("process still running"));

      await expect(h.controller.stop()).rejects.toThrow("process still running");
      expect(h.servers[0]!.stop).not.toHaveBeenCalled();
      expect(h.controller.status()).toMatchObject({
        running: true,
        phase: "running",
        openToAll: { phase: "open", url: "https://rocket-team.trycloudflare.com" },
        warning: expect.stringMatching(/could not finish closing/),
      });

      // Asked again, both the link and the workspace come down.
      await h.controller.stop();
      expect(h.tunnels[0]!.close).toHaveBeenCalledTimes(2);
      expect(h.servers[0]!.stop).toHaveBeenCalledOnce();
      expect(h.controller.status()).toMatchObject({ running: false, phase: "stopped" });
    });
  });

  describe("when the app quits", () => {
    it("finishes a start it already accepted, stops it, and accepts no more", async () => {
      const h = harness();
      const bind = deferred();
      h.beforeBind = () => bind.promise;
      const starting = h.controller.start({ workspaceName: "Rocket Team" });
      const quitting = h.controller.shutdown();
      expect(h.controller.shutdown()).toBe(quitting);
      await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow(
        /quitting/,
      );

      bind.resolve();
      await expect(starting).resolves.toMatchObject({ running: true });
      await quitting;
      expect(h.servers).toHaveLength(1);
      expect(h.servers[0]!.stop).toHaveBeenCalledOnce();
      expect(h.controller.status()).toEqual({ running: false, phase: "stopped" });
      await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow(
        /quitting/,
      );
    });

    it("can be called off when stopping fails, leaving the same server to try again with", async () => {
      const h = harness();
      await h.controller.start({ workspaceName: "Rocket Team" });
      h.servers[0]!.stop.mockRejectedValueOnce(new Error("drain failed"));
      await expect(h.controller.shutdown()).rejects.toThrow("drain failed");
      expect(h.controller.status()).toMatchObject({ running: true, port: 8543 });
      // No longer quitting: a start is refused for the failed stop, not for quitting.
      await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow(
        /Finish stopping/,
      );

      await h.controller.shutdown();
      expect(h.servers).toHaveLength(1);
      expect(h.servers[0]!.stop).toHaveBeenCalledTimes(2);
      expect(h.controller.status()).toEqual({ running: false, phase: "stopped" });
    });
  });
});

describe("the list of workspaces hosted on this computer", () => {
  it("adopts the folders earlier versions made, and resumes the one they hosted last", async () => {
    const root = profile();
    const hosted = join(root, "hosted");
    workspaceDb(join(hosted, "rocket-team"), "01ROCKET", "Rocket Team");
    workspaceDb(join(hosted, "workspace"), "01NIHON", "日本");
    mkdirSync(join(hosted, "empty"));
    const settings = new Map<string, unknown>([
      ["lastHosted", { workspaceName: "Rocket Team", port: 9001 }],
    ]);
    const h = harness({ root, settings });

    expect(await h.controller.lastHosted()).toEqual({
      folder: "rocket-team",
      workspaceName: "Rocket Team",
      port: 9001,
    });
    const { workspaces } = await h.controller.list();
    expect(workspaces.map((w) => [w.folder, w.name, w.port])).toEqual([
      ["rocket-team", "Rocket Team", 9001],
      ["workspace", "日本", 8543],
    ]);
    expect(registryOf(h).map((entry) => entry.id)).toEqual(["01ROCKET", "01NIHON"]);

    // The resume offer opens the same data, on the port it had.
    await h.controller.start({ folder: "rocket-team" });
    expect(h.starts).toEqual([{ port: 9001, dataDir: join(hosted, "rocket-team") }]);
    // An earlier version would find this one from its name, so it is told.
    expect(h.saved).toEqual([{ workspaceName: "Rocket Team", port: 9001 }]);
    await h.controller.stop();

    // A second launch finds its entries and adopts nothing more.
    const again = harness({ root, settings });
    const before = structuredClone(settings.get("hostedWorkspaces"));
    await again.controller.list();
    expect(settings.get("hostedWorkspaces")).toEqual(before);
  });

  it("names a folder it cannot read without listing it", async () => {
    const root = profile();
    mkdirSync(join(root, "hosted", "broken"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "hosted", "broken", "workspace.db"), "not a database");
    const h = harness({ root });
    expect(await h.controller.list()).toEqual({ workspaces: [], unreadable: ["broken"] });
  });

  it("will not start a folder that now holds a different workspace", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    const [entry] = registryOf(h);
    // Swapped by hand for another workspace's folder.
    h.databases.set(join(h.dataRoot, entry!.folder), { id: "someone-else", name: "Other" });
    await expect(h.controller.start({ folder: entry!.folder })).rejects.toThrow(
      /holds a different workspace/,
    );
    expect(h.starts).toHaveLength(1);
  });

  it("lists a workspace whose folder is gone, and never recreates it empty", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    const [entry] = registryOf(h);
    rmSync(join(h.dataRoot, entry!.folder), { recursive: true });
    expect((await h.controller.list()).workspaces).toEqual([
      expect.objectContaining({ folder: entry!.folder, missing: true, running: false }),
    ]);
    await expect(h.controller.start({ folder: entry!.folder })).rejects.toThrow(/missing/);
    expect(existsSync(join(h.dataRoot, entry!.folder))).toBe(false);
  });

  it("creates nothing it could not list, so every workspace can be found again", async () => {
    const h = harness();
    h.saveFails = true;
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow(
      /could not add the workspace/,
    );
    expect(h.starts).toEqual([]);
    expect(readdirSync(h.dataRoot)).toEqual([]);
  });

  it("does not take a settings file it cannot read for an empty list", async () => {
    const h = harness();
    h.readFails = true;
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow(
      /could not read its list/,
    );
    await expect(h.controller.list()).rejects.toThrow();
    expect(await h.controller.lastHosted()).toBeNull();
    expect(h.starts).toEqual([]);

    // Read again once it can be, rather than remembered as empty.
    h.readFails = false;
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).resolves.toMatchObject({
      running: true,
    });
  });

  it("drops entries that are malformed, repeated, or point outside the hosted folder", () => {
    const entry = {
      id: "a",
      folder: "rocket-team",
      name: "Rocket Team",
      port: 8543,
      lastHostedAt: 1,
    };
    expect(
      parseRegistry({
        version: 1,
        workspaces: [
          entry,
          { ...entry, id: "b" },
          { ...entry, folder: "copy" },
          { ...entry, id: "c", folder: "../outside" },
          { ...entry, id: "d", folder: "a\b" },
          { ...entry, id: "e", folder: "UPPER" },
          { ...entry, id: "f", folder: "ok", port: 70000 },
          { ...entry, id: null, folder: "adopted" },
        ],
      }),
    ).toEqual([entry, { ...entry, id: null, folder: "adopted" }]);
    expect(parseRegistry({ version: 2, workspaces: [entry] })).toEqual([]);
    expect(parseRegistry(null)).toEqual([]);
  });
});

describe("backing up a hosted workspace", () => {
  it("copies it into a new folder where it was asked, and remembers when", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    const [entry] = registryOf(h);
    const destination = profile();
    const made = await h.controller.backup({ folder: entry!.folder, destination });
    expect(h.backups).toEqual([
      {
        dataDir: join(h.dataRoot, entry!.folder),
        out: expect.stringMatching(/rocket-team-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/),
      },
    ]);
    expect(made.path).toBe(h.backups[0]!.out);
    expect(made.path.startsWith(destination)).toBe(true);
    // Running or not; and the date shown for it survives a restart.
    expect(h.controller.status().running).toBe(true);
    expect(registryOf(h)[0]!.lastBackupAt).toBe(made.at);
    expect((await h.controller.list()).workspaces[0]!.lastBackupAt).toBe(made.at);
  });

  it("copies nothing when the disk has no room for it", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    const [entry] = registryOf(h);
    h.free = 1024;
    await expect(
      h.controller.backup({ folder: entry!.folder, destination: profile() }),
    ).rejects.toThrow(/not enough free space.*needs about 16 MB, and 1 MB is free/);
    expect(h.backups).toEqual([]);
    expect(registryOf(h)[0]!.lastBackupAt).toBeUndefined();
  });

  it("refuses a workspace it does not list, or a folder it cannot name", async () => {
    const h = harness();
    await expect(h.controller.backup({ folder: "nope", destination: profile() })).rejects.toThrow(
      /not in the list/,
    );
    for (const bad of [undefined, { folder: "x" }, { folder: "x", destination: "relative/dir" }]) {
      await expect(h.controller.backup(bad)).rejects.toThrow(/Choose a workspace/);
    }
    expect(h.backups).toEqual([]);
  });
});

describe("remembering the last hosted workspace", () => {
  it("reads back what a start saved", () => {
    expect(parseLastHosted({ workspaceName: "Rocket Team", port: 8543 })).toEqual({
      workspaceName: "Rocket Team",
      port: 8543,
    });
  });

  it("refuses anything malformed rather than hosting under it", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "Rocket Team",
      [],
      {},
      { workspaceName: "", port: 8543 },
      { workspaceName: "   ", port: 8543 },
      { workspaceName: "x".repeat(81), port: 8543 },
      { workspaceName: "Rocket Team" },
      { workspaceName: "Rocket Team", port: -1 },
      { workspaceName: "Rocket Team", port: 70000 },
      { workspaceName: "Rocket Team", port: 85.5 },
      { workspaceName: "Rocket Team", port: "8543" },
      { workspaceName: 42, port: 8543 },
    ]) {
      expect(parseLastHosted(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("trims the name it kept", () => {
    expect(parseLastHosted({ workspaceName: "  Rocket Team  ", port: 0 })).toEqual({
      workspaceName: "Rocket Team",
      port: 0,
    });
  });
});

describe("a stable public address configured for this computer", () => {
  const configured = "https://chat.example.org";

  it("says where to repoint the carrier when the usual port was taken", async () => {
    const h = harness({
      publicAccess: true,
      publicAddress: () => ({ url: configured, setting: configured }),
    });
    h.beforeBind = (port) => {
      if (port === 8543) throw inUse();
    };

    const status = await h.controller.start({ workspaceName: "Rocket Team" });

    // The carrier keeps forwarding to 8543 whatever happens here, so the
    // address would reach the program that took it. Opening to all would
    // refuse, but only after the fact and without naming the cause.
    expect(status.port).toBe(50123);
    expect(status.warning).toContain(configured);
    expect(status.warning).toContain("http://127.0.0.1:50123");
    expect(status.warning).toMatch(/8543/);
  });

  it("shows the configured address and opens it for the running workspace", async () => {
    const h = harness({
      publicAccess: true,
      publicAddress: () => ({ url: configured, setting: configured }),
    });
    await h.controller.start({ workspaceName: "Rocket Team" });
    expect(h.controller.status()).toMatchObject({ publicAddress: configured });

    await h.controller.openToAll({ inviteOnly: true });
    // The connector is told which run to confirm, so the saved address cannot
    // publish a link to a workspace other than this one.
    expect(h.tunnelStarts.at(-1)).toMatchObject({ port: 8543, instanceId: "workspace-run-1" });
    // A carrier Gatherline does not own is not trusted to sanitize Cloudflare's
    // client-address header before forwarding it from loopback.
    expect(h.proxyTrust).toEqual([]);

    await h.controller.setInviteOnly(false);
    h.tunnels[0]!.drop("external route stopped answering");
    expect(h.controller.status()).toMatchObject({
      inviteOnly: true,
      openToAllError: expect.stringMatching(/same address/),
    });
    expect(h.controller.status().openToAllError).not.toMatch(/new link/);
  });

  it("trusts the loopback visitor header for a Cloudflare connector it owns", async () => {
    const h = harness({
      publicAccess: true,
      publicAddress: () => ({ url: configured, managed: true }),
    });
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.openToAll({ inviteOnly: true });
    expect(h.proxyTrust).toEqual([true]);
  });

  it("secures registration when it stops publishing an externally carried address", async () => {
    const h = harness({
      publicAccess: true,
      publicAddress: () => ({ url: configured, setting: configured }),
    });
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.openToAll({ inviteOnly: false });
    expect(h.controller.status().inviteOnly).toBe(false);

    await h.controller.endOpenToAll();
    expect(h.controller.status().inviteOnly).toBe(true);
    expect(h.publicUrls.at(-1)).toBeNull();
  });

  it("keeps registration secured when an external address fails verification", async () => {
    const h = harness({
      publicAccess: true,
      publicAddress: () => ({ url: configured, setting: configured }),
    });
    h.beforeTunnel = () => {
      throw new Error("address did not reach this workspace");
    };
    await h.controller.start({ workspaceName: "Rocket Team" });

    await expect(h.controller.openToAll({ inviteOnly: false })).rejects.toThrow(/did not reach/);
    expect(h.controller.status().inviteOnly).toBe(true);
  });

  it("secures and saves a replacement address, clearing the previous carrier's error", async () => {
    const h = harness({ publicAccess: true });
    h.beforeTunnel = () => {
      throw new Error("old carrier failed");
    };
    await h.controller.start({ workspaceName: "Rocket Team" });
    await expect(h.controller.openToAll({ inviteOnly: false })).rejects.toThrow(/old carrier/);
    expect(h.controller.status().openToAllError).toMatch(/old carrier/);

    await h.controller.setPublicAddress(configured);
    expect(h.savedPublicAddresses).toEqual([configured]);
    expect(h.controller.status().inviteOnly).toBe(true);
    expect(h.controller.status().openToAllError).toBeUndefined();
  });

  it("keeps registration secured if saving a replacement address fails", async () => {
    const h = harness({
      publicAccess: true,
      savePublicAddress: () => {
        throw new Error("settings unavailable");
      },
    });
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.setInviteOnly(false);

    await expect(h.controller.setPublicAddress(configured)).rejects.toThrow(/settings unavailable/);
    expect(h.controller.status().inviteOnly).toBe(true);
    expect(h.savedPublicAddresses).toEqual([]);
  });

  it("refuses to open a link, and changes nothing, while its configuration is unusable", async () => {
    const error = "Set both GATHERLINE_TUNNEL_URL and GATHERLINE_TUNNEL_TOKEN_FILE.";
    const h = harness({ publicAccess: true, publicAddress: () => ({ error }) });
    await h.controller.start({ workspaceName: "Rocket Team" });
    expect(h.controller.status()).toMatchObject({ publicAddressError: error });
    expect(h.controller.status()).not.toHaveProperty("publicAddress");

    await expect(h.controller.openToAll({ inviteOnly: true })).rejects.toThrow(/Set both/);
    expect(h.tunnelStarts).toEqual([]);
    expect(h.policyCalls).toEqual([]);
    expect(h.publicUrls).toEqual([]);
  });

  it("leaves a temporary address alone when nothing is configured", async () => {
    const h = harness({ publicAccess: true, publicAddress: () => ({}) });
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.openToAll({ inviteOnly: true });
    expect(h.controller.status()).not.toHaveProperty("publicAddress");
    expect(h.controller.status()).not.toHaveProperty("publicAddressError");
    expect(h.publicUrls.at(-1)).toBe("https://rocket-team.trycloudflare.com");
  });
});
