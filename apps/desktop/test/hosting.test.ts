import { describe, expect, it, vi, type Mock } from "vitest";
import { join } from "node:path";
import { createHostingController, type HostingSnapshot } from "../src/main/hosting.js";

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
function harness() {
  const h = {
    starts: [] as StartRequest[],
    servers: [] as { port: number; stop: Mock<() => Promise<void>> }[],
    saved: [] as unknown[],
    changes: [] as HostingSnapshot[],
    /** Runs as each server binds; throw to fail that attempt, or return a promise to hold it. */
    beforeBind: (_port: number): Promise<void> | void => {},
    saveFails: false,
    notifyFails: false,
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
      };
      h.servers.push(server);
      return server;
    },
    onChange: () => {
      if (h.notifyFails) throw new Error("window already destroyed");
      h.changes.push(h.controller.status());
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
