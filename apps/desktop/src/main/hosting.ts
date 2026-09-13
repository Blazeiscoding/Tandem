import { join } from "node:path";

export interface HostingSnapshot {
  running: boolean;
  phase: "stopped" | "starting" | "running" | "stopping";
  workspaceName?: string;
  port?: number;
  dataDir?: string;
  lanUrls?: string[];
  warning?: string;
}

interface HostedServer {
  port: number;
  stop(): Promise<void>;
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

  function changed(): void {
    // A renderer/tray notification must never lose ownership of a live server.
    try {
      options.onChange?.();
    } catch {
      // The next snapshot still reports the actual state.
    }
  }

  function status(): HostingSnapshot {
    return {
      running: server !== null,
      phase,
      ...(workspace ?? {}),
      ...(server ? { port: server.port, lanUrls: options.lanUrls(server.port) } : {}),
      ...(warning ? { warning } : {}),
    };
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
    return serialized(stopCurrent);
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    // Set before joining the queue: later IPC starts cannot outrun a pending quit.
    closing = true;
    shutdownPromise = serialized(stopCurrent).catch((error: unknown) => {
      // The caller can cancel quitting and retry with the same owned server.
      closing = false;
      shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  }

  return { status, start, stop, shutdown };
}
