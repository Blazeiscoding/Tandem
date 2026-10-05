import { useMemo, useState, type ReactNode } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { unreadThreadCount } from "@slackoss/client-core";
import { channelTitle, initials } from "../lib/format.js";
import { resumeTime, snoozeOptions } from "../lib/snooze.js";
import { AvatarWithPresence, PresenceDot } from "./Avatar.js";
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
  // A guest has public channels only: no DMs, rooms of its own, friends or schedules.
  const guest = self?.role === "guest";
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
      // On a phone this is a drawer, closed by the time a panel opened from it
      // closes; focus then goes to the button that opens the drawer.
      data-focus-fallback="open-navigation"
      className="workspace-sidebar flex h-full shrink-0"
    >
      <WorkspaceRail
        name={workspaceName || "Connecting…"}
        unread={totalMentions}
        others={props.otherWorkspaces ?? []}
        onOpen={props.onOpenWorkspace}
        onAdd={props.onSwitchWorkspace}
      />
      <div className="flex min-w-0 flex-1 flex-col border-r border-edge bg-raised">
        <header className="titlebar-drag flex h-14 shrink-0 flex-col justify-center border-b border-edge px-2 shadow-[0_1px_0_var(--color-deep)]">
          <h1 className="text-[16px] font-semibold">
            <WorkspaceSwitcher
              name={workspaceName || "Connecting…"}
              others={props.otherWorkspaces ?? []}
              onOpen={props.onOpenWorkspace}
              onAdd={props.onSwitchWorkspace}
            />
          </h1>
          <div
            className="flex items-center gap-1.5 px-2 text-[11px] text-ink-faint"
            title={baseHost}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${props.connectionLabel ? "bg-copper" : "bg-online"}`}
            />
            <span className="truncate">{props.connectionLabel ?? "Connected · Your server"}</span>
          </div>
        </header>

        <div className="sidebar-scroll flex-1 overflow-y-auto px-2 py-3">
          {/* Its words and shortcut are on the button already, so it needs no
              hint. A tooltip would also open when the phone drawer puts focus
              here, and take the Escape meant to close the drawer. */}
          <button
            onClick={props.onSearch}
            data-drawer-focus
            aria-keyshortcuts="Control+K Meta+K"
            className="mb-3 flex w-full items-center gap-2 rounded-lg bg-deep px-2.5 py-1.5 text-[13px] text-ink-faint transition-colors hover:text-ink"
          >
            <Icon name="search" size={15} />
            <span className="flex-1 text-left">Jump to…</span>
            <kbd aria-hidden="true" className="rounded bg-lifted px-1 font-mono text-[10px]">
              Ctrl K
            </kbd>
          </button>
          {props.gettingStarted}
          <ul className="mb-3 space-y-0.5">
            <li>
              <NavRow icon="activity" label="Activity" onClick={props.onActivity}>
                {totalMentions > 0 ? (
                  <span
                    aria-label="Unread mentions"
                    className="min-w-5 rounded-full bg-alert px-1.5 text-center text-[11px] font-bold text-ground"
                  >
                    {totalMentions}
                  </span>
                ) : (
                  Object.keys(memberships).some((id) => isUnread(id)) && (
                    <span
                      aria-label="Unread conversations"
                      className="rounded-full bg-copper/15 px-1.5 text-[11px] font-semibold text-copper"
                    >
                      {Object.keys(memberships).filter((id) => isUnread(id)).length}
                    </span>
                  )
                )}
              </NavRow>
            </li>
            <li>
              <NavRow icon="thread" label="Threads" onClick={props.onThreads}>
                {unreadThreads > 0 && (
                  <span
                    aria-label="Threads with unread replies"
                    className="rounded-full bg-copper/15 px-1.5 text-[11px] font-semibold text-copper"
                  >
                    {unreadThreads}
                  </span>
                )}
              </NavRow>
            </li>
            {!guest && (
              <li>
                <NavRow icon="friends" label="Friends" onClick={props.onFriends}>
                  {friendRequests > 0 && (
                    <span className="rounded-full bg-copper/15 px-1.5 text-[11px] font-semibold text-copper">
                      {friendRequests}
                    </span>
                  )}
                </NavRow>
              </li>
            )}
            <li>
              <NavRow icon="bookmark" label="Saved" onClick={props.onSaved} />
            </li>
            {!guest && (
              <li>
                <NavRow icon="clock" label="Scheduled" onClick={props.onScheduled} />
              </li>
            )}
          </ul>
          <SectionHeader
            label="Channels"
            actions={[
              { label: "Browse", onClick: props.onBrowseChannels },
              ...(guest
                ? []
                : [{ label: "New channel", icon: "plus" as const, onClick: props.onNewChannel }]),
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
                      <Icon name="lock" size={14} />
                    </span>
                  ) : (
                    // Drawn, and still read as "# general" as it was typed.
                    <>
                      <Icon name="hash" size={16} />
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
              actions={[{ label: "New message", icon: "plus", onClick: props.onNewDm }]}
            />
          )}
          <ul>
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
                      <AvatarWithPresence user={first} online={online} size={22} />
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
              className="mx-1 mt-2 rounded-lg border border-dashed border-edge p-3 text-left text-xs leading-relaxed text-ink-faint hover:border-ink-faint hover:text-ink"
            >
              Good conversations start here.
              <span className="mt-1 flex items-center gap-1 text-copper">
                Send someone a message
                <Icon name="arrow" size={12} />
              </span>
            </button>
          )}
        </div>

        <footer className="shrink-0 bg-deep/60 p-2">
          {snoozed && <SnoozedNotice until={dndUntil!} />}
          <div className="flex items-center gap-1">
            <button
              onClick={props.onEditProfile}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-lifted"
            >
              <AvatarWithPresence
                user={self ?? undefined}
                online={!snoozed}
                size={32}
                ring="var(--color-deep)"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">
                  {self?.displayName ?? "…"}
                </span>
                <span className="block truncate text-[11px] text-ink-faint">
                  {guest
                    ? "Guest"
                    : self?.statusText || self?.statusEmoji
                      ? `${self.statusEmoji} ${self.statusText}`.trim()
                      : "Set a status"}
                </span>
              </span>
            </button>
            {!snoozed && <SnoozeControl />}
            <WorkspaceMenu
              onCreateAccount={guest ? props.onCreateAccount : undefined}
              onInvite={props.onInvite}
              onManagePeople={props.onManagePeople}
              onManageApps={props.onManageApps}
              onAccountSettings={props.onAccountSettings}
              onShortcuts={props.onShortcuts}
              onDiagnostics={props.onDiagnostics}
            />
          </div>
        </footer>
      </div>
    </nav>
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
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[15px] text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
    >
      <Icon name={props.icon} size={18} className="text-ink-faint" />
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
      {props.children}
    </button>
  );
}

/**
 * Discord's rail of servers, for Tandem's workspaces: this one on top,
 * marked as current, then this device's other saved sign-ins, then a way to
 * add one. The same choices as the menu on the workspace's name.
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
      className="workspace-rail titlebar-drag flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-deep py-3"
    >
      <span className="mb-1" aria-hidden="true">
        <BrandMark size={40} />
      </span>
      <span aria-hidden="true" className="h-0.5 w-8 rounded-full bg-edge" />
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
          className="flex size-12 items-center justify-center rounded-full bg-raised text-online transition-all hover:rounded-2xl hover:bg-online hover:text-ground"
        >
          <Icon name="plus" size={22} />
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
        className={`absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-full bg-ink transition-all ${
          props.current ? "h-10" : "h-0 group-hover:h-5"
        }`}
      />
      <Tooltip label={title} side="right">
        <button
          onClick={props.onClick}
          aria-label={props.label}
          aria-current={props.current ? "page" : undefined}
          className={`relative flex size-12 items-center justify-center text-[15px] font-semibold transition-all ${
            props.current
              ? "rounded-2xl bg-copper text-ground"
              : "rounded-full bg-raised text-ink-dim hover:rounded-2xl hover:bg-copper hover:text-ground"
          }`}
        >
          {initials(title)}
          {(props.badge ?? 0) > 0 && (
            <span
              aria-hidden="true"
              className="absolute -bottom-1 -right-1 min-w-5 rounded-full border-4 border-deep bg-alert px-1 text-center text-[11px] font-bold leading-4 text-ground"
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
 * Invite, administration, switching and account settings behind one menu: five
 * stacked rows took 270 px on a 600 px tall window and left room for about
 * four channel rows.
 */
function WorkspaceMenu(props: {
  /** Given for a guest, who has no account settings and cannot invite. */
  onCreateAccount?: () => void;
  onInvite: () => void;
  onManagePeople?: () => void;
  onManageApps?: () => void;
  onAccountSettings: () => void;
  onShortcuts?: () => void;
  onDiagnostics?: () => void;
}) {
  const items: MenuItem[] = props.onCreateAccount
    ? [{ id: "create-account", label: "Create an account", onSelect: props.onCreateAccount }]
    : [{ id: "invite", label: "Invite people", onSelect: props.onInvite }];
  if (props.onManagePeople)
    items.push({ id: "people", label: "People", onSelect: props.onManagePeople });
  if (props.onManageApps)
    items.push({ id: "apps", label: "Apps and integrations", onSelect: props.onManageApps });
  if (!props.onCreateAccount)
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
      triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
      triggerContent={
        <>
          <Icon name="settings" size={18} />
          <span className="sr-only">Workspace</span>
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
      triggerClassName="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-0.5 text-left transition-colors hover:bg-lifted"
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

/** While notifications are paused: until when, and a way to resume now. */
function SnoozedNotice({ until }: { until: number }) {
  const client = useClient();
  const resumesAt = resumeTime(until, new Date());
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg bg-copper/10 px-2.5 py-1.5">
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

/** Do Not Disturb: pause notifications for a while. */
function SnoozeControl() {
  const client = useClient();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Tooltip label="Pause notifications">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Pause notifications"
          aria-expanded={open}
          className="flex size-8 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          <Icon name="bell" size={18} />
        </button>
      </Tooltip>
      {open && (
        <ul className="absolute bottom-full right-0 z-10 mb-2 w-56 overflow-hidden rounded-lg border border-edge bg-lifted py-1 shadow-xl">
          {snoozeOptions(new Date()).map((o) => (
            <li key={o.label}>
              <button
                onClick={() => {
                  client.snoozeNotificationsUntil(o.until());
                  setOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-sm text-ink-dim transition-colors hover:bg-copper hover:text-ground"
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
    <div className="mb-1 mt-2 flex items-center justify-between pl-2 pr-1">
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
        {props.label}
      </span>
      <span className="flex items-center gap-1">
        {props.actions.map((a) => {
          const button = (
            <button
              key={a.label}
              onClick={a.onClick}
              aria-label={a.icon ? a.label : undefined}
              className="flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
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
          className="absolute -left-2 top-1/2 h-2 w-1 -translate-y-1/2 rounded-full bg-ink"
        />
      )}
      <button
        onClick={props.onClick}
        aria-current={props.active ? "page" : undefined}
        className={`channel-row my-px flex w-full items-center gap-2 rounded-lg px-2 text-left text-[15px] transition-colors ${
          props.roomy ? "py-1" : "py-1.5"
        } ${
          props.active
            ? "bg-lifted font-medium text-ink"
            : props.muted
              ? "text-ink-faint hover:bg-lifted/60"
              : props.unread
                ? "font-semibold text-ink hover:bg-lifted/60"
                : "text-ink-dim hover:bg-lifted/60 hover:text-ink"
        }`}
      >
        <span
          className={`flex shrink-0 items-center justify-center ${
            props.roomy ? "w-6" : "w-5"
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
            className="min-w-5 shrink-0 rounded-full bg-alert px-1.5 text-center text-[11px] font-bold text-ground"
          >
            {props.mentions}
          </span>
        )}
      </button>
    </li>
  );
}
