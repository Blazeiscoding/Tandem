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

export interface HostingStatus {
  running: boolean;
  phase?: "stopped" | "starting" | "running" | "stopping";
  workspaceName?: string;
  port?: number;
  dataDir?: string;
  lanUrls?: string[];
  warning?: string;
  /** Whether closing the window can keep hosting through the system tray. */
  backgroundAvailable?: boolean;
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
  notify: (title: string, body: string) => void;
  /** Hand a scoped download URL to the browser/OS; completion is managed there. */
  downloadFile?: (url: string) => Promise<void>;
  /** Subscribe to LAN server discovery. Returns unsubscribe. Desktop only. */
  discoverLan?: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  /** slackoss:// links. Desktop only — browsers have no protocol handler. */
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
    start: (opts: { workspaceName: string; port?: number }) => Promise<HostingStatus>;
    stop: () => Promise<void>;
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
    notify: (title, body) => {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body });
      }
    },
  };
}
