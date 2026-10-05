import { useMemo, type ReactNode } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { unreadThreadCount } from "@slackoss/client-core";
import { channelTitle, initials, workspaceGradient } from "../lib/format.js";
import { resumeTime, snoozeOptions } from "../lib/snooze.js";
import { shortcutLabel } from "../lib/shortcuts.js";
import { AvatarWithPresence, PresenceDot } from "./Avatar.js";
import { Icon, type IconName } from "./Icon.js";
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
  /** Messages queued to send later; offered in the account menu. */
  onScheduled?: () => void;
  onActivity: () => void;
  onThreads: () => void;
  onInvite: () => void;
  onSwitchWorkspace: () => void;
  onEditProfile: () => void;
  onAccountSettings: () => void;
  /** Guests only: keeping this identity as an account. */
  onCreateAccount?: () => void;
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
  // A guest has public channels only: no DMs, rooms of its own, friends or schedules.
  const guest = self?.role === "guest";
  const drafts = useWorkspace((s) => s.drafts);
  const prefs = useWorkspace((s) => s.prefs);
  const huddles = useWorkspace((s) => s.huddles);
  const mentionCounts = useWorkspace((s) => s.mentionCounts);
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const snoozed = dndUntil !== null && dndUntil > Date.now();
  const others = props.otherWorkspaces ?? [];
  const name = workspaceName || "Connecting…";

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
  const unreadConversations = Object.keys(memberships).filter((id) => isUnread(id)).length;

  return (
    <nav
      aria-label="Workspace navigation"
      // On a phone this is a drawer, closed by the time a panel opened from it
      // closes; focus then goes to the button that opens the drawer.
      data-focus-fallback="open-navigation"
      className="workspace-sidebar flex h-full shrink-0 bg-deep"
    >
      {/* With one workspace, a rail of one says nothing; it appears with a second. */}
      {others.length > 0 && (
        <WorkspaceRail
          name={name}
          unread={totalMentions}
          others={others}
          onOpen={props.onOpenWorkspace}
          onAdd={props.onSwitchWorkspace}
        />
      )}
      <div className="sidebar-column flex min-w-0 flex-1 flex-col">
        <header className="titlebar-drag flex h-14 shrink-0 items-center gap-1 px-2.5">
          <h1 className="min-w-0 flex-1 text-[15px] font-semibold">
            <WorkspaceMenu
              name={name}
              others={others}
              onOpen={props.onOpenWorkspace}
              onAdd={props.onSwitchWorkspace}
              onCreateAccount={guest ? props.onCreateAccount : undefined}
              onInvite={props.onInvite}
              onManagePeople={props.onManagePeople}
              onManageApps={props.onManageApps}
            />
          </h1>
        </header>
        {props.connectionLabel && (
          <p
            role="status"
            className="mx-2.5 mb-2 flex items-center gap-2 rounded-lg bg-copper/10 px-2.5 py-1.5 text-[12px] font-medium text-copper"
          >
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-copper" />
            <span className="truncate first-letter:uppercase">{props.connectionLabel}</span>
          </p>
        )}

        <div className="px-2.5 pb-2">
          {/* Its words and shortcut are on the button already, so it needs no
              hint. A tooltip would also open when the phone drawer puts focus
              here, and take the Escape meant to close the drawer. */}
          <button
            onClick={props.onSearch}
            data-drawer-focus
            aria-keyshortcuts="Control+K Meta+K"
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-edge bg-ground px-2.5 text-[13px] text-ink-faint transition-colors hover:border-ink-faint/40 hover:text-ink-dim"
          >
            <Icon name="search" size={14} />
            <span className="flex-1 text-left">Jump to…</span>
            <kbd aria-hidden="true" className="font-sans text-[11px] tracking-wide">
              {shortcutLabel("Mod+K")}
            </kbd>
          </button>
        </div>

        <div className="sidebar-scroll flex-1 overflow-y-auto px-2.5 pb-4">
          {props.gettingStarted}
          <ul className="mb-4 space-y-px">
            <li>
              <NavRow icon="activity" label="Activity" onClick={props.onActivity}>
                {totalMentions > 0 ? (
                  <Count label="Unread mentions" strong>
                    {totalMentions}
                  </Count>
                ) : (
                  unreadConversations > 0 && (
                    <Count label="Unread conversations">{unreadConversations}</Count>
                  )
                )}
              </NavRow>
            </li>
            <li>
              <NavRow icon="thread" label="Threads" onClick={props.onThreads}>
                {unreadThreads > 0 && (
                  <Count label="Threads with unread replies">{unreadThreads}</Count>
                )}
              </NavRow>
            </li>
            <li>
              <NavRow icon="bookmark" label="Saved" onClick={props.onSaved} />
            </li>
          </ul>

          <SectionHeader
            label="Channels"
            actions={[
              { label: "Browse channels", icon: "compass", onClick: props.onBrowseChannels },
              ...(guest
                ? []
                : [{ label: "New channel", icon: "plus" as const, onClick: props.onNewChannel }]),
            ]}
          />
          <ul className="mb-4 space-y-px">
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
                      <Icon name="lock" size={14} />
                    </span>
                  ) : (
                    // Drawn, and still read as "# general" as it was typed.
                    <>
                      <Icon name="hash" size={15} />
                      <span className="sr-only">#</span>
                    </>
                  )
                }
                label={ch.name}
              />
            ))}
          </ul>

          {!guest && (
            <SectionHeader
              label="Direct messages"
              actions={[
                {
                  label: "Friends",
                  icon: "friends",
                  onClick: props.onFriends,
                  badge: friendRequests,
                },
                { label: "New message", icon: "plus", onClick: props.onNewDm },
              ]}
            />
          )}
          <ul className="space-y-px">
            {dms.map((ch) => {
              const others = (ch.memberIds ?? []).filter((id) => id !== self?.id);
              const online = others.some((id) => presence[id] === "online");
              const first = users[others[0] ?? ""];
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
                  icon={
                    first ? (
                      <AvatarWithPresence
                        user={first}
                        online={online}
                        size={20}
                        ring="var(--color-deep)"
                      />
                    ) : (
                      <PresenceDot online={online} />
                    )
                  }
                  label={channelTitle(ch, users, self?.id)}
                  roomy
                />
              );
            })}
          </ul>
          {dms.length === 0 && !guest && (
            <button
              onClick={props.onNewDm}
              className="group mt-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
            >
              <span className="flex size-5 items-center justify-center rounded-full border border-dashed border-ink-faint/60 group-hover:border-ink-dim">
                <Icon name="plus" size={12} />
              </span>
              Send someone a message
            </button>
          )}
        </div>

        <footer className="shrink-0 p-2">
          {snoozed && <SnoozedNotice until={dndUntil!} />}
          <div className="flex items-center gap-1">
            <AccountMenu
              guest={guest}
              snoozed={snoozed}
              onCreateAccount={props.onCreateAccount}
              onEditProfile={props.onEditProfile}
              onAccountSettings={props.onAccountSettings}
              onScheduled={guest ? undefined : props.onScheduled}
              onShortcuts={props.onShortcuts}
              onDiagnostics={props.onDiagnostics}
            />
            {!snoozed && <SnoozeControl />}
          </div>
        </footer>
      </div>
    </nav>
  );
}

/** A count beside a row: quiet for unread, the accent for what names you. */
function Count(props: { label: string; strong?: boolean; children: ReactNode }) {
  return (
    <span
      aria-label={props.label}
      className={`tabular min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-[18px] ${
        props.strong ? "bg-copper text-ground" : "bg-ink/[0.08] text-ink-dim"
      }`}
    >
      {props.children}
    </span>
  );
}

/** One of the sidebar's own places, above the channels. */
function NavRow(props: {
  icon: IconName;
  label: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      onClick={props.onClick}
      className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-sm text-ink-dim transition-colors hover:bg-ink/[0.05] hover:text-ink"
    >
      <Icon name={props.icon} size={16} className="text-ink-faint" />
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
      {props.children}
    </button>
  );
}

/** A workspace's mark: its initials on a colour of its own. */
function WorkspaceTile(props: { name: string; size?: number; className?: string }) {
  const size = props.size ?? 24;
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center rounded-lg font-semibold text-white ${props.className ?? ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: workspaceGradient(props.name),
      }}
    >
      {initials(props.name)}
    </span>
  );
}

/**
 * Discord's rail of servers, for Tandem's workspaces: this one on top,
 * marked as current, then this device's other saved sign-ins, then a way to
 * add one. The same choices as the menu on the workspace's name. Shown only
 * when there is somewhere else to go.
 */
function WorkspaceRail(props: {
  name: string;
  unread: number;
  others: OtherWorkspace[];
  onOpen?: (url: string) => void;
  onAdd: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Workspaces"
      className="workspace-rail titlebar-drag flex w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-edge/60 py-3"
    >
      <RailItem label={props.name} current badge={props.unread} />
      {props.others.map((w) => (
        <RailItem
          key={w.url}
          label={`${w.name} · @${w.handle}`}
          title={w.name}
          onClick={() => props.onOpen?.(w.url)}
        />
      ))}
      <Tooltip label="Add or join a workspace" side="right">
        <button
          onClick={props.onAdd}
          aria-label="Add or join a workspace"
          className="flex size-10 items-center justify-center rounded-xl border border-dashed border-edge text-ink-faint transition-colors hover:border-ink-faint hover:text-ink"
        >
          <Icon name="plus" size={18} />
        </button>
      </Tooltip>
    </div>
  );
}

function RailItem(props: {
  /** What it is called to a screen reader. */
  label: string;
  /** What its initials and tooltip are made from; the label when absent. */
  title?: string;
  current?: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  const title = props.title ?? props.label;
  return (
    <div className="group relative flex w-full justify-center">
      {/* Discord's pill: tall for the workspace on screen, a nub on hover. */}
      <span
        aria-hidden="true"
        className={`absolute left-0 top-1/2 w-[3px] -translate-y-1/2 rounded-full bg-ink transition-all ${
          props.current ? "h-6" : "h-0 group-hover:h-3"
        }`}
      />
      <Tooltip label={title} side="right">
        <button
          onClick={props.onClick}
          aria-label={props.label}
          aria-current={props.current ? "page" : undefined}
          className={`relative rounded-xl transition-opacity ${
            props.current ? "" : "opacity-60 hover:opacity-100"
          }`}
        >
          <WorkspaceTile name={title} size={40} className="rounded-xl" />
          {(props.badge ?? 0) > 0 && (
            <span
              aria-hidden="true"
              className="absolute -bottom-1 -right-1 min-w-5 rounded-full border-2 border-deep bg-copper px-1 text-center text-[11px] font-bold leading-4 text-ground"
            >
              {props.badge}
            </span>
          )}
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The workspace's name, at the top of the sidebar, opens what concerns the
 * workspace: bringing people in, running it, and moving to another one.
 * Two sign-ins to workspaces with the same name are told apart by the
 * account and the address.
 */
function WorkspaceMenu(props: {
  name: string;
  others: OtherWorkspace[];
  onOpen?: (url: string) => void;
  onAdd: () => void;
  /** Given for a guest, who cannot invite. */
  onCreateAccount?: () => void;
  onInvite: () => void;
  onManagePeople?: () => void;
  onManageApps?: () => void;
}) {
  const items: MenuItem[] = props.onCreateAccount
    ? [
        {
          id: "create-account",
          label: "Create an account",
          icon: "userPlus",
          onSelect: props.onCreateAccount,
        },
      ]
    : [{ id: "invite", label: "Invite people", icon: "userPlus", onSelect: props.onInvite }];
  if (props.onManagePeople)
    items.push({ id: "people", label: "People", icon: "members", onSelect: props.onManagePeople });
  if (props.onManageApps)
    items.push({
      id: "apps",
      label: "Apps and integrations",
      icon: "grid",
      onSelect: props.onManageApps,
    });
  const names = props.others.map((w) => w.name);
  props.others.forEach((w, i) => {
    const shared = names.filter((n) => n === w.name).length > 1 || w.name === props.name;
    items.push({
      id: w.url,
      label: `${w.name} · @${w.handle}${shared ? ` · ${w.url.replace(/^https?:\/\//, "")}` : ""}`,
      section: i === 0 ? "Switch to" : undefined,
      onSelect: () => props.onOpen?.(w.url),
    });
  });
  items.push({
    id: "add",
    label: "Add or join a workspace…",
    icon: "plus",
    section: props.others.length === 0 ? true : undefined,
    onSelect: props.onAdd,
  });
  return (
    <Menu
      label="Workspace"
      items={items}
      align="start"
      triggerClassName="flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-ink/[0.05]"
      triggerContent={
        <>
          <WorkspaceTile name={props.name} />
          <span className="min-w-0 truncate">{props.name}</span>
          <span className="sr-only">, workspace menu</span>
          <Icon name="chevronDown" size={14} className="shrink-0 text-ink-faint" />
        </>
      }
    />
  );
}

/**
 * You, at the foot of the sidebar: your name and status, and what concerns
 * only you — your profile, your settings, your queued messages, and help.
 */
function AccountMenu(props: {
  guest: boolean;
  snoozed: boolean;
  onCreateAccount?: () => void;
  onEditProfile: () => void;
  onAccountSettings: () => void;
  onScheduled?: () => void;
  onShortcuts?: () => void;
  onDiagnostics?: () => void;
}) {
  const self = useWorkspace((s) => s.self);
  const items: MenuItem[] = [];
  if (props.guest && props.onCreateAccount)
    items.push({
      id: "create-account",
      label: "Create an account",
      icon: "userPlus",
      onSelect: props.onCreateAccount,
    });
  if (!props.guest) {
    items.push({
      id: "profile",
      label: "Profile and status",
      icon: "user",
      onSelect: props.onEditProfile,
    });
    items.push({
      id: "account",
      label: "Account settings",
      icon: "settings",
      onSelect: props.onAccountSettings,
    });
  }
  if (props.onScheduled)
    items.push({
      id: "scheduled",
      label: "Scheduled messages",
      icon: "clock",
      onSelect: props.onScheduled,
    });
  // Help: the shortcut sheet opened only with Ctrl+/, and nothing said so.
  if (props.onShortcuts)
    items.push({
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: "keyboard",
      section: true,
      onSelect: props.onShortcuts,
    });
  if (props.onDiagnostics)
    items.push({
      id: "diagnostics",
      label: "Diagnostics",
      icon: "help",
      section: props.onShortcuts ? undefined : true,
      onSelect: props.onDiagnostics,
    });
  const status = props.guest
    ? "Guest"
    : self?.statusText || self?.statusEmoji
      ? `${self.statusEmoji} ${self.statusText}`.trim()
      : "Set a status";
  return (
    <div className="min-w-0 flex-1">
      <Menu
        label="Your account"
        items={items}
        align="start"
        triggerClassName="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-ink/[0.05]"
        triggerContent={
          <>
            <AvatarWithPresence
              user={self ?? undefined}
              online={!props.snoozed}
              size={30}
              ring="var(--color-deep)"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">
                {self?.displayName ?? "…"}
              </span>
              <span className="block truncate text-[12px] text-ink-faint">{status}</span>
            </span>
            <span className="sr-only">, your account</span>
          </>
        }
      />
    </div>
  );
}

/** While notifications are paused: until when, and a way to resume now. */
function SnoozedNotice({ until }: { until: number }) {
  const client = useClient();
  const resumesAt = resumeTime(until, new Date());
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg bg-ink/[0.05] px-2.5 py-1.5">
      <span className="text-ink-dim">
        <Icon name="bellOff" size={14} />
      </span>
      <span className="min-w-0 flex-1 text-[12px] text-ink-dim">Paused until {resumesAt}</span>
      <button
        onClick={() => client.snoozeNotifications(null)}
        className="rounded px-1 text-[12px] font-medium text-ink hover:underline"
      >
        Resume
      </button>
    </div>
  );
}

/** Do Not Disturb: pause notifications for a while. */
function SnoozeControl() {
  const client = useClient();
  return (
    <Menu
      label="Pause notifications"
      tooltip="Pause notifications"
      items={snoozeOptions(new Date()).map((o) => ({
        id: o.label,
        label: o.label,
        onSelect: () => client.snoozeNotificationsUntil(o.until()),
      }))}
      triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
      triggerContent={
        <>
          <Icon name="bell" size={17} />
          <span className="sr-only">Pause notifications</span>
        </>
      }
    />
  );
}

function SectionHeader(props: {
  label: string;
  /** Each action shows only its icon, and its label names it. */
  actions: { label: string; icon: IconName; onClick: () => void; badge?: number }[];
}) {
  return (
    <div className="group/section mb-1 flex h-7 items-center justify-between pl-2 pr-0.5">
      <span className="text-[12px] font-medium text-ink-faint">{props.label}</span>
      <span className="flex items-center gap-0.5">
        {props.actions.map((a) => (
          <Tooltip key={a.label} label={a.label}>
            <button
              onClick={a.onClick}
              aria-label={a.badge ? `${a.label}, ${a.badge} new` : a.label}
              className="relative flex size-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
            >
              <Icon name={a.icon} size={14} />
              {(a.badge ?? 0) > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-copper ring-2 ring-deep"
                />
              )}
            </button>
          </Tooltip>
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
  /** A row with an avatar in place of the channel mark. */
  roomy?: boolean;
  onClick: () => void;
}) {
  const showUnread = props.unread && !props.active && !props.muted;
  return (
    <li className="relative">
      {/* Discord's unread nub, at the very edge of the sidebar. */}
      {showUnread && (
        <span
          aria-hidden="true"
          className="absolute -left-2.5 top-1/2 h-2 w-[3px] -translate-y-1/2 rounded-r-full bg-ink"
        />
      )}
      <button
        onClick={props.onClick}
        aria-current={props.active ? "page" : undefined}
        className={`channel-row flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors ${
          props.active
            ? "bg-ink/[0.08] font-medium text-ink"
            : props.muted
              ? "text-ink-faint hover:bg-ink/[0.05]"
              : props.unread
                ? "font-semibold text-ink hover:bg-ink/[0.05]"
                : "text-ink-dim hover:bg-ink/[0.05] hover:text-ink"
        }`}
      >
        <span
          className={`flex shrink-0 items-center justify-center ${
            props.roomy ? "w-5" : "w-4"
          } ${props.active || showUnread ? "text-ink-dim" : "text-ink-faint"}`}
        >
          {props.icon}
        </span>{" "}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.huddle > 0 && (
          <span
            role="img"
            aria-label="Huddle in progress"
            title="Huddle in progress"
            className="shrink-0 text-online"
          >
            <Icon name="headphones" size={14} />
          </span>
        )}
        {props.draft && !props.active && (
          <span role="img" aria-label="Draft" title="Draft" className="shrink-0 text-ink-faint">
            <Icon name="edit" size={13} />
          </span>
        )}
        {props.muted && (
          <span role="img" aria-label="Muted" title="Muted" className="shrink-0 text-ink-faint">
            <Icon name="bellOff" size={13} />
          </span>
        )}
        {props.mentions > 0 && (
          <span
            aria-label={`${props.mentions} unread ${
              props.mentions === 1 ? "mention" : "mentions"
            } in ${props.label}`}
            className="tabular min-w-5 shrink-0 rounded-full bg-copper px-1.5 text-center text-[11px] font-bold leading-[18px] text-ground"
          >
            {props.mentions}
          </span>
        )}
      </button>
    </li>
  );
}
