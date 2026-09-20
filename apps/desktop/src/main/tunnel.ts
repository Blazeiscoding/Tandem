import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

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
  // The desktop owns this connector's configuration. A shell used for a
  // different tunnel must not silently supply its token, origin, or routing.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^TUNNEL_/i.test(name)),
  );
  // A script stands in for cloudflared in tests. The app's own executable
  // runs it as Node, so no separate Node install is needed.
  if (/\.[cm]?js$/.test(command)) {
    return spawn(process.execPath, [command, ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

async function gatherlineIsReachable(
  url: string,
  signal: AbortSignal,
  instanceId?: string,
): Promise<boolean> {
  const address = new URL(url);
  address.searchParams.set("_gatherline", randomUUID());
  const response = await fetch(address, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { status?: unknown; instanceId?: unknown } | null;
  return body?.status === "ok" && (instanceId === undefined || body.instanceId === instanceId);
}

/** Validates configuration without reading the file or including its contents in errors. */
export function validateNamedTunnelConfig(
  publicUrl: unknown,
  tokenFile: unknown,
): { publicUrl: string; tokenFile: string } {
  let url: URL;
  try {
    if (typeof publicUrl !== "string" || /\s|\\/.test(publicUrl)) throw new Error();
    url = new URL(publicUrl);
    const hostname = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      isIP(hostname.replace(/^\[|\]$/g, "")) ||
      !hostname.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname) ||
      hostname.length > 253 ||
      hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      throw new Error();
  } catch {
    throw new Error("Use a public HTTPS hostname without a path, credentials, query, or fragment.");
  }
  if (
    typeof tokenFile !== "string" ||
    !tokenFile ||
    /[\x00-\x1f\x7f]/.test(tokenFile) ||
    !isAbsolute(tokenFile)
  )
    throw new Error("Choose an absolute path to the Cloudflare tunnel token file.");
  return { publicUrl: url.origin, tokenFile };
}

/**
 * The stable public address configured for this app: both settings together,
 * or what is wrong with them. A half-configured pair is an error rather than
 * a quiet fall back to a temporary address, which would publish a different
 * link than the one its owner handed out.
 */
export function readNamedTunnelConfig(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): { publicUrl: string; tokenFile: string } | { error: string } | null {
  const publicUrl = env.GATHERLINE_TUNNEL_URL ?? env.SLACKOSS_TUNNEL_URL;
  const tokenFile = env.GATHERLINE_TUNNEL_TOKEN_FILE ?? env.SLACKOSS_TUNNEL_TOKEN_FILE;
  if (!publicUrl && !tokenFile) return null;
  try {
    if (!publicUrl || !tokenFile)
      throw new Error(
        "Set both GATHERLINE_TUNNEL_URL and GATHERLINE_TUNNEL_TOKEN_FILE to publish a stable address.",
      );
    const config = validateNamedTunnelConfig(publicUrl, tokenFile);
    // The file is never read here. Only its presence is checked, so a missing
    // one is corrected before opening rather than reported as a tunnel failure.
    if (!exists(config.tokenFile))
      throw new Error(
        "The Cloudflare tunnel token file is not where GATHERLINE_TUNNEL_TOKEN_FILE points.",
      );
    return config;
  } catch (error) {
    return { error: (error as Error).message };
  }
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
interface TunnelOptions {
  command: string;
  port: number;
  timeoutMs?: number;
  /** Lets a newly provisioned hostname reach DNS before the first lookup can be cached as missing. */
  dnsWarmupMs?: number;
  /** Gives up on opening, ending cloudflared, when aborted. */
  signal?: AbortSignal;
  /** Confirms that the public hostname reaches this running server, not another workspace. */
  instanceId?: string;
  launch?: (command: string, args: string[]) => ChildProcess;
  /** Replaced in tests; the default checks Gatherline's health endpoint through Cloudflare. */
  healthProbe?: (url: string, signal: AbortSignal, instanceId?: string) => Promise<boolean>;
}

export function openQuickTunnel(options: TunnelOptions): Promise<Tunnel> {
  return openTunnel(options);
}

/** Connects an existing, remotely managed tunnel without handling its token contents. */
export async function openNamedTunnel(
  options: TunnelOptions & { publicUrl: string; tokenFile: string; instanceId: string },
): Promise<Tunnel> {
  const config = validateNamedTunnelConfig(options.publicUrl, options.tokenFile);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error("The hosted workspace must have a valid listening port.");
  if (
    typeof options.instanceId !== "string" ||
    !options.instanceId ||
    options.instanceId.length > 200 ||
    /\s|\p{Cc}/u.test(options.instanceId)
  )
    throw new Error("The hosted workspace cannot verify its public address. Restart hosting.");
  return openTunnel(options, config);
}

function openTunnel(
  options: TunnelOptions,
  named?: { publicUrl: string; tokenFile: string },
): Promise<Tunnel> {
  if (options.signal?.aborted) return Promise.reject(new Error("Opening to all was cancelled."));
  const timeoutMs = options.timeoutMs ?? 75_000;
  const namedFailure =
    "Cloudflare could not connect the saved tunnel. Check its token file, your internet connection, and that cloudflared is version 2025.4.0 or later.";
  // An existing ~/.cloudflared/config.yml disables Quick Tunnels. Give this
  // child an isolated, harmless config so a named-tunnel setup cannot change
  // what the desktop button does.
  let configDir: string;
  try {
    configDir = mkdtempSync(join(tmpdir(), "gatherline-cloudflared-"));
  } catch {
    return Promise.reject(new Error("Could not create a temporary Cloudflare configuration."));
  }
  const configFile = join(configDir, "config.yml");
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
  try {
    writeFileSync(configFile, "no-autoupdate: true\n", { mode: 0o600 });
  } catch {
    cleanupConfig();
    return Promise.reject(new Error("Could not write the temporary Cloudflare configuration."));
  }
  let child: ChildProcess;
  try {
    child = (options.launch ?? launch)(options.command, [
      "tunnel",
      "--config",
      configFile,
      "--no-autoupdate",
      ...(named
        ? ["run", "--token-file", named.tokenFile]
        : ["--url", `http://127.0.0.1:${options.port}`]),
    ]);
  } catch (error) {
    cleanupConfig();
    return Promise.reject(
      new Error(
        named ? namedFailure : `cloudflared could not be started: ${(error as Error).message}`,
      ),
    );
  }
  const lines: string[] = [];
  let url: string | null = named?.publicUrl ?? null;
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
          named
            ? `The saved Cloudflare address did not reach this workspace. In Cloudflare, point its published application route to http://127.0.0.1:${options.port}, then try again.`
            : url
              ? "Cloudflare gave this workspace an address, but it did not become reachable. Check this computer's internet connection and try again."
              : "Cloudflare did not answer in time. Check this computer's internet connection and try again.",
        ),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const readLines = (parts: string[]) => {
      for (const line of parts) {
        // A connector can include credential contents in an error. Named
        // tunnels never retain raw output for diagnostics or expose it to UI.
        if (!named) {
          lines.push(line);
          if (lines.length > 50) lines.shift();
          url ??= line.match(QUICK_TUNNEL_URL)?.[0] ?? null;
        }
        if (CONNECTED.test(line)) connected = true;
      }
      if (!completed && !failing && !probeStarted && url && connected) {
        probeStarted = true;
        const address = url;
        void (async () => {
          // Cloudflare documents a brief DNS warm-up for new Quick Tunnel
          // hostnames. Looking it up immediately can leave an NXDOMAIN in the
          // operating system cache after the record itself is ready.
          const warmupMs = options.dnsWarmupMs ?? (named || options.healthProbe ? 0 : 10_000);
          if (warmupMs > 0) await wait(warmupMs, lifecycle.signal);
          while (!completed && !failing && !lifecycle.signal.aborted) {
            try {
              if (
                await healthProbe(`${address}/api/health`, lifecycle.signal, options.instanceId)
              ) {
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
    const reader = () => {
      let pending = "";
      return (chunk: Buffer) => {
        const parts = (pending + chunk.toString("utf8")).split(/\r?\n/);
        pending = (parts.pop() ?? "").slice(-16_384);
        readLines(parts);
      };
    };
    child.stdout?.on("data", reader());
    child.stderr?.on("data", reader());

    child.once("error", (error) => {
      if (!intentionalExit)
        fail(
          named ? namedFailure : `cloudflared could not be started: ${(error as Error).message}`,
        );
    });
    child.once("exit", (code) => {
      if (!completed && !failing) {
        const reason = lastComplaint(lines);
        fail(
          named
            ? namedFailure
            : reason
              ? `Cloudflare could not open a link: ${reason}`
              : `cloudflared stopped before opening a link (exit code ${code ?? "unknown"}).`,
        );
        return;
      }
      if (intentionalExit || failing) return;
      const reason = named
        ? "The saved Cloudflare tunnel connector stopped. Check its token file and reconnect."
        : (lastComplaint(lines) ?? `cloudflared exited (code ${code ?? "unknown"})`);
      unexpectedReason = reason;
      for (const listener of listeners.splice(0)) listener(reason);
    });
  });
}
