import type { OutboxChanges, StoredOutbox } from "@slackoss/client-core";
import type {
  AutoBackup,
  DiscoveredServer,
  HostedWorkspaces,
  HostingStart,
  HostingStatus,
  LastHosted,
  Platform,
  RestoreInventory,
} from "@slackoss/ui";

interface SlackossBridge {
  downloadFile: (url: string) => Promise<void>;
  storageGet: (key: string, options?: { strict?: boolean }) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  storageMergeOutbox: (
    key: string,
    changes: OutboxChanges,
    enveloped: boolean,
  ) => Promise<StoredOutbox>;
  onOutboxChanged: (cb: (key: string, stored: unknown) => void) => () => void;
  lanSnapshot: () => Promise<DiscoveredServer[]>;
  onLanServers: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  hostingStatus: () => Promise<HostingStatus>;
  hostingStart: (opts: HostingStart) => Promise<HostingStatus>;
  hostingLastHosted: () => Promise<LastHosted | null>;
  hostingList: () => Promise<HostedWorkspaces>;
  hostingBackup: (folder: string) => Promise<{ path: string; at: number } | null>;
  hostingForget: (folder: string) => Promise<void>;
  hostingRename: (folder: string, name: string) => Promise<{ folder: string; name: string }>;
  hostingOpenFolder: (folder: string) => Promise<void>;
  hostingSetStartOnLaunch: (folder: string | null) => Promise<string | null>;
  hostingSetReopenPublicOnLaunch: (reopen: boolean) => Promise<boolean>;
  hostingDismissLaunchError: () => Promise<unknown>;
  hostingSetPort: (folder: string, port: number) => Promise<{ folder: string; port: number }>;
  hostingSetAutoBackup: (
    folder: string,
    schedule: { everyDays: 1 | 7; keep: number } | null,
    chooseFolder: boolean,
  ) => Promise<AutoBackup | null | undefined>;
  hostingOpenAtLogin: () => Promise<boolean | null>;
  hostingSetOpenAtLogin: (open: boolean) => Promise<boolean>;
  hostingRestore: () => Promise<{
    folder: string;
    name: string;
    inventory?: RestoreInventory | null;
  } | null>;
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
      // Merged in the main process, where every window's writes wait their turn.
      mergeOutbox: (key, changes, enveloped) => bridge.storageMergeOutbox(key, changes, enveloped),
      watchOutbox: (key, cb) =>
        bridge.onOutboxChanged((changed, stored) => {
          if (changed === key) cb(stored);
        }),
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
      // Its refusals are the controller's own words, and the window shows them.
      start: (opts) => plainly(bridge.hostingStart(opts)),
      setPort: (folder, port) => plainly(bridge.hostingSetPort(folder, port)),
      setAutoBackup: (folder, schedule, chooseFolder) =>
        plainly(bridge.hostingSetAutoBackup(folder, schedule, chooseFolder)),
      lastHosted: () => bridge.hostingLastHosted(),
      list: () => bridge.hostingList(),
      backup: (folder) => plainly(bridge.hostingBackup(folder)),
      forget: (folder) => plainly(bridge.hostingForget(folder)),
      rename: (folder, name) => plainly(bridge.hostingRename(folder, name)),
      openFolder: (folder) => plainly(bridge.hostingOpenFolder(folder)),
      setReopenPublicOnLaunch: (reopen) => plainly(bridge.hostingSetReopenPublicOnLaunch(reopen)),
      dismissLaunchError: async () => {
        await plainly(bridge.hostingDismissLaunchError());
      },
      setStartOnLaunch: async (folder) => {
        await plainly(bridge.hostingSetStartOnLaunch(folder));
      },
      openAtLogin: {
        get: () => bridge.hostingOpenAtLogin(),
        set: (open) => plainly(bridge.hostingSetOpenAtLogin(open)),
      },
      restore: () => plainly(bridge.hostingRestore()),
      stop: () => bridge.hostingStop(),
      openToAll: (opts) => plainly(bridge.hostingOpenToAll(opts)),
      endOpenToAll: () => bridge.hostingEndOpenToAll(),
      setInviteOnly: (inviteOnly) => bridge.hostingSetInviteOnly(inviteOnly),
      setPublicAddress: (address) => plainly(bridge.hostingSetPublicAddress(address)),
      subscribe: (cb) => bridge.onHostingStatus(cb),
    },
  };
}
