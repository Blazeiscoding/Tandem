/**
 * Which microphone a huddle opens, and how the browser cleans up its sound
 * (Voice & video settings). Everything missing means the browser's default.
 */
export interface MicrophoneSettings {
  /** The device to open; missing or empty for the system's default. */
  deviceId?: string;
  /** Takes the other people's voices back out of the microphone. */
  echoCancellation?: boolean;
  /** Takes out steady background noise: fans, hum, keyboards. */
  noiseSuppression?: boolean;
  /** Evens out a voice that is too quiet or too loud. */
  autoGainControl?: boolean;
}

/**
 * Names the device the browser should open. A saved choice asks for it
 * loosely, so a headset left at home falls back to the default rather than
 * failing the call; a choice made just now asks exactly, so a device that
 * will not open says so instead of quietly opening another.
 */
function device(deviceId: string | undefined, exact: boolean) {
  if (!deviceId) return {};
  return { deviceId: exact ? { exact: deviceId } : deviceId };
}

/** What a huddle asks the browser for when it opens the microphone. */
export function microphoneConstraints(
  settings: MicrophoneSettings = {},
  exact = false,
): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: settings.echoCancellation ?? true,
      noiseSuppression: settings.noiseSuppression ?? true,
      autoGainControl: settings.autoGainControl ?? true,
      ...device(settings.deviceId, exact),
    },
    video: false,
  };
}

/** What a huddle asks the browser for when it opens the camera. */
export function cameraConstraints(deviceId?: string, exact = false): MediaStreamConstraints {
  return {
    video: {
      // 360p went soft as soon as a tile was bigger than a thumbnail. The
      // encoder still steps down on its own when the network cannot keep up.
      width: { ideal: 960, max: 1280 },
      height: { ideal: 540, max: 720 },
      frameRate: { ideal: 24, max: 30 },
      ...device(deviceId, exact),
    },
    audio: false,
  };
}

export interface MediaDeviceOption {
  id: string;
  label: string;
}

/** The devices this computer has, for choosing between them. */
export interface MediaDeviceLists {
  microphones: MediaDeviceOption[];
  cameras: MediaDeviceOption[];
  speakers: MediaDeviceOption[];
  /**
   * Whether the browser gave the devices' names. It keeps them back until a
   * page has been allowed the microphone or camera once.
   */
  named: boolean;
  /** What the system's default microphone and speaker are called, where it says. */
  defaultMicrophone: string;
  defaultSpeaker: string;
}

/** Chromium's stand-ins for whatever the system's default is, not devices of their own. */
const ALIASES = new Set(["", "default", "communications"]);

/** Every microphone, camera and speaker, without the browser's stand-ins for the default. */
export async function listMediaDevices(): Promise<MediaDeviceLists> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const of = (kind: MediaDeviceKind, noun: string) =>
    all
      .filter((d) => d.kind === kind && !ALIASES.has(d.deviceId))
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${noun} ${i + 1}` }));
  const defaultOf = (kind: MediaDeviceKind) =>
    all
      .find((d) => d.kind === kind && d.deviceId === "default")
      ?.label.replace(/^Default - /, "") ?? "";
  return {
    microphones: of("audioinput", "Microphone"),
    cameras: of("videoinput", "Camera"),
    speakers: of("audiooutput", "Speaker"),
    named: all.some((d) => d.label !== ""),
    defaultMicrophone: defaultOf("audioinput"),
    defaultSpeaker: defaultOf("audiooutput"),
  };
}

/** Whether this browser can play sound through a speaker other than the default. */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}
