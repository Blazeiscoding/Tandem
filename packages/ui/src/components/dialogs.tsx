import { useMemo, useState } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

export function NewChannelDialog(props: { onClose: () => void; onCreated: (ch: Channel) => void }) {
  const client = useClient();
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = name.trim().toLowerCase().replaceAll(/\s+/g, "-");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { channel } = await client.api.createChannel({
        type: isPrivate ? "private" : "public",
        name: slug,
      });
      props.onCreated(channel);
    } catch {
      setError("Couldn't create the channel — maybe the name is taken.");
    }
  }

  return (
    <Dialog title="New channel" onClose={props.onClose}>
      <form onSubmit={create} className="space-y-3">
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
            #
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="release-party"
            className={`${inputCls} pl-7`}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-dim">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="accent-copper"
          />
          Private — only invited members can see it
        </label>
        {error && <p className="text-sm text-alert">{error}</p>}
        <button type="submit" disabled={!slug} className={`${primaryBtnCls} w-full`}>
          Create {slug ? `#${slug}` : "channel"}
        </button>
      </form>
    </Dialog>
  );
}

export function BrowseChannelsDialog(props: { onClose: () => void; onOpen: (id: ID) => void }) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const [q, setQ] = useState("");

  const rooms = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.type === "public" && !c.archived)
        .filter((c) => c.name.includes(q.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels, q],
  );

  return (
    <Dialog title="All channels" onClose={props.onClose} width={480}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter channels"
        className={`${inputCls} mb-3`}
      />
      <ul className="space-y-1">
        {rooms.map((ch) => {
          const joined = ch.id in memberships;
          return (
            <li
              key={ch.id}
              className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-lifted"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">#{ch.name}</div>
                {ch.description && (
                  <div className="truncate text-xs text-ink-faint">{ch.description}</div>
                )}
              </div>
              {joined ? (
                <button
                  onClick={() => props.onOpen(ch.id)}
                  className="rounded-lg border border-edge px-3 py-1 text-sm text-ink-dim hover:text-ink"
                >
                  Open
                </button>
              ) : (
                <button
                  onClick={async () => {
                    await client.api.joinChannel(ch.id);
                    props.onOpen(ch.id);
                  }}
                  className="rounded-lg bg-copper px-3 py-1 text-sm font-semibold text-ground hover:bg-copper-deep"
                >
                  Join
                </button>
              )}
            </li>
          );
        })}
        {rooms.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">No channels match.</p>
        )}
      </ul>
    </Dialog>
  );
}

export function NewDmDialog(props: { onClose: () => void; onOpen: (id: ID) => void }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const presence = useWorkspace((s) => s.presence);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ID[]>([]);

  const candidates = Object.values(users)
    .filter((u) => u.id !== selfId && !u.deactivated && !u.isBot)
    .filter(
      (u) =>
        u.handle.includes(q.toLowerCase()) || u.displayName.toLowerCase().includes(q.toLowerCase()),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  async function start() {
    const channel = await client.openDm(picked);
    props.onOpen(channel.id);
  }

  return (
    <Dialog title="New message" onClose={props.onClose}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people"
        className={`${inputCls} mb-3`}
      />
      <ul className="mb-4 max-h-[300px] space-y-0.5 overflow-y-auto">
        {candidates.map((u) => (
          <li key={u.id}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-lifted">
              <input
                type="checkbox"
                checked={picked.includes(u.id)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, u.id] : p.filter((x) => x !== u.id)))
                }
                className="accent-copper"
              />
              <Avatar user={u} size={26} />
              <span className="min-w-0 flex-1 truncate">{u.displayName}</span>
              <span
                className={`size-2 rounded-full ${presence[u.id] === "online" ? "bg-online" : "bg-edge"}`}
              />
            </label>
          </li>
        ))}
        {candidates.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">
            {Object.keys(users).length <= 1 ? "You're the only one here so far." : "No one matches."}
          </p>
        )}
      </ul>
      <button onClick={start} disabled={picked.length === 0} className={`${primaryBtnCls} w-full`}>
        Start conversation
      </button>
    </Dialog>
  );
}

export function InviteDialog(props: { onClose: () => void }) {
  const client = useClient();
  const [invite, setInvite] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const host = client.baseUrl.replace(/^https?:\/\//, "");
  const link = invite ? `slackoss://join?host=${host}&code=${invite}` : null;

  async function generate() {
    const { invite } = await client.api.createInvite({ expiresInHours: 24 * 7 });
    setInvite(invite.code);
  }

  function copy(text: string, which: string) {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <Dialog title="Invite people" onClose={props.onClose}>
      <p className="mb-4 text-sm text-ink-dim">
        Teammates on your network can find this workspace automatically. Anyone else needs the
        address — and an invite code if the workspace is invite-only.
      </p>
      <div className="mb-4 rounded-lg border border-edge bg-ground p-3">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          Server address
        </div>
        <div className="flex items-center justify-between gap-2">
          <code className="font-mono text-sm text-copper">{host}</code>
          <button
            onClick={() => copy(host, "host")}
            className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-lifted"
          >
            {copied === "host" ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {invite ? (
        <div className="rounded-lg border border-edge bg-ground p-3">
          <div className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            Invite code · valid 7 days
          </div>
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-lg font-bold tracking-[0.2em] text-copper">
              {invite}
            </code>
            <button
              onClick={() => copy(link!, "link")}
              className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-lifted"
            >
              {copied === "link" ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={generate} className={`${primaryBtnCls} w-full`}>
          Generate invite code
        </button>
      )}
    </Dialog>
  );
}
