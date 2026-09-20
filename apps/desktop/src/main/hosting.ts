import { join } from "node:path";
import type { Tunnel } from "./tunnel.js";

export interface HostingSnapshot {
  running: boolean;
  phase: "stopped" | "starting" | "running" | "stopping";
  workspaceName?: string;
  port?: number;
  dataDir?: string;
  lanUrls?: string[];
  warning?: string;
  /** Reachable from anywhere through a tunnel, for as long as it lasts. */
  openToAll?: { phase: "opening" } | { phase: "open"; url: string };
  /** Why opening to all failed or ended, until it is tried again. */
  openToAllError?: string;
  /** Whether this computer has what opening to all needs. */
  tunnelAvailable?: boolean;
  /** A configured address that stays the same each time the link is opened. */
  publicAddress?: string;
  /** What the public address setting holds, valid or not, for editing. */
  publicAddressSetting?: string;
  /** Whether the environment set the address, so this app cannot change it. */
  publicAddressLocked?: boolean;
  /** Whether Gatherline runs the connector, rather than something else. */
  publicAddressManaged?: boolean;
  /** Why a configured stable address cannot be used, and what to correct. */
  publicAddressError?: string;
  /** Whether an account after the first needs an invite code. */
  inviteOnly?: boolean;
}

/**
 * Calls through a tunnel still go directly between people, so each side has
 * to find its public address. Cloudflare already carries the tunnel, so its
 * STUN server adds nobody new.
 */
export const OPEN_TO_ALL_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** What this computer hosted last, as remembered in its settings. */
export interface LastHosted {
  workspaceName: string;
  port: number;
}

/**
 * Reads the remembered workspace back, refusing anything malformed rather
 * than starting hosting under a name or port nobody chose. A settings file
 * edited by hand, or written by a newer app, must not become a surprise
 * workspace.
 */
export function parseLastHosted(value: unknown): LastHosted | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { workspaceName, port } = value as Record<string, unknown>;
  if (
    typeof workspaceName !== "string" ||
    !workspaceName.trim() ||
    workspaceName.trim().length > 80
  )
    return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { workspaceName: workspaceName.trim(), port };
}

interface HostedServer {
  port: number;
  /** Identifies this run, so a public address can be confirmed to reach it. */
  instanceId?: string;
  stop(): Promise<void>;
  /** How the running server is reached and joined; see `WorkspaceServer`. */
  setPublicUrl?(url: string | null): void;
  setTrustLoopbackProxy?(enabled: boolean): void;
  setIceServers?(servers: { urls: string }[]): void;
  inviteOnly?(): boolean;
  setInviteOnly?(inviteOnly: boolean): void;
  /** How many accounts exist, so opening to all can wait for the owner's. */
  accountCount?(): number;
}

interface HostingOptions {
  startServer(options: {
    workspaceName: string;
    port: number;
    dataDir: string;
  }): Promise<HostedServer>;
  saveLastHosted(options: { workspaceName: string; port: number }): Promise<void>;
  dataRoot: string;
  defaultPort: number;
  lanUrls(port: number): string[];
  onChange?(): void;
  /** Opens a tunnel to a port on this computer. Absent where there is none to open. */
  openTunnel?(port: number, signal: AbortSignal, instanceId?: string): Promise<Tunnel>;
  /** Whether a tunnel could be opened now. */
  tunnelAvailable?(): boolean;
  /**
   * The stable public address configured for this computer: what the setting
   * holds, the address that passed validation, who carries it, and what is
   * wrong with it. Absent where only temporary addresses are available.
   */
  publicAddress?(): {
    setting?: string;
    locked?: boolean;
    url?: string;
    managed?: boolean;
    error?: string;
  };
}

function startOptions(value: unknown): { workspaceName: string; port?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a workspace name before starting hosting.");
  const { workspaceName, port } = value as Record<string, unknown>;
  if (
    typeof workspaceName !== "string" ||
    !workspaceName.trim() ||
    workspaceName.trim().length > 80 ||
    /\p{Cc}/u.test(workspaceName)
  )
    throw new Error("Use a workspace name of 1 to 80 characters without control characters.");
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
  )
    throw new Error("The hosting port must be a whole number from 0 to 65535.");
  return { workspaceName: workspaceName.trim(), port: port as number | undefined };
}

/** Owns the embedded server, including operations accepted just before app shutdown. */
export function createHostingController(options: HostingOptions) {
  let server: HostedServer | null = null;
  let workspace: { workspaceName: string; dataDir: string } | null = null;
  let phase: HostingSnapshot["phase"] = "stopped";
  let warning: string | undefined;
  let metadataDirty = false;
  let stopFailed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let tunnel: Tunnel | null = null;
  /** Set while a tunnel is opening, so stopping or quitting need not wait for it. */
  let opening: AbortController | null = null;
  let openError: string | undefined;
  /** Invalidates public-open requests that were queued before a close or stop. */
  let publicRequest = 0;

  function changed(): void {
    // A renderer/tray notification must never lose ownership of a live server.
    try {
      options.onChange?.();
    } catch {
      // The next snapshot still reports the actual state.
    }
  }

  /**
   * Read for each snapshot, so correcting the configuration takes effect
   * without a restart. Configuration that cannot be read at all leaves the
   * temporary address available rather than failing the status call.
   */
  function publicAddress(): NonNullable<ReturnType<NonNullable<HostingOptions["publicAddress"]>>> {
    try {
      return options.publicAddress?.() ?? {};
    } catch {
      return {};
    }
  }

  function status(): HostingSnapshot {
    const address = publicAddress();
    return {
      running: server !== null,
      phase,
      ...(workspace ?? {}),
      ...(server ? { port: server.port, lanUrls: options.lanUrls(server.port) } : {}),
      ...(server?.inviteOnly ? { inviteOnly: server.inviteOnly() } : {}),
      ...(opening
        ? { openToAll: { phase: "opening" as const } }
        : tunnel
          ? { openToAll: { phase: "open" as const, url: tunnel.url } }
          : {}),
      ...(openError ? { openToAllError: openError } : {}),
      ...(options.tunnelAvailable ? { tunnelAvailable: options.tunnelAvailable() } : {}),
      ...(address.url ? { publicAddress: address.url } : {}),
      ...(address.setting ? { publicAddressSetting: address.setting } : {}),
      ...(address.locked ? { publicAddressLocked: true } : {}),
      ...(address.managed ? { publicAddressManaged: true } : {}),
      ...(address.error ? { publicAddressError: address.error } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  /** Back to reachable only on this network: no public address, no STUN. */
  function closeReach(target: HostedServer): void {
    for (const clear of [
      () => target.setTrustLoopbackProxy?.(false),
      () => target.setPublicUrl?.(null),
      () => target.setIceServers?.([]),
    ]) {
      try {
        clear();
      } catch {
        // Keep clearing the other public state even if an implementation fails.
      }
    }
  }

  async function endTunnel(): Promise<void> {
    const current = tunnel;
    if (!current) return;
    // Remove the public address from new links before asking the connector to
    // drain. Keep its handle/status until exit is confirmed so closing can be
    // retried if the child process refuses to stop.
    if (server) closeReach(server);
    await current.close();
    if (tunnel === current) tunnel = null;
  }

  function cancelPublicOpen(): void {
    publicRequest += 1;
    opening?.abort();
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.catch(() => {}).then(operation);
    pending = next;
    return next;
  }

  async function saveMetadata(): Promise<void> {
    if (!server || !workspace) return;
    try {
      await options.saveLastHosted({ workspaceName: workspace.workspaceName, port: server.port });
      metadataDirty = false;
      if (!stopFailed) warning = undefined;
    } catch {
      metadataDirty = true;
      if (!stopFailed)
        warning =
          "The workspace is running, but its last-used hosting settings could not be saved.";
    }
    changed();
  }

  function start(value: unknown): Promise<HostingSnapshot> {
    if (closing) return Promise.reject(new Error("The app is quitting. Hosting cannot start."));
    let requested: ReturnType<typeof startOptions>;
    try {
      requested = startOptions(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return serialized(async () => {
      if (server) {
        if (stopFailed) throw new Error("Finish stopping the workspace before starting it again.");
        if (workspace?.workspaceName !== requested.workspaceName)
          throw new Error(
            "Another workspace is already running. Stop it before starting this one.",
          );
        if (requested.port !== undefined && requested.port !== 0 && requested.port !== server.port)
          throw new Error(
            "This workspace is already running on another port. Stop it before changing ports.",
          );
        if (metadataDirty) await saveMetadata();
        return status();
      }

      // Keep existing data folders exactly where earlier desktop builds put them.
      const slug =
        requested.workspaceName
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")
          .replaceAll(/^-|-$/g, "") || "workspace";
      workspace = {
        workspaceName: requested.workspaceName,
        dataDir: join(options.dataRoot, slug),
      };
      phase = "starting";
      warning = undefined;
      changed();
      try {
        try {
          server = await options.startServer({
            ...workspace,
            port: requested.port ?? options.defaultPort,
          });
        } catch (error) {
          // Only the automatic port choice may change behind the user's back.
          if (
            requested.port !== undefined ||
            (error as NodeJS.ErrnoException)?.code !== "EADDRINUSE"
          )
            throw error;
          server = await options.startServer({ ...workspace, port: 0 });
        }
      } catch (error) {
        // The caller reports the failure. A lasting warning would repeat it, and
        // would still be showing long after the next attempt was made elsewhere.
        phase = "stopped";
        workspace = null;
        changed();
        throw error;
      }
      phase = "running";
      changed();
      // Binding succeeded. A settings failure is a warning, never a failed start.
      await saveMetadata();
      return status();
    });
  }

  async function stopCurrent(): Promise<void> {
    if (!server) return;
    phase = "stopping";
    changed();
    // A link to a server that is gone would only show Cloudflare's error page.
    try {
      await endTunnel();
    } catch (error) {
      phase = "running";
      warning = "The public link could not finish closing. Try stopping the workspace again.";
      changed();
      throw error;
    }
    openError = undefined;
    try {
      await server.stop();
    } catch (error) {
      phase = "running";
      stopFailed = true;
      warning =
        "The workspace could not finish stopping. Use Quit Gatherline to review recovery options.";
      changed();
      throw error;
    }
    server = null;
    workspace = null;
    phase = "stopped";
    warning = undefined;
    metadataDirty = false;
    stopFailed = false;
    changed();
  }

  function stop(): Promise<void> {
    cancelPublicOpen();
    return serialized(stopCurrent);
  }

  /**
   * Opens the running workspace to all: a tunnel gives it an https address
   * anyone can reach, links are built on that address, and calls look for a
   * route across networks. Joining keeps its rule unless `inviteOnly` is given.
   */
  function openToAll(value: unknown = {}): Promise<HostingSnapshot> {
    if (closing) return Promise.reject(new Error("The app is quitting."));
    const inviteOnly =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { inviteOnly?: unknown }).inviteOnly
        : undefined;
    if (inviteOnly !== undefined && typeof inviteOnly !== "boolean")
      return Promise.reject(
        new Error("Say whether joining needs an invite code with true or false."),
      );
    const request = publicRequest;
    return serialized(async () => {
      if (closing || request !== publicRequest) throw new Error("Opening to all was cancelled.");
      const target = server;
      if (!target || phase !== "running")
        throw new Error("Start hosting the workspace before opening it to all.");
      if (stopFailed)
        throw new Error("Finish stopping the workspace before changing its public access.");
      if (!options.openTunnel) throw new Error("Opening to all is not available in this app.");
      // A configured stable address that cannot be used has to be corrected.
      // Falling back would publish a temporary link nobody was given. An
      // already open link keeps working, so its policy can still be changed.
      const configured = publicAddress();
      if (!tunnel && configured.error) throw new Error(configured.error);
      if (
        !target.setPublicUrl ||
        !target.setIceServers ||
        !target.inviteOnly ||
        !target.setInviteOnly
      )
        throw new Error("This hosted workspace cannot change its public access settings.");
      // Through a tunnel nothing counts as this computer's own, so the owner
      // would need the claim code to create their account. Theirs comes first.
      if (target.accountCount && target.accountCount() === 0)
        throw new Error("Create your own account in the workspace first, then open it to all.");
      const previousInviteOnly = target.inviteOnly();
      const requestedInviteOnly = inviteOnly ?? true;
      openError = undefined;
      target.setInviteOnly(requestedInviteOnly);
      if (tunnel) {
        changed();
        return status();
      }
      const attempt = new AbortController();
      opening = attempt;
      openError = undefined;
      changed();
      let opened: Tunnel;
      try {
        opened = await options.openTunnel(target.port, attempt.signal, target.instanceId);
      } catch (error) {
        try {
          target.setInviteOnly(previousInviteOnly);
        } catch {
          // The original opening error remains the useful one to report.
        }
        // Called off by stopping, quitting or turning it off: nothing failed.
        if (!attempt.signal.aborted)
          openError = error instanceof Error ? error.message : String(error);
        if (opening === attempt) opening = null;
        changed();
        throw error;
      }
      if (opening === attempt) opening = null;
      if (attempt.signal.aborted || request !== publicRequest || closing) {
        try {
          target.setInviteOnly(previousInviteOnly);
        } catch {
          // Closing the newly opened connector still removes public access.
        }
        await opened.close().catch(() => {});
        changed();
        throw new Error("Opening to all was cancelled.");
      }
      try {
        target.setTrustLoopbackProxy?.(true);
        target.setPublicUrl(opened.url);
        target.setIceServers(OPEN_TO_ALL_ICE_SERVERS);
      } catch (error) {
        closeReach(target);
        try {
          target.setInviteOnly(previousInviteOnly);
        } catch {
          // The public connector is still closed below.
        }
        await opened.close().catch(() => {});
        openError = "The workspace could not take its public address. Try opening it to all again.";
        changed();
        throw error;
      }
      tunnel = opened;
      opened.onUnexpectedExit((reason) => {
        if (tunnel !== opened) return;
        tunnel = null;
        closeReach(target);
        openError = `The public link stopped working (${reason}). Open to all again for a new link.`;
        changed();
      });
      changed();
      return status();
    });
  }

  /** Back to this network only. Links go back to its addresses. */
  function endOpenToAll(): Promise<HostingSnapshot> {
    cancelPublicOpen();
    return serialized(async () => {
      openError = undefined;
      try {
        await endTunnel();
      } catch (error) {
        openError = "The public link could not finish closing. Try closing it again.";
        changed();
        throw error;
      }
      changed();
      return status();
    });
  }

  function setInviteOnly(value: unknown): Promise<HostingSnapshot> {
    if (typeof value !== "boolean")
      return Promise.reject(
        new Error("Say whether joining needs an invite code with true or false."),
      );
    return serialized(async () => {
      if (!server?.setInviteOnly || phase !== "running")
        throw new Error("Start hosting the workspace before changing who can join.");
      if (stopFailed)
        throw new Error("Finish stopping the workspace before changing who can join.");
      server.setInviteOnly(value);
      changed();
      return status();
    });
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    // Set before joining the queue: later IPC starts cannot outrun a pending quit.
    closing = true;
    cancelPublicOpen();
    shutdownPromise = serialized(stopCurrent).catch((error: unknown) => {
      // The caller can cancel quitting and retry with the same owned server.
      closing = false;
      shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  }

  return { status, start, stop, shutdown, openToAll, endOpenToAll, setInviteOnly };
}
