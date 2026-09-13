import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@slackoss/client-core";
import { useCopy } from "../lib/useCopy.js";
import type { Channel, ID, Invite, InviteStatus } from "@slackoss/protocol";
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
  const [showArchived, setShowArchived] = useState(false);

  const rooms = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => (c.type === "public" || c.type === "private") && c.archived === showArchived)
        .filter((c) => c.name.includes(q.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels, q, showArchived],
  );

  return (
    <Dialog title="All channels" onClose={props.onClose} width={480}>
      <label className="mb-3 flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived channels
      </label>
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
              {joined || ch.archived ? (
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

export function NewDmDialog(props: {
  onClose: () => void;
  onOpen: (id: ID) => void;
  initialMemberIds?: ID[];
}) {
  const client = useClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const presence = useWorkspace((s) => s.presence);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ID[]>(() =>
    [...new Set(props.initialMemberIds ?? [])].filter((id) => id !== selfId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = Object.values(users)
    .filter((u) => u.id !== selfId && ((!u.deactivated && !u.isBot) || picked.includes(u.id)))
    .filter(
      (u) =>
        u.handle.includes(q.toLowerCase()) || u.displayName.toLowerCase().includes(q.toLowerCase()),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  async function start() {
    if (busy || picked.length < 1 || picked.length > 8) return;
    if (picked.some((id) => !users[id] || users[id]?.deactivated || users[id]?.isBot)) {
      setError("Remove unavailable accounts from the selection before continuing.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const channel = await client.openDm(picked);
      if (mounted.current) props.onOpen(channel.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the conversation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New message" onClose={props.onClose}>
      {props.initialMemberIds && (
        <p className="mb-3 text-sm text-ink-dim">
          History stays in the current conversation. A conversation originally started for the
          selected people may reopen; otherwise a new one starts.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-sm text-alert">
          {error}
        </p>
      )}
      <p className="mb-2 text-xs text-ink-faint">{picked.length} of 8 people selected, plus you</p>
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
                disabled={busy || (!picked.includes(u.id) && picked.length >= 8)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, u.id] : p.filter((x) => x !== u.id)))
                }
                className="accent-copper"
              />
              <Avatar user={u} size={26} />
              <span className="min-w-0 flex-1 truncate">
                {u.displayName}
                {u.deactivated && " (unavailable)"}
              </span>
              <span
                className={`size-2 rounded-full ${presence[u.id] === "online" ? "bg-online" : "bg-edge"}`}
              />
            </label>
          </li>
        ))}
        {candidates.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">
            {Object.keys(users).length <= 1
              ? "You're the only one here so far."
              : "No one matches."}
          </p>
        )}
      </ul>
      <button
        onClick={start}
        disabled={busy || picked.length === 0 || picked.length > 8}
        className={`${primaryBtnCls} w-full`}
      >
        {busy ? "Opening…" : "Start conversation"}
      </button>
    </Dialog>
  );
}

/** What an invite's status means to the person looking at the list. */
const INVITE_STATUS: Record<InviteStatus, string> = {
  active: "Active",
  expired: "Expired",
  used_up: "Used up",
  revoked: "Revoked",
  creator_deactivated: "Creator deactivated",
  creator_not_permitted: "Creator can no longer invite",
};

export function InviteDialog(props: { onClose: () => void }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const selfRole = useWorkspace((s) => s.self?.role);
  // Older servers do not send the flag; every member could invite there.
  const canInvite = useWorkspace((s) => s.self?.canInvite ?? true);
  const [invite, setInvite] = useState<string | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRequest = useRef(0);
  const permissions = useMemo(
    () =>
      Object.values(users)
        .map((user) => `${user.id}:${user.role}:${user.canInvite}:${user.deactivated}`)
        .sort()
        .join("|"),
    [users],
  );
  const { copy, label, copied } = useCopy();
  const host = client.baseUrl.replace(/^https?:\/\//, "");
  const link = invite ? `slackoss://join?host=${host}&code=${invite}` : null;

  const loadInvites = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const result = await client.api.listInvites();
      if (request === listRequest.current) setInvites(result.invites);
    } catch {
      // The list is a convenience beside creating one; failing to load it
      // should not stop anyone inviting a colleague.
      if (request === listRequest.current) setInvites(null);
    }
  }, [client]);

  useEffect(() => {
    void loadInvites();
    return () => {
      listRequest.current++;
    };
  }, [loadInvites, permissions]);

  useEffect(() => {
    if (!canInvite) setInvite(null);
  }, [canInvite]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const { invite } = await client.api.createInvite({ expiresInHours: 24 * 7 });
      setInvite(invite.code);
      void loadInvites();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invite_permission_required"
          ? "An administrator must allow you to create invite codes."
          : "Could not create an invite code. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    if (
      !confirm(
        "Revoke this invite? Anyone who has not used it yet will not be able to join with it.",
      )
    ) {
      return;
    }
    setError(null);
    try {
      await client.api.revokeInvite(code);
      if (code === invite) setInvite(null);
      void loadInvites();
    } catch {
      setError("Could not revoke that invite. Nothing was changed; try again.");
    }
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
            onClick={() => void copy(host, "host")}
            className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-lifted"
          >
            {label("Copy", "Copied", "Copy failed", "host")}
          </button>
        </div>
      </div>
      {invite && canInvite ? (
        <div className="rounded-lg border border-edge bg-ground p-3">
          <div className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            Invite code · valid 7 days
          </div>
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-lg font-bold tracking-[0.2em] text-copper">
              {invite}
            </code>
            <button
              onClick={() => void copy(link!, "link")}
              className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-lifted"
            >
              {label("Copy link", "Copied", "Copy failed", "link")}
            </button>
          </div>
        </div>
      ) : canInvite ? (
        <button
          onClick={() => void generate()}
          disabled={busy}
          className={`${primaryBtnCls} w-full`}
        >
          Generate invite code
        </button>
      ) : (
        <p className="rounded-lg border border-edge bg-ground p-3 text-sm text-ink-dim">
          Creating invite codes needs permission from an administrator. Ask one to allow it, or to
          invite the person for you.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {error}
        </p>
      )}
      {invites && invites.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            Invite codes
          </div>
          <ul className="max-h-60 space-y-1.5 overflow-y-auto" aria-label="Invite codes">
            {invites.map((inv) => {
              // A role change takes effect before a refreshed list returns.
              if (selfRole !== "owner" && selfRole !== "admin" && inv.createdBy !== selfId)
                return null;
              const author = users[inv.createdBy];
              const status =
                inv.status !== "revoked" && author?.deactivated
                  ? "creator_deactivated"
                  : inv.status !== "revoked" && author?.canInvite === false
                    ? "creator_not_permitted"
                    : (inv.status ?? "active");
              const creator =
                inv.createdBy === selfId ? "you" : (users[inv.createdBy]?.displayName ?? "someone");
              return (
                <li
                  key={inv.code}
                  className="flex items-center gap-3 rounded-lg border border-edge px-3 py-2 text-sm"
                >
                  <code className="font-mono text-[13px] tracking-[0.15em] text-ink">
                    {inv.code}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                    by {creator} · {inv.uses}
                    {inv.maxUses !== null ? ` of ${inv.maxUses}` : ""} used
                    {inv.expiresAt !== null && status === "active"
                      ? ` · until ${new Date(inv.expiresAt).toLocaleDateString()}`
                      : ""}
                  </span>
                  <span
                    className={`text-xs ${status === "active" ? "text-online" : "text-ink-faint"}`}
                  >
                    {INVITE_STATUS[status]}
                  </span>
                  {status !== "revoked" && (
                    <button
                      onClick={() => void revoke(inv.code)}
                      className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-lifted hover:text-alert"
                      aria-label={`Revoke invite ${inv.code}`}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
