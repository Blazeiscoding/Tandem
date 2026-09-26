import { useEffect, useMemo, useRef, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Dialog, inputCls } from "./Dialog.js";
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
    <Dialog title="Jump to" onClose={props.onClose} width={480}>
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
        className={inputCls}
      />
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
        className="mt-2"
      />
      {/* Options, not buttons: the box keeps focus, and the arrow keys move the choice. */}
      <ul {...list.listProps} aria-label="Matches" className="mt-2">
        {results.map((r, i) => (
          <li
            key={`${r.kind}:${r.id}`}
            {...list.optionProps(i)}
            aria-label={`${r.label}, ${SWITCHER_KIND[r.kind]}`}
            onClick={() => void open(r)}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
              i === list.active ? "bg-copper/15 text-copper" : "text-ink-dim"
            }`}
          >
            <span aria-hidden className="flex w-4 justify-center text-ink-faint">
              {SWITCHER_ICON[r.kind]}
            </span>
            {r.label}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
