import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

/**
 * How much a message notification shows (IMP-03): the message, only who sent
 * it and where, or nothing but that something arrived, for a screen others
 * can see.
 */
export type NotificationPreview = "full" | "sender" | "none";

export const NOTIFICATION_PREVIEWS: readonly {
  id: NotificationPreview;
  label: string;
  example: string;
}[] = [
  {
    id: "full",
    label: "The message",
    example: "Priya Shah in #design: The launch moves to Friday",
  },
  { id: "sender", label: "Only who sent it", example: "Priya Shah in #design: New message" },
  { id: "none", label: "Nothing about it", example: "New message" },
];

/** What a notification says under each choice. */
export function notificationContent(
  preview: NotificationPreview,
  message: { from: string; channelName?: string; body: string },
): { title: string; body: string } {
  if (preview === "none") return { title: "New message", body: "Open Gatherline to read it." };
  const title = `${message.from}${message.channelName ? ` in #${message.channelName}` : ""}`;
  return { title, body: preview === "full" ? message.body : "New message" };
}

/** One account on one server: the choice is per workspace, not per device. */
export function previewAccount(serverUrl: string, userId: string): string {
  return `${serverUrl.replace(/\/+$/, "")} ${userId}`;
}

interface Previews {
  byAccount: Record<string, NotificationPreview>;
  loaded: boolean;
  /** The saved choices could not be read, so none of them is known. */
  unreadable: boolean;
  saving: boolean;
  error: string | null;
  setPreview: (account: string, preview: NotificationPreview) => Promise<void>;
}

const KEY = "notification-previews";
const isPreview = (value: unknown): value is NotificationPreview =>
  value === "full" || value === "sender" || value === "none";
const stores = new WeakMap<Platform, ReturnType<typeof createPreviews>>();

function createPreviews(platform: Platform) {
  const store = createStore<Previews>(() => ({
    byAccount: {},
    loaded: false,
    unreadable: false,
    saving: false,
    error: null,
    setPreview: async (account, preview) => {
      const { loaded, saving, byAccount } = store.getState();
      if (!loaded || saving) return;
      const next = { ...byAccount, [account]: preview };
      store.setState({ saving: true, error: null });
      try {
        await platform.storage.set(KEY, next);
        store.setState({ byAccount: next, unreadable: false });
      } catch {
        store.setState({ error: "Could not save this choice. Please try again." });
      } finally {
        store.setState({ saving: false });
      }
    },
  }));
  void platform.storage
    .get<Record<string, unknown>>(KEY)
    .then((saved) => {
      const byAccount: Record<string, NotificationPreview> = {};
      for (const [account, value] of Object.entries(saved ?? {}))
        if (isPreview(value)) byAccount[account] = value;
      store.setState({ byAccount, loaded: true });
    })
    .catch(() => {
      store.setState({
        loaded: true,
        unreadable: true,
        error:
          "Could not read your choice, so notifications show nothing about messages until you choose again.",
      });
    });
  return store;
}

/** Every account's choice on this device, from the platform's storage. */
export function useNotificationPreviews() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createPreviews(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}

/**
 * The choice in force for an account. Until the saved choice is read, or when
 * it cannot be, the most private one applies: catching up after starting can
 * notify at once, and must not show what someone chose to hide.
 */
export function previewFor(
  previews: Pick<Previews, "loaded" | "unreadable" | "byAccount">,
  account: string | null,
): NotificationPreview {
  if (!previews.loaded || (previews.unreadable && !(account && previews.byAccount[account])))
    return "none";
  return (account && previews.byAccount[account]) || "full";
}
