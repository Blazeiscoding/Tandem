import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@slackoss/client-core";
import { useCopy } from "../lib/useCopy.js";
import { browserLink, desktopLink, serverAddress } from "../lib/deeplink.js";
import type { Channel, ID, Invite, InviteStatus } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Dialog, inputCls } from "./Dialog.js";
import { useConfirm } from "./Confirm.js";
import { useShareableServer } from "./ShareableServer.js";
import { buttonClass } from "./Button.js";

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
        <button type="submit" disabled={!slug} className={buttonClass("primary", "w-full")}>
          Create {slug ? `#${slug}` : "channel"}
        </button>
      </form>
    </Dialog>
  );
}

/**
 * A guest keeping who they are: a username and password turn this guest into
 * an ordinary account, with the same messages and channels. The guest session
 * ends, and the token given back replaces it.
 */
export function GuestAccountDialog(props: {
  onClose: () => void;
  onCreated: (token: string, handle: string) => void;
}) {
  const client = useClient();
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Use at least 8 characters for the password.");
      return;
    }
    setBusy(true);
    try {
      const { token, user } = await client.api.createAccountFromGuest({
        handle: handle.trim().toLowerCase(),
        password,
      });
      // Even closed, the guest session it replaced has ended: carry on as the account.
      props.onCreated(token, user.handle);
    } catch (err) {
      if (!alive.current) return;
      setBusy(false);
      setError(
        err instanceof ApiError && err.code === "handle_taken"
          ? "That username is taken. Choose another."
          : err instanceof ApiError && err.code === "invalid_request"
            ? "Usernames are lowercase letters and digits; passwords need 8+ characters."
            : err instanceof ApiError && err.code === "invite_required"
              ? "This workspace now needs an invite to create an account."
              : "Could not create the account. Try again.",
      );
    }
  }

  return (
    <Dialog title="Create an account" onClose={props.onClose} dismissible={!busy}>
      <p className="mb-3 text-sm text-ink-dim">
        You are here as a guest, for a day. An account keeps your name, messages and channels, and
        lets you sign in again from anywhere.
      </p>
      <form onSubmit={create} className="space-y-3">
        <label className="block text-sm font-medium">
          Username
          <input
            autoFocus
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="username"
            spellCheck={false}
            autoCapitalize="none"
            className={`${inputCls} mt-1`}
          />
        </label>
        <label className="block text-sm font-medium">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className={`${inputCls} mt-1`}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !handle.trim() || !password}
          className={buttonClass("primary", "w-full")}
        >
          {busy ? "Creating…" : "Create account"}
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
              className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-ink/[0.05]"
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
                  className="rounded-lg border border-edge px-3 py-1 text-sm font-medium text-ink-dim transition-colors hover:bg-ink/[0.05] hover:text-ink"
                >
                  Open
                </button>
              ) : (
                <button
                  onClick={async () => {
                    await client.api.joinChannel(ch.id);
                    props.onOpen(ch.id);
                  }}
                  className="rounded-lg bg-copper px-3 py-1 text-sm font-semibold text-ground transition-colors hover:bg-copper-deep"
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
      <p className="mb-2 text-xs text-ink-faint">
        {picked.length === 0
          ? "Choose up to 8 people. You're included."
          : `${picked.length} of up to 8 chosen, plus you`}
      </p>
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
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-ink/[0.05]">
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
                className={`size-2 rounded-full ${presence[u.id] === "online" ? "bg-online" : "border border-ink-faint/60"}`}
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
        className={buttonClass("primary", "w-full")}
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

function InviteLink(props: { title: string; link: string; copyLabel: string; onCopy: () => void }) {
  return (
    <div className="mt-3 border-t border-edge pt-3">
      <div className="mb-1 text-xs text-ink-faint">{props.title}</div>
      <div className="flex items-center justify-between gap-2">
        <code className="min-w-0 break-all font-mono text-xs text-ink">{props.link}</code>
        <button
          onClick={props.onCopy}
          className="shrink-0 rounded px-2 py-1 text-xs text-ink-dim hover:bg-ink/[0.05]"
        >
          {props.copyLabel}
        </button>
      </div>
    </div>
  );
}

export function InviteDialog(props: { onClose: () => void }) {
  const client = useClient();
  const confirm = useConfirm();
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
  const shareable = useShareableServer();
  const addresses = [shareable.serverUrl, ...shareable.alternatives];
  const [chosenAddress, setChosenAddress] = useState<string | null>(null);
  const serverUrl =
    chosenAddress && addresses.includes(chosenAddress) ? chosenAddress : shareable.serverUrl;
  const host = serverAddress(serverUrl);
  const links = invite
    ? {
        browser: browserLink(serverUrl, { kind: "join", code: invite }),
        desktop: desktopLink(serverUrl, { kind: "join", code: invite }),
      }
    : null;

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
    const go = await confirm({
      title: "Revoke this invite?",
      body: "Anyone who has not used it yet will not be able to join with it.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!go) return;
    setError(null);
    try {
      await client.api.revokeInvite(code);
      if (code === invite) setInvite(null);
      void loadInvites();
    } catch {
      setError(
        "Could not confirm whether that invite was revoked. Check your connection before trying again.",
      );
      void loadInvites();
    }
  }

  return (
    <Dialog title="Invite people" onClose={props.onClose}>
      <p className="mb-4 text-sm text-ink-dim">
        {canInvite
          ? "Send someone an invite link. It opens this workspace in their browser with the code already filled in."
          : "Anyone joining needs this workspace's address, and an invite code as well if the workspace is invite-only."}
      </p>
      <div className="mb-4 rounded-lg border border-edge bg-ground p-3">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          Server address
        </div>
        <div className="flex items-center justify-between gap-2">
          {addresses.length > 1 ? (
            <select
              aria-label="Address used in links"
              value={serverUrl}
              onChange={(e) => setChosenAddress(e.target.value)}
              className="min-w-0 rounded border border-edge bg-raised px-2 py-1 font-mono text-sm text-copper"
            >
              {addresses.map((address) => (
                <option key={address} value={address}>
                  {serverAddress(address)}
                </option>
              ))}
            </select>
          ) : (
            <code className="min-w-0 break-all font-mono text-sm text-copper">{host}</code>
          )}
          <button
            onClick={() => void copy(host, "host")}
            className="shrink-0 rounded px-2 py-1 text-xs text-ink-dim hover:bg-ink/[0.05]"
          >
            {label("Copy address", "Copied", "Copy failed", "host")}
          </button>
        </div>
        {shareable.localOnly && (
          <p className="mt-2 text-xs text-ink-dim">
            This address reaches only this computer, so links made here will not work for anyone
            else. Open this workspace at its network or public address to invite people.
          </p>
        )}
      </div>
      {invite && canInvite && links ? (
        <div className="rounded-lg border border-edge bg-ground p-3">
          <div className="mb-1 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            Invite code · valid 7 days
          </div>
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-lg font-bold tracking-[0.2em] text-copper">
              {invite}
            </code>
            <button
              onClick={() => void copy(invite, "code")}
              className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-ink/[0.05]"
            >
              {label("Copy code", "Copied", "Copy failed", "code")}
            </button>
          </div>
          <InviteLink
            title="Browser link"
            link={links.browser}
            copyLabel={label("Copy link", "Copied", "Copy failed", "browser")}
            onCopy={() => void copy(links.browser, "browser")}
          />
          <InviteLink
            title="Desktop app link"
            link={links.desktop}
            copyLabel={label("Copy desktop link", "Copied", "Copy failed", "desktop")}
            onCopy={() => void copy(links.desktop, "desktop")}
          />
        </div>
      ) : canInvite ? (
        <button
          onClick={() => void generate()}
          disabled={busy}
          className={buttonClass("primary", "w-full")}
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
                      className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-ink/[0.05] hover:text-alert"
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
