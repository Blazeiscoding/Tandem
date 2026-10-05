import { useEffect, useRef, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { useCallPreferences } from "../lib/callPreferences.js";

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
