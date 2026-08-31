import { Dialog } from "./Dialog.js";

const GROUPS: { title: string; items: [string, string][] }[] = [
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
    items: [
      ["Enter", "Send"],
      ["Shift Enter", "New line"],
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
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={460}>
      <div className="space-y-4">
        {GROUPS.map((group) => (
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
          </section>
        ))}
      </div>
    </Dialog>
  );
}
