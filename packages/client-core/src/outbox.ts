import type { StoredPending } from "./workspace.js";

/**
 * The outbox as every window open on one account keeps it on the device.
 *
 * Each window writes its own sends and removals, never a whole list read
 * earlier, so the stored outbox is a merge of changes rather than whichever
 * window wrote last. A send taken out, because it was delivered or its author
 * discarded it, leaves a tombstone: no window can put it back, however stale
 * its copy. Between two versions of the same send, the newer revision wins, so
 * a refusal written by one window cannot be undone by another that has not
 * seen it; only a newer change, such as its author choosing Retry, replaces it.
 *
 * Kept free of anything but plain data so the desktop app's main process can
 * run the same merge, in one step, for every window at once.
 */
export interface StoredOutboxEntry extends StoredPending {
  /** When this version of the send was written; see `outboxRevision`. */
  rev: number;
}

export interface StoredOutbox {
  outbox: 2;
  /** The sends still waiting, in the order they were first stored. */
  entries: StoredOutboxEntry[];
  /** Sends taken out, by nonce, newest first. */
  removed: { nonce: string; rev: number }[];
}

export interface OutboxChanges {
  put: StoredOutboxEntry[];
  remove: { nonce: string; rev: number }[];
}

/**
 * How many tombstones are kept. A window stale enough to hold a send removed
 * more than this many removals ago is not one this has to outlast.
 */
export const OUTBOX_TOMBSTONES_KEPT = 500;

/**
 * A revision later than `previous` and, across windows, later than anything
 * written in an earlier millisecond: wall-clock time with room for a counter.
 */
export function outboxRevision(previous = 0, now = Date.now()): number {
  return Math.max(previous + 1, now * 1000);
}

export function isStoredPending(entry: unknown): entry is StoredPending {
  const e = entry as Record<string, unknown> | null;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.nonce === "string" &&
    typeof e.channelId === "string" &&
    (e.threadRootId === null || typeof e.threadRootId === "string") &&
    (e.broadcast === undefined || typeof e.broadcast === "boolean") &&
    typeof e.text === "string" &&
    typeof e.userId === "string" &&
    Number.isFinite(e.createdAt) &&
    (e.refusal === undefined || typeof e.refusal === "string") &&
    Array.isArray(e.attachments) &&
    e.attachments.every(
      (file: { name?: unknown; size?: unknown; mime?: unknown } | null) =>
        !!file &&
        typeof file.name === "string" &&
        typeof file.size === "number" &&
        Number.isFinite(file.size) &&
        file.size >= 0 &&
        typeof file.mime === "string",
    )
  );
}

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A send as plain data in a fixed shape, so two copies compare by their JSON. */
export function storedPending(entry: StoredPending): StoredPending {
  return {
    nonce: entry.nonce,
    channelId: entry.channelId,
    threadRootId: entry.threadRootId,
    ...(entry.broadcast === undefined ? {} : { broadcast: entry.broadcast }),
    text: entry.text,
    userId: entry.userId,
    createdAt: entry.createdAt,
    attachments: entry.attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
    ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
  };
}

export function emptyOutbox(): StoredOutbox {
  return { outbox: 2, entries: [], removed: [] };
}

/**
 * Reads a stored outbox of either shape: this one, or the plain list earlier
 * versions wrote, whose entries count as the oldest revision there is. Null
 * when it is neither, or holds an entry that is not a send.
 */
export function readStoredOutbox(value: unknown): StoredOutbox | null {
  if (value === null || value === undefined) return emptyOutbox();
  if (Array.isArray(value)) {
    return value.every(isStoredPending)
      ? { outbox: 2, entries: value.map((entry) => ({ ...entry, rev: 0 })), removed: [] }
      : null;
  }
  const record = value as Partial<StoredOutbox>;
  if (
    typeof record !== "object" ||
    record.outbox !== 2 ||
    !Array.isArray(record.entries) ||
    !Array.isArray(record.removed) ||
    !record.entries.every((entry) => isStoredPending(entry) && isRevision(entry.rev)) ||
    !record.removed.every((r) => !!r && typeof r.nonce === "string" && isRevision(r.rev))
  ) {
    return null;
  }
  return record as StoredOutbox;
}

/**
 * Applies one window's changes. A tombstone is final. Otherwise the newest
 * revision of a send is kept, and at the same revision the one already stored.
 */
export function mergeOutbox(current: StoredOutbox, changes: OutboxChanges): StoredOutbox {
  const entries = new Map(current.entries.map((entry) => [entry.nonce, entry]));
  const removed = new Map(current.removed.map((r) => [r.nonce, r.rev]));
  for (const removal of changes.remove) {
    if (!removal || typeof removal.nonce !== "string" || !isRevision(removal.rev)) continue;
    entries.delete(removal.nonce);
    removed.set(removal.nonce, Math.max(removed.get(removal.nonce) ?? 0, removal.rev));
  }
  for (const entry of changes.put) {
    if (!isStoredPending(entry) || !isRevision(entry.rev) || removed.has(entry.nonce)) continue;
    const held = entries.get(entry.nonce);
    if (held && held.rev >= entry.rev) continue;
    entries.set(entry.nonce, { ...storedPending(entry), rev: entry.rev });
  }
  const tombstones = [...removed]
    .map(([nonce, rev]) => ({ nonce, rev }))
    .sort((a, b) => b.rev - a.rev)
    .slice(0, OUTBOX_TOMBSTONES_KEPT);
  return { outbox: 2, entries: [...entries.values()], removed: tombstones };
}

/**
 * The outbox inside a stored value. `enveloped` is whether the key's value is
 * wrapped as `{ version: 1, value }`, as workspace-scoped keys are. Null when
 * the value cannot be read as an outbox.
 */
export function unwrapStoredOutbox(stored: unknown, enveloped: boolean): StoredOutbox | null {
  if (!enveloped || stored === null || stored === undefined) return readStoredOutbox(stored);
  const wrapper = stored as { version?: unknown; value?: unknown };
  if (typeof wrapper !== "object" || Array.isArray(wrapper) || wrapper.version !== 1) return null;
  return readStoredOutbox(wrapper.value);
}

/**
 * The whole step one atomic storage update performs: take what is stored,
 * whatever state it is in, merge the changes, and give back what to store and
 * the outbox it holds. Anything unreadable is replaced rather than left to
 * block every later save; a send it held is not lost for that alone, since
 * each window keeps writing its own until it sees them stored.
 */
export function applyOutboxChanges(
  stored: unknown,
  changes: OutboxChanges,
  enveloped: boolean,
): { value: unknown; outbox: StoredOutbox } {
  const outbox = mergeOutbox(unwrapStoredOutbox(stored, enveloped) ?? emptyOutbox(), changes);
  return { value: enveloped ? { version: 1, value: outbox } : outbox, outbox };
}
