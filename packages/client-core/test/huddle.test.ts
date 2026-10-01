import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HuddleSignal, ID } from "@slackoss/protocol";
import { HuddleSession } from "../src/huddle.js";

/**
 * Just enough WebRTC to exercise the session's own logic. The parts that
 * matter here are which transceiver a track lands on and what gets signalled —
 * not whether media actually flows, which only a real browser can tell us.
 */
interface FakeSender {
  track: unknown;
  replaceTrack: (t: unknown) => Promise<void>;
}
interface FakeReceiver {
  /** What the far side's last packet was worth, as the browser reports it. */
  level: number;
  getSynchronizationSources: () => { audioLevel: number }[];
}
interface FakeTransceiver {
  sender: FakeSender;
  receiver: FakeReceiver;
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  transceivers: FakeTransceiver[] = [];
  connectionState = "new";
  signalingState = "stable";
  closed = false;
  remoteDescription: unknown = null;
  candidates: unknown[] = [];
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: { transceiver: FakeTransceiver; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(_kind: string, _init: unknown): FakeTransceiver {
    const tx: FakeTransceiver = {
      sender: {
        track: null,
        replaceTrack(t: unknown) {
          this.track = t;
          return Promise.resolve();
        },
      },
      receiver: {
        level: 0,
        getSynchronizationSources() {
          return [{ audioLevel: this.level }];
        },
      },
    };
    this.transceivers.push(tx);
    return tx;
  }

  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "fake-offer" });
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "fake-answer" });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription(description: unknown) {
    this.remoteDescription = description;
    if (this.transceivers.length === 0) {
      this.addTransceiver("audio", {});
      this.addTransceiver("video", {});
      this.addTransceiver("video", {});
    }
    return Promise.resolve();
  }
  getTransceivers() {
    return this.transceivers;
  }
  addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }

  /** Simulates the far side's track arriving on one slot. */
  emitTrack(slot: 0 | 1 | 2): void {
    this.ontrack?.({ transceiver: this.transceivers[slot]!, track: { kind: "video" } });
  }
}

class FakeMediaStream {
  constructor(public tracks: unknown[] = []) {}
  getAudioTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

const g = globalThis as unknown as Record<string, unknown>;

/** Offers are sent after a couple of awaits; let them land before asserting. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Collects everything the session tries to send to the server. */
function makeSession(selfId: ID) {
  const sent: { to: ID; signal: HuddleSignal }[] = [];
  const session = new HuddleSession("C1", selfId, {
    send: (msg) => sent.push({ to: msg.to, signal: msg.signal }),
  });
  return { session, sent };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  g.RTCPeerConnection = FakePeerConnection;
  g.MediaStream = FakeMediaStream;
  // `navigator` is getter-only on the Node global, so define rather than assign.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve(new FakeMediaStream([{ kind: "video", stop() {} }])),
        getDisplayMedia: () => Promise.resolve(new FakeMediaStream([{ kind: "video", stop() {} }])),
      },
    },
  });
});

describe("HuddleSession", () => {
  it("buffers early ICE until the remote description is set", async () => {
    const { session } = makeSession("Z");
    const candidate = { candidate: "candidate:early", sdpMid: "0", sdpMLineIndex: 0 };
    await session.handleSignal("B", { kind: "ice", candidate });
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.candidates).toEqual([]);
    await session.handleSignal("B", { kind: "offer", sdp: "offer" });
    expect(pc.candidates).toEqual([candidate]);
    session.destroy();
  });

  it.each(["audio", "camera", "screen"])(
    "releases %s permission results after leaving",
    async (kind) => {
      const { session } = makeSession("A");
      let resolve!: (stream: MediaStream) => void;
      const pending = new Promise<MediaStream>((r) => {
        resolve = r;
      });
      const method = kind === "screen" ? "getDisplayMedia" : "getUserMedia";
      vi.spyOn(navigator.mediaDevices, method).mockReturnValue(pending);
      const stop = vi.fn();
      const task =
        kind === "audio"
          ? session.startLocalAudio()
          : kind === "camera"
            ? session.toggleCamera()
            : session.toggleScreenShare();
      session.destroy();
      resolve(new FakeMediaStream([{ stop }]) as unknown as MediaStream);
      await task;
      expect(stop).toHaveBeenCalledOnce();
      expect(session.cameraOn).toBe(false);
      expect(session.sharingScreen).toBe(false);
      session.syncParticipants(["A", "B"]);
      expect(FakePeerConnection.instances).toHaveLength(0);
    },
  );

  it.each(["audio", "camera", "screen"])(
    "says %s cannot be reached at all where the page has no way to ask",
    async (kind) => {
      // As on a page served over plain HTTP: no mediaDevices to ask.
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
      const { session } = makeSession("A");
      const task =
        kind === "audio"
          ? session.startLocalAudio()
          : kind === "camera"
            ? session.toggleCamera()
            : session.toggleScreenShare();
      await expect(task).rejects.toMatchObject({ name: "NotSupportedError" });
      expect(session.cameraOn).toBe(false);
      expect(session.sharingScreen).toBe(false);
      session.destroy();
    },
  );

  it("shares a screen as detail, keeping text sharp, and at no more than 1080p", async () => {
    const { session } = makeSession("A");
    const track: { kind: string; stop(): void; contentHint?: string } = {
      kind: "video",
      stop() {},
    };
    const capture = vi
      .spyOn(navigator.mediaDevices, "getDisplayMedia")
      .mockResolvedValue(new FakeMediaStream([track]) as unknown as MediaStream);
    await session.toggleScreenShare();
    // Without the hint, an encoder short of bandwidth blurs a screen like a face.
    expect(track.contentHint).toBe("detail");
    const video = capture.mock.calls[0]![0]!.video as MediaTrackConstraints;
    expect(video.width).toEqual({ max: 1920 });
    expect(video.height).toEqual({ max: 1080 });
    session.destroy();
  });

  it("deduplicates camera permission requests", async () => {
    const { session } = makeSession("A");
    const capture = vi.spyOn(navigator.mediaDevices, "getUserMedia");
    await Promise.all([session.toggleCamera(), session.toggleCamera()]);
    expect(capture).toHaveBeenCalledOnce();
    session.destroy();
  });
  it("gives every connection the same three slots before offering", async () => {
    const { session, sent } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    await flush();

    const pc = FakePeerConnection.instances[0]!;
    expect(pc.transceivers).toHaveLength(3);
    // "A" < "B", so this side offers.
    expect(sent.some((m) => m.signal.kind === "offer")).toBe(true);
    session.destroy();
  });

  it("lets the higher id wait to be offered to, so the two do not collide", () => {
    const { session, sent } = makeSession("Z");
    session.syncParticipants(["Z", "B"]);
    expect(sent.some((m) => m.signal.kind === "offer")).toBe(false);
    session.destroy();
  });

  it("hides a peer's video until they say they are sending it", () => {
    const { session } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    const pc = FakePeerConnection.instances[0]!;

    // Tracks arrive for every slot regardless, because the slots always exist.
    pc.emitTrack(1);
    pc.emitTrack(2);
    expect(session.state().peers[0]!.cameraStream).toBeNull();
    expect(session.state().peers[0]!.screenStream).toBeNull();

    void session.handleSignal("B", { kind: "media", camera: true, screen: false });
    expect(session.state().peers[0]!.cameraStream).not.toBeNull();
    expect(session.state().peers[0]!.screenStream).toBeNull();

    void session.handleSignal("B", { kind: "media", camera: false, screen: true });
    expect(session.state().peers[0]!.cameraStream).toBeNull();
    expect(session.state().peers[0]!.screenStream).not.toBeNull();
    session.destroy();
  });

  it("announces the camera to everyone without a new offer", async () => {
    const { session, sent } = makeSession("A");
    session.syncParticipants(["A", "B", "C"]);
    await flush();
    sent.length = 0;

    await session.toggleCamera();

    const media = sent.filter((m) => m.signal.kind === "media");
    expect(media).toHaveLength(2); // one per peer
    expect(media.every((m) => m.signal.kind === "media" && m.signal.camera)).toBe(true);
    // The whole point of fixed slots: no renegotiation.
    expect(sent.some((m) => m.signal.kind === "offer")).toBe(false);
    // The track really was attached to the camera slot on both connections.
    for (const pc of FakePeerConnection.instances) {
      expect(pc.transceivers[1]!.sender.track).not.toBeNull();
      expect(pc.transceivers[2]!.sender.track).toBeNull();
    }
    session.destroy();
  });

  it("tells a late joiner what is already being sent", async () => {
    const { session, sent } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    await session.toggleCamera();
    await flush();
    sent.length = 0;

    session.syncParticipants(["A", "B", "C"]);
    const toC = sent.filter((m) => m.to === "C" && m.signal.kind === "media");
    expect(toC).toHaveLength(1);
    expect(toC[0]!.signal).toMatchObject({ camera: true, screen: false });
    session.destroy();
  });

  it("drops anyone who leaves the room", () => {
    const { session } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    const pc = FakePeerConnection.instances[0]!;
    session.syncParticipants(["A"]);
    expect(pc.closed).toBe(true);
    expect(session.state().peers).toHaveLength(0);
    session.destroy();
  });
  it("shows a peer as talking only while their audio is loud", () => {
    vi.useFakeTimers();
    try {
      const { session } = makeSession("A");
      session.syncParticipants(["A", "B"]);
      const audioSlot = FakePeerConnection.instances[0]!.transceivers[0]!;

      expect(session.state().peers[0]!.speaking).toBe(false);
      audioSlot.receiver.level = 0.4;
      vi.advanceTimersByTime(200);
      expect(session.state().peers[0]!.speaking).toBe(true);

      // Silence holds the indicator briefly, so it does not strobe between words.
      audioSlot.receiver.level = 0;
      vi.advanceTimersByTime(300);
      expect(session.state().peers[0]!.speaking).toBe(true);
      vi.advanceTimersByTime(400);
      expect(session.state().peers[0]!.speaking).toBe(false);
      session.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the others when the microphone goes off", async () => {
    const { session, sent } = makeSession("A");
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(
      new FakeMediaStream([{ kind: "audio", enabled: true, stop() {} }]) as unknown as MediaStream,
    );
    await session.startLocalAudio();
    session.syncParticipants(["A", "B"]);
    sent.length = 0;

    session.toggleMic();
    expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: true });
    session.toggleMic();
    expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: false });
    session.destroy();
  });

  it("starts with the microphone off when asked, and says so to each peer as it connects", async () => {
    const { session, sent } = makeSession("A");
    const mic = { kind: "audio", enabled: true, stop() {} };
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(
      new FakeMediaStream([mic]) as unknown as MediaStream,
    );
    await session.startLocalAudio(true);
    expect(mic.enabled).toBe(false);
    expect(session.state().micMuted).toBe(true);

    session.syncParticipants(["A", "B"]);
    expect(sent.find((m) => m.to === "B" && m.signal.kind === "media")?.signal).toMatchObject({
      kind: "media",
      muted: true,
    });
    session.toggleMic();
    expect(mic.enabled).toBe(true);
    session.destroy();
  });

  describe("a microphone that stops mid-call (CALL-01)", () => {
    type Track = { kind: string; enabled: boolean; stop: () => void; onended?: () => void };
    const track = (): Track => ({ kind: "audio", enabled: true, stop: vi.fn() });
    const stream = (t: Track) => new FakeMediaStream([t]) as unknown as MediaStream;
    let listeners: Map<string, () => void>;

    beforeEach(() => {
      listeners = new Map();
      Object.assign(navigator.mediaDevices, {
        addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
        removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      });
    });

    async function inCall(first: Track) {
      const { session, sent } = makeSession("A");
      const ask = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream(first));
      await session.startLocalAudio();
      session.syncParticipants(["A", "B"]);
      await flush();
      return { session, sent, ask, pc: FakePeerConnection.instances[0]! };
    }

    it("sends everyone the system's microphone in its place, muted as it was", async () => {
      const unplugged = track();
      const { session, ask, pc } = await inCall(unplugged);
      expect(pc.transceivers[0]!.sender.track).toBe(unplugged);
      session.toggleMic();

      const next = track();
      ask.mockResolvedValueOnce(stream(next));
      unplugged.onended!();
      await flush();
      await flush();
      expect(ask).toHaveBeenCalledTimes(2);
      expect(pc.transceivers[0]!.sender.track).toBe(next);
      expect(next.enabled).toBe(false);
      expect(session.state()).toMatchObject({ micMuted: true, micLost: false });
      session.destroy();
    });

    it("says so when there is none, tells the others it is muted, and takes the next plugged in", async () => {
      const unplugged = track();
      const { session, sent, ask, pc } = await inCall(unplugged);
      sent.length = 0;
      ask.mockRejectedValueOnce(new DOMException("Requested device not found", "NotFoundError"));
      unplugged.onended!();
      await flush();
      expect(session.state().micLost).toBe(true);
      expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: true });

      const plugged = track();
      ask.mockResolvedValueOnce(stream(plugged));
      listeners.get("devicechange")!();
      await flush();
      await flush();
      expect(session.state()).toMatchObject({ micMuted: false, micLost: false });
      expect(pc.transceivers[0]!.sender.track).toBe(plugged);
      expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: false });
      expect(listeners.has("devicechange")).toBe(false);
      session.destroy();
    });

    it("stops listening for microphones once the huddle ends", async () => {
      const unplugged = track();
      const { session, ask } = await inCall(unplugged);
      ask.mockRejectedValueOnce(new DOMException("Requested device not found", "NotFoundError"));
      unplugged.onended!();
      await flush();
      expect(listeners.has("devicechange")).toBe(true);
      session.destroy();
      expect(listeners.has("devicechange")).toBe(false);
    });
  });

  it("takes a peer's word for whether they are muted", () => {
    const { session } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    expect(session.state().peers[0]!.micMuted).toBe(false);

    void session.handleSignal("B", { kind: "media", camera: false, screen: false, muted: true });
    expect(session.state().peers[0]!.micMuted).toBe(true);

    // A client from before the field simply does not say, and is not muted.
    void session.handleSignal("B", { kind: "media", camera: false, screen: false });
    expect(session.state().peers[0]!.micMuted).toBe(false);
    session.destroy();
  });
});
