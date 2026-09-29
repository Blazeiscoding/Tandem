import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredPending } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import {
  readWorkspaceStorage,
  updateWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "../lib/workspaceStorage.js";

function validDrafts(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((text) => typeof text === "string")
  );
}

function validOutbox(value: unknown): value is StoredPending[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry &&
        typeof entry.nonce === "string" &&
        typeof entry.channelId === "string" &&
        (entry.threadRootId === null || typeof entry.threadRootId === "string") &&
        (entry.broadcast === undefined || typeof entry.broadcast === "boolean") &&
        typeof entry.text === "string" &&
        typeof entry.userId === "string" &&
        Number.isFinite(entry.createdAt) &&
        (entry.refusal === undefined || typeof entry.refusal === "string") &&
        Array.isArray(entry.attachments) &&
        entry.attachments.every(
          (file: { name?: unknown; size?: unknown; mime?: unknown } | null) =>
            file &&
            typeof file.name === "string" &&
            typeof file.size === "number" &&
            Number.isFinite(file.size) &&
            file.size >= 0 &&
            typeof file.mime === "string",
        ),
    )
  );
}

/** Keeps unsent work on this device, scoped to the authenticated workspace and account. */
export function DraftPersistence({ platform }: { platform: Platform }) {
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const keys = useMemo(
    () => ({
      drafts: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "drafts"),
      outbox: workspaceStorageKey(client.baseUrl, workspaceId, selfId, "outbox"),
    }),
    [client, workspaceId, selfId],
  );
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<(() => void) | null>(null);

  useEffect(() => {
    const draftKey = keys.drafts;
    const outboxKey = keys.outbox;
    if (!draftKey || !outboxKey) return;
    let disposed = false;
    let loaded = false;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let currentDrafts = client.state.drafts;
    let currentOutbox = client.outboxSnapshot();
    let outboxJson = JSON.stringify(currentOutbox);
    const editedDrafts = new Set<string>();
    // Every window open on this account writes the same stored outbox, so each
    // takes out only what it saw delivered or discarded and keeps the rest.
    const removedPending = new Set<string>();
    let outboxChanged = false;
    const versions = { drafts: 0, outbox: 0 };
    const failing = new Set<keyof typeof versions>();
    setError(null);

    // The latest write of each part decides whether saving has failed.
    const save = (part: keyof typeof versions, write: Promise<void>) => {
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
      };
      return write.then(
        () => settle(true),
        () => settle(false),
      );
    };
    const mergeOutbox = (stored: StoredPending[]) => {
      const outbox = new Map(stored.map((entry) => [entry.nonce, entry]));
      // Once a removed send is no longer stored, there is nothing left to take out.
      for (const nonce of removedPending) if (!outbox.delete(nonce)) removedPending.delete(nonce);
      for (const entry of currentOutbox) outbox.set(entry.nonce, entry);
      return [...outbox.values()];
    };
    const saveDrafts = (drafts: Record<string, string>) =>
      save("drafts", writeWorkspaceStorage(platform, draftKey, drafts));
    const saveOutbox = () =>
      save(
        "outbox",
        updateWorkspaceStorage(platform, outboxKey, (stored) =>
          mergeOutbox(validOutbox(stored) ? stored : []),
        ),
      );

    // The client and keys belong to this effect, including its final flush.
    // A new connection must never write its drafts into the previous scope.
    const flush = () => {
      clearTimeout(timer);
      if (!loaded) return;
      void saveDrafts(currentDrafts);
      void saveOutbox();
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
      if (state.pending === previous.pending) return;
      for (const entry of previous.pending) {
        if (!state.pending.some((pending) => pending.nonce === entry.nonce))
          removedPending.add(entry.nonce);
      }
      const outbox = client.outboxSnapshot();
      const json = JSON.stringify(outbox);
      if (json === outboxJson) return;
      currentOutbox = outbox;
      outboxJson = json;
      outboxChanged = true;
      // A send accepted, delivered or refused is written now, not after the
      // pause drafts wait for: a restart in between would lose it or resend it.
      if (loaded) void saveOutbox();
    });

    const restore = () => {
      if (loading) return;
      loading = true;
      setError(null);
      void Promise.all([
        readWorkspaceStorage<unknown>(platform, draftKey),
        readWorkspaceStorage<unknown>(platform, outboxKey),
      ])
        .then(([storedDrafts, storedOutbox]) => {
          if (storedDrafts !== null && !validDrafts(storedDrafts))
            throw new Error("Invalid drafts");
          if (storedOutbox !== null && !validOutbox(storedOutbox))
            throw new Error("Invalid outbox");
          const drafts = { ...storedDrafts, ...currentDrafts };
          // Keep these edits across failed read retries as well as the first load.
          // An empty draft typed while storage was loading is an edit too.
          for (const key of editedDrafts) {
            if (!(key in currentDrafts)) delete drafts[key];
          }
          const outbox = mergeOutbox(storedOutbox ?? []);
          if (disposed) {
            // A quick switch may precede a desktop storage read. Finish saving
            // edits to the captured scope, without restoring or sending anything.
            if (editedDrafts.size) void saveDrafts(drafts);
            if (outboxChanged) void saveOutbox();
            return;
          }
          client.hydrateDrafts(drafts);
          client.restoreOutbox(outbox);
          loaded = true;
          flush();
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
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      disposed = true;
      flush();
    };
  }, [client, platform, keys]);

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
