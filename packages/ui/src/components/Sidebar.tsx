import { useMemo, useState } from "react";
import type { Channel, ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { Avatar, PresenceDot } from "./Avatar.js";

interface Props {
  activeChannelId: ID | null;
  onSelect: (id: ID) => void;
  onBrowseChannels: () => void;
  onNewChannel: () => void;
  onNewDm: () => void;
  onFriends: () => void;
  onInvite: () => void;
  onSwitchWorkspace: () => void;
  onEditProfile: () => void;
  /** Admins only; absent for members. */
  onManageApps?: () => void;
  connectionLabel: string | null;
}

export function Sidebar(props: Props) {
  const client = useClient();
  const friendRequests = useWorkspace((s) => s.friends.filter((f) => f.status === "incoming").length);
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

  return (
    <nav className="flex h-full w-[250px] shrink-0 flex-col border-r border-edge bg-raised">
      <header className="titlebar-drag border-b border-edge px-4 pb-3 pt-4">
        <h1 className="truncate text-[15px] font-bold">{workspaceName || "…"}</h1>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
          <span
            className={`size-1.5 rounded-full ${props.connectionLabel ? "bg-copper" : "bg-online"}`}
          />
          <span className="truncate">{props.connectionLabel ?? baseHost}</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <button onClick={props.onFriends} className="mb-4 flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-ink-dim hover:bg-lifted hover:text-ink">
          <span>Friends</span>
          {friendRequests > 0 && <span className="rounded-full bg-copper/15 px-2 text-xs text-copper">{friendRequests}</span>}
        </button>
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
                onClick={() => props.onSelect(ch.id)}
                icon={<PresenceDot online={online} />}
                label={channelTitle(ch, users, self?.id)}
              />
            );
          })}
        </ul>
      </div>

      <footer className="border-t border-edge p-2">
        <SnoozeControl snoozed={snoozed} until={dndUntil} />
        <button
          onClick={props.onEditProfile}
          className="mb-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-lifted"
        >
          <Avatar user={self ?? undefined} size={30} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {self?.displayName ?? "…"}
            </span>
            <span className="block truncate text-[11px] text-ink-faint">
              {self?.statusText || self?.statusEmoji
                ? `${self.statusEmoji} ${self.statusText}`.trim()
                : "Set a status"}
            </span>
          </span>
        </button>
        <button
          onClick={props.onInvite}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          + Invite people
        </button>
        {props.onManageApps && (
          <button
            onClick={props.onManageApps}
            className="w-full rounded-lg px-3 py-1.5 text-left text-[13px] text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
          >
            ⚙ Apps and integrations
          </button>
        )}
        <button
          onClick={props.onSwitchWorkspace}
          className="w-full rounded-lg px-3 py-1.5 text-left text-[13px] text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
        >
          ⇄ Switch workspace
        </button>
      </footer>
    </nav>
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
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={props.onClick}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left text-sm transition-colors ${
          props.active
            ? "bg-copper/15 text-copper"
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
