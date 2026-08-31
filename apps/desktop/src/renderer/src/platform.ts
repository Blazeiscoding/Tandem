import type { DiscoveredServer, HostingStatus, Platform } from "@slackoss/ui";

interface SlackossBridge {
  storageGet: (key: string) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  lanSnapshot: () => Promise<DiscoveredServer[]>;
  onLanServers: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  hostingStatus: () => Promise<HostingStatus>;
  hostingStart: (opts: { workspaceName: string; port?: number }) => Promise<HostingStatus>;
  hostingStop: () => Promise<void>;
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
    storage: {
      get: async <T>(key: string) => (await bridge.storageGet(key)) as T | null,
      set: (key, value) => bridge.storageSet(key, value),
    },
    notify: (title, body) => {
      new Notification(title, { body, silent: false });
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
      stop: () => bridge.hostingStop(),
    },
  };
}
