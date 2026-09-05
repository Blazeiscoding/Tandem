import { useEffect, useRef } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}

export function Dialog({ title, onClose, children, width = 440 }: Props) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Capture before child autoFocus runs during commit.
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = previousFocus.current;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key !== "Tab") return;
      const targets = [
        ...(panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ].filter((el) => el.getClientRects().length > 0);
      const first = targets[0];
      const last = targets.at(-1);
      if (!first) {
        e.preventDefault();
        panel.current?.focus();
        return;
      }
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || document.activeElement === panel.current)
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div
      ref={backdrop}
      onMouseDown={(e) => {
        if (e.target === backdrop.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-3 pt-[10vh]"
    >
      <div
        role="dialog"
        ref={panel}
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
        className="max-h-[80vh] max-w-full overflow-y-auto rounded-2xl border border-edge bg-raised p-5 shadow-2xl outline-none"
        style={{ width }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const inputCls =
  "w-full rounded-lg border border-edge bg-ground px-3 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-copper";

export const primaryBtnCls =
  "rounded-lg bg-copper px-4 py-2.5 text-sm font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40";
