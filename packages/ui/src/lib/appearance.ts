import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

/** "system" follows what the device prefers, light or dark. */
export const THEMES = ["system", "dark", "light", "contrast"] as const;
export type Theme = (typeof THEMES)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

interface Appearance {
  theme: Theme;
  density: Density;
  loaded: boolean;
  error: string | null;
  set: (change: Partial<Pick<Appearance, "theme" | "density">>) => Promise<void>;
}

const KEY = "appearance";
const stores = new WeakMap<Platform, ReturnType<typeof createAppearance>>();

function createAppearance(platform: Platform) {
  const store = createStore<Appearance>(() => ({
    // Dark was the only look before there was a choice, so it stays the default.
    theme: "dark",
    density: "comfortable",
    loaded: false,
    error: null,
    set: async (change) => {
      const before = store.getState();
      const next = {
        theme: change.theme ?? before.theme,
        density: change.density ?? before.density,
      };
      // Shown at once, so choosing feels like choosing; put back if it cannot be kept.
      store.setState({ ...next, error: null });
      try {
        await platform.storage.set(KEY, next);
      } catch {
        store.setState({
          theme: before.theme,
          density: before.density,
          error: "Could not save how Gatherline looks on this device. Please try again.",
        });
      }
    },
  }));
  void platform.storage
    .get<{ theme?: unknown; density?: unknown }>(KEY)
    .then((saved) => {
      store.setState({
        theme: (THEMES as readonly unknown[]).includes(saved?.theme)
          ? (saved!.theme as Theme)
          : "dark",
        density: (DENSITIES as readonly unknown[]).includes(saved?.density)
          ? (saved!.density as Density)
          : "comfortable",
        loaded: true,
      });
    })
    .catch(() => store.setState({ loaded: true }));
  return store;
}

/** How Gatherline looks on this device, across workspaces. */
export function useAppearance() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createAppearance(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}

/**
 * Puts the chosen theme and density on the document, where theme.css reads
 * them. Mounted once, at the top of the app, so every screen follows.
 */
export function useApplyAppearance(): void {
  const { theme, density } = useAppearance();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = density;
  }, [theme, density]);
}
