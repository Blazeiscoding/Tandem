import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { MicrophoneSettings, WorkspaceClient } from "@slackoss/client-core";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";
import { noiseFilter } from "./noiseFilter.js";

/**
 * The devices a huddle uses and how it cleans up the microphone's sound,
 * from Voice & video settings. Anything missing is the system's default.
 */
export interface CallDevices {
  microphoneId?: string;
  cameraId?: string;
  speakerId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  /** Strong noise suppression in place of the browser's own; see MicrophoneSettings. */
  noiseFilter?: boolean;
  autoGainControl?: boolean;
}

interface Preferences {
  /** Join huddles with the microphone off (CALL-01). */
  joinMuted: boolean;
  devices: CallDevices;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  unreadable: boolean;
  setJoinMuted: (value: boolean) => Promise<void>;
  /** Saves device choices; a key set to undefined goes back to the default. */
  setDevices: (patch: CallDevices) => Promise<void>;
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

/**
 * Only what was chosen: ids that are names, switches that are on or off.
 * Anything else is dropped rather than making the whole preference
 * unreadable, which would also forget whether to join muted.
 */
function devicesOf(saved: Record<string, unknown>): CallDevices {
  const devices: Record<string, string | boolean> = {};
  for (const key of ["microphoneId", "cameraId", "speakerId"]) {
    const value = saved[key];
    if (typeof value === "string" && value) devices[key] = value;
  }
  for (const key of ["echoCancellation", "noiseSuppression", "noiseFilter", "autoGainControl"]) {
    const value = saved[key];
    if (typeof value === "boolean") devices[key] = value;
  }
  return devices as CallDevices;
}

/** The microphone a huddle opens, as the session takes it. */
export function microphoneOf({
  microphoneId,
  cameraId: _camera,
  speakerId: _speaker,
  ...processing
}: CallDevices): MicrophoneSettings {
  return microphoneId ? { deviceId: microphoneId, ...processing } : processing;
}

function createPreferences(platform: Platform) {
  let initialization: Promise<void>;
  let loadVersion = 0;
  const write = (joinMuted: boolean, devices: CallDevices) => {
    if (store.getState().saving) return initialization;
    // An explicit acknowledged choice supersedes every older preference read.
    const version = ++loadVersion;
    const known = store.getState().loaded;
    store.setState({ saving: true, error: null });
    const writing = Promise.resolve()
      .then(() => platform.storage.set(KEY, { joinMuted, ...devices }))
      .then(() => {
        if (version === loadVersion)
          store.setState({ joinMuted, devices, loaded: true, unreadable: false });
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
  };
  const store: StoreApi<Preferences> = createStore<Preferences>(() => ({
    joinMuted: true,
    devices: {},
    loaded: false,
    saving: false,
    error: null,
    unreadable: false,
    setJoinMuted: (joinMuted) => write(joinMuted, store.getState().devices),
    setDevices: (patch) => {
      const { joinMuted, devices } = store.getState();
      return write(joinMuted, devicesOf({ ...devices, ...patch }));
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
      const { joinMuted, devices } = store.getState();
      const microphone = microphoneOf(devices);
      await client.joinHuddle(channelId, {
        muted: joinMuted,
        ...(Object.keys(microphone).length > 0 ? { microphone } : {}),
        ...(devices.cameraId ? { cameraId: devices.cameraId } : {}),
        noiseFilter,
      });
    },
  }));
  function load(): Promise<void> {
    const version = ++loadVersion;
    store.setState({ joinMuted: true, devices: {}, loaded: false, error: null });
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
          devices: saved === null ? {} : devicesOf(saved as Record<string, unknown>),
          loaded: true,
          unreadable: false,
        });
      })
      .catch(() => {
        if (version !== loadVersion) return;
        store.setState({
          joinMuted: true,
          devices: {},
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
