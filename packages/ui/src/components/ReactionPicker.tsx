import { useState } from "react";
import { findEmoji } from "../lib/emoji.js";
import { isImeKey } from "../lib/textInput.js";
import { useListbox } from "../lib/useListbox.js";
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
  const list = useListbox(matches.length);
  function pick(emoji: string) {
    props.onClose();
    props.onPick(emoji);
  }
  return (
    <Dialog title="Add a reaction" onClose={props.onClose} width={360}>
      <input
        autoFocus={!touch}
        {...list.comboboxProps}
        aria-label="Search emoji"
        placeholder="Search emoji"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          list.choose(0);
        }}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent) || list.move(e)) return;
          const chosen = matches[list.active];
          if (e.key === "Enter" && chosen) {
            e.preventDefault();
            pick(chosen[0]);
          }
        }}
        className={`${inputCls} mb-3`}
      />
      <ul
        {...list.listProps}
        aria-label="Emoji"
        className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto"
      >
        {matches.map(([emoji, label], i) => (
          <li
            key={label}
            {...list.optionProps(i)}
            aria-label={label}
            onClick={() => pick(emoji)}
            className={`cursor-pointer rounded-lg p-1.5 text-center text-2xl transition-colors hover:bg-lifted ${
              i === list.active ? "bg-copper/15" : ""
            }`}
          >
            {emoji}
          </li>
        ))}
      </ul>
      {!matches.length && (
        <p role="status" className="py-2 text-sm text-ink-faint">
          No emoji matched. Try another word.
        </p>
      )}
    </Dialog>
  );
}
