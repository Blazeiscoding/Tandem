import { useId, useRef, useState } from "react";
import { findEmoji } from "../lib/emoji.js";
import { isImeKey } from "../lib/textInput.js";
import { useListbox } from "../lib/useListbox.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

export const MESSAGE_LIMIT = 12_000;
export const formattingShortcut = (key: string) => ({ b: "*", i: "_", e: "`" })[key.toLowerCase()];

/** Keep composer and editor selection behavior identical. */
export function formatText(
  text: string,
  start: number,
  end: number,
  marker: string,
  placeholder = "text",
  block = false,
) {
  const selected = text.slice(start, end) || placeholder;
  const unwrap =
    !block &&
    start >= marker.length &&
    text.slice(start - marker.length, start) === marker &&
    text.slice(end, end + marker.length) === marker;
  const prefix = unwrap
    ? ""
    : block
      ? `${start > 0 && text[start - 1] !== "\n" ? "\n" : ""}${marker}\n`
      : marker;
  const suffix = unwrap
    ? ""
    : block
      ? `\n${marker}${end < text.length && text[end] !== "\n" ? "\n" : ""}`
      : marker;
  const from = unwrap ? start - marker.length : start;
  const to = unwrap ? end + marker.length : end;
  return {
    text: text.slice(0, from) + prefix + selected + suffix + text.slice(to),
    selectionStart: from + prefix.length,
    selectionEnd: from + prefix.length + selected.length,
  };
}

interface Props {
  onFormat: (marker: string, placeholder: string, block?: boolean) => void;
  onInsert: (text: string) => void;
  preview: boolean;
  onTogglePreview: () => void;
}

export function FormattingToolbar({ onFormat, onInsert, preview, onTogglePreview }: Props) {
  const [open, setOpen] = useState(false);
  // On a phone the formatting buttons fold away behind one, so the row
  // leaves room for what is being written. theme.css does the folding.
  const [expanded, setExpanded] = useState(false);
  const buttonsId = useId();
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const matches = findEmoji(query);
  const list = useListbox(matches.length);
  function insert(emoji: string) {
    onInsert(emoji);
    setOpen(false);
  }
  return (
    <>
      <div
        role="group"
        aria-label="Message formatting"
        className="flex flex-wrap items-center gap-0.5 border-b border-edge px-2 py-1 text-sm text-ink-dim"
      >
        <Tooltip label={expanded ? "Hide formatting" : "Formatting"}>
          <button
            type="button"
            aria-label="Formatting"
            aria-expanded={expanded}
            aria-controls={buttonsId}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setExpanded((v) => !v)}
            className="formatting-toggle items-center rounded px-2 py-1 text-xs font-semibold hover:bg-lifted"
          >
            Aa
          </button>
        </Tooltip>
        <span
          id={buttonsId}
          className="formatting-buttons contents"
          data-expanded={expanded || undefined}
        >
          {[
            { label: "Bold", symbol: "B", marker: "*", style: "font-bold", keys: "Ctrl/Cmd+B" },
            { label: "Italic", symbol: "I", marker: "_", style: "italic", keys: "Ctrl/Cmd+I" },
            { label: "Strikethrough", symbol: "S", marker: "~", style: "line-through" },
            {
              label: "Inline code",
              symbol: "</>",
              marker: "`",
              style: "font-mono text-xs",
              keys: "Ctrl/Cmd+E",
            },
          ].map((item) => (
            <Tooltip key={item.label} label={item.label} keys={item.keys}>
              <button
                type="button"
                aria-label={item.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onFormat(item.marker, "text")}
                className={`rounded px-2 py-1 hover:bg-lifted ${item.style}`}
              >
                {item.symbol}
              </button>
            </Tooltip>
          ))}
          <Tooltip label="Code block">
            <button
              type="button"
              aria-label="Code block"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFormat("```", "code", true)}
              className="rounded px-2 py-1 font-mono text-xs hover:bg-lifted"
            >
              {"{ }"}
            </button>
          </Tooltip>
        </span>
        <Tooltip label="Insert emoji">
          <button
            ref={trigger}
            type="button"
            aria-label="Insert emoji"
            aria-expanded={open}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpen((v) => !v);
              setQuery("");
            }}
            className="flex items-center rounded px-2 py-1 hover:bg-lifted"
          >
            <Icon name="smile" size={15} />
          </button>
        </Tooltip>
        <button
          type="button"
          aria-pressed={preview}
          onClick={onTogglePreview}
          className="ml-auto rounded px-2 py-1 text-xs hover:bg-lifted"
        >
          Preview
        </button>
      </div>
      {open && (
        <div
          role="group"
          aria-label="Choose an emoji"
          className="border-b border-edge p-2"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <input
            autoFocus
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
                insert(chosen[0]);
              }
            }}
            className="mb-2 w-full rounded border border-edge bg-ground px-2 py-1 text-sm outline-none focus:border-copper"
          />
          <ul
            {...list.listProps}
            aria-label="Emoji"
            className="grid max-h-36 grid-cols-6 gap-1 overflow-y-auto"
          >
            {matches.map(([emoji, label], i) => (
              <li
                key={label}
                {...list.optionProps(i)}
                aria-label={label}
                title={label}
                onClick={() => insert(emoji)}
                className={`cursor-pointer rounded p-1 text-center text-xl hover:bg-lifted ${
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
        </div>
      )}
    </>
  );
}
