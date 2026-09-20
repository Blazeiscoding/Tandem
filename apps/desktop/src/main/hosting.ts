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
  /** Published at a public address, for as long as this app is using it. */
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
  /** Persists an address the host supplied, after the controller makes the change safe. */
  savePublicAddress?(address: string | null): Promise<void>;
  /**
   * Whether `http://127.0.0.1:<port>` answers as this run. Windows lets a
   * wildcard bind succeed beside an existing loopback one, so holding the
   * port does not prove the port reaches us. Absent where nothing can check.
   */
  verifyLoopback?(port: number, instanceId?: string): Promise<boolean>;
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
  /**
   * Kept apart from `warning`, which saving settings clears on its next
   * success. Where this run is listening is true until it stops.
   */
  let portWarning: string | undefined;
  let metadataDirty = false;
  let stopFailed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let tunnel: Tunnel | null = null;
  /** The current address is carried by a process outside this app's control. */
  let externalCarrier = false;
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
      ...(portWarning || warning
        ? { warning: [portWarning, warning].filter(Boolean).join(" ") }
        : {}),
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
    if (server) {
      closeReach(server);
      // Stopping our use of an external route cannot stop that route. Keep it
      // from becoming an open-registration endpoint if it is still running.
      if (externalCarrier) server.setInviteOnly?.(true);
    }
    await current.close();
    if (tunnel === current) {
      tunnel = null;
      externalCarrier = false;
    }
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

  /**
   * Whether loopback leads somewhere other than this run. Only a clear "no"
   * counts: a probe that cannot be made, throws, or is slow says nothing
   * about who owns the port, and a false alarm here would be worse than
   * silence.
   */
  async function loopbackTaken(target: HostedServer): Promise<boolean> {
    if (!options.verifyLoopback) return false;
    try {
      return !(await options.verifyLoopback(target.port, target.instanceId));
    } catch {
      return false;
    }
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
      portWarning = undefined;
      changed();
      let movedFrom: number | undefined;
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
          // Whatever holds the usual port is still answering there. Anything
          // aimed at it now reaches that program instead of this workspace.
          movedFrom = options.defaultPort;
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
      // A carrier forwards to one port and keeps forwarding there. Say so
      // while it can still be corrected, rather than letting Open to all
      // fail later with only "did not answer as this workspace".
      if (movedFrom !== undefined) {
        const configured = publicAddress().url;
        portWarning = configured
          ? `Port ${movedFrom} was already in use, so this workspace is on ${server.port}. Point ${configured} at http://127.0.0.1:${server.port}, or it will reach whatever is using ${movedFrom}.`
          : `Port ${movedFrom} was already in use, so this workspace is on ${server.port}. Links that name ${movedFrom} will not reach it.`;
      } else if (await loopbackTaken(server)) {
        portWarning =
          `Another program is answering on http://127.0.0.1:${server.port}, so anything sent there reaches it and not this workspace. ` +
          `Stop that program and start hosting again, or host on a different port. Teammates on this network can still use ${options.lanUrls(server.port)[0] ?? "this computer's network address"}.`;
      }
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
    portWarning = undefined;
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
      const carriedElsewhere = !!configured.url && !configured.managed;
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
      const closedInviteOnly = carriedElsewhere ? true : previousInviteOnly;
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
          target.setInviteOnly(closedInviteOnly);
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
          target.setInviteOnly(closedInviteOnly);
        } catch {
          // Closing the newly opened connector still removes public access.
        }
        await opened.close().catch(() => {});
        changed();
        throw new Error("Opening to all was cancelled.");
      }
      try {
        // Only a connector Gatherline starts is known to replace Cloudflare's
        // client-address header. A generic local proxy may pass a forged one.
        if (!carriedElsewhere) target.setTrustLoopbackProxy?.(true);
        target.setPublicUrl(opened.url);
        target.setIceServers(OPEN_TO_ALL_ICE_SERVERS);
      } catch (error) {
        closeReach(target);
        try {
          target.setInviteOnly(closedInviteOnly);
        } catch {
          // The public connector is still closed below.
        }
        await opened.close().catch(() => {});
        openError = "The workspace could not take its public address. Try opening it to all again.";
        changed();
        throw error;
      }
      tunnel = opened;
      externalCarrier = carriedElsewhere;
      opened.onUnexpectedExit((reason) => {
        if (tunnel !== opened) return;
        tunnel = null;
        const wasExternal = externalCarrier;
        externalCarrier = false;
        closeReach(target);
        if (wasExternal) target.setInviteOnly?.(true);
        openError = configured.url
          ? `The public link stopped working (${reason}). Fix its connection, then open to all again at the same address.`
          : `The public link stopped working (${reason}). Open to all again for a new link.`;
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

  /**
   * Changes the saved external address in the same queue as opening it. An
   * external carrier may already be live, so registration is secured before
   * persistence and remains secured if saving fails.
   */
  function setPublicAddress(value: string | null): Promise<HostingSnapshot> {
    if (!options.savePublicAddress)
      return Promise.reject(new Error("Saving a public address is not available in this app."));
    return serialized(async () => {
      if (closing) throw new Error("The app is quitting.");
      if (tunnel || opening)
        throw new Error("Stop using the current public address before changing it.");
      if (server && phase === "running") server.setInviteOnly?.(true);
      await options.savePublicAddress!(value);
      openError = undefined;
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

  return {
    status,
    start,
    stop,
    shutdown,
    openToAll,
    endOpenToAll,
    setInviteOnly,
    setPublicAddress,
  };
}
