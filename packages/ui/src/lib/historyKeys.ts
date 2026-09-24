import { useEffect } from "react";

/**
 * Alt+Left and Alt+Right, and a mouse's side buttons, go Back and Forward.
 * A browser does this already; the desktop window has no toolbar, so it is
 * switched on there.
 */
export function useHistoryKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === "ArrowLeft") window.history.back();
      else if (e.key === "ArrowRight") window.history.forward();
      else return;
      e.preventDefault();
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) window.history.back();
      else if (e.button === 4) window.history.forward();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [enabled]);
}
