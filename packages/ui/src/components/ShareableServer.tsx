import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { isLoopbackUrl, shareableServer, type ShareableServer } from "../lib/deeplink.js";
import { useHostingStatus } from "./HostDialog.js";

const ShareableServerContext = createContext<ShareableServer | null>(null);

/**
 * Works out, for the workspace on screen, which address the links people copy
 * should carry. Asked once rather than on each copy: a clipboard write has to
 * follow the click that asked for it, not a request to the server.
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
    // Asked once the workspace is reachable, and again after a failure only
    // when it comes back.
    if (!online || publicUrl !== undefined) return;
    let live = true;
    client.api
      .serverInfo()
      .then((info) => {
        if (live) setPublicUrl(info.publicUrl ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, online, publicUrl]);

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
