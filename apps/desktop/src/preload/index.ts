import { contextBridge, ipcRenderer } from "electron";

export interface SlackossBridge {
  downloadFile: (url: string) => Promise<void>;
  storageGet: (key: string, options?: { strict?: boolean }) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  lanSnapshot: () => Promise<unknown[]>;
  onLanServers: (cb: (servers: unknown[]) => void) => () => void;
  hostingStatus: () => Promise<unknown>;
  hostingLastHosted: () => Promise<unknown>;
  hostingList: () => Promise<unknown>;
  hostingBackup: (folder: string) => Promise<unknown>;
  hostingForget: (folder: string) => Promise<void>;
  hostingRename: (folder: string, name: string) => Promise<unknown>;
  hostingOpenFolder: (folder: string) => Promise<void>;
  hostingSetStartOnLaunch: (folder: string | null) => Promise<unknown>;
  hostingOpenAtLogin: () => Promise<unknown>;
  hostingSetOpenAtLogin: (open: boolean) => Promise<unknown>;
  hostingRestore: () => Promise<unknown>;
  hostingStart: (
    opts: { workspaceName: string; port?: number } | { folder: string; port?: number },
  ) => Promise<unknown>;
  hostingStop: () => Promise<void>;
  hostingOpenToAll: (opts: { inviteOnly: boolean }) => Promise<unknown>;
  hostingEndOpenToAll: () => Promise<unknown>;
  hostingSetInviteOnly: (inviteOnly: boolean) => Promise<unknown>;
  hostingSetPublicAddress: (address: string) => Promise<unknown>;
  onHostingStatus: (cb: (status: unknown) => void) => () => void;
  /** A gatherline:// (or legacy slackoss://) link that launched the app, if any. */
  consumeDeepLink: () => Promise<string | null>;
  onDeepLink: (cb: (url: string) => void) => () => void;
  /** Shows the window again, restored and in front. */
  revealWindow: () => Promise<void>;
}

const bridge: SlackossBridge = {
  downloadFile: (url) => ipcRenderer.invoke("file:download", url),
  storageGet: (key, options) => ipcRenderer.invoke("storage:get", key, options),
  storageSet: (key, value) => ipcRenderer.invoke("storage:set", key, value),
  lanSnapshot: () => ipcRenderer.invoke("lan:snapshot"),
  onLanServers: (cb) => {
    const listener = (_e: unknown, servers: unknown[]) => cb(servers);
    ipcRenderer.on("lan:servers", listener);
    return () => ipcRenderer.removeListener("lan:servers", listener);
  },
  hostingStatus: () => ipcRenderer.invoke("hosting:status"),
  hostingLastHosted: () => ipcRenderer.invoke("hosting:lastHosted"),
  hostingList: () => ipcRenderer.invoke("hosting:list"),
  hostingBackup: (folder) => ipcRenderer.invoke("hosting:backup", folder),
  hostingForget: (folder) => ipcRenderer.invoke("hosting:forget", folder),
  hostingRename: (folder, name) => ipcRenderer.invoke("hosting:rename", { folder, name }),
  hostingOpenFolder: (folder) => ipcRenderer.invoke("hosting:openFolder", folder),
  hostingSetStartOnLaunch: (folder) => ipcRenderer.invoke("hosting:setStartOnLaunch", folder),
  hostingOpenAtLogin: () => ipcRenderer.invoke("hosting:openAtLogin"),
  hostingSetOpenAtLogin: (open) => ipcRenderer.invoke("hosting:setOpenAtLogin", open),
  hostingRestore: () => ipcRenderer.invoke("hosting:restore"),
  hostingStart: (opts) => ipcRenderer.invoke("hosting:start", opts),
  hostingStop: () => ipcRenderer.invoke("hosting:stop"),
  hostingOpenToAll: (opts) => ipcRenderer.invoke("hosting:openToAll", opts),
  hostingEndOpenToAll: () => ipcRenderer.invoke("hosting:endOpenToAll"),
  hostingSetInviteOnly: (inviteOnly) => ipcRenderer.invoke("hosting:setInviteOnly", inviteOnly),
  hostingSetPublicAddress: (address) => ipcRenderer.invoke("hosting:setPublicAddress", address),
  onHostingStatus: (cb) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("hosting:changed", listener);
    return () => ipcRenderer.removeListener("hosting:changed", listener);
  },
  consumeDeepLink: () => ipcRenderer.invoke("deeplink:consume"),
  onDeepLink: (cb) => {
    const listener = (_e: unknown, url: string) => cb(url);
    ipcRenderer.on("deeplink", listener);
    return () => ipcRenderer.removeListener("deeplink", listener);
  },
  revealWindow: () => ipcRenderer.invoke("window:reveal"),
};

contextBridge.exposeInMainWorld("slackoss", bridge);
