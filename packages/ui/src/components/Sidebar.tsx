import { useMemo, useState, type ReactNode } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { unreadThreadCount } from "@slackoss/client-core";
import { channelTitle } from "../lib/format.js";
import { resumeTime, snoozeOptions } from "../lib/snooze.js";
import { Avatar, PresenceDot } from "./Avatar.js";
import { BrandMark, Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
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
  onShortcuts?: () => void;
  onDiagnostics?: () => void;
  /** Shown under the Jump button, such as the owner's first steps. */
  gettingStarted?: ReactNode;
  /** Admins only; absent for members. */
  onManageApps?: () => void;
  onManagePeople?: () => void;
  connectionLabel: string | null;
  /** This device's other saved sign-ins, most recently used first. */
  otherWorkspaces?: OtherWorkspace[];
  onOpenWorkspace?: (url: string) => void;
}

/** A saved sign-in to another workspace, without its credentials. */
export interface OtherWorkspace {
  url: string;
  name: string;
  handle: string;
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

      <div className="sidebar-scroll flex-1 overflow-y-auto px-3 py-4">
        <h1 className="mb-3 text-[15px] font-semibold">
          <WorkspaceSwitcher
            name={workspaceName || "Connecting…"}
            others={props.otherWorkspaces ?? []}
            onOpen={props.onOpenWorkspace}
            onAdd={props.onSwitchWorkspace}
          />
        </h1>
        {/* Its words and shortcut are on the button already, so it needs no
            hint. A tooltip would also open when the phone drawer puts focus
            here, and take the Escape meant to close the drawer. */}
        <button
          onClick={props.onSearch}
          aria-keyshortcuts="Control+K Meta+K"
          className="mb-2 flex w-full items-center gap-2 rounded-lg border border-edge bg-ground/50 px-3 py-2 text-[12px] text-ink-faint hover:border-ink-faint hover:text-ink"
        >
          <Icon name="search" size={15} />
          <span className="flex-1 text-left">Jump to…</span>
          <kbd aria-hidden="true" className="rounded border border-edge px-1 text-[10px]">
            Ctrl K
          </kbd>
        </button>
        {props.gettingStarted}
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
            { label: "New channel", icon: "plus", onClick: props.onNewChannel },
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
              icon={
                ch.type === "private" ? (
                  <span role="img" aria-label="Private channel" title="Private channel">
                    <Icon name="lock" size={13} />
                  </span>
                ) : (
                  "#"
                )
              }
              label={ch.name}
            />
          ))}
        </ul>

        <SectionHeader
          label="Direct messages"
          actions={[{ label: "New message", icon: "plus", onClick: props.onNewDm }]}
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
            <span className="mt-1 flex items-center gap-1 text-copper">
              Send someone a message
              <Icon name="arrow" size={12} />
            </span>
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
          onAccountSettings={props.onAccountSettings}
          onShortcuts={props.onShortcuts}
          onDiagnostics={props.onDiagnostics}
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
  onAccountSettings: () => void;
  onShortcuts?: () => void;
  onDiagnostics?: () => void;
}) {
  const items: MenuItem[] = [{ id: "invite", label: "Invite people", onSelect: props.onInvite }];
  if (props.onManagePeople)
    items.push({ id: "people", label: "People", onSelect: props.onManagePeople });
  if (props.onManageApps)
    items.push({ id: "apps", label: "Apps and integrations", onSelect: props.onManageApps });
  items.push({ id: "account", label: "Account settings", onSelect: props.onAccountSettings });
  // Help: the shortcut sheet opened only with Ctrl+/, and nothing said so.
  if (props.onShortcuts)
    items.push({ id: "shortcuts", label: "Keyboard shortcuts", onSelect: props.onShortcuts });
  if (props.onDiagnostics)
    items.push({ id: "diagnostics", label: "Diagnostics", onSelect: props.onDiagnostics });
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

/**
 * The workspace's name, at the top of the sidebar, opens a menu of this
 * device's other saved workspaces, each opened with its saved sign-in, and a
 * way to add or join another. Two sign-ins to workspaces with the same name
 * are told apart by the account and the address.
 */
function WorkspaceSwitcher(props: {
  name: string;
  others: OtherWorkspace[];
  onOpen?: (url: string) => void;
  onAdd: () => void;
}) {
  const names = props.others.map((w) => w.name);
  const items: MenuItem[] = props.others.map((w) => {
    const shared = names.filter((n) => n === w.name).length > 1 || w.name === props.name;
    return {
      id: w.url,
      label: `${w.name} · @${w.handle}${shared ? ` · ${w.url.replace(/^https?:\/\//, "")}` : ""}`,
      onSelect: () => props.onOpen?.(w.url),
    };
  });
  items.push({ id: "add", label: "Add or join a workspace…", onSelect: props.onAdd });
  return (
    <Menu
      label="Switch workspace"
      items={items}
      triggerClassName="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-lifted"
      triggerContent={
        <>
          <span className="min-w-0 truncate">{props.name}</span>
          <span className="sr-only">, switch workspace</span>
          <Icon name="chevronDown" size={14} className="shrink-0 text-ink-faint" />
        </>
      }
    />
  );
}

/** Do Not Disturb: pause notifications for a while. */
function SnoozeControl({ snoozed, until }: { snoozed: boolean; until: number | null }) {
  const client = useClient();
  const [open, setOpen] = useState(false);

  if (snoozed) {
    const resumesAt = resumeTime(until!, new Date());
    return (
      <div className="mb-1 flex items-center gap-2 rounded-lg border border-copper/40 bg-copper/10 px-2.5 py-1.5">
        <span className="text-copper">
          <Icon name="bellOff" size={14} />
        </span>
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
        className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
      >
        <Icon name="bellOff" size={14} />
        Pause notifications
      </button>
      {open && (
        <ul className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-hidden rounded-lg border border-edge bg-lifted shadow-xl">
          {snoozeOptions(new Date()).map((o) => (
            <li key={o.label}>
              <button
                onClick={() => {
                  client.snoozeNotificationsUntil(o.until());
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
  /** An action with an icon shows only the icon, and its label names it. */
  actions: { label: string; icon?: IconName; onClick: () => void }[];
}) {
  return (
    <div className="mb-1 flex items-center justify-between px-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
        {props.label}
      </span>
      <span className="flex items-center gap-1">
        {props.actions.map((a) => {
          const button = (
            <button
              key={a.label}
              onClick={a.onClick}
              aria-label={a.icon ? a.label : undefined}
              className="flex items-center rounded px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
            >
              {a.icon ? <Icon name={a.icon} size={14} /> : a.label}
            </button>
          );
          // A worded action says what it does already; an icon needs the hint.
          return a.icon ? (
            <Tooltip key={a.label} label={a.label}>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
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
        className={`channel-row my-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-[8px] text-left text-sm transition-colors ${
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
        </span>{" "}
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
          <span
            role="img"
            aria-label="Huddle in progress"
            title="Huddle in progress"
            className="shrink-0 text-online"
          >
            <Icon name="headphones" size={12} />
          </span>
        )}
        {props.draft && !props.active && (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">draft</span>
        )}
        {props.muted && (
          <span role="img" aria-label="Muted" title="Muted" className="shrink-0 text-ink-faint">
            <Icon name="bellOff" size={12} />
          </span>
        )}
        {props.unread && !props.active && !props.muted && (
          <span className="size-2 shrink-0 rounded-full bg-copper" />
        )}
      </button>
    </li>
  );
}
