import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { HuddleSignal, ModalView } from "@slackoss/protocol";
import { HuddleSession } from "../../../packages/client-core/src/huddle.js";

const evidence: Record<string, unknown> = {
  revision: "cd3af584ba46adace45465cb5e5c66afb238b01c",
  scope:
    "Production session/client logic with synthetic media capture and request completions; no real media transport or server.",
};
const sessions: HuddleSession[] = [];
const clients: WorkspaceClient[] = [];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
type Track = {
  kind: string;
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};
const track = (): Track => ({ kind: "audio", enabled: true, stop: vi.fn(), onended: null });
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return [];
  }
}
class Peer {
  static instances: Peer[] = [];
  transceivers: {
    sender: { track: unknown; replaceTrack: (track: unknown) => Promise<void> };
    receiver: { getSynchronizationSources: () => [] };
  }[] = [];
  connectionState = "new";
  signalingState = "stable";
  constructor() {
    Peer.instances.push(this);
  }
  addTransceiver() {
    const sender = {
      track: null as unknown,
      replaceTrack: async (next: unknown) => {
        sender.track = next;
      },
    };
    const tx = { sender, receiver: { getSynchronizationSources: (): [] => [] } };
    this.transceivers.push(tx);
    return tx;
  }
  getTransceivers() {
    return this.transceivers;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "synthetic" });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  close() {}
}
beforeEach(() => {
  Peer.instances = [];
  vi.stubGlobal("AudioContext", undefined);
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() =>
  writeFileSync(
    new URL("./client-state-evidence.json", import.meta.url),
    JSON.stringify(evidence, null, 2) + "\n",
  ),
);

async function call(muted = false) {
  const original = track();
  const ask = vi.mocked(navigator.mediaDevices.getUserMedia);
  ask.mockResolvedValueOnce(new Stream([original]) as unknown as MediaStream);
  const sent: HuddleSignal[] = [];
  const session = new HuddleSession("C_SYNTHETIC", "A", {
    send: (frame) => sent.push(frame.signal),
  });
  sessions.push(session);
  await session.startLocalAudio(muted);
  session.syncParticipants(["A", "B"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { session, ask, sent, original, sender: Peer.instances[0]!.transceivers[0]!.sender };
}
const modal = (id: string): ModalView => ({
  id,
  callbackId: id,
  title: id,
  submitLabel: "Submit",
  closeLabel: "Cancel",
  privateMetadata: "",
  text: "",
  fields: [],
});

describe("new client lifetime boundaries", () => {
  it("diagnostic: a mute chosen during microphone replacement is undone", async () => {
    const { session, ask, sent, original, sender } = await call();
    const capture = deferred<MediaStream>();
    ask.mockReturnValueOnce(capture.promise);
    const replacement = session.recoverMicrophone();
    session.toggleMic();
    expect(session.micMuted).toBe(true);
    const next = track();
    capture.resolve(new Stream([next]) as unknown as MediaStream);
    expect(await replacement).toBe(true);
    expect(session.micMuted).toBe(false);
    expect(next.enabled).toBe(true);
    expect(sender.track).toBe(next);
    expect(original.stop).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ kind: "media", muted: false });
    evidence.muteDuringReplacement = {
      mutedWhileCapturePending: true,
      mutedAfterReplacement: session.micMuted,
      replacementTrackEnabled: next.enabled,
      replacementAttachedToSender: sender.track === next,
      finalMediaSignal: sent.at(-1),
    };
  });
  it("control: a mute chosen before replacement stays muted", async () => {
    const { session, ask, sender } = await call(true);
    const next = track();
    ask.mockResolvedValueOnce(new Stream([next]) as unknown as MediaStream);
    expect(await session.recoverMicrophone()).toBe(true);
    expect(next.enabled).toBe(false);
    expect(session.micMuted).toBe(true);
    expect(sender.track).toBe(next);
    evidence.mutedReplacementControl = {
      replacementTrackEnabled: next.enabled,
      micMuted: session.micMuted,
    };
  });
  it("control: leaving during replacement stops its returned microphone", async () => {
    const { session, ask } = await call();
    const capture = deferred<MediaStream>();
    ask.mockReturnValueOnce(capture.promise);
    const replacement = session.recoverMicrophone();
    session.destroy();
    const next = track();
    capture.resolve(new Stream([next]) as unknown as MediaStream);
    expect(await replacement).toBe(false);
    expect(next.stop).toHaveBeenCalledOnce();
    evidence.destroyedReplacementControl = {
      returnedTrackStopped: next.stop.mock.calls.length,
      replacementAccepted: false,
    };
  });
  it("diagnostic: completing submission A closes a newer modal B", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-only");
    clients.push(client);
    client.store.setState({ modal: modal("V_A") });
    const answer = deferred<{ ok: boolean }>();
    const submit = vi.spyOn(client.api, "submitView").mockReturnValueOnce(answer.promise);
    const pending = client.submitModal({ details: { value: "For A" } });
    expect(submit).toHaveBeenCalledWith("V_A", { details: { value: "For A" } });
    client.dismissModal();
    client.store.setState({ modal: modal("V_B") });
    answer.resolve({ ok: true });
    await pending;
    expect(client.state.modal).toBeNull();
    evidence.staleModalSubmission = {
      submittedViewId: submit.mock.calls[0]![0],
      currentBeforeOldAnswer: "V_B",
      currentAfterOldAnswer: client.state.modal,
    };
  });
});
