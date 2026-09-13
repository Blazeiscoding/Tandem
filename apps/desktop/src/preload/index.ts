import { contextBridge, ipcRenderer } from "electron";

export interface SlackossBridge {
  downloadFile: (url: string) => Promise<void>;
  storageGet: (key: string, options?: { strict?: boolean }) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  lanSnapshot: () => Promise<unknown[]>;
  onLanServers: (cb: (servers: unknown[]) => void) => () => void;
  hostingStatus: () => Promise<unknown>;
  hostingStart: (opts: { workspaceName: string; port?: number }) => Promise<unknown>;
  hostingStop: () => Promise<void>;
  onHostingStatus: (cb: (status: unknown) => void) => () => void;
  /** A slackoss:// link that launched the app, if any. */
  consumeDeepLink: () => Promise<string | null>;
  onDeepLink: (cb: (url: string) => void) => () => void;
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
  hostingStart: (opts) => ipcRenderer.invoke("hosting:start", opts),
  hostingStop: () => ipcRenderer.invoke("hosting:stop"),
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
};

contextBridge.exposeInMainWorld("slackoss", bridge);
