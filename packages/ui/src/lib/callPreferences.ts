import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorkspaceClient } from "@slackoss/client-core";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

interface Preferences {
  /** Join huddles with the microphone off (CALL-01). */
  joinMuted: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  unreadable: boolean;
  setJoinMuted: (value: boolean) => Promise<void>;
  retryLoad: () => Promise<void>;
  /** Every join waits for device preferences; unknown preferences keep the mic off. */
  joinHuddle: (
    client: WorkspaceClient,
    channelId: string,
    stillWanted?: () => boolean,
  ) => Promise<void>;
}

const KEY = "call-preferences";
const stores = new WeakMap<Platform, ReturnType<typeof createPreferences>>();

function createPreferences(platform: Platform) {
  let initialization: Promise<void>;
  let loadVersion = 0;
  const store: StoreApi<Preferences> = createStore<Preferences>(() => ({
    joinMuted: true,
    loaded: false,
    saving: false,
    error: null,
    unreadable: false,
    setJoinMuted: async (joinMuted) => {
      if (store.getState().saving) return;
      // An explicit acknowledged choice supersedes every older preference read.
      const version = ++loadVersion;
      const known = store.getState().loaded;
      store.setState({ saving: true, error: null });
      const writing = Promise.resolve()
        .then(() => platform.storage.set(KEY, { joinMuted }))
        .then(() => {
          if (version === loadVersion)
            store.setState({ joinMuted, loaded: true, unreadable: false });
        })
        .catch(() => {
          if (version === loadVersion)
            store.setState({
              loaded: true,
              unreadable: !known || store.getState().unreadable,
              error: "Could not save this preference. Please try again.",
            });
        })
        .finally(() => store.setState({ saving: false }));
      initialization = writing;
      return writing;
    },
    retryLoad: () => (store.getState().saving ? initialization : (initialization = load())),
    joinHuddle: async (client, channelId, stillWanted = () => true) => {
      // Wait for the latest choice, even if the read a Retry replaced stays hung.
      while (!store.getState().loaded || store.getState().saving) {
        await new Promise<void>((resolve) => {
          const unsubscribe = store.subscribe(() => {
            unsubscribe();
            resolve();
          });
        });
      }
      if (
        !stillWanted() ||
        client.state.status === "closed" ||
        client.state.status === "auth_failed" ||
        client.state.status === "password_change_required"
      )
        return;
      await client.joinHuddle(channelId, { muted: store.getState().joinMuted });
    },
  }));
  function load(): Promise<void> {
    const version = ++loadVersion;
    store.setState({ joinMuted: true, loaded: false, error: null });
    return Promise.resolve()
      .then(() => platform.storage.get<unknown>(KEY, { strict: true }))
      .then((saved) => {
        if (version !== loadVersion) return;
        if (
          saved !== null &&
          (typeof saved !== "object" ||
            Array.isArray(saved) ||
            typeof (saved as { joinMuted?: unknown }).joinMuted !== "boolean")
        )
          throw new Error("Unreadable call preferences");
        store.setState({
          joinMuted: saved !== null && (saved as { joinMuted: boolean }).joinMuted,
          loaded: true,
          unreadable: false,
        });
      })
      .catch(() => {
        if (version !== loadVersion) return;
        store.setState({
          joinMuted: true,
          loaded: true,
          unreadable: true,
          error: "Could not load your preference. Huddles start with the microphone off.",
        });
      });
  }
  initialization = load();
  return store;
}

/** How huddles start on this device, for every workspace, from the platform's storage. */
export function useCallPreferences() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createPreferences(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}
