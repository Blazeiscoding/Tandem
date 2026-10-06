import { useEffect, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { HuddleControls } from "./HuddleControls.js";
import { HuddleAudio } from "./HuddleAudio.js";
import { Tooltip } from "./Tooltip.js";
import { huddleHasVideo, type HuddleView } from "../lib/huddleView.js";
import { useCallPreferences } from "../lib/callPreferences.js";

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
  onShowCallLog,
}: {
  view?: HuddleView;
  onViewChange?: (view: HuddleView) => void;
  /** Opens the call log, for someone who cannot connect to know why. */
  onShowCallLog?: () => void;
}) {
  const huddle = useWorkspace((s) => s.huddle);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);

  if (!huddle) return null;
  const channel = channels[huddle.channelId];
  const where = channel
    ? channel.name
      ? `#${channel.name}`
      : channelTitle(channel, users, selfId)
    : "huddle";

  const connecting = huddle.peers.some((p) => !p.connected);
  // Someone who has taken too long to connect: say so, and offer the reason.
  const stuck = huddle.peers.filter((p) => !p.connected && p.trouble);
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
              : stuck.length > 0
                ? `Can't connect to ${stuck
                    .map((p) => users[p.userId]?.displayName ?? "someone")
                    .join(", ")} · Trying again`
                : `${huddle.peers.length + 1} participants${connecting ? " · Connecting…" : ""}${sharing}`}
          </div>
          {stuck.length > 0 && onShowCallLog && (
            <button
              type="button"
              onClick={onShowCallLog}
              className="text-xs text-copper underline decoration-copper/40 hover:decoration-copper"
            >
              Why? See the call log
            </button>
          )}
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
              p.connected
                ? p.micMuted
                  ? " (muted)"
                  : ""
                : p.trouble
                  ? " (can't connect)"
                  : " (connecting…)"
            }`}
            speaking={p.speaking}
            muted={p.micMuted}
            dim={!p.connected}
          />
        ))}
      </ul>

      <HuddleAudio peers={huddle.peers} />

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
  const currentRoom = useRef({ client, channelId });
  currentRoom.current = { client, channelId };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const count = participants?.length ?? 0;

  async function join() {
    setError(null);
    setJoining(true);
    try {
      await calls.joinHuddle(
        client,
        channelId,
        () =>
          mounted.current &&
          currentRoom.current.client === client &&
          currentRoom.current.channelId === channelId,
      );
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "Could not join this huddle.");
        setTimeout(() => {
          if (mounted.current) setError(null);
        }, 4000);
      }
    } finally {
      if (mounted.current) setJoining(false);
    }
  }

  if (inThis) {
    return (
      <span className="flex items-center gap-2 rounded-lg bg-online/15 px-2.5 py-1.5 text-[13px] font-medium text-online">
        <Icon name="headphones" size={18} />
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
        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors ${
          error
            ? "text-alert"
            : count > 0
              ? "bg-online/15 text-online hover:bg-online/25"
              : "text-ink-faint hover:bg-lifted/60 hover:text-ink"
        }`}
      >
        {error ? (
          <span role="alert">{error}</span>
        ) : joining ? (
          "Joining…"
        ) : (
          <>
            <Icon name="headphones" size={20} />
            <span className="header-secondary">Huddle</span>
            {count > 0 && <span className="font-mono text-[11px]">{count}</span>}
          </>
        )}
      </button>
    </Tooltip>
  );
}
