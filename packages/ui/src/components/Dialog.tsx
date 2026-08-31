import { useEffect, useRef } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}

export function Dialog({ title, onClose, children, width = 440 }: Props) {
  const backdrop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={backdrop}
      onMouseDown={(e) => {
        if (e.target === backdrop.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-label={title}
        className="max-h-[70vh] overflow-y-auto rounded-2xl border border-edge bg-raised p-5 shadow-2xl"
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
