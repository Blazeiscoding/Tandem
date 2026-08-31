import { useMemo, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Dialog, inputCls } from "./Dialog.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { formatTime } from "../lib/format.js";

/** Ctrl+K — jump to any channel, DM, or person. */
export function QuickSwitcher(props: { onClose: () => void; onOpen: (channelId: ID) => void }) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);

  const results = useMemo(() => {
    const query = q.toLowerCase();
    const chans = Object.values(channels)
      .filter((c) => !c.archived)
      .map((c) => ({
        kind: "channel" as const,
        id: c.id,
        label:
          c.type === "public" || c.type === "private"
            ? `#${c.name}`
            : channelTitle(c, users, selfId),
      }))
      .filter((r) => r.label.toLowerCase().includes(query));
    const people = Object.values(users)
      .filter((u) => u.id !== selfId && !u.deactivated)
      .filter(
        (u) => u.handle.includes(query) || u.displayName.toLowerCase().includes(query),
      )
      .map((u) => ({ kind: "user" as const, id: u.id, label: u.displayName }));
    return [...chans, ...people].slice(0, 12);
  }, [q, channels, users, selfId]);

  async function open(r: (typeof results)[number]) {
    if (r.kind === "channel") {
      props.onOpen(r.id);
    } else {
      const ch = await client.openDm([r.id]);
      props.onOpen(ch.id);
    }
  }

  return (
    <Dialog title="Jump to" onClose={props.onClose} width={480}>
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
          } else if (e.key === "Enter" && results[index]) {
            void open(results[index]);
          }
        }}
        placeholder="Channel or person"
        className={inputCls}
      />
      <ul className="mt-2">
        {results.map((r, i) => (
          <li key={`${r.kind}:${r.id}`}>
            <button
              onClick={() => void open(r)}
              onMouseEnter={() => setIndex(i)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                i === index ? "bg-copper/15 text-copper" : "text-ink-dim"
              }`}
            >
              <span className="w-4 text-center text-ink-faint">
                {r.kind === "channel" ? "#" : "@"}
              </span>
              {r.label}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Full-text message search over the workspace. */
export function SearchDialog(props: { onClose: () => void; onJump: (channelId: ID) => void }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof client.api.search>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      setResults(await client.api.search(q.trim()));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Search messages" onClose={props.onClose} width={560}>
      <form onSubmit={run} className="mb-3 flex gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search every channel you can see"
          className={inputCls}
        />
      </form>
      {busy && <p className="py-4 text-center text-sm text-ink-faint">Searching…</p>}
      {results && !busy && (
        <ul className="space-y-2">
          {results.messages.map((m) => {
            const ch = channels[m.channelId];
            return (
              <li key={m.id}>
                <button
                  onClick={() => props.onJump(m.channelId)}
                  className="w-full rounded-lg border border-edge bg-ground p-3 text-left transition-colors hover:border-copper/50"
                >
                  <div className="mb-1 flex items-baseline gap-2 text-[12px] text-ink-faint">
                    <span className="font-medium text-copper">
                      {ch ? (ch.name ? `#${ch.name}` : "Direct message") : "unknown"}
                    </span>
                    <span>{users[m.userId]?.displayName}</span>
                    <span className="ml-auto font-mono">{formatTime(m.createdAt)}</span>
                  </div>
                  <div className="text-sm">
                    <Mrkdwn text={m.text} users={users} channels={channels} />
                  </div>
                </button>
              </li>
            );
          })}
          {results.messages.length === 0 && (
            <p className="py-4 text-center text-sm text-ink-faint">
              Nothing matched. Try different words.
            </p>
          )}
        </ul>
      )}
    </Dialog>
  );
}
