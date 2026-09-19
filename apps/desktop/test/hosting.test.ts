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
function harness(options: { publicAccess?: boolean } = {}) {
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
    publicUrls: [] as (string | null)[],
    iceServers: [] as { urls: string }[][],
    tunnelStarts: [] as { port: number; signal: AbortSignal }[],
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
        stop: vi.fn(async () => {}),
        ...(options.publicAccess
          ? {
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
          openTunnel: async (port: number, signal: AbortSignal) => {
            h.events.push("tunnel:open");
            h.tunnelStarts.push({ port, signal });
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
