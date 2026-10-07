import { afterEach, describe, expect, it } from "vitest";
import { canChooseSpeaker, listMediaDevices } from "../src/devices.js";

/** What Chromium's `enumerateDevices` gives on Windows, stand-ins for the default included. */
function devices(list: { kind: MediaDeviceKind; deviceId: string; label: string }[]) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { enumerateDevices: () => Promise.resolve(list) } },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
});

describe("the devices to choose from (Voice & video)", () => {
  it("lists each device once, without the browser's stand-ins for the default", async () => {
    devices([
      { kind: "audioinput", deviceId: "default", label: "Default - Headset Microphone (USB)" },
      { kind: "audioinput", deviceId: "communications", label: "Communications - Headset (USB)" },
      { kind: "audioinput", deviceId: "mic-usb", label: "Headset Microphone (USB)" },
      { kind: "audioinput", deviceId: "mic-array", label: "Microphone Array (Realtek)" },
      { kind: "videoinput", deviceId: "cam-1", label: "Integrated Camera" },
      { kind: "audiooutput", deviceId: "default", label: "Default - Speakers (Realtek)" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Speakers (Realtek)" },
    ]);
    expect(await listMediaDevices()).toEqual({
      microphones: [
        { id: "mic-usb", label: "Headset Microphone (USB)" },
        { id: "mic-array", label: "Microphone Array (Realtek)" },
      ],
      cameras: [{ id: "cam-1", label: "Integrated Camera" }],
      speakers: [{ id: "spk-1", label: "Speakers (Realtek)" }],
      named: true,
      defaultMicrophone: "Headset Microphone (USB)",
      defaultSpeaker: "Speakers (Realtek)",
    });
  });

  it("numbers devices whose names the browser keeps back, and says it is keeping them", async () => {
    devices([
      { kind: "audioinput", deviceId: "a1", label: "" },
      { kind: "audioinput", deviceId: "a2", label: "" },
      { kind: "videoinput", deviceId: "v1", label: "" },
      // Before any permission, Chromium gives one of each kind with no id at all.
      { kind: "audiooutput", deviceId: "", label: "" },
    ]);
    const lists = await listMediaDevices();
    expect(lists.named).toBe(false);
    expect(lists.microphones.map((d) => d.label)).toEqual(["Microphone 1", "Microphone 2"]);
    expect(lists.cameras.map((d) => d.label)).toEqual(["Camera 1"]);
    expect(lists.speakers).toEqual([]);
  });

  it("lists nothing where the page cannot reach devices at all", async () => {
    const lists = await listMediaDevices();
    expect(lists).toMatchObject({ microphones: [], cameras: [], speakers: [], named: false });
  });

  it("offers a choice of speaker only where the browser can play through one", () => {
    const g = globalThis as { HTMLMediaElement?: unknown };
    const before = g.HTMLMediaElement;
    try {
      g.HTMLMediaElement = class {};
      expect(canChooseSpeaker()).toBe(false);
      g.HTMLMediaElement = class {
        setSinkId() {}
      };
      expect(canChooseSpeaker()).toBe(true);
    } finally {
      g.HTMLMediaElement = before;
    }
  });
});
