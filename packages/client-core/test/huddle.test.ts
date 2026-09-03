import { beforeEach, describe, expect, it } from "vitest";
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
interface FakeTransceiver {
  sender: FakeSender;
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  transceivers: FakeTransceiver[] = [];
  connectionState = "new";
  signalingState = "stable";
  closed = false;
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
  setRemoteDescription() {
    return Promise.resolve();
  }
  addIceCandidate() {
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
        getDisplayMedia: () =>
          Promise.resolve(new FakeMediaStream([{ kind: "video", stop() {} }])),
      },
    },
  });
});

describe("HuddleSession", () => {
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
});
