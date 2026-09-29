import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createHostingController,
  parseLastHosted,
  type HostingSnapshot,
} from "../src/main/hosting.js";
import {
  parseAutoBackup,
  parseRegistry,
  readWorkspace,
  writeWorkspaceName,
  type HostedWorkspace,
} from "../src/main/registry.js";
import type { Tunnel } from "../src/main/tunnel.js";
import {
  backupWorkspace,
  createWorkspaceServer,
  inventoryBackup,
  restoreWorkspace,
  verifyBackup,
} from "@slackoss/server";

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

/** What the harness's stand-in backups write as their manifest, so its check can pass them. */
const FAKE_MANIFEST = '{"fake":true}';

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
    /** Keys that cannot be read, as a damaged settings file would leave one. */
    unreadableKeys: new Set<string>(),
    /** Each name a running server was given. */
    renamedRunning: [] as string[],
    /** How many times a running server announced itself again. */
    reannounced: 0,
    /** Who is connected to the running server, and whoever listens for changes. */
    connected: 0,
    connectionListeners: new Set<() => void>(),
    /** Each name written into a stopped workspace's database; set `writeFails` to refuse. */
    written: [] as { dataDir: string; name: string }[],
    writeFails: false,
    /** Each folder shown in the file manager, and what the system answers. */
    opened: [] as string[],
    openAnswer: "",
    clock: 1000,
    /** Each backup the server was asked for, and the free space the disk reports. */
    backups: [] as { dataDir: string; out: string }[],
    /**
     * Whether a backup leaves a folder shaped like the server's, holding the
     * workspace's ID, as the real one always does.
     */
    writeBackups: true,
    /** Whether backups are the real server's, of a real workspace, checked as the app checks them. */
    realBackups: false,
    /** A workspace ID the stand-in backup writes instead, as if the folder were swapped mid-copy. */
    swapDuringBackup: null as string | null,
    /** While set, the stand-in backup waits for it, holding its turn. */
    backupGate: null as Promise<void> | null,
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
    writeWorkspaceName: (dataDir, name) => {
      if (h.writeFails)
        throw new Error(`database is locked: ${join(dataDir, "workspace.db")} (C:\\Users\\sam)`);
      h.written.push({ dataDir, name });
      const fake = h.databases.get(dataDir);
      if (fake) fake.name = name;
      else writeWorkspaceName(dataDir, name);
    },
    openFolder: async (path) => {
      h.opened.push(path);
      return h.openAnswer;
    },
    backupWorkspace: async (request) => {
      h.backups.push(request);
      if (h.backupGate) await h.backupGate;
      if (h.realBackups) return backupWorkspace(request);
      if (h.writeBackups) {
        const inside = h.databases.get(request.dataDir);
        workspaceDb(
          request.out,
          h.swapDuringBackup ?? inside?.id ?? null,
          inside?.name ?? "Unnamed",
        );
        writeFileSync(join(request.out, "manifest.json"), FAKE_MANIFEST);
      }
      return { files: [] };
    },
    freeBytes: async () => h.free,
    // The fake backups above pass as the server's own would; everything else
    // meets the real check.
    verifyBackup: async (dir) =>
      existsSync(join(dir, "manifest.json")) &&
      readFileSync(join(dir, "manifest.json"), "utf8") === FAKE_MANIFEST
        ? { workspaceName: "Fake", database: { bytes: 0 }, files: [] }
        : verifyBackup(dir),
    restoreWorkspace,
    inventoryBackup: async (dir) => inventoryBackup(dir),
    settings: {
      get: async (key, { strict, distinguishMissing } = {}) => {
        if (h.readFails && strict) throw new Error("Could not read settings.");
        if (h.unreadableKeys.has(key)) {
          if (strict) throw new Error("Could not read settings.");
          return null;
        }
        return h.settings.has(key) ? h.settings.get(key) : distinguishMissing ? undefined : null;
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
        setWorkspaceName: (name: string) => {
          h.renamedRunning.push(name);
          db.name = name;
        },
        reannounce: () => {
          h.reannounced++;
        },
        connectedPeople: () => h.connected,
        onConnectedChange: (listener: () => void) => {
          h.connectionListeners.add(listener);
          return () => void h.connectionListeners.delete(listener);
        },
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
      portChosen: false,
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
      connected: 0,
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
    ).rejects.toThrow(
      "Port 9000 is already in use on this computer. Choose another, or leave the port empty to use one that is free.",
    );
    expect(chosen.starts.map((s) => s.port)).toEqual([9000]);
    expect(chosen.controller.status()).toEqual({ running: false, phase: "stopped" });
  });

  it("keeps a port chosen at creation when it is busy on reopening, and does not start", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team", port: 9100 });
    await h.controller.stop();
    const folder = registryOf(h)[0]!.folder;
    h.beforeBind = (port) => {
      if (port === 9100) throw inUse();
    };
    h.starts.length = 0;
    await expect(h.controller.start({ folder })).rejects.toThrow(
      "Port 9100, chosen for Rocket Team, is already in use on this computer, so it did not start.",
    );
    expect(h.starts.map((s) => s.port)).toEqual([9100]);
    expect(registryOf(h)[0]).toMatchObject({ port: 9100, portChosen: true });
    expect(made.port).toBe(9100);
  });

  it("keeps a port chosen through Change port when starting with the app", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    const folder = registryOf(h)[0]!.folder;
    await h.controller.setPort({ folder, port: 9100 });
    await h.controller.setStartOnLaunch(folder);
    h.beforeBind = (port) => {
      if (port === 9100) throw inUse();
    };
    h.starts.length = 0;
    expect(await h.controller.startForLaunch()).toBeNull();
    expect(h.starts.map((s) => s.port)).toEqual([9100]);
    expect(h.controller.status().launchError).toMatch(/Port 9100, chosen for Rocket Team/);
    expect(registryOf(h)[0]).toMatchObject({ port: 9100, portChosen: true });
  });

  it("still moves a workspace whose port was never chosen", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    const folder = registryOf(h)[0]!.folder;
    expect(registryOf(h)[0]!.portChosen).toBe(false);
    h.beforeBind = (port) => {
      if (port === 8543) throw inUse();
    };
    h.starts.length = 0;
    const status = await h.controller.start({ folder });
    expect(h.starts.map((s) => s.port)).toEqual([8543, 0]);
    expect(status.port).toBe(50123);
  });

  it("treats an older entry's unusual port as chosen", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team", port: 9100 });
    await h.controller.stop();
    // As saved before chosen ports were recorded.
    const saved = h.settings.get("hostedWorkspaces") as { workspaces: Record<string, unknown>[] };
    for (const entry of saved.workspaces) delete entry.portChosen;
    const folder = registryOf(h)[0]!.folder;
    h.beforeBind = (port) => {
      if (port === 9100) throw inUse();
    };
    const later = harness({ root: join(h.dataRoot, ".."), settings: h.settings });
    for (const [path, found] of h.databases) later.databases.set(path, found);
    later.beforeBind = h.beforeBind;
    await expect(later.controller.start({ folder })).rejects.toThrow(/Port 9100, chosen for/);
  });

  it("reports a failed start once, and leaves nothing claiming to be hosted", async () => {
    const h = harness();
    h.beforeBind = () => {
      throw Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    };
    // Described by its code: a system error's own message names paths.
    await expect(h.controller.start({ workspaceName: "Rocket Team" })).rejects.toThrow(
      "The workspace could not start (EACCES). Check that its data folder is writable and its port is free, then try again.",
    );
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

  it("removes a workspace whose folder is gone, and keeps one still on this computer", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    await h.controller.start({ workspaceName: "Night Shift" });
    await h.controller.stop();
    const [kept, gone] = registryOf(h);
    await expect(h.controller.forget(kept!.folder)).rejects.toThrow(/still on this computer/);
    rmSync(join(h.dataRoot, gone!.folder), { recursive: true });
    await h.controller.forget(gone!.folder);
    expect(registryOf(h).map((entry) => entry.name)).toEqual(["Rocket Team"]);
    // Nothing to do for one already gone from the list.
    await expect(h.controller.forget(gone!.folder)).resolves.toBeUndefined();
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
    expect(() => parseRegistry({ version: 2, workspaces: [entry] })).toThrow(
      /newer version of Gatherline/,
    );
    expect(() => parseRegistry(null)).toThrow(/invalid/);
    expect(() => parseRegistry({ version: 1, workspaces: "not a list" })).toThrow(/invalid/);
    expect(parseRegistry(undefined)).toEqual([]);
  });

  it("leaves an unsupported registry and auto-start choice intact on a downgrade", async () => {
    const h = harness();
    workspaceDb(join(h.dataRoot, "old-team"), "ws-old", "Old Team");
    const newer = {
      version: 2,
      workspaces: [
        { id: "ws-old", folder: "old-team", name: "Old Team", port: 8543, lastHostedAt: 1 },
      ],
    };
    h.settings.set("hostedWorkspaces", newer);
    h.settings.set("startOnLaunch", "old-team");
    const before = structuredClone([...h.settings]);

    await expect(h.controller.list()).rejects.toThrow(/newer version of Gatherline/);
    await expect(h.controller.start({ workspaceName: "New Team" })).rejects.toThrow(
      /newer version of Gatherline/,
    );
    await expect(h.controller.rename({ folder: "old-team", name: "Renamed" })).rejects.toThrow(
      /newer version of Gatherline/,
    );
    await expect(h.controller.restore({ backupDir: profile() })).rejects.toThrow(
      /newer version of Gatherline/,
    );
    await expect(h.controller.startForLaunch()).resolves.toBeNull();
    expect(h.controller.status().launchError).toMatch(/newer version of Gatherline/);
    expect([...h.settings]).toEqual(before);
    expect(h.starts).toEqual([]);
    expect(readdirSync(h.dataRoot)).toEqual(["old-team"]);
  });

  it("does not adopt folders over a present but malformed registry", async () => {
    const h = harness();
    workspaceDb(join(h.dataRoot, "old-team"), "ws-old", "Old Team");
    h.settings.set("hostedWorkspaces", null);
    h.settings.set("lastHosted", { workspaceName: "Old Team", port: 9210 });
    const before = structuredClone([...h.settings]);

    await expect(h.controller.list()).rejects.toThrow(
      /hosted workspace list in settings is invalid/,
    );
    await expect(h.controller.start({ workspaceName: "New Team" })).rejects.toThrow(/invalid/);
    expect([...h.settings]).toEqual(before);
    expect(h.starts).toEqual([]);
    expect(readdirSync(h.dataRoot)).toEqual(["old-team"]);
  });

  it("still adopts legacy folders when the registry key is absent", async () => {
    const h = harness();
    workspaceDb(join(h.dataRoot, "old-team"), "ws-old", "Old Team");
    h.settings.set("lastHosted", { workspaceName: "Old Team", port: 9210 });

    expect((await h.controller.list()).workspaces).toEqual([
      expect.objectContaining({ folder: "old-team", name: "Old Team", port: 9210 }),
    ]);
    expect(h.settings.get("hostedWorkspaces")).toEqual({
      version: 1,
      workspaces: [expect.objectContaining({ id: "ws-old", folder: "old-team" })],
    });
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

describe("renaming a hosted workspace", () => {
  it("renames a running workspace through its server, and its folder stays where it is", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    const [entry] = registryOf(h);
    const renamed = await h.controller.rename({ folder: entry!.folder, name: "  Blue Team " });
    expect(renamed).toEqual({ folder: entry!.folder, name: "Blue Team" });
    // The server was told, so everyone connected hears it; nothing restarted.
    expect(h.renamedRunning).toEqual(["Blue Team"]);
    expect(h.written).toEqual([]);
    expect(h.starts).toHaveLength(1);
    expect(h.controller.status()).toMatchObject({ running: true, workspaceName: "Blue Team" });
    expect(h.changes.at(-1)).toMatchObject({ workspaceName: "Blue Team" });
    expect(registryOf(h)).toEqual([{ ...entry, name: "Blue Team" }]);
    expect(readdirSync(h.dataRoot)).toEqual([entry!.folder]);
  });

  it("renames a stopped workspace in its database without starting it, and never hands a start the name", async () => {
    const root = profile();
    const hosted = join(root, "hosted");
    workspaceDb(join(hosted, "rocket-team"), "01ROCKET", "Rocket Team");
    const settings = new Map<string, unknown>([
      ["lastHosted", { workspaceName: "Rocket Team", port: 9001 }],
    ]);
    const h = harness({ root, settings });

    await h.controller.rename({ folder: "rocket-team", name: "Blue Team" });
    expect(h.starts).toEqual([]);
    expect(readWorkspace(join(hosted, "rocket-team"))).toEqual({
      id: "01ROCKET",
      name: "Blue Team",
    });
    expect(readdirSync(hosted)).toEqual(["rocket-team"]);
    expect(registryOf(h)).toEqual([
      expect.objectContaining({ id: "01ROCKET", folder: "rocket-team", name: "Blue Team" }),
    ]);
    // An earlier version would reopen rocket-team as Rocket Team and put the
    // old name back, so it is no longer told about it.
    expect(h.saved).toEqual([null]);

    // Starting it gives the server no name: it already has the new one.
    const status = await h.controller.start({ folder: "rocket-team" });
    expect(h.starts).toEqual([{ port: 9001, dataDir: join(hosted, "rocket-team") }]);
    expect(status.workspaceName).toBe("Blue Team");
    await h.controller.stop();

    // A second launch lists the new name.
    const again = harness({ root, settings });
    expect((await again.controller.list()).workspaces.map((w) => w.name)).toEqual(["Blue Team"]);
  });

  it("writes a name the real server keeps when it next starts", async () => {
    const root = profile();
    const dataDir = join(root, "hosted", "rocket-team");
    const first = await createWorkspaceServer({
      dataDir,
      port: 0,
      host: "127.0.0.1",
      mdns: false,
      workspaceName: "Rocket Team",
      logger: false,
    });
    const id = first.store.getMeta("workspace_id");
    await first.stop();

    const h = harness({ root });
    await h.controller.rename({ folder: "rocket-team", name: "Blue Team" });
    const second = await createWorkspaceServer({
      dataDir,
      port: 0,
      host: "127.0.0.1",
      mdns: false,
      logger: false,
    });
    try {
      expect(second.store.getMeta("workspace_name")).toBe("Blue Team");
      expect(second.store.getMeta("workspace_id")).toBe(id);
    } finally {
      await second.stop();
    }
  });

  it("keeps two workspaces that share a name apart", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Team A" });
    await h.controller.stop();
    await h.controller.start({ workspaceName: "Night Shift" });
    await h.controller.stop();
    const [first, second] = registryOf(h);
    await h.controller.rename({ folder: second!.folder, name: "Team A" });

    const { workspaces } = await h.controller.list();
    expect(workspaces.map((w) => [w.folder, w.name])).toEqual([
      [second!.folder, "Team A"],
      [first!.folder, "Team A"],
    ]);
    // Only the renamed one's database changed.
    expect(h.databases.get(join(h.dataRoot, first!.folder))).toEqual({
      id: "ws-1",
      name: "Team A",
    });
    expect(h.databases.get(join(h.dataRoot, second!.folder))).toEqual({
      id: "ws-2",
      name: "Team A",
    });
    // Each still starts its own folder, found by its entry and not its name.
    await h.controller.start({ folder: first!.folder });
    await h.controller.stop();
    await h.controller.start({ folder: second!.folder });
    expect(h.starts.slice(2).map((s) => s.dataDir)).toEqual([
      join(h.dataRoot, first!.folder),
      join(h.dataRoot, second!.folder),
    ]);
    expect(registryOf(h).map((e) => e.id)).toEqual(["ws-1", "ws-2"]);
  });

  it("refuses a bad name, an unlisted workspace, and a folder that is gone or holds another", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    await h.controller.start({ workspaceName: "Night Shift" });
    await h.controller.stop();
    const [rocket, night] = registryOf(h);
    const before = registryOf(h);

    for (const name of ["", "   ", "x".repeat(81), "Blue\nTeam", 5, undefined]) {
      await expect(h.controller.rename({ folder: rocket!.folder, name })).rejects.toThrow(
        /1 to 80 characters/,
      );
    }
    for (const bad of [undefined, null, "rocket-team", { folder: 5, name: "Blue Team" }]) {
      await expect(h.controller.rename(bad)).rejects.toThrow(/Choose a workspace/);
    }
    await expect(h.controller.rename({ folder: "not-listed", name: "Blue Team" })).rejects.toThrow(
      /not in the list/,
    );

    // Swapped by hand for another workspace's folder: that one keeps its name.
    const nightDir = join(h.dataRoot, night!.folder);
    h.databases.set(nightDir, { id: "someone-else", name: "Other" });
    await expect(h.controller.rename({ folder: night!.folder, name: "Blue Team" })).rejects.toThrow(
      /holds a different workspace/,
    );
    expect(h.databases.get(nightDir)!.name).toBe("Other");

    // A database that cannot be written: said plainly, without its path.
    h.writeFails = true;
    const refused = await h.controller
      .rename({ folder: rocket!.folder, name: "Blue Team" })
      .catch((error: Error) => error.message);
    expect(refused).toMatch(/could not be changed, so it was not renamed/);
    expect(refused).not.toContain(h.dataRoot);
    expect(refused).not.toContain("sam");
    h.writeFails = false;

    // Gone, and never recreated to hold the name.
    rmSync(join(h.dataRoot, rocket!.folder), { recursive: true });
    await expect(
      h.controller.rename({ folder: rocket!.folder, name: "Blue Team" }),
    ).rejects.toThrow(/missing/);
    expect(existsSync(join(h.dataRoot, rocket!.folder))).toBe(false);

    expect(h.written).toEqual([]);
    expect(h.renamedRunning).toEqual([]);
    expect(registryOf(h)).toEqual(before);
  });
});

describe("opening a hosted workspace's folder", () => {
  it("opens only a folder the list names, never a path it is given", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    const [entry] = registryOf(h);
    await h.controller.openFolder(entry!.folder);
    expect(h.opened).toEqual([join(h.dataRoot, entry!.folder)]);

    for (const bad of [
      undefined,
      5,
      { folder: entry!.folder },
      "not-listed",
      "..",
      "../settings.json",
      h.dataRoot,
      join(h.dataRoot, entry!.folder),
      "C:\\Windows",
    ]) {
      await expect(h.controller.openFolder(bad)).rejects.toThrow();
    }
    expect(h.opened).toHaveLength(1);
  });

  it("says when the folder is gone, or the system could not open it, without the path", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    await h.controller.start({ workspaceName: "Night Shift" });
    const [rocket, night] = registryOf(h);

    h.openAnswer = `Failed to open path ${join(h.dataRoot, night!.folder)}`;
    const refused = await h.controller
      .openFolder(night!.folder)
      .catch((error: Error) => error.message);
    expect(refused).toBe("The folder for Night Shift could not be opened.");

    h.openAnswer = "";
    rmSync(join(h.dataRoot, rocket!.folder), { recursive: true });
    await expect(h.controller.openFolder(rocket!.folder)).rejects.toThrow(/missing/);
    expect(h.opened).toEqual([join(h.dataRoot, night!.folder)]);
  });
});

describe("restoring a backup in the desktop app", () => {
  /** A real workspace, backed up by the real server, as another computer would have made it. */
  async function realBackup(): Promise<{ dir: string; id: string }> {
    const elsewhere = profile();
    const server = await createWorkspaceServer({
      dataDir: join(elsewhere, "data"),
      port: 0,
      host: "127.0.0.1",
      mdns: false,
      workspaceName: "Rocket Team",
      logger: false,
    });
    const id = server.store.getMeta("workspace_id")!;
    await server.stop();
    const dir = join(elsewhere, "backup");
    await backupWorkspace({ dataDir: join(elsewhere, "data"), out: dir });
    return { dir, id };
  }

  it("restores onto a fresh install as a new workspace, and starts nothing", async () => {
    const backup = await realBackup();
    const h = harness();
    const restored = await h.controller.restore({ backupDir: backup.dir });
    expect(restored).toEqual({
      folder: expect.stringMatching(NEW_FOLDER),
      name: "Rocket Team",
      inventory: expect.objectContaining({ sessions: expect.any(Number) }),
    });
    expect(registryOf(h)).toEqual([
      expect.objectContaining({ id: backup.id, folder: restored.folder, name: "Rocket Team" }),
    ]);
    expect(readWorkspace(join(h.dataRoot, restored.folder))).toEqual({
      id: backup.id,
      name: "Rocket Team",
    });
    expect(h.starts).toEqual([]);
    // Nothing but the restored folder is left behind in the hosted folder.
    expect(readdirSync(h.dataRoot)).toEqual([restored.folder]);
    // From the list it starts only to be looked inside, with its identity checked.
    await h.controller.start({ folder: restored.folder });
    expect(h.starts).toEqual([
      { port: 8543, dataDir: join(h.dataRoot, restored.folder), isolated: true },
    ]);
  });

  it("brings a listed workspace whose folder is gone back into that folder", async () => {
    const backup = await realBackup();
    const settings = new Map<string, unknown>([
      [
        "hostedWorkspaces",
        {
          version: 1,
          workspaces: [
            { id: backup.id, folder: "rocket-team", name: "Rocket", port: 9001, lastHostedAt: 5 },
          ],
        },
      ],
    ]);
    const h = harness({ settings });
    expect(await h.controller.restore({ backupDir: backup.dir })).toMatchObject({
      folder: "rocket-team",
      name: "Rocket Team",
    });
    expect(registryOf(h)).toEqual([
      expect.objectContaining({ folder: "rocket-team", port: 9001, name: "Rocket Team" }),
    ]);
    expect(existsSync(join(h.dataRoot, "rocket-team", "workspace.db"))).toBe(true);
  });

  it("holds a restored workspace until it is put back in use, across a restart", async () => {
    const backup = await realBackup();
    const settings = new Map<string, unknown>([
      [
        "hostedWorkspaces",
        {
          version: 1,
          workspaces: [
            { id: backup.id, folder: "rocket-team", name: "Rocket", port: 9001, lastHostedAt: 5 },
          ],
        },
      ],
      // Chosen to start with Gatherline before its folder went missing.
      ["startOnLaunch", "rocket-team"],
    ]);
    const h = harness({ settings });
    const restored = await h.controller.restore({ backupDir: backup.dir });
    expect(restored.inventory).toMatchObject({
      scheduled: expect.any(Object),
      sessions: expect.any(Number),
    });
    // Restoring takes it off starting by itself.
    expect(settings.get("startOnLaunch")).toBeNull();

    // A later launch finds it still held, and starts it only to look inside.
    const later = harness({ root: join(h.dataRoot, ".."), settings });
    expect(await later.controller.startForLaunch()).toBeNull();
    const listed = (await later.controller.list()).workspaces[0]!;
    expect(listed).toMatchObject({ folder: "rocket-team", restored: true });
    const looking = await later.controller.start({ folder: "rocket-team" });
    expect(looking.isolated).toBe(true);
    expect(later.starts.at(-1)).toMatchObject({ isolated: true });
    await expect(later.controller.openToAll({})).rejects.toThrow(/cannot be opened to all/);
    await expect(later.controller.start({ folder: "rocket-team", activate: true })).rejects.toThrow(
      /Stop looking inside/,
    );
    await expect(later.controller.setStartOnLaunch("rocket-team")).rejects.toThrow(
      /back in use before choosing it/,
    );
    await later.controller.stop();

    // Put back in use on purpose: a normal start, and the hold is gone for good.
    const live = await later.controller.start({ folder: "rocket-team", activate: true });
    expect(live.isolated).toBeUndefined();
    expect(later.starts.at(-1)).not.toHaveProperty("isolated");
    expect(registryOf(later)[0]!.restoredHold).toBeUndefined();
    await later.controller.stop();
    await later.controller.start({ folder: "rocket-team" });
    expect(later.starts.at(-1)).not.toHaveProperty("isolated");
  });

  it("does not start a held workspace with Gatherline, even if an older version chose it", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    const saved = h.settings.get("hostedWorkspaces") as { workspaces: Record<string, unknown>[] };
    saved.workspaces[0]!.restoredHold = "unreadable";
    h.settings.set("startOnLaunch", saved.workspaces[0]!.folder);
    const later = harness({ root: join(h.dataRoot, ".."), settings: h.settings });
    for (const [path, found] of h.databases) later.databases.set(path, found);
    expect(await later.controller.startForLaunch()).toBeNull();
    expect(later.controller.status().launchError).toMatch(
      /restored from a backup and has not been put back in use/,
    );
    expect(later.starts).toEqual([]);
  });

  it("leaves a workspace still on this computer alone", async () => {
    const backup = await realBackup();
    const root = profile();
    workspaceDb(join(root, "hosted", "rocket-team"), backup.id, "Rocket Team");
    const h = harness({ root });
    await expect(h.controller.restore({ backupDir: backup.dir })).rejects.toThrow(
      /already hosted on this computer/,
    );
    expect(readdirSync(h.dataRoot)).toEqual(["rocket-team"]);
    expect(registryOf(h)).toHaveLength(1);
  });

  it("restores nothing without room for it, or from a damaged backup", async () => {
    const backup = await realBackup();
    const h = harness();
    h.free = 1024;
    await expect(h.controller.restore({ backupDir: backup.dir })).rejects.toThrow(
      /not enough free space/,
    );
    h.free = Number.MAX_SAFE_INTEGER;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(backup.dir, "workspace.db"), "damaged");
    await expect(h.controller.restore({ backupDir: backup.dir })).rejects.toThrow(/damaged/);
    await expect(h.controller.restore({ backupDir: "relative" })).rejects.toThrow(/Choose/);
    expect(registryOf(h)).toEqual([]);
    expect(existsSync(h.dataRoot) ? readdirSync(h.dataRoot) : []).toEqual([]);
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

  it("reopens a stable address when started with Gatherline, only when asked, and invite-only", async () => {
    let address = configured;
    const first = harness({
      publicAccess: true,
      publicAddress: () => ({ url: address, managed: true }),
    });
    await first.controller.start({ workspaceName: "Rocket Team" });
    const folder = registryOf(first)[0]!.folder;
    await first.controller.setStartOnLaunch(folder);
    expect(await first.controller.setReopenPublicOnLaunch(true)).toBe(true);
    expect(first.controller.status().reopensPublicOnLaunch).toBe(true);
    expect(first.settings.get("reopenPublicOnLaunch")).toEqual({ folder, address: configured });
    await first.controller.stop();

    const next = harness({
      root: join(first.dataRoot, ".."),
      settings: first.settings,
      publicAccess: true,
      publicAddress: () => ({ url: address, managed: true }),
    });
    for (const [path, found] of first.databases) next.databases.set(path, found);
    const started = await next.controller.startForLaunch();
    expect(started?.openToAll).toEqual({ phase: "open", url: expect.any(String) });
    expect(next.tunnelStarts).toHaveLength(1);
    expect(next.controller.status().inviteOnly).toBe(true);
    await next.controller.stop();

    // The address it was set up with changed: nothing is published by it.
    address = "https://other.example.org";
    const moved = harness({
      root: join(first.dataRoot, ".."),
      settings: first.settings,
      publicAccess: true,
      publicAddress: () => ({ url: address, managed: true }),
    });
    for (const [path, found] of first.databases) moved.databases.set(path, found);
    const running = await moved.controller.startForLaunch();
    expect(running?.running).toBe(true);
    expect(moved.tunnelStarts).toHaveLength(0);
    expect(moved.controller.status().launchError).toMatch(/was not reopened.*has changed/);
  });

  it("keeps hosting and says so when the stable address cannot be reopened", async () => {
    const first = harness({
      publicAccess: true,
      publicAddress: () => ({ url: configured, managed: true }),
    });
    await first.controller.start({ workspaceName: "Rocket Team" });
    await first.controller.setStartOnLaunch(registryOf(first)[0]!.folder);
    await first.controller.setReopenPublicOnLaunch(true);
    await first.controller.stop();
    const next = harness({
      root: join(first.dataRoot, ".."),
      settings: first.settings,
      publicAccess: true,
      publicAddress: () => ({ url: configured, managed: true }),
    });
    for (const [path, found] of first.databases) next.databases.set(path, found);
    next.beforeTunnel = () => {
      throw new Error("address did not reach this workspace");
    };
    const started = await next.controller.startForLaunch();
    expect(started?.running).toBe(true);
    expect(next.controller.status().launchError).toMatch(
      /started on this network, but .* was not reopened\. .*did not reach/,
    );
    // Nothing was published, and it is back to how it was before trying.
    expect(next.publicUrls.filter(Boolean)).toEqual([]);
    expect(next.controller.status().openToAll).toBeUndefined();
  });

  it("offers reopening only for a stable address", async () => {
    const h = harness({ publicAccess: true });
    await h.controller.start({ workspaceName: "Rocket Team" });
    await expect(h.controller.setReopenPublicOnLaunch(true)).rejects.toThrow(
      /Only a stable address/,
    );
    expect(await h.controller.setReopenPublicOnLaunch(false)).toBe(false);
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

describe("starting with the computer", () => {
  it("starts the chosen workspace when the app opens, and says so in the status and the list", async () => {
    const first = harness();
    const made = await first.controller.start({ workspaceName: "Rocket Team" });
    await first.controller.setStartOnLaunch(made.folder!);
    expect(first.settings.get("startOnLaunch")).toBe(made.folder);
    expect(first.controller.status().startsOnLaunch).toBe(true);
    await first.controller.stop();

    // The next launch, sharing the profile and its settings.
    const next = harness({ root: join(first.dataRoot, ".."), settings: first.settings });
    for (const [dataDir, db] of first.databases) next.databases.set(dataDir, db);
    const started = await next.controller.startForLaunch();
    expect(started).toMatchObject({ running: true, folder: made.folder, startsOnLaunch: true });
    expect(next.starts).toHaveLength(1);
    expect((await next.controller.list()).workspaces).toEqual([
      expect.objectContaining({ folder: made.folder, startsOnLaunch: true }),
    ]);
  });

  it("says so when the choice itself cannot be read, and finds it once it can", async () => {
    const first = harness();
    await first.controller.start({ workspaceName: "Rocket Team" });
    const folder = registryOf(first)[0]!.folder;
    await first.controller.setStartOnLaunch(folder);
    await first.controller.stop();

    const next = harness({ root: join(first.dataRoot, ".."), settings: first.settings });
    for (const [path, found] of first.databases) next.databases.set(path, found);
    next.unreadableKeys.add("startOnLaunch");
    expect(await next.controller.startForLaunch()).toBeNull();
    expect(next.controller.status().launchError).toMatch(/could not read which workspace to start/);
    // The rest of hosting still works, and lists what it can.
    expect((await next.controller.list()).workspaces.map((w) => w.folder)).toEqual([folder]);

    // Repaired: nothing unreadable was remembered as "none".
    next.unreadableKeys.clear();
    const started = await next.controller.startForLaunch();
    expect(started?.running).toBe(true);
    expect(next.controller.status().launchError).toBeUndefined();
  });

  it("lets a failed choice be taken back while nothing is running, keeping the workspace", async () => {
    const h = harness();
    await h.controller.start({ workspaceName: "Rocket Team" });
    const folder = registryOf(h)[0]!.folder;
    await h.controller.setStartOnLaunch(folder);
    await h.controller.stop();
    h.beforeBind = () => {
      throw Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    };
    expect(await h.controller.startForLaunch()).toBeNull();
    expect(h.controller.status().launchError).toBeDefined();

    expect(await h.controller.setStartOnLaunch(null)).toBeNull();
    expect(h.controller.status().launchError).toBeUndefined();
    expect(h.settings.get("startOnLaunch")).toBeNull();
    expect(registryOf(h).map((e) => e.folder)).toEqual([folder]);
  });

  it("does not take a choice it cannot understand for no choice", async () => {
    const h = harness();
    h.settings.set("startOnLaunch", 42);
    expect(await h.controller.startForLaunch()).toBeNull();
    expect(h.controller.status().launchError).toMatch(/could not read which workspace to start/);
  });

  it("starts nothing when nothing was chosen, or the choice was taken back", async () => {
    const h = harness();
    expect(await h.controller.startForLaunch()).toBeNull();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.setStartOnLaunch(made.folder!);
    await h.controller.setStartOnLaunch(null);
    expect(h.controller.status().startsOnLaunch).toBeUndefined();
    await h.controller.stop();
    expect(await h.controller.startForLaunch()).toBeNull();
    expect(h.starts).toHaveLength(1);
  });

  it("refuses to choose a workspace it does not list, or anything but a folder", async () => {
    const h = harness();
    await expect(h.controller.setStartOnLaunch("w-not-here")).rejects.toThrow(
      "That workspace is not in the list hosted on this computer.",
    );
    await expect(h.controller.setStartOnLaunch(42)).rejects.toThrow(/Choose a workspace/);
    expect(h.settings.has("startOnLaunch")).toBe(false);
  });

  it("says why the chosen workspace did not start, until hosting next starts", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.setStartOnLaunch(made.folder!);
    await h.controller.stop();
    h.beforeBind = () => {
      throw new Error("The database is newer than this version of Gatherline.");
    };
    expect(await h.controller.startForLaunch()).toBeNull();
    expect(h.controller.status()).toMatchObject({
      running: false,
      launchError:
        "Gatherline did not start hosting Rocket Team when it opened. The database is newer than this version of Gatherline.",
    });
    // The choice stands: it was the start that failed, not the choice.
    expect(h.settings.get("startOnLaunch")).toBe(made.folder);

    h.beforeBind = () => {};
    await h.controller.start({ folder: made.folder });
    expect(h.controller.status().launchError).toBeUndefined();
  });

  it("drops a choice whose workspace has left the list, and forgetting a workspace drops it too", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.setStartOnLaunch(made.folder!);
    await h.controller.stop();
    rmSync(join(h.dataRoot, made.folder!), { recursive: true, force: true });
    await h.controller.forget(made.folder);
    expect(h.settings.get("startOnLaunch")).toBeNull();
    expect(await h.controller.startForLaunch()).toBeNull();

    // A choice left behind by some other way of editing the list.
    const other = harness();
    other.settings.set("startOnLaunch", "w-long-gone");
    expect(await other.controller.startForLaunch()).toBeNull();
    expect(other.settings.get("startOnLaunch")).toBeNull();
    expect(other.controller.status().launchError).toBeUndefined();
  });

  it("says the list could not be read rather than starting nothing silently", async () => {
    const h = harness();
    h.settings.set("startOnLaunch", "w-anything");
    h.unreadableKeys.add("hostedWorkspaces");
    expect(await h.controller.startForLaunch()).toBeNull();
    expect(h.controller.status().launchError).toMatch(
      /could not read its list of hosted workspaces/,
    );
  });

  it("announces the running workspace again when the network changes, and tells the window", async () => {
    const h = harness();
    h.controller.networkChanged();
    expect(h.reannounced).toBe(0);
    await h.controller.start({ workspaceName: "Rocket Team" });
    const told = h.changes.length;
    h.controller.networkChanged();
    expect(h.reannounced).toBe(1);
    expect(h.changes.length).toBe(told + 1);
    expect(h.changes.at(-1)).toMatchObject({ running: true, lanUrls: ["192.168.1.20:8543"] });
  });
});

describe("who is connected, and which port", () => {
  it("counts who is connected to the running workspace, and tells the window when that changes", async () => {
    const h = harness();
    expect(h.controller.status().connected).toBeUndefined();
    await h.controller.start({ workspaceName: "Rocket Team" });
    expect(h.controller.status().connected).toBe(0);

    h.connected = 3;
    for (const listener of h.connectionListeners) listener();
    expect(h.changes.at(-1)).toMatchObject({ running: true, connected: 3 });

    await h.controller.stop();
    expect(h.connectionListeners.size).toBe(0);
    expect(h.controller.status().connected).toBeUndefined();
  });

  it("changes the port a stopped workspace starts on, and not the running one's", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await expect(h.controller.setPort({ folder: made.folder, port: 9100 })).rejects.toThrow(
      "Stop hosting Rocket Team before changing its port.",
    );
    await h.controller.stop();

    expect(await h.controller.setPort({ folder: made.folder, port: 9100 })).toEqual({
      folder: made.folder,
      port: 9100,
    });
    expect(registryOf(h)[0]).toMatchObject({ port: 9100 });
    await h.controller.start({ folder: made.folder });
    expect(h.starts.at(-1)!.port).toBe(9100);
  });

  it("refuses a port no program could use, and a workspace it does not list", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    for (const port of [0, 65536, 80.5, "9000", null]) {
      await expect(h.controller.setPort({ folder: made.folder, port })).rejects.toThrow(
        "Choose a port from 1 to 65535.",
      );
    }
    await expect(h.controller.setPort({ folder: "w-elsewhere", port: 9100 })).rejects.toThrow(
      "That workspace is not in the list hosted on this computer.",
    );
    expect(registryOf(h)[0]).toMatchObject({ port: 8543 });
  });

  it("keeps the old port when the new one cannot be saved", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    h.saveFails = true;
    await expect(h.controller.setPort({ folder: made.folder, port: 9100 })).rejects.toThrow(
      /could not save the new port/,
    );
    h.saveFails = false;
    expect((await h.controller.list()).workspaces[0]).toMatchObject({ port: 8543 });
  });
});

describe("protecting recovery copies", () => {
  const DAY = 24 * 3600_000;

  /** A real workspace, listed as hosted here and stopped, as the real server leaves it. */
  async function realWorkspace(h: ReturnType<typeof harness>, folder = "rocket-team") {
    const dataDir = join(h.dataRoot, folder);
    const server = await createWorkspaceServer({
      dataDir,
      port: 0,
      host: "127.0.0.1",
      mdns: false,
      workspaceName: "Rocket Team",
      logger: false,
    });
    const id = server.store.getMeta("workspace_id")!;
    await server.stop();
    return { dataDir, id, folder };
  }

  /** A harness whose backups are the real server's, with one real workspace listed. */
  async function realScheduled(keep: number) {
    const settings = new Map<string, unknown>();
    const h = harness({ settings });
    h.realBackups = true;
    const workspace = await realWorkspace(h);
    settings.set("hostedWorkspaces", {
      version: 1,
      workspaces: [
        {
          id: workspace.id,
          folder: workspace.folder,
          name: "Rocket Team",
          port: 9001,
          lastHostedAt: 5,
        },
      ],
    });
    const destination = profile();
    await h.controller.setAutoBackup({
      folder: workspace.folder,
      schedule: { destination, everyDays: 1, keep },
    });
    return { h, destination, ...workspace };
  }

  /** A real backup of the workspace, named as this app names them, at `stamp`. */
  async function archive(dataDir: string, destination: string, stamp: string) {
    const dir = join(destination, `rocket-team-${stamp}`);
    await backupWorkspace({ dataDir, out: dir });
    return dir;
  }

  it("never lets a damaged backup dated in the future take the place of the one just made", async () => {
    const { h, destination, dataDir, folder } = await realScheduled(1);
    // The same workspace's database, but its manifest ruined, and dated years ahead.
    const future = await archive(dataDir, destination, "2099-01-01T00-00-00");
    writeFileSync(join(future, "manifest.json"), "{}");
    await expect(verifyBackup(future)).rejects.toThrow();

    await h.controller.runDueBackups();

    expect(h.backups).toHaveLength(1);
    const fresh = h.backups[0]!.out;
    expect(readdirSync(destination)).toEqual([fresh.slice(destination.length + 1)]);
    await expect(verifyBackup(fresh)).resolves.toMatchObject({ workspaceName: "Rocket Team" });
    const listed = (await h.controller.list()).workspaces.find((w) => w.folder === folder)!;
    expect(listed.autoBackupError).toBeNull();
    expect(listed.lastBackupAt).not.toBeNull();
  });

  it("counts only copies that pass the check, and leaves a failing one it still has room for", async () => {
    const { h, destination, dataDir } = await realScheduled(2);
    const future = await archive(dataDir, destination, "2099-01-01T00-00-00");
    writeFileSync(join(future, "manifest.json"), "{}");
    const good = await archive(dataDir, destination, "2020-01-02T00-00-00");
    // Its manifest names an attachment that is not there.
    const missing = await archive(dataDir, destination, "2020-01-01T00-00-00");
    const manifest = JSON.parse(readFileSync(join(missing, "manifest.json"), "utf8"));
    manifest.files.push({ name: "gone", bytes: 1, sha256: "0".repeat(64) });
    writeFileSync(join(missing, "manifest.json"), JSON.stringify(manifest));
    const damaged = await archive(dataDir, destination, "2019-01-01T00-00-00");
    writeFileSync(join(damaged, "workspace.db"), "not a database");

    await h.controller.runDueBackups();

    const fresh = h.backups[0]!.out;
    // The fresh copy and the newest good one are the two kept. The damaged
    // future one never counted, so it was not removed to make room either.
    // The one missing an attachment, past the two good copies, went. The one
    // whose database is unreadable cannot be shown to be this workspace's,
    // so it is not this app's to remove.
    expect(readdirSync(destination).sort()).toEqual(
      [fresh, good, future, damaged].map((dir) => dir.slice(destination.length + 1)).sort(),
    );
    expect(existsSync(missing)).toBe(false);
  });

  it("keeps the backup just made when the clock has gone back", async () => {
    const { h, destination, dataDir } = await realScheduled(1);
    // Made when the clock read later than it does now.
    await archive(dataDir, destination, "2030-06-01T00-00-00");
    await h.controller.runDueBackups();
    const fresh = h.backups[0]!.out;
    expect(fresh < join(destination, "rocket-team-2030")).toBe(true);
    expect(readdirSync(destination)).toEqual([fresh.slice(destination.length + 1)]);
    await expect(verifyBackup(fresh)).resolves.toBeDefined();
  });

  it("refuses to back up a listed workspace whose folder now holds another", async () => {
    const settings = new Map<string, unknown>();
    const h = harness({ settings });
    h.realBackups = true;
    const other = await realWorkspace(h, "rocket-team");
    // The list says this folder is a different workspace than the one in it.
    settings.set("hostedWorkspaces", {
      version: 1,
      workspaces: [
        {
          id: "ws-listed",
          folder: other.folder,
          name: "Design Guild",
          port: 9001,
          lastHostedAt: 5,
        },
      ],
    });
    const destination = profile();
    await expect(h.controller.backup({ folder: other.folder, destination })).rejects.toThrow(
      /The folder listed as Design Guild holds “Rocket Team” instead/,
    );
    expect(h.backups).toEqual([]);
    expect(readdirSync(destination)).toEqual([]);
    expect(registryOf(h)[0]!.lastBackupAt).toBeUndefined();
  });

  it("removes a copy whose workspace changed while it was being made, and records nothing", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    const destination = profile();
    // Checked before the copy starts, then swapped for another workspace's.
    h.swapDuringBackup = "ws-swapped";
    await expect(h.controller.backup({ folder: made.folder!, destination })).rejects.toThrow(
      /changed while it was being copied, so the copy was removed/,
    );
    expect(readdirSync(destination)).toEqual([]);
    expect(registryOf(h)[0]!.lastBackupAt).toBeUndefined();
  });
});

describe("scheduled backups", () => {
  const DAY = 24 * 3600_000;

  async function scheduled(keep = 2) {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    const destination = profile();
    await h.controller.setAutoBackup({
      folder: made.folder,
      schedule: { destination, everyDays: 1, keep },
    });
    return { h, folder: made.folder!, destination };
  }

  it("backs a workspace up when it is due, and not again until the next one is", async () => {
    const { h, folder, destination } = await scheduled();
    expect((await h.controller.list()).workspaces[0]).toMatchObject({
      autoBackup: { destination, everyDays: 1, keep: 2 },
      autoBackupError: null,
    });
    await h.controller.runDueBackups();
    expect(h.backups).toHaveLength(1);
    expect(h.backups[0]!.out.startsWith(destination)).toBe(true);
    await h.controller.runDueBackups();
    expect(h.backups).toHaveLength(1);

    h.clock += DAY;
    await h.controller.runDueBackups();
    expect(h.backups).toHaveLength(2);
    expect(registryOf(h).find((e) => e.folder === folder)!.lastBackupAt).toBeGreaterThan(DAY);
  });

  it("keeps only the newest of its own backups, and leaves everything else in the folder alone", async () => {
    const { h, destination } = await scheduled(2);
    // A folder of the host's own, and a backup of some other workspace.
    mkdirSync(join(destination, "holiday-photos"));
    workspaceDb(join(destination, "other-team-2026-01-01T00-00-00"), "ws-other", "Other Team");
    writeFileSync(join(destination, "other-team-2026-01-01T00-00-00", "manifest.json"), "{}");
    // And a copy of this very workspace's backup that someone named themselves.
    const id = registryOf(h)[0]!.id;
    workspaceDb(join(destination, "keep-this-one"), id, "Rocket Team");
    writeFileSync(join(destination, "keep-this-one", "manifest.json"), "{}");

    for (let day = 0; day < 4; day++) {
      await h.controller.runDueBackups();
      h.clock += DAY;
    }
    expect(h.backups).toHaveLength(4);
    const left = readdirSync(destination).sort();
    expect(left).toEqual(
      [
        "holiday-photos",
        "keep-this-one",
        "other-team-2026-01-01T00-00-00",
        h.backups[2]!.out.slice(destination.length + 1),
        h.backups[3]!.out.slice(destination.length + 1),
      ].sort(),
    );
  });

  it("backs up into a new folder at once, however recently the workspace was backed up elsewhere", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.backup({ folder: made.folder!, destination: profile() });
    const weekly = profile();
    await h.controller.setAutoBackup({
      folder: made.folder,
      schedule: { destination: weekly, everyDays: 7, keep: 3 },
    });
    await h.controller.runDueBackups();
    expect(readdirSync(weekly)).toHaveLength(1);
    // Moved to another folder, that one is due at once too.
    const moved = profile();
    await h.controller.setAutoBackup({
      folder: made.folder,
      schedule: { destination: moved, everyDays: 7, keep: 3 },
    });
    await h.controller.runDueBackups();
    expect(readdirSync(moved)).toHaveLength(1);
    // Changing only how often or how many keeps its last run, so it waits.
    await h.controller.setAutoBackup({
      folder: made.folder,
      schedule: { everyDays: 1, keep: 5 },
    });
    await h.controller.runDueBackups();
    expect(readdirSync(moved)).toHaveLength(1);
    expect(registryOf(h)[0]!.autoBackup).toMatchObject({
      destination: moved,
      everyDays: 1,
      keep: 5,
      lastAt: expect.any(Number),
    });
  });

  it("keeps a first backup that failed due, and says so, until one is made", async () => {
    const { h, destination } = await scheduled();
    h.free = 0;
    await h.controller.runDueBackups();
    expect((await h.controller.list()).workspaces[0]!.autoBackupError).toMatch(/did not finish/);
    expect(readdirSync(destination)).toEqual([]);
    // No day has passed, and it is still due.
    h.free = Number.MAX_SAFE_INTEGER;
    await h.controller.runDueBackups();
    expect(readdirSync(destination)).toHaveLength(1);
    expect((await h.controller.list()).workspaces[0]!.autoBackupError).toBeNull();
  });

  it("makes one backup when two checks overlap, and reports no failure", async () => {
    const { h, destination } = await scheduled();
    await Promise.all([h.controller.runDueBackups(), h.controller.runDueBackups()]);
    expect(h.backups).toHaveLength(1);
    expect(readdirSync(destination)).toHaveLength(1);
    expect((await h.controller.list()).workspaces[0]!.autoBackupError).toBeNull();
  });

  it("does not back up a schedule turned off while it waited its turn", async () => {
    const h = harness();
    const first = await h.controller.start({ workspaceName: "Rocket Team" });
    await h.controller.stop();
    const second = await h.controller.start({ workspaceName: "Design Guild" });
    const [one, two] = [profile(), profile()];
    await h.controller.setAutoBackup({
      folder: first.folder,
      schedule: { destination: one, everyDays: 1, keep: 2 },
    });
    await h.controller.setAutoBackup({
      folder: second.folder,
      schedule: { destination: two, everyDays: 1, keep: 2 },
    });
    const gate = deferred();
    h.backupGate = gate.promise;
    const pass = h.controller.runDueBackups();
    await vi.waitFor(() => expect(h.backups).toHaveLength(1));
    // Turned off while the first workspace's copy holds the turn.
    const off = h.controller.setAutoBackup({ folder: second.folder, schedule: null });
    h.backupGate = null;
    gate.resolve();
    await Promise.all([pass, off]);
    expect(readdirSync(one)).toHaveLength(1);
    expect(readdirSync(two)).toEqual([]);
    expect(h.backups).toHaveLength(1);
  });

  it("names two backups made in the same second apart", async () => {
    const { h, folder, destination } = await scheduled();
    await h.controller.backup({ folder, destination });
    await h.controller.runDueBackups();
    expect(readdirSync(destination)).toHaveLength(2);
    expect((await h.controller.list()).workspaces[0]!.autoBackupError).toBeNull();
  });

  it("says why a scheduled backup did not finish, and clears it once one does", async () => {
    const { h, folder } = await scheduled();
    h.free = 0;
    await h.controller.runDueBackups();
    const failed = (await h.controller.list()).workspaces.find((w) => w.folder === folder)!;
    expect(failed.autoBackupError).toMatch(
      /^The scheduled backup of Rocket Team did not finish\. There is not enough free space there\./,
    );
    expect(h.changes.at(-1)).toBeDefined();

    h.free = Number.MAX_SAFE_INTEGER;
    await h.controller.runDueBackups();
    expect((await h.controller.list()).workspaces[0]!.autoBackupError).toBeNull();
  });

  it("changes how often and how many while keeping the folder, and turns off", async () => {
    const { h, folder, destination } = await scheduled();
    expect(
      await h.controller.setAutoBackup({ folder, schedule: { everyDays: 7, keep: 14 } }),
    ).toEqual({ destination, everyDays: 7, keep: 14 });
    expect(registryOf(h)[0]!.autoBackup).toEqual({ destination, everyDays: 7, keep: 14 });

    expect(await h.controller.setAutoBackup({ folder, schedule: null })).toBeNull();
    expect(registryOf(h)[0]!.autoBackup).toBeUndefined();
    await h.controller.runDueBackups();
    expect(h.backups).toHaveLength(0);
  });

  it("refuses a schedule it could not follow", async () => {
    const h = harness();
    const made = await h.controller.start({ workspaceName: "Rocket Team" });
    await expect(
      h.controller.setAutoBackup({ folder: made.folder, schedule: { everyDays: 1, keep: 7 } }),
    ).rejects.toThrow("Choose a folder to back the workspace up into.");
    const destination = profile();
    for (const schedule of [
      { destination, everyDays: 2, keep: 7 },
      { destination, everyDays: 1, keep: 0 },
      { destination, everyDays: 1, keep: 61 },
      { destination: "backups", everyDays: 1, keep: 7 },
    ]) {
      await expect(h.controller.setAutoBackup({ folder: made.folder, schedule })).rejects.toThrow(
        "Choose a folder, daily or weekly, and to keep 1 to 60 backups.",
      );
    }
    await expect(
      h.controller.setAutoBackup({
        folder: made.folder,
        schedule: { destination: join(destination, "gone"), everyDays: 1, keep: 7 },
      }),
    ).rejects.toThrow("That folder is not there any more. Choose another.");
    await expect(
      h.controller.setAutoBackup({ folder: "w-elsewhere", schedule: null }),
    ).rejects.toThrow("That workspace is not in the list hosted on this computer.");
    expect(registryOf(h)[0]!.autoBackup).toBeUndefined();
  });

  it("reads when a schedule last ran, and forgets a time it cannot read", () => {
    const base = { destination: profile(), everyDays: 7, keep: 3 };
    expect(parseAutoBackup({ ...base, lastAt: 1234 })).toEqual({ ...base, lastAt: 1234 });
    for (const lastAt of [-1, "yesterday", Number.NaN, null])
      expect(parseAutoBackup({ ...base, lastAt })).toEqual(base);
  });

  it("reads a schedule back from the settings file, and drops one it could not follow", () => {
    const entry = { id: "ws-1", folder: "w-1", name: "Rocket Team", port: 8543, lastHostedAt: 1 };
    const destination = profile();
    expect(
      parseRegistry({
        version: 1,
        workspaces: [
          { ...entry, autoBackup: { destination, everyDays: 7, keep: 3 } },
          {
            ...entry,
            id: "ws-2",
            folder: "w-2",
            autoBackup: { destination, everyDays: 3, keep: 3 },
          },
        ],
      }).map((e) => e.autoBackup),
    ).toEqual([{ destination, everyDays: 7, keep: 3 }, undefined]);
  });
});
