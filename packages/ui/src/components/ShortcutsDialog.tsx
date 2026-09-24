import { useComposerPreferences } from "../lib/composerPreferences.js";
import { Dialog } from "./Dialog.js";

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
    title: "On a message",
    items: [
      ["Hover", "Reactions, reply, link, save, pin"],
      ["Esc", "Cancel an edit"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { enterSends } = useComposerPreferences();
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={460}>
      <div className="space-y-4">
        {groups(enterSends).map((group) => (
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
