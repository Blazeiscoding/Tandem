import { useState, type RefObject } from "react";
import { findEmoji } from "../lib/emoji.js";
import { isImeKey } from "../lib/textInput.js";
import { useListbox } from "../lib/useListbox.js";
import { Dialog, inputCls } from "./Dialog.js";
import { Popover } from "./Popover.js";

/**
 * Any emoji as a reaction, not only the six the message toolbar offers. With
 * a pointer it hangs off the message it reacts to, as Slack's and Discord's
 * do, so the message stays in sight; on a touchscreen it is a dialog of its
 * own, and the search box waits to be tapped, so opening the picker does not
 * raise a keyboard over the emoji.
 */
export function ReactionPicker(props: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** The message it reacts to, for the picker to sit beside. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [touch] = useState(() => window.matchMedia?.("(hover: none)").matches ?? false);
  const matches = findEmoji(query);
  const list = useListbox(matches.length);
  function pick(emoji: string) {
    props.onClose();
    props.onPick(emoji);
  }
  const body = (
    <>
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
            className={`cursor-pointer rounded-lg p-1.5 text-center text-2xl transition-colors hover:bg-ink/[0.05] ${
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
    </>
  );
  if (props.anchor && !touch)
    return (
      <Popover label="Add a reaction" anchor={props.anchor} onClose={props.onClose} width={320}>
        <div className="p-3">{body}</div>
      </Popover>
    );
  return (
    <Dialog title="Add a reaction" onClose={props.onClose} width={360}>
      {body}
    </Dialog>
  );
}
