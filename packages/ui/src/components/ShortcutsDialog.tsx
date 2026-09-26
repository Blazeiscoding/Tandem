import { useComposerPreferences } from "../lib/composerPreferences.js";
import { useState } from "react";
import { Dialog, inputCls } from "./Dialog.js";

/** What Enter does depends on the preference in Account settings, so the list follows it. */
function writingKeys(enterSends: boolean): [string, string][] {
  return enterSends
    ? [
        ["Enter", "Send"],
        ["Shift Enter", "New line"],
        ["Ctrl Enter", "Send without choosing a mention"],
      ]
    : [
        ["Ctrl Enter", "Send"],
        ["Enter", "New line"],
      ];
}

const groups = (
  enterSends: boolean,
): { title: string; items: [string, string][]; note?: string }[] => [
  {
    title: "Getting around",
    items: [
      ["Ctrl K", "Jump to a channel or person"],
      ["Ctrl F", "Search messages"],
      ["Esc", "Close the open panel or dialog"],
      ["Ctrl /", "Show this list"],
    ],
  },
  {
    title: "Writing",
    note: "Choose what Enter does in Account settings.",
    items: [
      ...writingKeys(enterSends),
      ["Ctrl B", "Bold selected text"],
      ["Ctrl I", "Italic selected text"],
      ["Ctrl E", "Inline code"],
      ["@", "Mention someone"],
      ["Ctrl V", "Paste an image straight in"],
    ],
  },
  {
    title: "Messages",
    note: "The list of messages is one Tab stop; these work once it has focus.",
    items: [
      ["↑", "Previous message"],
      ["↓", "Next message"],
      ["Home", "First message"],
      ["End", "Last message"],
      ["Enter", "Into the message's actions"],
      ["Esc", "Back out to the message, or cancel an edit"],
    ],
  },
];

/** A shortcut matches when every word typed is in its keys or what it does. */
function matches(query: string, keys: string, what: string): boolean {
  const haystack = `${keys} ${what}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { enterSends } = useComposerPreferences();
  const [query, setQuery] = useState("");
  const shown = groups(enterSends)
    .map((group) => ({
      ...group,
      items: group.items.filter(([keys, what]) => matches(query, keys, what)),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={460}>
      <label className="mb-4 block text-sm">
        <span className="sr-only">Find a shortcut</span>
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a shortcut"
          className={inputCls}
        />
      </label>
      <p role="status" className="mb-2 text-sm text-ink-faint empty:hidden">
        {shown.length === 0 ? "No shortcut matches. Try another word." : ""}
      </p>
      <div className="space-y-4">
        {shown.map((group) => (
          <section key={group.title}>
            <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
              {group.title}
            </h3>
            <ul className="space-y-1">
              {group.items.map(([keys, what]) => (
                <li key={keys} className="flex items-baseline gap-3 text-sm">
                  <span className="flex shrink-0 gap-1">
                    {keys.split(" ").map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-edge bg-ground px-1.5 py-0.5 font-mono text-[11px] text-ink-dim"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                  <span className="text-ink-dim">{what}</span>
                </li>
              ))}
            </ul>
            {group.note && <p className="mt-2 text-xs text-ink-faint">{group.note}</p>}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
