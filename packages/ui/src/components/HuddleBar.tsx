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
}: {
  view?: HuddleView;
  onViewChange?: (view: HuddleView) => void;
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
      className="mx-4 mb-2 flex flex-wrap items-center gap-3 rounded-xl border border-online/25 bg-online/[0.06] px-4 py-2.5"
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
      <span className="mr-1 flex h-8 items-center gap-1.5 rounded-full bg-online/12 px-3 text-[13px] font-medium text-online">
        <span className="size-1.5 animate-pulse rounded-full bg-online" />
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
        className={`mr-1 flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors ${
          error
            ? "border-alert/40 text-alert"
            : count > 0
              ? "border-online/30 bg-online/12 text-online hover:bg-online/20"
              : "border-edge text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
        }`}
      >
        {error ? (
          <span role="alert">{error}</span>
        ) : joining ? (
          "Joining…"
        ) : (
          <>
            <Icon name="headphones" size={16} />
            <span className="header-secondary">{count > 0 ? "Join" : "Huddle"}</span>
            {count > 0 && <span className="tabular text-[12px]">{count}</span>}
          </>
        )}
      </button>
    </Tooltip>
  );
}
