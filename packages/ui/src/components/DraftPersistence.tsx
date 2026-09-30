import { useEffect, useMemo, useRef, useState } from "react";
import {
  OUTBOX_TOMBSTONES_KEPT,
  outboxRevision,
  storedPending,
  type StoredOutbox,
  type StoredOutboxEntry,
} from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import {
  mergeWorkspaceOutbox,
  readWorkspaceOutbox,
  readWorkspaceStorage,
  watchWorkspaceOutbox,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "../lib/workspaceStorage.js";

/** A send's words kept for a restart while the outbox could not store them. */
interface UnstoredSend {
  draftKey: string;
  text: string;
}

function validUnstored(value: unknown): value is Record<string, UnstoredSend> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (send: Partial<UnstoredSend> | null) =>
        !!send && typeof send.draftKey === "string" && typeof send.text === "string",
    )
  );
}

/** The composer a send came from, as `Composer` keys its draft. */
const composerOf = (send: Pick<StoredOutboxEntry, "channelId" | "threadRootId">) =>
  send.threadRootId ? `${send.channelId}:${send.threadRootId}` : send.channelId;

function validDrafts(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((text) => typeof text === "string")
  );
}

/** How many times in a row a window writes its sends again after another's write left them out. */
const REPAIRS = 3;

/**
 * Keeps unsent work on this device, scoped to the authenticated workspace and
 * account.
 *
 * Every window open on the account shares one stored outbox. Each writes only
 * its own sends and the ones it saw delivered or discarded, merged in one step
 * by the platform (see `mergeWorkspaceOutbox`), and takes on what the others
 * wrote about the sends it holds: one taken out elsewhere goes here too, and a
 * refusal given elsewhere stops it here until its author chooses Retry.
 *
 * A send is kept on this device once the outbox write carrying it resolves;
 * from then a restart brings it back. Until then a draft already saved with
 * its words stays saved: a draft is written only after the outbox write
 * before it has succeeded, so a process that dies in between comes back with
 * the words in the composer rather than losing both. A write that fails says
 * so, keeps the draft as it was on disk, and is made again on Retry.
 *
 * Words sent before their draft was first saved have no saved draft to fall
 * back on. While outbox writes fail, the sends the outbox has not stored are
 * kept by nonce under a key of their own, and a restart puts any the outbox
 * still does not hold back in their composer: their words come back once, as
 * a draft or as a send, never as both. An ordinary send writes nothing there.
 */
export function DraftPersistence({ platform }: { platform: Platform }) {
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const keys = useMemo(
    () => ({
      drafts: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "drafts"),
      outbox: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "outbox"),
      unstored: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "unstored-sends"),
    }),
    [client, workspaceId, selfId],
  );
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<(() => void) | null>(null);

  useEffect(() => {
    const draftKey = keys.drafts;
    const outboxKey = keys.outbox;
    const unstoredKey = keys.unstored;
    const self = selfId;
    if (!draftKey || !outboxKey || !unstoredKey || !self) return;
    let disposed = false;
    let loaded = false;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let currentDrafts = client.state.drafts;
    const editedDrafts = new Set<string>();
    // This window's sends as it last wrote or took them on, and the ones it
    // saw leave. Every write carries all of them: the merge keeps the newest
    // of each, so writing one again changes nothing, and puts back one that
    // another window's write left out.
    const held = new Map<string, { entry: StoredOutboxEntry; json: string }>();
    const gone = new Map<string, number>();
    let revision = 0;
    let outboxChanged = false;
    let outboxWrite: Promise<unknown> = Promise.resolve();
    let repairs = 0;
    // Set while this window takes on what is stored, so the client's changes
    // along the way are not mistaken for its own new ones.
    let quiet = false;
    const versions = { drafts: 0, outbox: 0 };
    const failing = new Set<keyof typeof versions>();
    // Sends this window has seen stored: the outbox holds their words.
    const stored = new Set<string>();
    // Words brought back from the unstored key, kept there until a drafts
    // write has them; and that key's content as last written, as JSON.
    let carried: Record<string, UnstoredSend> = {};
    let unstoredJson = "{}";
    setError(null);

    // While outbox writes fail, keeps the words of every send this window
    // holds that the outbox has not stored, and afterwards takes them out.
    const keepUnstored = () => {
      const want: Record<string, UnstoredSend> = { ...carried };
      if (failing.has("outbox")) {
        for (const [nonce, { entry }] of held) {
          if (!stored.has(nonce) && entry.text) {
            want[nonce] = { draftKey: composerOf(entry), text: entry.text };
          }
        }
      }
      const json = JSON.stringify(want);
      if (json === unstoredJson) return;
      unstoredJson = json;
      void writeWorkspaceStorage(platform, unstoredKey, want).catch(() => {
        // Unknown now: write it again next time.
        unstoredJson = "";
      });
    };

    // The latest write of each part decides whether saving has failed.
    const save = (part: keyof typeof versions, write: Promise<unknown>) => {
      const version = ++versions[part];
      const settle = (saved: boolean) => {
        if (version !== versions[part]) return;
        if (saved) failing.delete(part);
        else failing.add(part);
        if (!disposed)
          setError(
            failing.size
              ? "Could not save drafts and queued messages on this device. Keep it open and retry."
              : null,
          );
        if (loaded) keepUnstored();
      };
      return write.then(
        () => settle(true),
        () => settle(false),
      );
    };

    const forget = (nonce: string, rev: number) => {
      held.delete(nonce);
      gone.delete(nonce);
      gone.set(nonce, rev);
      if (gone.size > OUTBOX_TOMBSTONES_KEPT) gone.delete(gone.keys().next().value!);
    };

    // Gives each send whose stored form changed here a new revision, and each
    // one that left a tombstone. True when there is something to write.
    const observe = () => {
      const now = new Set<string>();
      let changed = false;
      for (const pending of client.outboxSnapshot()) {
        const entry = storedPending(pending);
        now.add(entry.nonce);
        const json = JSON.stringify(entry);
        if (held.get(entry.nonce)?.json === json) continue;
        revision = outboxRevision(revision);
        held.set(entry.nonce, { entry: { ...entry, rev: revision }, json });
        changed = true;
      }
      for (const nonce of [...held.keys()]) {
        if (now.has(nonce)) continue;
        revision = outboxRevision(revision);
        forget(nonce, revision);
        changed = true;
      }
      return changed;
    };

    const seen = (record: StoredOutbox) => {
      for (const r of [...record.entries, ...record.removed]) revision = Math.max(revision, r.rev);
    };

    // Takes on what other windows wrote about this window's sends. True when
    // something of this window's is missing from what is stored.
    const reconcile = (record: StoredOutbox | null): boolean => {
      if (!record) return held.size > 0 || gone.size > 0;
      seen(record);
      const stored = new Map(record.entries.map((entry) => [entry.nonce, entry]));
      const removed = new Map(record.removed.map((r) => [r.nonce, r.rev]));
      const dropped: string[] = [];
      const refused: StoredOutboxEntry[] = [];
      let missing = false;
      for (const [nonce, mine] of held) {
        const theirs = stored.get(nonce);
        if (removed.has(nonce)) dropped.push(nonce);
        else if (!theirs || theirs.rev < mine.entry.rev) missing = true;
        else if (
          theirs.rev > mine.entry.rev &&
          theirs.refusal !== undefined &&
          mine.entry.refusal === undefined
        )
          refused.push(theirs);
      }
      for (const nonce of gone.keys()) if (stored.has(nonce)) missing = true;
      for (const nonce of dropped) {
        forget(nonce, removed.get(nonce)!);
        client.discardSend(nonce);
      }
      for (const theirs of refused) {
        held.set(theirs.nonce, { entry: theirs, json: JSON.stringify(storedPending(theirs)) });
        client.adoptRefusal(theirs.nonce, theirs.refusal!);
      }
      return missing;
    };

    const saveDrafts = (drafts: Record<string, string>) => {
      const bringing = carried;
      return save(
        "drafts",
        outboxWrite
          .then(() => writeWorkspaceStorage(platform, draftKey, drafts))
          .then(() => {
            // The drafts now hold what came back; the unstored key need not.
            if (carried === bringing) carried = {};
          }),
      );
    };
    const saveOutbox = () => {
      const write = mergeWorkspaceOutbox(platform, outboxKey, {
        put: [...held.values()].map((h) => h.entry),
        remove: [...gone].map(([nonce, rev]) => ({ nonce, rev })),
      }).then((record) => {
        for (const entry of record.entries) if (held.has(entry.nonce)) stored.add(entry.nonce);
        for (const nonce of stored) if (!held.has(nonce)) stored.delete(nonce);
        if (!disposed && loaded) takeOn(record);
        // Drafts held back by a failed outbox write can go now.
        if (loaded && failing.has("drafts")) void saveDrafts(currentDrafts);
      });
      outboxWrite = write;
      return save("outbox", write);
    };
    const quietly = <T,>(step: () => T): T => {
      quiet = true;
      try {
        return step();
      } finally {
        quiet = false;
      }
    };
    // Writing again when something is missing is bounded, so two windows that
    // disagree about what is stored cannot keep each other writing.
    const takeOn = (record: StoredOutbox | null) => {
      const missing = quietly(() => reconcile(record));
      if (observe()) void saveOutbox();
      else if (!missing) repairs = 0;
      else if (repairs++ < REPAIRS) void saveOutbox();
    };

    // The client and keys belong to this effect, including its final flush.
    // A new connection must never write its drafts into the previous scope.
    const flush = () => {
      clearTimeout(timer);
      if (!loaded) return;
      void saveOutbox();
      void saveDrafts(currentDrafts);
    };
    const unsubscribe = client.store.subscribe((state, previous) => {
      if (state.drafts !== previous.drafts) {
        if (!loaded) {
          for (const key of new Set([
            ...Object.keys(previous.drafts),
            ...Object.keys(state.drafts),
          ])) {
            if (state.drafts[key] !== previous.drafts[key]) editedDrafts.add(key);
          }
        }
        currentDrafts = state.drafts;
        clearTimeout(timer);
        if (loaded) timer = setTimeout(() => void saveDrafts(currentDrafts), 600);
      }
      if (quiet || state.pending === previous.pending || !observe()) return;
      outboxChanged = true;
      // A send accepted, delivered or refused is written now, not after the
      // pause drafts wait for: a restart in between would lose it or resend it.
      if (loaded) void saveOutbox();
    });
    const unwatch = watchWorkspaceOutbox(platform, outboxKey, (record) => {
      if (loaded && !disposed) takeOn(record);
    });

    // What was stored meets what this client already holds, which after a
    // change of address is more than nothing.
    const load = (record: StoredOutbox) => {
      seen(record);
      const pending = new Map(client.outboxSnapshot().map((p) => [p.nonce, storedPending(p)]));
      const refused: StoredOutboxEntry[] = [];
      for (const r of record.removed) {
        if (!pending.has(r.nonce)) continue;
        forget(r.nonce, r.rev);
        client.discardSend(r.nonce);
      }
      const restored: StoredOutboxEntry[] = [];
      for (const entry of record.entries) {
        if (entry.userId !== self || held.has(entry.nonce) || gone.has(entry.nonce)) continue;
        const json = JSON.stringify(storedPending(entry));
        const mine = pending.get(entry.nonce);
        if (!mine) restored.push(entry);
        else if (entry.refusal !== undefined && mine.refusal === undefined) refused.push(entry);
        // This client's own version differs and is newer: it gets a revision of its own.
        else if (JSON.stringify(mine) !== json) continue;
        held.set(entry.nonce, { entry, json });
      }
      for (const entry of refused) client.adoptRefusal(entry.nonce, entry.refusal!);
      client.restoreOutbox(restored.map(storedPending));
    };

    const restore = () => {
      if (loading) return;
      loading = true;
      setError(null);
      void Promise.all([
        readWorkspaceStorage<unknown>(platform, draftKey),
        readWorkspaceOutbox(platform, outboxKey),
        readWorkspaceStorage<unknown>(platform, unstoredKey),
      ])
        .then(([storedDrafts, record, unstored]) => {
          if (storedDrafts !== null && !validDrafts(storedDrafts))
            throw new Error("Invalid drafts");
          const drafts: Record<string, string> = { ...storedDrafts, ...currentDrafts };
          // Keep these edits across failed read retries as well as the first load.
          // An empty draft typed while storage was loading is an edit too.
          for (const key of editedDrafts) {
            if (!(key in currentDrafts)) delete drafts[key];
          }
          // Words of sends the outbox never stored go back to their composer.
          // One the outbox holds, or took out, comes back as a send or not at all.
          const owned = new Set([
            ...record.entries.map((e) => e.nonce),
            ...record.removed.map((r) => r.nonce),
          ]);
          const kept = validUnstored(unstored) ? unstored : {};
          const back: Record<string, UnstoredSend> = {};
          for (const [nonce, send] of Object.entries(kept)) {
            if (owned.has(nonce)) continue;
            back[nonce] = send;
            const draft = drafts[send.draftKey] ?? "";
            if (!draft.includes(send.text))
              drafts[send.draftKey] = draft ? `${draft}\n\n${send.text}` : send.text;
          }
          if (disposed) {
            // A quick switch may precede a desktop storage read. Finish saving
            // edits to the captured scope, without restoring or sending anything.
            if (outboxChanged) void saveOutbox();
            if (editedDrafts.size) void saveDrafts(drafts);
            return;
          }
          client.hydrateDrafts(drafts);
          quietly(() => load(record));
          observe();
          carried = back;
          unstoredJson = JSON.stringify(kept);
          loaded = true;
          flush();
          keepUnstored();
        })
        .catch(() => {
          if (!disposed)
            setError(
              "Could not restore drafts and queued messages on this device. Saved work is kept; retry before closing.",
            );
        })
        .finally(() => {
          loading = false;
        });
    };
    // Once restored, memory is authoritative. Re-reading after a failed save
    // could resurrect cleared drafts or send a message the author discarded.
    const retryPersistence = () => (loaded ? flush() : restore());
    retry.current = retryPersistence;
    restore();

    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      if (retry.current === retryPersistence) retry.current = null;
      unsubscribe();
      unwatch();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      disposed = true;
      flush();
    };
  }, [client, platform, keys, selfId]);

  return error ? (
    <div
      role="alert"
      className="absolute inset-x-3 top-3 z-50 flex items-center gap-3 rounded-lg border border-alert/30 bg-raised p-3 text-sm text-alert shadow-lg"
    >
      <span className="flex-1">{error}</span>
      <button type="button" className="shrink-0 underline" onClick={() => retry.current?.()}>
        Retry
      </button>
    </div>
  ) : null;
}
