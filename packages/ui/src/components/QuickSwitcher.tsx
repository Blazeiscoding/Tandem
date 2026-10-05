import { useEffect, useMemo, useRef, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Modal } from "./Modal.js";
import { isImeKey } from "../lib/textInput.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { useListbox } from "../lib/useListbox.js";

type SwitcherRow =
  | { kind: "public" | "private" | "conversation"; id: ID; label: string }
  /** `channelId` is set when a direct conversation with this person already exists. */
  | { kind: "person"; id: ID; label: string; channelId?: ID };

const SWITCHER_ICON: Record<SwitcherRow["kind"], React.ReactNode> = {
  public: "#",
  private: <Icon name="lock" size={13} />,
  conversation: "@",
  person: "@",
};

/** What each row is, for a screen reader, which cannot see its sign. */
const SWITCHER_KIND: Record<SwitcherRow["kind"], string> = {
  public: "channel",
  private: "private channel",
  conversation: "conversation",
  person: "person",
};

/** Ctrl+K — jump to any channel, DM, or person. */
export function QuickSwitcher(props: { onClose: () => void; onOpen: (channelId: ID) => void }) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const [q, setQ] = useState("");
  /** A person whose new direct conversation is being started, or failed to start. */
  const [opening, setOpening] = useState<SwitcherRow | null>(null);
  const [failed, setFailed] = useState<SwitcherRow | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const results = useMemo(() => {
    // "#des" and "@al" are how people write names here; the sign is not part of one.
    const query = q.trim().toLowerCase().replace(/^[#@]/, "");
    const matches = (text: string) => text.toLowerCase().includes(query);
    const rows: SwitcherRow[] = [];
    // A conversation with one other person is that person, and is listed once,
    // as them. It opens directly rather than asking the server for it again.
    const directWith = new Map<ID, ID>();
    for (const c of Object.values(channels)) {
      if (c.archived) continue;
      if (c.type === "public" || c.type === "private") {
        if (matches(c.name))
          rows.push({ kind: c.type === "private" ? "private" : "public", id: c.id, label: c.name });
        continue;
      }
      const others = (c.memberIds ?? []).filter((id) => id !== selfId);
      const other = others.length === 1 ? users[others[0]!] : undefined;
      if (c.type === "dm" && other && !other.deactivated) {
        directWith.set(other.id, c.id);
        continue;
      }
      const label = channelTitle(c, users, selfId);
      if (matches(label)) rows.push({ kind: "conversation", id: c.id, label });
    }
    for (const u of Object.values(users)) {
      if (u.id === selfId || u.deactivated) continue;
      if (!u.handle.includes(query) && !matches(u.displayName)) continue;
      rows.push({
        kind: "person",
        id: u.id,
        label: u.displayName,
        channelId: directWith.get(u.id),
      });
    }
    return rows.slice(0, 12);
  }, [q, channels, users, selfId]);
  const list = useListbox(results.length);

  async function open(r: SwitcherRow) {
    if (r.kind !== "person") return props.onOpen(r.id);
    if (r.channelId) return props.onOpen(r.channelId);
    if (opening) return;
    setOpening(r);
    setFailed(null);
    try {
      const channel = await client.openDm([r.id]);
      // Closed while the server answered: somebody who pressed Escape has moved on.
      if (mounted.current) props.onOpen(channel.id);
    } catch {
      if (mounted.current) setFailed(r);
    } finally {
      if (mounted.current) setOpening(null);
    }
  }

  const query = q.trim();

  return (
    // A palette rather than a dialog: no title bar, no animation, because it
    // opens dozens of times a day from the keyboard and must feel instant.
    <Modal
      title="Jump to"
      onClose={props.onClose}
      backdropClassName="flex items-start justify-center bg-black/45 px-3 pt-[14vh] backdrop-blur-[2px]"
      className="w-[560px] max-w-full overflow-hidden rounded-2xl border border-edge bg-raised shadow-[var(--shadow-dialog)] outline-none"
    >
      <div className="flex items-center gap-3 border-b border-edge px-4">
        <Icon name="search" size={18} className="text-ink-faint" />
        <input
          autoFocus
          {...list.comboboxProps}
          aria-label="Channel or person"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            list.choose(0);
            setFailed(null);
          }}
          onKeyDown={(e) => {
            // Enter chooses among an input method's candidates. Jumping to a
            // channel on it would take somebody out of the box mid-word.
            if (isImeKey(e.nativeEvent)) return;
            if (list.move(e)) return;
            const chosen = results[list.active];
            if (e.key === "Enter" && chosen) void open(chosen);
          }}
          placeholder="Channel or person"
          className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-faint"
        />
        {/* For a finger or a pointer; the keyboard has Escape. */}
        <button
          type="button"
          aria-label="Close"
          onClick={props.onClose}
          className="-mr-1.5 flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="max-h-[52vh] overflow-y-auto p-2">
        <ListStatus
          loading={opening !== null}
          loadingLabel={`Opening a conversation with ${opening?.label ?? ""}…`}
          error={failed && `Could not open a conversation with ${failed.label}.`}
          onRetry={() => failed && void open(failed)}
          retryLabel="Try again"
          empty={
            results.length === 0 &&
            (query
              ? `No channel or person matches “${query}”.`
              : "No channels or people to jump to yet.")
          }
          className="px-2"
        />
        {results.length > 0 && (
          <p aria-hidden="true" className="px-2.5 pb-1 pt-1 text-[12px] font-medium text-ink-faint">
            {query ? "Matches" : "Channels and people"}
          </p>
        )}
        {/* Options, not buttons: the box keeps focus, and the arrow keys move the choice. */}
        <ul {...list.listProps} aria-label="Matches">
          {results.map((r, i) => (
            <li
              key={`${r.kind}:${r.id}`}
              {...list.optionProps(i)}
              aria-label={`${r.label}, ${SWITCHER_KIND[r.kind]}`}
              onClick={() => void open(r)}
              className={`relative flex h-9 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left text-sm ${
                i === list.active
                  ? "bg-ink/[0.07] text-ink after:absolute after:right-3 after:text-[12px] after:text-ink-faint after:content-['↵']"
                  : "text-ink-dim"
              }`}
            >
              <span
                aria-hidden
                className="flex size-6 items-center justify-center rounded-md border border-edge text-ink-faint"
              >
                {SWITCHER_ICON[r.kind]}
              </span>
              {r.label}
            </li>
          ))}
        </ul>
      </div>
      <footer
        aria-hidden="true"
        className="flex items-center gap-4 border-t border-edge px-4 py-2 text-[11px] text-ink-faint"
      >
        <span>↑ ↓ to move</span>
        <span>↵ to open</span>
        <span className="ml-auto">esc to close</span>
      </footer>
    </Modal>
  );
}
