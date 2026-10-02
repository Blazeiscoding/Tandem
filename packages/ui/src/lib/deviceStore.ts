import {
  applyDraftChanges,
  applyOutboxChanges,
  applyRecordChanges,
  type DraftChanges,
  type OutboxChanges,
  type RecordChanges,
} from "@slackoss/client-core";

/**
 * Where the web client keeps unsent work and choices on this device (F01).
 *
 * In IndexedDB where the browser has it: every change to a key is one
 * readwrite transaction, read, merge and write together, and the browser
 * runs those one at a time for every tab and process of this site. Tabs in
 * different processes each keep their own copy of localStorage and hear of
 * each other's writes a moment later, so with localStorage alone two tabs
 * could each merge into a copy without the other's change and one would be
 * lost. A change is acknowledged when its transaction completes.
 *
 * A transaction a closing page started may never complete, which
 * localStorage's immediate writes never risked. So each change is first
 * written down, as data, in a small localStorage journal, synchronously,
 * and made the next time the client starts if it was not finished. Which
 * tab made each change, and how many it had made, is kept beside every
 * value in the same transaction, so a change found written down is made
 * once: never again after it was made, even when it was another open tab's
 * change still being finished and that tab has made newer ones since. Other
 * tabs are told of each change over a BroadcastChannel.
 *
 * Without IndexedDB or BroadcastChannel (some private windows, some
 * embedded browsers), or when it cannot be opened, values stay in
 * localStorage as before. Values from before IndexedDB are moved across the
 * first time each key is met: none is left behind in localStorage, so a
 * sign-in forgotten here is not still kept there.
 */

/** One change to one key, as data, so it can be written down and made again. */
export type StoreOp =
  | { kind: "set"; value: unknown }
  | { kind: "initialize"; value: unknown }
  | { kind: "outbox"; changes: OutboxChanges; enveloped: boolean }
  | { kind: "drafts"; changes: DraftChanges; enveloped: boolean }
  | { kind: "record"; changes: RecordChanges };

/** What an op gives back when it was made already: what is stored now, read as it would read it. */
function resultNow(stored: unknown, op: StoreOp): unknown {
  switch (op.kind) {
    case "set":
      return undefined;
    case "initialize":
      return stored ?? null;
    case "outbox":
      return applyOutboxChanges(stored, { put: [], remove: [] }, op.enveloped).outbox;
    case "drafts":
      return applyDraftChanges(stored, { put: {}, remove: [] }, op.enveloped).drafts;
    case "record":
      return applyRecordChanges(stored, {});
  }
}

/** What an op makes of the stored value, and what its caller is given back. */
export function applyOp(stored: unknown, op: StoreOp): { value: unknown; result: unknown } {
  switch (op.kind) {
    case "set":
      return { value: op.value ?? null, result: undefined };
    case "initialize": {
      const now = stored ?? op.value ?? null;
      return { value: now, result: now };
    }
    case "outbox": {
      const { value, outbox } = applyOutboxChanges(stored, op.changes, op.enveloped);
      return { value, result: outbox };
    }
    case "drafts": {
      const { value, drafts } = applyDraftChanges(stored, op.changes, op.enveloped);
      return { value, result: drafts };
    }
    case "record": {
      const value = applyRecordChanges(stored, op.changes);
      return { value, result: value };
    }
  }
}

/** Where each value lived before IndexedDB, and still does without it. */
export const LEGACY_PREFIX = "slackoss:";
/** Changes written down before they are made. */
export const JOURNAL_PREFIX = "slackoss-journal:";
/** How long a change written down is tried again for, if it cannot be made. */
const JOURNAL_KEPT_MS = 24 * 60 * 60 * 1000;
const DATABASE = "tandem-device";
const VALUES = "values";
/** For each key, the last change each tab made to it: `{ [tab]: [seq, at] }`. */
const MADE = "made";
/** How long a tab's last change to a key is remembered once it has made no other. */
const MADE_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL = "tandem-device";

/** A stored value from its text; unreadable text is no value, which a merge replaces. */
function parsed(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** What a watcher is told: the value, or the text itself when it cannot be read. */
function told(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Which tab asked for a change, and the how-manyth of its changes it is. */
interface Origin {
  tab: string;
  seq: number;
}

interface Backend {
  kind: "indexeddb" | "localstorage";
  /** The stored text, or null when nothing is stored. */
  read(key: string): Promise<string | null>;
  /**
   * Makes one change in one step, unless `origin` says it was made already,
   * and gives back the text now stored, the op's result, and whether it made it.
   */
  apply(
    key: string,
    op: StoreOp,
    origin: Origin,
  ): Promise<{ raw: string; result: unknown; made: boolean }>;
}

function localBackend(): Backend {
  return {
    kind: "localstorage",
    read: async (key) => localStorage.getItem(LEGACY_PREFIX + key),
    // Read, merged and written with nothing awaited between, so nothing in
    // this tab comes between; and at once, so a closing page still writes it.
    apply: async (key, op) => {
      const name = LEGACY_PREFIX + key;
      const raw = localStorage.getItem(name);
      const { value, result } = applyOp(parsed(raw), op);
      const next = JSON.stringify(value);
      if (next !== raw) localStorage.setItem(name, next);
      return { raw: next, result, made: true };
    },
  };
}

/** How long opening the database may take before localStorage is used instead. */
const OPEN_TIMEOUT_MS = 5_000;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let late = false;
    // Some browsers have been known never to answer; a client that waits for
    // its storage forever never starts.
    const timer = setTimeout(() => {
      late = true;
      reject(new Error("The device storage did not open."));
    }, OPEN_TIMEOUT_MS);
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      for (const name of [VALUES, MADE])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (late || !db.objectStoreNames.contains(VALUES) || !db.objectStoreNames.contains(MADE)) {
        db.close();
        return reject(new Error("The device storage cannot be used."));
      }
      // A newer client upgrading the database in another tab goes first.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
    request.onblocked = () => {
      clearTimeout(timer);
      reject(new Error("The device storage is in use by an older tab."));
    };
  });
}

function forgetLegacy(key: string) {
  try {
    localStorage.removeItem(LEGACY_PREFIX + key);
  } catch {
    // Nothing to forget.
  }
}

function indexedBackend(db: IDBDatabase): Backend {
  /**
   * One readwrite transaction; settles when it has committed, or failed.
   * `moved` names keys whose localStorage value it brought across, forgotten
   * there once it has.
   */
  const transaction = <T>(
    work: (
      values: IDBObjectStore,
      done: (result: T) => void,
      moved: Set<string>,
      made: IDBObjectStore,
    ) => void,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      let result: { value: T } | null = null;
      const moved = new Set<string>();
      const tx = db.transaction([VALUES, MADE], "readwrite");
      tx.oncomplete = () => {
        for (const key of moved) forgetLegacy(key);
        if (result) resolve(result.value);
        else reject(new Error("The device storage did not answer."));
      };
      tx.onerror = () => reject(tx.error ?? new Error("The device storage refused the change."));
      tx.onabort = () => reject(tx.error ?? new Error("The device storage refused the change."));
      try {
        work(tx.objectStore(VALUES), (value) => (result = { value }), moved, tx.objectStore(MADE));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  /**
   * The stored text, bringing across what localStorage held for the key the
   * first time it is met, inside the same transaction.
   */
  const current = (
    values: IDBObjectStore,
    key: string,
    moved: Set<string>,
    then: (raw: string | null) => void,
  ) => {
    const request = values.get(key);
    request.onsuccess = () => {
      let legacy: string | null = null;
      try {
        legacy = localStorage.getItem(LEGACY_PREFIX + key);
      } catch {
        // Nothing to bring across.
      }
      if (typeof request.result === "string") {
        // Left by a page that closed before it could forget it, or written
        // since by a client from before: what is stored here stands.
        if (legacy !== null) moved.add(key);
        return then(request.result);
      }
      if (legacy !== null) {
        values.put(legacy, key);
        moved.add(key);
      }
      then(legacy);
    };
  };
  return {
    kind: "indexeddb",
    read: (key) =>
      transaction<string | null>((values, done, moved) => current(values, key, moved, done)),
    apply: (key, op, origin) =>
      transaction((values, done, moved, made) =>
        current(values, key, moved, (raw) => {
          const request = made.get(key);
          request.onsuccess = () => {
            const now = Date.now();
            const record: Record<string, [seq: number, at: number]> =
              request.result && typeof request.result === "object" ? request.result : {};
            const last = record[origin.tab];
            if (Array.isArray(last) && last[0] >= origin.seq) {
              // Made already: by this tab, or by one that took it up from the journal.
              return done({ raw: raw ?? "null", result: resultNow(parsed(raw), op), made: false });
            }
            const { value, result } = applyOp(parsed(raw), op);
            const next = JSON.stringify(value);
            // Written even when empty, so an emptied key is never filled again
            // from what localStorage held before.
            if (next !== raw) values.put(next, key);
            record[origin.tab] = [origin.seq, now];
            for (const [tab, [, at]] of Object.entries(record))
              if (now - at > MADE_KEPT_MS) delete record[tab];
            made.put(record, key);
            done({ raw: next, result, made: true });
          };
        }),
      ),
  };
}

interface JournalEntry {
  key: string;
  op: StoreOp;
  at: number;
  seq: number;
  /** The tab that asked for it. */
  tab: string;
}

/** The journal's entries, oldest first, by their localStorage names. */
function journalEntries(): [name: string, entry: JournalEntry][] {
  const found: [string, JournalEntry][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(JOURNAL_PREFIX)) continue;
      try {
        const entry = JSON.parse(localStorage.getItem(name) ?? "null") as JournalEntry | null;
        // Named `<tab>:<seq>`, which says whose change it is should it not.
        const [tab] = name.slice(JOURNAL_PREFIX.length).split(":");
        if (entry && typeof entry.key === "string" && entry.op && typeof entry.seq === "number")
          found.push([name, { ...entry, tab: typeof entry.tab === "string" ? entry.tab : tab! }]);
        else localStorage.removeItem(name);
      } catch {
        localStorage.removeItem(name);
      }
    }
  } catch {
    // No localStorage: nothing was written down.
  }
  return found.sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq);
}

export interface DeviceStore {
  /** Which storage this device ended up with. */
  readonly backend: Promise<"indexeddb" | "localstorage">;
  /** The stored text under `key`, or null; rejects when storage cannot be read. */
  read(key: string): Promise<string | null>;
  /** Makes one change, acknowledged once stored, and gives back its result. */
  apply(key: string, op: StoreOp): Promise<unknown>;
  /** Calls back with what another tab stored under `key`, each time it does. */
  watch(key: string, cb: (stored: unknown) => void): () => void;
}

/** The web client's device storage; see the note at the top of this file. */
export function deviceStore(options: { tab?: string } = {}): DeviceStore {
  // Named afresh for every page; a test may name one to stand for a tab already met.
  const tab = options.tab ?? Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const canIndex = typeof indexedDB !== "undefined" && typeof BroadcastChannel === "function";
  const channel = canIndex ? new BroadcastChannel(CHANNEL) : null;
  // Known at once without IndexedDB, so each write still happens within the
  // call that asks for it, as a closing page needs.
  let backend: Backend | null = canIndex ? null : localBackend();
  const opened: Promise<Backend> = backend
    ? Promise.resolve(backend)
    : openDatabase()
        .then(indexedBackend)
        .catch(() => {
          channel?.close();
          return localBackend();
        });
  // Changes a closing page left unfinished are made before any other here.
  // One another open tab is still making is made once all the same, by
  // whichever of the two comes first.
  const ready = opened.then(async (chosen) => {
    for (const [name, entry] of journalEntries()) {
      try {
        const { raw, made } = await chosen.apply(entry.key, entry.op, entry);
        if (made && chosen.kind === "indexeddb") channel?.postMessage({ key: entry.key, raw });
      } catch {
        // Not made: tried again next time, unless it has been failing for a day.
        if (Date.now() - entry.at < JOURNAL_KEPT_MS) continue;
      }
      try {
        localStorage.removeItem(name);
      } catch {
        // Tried again next time, which changes nothing.
      }
    }
    backend = chosen;
    return chosen;
  });

  /** Written down at once, while it may be the last thing a closing page does. */
  const writeDown = (key: string, op: StoreOp, origin: Origin): string | null => {
    if (backend?.kind === "localstorage") return null;
    const name = `${JOURNAL_PREFIX}${tab}:${origin.seq}`;
    try {
      localStorage.setItem(name, JSON.stringify({ key, op, at: Date.now(), ...origin }));
      return name;
    } catch {
      // No room to write it down: it is still made, only not again after a crash.
      return null;
    }
  };
  const crossOut = (name: string | null) => {
    if (!name) return;
    try {
      localStorage.removeItem(name);
    } catch {
      // Made again next time, which changes nothing.
    }
  };

  return {
    backend: ready.then((chosen) => chosen.kind),
    read: async (key) => (backend?.kind === "localstorage" ? backend : await ready).read(key),
    apply: async (key, op) => {
      const origin = { tab, seq: ++seq };
      const name = writeDown(key, op, origin);
      try {
        const chosen = backend?.kind === "localstorage" ? backend : await ready;
        const { raw, result, made } = await chosen.apply(key, op, origin);
        if (made && chosen.kind === "indexeddb") channel?.postMessage({ key, raw });
        return result;
      } finally {
        crossOut(name);
      }
    },
    watch: (key, cb) => {
      const fromTab = (event: MessageEvent<{ key: string; raw: string }>) => {
        if (event.data?.key === key) cb(told(event.data.raw));
      };
      // Without IndexedDB, other tabs' writes arrive as storage events.
      const fromStorage = (event: StorageEvent) => {
        if (backend?.kind !== "localstorage" || event.storageArea !== localStorage) return;
        if (event.key !== LEGACY_PREFIX + key) return;
        // Left as text when unreadable, which nothing reads as its value.
        cb(told(event.newValue));
      };
      channel?.addEventListener("message", fromTab);
      window.addEventListener("storage", fromStorage);
      return () => {
        channel?.removeEventListener("message", fromTab);
        window.removeEventListener("storage", fromStorage);
      };
    },
  };
}
