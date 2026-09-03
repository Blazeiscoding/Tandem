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
  peers: HuddlePeer[];
}

/** How the huddle reaches the server; supplied by WorkspaceClient. */
export interface HuddleTransport {
  send: (msg: { type: "huddle.signal"; channelId: ID; to: ID; signal: HuddleSignal }) => void;
}

const RTC_CONFIG: RTCConfiguration = {
  // A LAN or self-hosted workspace usually needs no STUN at all; host
  // candidates are enough. The public server is a fallback for wider networks.
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/**
 * One connection per participant, with its three media slots fixed up front.
 *
 * Every peer declares the same transceivers in the same order — microphone,
 * camera, screen — before the first offer, so turning a camera or a share on
 * later is just `replaceTrack` on a slot that already exists. That avoids
 * renegotiation entirely, which matters because renegotiating a mesh mid-call
 * is where glare and half-connected peers come from. It also means the two
 * sides agree on which incoming track is which: the receiving transceiver is
 * the very object we created, so the slot is known by identity rather than by
 * guessing from an SDP mid.
 */
export class HuddleSession {
  private peers = new Map<ID, Peer>();
  private connected = new Set<ID>();
  private localStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private localCameraStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;

  /** Called whenever anything the UI renders has changed. */
  onChange: (() => void) | null = null;

  constructor(
    readonly channelId: ID,
    private selfId: ID,
    private transport: HuddleTransport,
  ) {}

  /** Grabs the microphone. Rejects if permission is refused or no device exists. */
  async startLocalAudio(): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  get micMuted(): boolean {
    const track = this.localStream?.getAudioTracks()[0];
    return track ? !track.enabled : false;
  }

  toggleMic(): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
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
      })),
    };
  }

  /**
   * Reconciles the mesh against the room roster: dial anyone new, drop anyone
   * who left. Only one side offers, decided by id, so the two don't collide.
   */
  syncParticipants(userIds: ID[]): void {
    const others = new Set(userIds.filter((id) => id !== this.selfId));

    for (const userId of this.peers.keys()) {
      if (!others.has(userId)) this.closePeer(userId);
    }
    for (const userId of others) {
      if (this.peers.has(userId)) continue;
      const peer = this.createPeer(userId);
      if (shouldInitiateOffer(this.selfId, userId)) void this.offer(userId, peer.pc);
    }
    this.onChange?.();
  }

  private createPeer(userId: ID): Peer {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // Order is the contract: both ends create these identically, so the m-lines
    // line up and each transceiver means the same thing on both sides.
    const audioTx = pc.addTransceiver("audio", { direction: "sendrecv" });
    const cameraTx = pc.addTransceiver("video", { direction: "sendrecv" });
    const screenTx = pc.addTransceiver("video", { direction: "sendrecv" });

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
    };
    this.peers.set(userId, peer);

    // Whatever is already live goes out on the new connection immediately.
    const micTrack = this.localStream?.getAudioTracks()[0] ?? null;
    if (micTrack) void audioTx.sender.replaceTrack(micTrack);
    if (this.cameraTrack) void cameraTx.sender.replaceTrack(this.cameraTrack);
    if (this.screenTrack) void screenTx.sender.replaceTrack(this.screenTrack);

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
      if (e.transceiver === peer.cameraTx) peer.camera = stream;
      else if (e.transceiver === peer.screenTx) peer.screen = stream;
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
    return peer;
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
    // A signal can arrive before the roster update that introduces the peer.
    let peer = this.peers.get(from);
    if (!peer) peer = this.createPeer(from);
    const pc = peer.pc;

    if (signal.kind === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
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
    } else if (signal.kind === "media") {
      peer.cameraOn = signal.camera;
      peer.screenOn = signal.screen;
      this.onChange?.();
    } else {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch {
        // Candidates can arrive before the remote description; losing one is
        // survivable, so never let it break the call.
      }
    }
  }

  /** Turns the camera on or off. */
  async toggleCamera(): Promise<void> {
    if (this.cameraTrack) {
      this.stopCamera();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
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
    if (this.screenTrack) {
      this.stopScreenShare();
      return;
    }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
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
        (slot === "camera" ? peer.cameraTx : peer.screenTx).sender
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
    const signal = {
      kind: "media" as const,
      camera: this.cameraTrack !== null,
      screen: this.screenTrack !== null,
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
  }

  /** Tears down every connection and releases the camera and microphone. */
  destroy(): void {
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
  pc: RTCPeerConnection;
  audioTx: RTCRtpTransceiver;
  cameraTx: RTCRtpTransceiver;
  screenTx: RTCRtpTransceiver;
  audio: MediaStream | null;
  camera: MediaStream | null;
  screen: MediaStream | null;
  /** What they told us they are sending; see the "media" signal. */
  cameraOn: boolean;
  screenOn: boolean;
}
