import { shouldInitiateOffer, type HuddleSignal, type ID } from "@slackoss/protocol";

export interface HuddlePeer {
  userId: ID;
  stream: MediaStream | null;
  /** True once the connection is carrying media. */
  connected: boolean;
}

export interface HuddleState {
  channelId: ID;
  micMuted: boolean;
  sharingScreen: boolean;
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
 * One peer connection per other participant (a mesh). Fine for the handful of
 * people a self-hosted workspace puts in a call; an SFU is the answer beyond that.
 */
export class HuddleSession {
  private peers = new Map<ID, RTCPeerConnection>();
  private remoteStreams = new Map<ID, MediaStream>();
  private connected = new Set<ID>();
  private localStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;

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

  get sharingScreen(): boolean {
    return this.screenTrack !== null;
  }

  state(): HuddleState {
    return {
      channelId: this.channelId,
      micMuted: this.micMuted,
      sharingScreen: this.sharingScreen,
      peers: [...this.peers.keys()].map((userId) => ({
        userId,
        stream: this.remoteStreams.get(userId) ?? null,
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
      const pc = this.createPeer(userId);
      if (shouldInitiateOffer(this.selfId, userId)) void this.offer(userId, pc);
    }
    this.onChange?.();
  }

  private createPeer(userId: ID): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers.set(userId, pc);

    for (const track of this.localStream?.getTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

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
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.remoteStreams.set(userId, stream);
      this.onChange?.();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.connected.add(userId);
      else this.connected.delete(userId);
      this.onChange?.();
    };

    return pc;
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
    let pc = this.peers.get(from);
    if (!pc) pc = this.createPeer(from);

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
    } else {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch {
        // Candidates can arrive before the remote description; losing one is
        // survivable, so never let it break the call.
      }
    }
  }

  /** Replaces the outgoing video track with the screen, or stops sharing. */
  async toggleScreenShare(): Promise<void> {
    if (this.screenTrack) {
      this.stopScreenShare();
      return;
    }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = display.getVideoTracks()[0];
    if (!track) return;
    this.screenTrack = track;
    // Stopping from the browser's own bar must clean up too.
    track.onended = () => this.stopScreenShare();

    for (const pc of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
      else pc.addTrack(track, display);
    }
    this.onChange?.();
  }

  private stopScreenShare(): void {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    for (const pc of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) void sender.replaceTrack(this.cameraTrack);
    }
    this.onChange?.();
  }

  private closePeer(userId: ID): void {
    this.peers.get(userId)?.close();
    this.peers.delete(userId);
    this.remoteStreams.delete(userId);
    this.connected.delete(userId);
  }

  /** Tears down every connection and releases the microphone. */
  destroy(): void {
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
    this.stopScreenShare();
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    this.onChange = null;
  }
}
