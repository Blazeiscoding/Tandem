import { useEffect, useState } from "react";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";

/** Isolate draft updates from the workspace shell and its message tree. */
export function DraftPersistence({ platform }: { platform: Platform }) {
  const client = useClient();
  const drafts = useWorkspace((s) => s.drafts);
  const [loaded, setLoaded] = useState(false);
  const key = `drafts:${client.baseUrl}`;
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    void platform.storage
      .get<Record<string, string>>(key)
      .then((stored) => {
        if (disposed) return;
        if (stored) client.hydrateDrafts({ ...stored, ...client.state.drafts });
        setLoaded(true);
      })
      .catch(() => {
        if (!disposed) setLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, [client, platform, key]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => void platform.storage.set(key, drafts), 600);
    return () => clearTimeout(timer);
  }, [drafts, platform, key, loaded]);
  return null;
}
