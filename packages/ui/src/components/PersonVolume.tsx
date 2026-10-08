import { useId } from "react";
import type { ID } from "@slackoss/protocol";
import { AS_SENT, DEFAULT_VOLUME, MAX_VOLUME, useCallVolumes } from "../lib/callVolumes.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

/**
 * How loud someone in the call is to you: muted for you alone, or anywhere
 * from silent to twice as loud as they arrive. Nobody else hears the change.
 */
export function PersonVolume({ userId, name }: { userId: ID; name: string }) {
  const { volumes, set } = useCallVolumes();
  const choice = volumes[userId] ?? AS_SENT;
  const marks = useId();
  return (
    <div className="flex items-center gap-2">
      <Tooltip label={choice.muted ? `Unmute ${name} for you` : `Mute ${name} for you`}>
        <button
          type="button"
          aria-label={`Mute ${name} for you`}
          aria-pressed={choice.muted}
          onClick={() => set(userId, { muted: !choice.muted })}
          className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-ink/[0.06] ${
            choice.muted ? "text-alert" : "text-ink-dim hover:text-ink"
          }`}
        >
          <Icon name={choice.muted ? "volumeOff" : "volume"} size={16} />
        </button>
      </Tooltip>
      {/* Moving it means wanting to hear them, so it unmutes as well. */}
      <input
        type="range"
        min={0}
        max={MAX_VOLUME}
        step={5}
        list={marks}
        value={choice.volume}
        aria-label={`${name}'s volume`}
        aria-valuetext={`${choice.volume}%`}
        onChange={(event) => set(userId, { volume: Number(event.target.value), muted: false })}
        className="min-w-0 flex-1"
      />
      {/* A mark where they are as they arrive, which the slider settles on near it. */}
      <datalist id={marks}>
        <option value={DEFAULT_VOLUME} />
      </datalist>
      <span
        aria-hidden="true"
        className={`tabular w-10 shrink-0 text-right text-xs ${
          choice.muted ? "text-alert" : "text-ink-dim"
        }`}
      >
        {choice.muted ? "Off" : `${choice.volume}%`}
      </span>
    </div>
  );
}
