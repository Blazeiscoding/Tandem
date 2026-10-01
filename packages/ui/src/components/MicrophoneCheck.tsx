import { useEffect, useRef, useState } from "react";
import { captureFailure, testMicrophone, type MicrophoneTest } from "@slackoss/client-core";
import { buttonClass } from "./Button.js";

type Check =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "listening"; label: string; metered: boolean; level: number }
  | { phase: "failed"; message: string };

/**
 * Hearing whether the microphone works before a huddle (CALL-01): which one
 * the browser opened, and a meter that moves when someone speaks. Nothing is
 * sent anywhere, and the microphone closes when the check stops or the
 * settings close.
 */
export function MicrophoneCheck() {
  const [check, setCheck] = useState<Check>({ phase: "idle" });
  const test = useRef<MicrophoneTest | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      test.current?.stop();
      test.current = null;
    };
  }, []);

  async function start() {
    setCheck({ phase: "starting" });
    try {
      const opened = await testMicrophone((level) => {
        if (alive.current) setCheck((now) => (now.phase === "listening" ? { ...now, level } : now));
      });
      if (!alive.current) {
        opened.stop();
        return;
      }
      test.current = opened;
      setCheck({ phase: "listening", label: opened.label, metered: opened.metered, level: 0 });
    } catch (err) {
      if (alive.current)
        setCheck({
          phase: "failed",
          message: captureFailure("microphone", err) ?? "Your microphone could not start.",
        });
    }
  }

  function stop() {
    test.current?.stop();
    test.current = null;
    setCheck({ phase: "idle" });
  }

  // A peak of half the range already reads as speaking loudly.
  const percent = check.phase === "listening" ? Math.min(100, Math.round(check.level * 200)) : 0;
  return (
    <div className="mt-4 space-y-2">
      {check.phase === "listening" ? (
        <>
          <p className="text-sm">
            Listening to {check.label ? <strong>{check.label}</strong> : "your default microphone"}.
            {check.metered
              ? " Say something: the bar should move."
              : " It opened, but this browser cannot show how loud it is."}{" "}
            Nothing is sent to anyone.
          </p>
          {check.metered && (
            <div
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 w-full overflow-hidden rounded bg-lifted"
            >
              <div className="h-full bg-online" style={{ width: `${percent}%` }} />
            </div>
          )}
          <button type="button" className={buttonClass("secondary")} onClick={stop}>
            Stop test
          </button>
        </>
      ) : (
        <button
          type="button"
          className={buttonClass("secondary")}
          disabled={check.phase === "starting"}
          onClick={() => void start()}
        >
          {check.phase === "starting" ? "Opening the microphone…" : "Test microphone"}
        </button>
      )}
      {check.phase === "failed" && (
        <p role="alert" className="text-sm text-alert">
          {check.message}
        </p>
      )}
    </div>
  );
}
