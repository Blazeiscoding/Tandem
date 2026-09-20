import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findCloudflared, openQuickTunnel, type Tunnel } from "../src/main/tunnel.js";

const fake = resolve(import.meta.dirname, "../../../tests/fixtures/fake-cloudflared.mjs");
const healthy = async () => true;

/** Starts the stand-in cloudflared the way the app starts the real one, in a chosen mode. */
function launchAs(mode: string, extra: Record<string, string> = {}) {
  return (_command: string, args: string[]) =>
    spawn(process.execPath, [fake, ...args], {
      env: { ...process.env, FAKE_CLOUDFLARED_MODE: mode, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
}

const opened: Tunnel[] = [];
afterEach(async () => {
  for (const tunnel of opened.splice(0)) await tunnel.close();
});

describe("finding cloudflared", () => {
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it("takes a path configured for the app, and nothing else when that is missing", () => {
    const env = { GATHERLINE_CLOUDFLARED: "D:\\tools\\cloudflared.exe", PATH: "C:\\bin" };
    expect(findCloudflared(env, present("D:\\tools\\cloudflared.exe"), "win32")).toBe(
      "D:\\tools\\cloudflared.exe",
    );
    expect(findCloudflared(env, present(join("C:\\bin", "cloudflared.exe")), "win32")).toBeNull();
  });

  it("looks on PATH first, then where the Windows installer and winget put it", () => {
    const env = {
      PATH: "C:\\bin;C:\\tools",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
    };
    const installer = join("C:\\Program Files (x86)", "cloudflared", "cloudflared.exe");
    const winget = join(
      "C:\\Users\\sam\\AppData\\Local",
      "Microsoft",
      "WinGet",
      "Links",
      "cloudflared.exe",
    );
    const onPath = join("C:\\tools", "cloudflared.exe");
    expect(findCloudflared(env, present(installer, winget, onPath), "win32")).toBe(onPath);
    expect(findCloudflared(env, present(installer, winget), "win32")).toBe(installer);
    expect(findCloudflared(env, present(winget), "win32")).toBe(winget);
    expect(findCloudflared(env, present(), "win32")).toBeNull();
  });
});

describe("opening a quick tunnel", () => {
  it("resolves with the address once a connection has registered, pointed at the workspace's port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gatherline-tunnel-"));
    try {
      const argsFile = join(dir, "args.json");
      const tunnel = await openQuickTunnel({
        command: "cloudflared",
        port: 8543,
        launch: launchAs("open", { FAKE_CLOUDFLARED_ARGS: argsFile }),
        healthProbe: healthy,
      });
      opened.push(tunnel);
      expect(tunnel.url).toBe("https://fake-open-to-all.trycloudflare.com");
      const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      expect(args[0]).toBe("tunnel");
      expect(args[1]).toBe("--config");
      expect(args[2]).toMatch(/gatherline-cloudflared-.+[\\/]config\.yml$/);
      expect(args.slice(3)).toEqual(["--no-autoupdate", "--url", "http://127.0.0.1:8543"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a script standing in for cloudflared with the app's own executable", async () => {
    const tunnel = await openQuickTunnel({ command: fake, port: 8543, healthProbe: healthy });
    opened.push(tunnel);
    expect(tunnel.url).toBe("https://fake-open-to-all.trycloudflare.com");
  });

  it("does not expose the address until Gatherline answers through Cloudflare", async () => {
    let makeHealthy!: () => void;
    const ready = new Promise<void>((resolve) => {
      makeHealthy = resolve;
    });
    const probes: string[] = [];
    let openedYet = false;
    const opening = openQuickTunnel({
      command: "cloudflared",
      port: 8543,
      launch: launchAs("open"),
      healthProbe: async (url) => {
        probes.push(url);
        await ready;
        return true;
      },
    }).then((tunnel) => {
      openedYet = true;
      return tunnel;
    });
    await expect
      .poll(() => probes)
      .toEqual(["https://fake-open-to-all.trycloudflare.com/api/health"]);
    expect(openedYet).toBe(false);
    makeHealthy();
    const tunnel = await opening;
    opened.push(tunnel);
    expect(openedYet).toBe(true);
  });

  it("says why when Cloudflare refuses the tunnel", async () => {
    await expect(
      openQuickTunnel({ command: "cloudflared", port: 8543, launch: launchAs("refused") }),
    ).rejects.toThrow(
      "Cloudflare could not open a link: failed to request quick Tunnel: 429 Too Many Requests",
    );
  });

  it("gives up, and ends cloudflared, when the address never becomes reachable", async () => {
    let child: ReturnType<ReturnType<typeof launchAs>> | undefined;
    const launch = launchAs("no-connect");
    await expect(
      openQuickTunnel({
        command: "cloudflared",
        port: 8543,
        timeoutMs: 1500,
        launch: (command, args) => (child = launch(command, args)),
      }),
    ).rejects.toThrow(/gave this workspace an address, but it did not become reachable/);
    await expect.poll(() => child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });

  it("says so when cloudflared cannot be started at all", async () => {
    await expect(
      openQuickTunnel({ command: join(tmpdir(), "no-such-cloudflared.exe"), port: 8543 }),
    ).rejects.toThrow(/cloudflared could not be started/);
  });

  it("reports a tunnel that ends on its own, and not one it was asked to close", async () => {
    const dropped = await openQuickTunnel({
      command: "cloudflared",
      port: 8543,
      launch: launchAs("drop"),
      healthProbe: healthy,
    });
    const reasons: string[] = [];
    await new Promise((resolve) => setTimeout(resolve, 300));
    dropped.onUnexpectedExit((reason) => reasons.push(reason));
    await expect.poll(() => reasons).toEqual(["the tunnel was closed by the test"]);

    const closed = await openQuickTunnel({
      command: "cloudflared",
      port: 8543,
      launch: launchAs("open"),
      healthProbe: healthy,
    });
    const quiet: string[] = [];
    closed.onUnexpectedExit((reason) => quiet.push(reason));
    await closed.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(quiet).toEqual([]);
  });
});
