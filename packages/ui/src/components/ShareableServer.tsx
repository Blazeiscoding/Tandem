import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { isLoopbackUrl, shareableServer, type ShareableServer } from "../lib/deeplink.js";
import { useHostingStatus } from "../lib/hosting.js";

const ShareableServerContext = createContext<ShareableServer | null>(null);

/**
 * Works out, for the workspace on screen, which address the links people copy
 * should carry. Kept ready rather than fetched on copy: a clipboard write has
 * to follow the click that asked for it, not a request to the server. The
 * lightweight server-info read is repeated after reconnect, when the page
 * returns to the foreground, and occasionally while it stays open so a tunnel
 * opened or replaced elsewhere does not leave stale links behind.
 */
export function ShareableServerProvider(props: { platform: Platform; children: ReactNode }) {
  const client = useClient();
  const online = useWorkspace((s) => s.status === "online");
  const [publicUrl, setPublicUrl] = useState<string | null | undefined>(undefined);
  // Only a host looking at its own workspace through localhost needs to know
  // what else this computer answers on.
  const hosting = useHostingStatus(
    isLoopbackUrl(client.baseUrl) ? props.platform.hosting : undefined,
  );

  useEffect(() => {
    setPublicUrl(undefined);
    if (!online) return;
    let live = true;
    let revision = 0;
    let applied = 0;
    const refresh = () => {
      const request = ++revision;
      void client.api
        .serverInfo()
        .then((info) => {
          // A later successful read wins. If that later read fails, an older
          // successful response is still better than leaving the address unknown.
          if (live && request > applied) {
            applied = request;
            setPublicUrl(info.publicUrl ?? null);
          }
        })
        .catch(() => {});
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [client, online]);

  const value = useMemo(
    () => shareableServer({ baseUrl: client.baseUrl, publicUrl, hosting: hosting.status }),
    [client.baseUrl, publicUrl, hosting.status],
  );
  return (
    <ShareableServerContext.Provider value={value}>
      {props.children}
    </ShareableServerContext.Provider>
  );
}

/** The address to build shared links on, and whether it reaches only this computer. */
export function useShareableServer(): ShareableServer {
  const client = useClient();
  const shared = useContext(ShareableServerContext);
  return shared ?? shareableServer({ baseUrl: client.baseUrl });
}
