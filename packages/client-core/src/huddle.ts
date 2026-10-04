import { shouldInitiateOffer, type HuddleSignal, type ID } from "@slackoss/protocol";

export interface HuddlePeer {
  userId: ID;
  /** Their microphone. Always attach it, even when there is no video. */
  audioStream: MediaStream | null;
  /** Their camera, or null while it is off. */
  cameraStream: MediaStream | null;
  /** What they are sharing, or null while they are not. */
  screenStream: MediaStream | null;
  /** True once the connection is carrying media. */
  connected: boolean;
  /** Their microphone is off, as they reported it. */
  micMuted: boolean;
  /** They are talking right now. */
  speaking: boolean;
}

export interface HuddleState {
  channelId: ID;
  micMuted: boolean;
  cameraOn: boolean;
  sharingScreen: boolean;
  /** Your own camera, for the self-view tile. */
  localCameraStream: MediaStream | null;
  /** Your own share, so you can see what everyone else is seeing. */
  localScreenStream: MediaStream | null;
  /** You are talking right now. */
  speaking: boolean;
  /**
   * Your microphone stopped, unplugged or its permission taken back, and no
   * other could be had: nobody can hear you until one is (CALL-01).
   */
  micLost: boolean;
  peers: HuddlePeer[];
}

/** How the huddle reaches the server; supplied by WorkspaceClient. */
export interface HuddleTransport {
  send: (msg: { type: "huddle.signal"; channelId: ID; to: ID; signal: HuddleSignal }) => void;
}

/**
 * Loud enough to count as talking, and how long a tile keeps saying so after
 * the last loud sample. Without the hold the indicator strobes in the gaps
 * between syllables, which is worse than not having it.
 */
const SPEAKING_LEVEL = 0.02;
const SPEAKING_HOLD_MS = 500;
const LEVEL_POLL_MS = 120;

/**
 * How loud a peer's last audio packet was, read from the RTP header extension
 * the browser already parses for us. One number per participant per poll, and
 * no Web Audio graph per peer — which is the version that would show up in a
 * six-person call's CPU.
 */
function receivedLevel(peer: Peer): number {
  const receiver = peer.audioTx?.receiver;
  if (!receiver?.getSynchronizationSources) return 0;
  let loudest = 0;
  for (const source of receiver.getSynchronizationSources()) {
    loudest = Math.max(loudest, source.audioLevel ?? 0);
  }
  return loudest;
}

/**
 * One connection per participant, with its three media slots fixed up front.
 *
 * The offerer declares microphone, camera, screen in that order. The answerer
 * adopts those slots from the offer. Subsequent camera/screen changes use
 * replaceTrack without renegotiation; incoming tracks use the negotiated order.
 */
export class HuddleSession {
  private destroyed = false;
  private acquiringCamera = false;
  private acquiringScreen = false;
  private peers = new Map<ID, Peer>();
  private connected = new Set<ID>();
  private localStream: MediaStream | null = null;
  /** The person's latest choice, even while the microphone is being replaced. */
  private muted = false;
  private micLost = false;
  private recoveringMic: Promise<boolean> | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private localCameraStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  /** Who is currently shown as talking, and when each was last loud. */
  private speaking = new Set<ID>();
  private spokeAt = new Map<ID, number>();
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelSamples: Uint8Array<ArrayBuffer> | null = null;

  /** Called whenever anything the UI renders has changed. */
  onChange: (() => void) | null = null;

  constructor(
    readonly channelId: ID,
    private selfId: ID,
    private transport: HuddleTransport,
    private rtcConfig: RTCConfiguration = { iceServers: [] },
  ) {}

  /**
   * Grabs the microphone. Rejects as the browser does if permission is
   * refused or no device exists, and with `NotSupportedError` where there is
   * no way to ask (an insecure page); `captureFailure` words each for people.
   *
   * `muted` starts it off, for someone who chose to join huddles that way:
   * nothing they say is sent until they turn it on, and each peer is told so
   * as it connects (CALL-01).
   */
  async startLocalAudio(muted = false): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw unsupported("microphone");
    this.muted = muted;
    const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
    if (this.destroyed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.adoptMicrophone(stream);
    this.startLevelPolling();
  }

  /** Makes this the microphone everyone hears, and watches for it stopping. */
  private adoptMicrophone(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.enabled = !this.muted;
      // Stopping a track ourselves does not end it this way, so this is only
      // ever the device going, or its permission.
      track.onended = () => void this.recoverMicrophone();
    }
    this.localStream = stream;
    this.micLost = false;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.watchLocalLevel(stream);
  }

  /**
   * The microphone stopped: unplugged, or its permission taken back. Asks for
   * one again, which is whatever the system now has as its default, and sends
   * it to everyone in place of the old one, muted if it was (CALL-01). With
   * none to be had the huddle says so, tells the others this side is muted
   * rather than leaving them to wonder at the silence, and tries again when a
   * device is plugged in. Resolves whether there is a microphone now.
   */
  async recoverMicrophone(): Promise<boolean> {
    if (this.destroyed || !this.localStream) return false;
    if (this.recoveringMic) return this.recoveringMic;
    const attempt = this.replaceMicrophone();
    this.recoveringMic = attempt;
    void attempt.finally(() => {
      if (this.recoveringMic === attempt) this.recoveringMic = null;
    });
    return attempt;
  }

  private async replaceMicrophone(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
      if (this.destroyed) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      for (const track of this.localStream?.getTracks() ?? []) track.stop();
      this.adoptMicrophone(stream);
      this.stopWaitingForMicrophone();
      await Promise.all(
        [...this.peers.values()].map((peer) =>
          peer.audioTx?.sender.replaceTrack(stream.getAudioTracks()[0] ?? null).catch(() => {}),
        ),
      );
      return true;
    } catch {
      if (this.destroyed) return false;
      this.micLost = true;
      this.waitForMicrophone();
      return false;
    } finally {
      this.announceMedia();
      this.onChange?.();
    }
  }

  private readonly onDeviceChange = () => void this.recoverMicrophone();

  private waitForMicrophone(): void {
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
  }

  private stopWaitingForMicrophone(): void {
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
  }

  /**
   * Your own microphone level, so your tile lights up like everyone else's.
   * A muted track carries silence, so muting stops this on its own.
   */
  private watchLocalLevel(stream: MediaStream): void {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    try {
      const context = new Ctx();
      void context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      this.audioContext = context;
      this.analyser = analyser;
      this.levelSamples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch {
      // Showing a level is a nicety. Never let it cost someone the call.
    }
  }

  private localLevel(): number {
    if (!this.analyser || !this.levelSamples) return 0;
    return peakLevel(this.analyser, this.levelSamples);
  }

  private startLevelPolling(): void {
    if (this.levelTimer || this.destroyed) return;
    this.levelTimer = setInterval(() => this.sampleLevels(), LEVEL_POLL_MS);
  }

  /** One pass over every participant's loudness, published only on a change. */
  private sampleLevels(): void {
    const now = Date.now();
    if (this.localLevel() > SPEAKING_LEVEL) this.spokeAt.set(this.selfId, now);
    for (const [userId, peer] of this.peers) {
      if (receivedLevel(peer) > SPEAKING_LEVEL) this.spokeAt.set(userId, now);
    }

    let changed = false;
    const present = new Set<ID>([this.selfId, ...this.peers.keys()]);
    for (const userId of present) {
      const talking = now - (this.spokeAt.get(userId) ?? 0) < SPEAKING_HOLD_MS;
      if (talking === this.speaking.has(userId)) continue;
      if (talking) this.speaking.add(userId);
      else this.speaking.delete(userId);
      changed = true;
    }
    for (const userId of this.speaking) {
      if (present.has(userId)) continue;
      this.speaking.delete(userId);
      changed = true;
    }
    // Re-rendering the whole huddle eight times a second is exactly the stutter
    // this is meant to avoid, so only a real transition reaches the UI.
    if (changed) this.onChange?.();
  }

  get micMuted(): boolean {
    return this.muted;
  }

  toggleMic(): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (this.destroyed || !track) return;
    this.muted = !this.muted;
    track.enabled = !this.muted;
    // Everyone else needs to know, or a muted person just looks silent.
    this.announceMedia();
    this.onChange?.();
  }

  get cameraOn(): boolean {
    return this.cameraTrack !== null;
  }

  get sharingScreen(): boolean {
    return this.screenTrack !== null;
  }

  state(): HuddleState {
    return {
      channelId: this.channelId,
      micMuted: this.micMuted,
      cameraOn: this.cameraOn,
      sharingScreen: this.sharingScreen,
      localCameraStream: this.localCameraStream,
      localScreenStream: this.localScreenStream,
      peers: [...this.peers.entries()].map(([userId, peer]) => ({
        userId,
        audioStream: peer.audio,
        cameraStream: peer.cameraOn ? peer.camera : null,
        screenStream: peer.screenOn ? peer.screen : null,
        connected: this.connected.has(userId),
        micMuted: peer.micMuted,
        speaking: this.speaking.has(userId),
      })),
      speaking: this.speaking.has(this.selfId),
      micLost: this.micLost,
    };
  }

  /**
   * Reconciles the mesh against the room roster: dial anyone new, drop anyone
   * who left. Only one side offers, decided by id, so the two don't collide.
   */
  syncParticipants(userIds: ID[]): void {
    if (this.destroyed) return;
    const others = new Set(userIds.filter((id) => id !== this.selfId));

    for (const userId of this.peers.keys()) {
      if (!others.has(userId)) this.closePeer(userId);
    }
    for (const userId of others) {
      if (this.peers.has(userId)) continue;
      this.createPeer(userId);
    }
    this.onChange?.();
  }

  private createPeer(userId: ID): Peer {
    const pc = new RTCPeerConnection(this.rtcConfig);

    // Order is the contract: both ends create these identically, so the m-lines
    // line up and each transceiver means the same thing on both sides.
    // Only the offerer creates slots. The answerer adopts the slots from the
    // remote offer; pre-creating them on both sides produces six transceivers
    // in Chromium and a receive-only answer (one-way audio).
    const initiating = shouldInitiateOffer(this.selfId, userId);
    const audioTx = initiating ? pc.addTransceiver("audio", { direction: "sendrecv" }) : null;
    const cameraTx = initiating ? pc.addTransceiver("video", { direction: "sendrecv" }) : null;
    const screenTx = initiating ? pc.addTransceiver("video", { direction: "sendrecv" }) : null;

    const peer: Peer = {
      pc,
      audioTx,
      cameraTx,
      screenTx,
      audio: null,
      camera: null,
      screen: null,
      cameraOn: false,
      screenOn: false,
      micMuted: false,
      pendingIce: [],
    };
    this.peers.set(userId, peer);
    this.startLevelPolling();

    // Whatever is already live goes out on the new connection immediately.
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.transport.send({
        type: "huddle.signal",
        channelId: this.channelId,
        to: userId,
        signal: {
          kind: "ice",
          candidate: {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
          },
        },
      });
    };

    pc.ontrack = (e) => {
      // A slot always exists, so a track arrives for it whether or not
      // anything is being sent. Keep the stream; whether it is worth showing
      // is what the peer's "media" signal tells us.
      const stream = new MediaStream([e.track]);
      const slot = pc.getTransceivers().indexOf(e.transceiver);
      if (slot === 1) peer.camera = stream;
      else if (slot === 2) peer.screen = stream;
      else peer.audio = stream;
      this.onChange?.();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.connected.add(userId);
      else this.connected.delete(userId);
      this.onChange?.();
    };

    // Tell them what we are sending, so someone joining a call that already
    // has video on sees it rather than an empty tile.
    this.announceMedia(userId);
    if (initiating)
      void this.attachLocalTracks(peer)
        .then(() => {
          if (!this.destroyed && this.peers.get(userId) === peer) return this.offer(userId, pc);
        })
        .catch(() => {});
    return peer;
  }

  private async attachLocalTracks(peer: Peer): Promise<void> {
    await Promise.all([
      peer.audioTx?.sender.replaceTrack(this.localStream?.getAudioTracks()[0] ?? null),
      peer.cameraTx?.sender.replaceTrack(this.cameraTrack),
      peer.screenTx?.sender.replaceTrack(this.screenTrack),
    ]);
  }

  private async offer(userId: ID, pc: RTCPeerConnection): Promise<void> {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.transport.send({
      type: "huddle.signal",
      channelId: this.channelId,
      to: userId,
      signal: { kind: "offer", sdp: offer.sdp ?? "" },
    });
  }

  /** Handles a relayed offer/answer/candidate from one peer. */
  async handleSignal(from: ID, signal: HuddleSignal): Promise<void> {
    if (this.destroyed) return;
    // A signal can arrive before the roster update that introduces the peer.
    let peer = this.peers.get(from);
    if (!peer) peer = this.createPeer(from);
    const pc = peer.pc;

    if (signal.kind === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const slots = pc.getTransceivers();
      peer.audioTx = slots[0] ?? null;
      peer.cameraTx = slots[1] ?? null;
      peer.screenTx = slots[2] ?? null;
      for (const slot of slots) slot.direction = "sendrecv";
      await this.attachLocalTracks(peer);
      await this.flushIce(peer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.transport.send({
        type: "huddle.signal",
        channelId: this.channelId,
        to: from,
        signal: { kind: "answer", sdp: answer.sdp ?? "" },
      });
    } else if (signal.kind === "answer") {
      // Ignore an answer that arrives when we are not expecting one.
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await this.flushIce(peer);
    } else if (signal.kind === "media") {
      peer.cameraOn = signal.camera;
      peer.screenOn = signal.screen;
      peer.micMuted = signal.muted ?? false;
      this.onChange?.();
    } else {
      if (!pc.remoteDescription) {
        if (peer.pendingIce.length < 128) peer.pendingIce.push(signal.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch {
        // Candidates can arrive before the remote description; losing one is
        // survivable, so never let it break the call.
      }
    }
  }

  private async flushIce(peer: Peer): Promise<void> {
    for (const candidate of peer.pendingIce.splice(0)) {
      await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  /** Turns the camera on or off. */
  async toggleCamera(): Promise<void> {
    if (this.destroyed || this.acquiringCamera) return;
    if (this.cameraTrack) {
      this.stopCamera();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw unsupported("camera");
    this.acquiringCamera = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // 360p went soft as soon as a tile was bigger than a thumbnail. The
          // encoder still steps down on its own when the network cannot keep up.
          width: { ideal: 960, max: 1280 },
          height: { ideal: 540, max: 720 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      });
    } finally {
      this.acquiringCamera = false;
    }
    if (this.destroyed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    this.cameraTrack = track;
    this.localCameraStream = stream;
    track.onended = () => this.stopCamera();
    await this.publish("camera", track);
  }

  private stopCamera(): void {
    if (!this.cameraTrack) return;
    this.cameraTrack.stop();
    this.cameraTrack = null;
    this.localCameraStream = null;
    void this.publish("camera", null);
  }

  /** Starts or stops sharing the screen. */
  async toggleScreenShare(): Promise<void> {
    if (this.destroyed || this.acquiringScreen) return;
    if (this.screenTrack) {
      this.stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw unsupported("screen");
    this.acquiringScreen = true;
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        // Each viewer is encoded separately in a mesh, so a 4K screen is sent
        // at no more than 1080p. That is still sharp text.
        video: {
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { ideal: 15, max: 15 },
        },
        audio: false,
      });
    } finally {
      this.acquiringScreen = false;
    }
    if (this.destroyed) {
      display.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = display.getVideoTracks()[0];
    if (!track) return;
    // Screen content: when bandwidth runs short, keep the resolution and drop
    // frames. Without the hint the encoder treats a screen like a camera and
    // blurs the text first.
    track.contentHint = "detail";
    this.screenTrack = track;
    this.localScreenStream = display;
    // Stopping from the browser's own bar must clean up too.
    track.onended = () => this.stopScreenShare();
    await this.publish("screen", track);
  }

  private stopScreenShare(): void {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    this.localScreenStream = null;
    void this.publish("screen", null);
  }

  /**
   * Pushes one slot's track to every peer. Because the transceiver was created
   * up front this needs no new offer — the track simply starts or stops
   * flowing, and the far side sees its receiver unmute or mute.
   */
  private async publish(slot: "camera" | "screen", track: MediaStreamTrack | null): Promise<void> {
    await Promise.all(
      [...this.peers.values()].map((peer) =>
        (slot === "camera" ? peer.cameraTx : peer.screenTx)?.sender
          .replaceTrack(track)
          // A peer that died mid-call must not stop the others updating.
          .catch(() => {}),
      ),
    );
    this.announceMedia();
    this.onChange?.();
  }

  /** Says which slots we are sending on, to one peer or to all of them. */
  private announceMedia(to?: ID): void {
    if (this.destroyed) return;
    const signal = {
      kind: "media" as const,
      camera: this.cameraTrack !== null,
      screen: this.screenTrack !== null,
      muted: this.micMuted || this.micLost,
    };
    for (const userId of to ? [to] : this.peers.keys()) {
      this.transport.send({
        type: "huddle.signal",
        channelId: this.channelId,
        to: userId,
        signal,
      });
    }
  }

  private closePeer(userId: ID): void {
    this.peers.get(userId)?.pc.close();
    this.peers.delete(userId);
    this.connected.delete(userId);
    this.speaking.delete(userId);
    this.spokeAt.delete(userId);
  }

  /** Tears down every connection and releases the camera and microphone. */
  destroy(): void {
    this.destroyed = true;
    this.stopWaitingForMicrophone();
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.analyser = null;
    this.levelSamples = null;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    this.localCameraStream = null;
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.localScreenStream = null;
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    this.onChange = null;
  }
}

/** One connection and its three fixed media slots. */
interface Peer {
  pendingIce: RTCIceCandidateInit[];
  pc: RTCPeerConnection;
  audioTx: RTCRtpTransceiver | null;
  cameraTx: RTCRtpTransceiver | null;
  screenTx: RTCRtpTransceiver | null;
  audio: MediaStream | null;
  camera: MediaStream | null;
  screen: MediaStream | null;
  /** What they told us they are sending; see the "media" signal. */
  cameraOn: boolean;
  screenOn: boolean;
  micMuted: boolean;
}

/** The microphone a huddle asks for, at the start and after losing one. */
const MICROPHONE: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  video: false,
};

/** What the browser would have said, had it offered a way to ask at all. */
function unsupported(kind: string): DOMException {
  return new DOMException(`No way to reach the ${kind} here.`, "NotSupportedError");
}

/** The loudest of the latest samples, from 0 (silence) to 1. */
function peakLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(samples);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
  return peak / 128;
}

/** A microphone opened only to hear whether it works (CALL-01). */
export interface MicrophoneTest {
  /** The device's name, where the browser gives one; empty otherwise. */
  label: string;
  /** False where the browser cannot measure sound, so no level will come. */
  metered: boolean;
  /** Closes the microphone. Safe to call more than once. */
  stop(): void;
}

/**
 * Opens the microphone the way a huddle does and reports how loud it is,
 * several times a second, until stopped, so someone can check it before a
 * call. Nothing is sent anywhere. Rejects as `startLocalAudio` does, for
 * `captureFailure` to word.
 */
export async function testMicrophone(onLevel: (level: number) => void): Promise<MicrophoneTest> {
  if (!navigator.mediaDevices?.getUserMedia) throw unsupported("microphone");
  const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (Ctx) {
    try {
      context = new Ctx();
      void context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      timer = setInterval(() => onLevel(peakLevel(analyser, samples)), LEVEL_POLL_MS);
    } catch {
      // The microphone opened; only the meter is missing.
      void context?.close().catch(() => {});
      context = null;
    }
  }
  return {
    label: stream.getAudioTracks()[0]?.label ?? "",
    metered: timer !== null,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stream.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      context = null;
    },
  };
}
