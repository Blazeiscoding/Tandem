import { describe, expect, it, vi, type Mock } from "vitest";
import { join } from "node:path";
import {
  createHostingController,
  parseLastHosted,
  type HostingSnapshot,
} from "../src/main/hosting.js";
import type { Tunnel } from "../src/main/tunnel.js";

interface StartRequest {
  workspaceName: string;
  port: number;
  dataDir: string;
}

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
  } = {},
) {
  type FakeTunnel = Tunnel & { close: Mock<() => Promise<void>>; drop(reason: string): void };
  const h = {
    starts: [] as StartRequest[],
    servers: [] as { port: number; stop: Mock<() => Promise<void>> }[],
    saved: [] as unknown[],
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
  h.controller = createHostingController({
    dataRoot: join("profile", "hosted"),
    defaultPort: 8543,
    lanUrls: (port) => [`192.168.1.20:${port}`],
    saveLastHosted: async (value) => {
      if (h.saveFails) throw new Error("settings file is read-only");
      h.saved.push(value);
    },
    startServer: async (request) => {
      h.starts.push(request);
      await h.beforeBind(request.port);
      const server = {
        port: request.port === 0 ? 50123 : request.port,
        instanceId: "workspace-run-1",
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

describe("hosting a workspace from the desktop app", () => {
  it("starts on the usual port, in a folder named for the workspace, and remembers it", async () => {
    const h = harness();
    const status = await h.controller.start({ workspaceName: "  Rocket Team " });
    const dataDir = join("profile", "hosted", "rocket-team");
    expect(h.starts).toEqual([{ workspaceName: "Rocket Team", port: 8543, dataDir }]);
    expect(status).toEqual({
      running: true,
      phase: "running",
      workspaceName: "Rocket Team",
      dataDir,
      port: 8543,
      lanUrls: ["192.168.1.20:8543"],
    });
    expect(h.saved).toEqual([{ workspaceName: "Rocket Team", port: 8543 }]);
    expect(h.changes.map((c) => c.phase)).toEqual(["starting", "running", "running"]);
  });

  it("keeps the folder names earlier versions used, so existing workspaces reopen", async () => {
    for (const [name, folder] of [
      ["Rocket Team", "rocket-team"],
      ["  Ops / Night Shift  ", "ops-night-shift"],
      ["???", "workspace"],
    ] as const) {
      const h = harness();
      await h.controller.start({ workspaceName: name });
      expect(h.starts[0]!.dataDir).toBe(join("profile", "hosted", folder));
    }
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
  });

  it("keeps a started workspace running when its settings cannot be saved, and saves them later", async () => {
    const h = harness();
    h.saveFails = true;
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
    expect(h.saved).toEqual([{ workspaceName: "Rocket Team", port: 8543 }]);
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
    h.saveFails = true;
    h.beforeBind = (port) => {
      if (port === 8543) throw inUse();
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
