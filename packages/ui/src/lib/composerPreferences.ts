import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

interface Preferences {
  enterSends: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  setEnterSends: (value: boolean) => Promise<void>;
}

const KEY = "composer-preferences";
const stores = new WeakMap<Platform, ReturnType<typeof createPreferences>>();

function createPreferences(platform: Platform) {
  const store = createStore<Preferences>(() => ({
    // Until storage answers, Enter is a new line rather than an accidental send.
    enterSends: false,
    loaded: false,
    saving: false,
    error: null,
    setEnterSends: async (enterSends) => {
      if (!store.getState().loaded || store.getState().saving) return;
      store.setState({ saving: true, error: null });
      try {
        await platform.storage.set(KEY, { enterSends });
        store.setState({ enterSends });
      } catch {
        store.setState({ error: "Could not save this preference. Please try again." });
      } finally {
        store.setState({ saving: false });
      }
    },
  }));
  void platform.storage
    .get<{ enterSends?: unknown }>(KEY)
    .then((saved) => {
      store.setState({
        enterSends: typeof saved?.enterSends === "boolean" ? saved.enterSends : true,
        loaded: true,
      });
    })
    .catch(() => {
      store.setState({
        loaded: true,
        error: "Could not load your preference. Enter inserts a new line until you choose again.",
      });
    });
  return store;
}

/** Shared by every composer on this device, using the browser or desktop storage adapter. */
export function useComposerPreferences() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createPreferences(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}
