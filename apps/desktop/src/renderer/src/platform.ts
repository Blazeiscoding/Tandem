import type {
  DiscoveredServer,
  HostedWorkspaces,
  HostingStart,
  HostingStatus,
  LastHosted,
  Platform,
} from "@slackoss/ui";

interface SlackossBridge {
  downloadFile: (url: string) => Promise<void>;
  storageGet: (key: string, options?: { strict?: boolean }) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  lanSnapshot: () => Promise<DiscoveredServer[]>;
  onLanServers: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  hostingStatus: () => Promise<HostingStatus>;
  hostingStart: (opts: HostingStart) => Promise<HostingStatus>;
  hostingLastHosted: () => Promise<LastHosted | null>;
  hostingList: () => Promise<HostedWorkspaces>;
  hostingBackup: (folder: string) => Promise<{ path: string; at: number } | null>;
  hostingStop: () => Promise<void>;
  hostingOpenToAll: (opts: { inviteOnly: boolean }) => Promise<HostingStatus>;
  hostingEndOpenToAll: () => Promise<HostingStatus>;
  hostingSetInviteOnly: (inviteOnly: boolean) => Promise<HostingStatus>;
  hostingSetPublicAddress: (address: string) => Promise<HostingStatus>;
  onHostingStatus: (cb: (status: HostingStatus) => void) => () => void;
  consumeDeepLink: () => Promise<string | null>;
  onDeepLink: (cb: (url: string) => void) => () => void;
  revealWindow: () => Promise<void>;
}

declare global {
  interface Window {
    slackoss: SlackossBridge;
  }
}

/**
 * Electron prefixes a rejected handler's message with the channel it came
 * from. Where the main process wrote the message for the person reading it,
 * that prefix is noise, so it is removed before the UI ever sees it.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;
function plainly<T>(call: Promise<T>): Promise<T> {
  return call.catch((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(message.replace(IPC_PREFIX, "") || message);
  });
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
          // The renderer cannot raise a window that is minimized or closed to
          // the tray; the main process can.
          void bridge.revealWindow();
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
      list: () => bridge.hostingList(),
      backup: (folder) => plainly(bridge.hostingBackup(folder)),
      stop: () => bridge.hostingStop(),
      openToAll: (opts) => plainly(bridge.hostingOpenToAll(opts)),
      endOpenToAll: () => bridge.hostingEndOpenToAll(),
      setInviteOnly: (inviteOnly) => bridge.hostingSetInviteOnly(inviteOnly),
      setPublicAddress: (address) => plainly(bridge.hostingSetPublicAddress(address)),
      subscribe: (cb) => bridge.onHostingStatus(cb),
    },
  };
}
