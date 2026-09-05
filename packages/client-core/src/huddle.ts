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

  /** Grabs the microphone. Rejects if permission is refused or no device exists. */
  async startLocalAudio(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access requires the desktop app or an HTTPS browser connection.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false,
    });
    if (this.destroyed) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.localStream = stream;
    this.watchLocalLevel(stream);
    this.startLevelPolling();
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
    this.analyser.getByteTimeDomainData(this.levelSamples);
    let peak = 0;
    for (const sample of this.levelSamples) peak = Math.max(peak, Math.abs(sample - 128));
    return peak / 128;
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
    const track = this.localStream?.getAudioTracks()[0];
    return track ? !track.enabled : false;
  }

  toggleMic(): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
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
    if (initiating) void this.attachLocalTracks(peer).then(() => {
      if (!this.destroyed && this.peers.get(userId) === peer) return this.offer(userId, pc);
    }).catch(() => {});
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
    this.acquiringCamera = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 }, frameRate: { ideal: 20, max: 24 } },
        audio: false,
      });
    } finally { this.acquiringCamera = false; }
    if (this.destroyed) { stream.getTracks().forEach((track) => track.stop()); return; }
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
    this.acquiringScreen = true;
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 10, max: 15 } }, audio: false,
      });
    } finally { this.acquiringScreen = false; }
    if (this.destroyed) { display.getTracks().forEach((track) => track.stop()); return; }
    const track = display.getVideoTracks()[0];
    if (!track) return;
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
      muted: this.micMuted,
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
