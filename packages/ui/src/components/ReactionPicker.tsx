import { useState } from "react";
import { findEmoji } from "../lib/emoji.js";
import { Dialog, inputCls } from "./Dialog.js";

/**
 * Any emoji as a reaction, not only the six the message toolbar offers. On a
 * touchscreen the search box waits to be tapped, so opening the picker does
 * not raise a keyboard over the emoji.
 */
export function ReactionPicker(props: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [touch] = useState(() => window.matchMedia?.("(hover: none)").matches ?? false);
  const matches = findEmoji(query);
  return (
    <Dialog title="Add a reaction" onClose={props.onClose} width={360}>
      <input
        autoFocus={!touch}
        aria-label="Search emoji"
        placeholder="Search emoji"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={`${inputCls} mb-3`}
      />
      <div
        role="group"
        aria-label="Emoji"
        className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto"
      >
        {matches.map(([emoji, label]) => (
          <button
            type="button"
            key={label}
            aria-label={label}
            onClick={() => {
              props.onClose();
              props.onPick(emoji);
            }}
            className="rounded-lg p-1.5 text-2xl transition-colors hover:bg-lifted"
          >
            {emoji}
          </button>
        ))}
      </div>
      {!matches.length && (
        <p role="status" className="py-2 text-sm text-ink-faint">
          No emoji matched. Try another word.
        </p>
      )}
    </Dialog>
  );
}
