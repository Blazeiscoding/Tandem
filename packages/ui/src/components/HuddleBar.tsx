import { useCallback, useEffect, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import type { HuddlePeer } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { HuddleControls } from "./HuddleControls.js";
import { Tooltip } from "./Tooltip.js";
import { huddleHasVideo, type HuddleView } from "../lib/huddleView.js";
import { useCallPreferences } from "../lib/callPreferences.js";

/**
 * Plays one peer's audio. A hidden <audio> element is what actually makes a
 * WebRTC stream audible — receiving the track alone is not enough.
 *
 * A browser that will not play sound until someone asks refuses with
 * `NotAllowedError`. The element is handed up to the bar, which asks
 * (CALL-01); any other refusal is a play cut short by a new stream.
 */
function PeerAudio({
  peer,
  onHeldBack,
}: {
  peer: HuddlePeer;
  onHeldBack: (userId: ID, el: HTMLAudioElement | null) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !peer.audioStream) return;
    el.srcObject = peer.audioStream;
    void el.play()?.then(
      () => onHeldBack(peer.userId, null),
      (err: unknown) => {
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          onHeldBack(peer.userId, el);
        }
      },
    );
    return () => {
      el.srcObject = null;
      onHeldBack(peer.userId, null);
    };
  }, [peer.audioStream, peer.userId, onHeldBack]);

  return <audio ref={ref} autoPlay hidden />;
}

/**
 * The audio the browser is holding back, and a way to let it play. Any click
 * or key press counts as asking, since the bar is out of sight on a full
 * screen stage; the button says so where it can be seen.
 */
function useHeldBackAudio() {
  const [held, setHeld] = useState<ReadonlyMap<ID, HTMLAudioElement>>(() => new Map());
  const onHeldBack = useCallback((userId: ID, el: HTMLAudioElement | null) => {
    setHeld((previous) => {
      if (previous.get(userId) === (el ?? undefined)) return previous;
      const next = new Map(previous);
      if (el) next.set(userId, el);
      else next.delete(userId);
      return next;
    });
  }, []);
  // Played from within the gesture itself, which is what the browser waits for.
  const play = useCallback(() => {
    for (const [userId, el] of held) {
      void el.play()?.then(
        () => onHeldBack(userId, null),
        () => {},
      );
    }
  }, [held, onHeldBack]);
  useEffect(() => {
    if (held.size === 0) return;
    document.addEventListener("pointerdown", play, true);
    document.addEventListener("keydown", play, true);
    return () => {
      document.removeEventListener("pointerdown", play, true);
      document.removeEventListener("keydown", play, true);
    };
  }, [held, play]);
  return { heldBack: held.size > 0, onHeldBack, play };
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

/**
 * The bar shown while you are in a huddle. With the video put away, it offers
 * to bring it back.
 */
export function HuddleBar({
  view = "docked",
  onViewChange,
}: {
  view?: HuddleView;
  onViewChange?: (view: HuddleView) => void;
}) {
  const huddle = useWorkspace((s) => s.huddle);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const { heldBack, onHeldBack, play } = useHeldBackAudio();

  if (!huddle) return null;
  const channel = channels[huddle.channelId];
  const where = channel
    ? channel.name
      ? `#${channel.name}`
      : channelTitle(channel, users, selfId)
    : "huddle";

  const connecting = huddle.peers.some((p) => !p.connected);
  const sharer = huddle.peers.find((p) => p.screenStream);
  const sharing = sharer
    ? ` · ${users[sharer.userId]?.displayName ?? "Someone"} is sharing their screen`
    : huddle.sharingScreen
      ? " · You're sharing your screen"
      : "";

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
          <div role="status" className="truncate text-xs text-ink-faint">
            {huddle.peers.length === 0
              ? "Waiting for someone to join…"
              : `${huddle.peers.length + 1} participants${connecting ? " · Connecting…" : ""}${sharing}`}
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
        <PeerAudio key={p.userId} peer={p} onHeldBack={onHeldBack} />
      ))}

      {heldBack && (
        <p
          role="alert"
          className="flex basis-full items-center gap-3 text-sm text-alert sm:basis-auto"
        >
          Your browser is holding back the huddle's sound.
          <button
            onClick={play}
            className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-alert px-3 font-medium transition-colors hover:bg-alert/10"
          >
            <Icon name="headphones" size={16} />
            Turn on sound
          </button>
        </p>
      )}

      {view === "hidden" && onViewChange && huddleHasVideo(huddle) && (
        <button
          onClick={() => onViewChange("docked")}
          className="flex h-11 items-center gap-2 rounded-xl border border-edge px-3 text-sm text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
        >
          <Icon name="chevronUp" size={16} />
          Show video
        </button>
      )}

      <HuddleControls />
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
  const calls = useCallPreferences();
  const count = participants?.length ?? 0;

  async function join() {
    setError(null);
    setJoining(true);
    try {
      await client.joinHuddle(channelId, { muted: calls.joinMuted });
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

  const label = count > 0 ? `Join the huddle (${count})` : "Start a huddle";
  return (
    <Tooltip label={label}>
      <button
        onClick={join}
        disabled={joining}
        aria-label={label}
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
    </Tooltip>
  );
}
