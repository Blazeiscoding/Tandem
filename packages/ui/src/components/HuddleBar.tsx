import { useEffect, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import type { HuddlePeer } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Avatar } from "./Avatar.js";

/**
 * Plays one peer's audio. A hidden <audio> element is what actually makes a
 * WebRTC stream audible — receiving the track alone is not enough.
 */
function PeerAudio({ peer }: { peer: HuddlePeer }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !peer.audioStream) return;
    el.srcObject = peer.audioStream;
    // Autoplay can be refused; there is nothing useful to do but carry on.
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [peer.audioStream]);

  return <audio ref={ref} autoPlay hidden />;
}

/**
 * A video surface. Muted is not optional: the audio arrives on its own
 * element, and playing it here as well would double every voice.
 */
function Video({ stream, mirrored }: { stream: MediaStream; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`size-full object-contain ${mirrored ? "-scale-x-100" : ""}`}
    />
  );
}

function Tile({
  user,
  stream,
  label,
  mirrored,
  big,
}: {
  user: User | undefined;
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
  big?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-edge bg-ground ${
        big ? "size-full" : "aspect-video w-40 shrink-0"
      }`}
    >
      {stream ? (
        <Video stream={stream} mirrored={mirrored} />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Avatar user={user} size={big ? 64 : 32} />
        </div>
      )}
      <span className="absolute bottom-1 left-1 rounded bg-ground/80 px-1.5 py-0.5 text-[11px] text-ink-dim">
        {label}
      </span>
    </div>
  );
}

/**
 * The video area, shown only once there is something to see. A share takes the
 * stage and the cameras become a strip beside it, which is the arrangement
 * that matches why people share in the first place.
 */
export function HuddleStage() {
  const huddle = useWorkspace((s) => s.huddle);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  if (!huddle) return null;

  const sharer = huddle.peers.find((p) => p.screenStream);
  const share = huddle.localScreenStream
    ? { stream: huddle.localScreenStream, who: "Your screen" }
    : sharer
      ? {
          stream: sharer.screenStream!,
          who: `${users[sharer.userId]?.displayName ?? "Someone"}'s screen`,
        }
      : null;

  const cameras: { key: string; user: User | undefined; stream: MediaStream; mine: boolean }[] = [];
  if (huddle.localCameraStream && selfId) {
    cameras.push({
      key: "self",
      user: users[selfId],
      stream: huddle.localCameraStream,
      mine: true,
    });
  }
  for (const p of huddle.peers) {
    if (p.cameraStream) {
      cameras.push({ key: p.userId, user: users[p.userId], stream: p.cameraStream, mine: false });
    }
  }

  if (!share && cameras.length === 0) return null;

  return (
    <div className="flex gap-2 border-t border-edge bg-raised px-5 py-3">
      {share && (
        <div className="h-56 min-w-0 flex-1">
          <Tile user={undefined} stream={share.stream} label={share.who} big />
        </div>
      )}
      <div
        className={
          share
            ? "flex h-56 w-40 shrink-0 flex-col gap-2 overflow-y-auto"
            : "flex flex-wrap gap-2"
        }
      >
        {cameras.map((c) => (
          <Tile
            key={c.key}
            user={c.user}
            stream={c.stream}
            mirrored={c.mine}
            label={c.mine ? "You" : (c.user?.displayName ?? "unknown")}
          />
        ))}
      </div>
    </div>
  );
}

/** The bar shown while you are in a huddle. */
export function HuddleBar() {
  const client = useClient();
  const huddle = useWorkspace((s) => s.huddle);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const [busy, setBusy] = useState<"screen" | "camera" | null>(null);

  if (!huddle) return null;
  const channel = channels[huddle.channelId];
  const where = channel
    ? channel.name
      ? `#${channel.name}`
      : channelTitle(channel, users, selfId)
    : "huddle";

  /** Device pickers can be dismissed, and that is not an error worth showing. */
  const guarded = async (which: "screen" | "camera", run: () => Promise<void>) => {
    setBusy(which);
    try {
      await run();
    } catch {
      /* permission refused or the picker was closed */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-3 border-t border-copper/40 bg-copper/10 px-5 py-2">
      <span className="flex size-2 shrink-0 animate-pulse rounded-full bg-online" />
      <span className="shrink-0 text-sm font-medium text-copper">Huddle in {where}</span>

      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Avatar user={selfId ? users[selfId] : undefined} size={22} />
        {huddle.peers.map((p) => (
          <span
            key={p.userId}
            title={`${users[p.userId]?.displayName ?? "unknown"}${
              p.connected ? "" : " (connecting…)"
            }`}
            className={p.connected ? "" : "opacity-40"}
          >
            <Avatar user={users[p.userId]} size={22} />
          </span>
        ))}
        {huddle.peers.length === 0 && (
          <span className="text-[12px] text-ink-faint">Waiting for someone to join…</span>
        )}
      </span>

      {huddle.peers.map((p) => (
        <PeerAudio key={p.userId} peer={p} />
      ))}

      <button
        onClick={() => client.toggleMic()}
        title={huddle.micMuted ? "Unmute" : "Mute"}
        className={`rounded-lg border px-2.5 py-1 text-[13px] transition-colors ${
          huddle.micMuted
            ? "border-alert text-alert"
            : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink"
        }`}
      >
        {huddle.micMuted ? "🔇" : "🎙"}
      </button>
      <button
        onClick={() => void guarded("camera", () => client.toggleCamera())}
        disabled={busy !== null}
        title={huddle.cameraOn ? "Turn your camera off" : "Turn your camera on"}
        className={`rounded-lg border px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50 ${
          huddle.cameraOn
            ? "border-copper text-copper"
            : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink"
        }`}
      >
        📹
      </button>
      <button
        onClick={() => void guarded("screen", () => client.toggleScreenShare())}
        disabled={busy !== null}
        title={huddle.sharingScreen ? "Stop sharing" : "Share your screen"}
        className={`rounded-lg border px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50 ${
          huddle.sharingScreen
            ? "border-copper text-copper"
            : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink"
        }`}
      >
        🖥
      </button>
      <button
        onClick={() => client.leaveHuddle()}
        className="rounded-lg bg-alert/90 px-3 py-1 text-[13px] font-semibold text-white transition-colors hover:bg-alert"
      >
        Leave
      </button>
    </div>
  );
}

/** Header control: start a huddle, join the running one, or show you're in it. */
export function HuddleButton({ channelId }: { channelId: ID }) {
  const client = useClient();
  const participants = useWorkspace((s) => s.huddles[channelId]);
  const inThis = useWorkspace((s) => s.huddle?.channelId === channelId);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const count = participants?.length ?? 0;

  async function join() {
    setError(null);
    setJoining(true);
    try {
      await client.joinHuddle(channelId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join this huddle.");
      setTimeout(() => setError(null), 4000);
    } finally { setJoining(false); }
  }

  if (inThis) {
    return (
      <span className="rounded-lg border border-copper px-2.5 py-1.5 text-[13px] text-copper">
        🎧 In huddle
      </span>
    );
  }

  return (
    <button
      onClick={join}
      disabled={joining}
      title={error ?? (count > 0 ? `Join the huddle (${count})` : "Start a huddle")}
      className={`rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
        error
          ? "border-alert text-alert"
          : count > 0
            ? "border-online text-online hover:bg-online/10"
            : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
      }`}
    >
      {error ? <span role="alert">{error}</span> : joining ? "Joining…" : <>🎧{count > 0 && <span className="ml-1 font-mono text-[11px]">{count}</span>}</>}
    </button>
  );
}
