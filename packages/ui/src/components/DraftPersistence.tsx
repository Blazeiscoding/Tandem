import { useEffect, useRef, useState } from "react";
import type { StoredPending } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";

/**
 * Keeps unsent work — drafts and the outbox — on disk.
 *
 * Storage is keyed by workspace *and* account. Signing into a second account on
 * the same server must never hand it the first account's half-written messages.
 */
export function DraftPersistence({ platform }: { platform: Platform }) {
  const client = useClient();
  const drafts = useWorkspace((s) => s.drafts);
  const pending = useWorkspace((s) => s.pending);
  const selfId = useWorkspace((s) => s.self?.id);
  const [loaded, setLoaded] = useState(false);
  // Nothing is read or written until the snapshot says who is signed in.
  const scope = selfId ? `${client.baseUrl}:${selfId}` : null;
  const draftKey = scope && `drafts:${scope}`;
  const outboxKey = scope && `outbox:${scope}`;

  useEffect(() => {
    if (!draftKey || !outboxKey) return;
    let disposed = false;
    setLoaded(false);
    void Promise.all([
      platform.storage.get<Record<string, string>>(draftKey),
      platform.storage.get<StoredPending[]>(outboxKey),
    ])
      .then(([storedDrafts, storedOutbox]) => {
        if (disposed) return;
        if (storedDrafts) client.hydrateDrafts({ ...storedDrafts, ...client.state.drafts });
        if (storedOutbox?.length) client.restoreOutbox(storedOutbox);
        setLoaded(true);
      })
      .catch(() => {
        if (!disposed) setLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, [client, platform, draftKey, outboxKey]);

  // The latest value to write, read by the flush paths below without making
  // them depend on every keystroke.
  const latest = useRef({ draftKey, outboxKey, drafts, pending, loaded });
  latest.current = { draftKey, outboxKey, drafts, pending, loaded };

  useEffect(() => {
    const flush = () => {
      const { draftKey: dk, outboxKey: ok, loaded: ready } = latest.current;
      if (!ready || !dk || !ok) return;
      void platform.storage.set(dk, latest.current.drafts);
      void platform.storage.set(ok, client.outboxSnapshot());
    };
    // A debounce alone loses the last edit when the window closes or the app is
    // hidden, which on mobile is often the last thing that happens to it.
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [client, platform]);

  useEffect(() => {
    if (!loaded || !draftKey) return;
    const timer = setTimeout(() => void platform.storage.set(draftKey, drafts), 600);
    return () => clearTimeout(timer);
  }, [drafts, platform, draftKey, loaded]);

  useEffect(() => {
    if (!loaded || !outboxKey) return;
    const timer = setTimeout(
      () => void platform.storage.set(outboxKey, client.outboxSnapshot()),
      600,
    );
    return () => clearTimeout(timer);
  }, [client, pending, platform, outboxKey, loaded]);

  return null;
}
