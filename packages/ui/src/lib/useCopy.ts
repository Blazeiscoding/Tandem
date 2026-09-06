import { useCallback, useEffect, useRef, useState } from "react";

type CopyState = { key: string; ok: boolean } | null;

/**
 * Reports a clipboard write only once it has actually happened.
 *
 * `navigator.clipboard.writeText` is refused often enough to matter — an
 * insecure origin, a window that lost focus, a browser policy — and a button
 * that says "Copied" when nothing was copied costs the reader whatever they
 * paste next.
 */
export function useCopy(resetMs = 1500) {
  const [state, setState] = useState<CopyState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = useCallback(
    async (text: string, key = "default") => {
      if (timer.current) clearTimeout(timer.current);
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
      setState({ key, ok });
      timer.current = setTimeout(() => setState(null), resetMs);
    },
    [resetMs],
  );

  /** What the button should read right now. */
  const label = useCallback(
    (idle: string, done: string, failed: string, key = "default") =>
      state?.key !== key ? idle : state.ok ? done : failed,
    [state],
  );

  return { copy, label, copied: state };
}
