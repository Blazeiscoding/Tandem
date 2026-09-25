import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Tunnel } from "./tunnel.js";
import {
  REGISTRY_KEY,
  adoptFolders,
  legacyFolder,
  newFolder,
  parseRegistry,
  readWorkspace,
  serializeRegistry,
  type HostedWorkspace,
} from "./registry.js";

export interface HostingSnapshot {
  running: boolean;
  phase: "stopped" | "starting" | "running" | "stopping";
  workspaceName?: string;
  /** The running workspace's entry in the list of hosted workspaces. */
  folder?: string;
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

/**
 * What earlier versions remembered as hosted last, and what this one still
 * writes for them. They reopen by name, so it names a workspace only when an
 * earlier version would find that workspace's folder from it.
 */
export interface LastHosted {
  workspaceName: string;
  port: number;
}

/** One entry in the list of workspaces hosted on this computer, as the window sees it. */
export interface HostedWorkspaceSummary {
  folder: string;
  name: string;
  port: number;
  lastHostedAt: number;
  /** When a backup of it last finished, or null if none has here. */
  lastBackupAt: number | null;
  running: boolean;
  /** Its folder is gone, so it cannot start. */
  missing: boolean;
}

/**
 * Reads an earlier version's remembered workspace, refusing anything
 * malformed rather than starting hosting under a name or port nobody chose.
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
  /** The identity the server keeps in its database, recorded in the registry. */
  workspaceId?(): string | null;
  /** The name the server keeps, which may differ from a name typed before. */
  workspaceName?(): string;
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
  /** `workspaceName` is given for a new workspace only; an existing one keeps its own. */
  startServer(options: {
    workspaceName?: string;
    port: number;
    dataDir: string;
  }): Promise<HostedServer>;
  /** Where the list of hosted workspaces is kept. `strict` reads throw when the file is unreadable. */
  settings: {
    get(key: string, options?: { strict?: boolean }): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** Reads a workspace's identity from its folder without starting it. */
  readWorkspace?: typeof readWorkspace;
  /** The server's verified backup: a consistent copy of the database and every attachment. */
  backupWorkspace?(options: { dataDir: string; out: string }): Promise<{ files: unknown[] }>;
  /** Bytes free on the disk holding `dir`. */
  freeBytes?(dir: string): Promise<number>;
  now?: () => number;
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

type StartRequest = ({ workspaceName: string } | { folder: string }) & { port?: number };

/**
 * `{ folder }` starts a workspace already in the list. `{ workspaceName }`
 * always makes a new one: nothing is ever found by its name.
 */
function startOptions(value: unknown): StartRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a workspace name before starting hosting.");
  const { workspaceName, folder, port } = value as Record<string, unknown>;
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
  )
    throw new Error("The hosting port must be a whole number from 0 to 65535.");
  if (folder !== undefined) {
    if (typeof folder !== "string" || workspaceName !== undefined)
      throw new Error("Choose one workspace to start.");
    return { folder, port: port as number | undefined };
  }
  if (
    typeof workspaceName !== "string" ||
    !workspaceName.trim() ||
    workspaceName.trim().length > 80 ||
    /\p{Cc}/u.test(workspaceName)
  )
    throw new Error("Use a workspace name of 1 to 80 characters without control characters.");
  return { workspaceName: workspaceName.trim(), port: port as number | undefined };
}

/** Everything under a folder, counted by size. Files that vanish while counting are skipped. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else if (entry.isFile())
      total += await stat(path).then(
        (info) => info.size,
        () => 0,
      );
  }
  return total;
}

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** Owns the embedded server, including operations accepted just before app shutdown. */
export function createHostingController(options: HostingOptions) {
  let server: HostedServer | null = null;
  let workspace: { workspaceName: string; folder: string; dataDir: string } | null = null;
  let phase: HostingSnapshot["phase"] = "stopped";
  const now = options.now ?? Date.now;
  const read = options.readWorkspace ?? readWorkspace;
  /** Every workspace hosted here, once read. Null until then, or while it cannot be. */
  let registry: HostedWorkspace[] | null = null;
  let registryLoad: Promise<HostedWorkspace[]> | null = null;
  /** Folders adoption could not read, named until the registry is read again. */
  let unreadableFolders: string[] = [];
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

  /**
   * Reads the list of hosted workspaces once, adopting any folder it does not
   * name. Nothing can start before this finishes, so adoption never opens a
   * database a running server has open. A settings file that cannot be read
   * is not taken as an empty list, and is tried again next time.
   */
  function loadRegistry(): Promise<HostedWorkspace[]> {
    if (registry) return Promise.resolve(registry);
    registryLoad ??= (async () => {
      const stored = await options.settings.get(REGISTRY_KEY, { strict: true });
      const known = parseRegistry(stored);
      // Only the first start of this version converts what earlier ones kept.
      const legacy =
        stored === null
          ? parseLastHosted(await options.settings.get("lastHosted").catch(() => null))
          : null;
      const { adopted, unreadable } = await adoptFolders({
        dataRoot: options.dataRoot,
        known,
        lastHosted: legacy,
        defaultPort: options.defaultPort,
        now: now(),
        read,
      });
      unreadableFolders = unreadable;
      registry = [...known, ...adopted];
      // Kept in memory if this fails, and written with the next change.
      if (adopted.length > 0) await saveRegistry().catch(() => {});
      return registry;
    })().finally(() => {
      registryLoad = null;
    });
    return registryLoad;
  }

  function saveRegistry(): Promise<void> {
    return options.settings.set(REGISTRY_KEY, serializeRegistry(registry ?? []));
  }

  function updateEntry(folder: string, change: Partial<HostedWorkspace>): void {
    registry = (registry ?? []).map((entry) =>
      entry.folder === folder ? { ...entry, ...change } : entry,
    );
  }

  async function saveMetadata(): Promise<void> {
    if (!server || !workspace) return;
    try {
      await saveRegistry();
      const entry = registry?.find((e) => e.folder === workspace!.folder);
      // Earlier versions find a folder from its name. Name one to them only
      // when that leads to this workspace, never to a different one.
      await options.settings.set(
        "lastHosted",
        entry && entry.folder === legacyFolder(entry.name)
          ? { workspaceName: entry.name, port: entry.port }
          : null,
      );
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
        const same =
          "folder" in requested
            ? requested.folder === workspace?.folder
            : requested.workspaceName === workspace?.workspaceName;
        if (!same)
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

      let list: HostedWorkspace[];
      try {
        list = await loadRegistry();
      } catch {
        throw new Error(
          "Gatherline could not read its list of hosted workspaces, so it will not start one. Check that its settings file can be read, then try again.",
        );
      }
      let entry: HostedWorkspace;
      const created = !("folder" in requested);
      if ("folder" in requested) {
        const found = list.find((e) => e.folder === requested.folder);
        if (!found) throw new Error("That workspace is not in the list hosted on this computer.");
        const dataDir = join(options.dataRoot, found.folder);
        // Never recreated empty: an empty folder would look like the workspace.
        if (!existsSync(dataDir))
          throw new Error(`The folder that held ${found.name} is missing, so it cannot start.`);
        if (found.id) {
          const inside = read(dataDir);
          if (!inside)
            throw new Error(
              `${found.name}'s database is missing or unreadable, so it cannot start.`,
            );
          // A folder copied or swapped by hand holds some other workspace.
          if (inside.id !== found.id)
            throw new Error(
              `The folder for ${found.name} holds a different workspace, so it will not start.`,
            );
        }
        entry = found;
      } else {
        // A new folder that has nothing to do with the name. It is listed
        // before the server starts in it, so the app can always find it again.
        entry = {
          id: null,
          folder: newFolder(),
          name: requested.workspaceName,
          port: requested.port ?? options.defaultPort,
          lastHostedAt: now(),
        };
        const dataDir = join(options.dataRoot, entry.folder);
        await mkdir(options.dataRoot, { recursive: true });
        await mkdir(dataDir);
        registry = [...list, entry];
        try {
          await saveRegistry();
        } catch {
          registry = list;
          await rm(dataDir, { recursive: true, force: true }).catch(() => {});
          throw new Error(
            "Gatherline could not add the workspace to its settings, so it did not create it. Check that its settings folder is writable, then try again.",
          );
        }
      }
      workspace = {
        workspaceName: entry.name,
        folder: entry.folder,
        dataDir: join(options.dataRoot, entry.folder),
      };
      const preferred = requested.port ?? (created ? options.defaultPort : entry.port);
      const serverOptions = {
        dataDir: workspace.dataDir,
        // An existing workspace keeps the name it has; only a new one is given one.
        ...(created ? { workspaceName: entry.name } : {}),
      };
      phase = "starting";
      warning = undefined;
      portWarning = undefined;
      changed();
      let movedFrom: number | undefined;
      try {
        try {
          server = await options.startServer({ ...serverOptions, port: preferred });
        } catch (error) {
          // Only the automatic port choice may change behind the user's back.
          if (
            requested.port !== undefined ||
            (error as NodeJS.ErrnoException)?.code !== "EADDRINUSE"
          )
            throw error;
          server = await options.startServer({ ...serverOptions, port: 0 });
          // Whatever holds the usual port is still answering there. Anything
          // aimed at it now reaches that program instead of this workspace.
          movedFrom = preferred;
        }
      } catch (error) {
        // The caller reports the failure. A lasting warning would repeat it, and
        // would still be showing long after the next attempt was made elsewhere.
        phase = "stopped";
        workspace = null;
        // A new workspace that never started holds nothing. Take it back out,
        // so trying again does not leave empty workspaces in the list.
        if (created) {
          registry = list;
          await saveRegistry()
            .then(() => rm(join(options.dataRoot, entry.folder), { recursive: true, force: true }))
            .catch(() => {});
        }
        changed();
        throw error;
      }
      updateEntry(entry.folder, {
        id: server.workspaceId?.() ?? entry.id,
        name: server.workspaceName?.() ?? entry.name,
        port: server.port,
        lastHostedAt: now(),
      });
      workspace.workspaceName = server.workspaceName?.() ?? entry.name;
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

  /** Every workspace hosted here, most recent first, and the folders that could not be read. */
  async function list(): Promise<{ workspaces: HostedWorkspaceSummary[]; unreadable: string[] }> {
    const entries = await loadRegistry();
    return {
      workspaces: [...entries]
        .sort((a, b) => b.lastHostedAt - a.lastHostedAt)
        .map((entry) => ({
          folder: entry.folder,
          name: entry.name,
          port: entry.port,
          lastHostedAt: entry.lastHostedAt,
          lastBackupAt: entry.lastBackupAt ?? null,
          running: server !== null && workspace?.folder === entry.folder,
          missing: !existsSync(join(options.dataRoot, entry.folder)),
        })),
      unreadable: unreadableFolders,
    };
  }

  /**
   * Copies a hosted workspace into a new folder inside `destination`, running
   * or not, and records when. It waits its turn behind starting and stopping,
   * so the app cannot quit or change workspaces halfway through a copy.
   */
  function backup(value: unknown): Promise<{ path: string; at: number }> {
    const { folder, destination } = (value ?? {}) as Record<string, unknown>;
    if (typeof folder !== "string" || typeof destination !== "string" || !isAbsolute(destination))
      return Promise.reject(new Error("Choose a workspace and a folder to back it up to."));
    if (!options.backupWorkspace)
      return Promise.reject(new Error("Backing up is not available in this app."));
    return serialized(async () => {
      if (closing) throw new Error("The app is quitting.");
      const entry = (await loadRegistry()).find((e) => e.folder === folder);
      if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
      const dataDir = join(options.dataRoot, entry.folder);
      if (!existsSync(dataDir))
        throw new Error(
          `The folder that held ${entry.name} is missing, so there is nothing to back up.`,
        );
      if (options.freeBytes) {
        // The copy is about the size of the folder. A little over that leaves
        // room for the database's snapshot to be larger than the file it came from.
        const needed = Math.ceil((await folderBytes(dataDir)) * 1.1) + 16 * 1024 * 1024;
        const free = await options.freeBytes(destination);
        if (free < needed)
          throw new Error(
            `There is not enough free space there. The backup needs about ${megabytes(needed)}, and ${megabytes(free)} is free.`,
          );
      }
      const stamp = new Date(now()).toISOString().slice(0, 19).replaceAll(":", "-");
      const out = join(destination, `${legacyFolder(entry.name)}-${stamp}`);
      await options.backupWorkspace!({ dataDir, out });
      const at = now();
      updateEntry(entry.folder, { lastBackupAt: at });
      // The backup is made and verified either way. Only the date shown for it can be lost.
      await saveRegistry().catch(() => {});
      changed();
      return { path: out, at };
    });
  }

  /**
   * Takes a workspace whose folder is gone out of the list. One whose folder
   * is still there would only be adopted again on the next launch, so it stays.
   */
  function forget(value: unknown): Promise<void> {
    if (typeof value !== "string")
      return Promise.reject(new Error("Choose a workspace to remove."));
    return serialized(async () => {
      const list = await loadRegistry();
      const entry = list.find((e) => e.folder === value);
      if (!entry) return;
      if (existsSync(join(options.dataRoot, entry.folder)))
        throw new Error(`${entry.name} is still on this computer, so it stays in the list.`);
      registry = list.filter((e) => e.folder !== entry.folder);
      try {
        await saveRegistry();
      } catch (error) {
        registry = list;
        throw error;
      }
      changed();
    });
  }

  /** The workspace hosted most recently, for offering to start it again. */
  async function lastHosted(): Promise<{
    folder: string;
    workspaceName: string;
    port: number;
  } | null> {
    const entries = await loadRegistry().catch(() => []);
    const latest = entries.reduce<HostedWorkspace | null>(
      (best, entry) => (!best || entry.lastHostedAt > best.lastHostedAt ? entry : best),
      null,
    );
    return latest ? { folder: latest.folder, workspaceName: latest.name, port: latest.port } : null;
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
    list,
    lastHosted,
    backup,
    forget,
    start,
    stop,
    shutdown,
    openToAll,
    endOpenToAll,
    setInviteOnly,
    setPublicAddress,
  };
}
