import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

interface Preferences {
  /** Join huddles with the microphone off (CALL-01). */
  joinMuted: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  setJoinMuted: (value: boolean) => Promise<void>;
}

const KEY = "call-preferences";
const stores = new WeakMap<Platform, ReturnType<typeof createPreferences>>();

function createPreferences(platform: Platform) {
  const store = createStore<Preferences>(() => ({
    joinMuted: false,
    loaded: false,
    saving: false,
    error: null,
    setJoinMuted: async (joinMuted) => {
      if (!store.getState().loaded || store.getState().saving) return;
      store.setState({ saving: true, error: null });
      try {
        await platform.storage.set(KEY, { joinMuted });
        store.setState({ joinMuted });
      } catch {
        store.setState({ error: "Could not save this preference. Please try again." });
      } finally {
        store.setState({ saving: false });
      }
    },
  }));
  void platform.storage
    .get<{ joinMuted?: unknown }>(KEY)
    .then((saved) => {
      store.setState({ joinMuted: saved?.joinMuted === true, loaded: true });
    })
    .catch(() => {
      store.setState({
        loaded: true,
        error: "Could not load your preference. Huddles start with the microphone on.",
      });
    });
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
