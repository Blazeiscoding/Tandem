import { useMemo, useState } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { unreadThreadCount } from "@slackoss/client-core";
import { channelTitle } from "../lib/format.js";
import { Avatar, PresenceDot } from "./Avatar.js";
import { BrandMark, Icon } from "./Icon.js";
import { Menu, type MenuItem } from "./Menu.js";

interface Props {
  activeChannelId: ID | null;
  onSelect: (id: ID) => void;
  onBrowseChannels: () => void;
  onNewChannel: () => void;
  onNewDm: () => void;
  onFriends: () => void;
  onSearch: () => void;
  onSaved: () => void;
  onScheduled: () => void;
  onActivity: () => void;
  onThreads: () => void;
  onInvite: () => void;
  onSwitchWorkspace: () => void;
  onEditProfile: () => void;
  onAccountSettings: () => void;
  /** Admins only; absent for members. */
  onManageApps?: () => void;
  onManagePeople?: () => void;
  connectionLabel: string | null;
}

export function Sidebar(props: Props) {
  const client = useClient();
  const unreadThreads = useWorkspace((s) => unreadThreadCount(s.threadFollows));
  const friendRequests = useWorkspace(
    (s) => s.friends.filter((f) => f.status === "incoming").length,
  );
  const workspaceName = useWorkspace((s) => s.workspaceName);
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const channelLastSeq = useWorkspace((s) => s.channelLastSeq);
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const self = useWorkspace((s) => s.self);
  const drafts = useWorkspace((s) => s.drafts);
  const prefs = useWorkspace((s) => s.prefs);
  const huddles = useWorkspace((s) => s.huddles);
  const mentionCounts = useWorkspace((s) => s.mentionCounts);
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const snoozed = dndUntil !== null && dndUntil > Date.now();
  const baseHost = client.baseUrl.replace(/^https?:\/\//, "");

  const { rooms, dms } = useMemo(() => {
    const rooms: Channel[] = [];
    const dms: Channel[] = [];
    for (const ch of Object.values(channels)) {
      if (ch.archived) continue;
      if (ch.type === "dm" || ch.type === "group_dm") {
        if (ch.id in memberships) dms.push(ch);
      } else if (ch.id in memberships) {
        rooms.push(ch);
      }
    }
    rooms.sort((a, b) => a.name.localeCompare(b.name));
    dms.sort((a, b) => (channelLastSeq[b.id] ?? 0) - (channelLastSeq[a.id] ?? 0));
    return { rooms, dms };
  }, [channels, memberships, channelLastSeq]);

  const isUnread = (id: ID) => (channelLastSeq[id] ?? 0) > (memberships[id] ?? 0);
  const hasDraft = (id: ID) => !!drafts[id];
  // Muted channels still show unread state, just quietly.
  const isMuted = (id: ID) => prefs[id]?.muted ?? false;
  const huddleCount = (id: ID) => huddles[id]?.length ?? 0;
  const mentions = (id: ID) => mentionCounts[id] ?? 0;
  const totalMentions = Object.values(mentionCounts).reduce((sum, n) => sum + n, 0);

  return (
    <nav
      aria-label="Workspace navigation"
      className="workspace-sidebar flex h-full shrink-0 flex-col border-r border-edge bg-raised"
    >
      <header className="titlebar-drag flex h-[76px] shrink-0 items-center gap-3 border-b border-edge px-4">
        <BrandMark />
        <div className="min-w-0">
          <div className="text-[16px] font-semibold tracking-tight">Gatherline</div>
          <div
            className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint"
            title={baseHost}
          >
            <span
              className={`size-1.5 rounded-full ${props.connectionLabel ? "bg-copper" : "bg-online"}`}
            />
            <span className="truncate">{props.connectionLabel ?? "Connected · Your server"}</span>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <h1 className="mb-3 truncate px-2 text-[15px] font-semibold" title={baseHost}>
          {workspaceName || "Connecting…"}
        </h1>
        <button
          onClick={props.onSearch}
          className="mb-2 flex w-full items-center gap-2 rounded-lg border border-edge bg-ground/50 px-3 py-2 text-[12px] text-ink-faint hover:border-ink-faint hover:text-ink"
          title="Jump to a conversation (Ctrl K)"
        >
          <Icon name="search" size={15} />
          <span className="flex-1 text-left">Jump to…</span>
          <kbd className="rounded border border-edge px-1 text-[10px]">Ctrl K</kbd>
        </button>
        <button
          onClick={props.onActivity}
          className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-ink-dim hover:bg-lifted hover:text-ink"
        >
          <span className="flex items-center gap-2">
            <Icon name="activity" size={17} />
            Activity
          </span>
          {totalMentions > 0 ? (
            <span
              aria-label="Unread mentions"
              className="rounded-full bg-copper px-2 text-xs font-semibold text-ground"
            >
              {totalMentions}
            </span>
          ) : (
            Object.keys(memberships).some((id) => isUnread(id)) && (
              <span
                aria-label="Unread conversations"
                className="rounded-full bg-copper/15 px-2 text-xs text-copper"
              >
                {Object.keys(memberships).filter((id) => isUnread(id)).length}
              </span>
            )
          )}
        </button>
        <button
          onClick={props.onThreads}
          className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-ink-dim hover:bg-lifted hover:text-ink"
        >
          <span className="flex items-center gap-2">
            <Icon name="thread" size={17} />
            Threads
          </span>
          {unreadThreads > 0 && (
            <span
              aria-label="Threads with unread replies"
              className="rounded-full bg-copper/15 px-2 text-xs text-copper"
            >
              {unreadThreads}
            </span>
          )}
        </button>
        <button
          onClick={props.onFriends}
          className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-ink-dim hover:bg-lifted hover:text-ink"
        >
          <span className="flex items-center gap-2">
            <Icon name="friends" size={17} />
            Friends
          </span>
          {friendRequests > 0 && (
            <span className="rounded-full bg-copper/15 px-2 text-xs text-copper">
              {friendRequests}
            </span>
          )}
        </button>
        <div className="mb-5 flex gap-1 border-b border-edge pb-4">
          <button
            onClick={props.onSaved}
            className="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-xs text-ink-dim hover:bg-lifted"
          >
            <Icon name="bookmark" size={15} />
            Saved
          </button>
          <button
            onClick={props.onScheduled}
            className="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-xs text-ink-dim hover:bg-lifted"
          >
            <Icon name="clock" size={15} />
            Scheduled
          </button>
        </div>
        <SectionHeader
          label="Channels"
          actions={[
            { label: "Browse", onClick: props.onBrowseChannels },
            { label: "+", onClick: props.onNewChannel, title: "New channel" },
          ]}
        />
        <ul className="mb-4">
          {rooms.map((ch) => (
            <ChannelRow
              key={ch.id}
              active={ch.id === props.activeChannelId}
              unread={isUnread(ch.id)}
              muted={isMuted(ch.id)}
              draft={hasDraft(ch.id)}
              huddle={huddleCount(ch.id)}
              mentions={mentions(ch.id)}
              onClick={() => props.onSelect(ch.id)}
              icon={ch.type === "private" ? "🔒" : "#"}
              label={ch.name}
            />
          ))}
        </ul>

        <SectionHeader
          label="Direct messages"
          actions={[{ label: "+", onClick: props.onNewDm, title: "New message" }]}
        />
        <ul>
          {dms.map((ch) => {
            const others = (ch.memberIds ?? []).filter((id) => id !== self?.id);
            const online = others.some((id) => presence[id] === "online");
            return (
              <ChannelRow
                key={ch.id}
                active={ch.id === props.activeChannelId}
                unread={isUnread(ch.id)}
                muted={isMuted(ch.id)}
                draft={hasDraft(ch.id)}
                huddle={huddleCount(ch.id)}
                mentions={mentions(ch.id)}
                onClick={() => props.onSelect(ch.id)}
                icon={<PresenceDot online={online} />}
                label={channelTitle(ch, users, self?.id)}
              />
            );
          })}
        </ul>
        {dms.length === 0 && (
          <button
            onClick={props.onNewDm}
            className="mx-2 mt-2 rounded-lg border border-dashed border-edge p-3 text-left text-xs leading-relaxed text-ink-faint hover:border-ink-faint hover:text-ink"
          >
            Good conversations start here.
            <span className="mt-1 block text-copper">Send someone a message →</span>
          </button>
        )}
      </div>

      <footer className="border-t border-edge p-2">
        <SnoozeControl snoozed={snoozed} until={dndUntil} />
        <button
          onClick={props.onEditProfile}
          className="mb-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-lifted"
        >
          <Avatar user={self ?? undefined} size={30} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{self?.displayName ?? "…"}</span>
            <span className="block truncate text-[11px] text-ink-faint">
              {self?.statusText || self?.statusEmoji
                ? `${self.statusEmoji} ${self.statusText}`.trim()
                : "Set a status"}
            </span>
          </span>
        </button>
        <WorkspaceMenu
          onInvite={props.onInvite}
          onManagePeople={props.onManagePeople}
          onManageApps={props.onManageApps}
          onSwitchWorkspace={props.onSwitchWorkspace}
          onAccountSettings={props.onAccountSettings}
        />
      </footer>
    </nav>
  );
}

/**
 * Invite, administration, switching and account settings behind one menu: five
 * stacked rows took 270 px on a 600 px tall window and left room for about
 * four channel rows.
 */
function WorkspaceMenu(props: {
  onInvite: () => void;
  onManagePeople?: () => void;
  onManageApps?: () => void;
  onSwitchWorkspace: () => void;
  onAccountSettings: () => void;
}) {
  const items: MenuItem[] = [{ id: "invite", label: "Invite people", onSelect: props.onInvite }];
  if (props.onManagePeople)
    items.push({ id: "people", label: "People", onSelect: props.onManagePeople });
  if (props.onManageApps)
    items.push({ id: "apps", label: "Apps and integrations", onSelect: props.onManageApps });
  items.push(
    { id: "switch", label: "Switch workspace", onSelect: props.onSwitchWorkspace },
    { id: "account", label: "Account settings", onSelect: props.onAccountSettings },
  );
  return (
    <Menu
      label="Workspace"
      items={items}
      triggerClassName="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
      triggerContent={
        <>
          <Icon name="menu" size={15} />
          <span className="flex-1">Workspace</span>
        </>
      }
    />
  );
}

const SNOOZE_OPTIONS = [
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "Until tomorrow", minutes: 60 * 12 },
];

/** Do Not Disturb: pause notifications for a while. */
function SnoozeControl({ snoozed, until }: { snoozed: boolean; until: number | null }) {
  const client = useClient();
  const [open, setOpen] = useState(false);

  if (snoozed) {
    const resumesAt = new Date(until!).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return (
      <div className="mb-1 flex items-center gap-2 rounded-lg border border-copper/40 bg-copper/10 px-2.5 py-1.5">
        <span className="text-[13px]">🔕</span>
        <span className="min-w-0 flex-1 text-[11px] text-copper">Paused until {resumesAt}</span>
        <button
          onClick={() => client.snoozeNotifications(null)}
          className="text-[11px] text-ink-dim underline hover:text-ink"
        >
          Resume
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-1 w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
      >
        🔔 Pause notifications
      </button>
      {open && (
        <ul className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-hidden rounded-lg border border-edge bg-lifted shadow-xl">
          {SNOOZE_OPTIONS.map((o) => (
            <li key={o.minutes}>
              <button
                onClick={() => {
                  client.snoozeNotifications(o.minutes);
                  setOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-sm text-ink-dim transition-colors hover:bg-copper/15 hover:text-ink"
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SectionHeader(props: {
  label: string;
  actions: { label: string; onClick: () => void; title?: string }[];
}) {
  return (
    <div className="mb-1 flex items-center justify-between px-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        {props.label}
      </span>
      <span className="flex gap-1">
        {props.actions.map((a) => (
          <button
            key={a.label}
            onClick={a.onClick}
            title={a.title}
            className="rounded px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
          >
            {a.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function ChannelRow(props: {
  active: boolean;
  unread: boolean;
  muted: boolean;
  draft: boolean;
  /** How many people are in this channel’s huddle; 0 for none. */
  huddle: number;
  /** Unread messages here that name this user; 0 for none. */
  mentions: number;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={props.onClick}
        aria-current={props.active ? "page" : undefined}
        className={`my-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-[8px] text-left text-sm transition-colors ${
          props.active
            ? "bg-copper/15 font-medium text-copper shadow-[inset_3px_0_var(--color-copper)]"
            : props.muted
              ? "text-ink-faint hover:bg-lifted"
              : props.unread
                ? "font-semibold text-ink hover:bg-lifted"
                : "text-ink-dim hover:bg-lifted hover:text-ink"
        }`}
      >
        <span className="flex w-4 shrink-0 items-center justify-center text-ink-faint">
          {props.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.mentions > 0 && (
          <span
            aria-label={`${props.mentions} unread ${
              props.mentions === 1 ? "mention" : "mentions"
            } in ${props.label}`}
            className="shrink-0 rounded-full bg-copper px-1.5 text-[10px] font-semibold text-ground"
          >
            {props.mentions}
          </span>
        )}
        {props.huddle > 0 && (
          <span className="shrink-0 text-[10px] text-online" title="Huddle in progress">
            🎧
          </span>
        )}
        {props.draft && !props.active && (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">draft</span>
        )}
        {props.muted && <span className="shrink-0 text-[10px] text-ink-faint">🔕</span>}
        {props.unread && !props.active && !props.muted && (
          <span className="size-2 shrink-0 rounded-full bg-copper" />
        )}
      </button>
    </li>
  );
}
