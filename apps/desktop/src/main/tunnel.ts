import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where to find Cloudflare's cloudflared: a path set for this app, then PATH,
 * then where its Windows installer and winget put it, then the usual package
 * manager folders elsewhere. Null when it is not installed.
 */
export function findCloudflared(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = env.GATHERLINE_CLOUDFLARED ?? env.SLACKOSS_CLOUDFLARED;
  if (configured) return exists(configured) ? configured : null;
  const windows = platform === "win32";
  const file = windows ? "cloudflared.exe" : "cloudflared";
  const candidates = (env.PATH ?? env.Path ?? "")
    .split(windows ? ";" : ":")
    .filter(Boolean)
    .map((dir) => join(dir, file));
  if (windows) {
    for (const root of [env["ProgramFiles(x86)"], env.ProgramFiles]) {
      if (root) candidates.push(join(root, "cloudflared", file));
    }
    if (env.LOCALAPPDATA)
      candidates.push(join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", file));
  } else {
    candidates.push(
      "/opt/homebrew/bin/cloudflared",
      "/usr/local/bin/cloudflared",
      "/usr/bin/cloudflared",
    );
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** A workspace reachable from the internet, for as long as the tunnel lasts. */
export interface Tunnel {
  /** The https address anyone can reach the workspace at. */
  url: string;
  /** Ends the tunnel. Resolves once cloudflared has exited. */
  close(): Promise<void>;
  /** Called once, if the tunnel ends without being asked to. */
  onUnexpectedExit(listener: (reason: string) => void): void;
}

/** The address a quick tunnel prints once Cloudflare has handed one out. */
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** Printed once Cloudflare's edge can reach the tunnel, so the address works. */
const CONNECTED = /Registered tunnel connection/;

function launch(command: string, args: string[]): ChildProcess {
  // A script stands in for cloudflared in tests. The app's own executable
  // runs it as Node, so no separate Node install is needed.
  if (/\.[cm]?js$/.test(command)) {
    return spawn(process.execPath, [command, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** The line cloudflared gave up on, shortened to something worth showing. */
function lastComplaint(lines: string[]): string | null {
  const line = [...lines]
    .reverse()
    .find(
      (text) =>
        /\b(ERR|error|failed)\b/i.test(text) && !/Configuration file .* was empty/i.test(text),
    );
  if (!line) return null;
  const quoted = line.match(/error="([^"]+)"/)?.[1];
  const text = (quoted ?? line.replace(/^\S+\s+(ERR|INF|WRN)\s+/, "")).trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

async function gatherlineIsReachable(url: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { status?: unknown };
  return body.status === "ok";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Opens a Cloudflare quick tunnel to a port on this computer: no account and
 * nothing to configure, and a new https address each time. Resolves once the
 * address is reachable rather than when it is first printed, since Cloudflare
 * answers with an error page until a connection has registered.
 */
export function openQuickTunnel(options: {
  command: string;
  port: number;
  timeoutMs?: number;
  /** Lets a newly provisioned hostname reach DNS before the first lookup can be cached as missing. */
  dnsWarmupMs?: number;
  /** Gives up on opening, ending cloudflared, when aborted. */
  signal?: AbortSignal;
  launch?: (command: string, args: string[]) => ChildProcess;
  /** Replaced in tests; the default checks Gatherline's health endpoint through Cloudflare. */
  healthProbe?: (url: string, signal: AbortSignal) => Promise<boolean>;
}): Promise<Tunnel> {
  if (options.signal?.aborted) return Promise.reject(new Error("Opening to all was cancelled."));
  const timeoutMs = options.timeoutMs ?? 75_000;
  // An existing ~/.cloudflared/config.yml disables Quick Tunnels. Give this
  // child an isolated, harmless config so a named-tunnel setup cannot change
  // what the desktop button does.
  const configDir = mkdtempSync(join(tmpdir(), "gatherline-cloudflared-"));
  const configFile = join(configDir, "config.yml");
  writeFileSync(configFile, "no-autoupdate: true\n", { mode: 0o600 });
  let configCleaned = false;
  const cleanupConfig = () => {
    if (configCleaned) return;
    configCleaned = true;
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {
      // The operating system can clean a one-line temporary config later.
    }
  };
  let child: ChildProcess;
  try {
    child = (options.launch ?? launch)(options.command, [
      "tunnel",
      "--config",
      configFile,
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${options.port}`,
    ]);
  } catch (error) {
    cleanupConfig();
    return Promise.reject(
      new Error(`cloudflared could not be started: ${(error as Error).message}`),
    );
  }
  const lines: string[] = [];
  let url: string | null = null;
  let connected = false;
  let completed = false;
  let failing = false;
  let intentionalExit = false;
  let didExit = child.exitCode !== null || child.signalCode !== null;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  if (didExit) resolveExit();
  child.once("exit", () => {
    didExit = true;
    cleanupConfig();
    resolveExit();
  });
  child.once("error", () => {
    // A spawn failure has no process and therefore no later exit event.
    if (child.pid === undefined) {
      didExit = true;
      cleanupConfig();
      resolveExit();
    }
  });
  const exitWithin = (ms: number): Promise<boolean> => {
    if (didExit) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(didExit), ms);
      void exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };
  const lifecycle = new AbortController();
  let terminating: Promise<void> | null = null;
  const terminate = (): Promise<void> => {
    if (terminating) return terminating;
    intentionalExit = true;
    lifecycle.abort();
    const attempt = (async () => {
      if (!didExit && child.pid !== undefined) {
        try {
          child.kill();
        } catch {
          // Escalation below still gets a chance.
        }
        await exitWithin(2_000);
      }
      if (!didExit && child.pid !== undefined) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Report a process that still cannot be confirmed dead below.
        }
        await exitWithin(2_000);
      }
      cleanupConfig();
      if (!didExit && child.pid !== undefined)
        throw new Error("cloudflared did not stop after Gatherline closed the public link.");
    })();
    terminating = attempt.catch((error: unknown) => {
      terminating = null;
      throw error;
    });
    return terminating;
  };
  const listeners: ((reason: string) => void)[] = [];
  let unexpectedReason: string | null = null;

  return new Promise<Tunnel>((resolve, reject) => {
    let probeStarted = false;
    const healthProbe = options.healthProbe ?? gatherlineIsReachable;
    const onAbort = () => fail("Opening to all was cancelled.");
    const cleanupOpening = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message: string) => {
      if (completed || failing) return;
      failing = true;
      cleanupOpening();
      void terminate().then(
        () => {
          completed = true;
          reject(new Error(message));
        },
        (stopError: unknown) => {
          completed = true;
          const detail = stopError instanceof Error ? ` ${stopError.message}` : "";
          reject(new Error(`${message}${detail}`));
        },
      );
    };
    const timer = setTimeout(
      () =>
        fail(
          url
            ? "Cloudflare gave this workspace an address, but it did not become reachable. Check this computer's internet connection and try again."
            : "Cloudflare did not answer in time. Check this computer's internet connection and try again.",
        ),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    let pending = "";
    const read = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        if (lines.length > 50) lines.shift();
        url ??= line.match(QUICK_TUNNEL_URL)?.[0] ?? null;
        if (CONNECTED.test(line)) connected = true;
      }
      if (!completed && !failing && !probeStarted && url && connected) {
        probeStarted = true;
        const address = url;
        void (async () => {
          // Cloudflare documents a brief DNS warm-up for new Quick Tunnel
          // hostnames. Looking it up immediately can leave an NXDOMAIN in the
          // operating system cache after the record itself is ready.
          const warmupMs = options.dnsWarmupMs ?? (options.healthProbe ? 0 : 10_000);
          if (warmupMs > 0) await wait(warmupMs, lifecycle.signal);
          while (!completed && !failing && !lifecycle.signal.aborted) {
            try {
              if (await healthProbe(`${address}/api/health`, lifecycle.signal)) {
                if (completed || failing || lifecycle.signal.aborted) return;
                completed = true;
                cleanupOpening();
                resolve({
                  url: address,
                  close: terminate,
                  onUnexpectedExit: (listener) => {
                    if (unexpectedReason) queueMicrotask(() => listener(unexpectedReason!));
                    else listeners.push(listener);
                  },
                });
                return;
              }
            } catch {
              if (lifecycle.signal.aborted) return;
            }
            await wait(500, lifecycle.signal);
          }
        })();
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);

    child.once("error", (error) => {
      if (!intentionalExit) fail(`cloudflared could not be started: ${(error as Error).message}`);
    });
    child.once("exit", (code) => {
      if (!completed && !failing) {
        const reason = lastComplaint(lines);
        fail(
          reason
            ? `Cloudflare could not open a link: ${reason}`
            : `cloudflared stopped before opening a link (exit code ${code ?? "unknown"}).`,
        );
        return;
      }
      if (intentionalExit || failing) return;
      const reason = lastComplaint(lines) ?? `cloudflared exited (code ${code ?? "unknown"})`;
      unexpectedReason = reason;
      for (const listener of listeners.splice(0)) listener(reason);
    });
  });
}
