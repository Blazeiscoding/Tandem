import { useState } from "react";
import { captureFailure } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

/**
 * Microphone, camera, screen and Leave. The huddle bar shows them, and so does
 * the stage in full screen, where the bar is out of sight.
 *
 * A toggle names what it controls, and aria-pressed, not the name, says whether
 * it is on: a screen reader hears the same button before and after a press.
 */
export function HuddleControls({ overlay = false }: { overlay?: boolean }) {
  const client = useClient();
  const huddle = useWorkspace((s) => s.huddle);
  const [busy, setBusy] = useState<"screen" | "camera" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  if (!huddle) return null;

  /**
   * A closed picker says nothing. A blocked permission, a missing device or a
   * page that cannot ask says what to do about it, where it used to say
   * nothing either (CALL-01).
   */
  const guarded = async (which: "screen" | "camera", run: () => Promise<void>) => {
    setBusy(which);
    setFailure(null);
    try {
      await run();
    } catch (err) {
      setFailure(captureFailure(which, err));
    } finally {
      setBusy(null);
    }
  };

  const off = overlay
    ? "border-white/15 bg-black/45 text-white hover:bg-black/65"
    : "border-edge text-ink-dim hover:border-ink-faint hover:text-ink";
  const toggleCls = (on: boolean, onCls: string) =>
    `flex size-11 items-center justify-center rounded-xl border transition-colors disabled:opacity-50 ${
      on ? onCls : off
    }`;
  const lit = overlay ? "border-copper bg-black/45 text-copper" : "border-copper text-copper";

  return (
    <>
      <div
        role="group"
        aria-label="Huddle controls"
        className={`flex shrink-0 items-center gap-2 ${
          overlay ? "rounded-2xl bg-black/35 p-2 backdrop-blur" : "ml-auto"
        }`}
      >
        <Tooltip label={huddle.micMuted ? "Unmute" : "Mute"}>
          <button
            aria-label="Mute microphone"
            aria-pressed={huddle.micMuted}
            onClick={() => client.toggleMic()}
            className={toggleCls(
              huddle.micMuted,
              overlay ? "border-alert bg-black/45 text-alert" : "border-alert text-alert",
            )}
          >
            <Icon name={huddle.micMuted ? "micOff" : "mic"} />
          </button>
        </Tooltip>
        <Tooltip label={huddle.cameraOn ? "Turn your camera off" : "Turn your camera on"}>
          <button
            aria-label="Camera"
            aria-pressed={huddle.cameraOn}
            onClick={() => void guarded("camera", () => client.toggleCamera())}
            disabled={busy !== null}
            className={toggleCls(huddle.cameraOn, lit)}
          >
            <Icon name="camera" />
          </button>
        </Tooltip>
        <Tooltip label={huddle.sharingScreen ? "Stop sharing" : "Share your screen"}>
          <button
            aria-label="Share screen"
            aria-pressed={huddle.sharingScreen}
            onClick={() => void guarded("screen", () => client.toggleScreenShare())}
            disabled={busy !== null}
            className={toggleCls(huddle.sharingScreen, lit)}
          >
            <Icon name="screen" />
          </button>
        </Tooltip>
        {/* Leave keeps its word: an arrow out of a door reads as signing out just as easily. */}
        <button
          onClick={() => client.leaveHuddle()}
          className="flex h-11 items-center gap-2 rounded-xl bg-alert px-4 text-sm font-semibold text-ground transition-colors hover:bg-alert/85"
        >
          <Icon name="leave" size={16} />
          Leave
        </button>
      </div>
      {huddle.micLost && (
        <p
          role="alert"
          className={`flex basis-full items-center justify-end gap-3 text-xs ${
            overlay ? "mt-2 rounded-lg bg-black/60 px-3 py-2 text-white" : "text-alert"
          }`}
        >
          <span>
            Your microphone stopped, so nobody can hear you. Connect one, and it is used as soon as
            it is found.
          </span>
          <button
            type="button"
            onClick={() => client.retryMicrophone()}
            className="shrink-0 rounded-lg border border-current px-2 py-1 font-medium"
          >
            Try again
          </button>
        </p>
      )}
      {failure && (
        <p
          role="alert"
          className={`flex basis-full items-start justify-end gap-2 text-xs ${
            overlay ? "mt-2 rounded-lg bg-black/60 px-3 py-2 text-white" : "text-alert"
          }`}
        >
          <span>{failure}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setFailure(null)}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <Icon name="close" size={12} />
          </button>
        </p>
      )}
    </>
  );
}
