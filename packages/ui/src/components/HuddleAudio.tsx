import { useCallback, useEffect, useRef, useState } from "react";
import type { HuddlePeer } from "@slackoss/client-core";
import type { ID } from "@slackoss/protocol";

type PlaybackFailure = "gesture" | "failed";

function playbackFailure(error: unknown): PlaybackFailure | null {
  // Replacing a stream can interrupt play without leaving anything to recover.
  if (error instanceof DOMException && error.name === "AbortError") return null;
  return error instanceof DOMException && error.name === "NotAllowedError" ? "gesture" : "failed";
}

type PlaybackCallbacks = {
  register: (id: ID, retry: (() => void) | null) => void;
  report: (id: ID, failure: PlaybackFailure | null) => void;
};

/** Attach each microphone stream even when the call has no video. */
function PeerAudio({ peer, register, report }: { peer: HuddlePeer } & PlaybackCallbacks) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !peer.audioStream) return;
    let active = true;
    let attempt = 0;
    element.srcObject = peer.audioStream;
    const play = () => {
      const ticket = ++attempt;
      const settled = (failure: PlaybackFailure | null) => {
        if (active && ticket === attempt) report(peer.userId, failure);
      };
      try {
        // The retry calls play directly from the button's user gesture.
        void Promise.resolve(element.play()).then(
          () => settled(null),
          (error: unknown) => settled(playbackFailure(error)),
        );
      } catch (error) {
        settled(playbackFailure(error));
      }
    };
    register(peer.userId, play);
    play();
    return () => {
      active = false;
      register(peer.userId, null);
      report(peer.userId, null);
      element.srcObject = null;
    };
  }, [peer.audioStream, peer.userId, register, report]);
  return <audio ref={ref} autoPlay hidden />;
}

/** One gesture retries all blocked peers, without restarting audible streams. */
export function HuddleAudio({ peers }: { peers: HuddlePeer[] }) {
  const retries = useRef(new Map<ID, () => void>());
  const [blocked, setBlocked] = useState<Map<ID, PlaybackFailure>>(() => new Map());
  const register = useCallback<PlaybackCallbacks["register"]>((id, retry) => {
    if (retry) retries.current.set(id, retry);
    else retries.current.delete(id);
  }, []);
  const report = useCallback<PlaybackCallbacks["report"]>((id, value) => {
    setBlocked((previous) => {
      if (previous.get(id) === (value ?? undefined)) return previous;
      const next = new Map(previous);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });
  }, []);
  const retry = useCallback(() => {
    for (const id of blocked.keys()) retries.current.get(id)?.();
  }, [blocked]);
  const heldBack = [...blocked.values()].includes("gesture");
  useEffect(() => {
    if (!heldBack) return;
    // A fullscreen stage can hide the bar. Its next gesture also releases
    // autoplay, while the button itself retries once in its click handler.
    const onGesture = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-huddle-audio-retry]"))
        return;
      for (const [id, failure] of blocked) {
        if (failure === "gesture") retries.current.get(id)?.();
      }
    };
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
    return () => {
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }, [blocked, heldBack]);
  return (
    <>
      {peers.map((peer) => (
        <PeerAudio key={peer.userId} peer={peer} register={register} report={report} />
      ))}
      {blocked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span role={heldBack ? "alert" : "status"} className="text-xs text-ink-dim">
            {heldBack
              ? "Your browser is holding back the huddle's sound."
              : "Call audio could not start."}
          </span>
          <button
            type="button"
            data-huddle-audio-retry
            onClick={retry}
            className="h-11 rounded-xl border border-edge px-3 text-sm text-ink hover:border-ink-faint"
          >
            Turn on sound
          </button>
        </div>
      )}
    </>
  );
}
