import { parseDeepLink } from "./lib/deeplink.js";

/** A workspace server found on the local network via mDNS. */
export interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  serverVersion: string;
}

export interface SavedServer {
  url: string;
  token: string;
  workspaceName: string;
  handle: string;
  lastUsedAt: number;
}

/**
 * What starts hosting: `folder` for a workspace already hosted on this
 * computer, or `workspaceName` for a new one. A name never finds an old one.
 */
export type HostingStart = ({ folder: string } | { workspaceName: string }) & { port?: number };

/** The workspace this computer hosted most recently. */
export interface LastHosted {
  /** Absent from an app older than the list of hosted workspaces. */
  folder?: string;
  workspaceName: string;
  port: number;
}

/** Every workspace hosted on this computer, most recent first. */
export interface HostedWorkspaces {
  workspaces: {
    folder: string;
    name: string;
    port: number;
    lastHostedAt: number;
    /** When a backup of it last finished, or null if none has on this computer. */
    lastBackupAt: number | null;
    running: boolean;
    /** Its folder is gone, so it cannot start. */
    missing: boolean;
  }[];
  /** Folders holding a workspace that could not be read. */
  unreadable: string[];
}

export interface HostingStatus {
  running: boolean;
  phase?: "stopped" | "starting" | "running" | "stopping";
  workspaceName?: string;
  /** The running workspace's entry in the list of hosted workspaces. */
  folder?: string;
  port?: number;
  dataDir?: string;
  lanUrls?: string[];
  warning?: string;
  /** Whether closing the window can keep hosting through the system tray. */
  backgroundAvailable?: boolean;
  /** A public address, while Cloudflare Tunnel is opening or open. */
  openToAll?: { phase: "opening" } | { phase: "open"; url: string };
  /** Why the last attempt to open the public address failed or ended. */
  openToAllError?: string;
  /** Whether cloudflared is installed where the desktop app can find it. */
  tunnelAvailable?: boolean;
  /** A configured address that stays the same each time the link is opened. */
  publicAddress?: string;
  /** What the public address setting holds, valid or not, for editing. */
  publicAddressSetting?: string;
  /** Whether the environment set the address, so this app cannot change it. */
  publicAddressLocked?: boolean;
  /** Whether Gatherline runs the connector for it, rather than something else. */
  publicAddressManaged?: boolean;
  /** Safe setup instructions when the stable address configuration cannot be used. */
  publicAddressError?: string;
  /** Whether new accounts need an invite code. */
  inviteOnly?: boolean;
}

/**
 * What the surrounding shell (Electron app, browser) provides to the UI.
 * Everything optional degrades gracefully — the web client has no LAN
 * discovery or hosting.
 */
export interface Platform {
  /** "desktop" gets the frameless titlebar spacing; "web" does not. */
  kind: "desktop" | "web";
  storage: {
    /** Strict reads must reject unreadable data instead of treating it as absent. */
    get: <T>(key: string, options?: { strict?: boolean }) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  notify: (title: string, body: string, onClick?: () => void) => void;
  /** Hand a scoped download URL to the browser/OS; completion is managed there. */
  downloadFile?: (url: string) => Promise<void>;
  /** Subscribe to LAN server discovery. Returns unsubscribe. Desktop only. */
  discoverLan?: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  /**
   * Links to join a workspace or open a message: gatherline:// ones (the
   * previous slackoss:// form still reads) in the desktop app, and the
   * address a browser was opened at.
   */
  deepLinks?: {
    /** A link that launched the app, consumed once. */
    consumePending: () => Promise<string | null>;
    /** Links arriving while the app is already running. */
    subscribe: (cb: (url: string) => void) => () => void;
  };
  /** "Open to LAN" — run a workspace server inside this app. Desktop only. */
  hosting?: {
    status: () => Promise<HostingStatus>;
    subscribe?: (cb: (status: HostingStatus) => void) => () => void;
    start: (opts: HostingStart) => Promise<HostingStatus>;
    stop: () => Promise<void>;
    /** Publish/unpublish the hosted workspace at a public address. */
    openToAll?: (opts: { inviteOnly: boolean }) => Promise<HostingStatus>;
    endOpenToAll?: () => Promise<HostingStatus>;
    /** Change whether new accounts need an invite while the server is running. */
    setInviteOnly?: (inviteOnly: boolean) => Promise<HostingStatus>;
    /**
     * Save an address something else already carries to this workspace, or
     * clear it with "" to go back to a temporary one. Rejects what cannot be
     * published, so the setting never holds an address that will not work.
     */
    setPublicAddress?: (address: string) => Promise<HostingStatus>;
    /** The workspace this computer hosted last, if it remembers. */
    lastHosted?: () => Promise<LastHosted | null>;
    /** Every workspace hosted on this computer. Absent from apps older than the list. */
    list?: () => Promise<HostedWorkspaces>;
    /**
     * Asks where to save a backup of a hosted workspace, running or not, and
     * makes it there. Null when no folder was chosen.
     */
    backup?: (folder: string) => Promise<{ path: string; at: number } | null>;
  };
}

/** Browser fallback platform — used by the web client and in dev. */
export function webPlatform(): Platform {
  return {
    kind: "web",
    downloadFile: async (url) => {
      // A failed redemption must not replace the workspace page. Downloads
      // from an attachment response are handed to the browser's download UI.
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.title = "File download";
      frame.referrerPolicy = "no-referrer";
      frame.src = url;
      document.body.append(frame);
      setTimeout(() => frame.remove(), 300_000);
    },
    storage: {
      get: async <T>(key: string, options?: { strict?: boolean }) => {
        try {
          const raw = localStorage.getItem(`slackoss:${key}`);
          return raw === null ? null : (JSON.parse(raw) as T);
        } catch (error) {
          if (options?.strict) throw error;
          return null;
        }
      },
      set: async (key, value) => {
        localStorage.setItem(`slackoss:${key}`, JSON.stringify(value));
      },
    },
    notify: (title, body, onClick) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const note = new Notification(title, { body });
      if (onClick) {
        note.onclick = (event) => {
          event.preventDefault();
          window.focus();
          onClick();
          note.close();
        };
      }
    },
    deepLinks: {
      consumePending: async () => takeLinkFromAddress(),
      subscribe: (cb) => {
        // A link pasted into the address bar of a page already open changes
        // only the fragment, which loads nothing.
        const onHashChange = () => {
          const link = takeLinkFromAddress();
          if (link) cb(link);
        };
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
      },
    },
  };
}

/**
 * The link this page was opened at, such as <server>/#/join/<code>. It is taken
 * out of the address once read, so a reload does not act on it again and an
 * invite code does not stay in the address bar or the history.
 */
function takeLinkFromAddress(): string | null {
  const { href, pathname, search } = window.location;
  if (!parseDeepLink(href)) return null;
  history.replaceState(history.state, "", pathname + search);
  return href;
}
