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
  port?: number;
  dataDir?: string;
  lanUrls?: string[];
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
    get: <T>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  notify: (title: string, body: string) => void;
  /** Subscribe to LAN server discovery. Returns unsubscribe. Desktop only. */
  discoverLan?: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  /** "Open to LAN" — run a workspace server inside this app. Desktop only. */
  hosting?: {
    status: () => Promise<HostingStatus>;
    start: (opts: { workspaceName: string; port?: number }) => Promise<HostingStatus>;
    stop: () => Promise<void>;
  };
}

/** Browser fallback platform — used by the web client and in dev. */
export function webPlatform(): Platform {
  return {
    kind: "web",
    storage: {
      get: async <T>(key: string) => {
        try {
          const raw = localStorage.getItem(`slackoss:${key}`);
          return raw ? (JSON.parse(raw) as T) : null;
        } catch {
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
