import type { Platform } from "../platform.js";
import { checkWorkspaceAddress } from "./workspaceAddressTrust.js";

export interface WorkspaceStorageKey {
  key: string;
  /** The account-scoped address key used before workspace IDs reached the client. */
  legacyKey?: string;
  legacyScope?: {
    baseUrl: string;
    workspaceId: string;
    selfId: string;
    kind: string;
    suffix?: string;
  };
}

/** Call only with identity from the authenticated ready snapshot. */
export function workspaceStorageKey(
  baseUrl: string,
  workspaceId: string | null | undefined,
  selfId: string | null | undefined,
  kind: string,
  suffix?: string,
): WorkspaceStorageKey | null {
  if (!selfId) return null;
  const legacyKey = `${kind}:${baseUrl}:${selfId}${suffix === undefined ? "" : `:${suffix}`}`;
  if (!workspaceId) return { key: legacyKey };
  const parts = [workspaceId, selfId, kind, ...(suffix === undefined ? [] : [suffix])];
  return {
    key: `local:v1:${parts.map(encodeURIComponent).join(":")}`,
    legacyKey,
    legacyScope: { baseUrl, workspaceId, selfId, kind, suffix },
  };
}

const queues = new WeakMap<Platform, Map<string, Promise<void>>>();

function serialized<T>(platform: Platform, key: string, operation: () => Promise<T>): Promise<T> {
  const queue = queues.get(platform) ?? new Map<string, Promise<void>>();
  queues.set(platform, queue);
  const previous = queue.get(key);
  let result: Promise<T>;
  try {
    // An uncontended browser write must still enter localStorage immediately:
    // pagehide cannot rely on another turn to save the final keystroke.
    result = previous ? previous.then(operation) : operation();
  } catch (error) {
    result = Promise.reject(error);
  }
  // A rejected operation reaches its caller without blocking later retries.
  const settled = result.then(
    () => {},
    () => {},
  );
  queue.set(key, settled);
  void settled.then(() => {
    if (queue.get(key) === settled) queue.delete(key);
  });
  return result;
}

function envelope(value: unknown) {
  if (value === undefined) throw new Error("Cannot save an undefined workspace value.");
  return { version: 1, value };
}

function unwrap<T>(stored: unknown): T | null {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    !("version" in stored) ||
    stored.version !== 1 ||
    !("value" in stored)
  ) {
    throw new Error("Could not read the saved workspace data.");
  }
  return stored.value as T | null;
}

export function readWorkspaceStorage<T>(
  platform: Platform,
  key: WorkspaceStorageKey,
): Promise<T | null> {
  return serialized(platform, key.key, async () => {
    const stored = await platform.storage.get<unknown>(key.key, { strict: true });
    if (!key.legacyKey) return stored as T | null;
    if (stored !== null) return unwrap<T>(stored);
    const legacyKeys = [key.legacyKey];
    if (key.legacyScope) {
      const scope = key.legacyScope;
      const access = await checkWorkspaceAddress(
        platform,
        scope.workspaceId,
        scope.selfId,
        scope.baseUrl,
      );
      if (!access.allowed)
        throw new Error("Approve this workspace address before restoring local work.");
      // A thread composer/search dialog may never have opened at the old
      // address after upgrade. Its legacy slot is still recoverable once both
      // addresses have been explicitly linked on this device.
      for (const address of access.addresses) {
        const candidate = `${scope.kind}:${address}:${scope.selfId}${scope.suffix === undefined ? "" : `:${scope.suffix}`}`;
        if (!legacyKeys.includes(candidate)) legacyKeys.push(candidate);
      }
    }
    for (const legacyKey of legacyKeys) {
      const value = await serialized(platform, legacyKey, async () => {
        const legacy = await platform.storage.get<T>(legacyKey, { strict: true });
        if (legacy === null) return null;
        await platform.storage.set(key.key, envelope(legacy));
        try {
          await platform.storage.set(legacyKey, null);
        } catch {
          // The durable new value remains authoritative if retirement fails.
        }
        return legacy;
      });
      if (value !== null) return value;
    }
    // Record absence as well: dismissed recovery and cleared data must not be
    // resurrected by a stale address key on a later read.
    await platform.storage.set(key.key, envelope(null));
    return null;
  });
}

export function writeWorkspaceStorage(
  platform: Platform,
  key: WorkspaceStorageKey,
  value: unknown,
): Promise<void> {
  return serialized(platform, key.key, () =>
    platform.storage.set(key.key, key.legacyKey ? envelope(value) : value),
  );
}

/**
 * Reads a value and writes what `update` makes of it in one turn of its key's
 * queue, so two writers here cannot lose each other's change in between. Call
 * only after the value has been read once, which retires its legacy key. A
 * value that cannot be read is replaced rather than blocking every later save.
 */
export function updateWorkspaceStorage(
  platform: Platform,
  key: WorkspaceStorageKey,
  update: (current: unknown) => unknown,
): Promise<void> {
  return serialized(platform, key.key, async () => {
    let current: unknown = null;
    try {
      const stored = await platform.storage.get<unknown>(key.key, { strict: true });
      current = key.legacyKey && stored !== null ? unwrap(stored) : stored;
    } catch {
      // Nothing unreadable can be kept; the writer's own value takes its place.
    }
    const value = update(current);
    await platform.storage.set(key.key, key.legacyKey ? envelope(value) : value);
  });
}
