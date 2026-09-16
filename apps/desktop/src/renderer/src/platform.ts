import type { DiscoveredServer, HostingStatus, Platform } from "@slackoss/ui";

interface SlackossBridge {
  downloadFile: (url: string) => Promise<void>;
  storageGet: (key: string, options?: { strict?: boolean }) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  lanSnapshot: () => Promise<DiscoveredServer[]>;
  onLanServers: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  hostingStatus: () => Promise<HostingStatus>;
  hostingStart: (opts: { workspaceName: string; port?: number }) => Promise<HostingStatus>;
  hostingLastHosted: () => Promise<{ workspaceName: string; port: number } | null>;
  hostingStop: () => Promise<void>;
  onHostingStatus: (cb: (status: HostingStatus) => void) => () => void;
  consumeDeepLink: () => Promise<string | null>;
  onDeepLink: (cb: (url: string) => void) => () => void;
}

declare global {
  interface Window {
    slackoss: SlackossBridge;
  }
}

export function electronPlatform(): Platform {
  const bridge = window.slackoss;
  return {
    kind: "desktop",
    downloadFile: (url) => bridge.downloadFile(url),
    storage: {
      get: async <T>(key: string, options?: { strict?: boolean }) =>
        (await bridge.storageGet(key, options)) as T | null,
      set: (key, value) => bridge.storageSet(key, value),
    },
    notify: (title, body, onClick) => {
      const note = new Notification(title, { body, silent: false });
      if (onClick) {
        note.onclick = (event) => {
          event.preventDefault();
          window.focus();
          onClick();
          note.close();
        };
      }
    },
    discoverLan: (cb) => {
      void bridge.lanSnapshot().then(cb);
      return bridge.onLanServers(cb);
    },
    deepLinks: {
      consumePending: () => bridge.consumeDeepLink(),
      subscribe: (cb) => bridge.onDeepLink(cb),
    },
    hosting: {
      status: () => bridge.hostingStatus(),
      start: (opts) => bridge.hostingStart(opts),
      lastHosted: () => bridge.hostingLastHosted(),
      stop: () => bridge.hostingStop(),
      subscribe: (cb) => bridge.onHostingStatus(cb),
    },
  };
}
