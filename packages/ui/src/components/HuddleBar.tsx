import { useEffect, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import type { HuddlePeer } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";

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
function Video({
  stream,
  mirrored,
  fit = "cover",
}: {
  stream: MediaStream;
  mirrored?: boolean;
  /** A face fills its tile; a shared screen has to be shown whole. */
  fit?: "cover" | "contain";
}) {
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
      className={`size-full ${fit === "cover" ? "object-cover" : "object-contain"} ${
        mirrored ? "-scale-x-100" : ""
      }`}
    />
  );
}

/**
 * One participant. A camera fills it; without one the avatar stands in, which
 * is what most of a huddle looks like most of the time.
 */
function Tile({
  user,
  stream,
  label,
  mirrored,
  speaking,
  muted,
  big,
  fit,
}: {
  user: User | undefined;
  stream: MediaStream | null;
  label: string;
  mirrored?: boolean;
  speaking?: boolean;
  muted?: boolean;
  big?: boolean;
  fit?: "cover" | "contain";
}) {
  return (
    <div
      className={`relative size-full min-h-0 overflow-hidden rounded-xl border bg-ground transition-colors ${
        speaking ? "border-online" : "border-edge"
      }`}
    >
      {stream ? (
        <Video stream={stream} mirrored={mirrored} fit={fit} />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Avatar user={user} size={big ? 64 : 40} />
        </div>
      )}
      <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-ground/80 px-1.5 py-0.5 text-[11px] text-ink-dim">
        {muted && (
          <span title="Muted" className="text-alert">
            <Icon name="micOff" size={11} />
          </span>
        )}
        {label}
      </span>
    </div>
  );
}

/** The gap between tiles, in rem, kept here because the sizing maths needs it. */
const TILE_GAP = 0.5;

/**
 * How to lay out `count` tiles in a fixed-height strip. Square-ish beats one
 * long row: four people in a row are four postage stamps, and in a 2x2 they
 * are four times the size for the same strip of screen.
 *
 * Sizing every tile explicitly, rather than leaving it to a grid, is what lets
 * a short last row sit centred instead of hanging off to the left.
 */
function tileLayout(count: number): { flexBasis: string; height: string } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  return {
    flexBasis: `calc((100% - ${(columns - 1) * TILE_GAP}rem) / ${columns})`,
    height: `calc((100% - ${(rows - 1) * TILE_GAP}rem) / ${rows})`,
  };
}

/**
 * The video area. A share takes the stage and everyone else becomes a strip
 * beside it, which is the arrangement that matches why people share. Without
 * a share it is a grid of everyone in the call.
 *
 * The whole thing is height-bounded on purpose: it used to be a wrapping row
 * of fixed-width tiles, so a sixth camera silently ate another row of the
 * message list.
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

  // Everyone in the call gets a tile, camera or not, so the grid shows who is
  // actually here rather than only who switched a camera on.
  const tiles = [
    {
      key: "self",
      user: selfId ? users[selfId] : undefined,
      stream: huddle.localCameraStream,
      label: "You",
      mirrored: true,
      speaking: huddle.speaking,
      muted: huddle.micMuted,
    },
    ...huddle.peers.map((p) => ({
      key: p.userId,
      user: users[p.userId],
      stream: p.cameraStream,
      label: users[p.userId]?.displayName ?? "unknown",
      mirrored: false,
      speaking: p.speaking,
      muted: p.micMuted,
    })),
  ];

  // Nothing to look at in a plain audio call between two people; the bar
  // already says who is in it.
  const anyVideo = share !== null || tiles.some((t) => t.stream);
  if (!anyVideo && tiles.length < 3) return null;

  const layout = tileLayout(tiles.length);

  return (
    <div className="flex gap-2 border-t border-edge bg-raised px-5 py-3">
      {share && (
        <div className="h-56 min-w-0 flex-1">
          <Tile user={undefined} stream={share.stream} label={share.who} fit="contain" big />
        </div>
      )}
      <div
        className={
          share
            ? "flex h-56 w-44 shrink-0 flex-col gap-2 overflow-y-auto"
            : "flex h-56 flex-1 flex-wrap content-center justify-center gap-2"
        }
      >
        {tiles.map((t) => (
          <div
            key={t.key}
            className="min-h-0 shrink-0"
            style={share ? { height: "6rem", flexShrink: 0 } : layout}
          >
            <Tile
              user={t.user}
              stream={t.stream}
              mirrored={t.mirrored}
              speaking={t.speaking}
              muted={t.muted}
              label={t.label}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A face in the huddle bar. The ring is the answer to "who is talking?", which
 * in a call of more than three people is the only question anyone has.
 */
function HuddleFace({
  user,
  title,
  speaking,
  muted,
  dim,
}: {
  user: User | undefined;
  title: string;
  speaking?: boolean;
  muted?: boolean;
  dim?: boolean;
}) {
  return (
    <li className="flex shrink-0">
      <span
        role="img"
        aria-label={title}
        title={title}
        className={`relative flex rounded-full ring-2 transition-colors ${
          speaking ? "ring-online" : "ring-transparent"
        } ${dim ? "opacity-40" : ""}`}
      >
        <Avatar user={user} size={22} />
        {muted && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-raised p-0.5 text-ink-dim">
            <Icon name="micOff" size={9} />
          </span>
        )}
      </span>
    </li>
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

  const connecting = huddle.peers.some((p) => !p.connected);
  /** A toggle names what it controls; aria-pressed, not the name, says whether it is on. */
  const toggleCls = (on: boolean, onCls: string) =>
    `flex size-11 items-center justify-center rounded-xl border transition-colors disabled:opacity-50 ${
      on ? onCls : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink"
    }`;

  return (
    <div
      role="region"
      aria-label="Active huddle"
      className="flex flex-wrap items-center gap-3 border-t border-copper/40 bg-raised px-5 py-3"
    >
      {/* The minimum width is what sends the controls to a line of their own on a phone. */}
      <div className="flex min-w-40 flex-1 items-center gap-2.5">
        <Icon name="headphones" className="text-online" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={`Huddle in ${where}`}>
            Huddle in {where}
          </div>
          <div role="status" className="text-xs text-ink-faint">
            {huddle.peers.length === 0
              ? "Waiting for someone to join…"
              : `${huddle.peers.length + 1} participants${connecting ? " · Connecting…" : ""}`}
          </div>
        </div>
      </div>

      <ul
        aria-label="In the huddle"
        className="flex min-w-0 max-w-40 items-center gap-1.5 overflow-x-auto p-1"
      >
        <HuddleFace
          user={selfId ? users[selfId] : undefined}
          title={`You${huddle.micMuted ? " (muted)" : ""}`}
          speaking={huddle.speaking}
          muted={huddle.micMuted}
        />
        {huddle.peers.map((p) => (
          <HuddleFace
            key={p.userId}
            user={users[p.userId]}
            title={`${users[p.userId]?.displayName ?? "unknown"}${
              p.connected ? (p.micMuted ? " (muted)" : "") : " (connecting…)"
            }`}
            speaking={p.speaking}
            muted={p.micMuted}
            dim={!p.connected}
          />
        ))}
      </ul>

      {huddle.peers.map((p) => (
        <PeerAudio key={p.userId} peer={p} />
      ))}

      <div
        role="group"
        aria-label="Huddle controls"
        className="ml-auto flex shrink-0 items-center gap-2"
      >
        <button
          aria-label="Mute microphone"
          aria-pressed={huddle.micMuted}
          onClick={() => client.toggleMic()}
          title={huddle.micMuted ? "Unmute" : "Mute"}
          className={toggleCls(huddle.micMuted, "border-alert text-alert")}
        >
          <Icon name={huddle.micMuted ? "micOff" : "mic"} />
        </button>
        <button
          aria-label="Camera"
          aria-pressed={huddle.cameraOn}
          onClick={() => void guarded("camera", () => client.toggleCamera())}
          disabled={busy !== null}
          title={huddle.cameraOn ? "Turn your camera off" : "Turn your camera on"}
          className={toggleCls(huddle.cameraOn, "border-copper text-copper")}
        >
          <Icon name="camera" />
        </button>
        <button
          aria-label="Share screen"
          aria-pressed={huddle.sharingScreen}
          onClick={() => void guarded("screen", () => client.toggleScreenShare())}
          disabled={busy !== null}
          title={huddle.sharingScreen ? "Stop sharing" : "Share your screen"}
          className={toggleCls(huddle.sharingScreen, "border-copper text-copper")}
        >
          <Icon name="screen" />
        </button>
        {/* Leave keeps its word: an arrow out of a door reads as signing out just as easily. */}
        <button
          onClick={() => client.leaveHuddle()}
          title="Leave the huddle"
          className="flex h-11 items-center gap-2 rounded-xl bg-alert px-4 text-sm font-semibold text-ground transition-colors hover:bg-alert/85"
        >
          <Icon name="leave" size={16} />
          Leave
        </button>
      </div>
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
    } finally {
      setJoining(false);
    }
  }

  if (inThis) {
    return (
      <span className="flex items-center gap-2 rounded-lg border border-copper px-2.5 py-1.5 text-[13px] text-copper">
        <Icon name="headphones" />
        <span className="header-secondary">In huddle</span>
      </span>
    );
  }

  return (
    <button
      onClick={join}
      disabled={joining}
      title={error ?? (count > 0 ? `Join the huddle (${count})` : "Start a huddle")}
      aria-label={count > 0 ? `Join the huddle (${count})` : "Start a huddle"}
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
        error
          ? "border-alert text-alert"
          : count > 0
            ? "border-online text-online hover:bg-online/10"
            : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
      }`}
    >
      {error ? (
        <span role="alert">{error}</span>
      ) : joining ? (
        "Joining…"
      ) : (
        <>
          <Icon name="headphones" />
          <span className="header-secondary">Huddle</span>
          {count > 0 && <span className="font-mono text-[11px]">{count}</span>}
        </>
      )}
    </button>
  );
}
