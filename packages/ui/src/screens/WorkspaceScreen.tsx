import { useCallback, useEffect, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { WorkspaceClient, decideNotification, notificationBody } from "@slackoss/client-core";
import { ClientContext, useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { channelTitle } from "../lib/format.js";
import { Sidebar } from "../components/Sidebar.js";
import { JumpToLatestBar, MessageTimeline } from "../components/MessageTimeline.js";
import { Composer } from "../components/Composer.js";
import { ThreadPanel } from "../components/ThreadPanel.js";
import {
  BrowseChannelsDialog,
  InviteDialog,
  NewChannelDialog,
  NewDmDialog,
} from "../components/dialogs.js";
import { QuickSwitcher, SearchDialog } from "../components/QuickSwitcher.js";
import { LaterPanel, PinsPanel } from "../components/MessageListPanel.js";
import { ScheduledPanel } from "../components/ScheduledPanel.js";
import { EditProfileDialog, ProfileDialog } from "../components/ProfileDialog.js";
import { ChannelDetailsDialog } from "../components/ChannelDetailsDialog.js";
import { ShortcutsDialog } from "../components/ShortcutsDialog.js";
import { HuddleBar, HuddleButton, HuddleStage } from "../components/HuddleBar.js";
import { AppsDialog } from "../components/AppsDialog.js";
import { PeopleDialog } from "../components/PeopleDialog.js";
import { ViewModal } from "../components/ViewModal.js";
import { FriendsDialog } from "../components/FriendsDialog.js";
import { Icon } from "../components/Icon.js";
import { DraftPersistence } from "../components/DraftPersistence.js";

interface Props {
  client: WorkspaceClient;
  platform: Platform;
  /** A message to open on arrival, from a slackoss://message link. */
  initialTarget?: { channelId: ID; messageId: ID } | null;
  onLeaveWorkspace: () => void;
}

type DialogKind =
  | { kind: "none" }
  | { kind: "friends" }
  | { kind: "new-channel" }
  | { kind: "browse" }
  | { kind: "new-dm" }
  | { kind: "invite" }
  | { kind: "switcher" }
  | { kind: "search" }
  | { kind: "edit-profile" }
  | { kind: "profile"; userId: ID }
  | { kind: "channel-details" }
  | { kind: "shortcuts" }
  | { kind: "apps" }
  | { kind: "people" };

/** Only one right-hand panel is open at a time. */
type SidePanel =
  | { kind: "none" }
  | { kind: "thread"; rootId: ID }
  | { kind: "pins" }
  | { kind: "later" }
  | { kind: "scheduled" };

export function WorkspaceScreen({ client, platform, initialTarget, onLeaveWorkspace }: Props) {
  return (
    <ClientContext.Provider value={client}>
      <div className="flex h-full min-h-0 flex-col">
        {platform.kind === "desktop" && (
          <div className="titlebar-drag flex h-10 shrink-0 items-center border-b border-edge px-4 text-[11px] text-ink-faint">
            Gatherline · Your workspace
          </div>
        )}
        <div className="min-h-0 flex-1">
          <WorkspaceInner
            platform={platform}
            initialTarget={initialTarget ?? null}
            onLeaveWorkspace={onLeaveWorkspace}
          />
        </div>
      </div>
    </ClientContext.Provider>
  );
}

function WorkspaceInner({
  platform,
  initialTarget,
  onLeaveWorkspace,
}: {
  platform: Platform;
  initialTarget: { channelId: ID; messageId: ID } | null;
  onLeaveWorkspace: () => void;
}) {
  const status = useWorkspace((s) => s.status);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const self = useWorkspace((s) => s.self);
  const [activeChannelId, setActiveChannelId] = useState<ID | null>(
    initialTarget?.channelId ?? null,
  );
  const [highlightMessageId, setHighlightMessageId] = useState<ID | null>(
    initialTarget?.messageId ?? null,
  );
  const [panel, setPanel] = useState<SidePanel>({ kind: "none" });
  const [dialog, setDialog] = useState<DialogKind>({ kind: "none" });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const clientFromCtx = useClient();

  useEffect(() => {
    if (dialog.kind !== "none") setSidebarOpen(false);
  }, [dialog.kind]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const nav = document.querySelector<HTMLElement>('[aria-label="Workspace navigation"]');
    const previous = document.activeElement as HTMLElement | null;
    nav?.querySelector<HTMLElement>("button")?.focus();
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const buttons = [
        ...(nav?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
      ].filter((button) => button.getClientRects().length > 0);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onTab);
    return () => {
      window.removeEventListener("keydown", onTab);
      // A newly opened dialog owns focus now; do not pull it back out.
      if (previous?.isConnected && !document.activeElement?.closest('[role="dialog"]'))
        previous.focus();
    };
  }, [sidebarOpen]);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 761px)");
    const onResize = () => {
      if (wide.matches) setSidebarOpen(false);
    };
    wide.addEventListener("change", onResize);
    return () => wide.removeEventListener("change", onResize);
  }, []);

  // Load the linked message's surrounding history, then navigate to it. This
  // must set state rather than rely on the useState initialisers above: the
  // screen keeps its key across deep links, so it re-renders without remounting.
  useEffect(() => {
    if (!initialTarget) return;
    const { channelId, messageId } = initialTarget;
    void clientFromCtx
      .jumpToMessage(channelId, messageId)
      .then(() => {
        setActiveChannelId(channelId);
        setHighlightMessageId(messageId);
      })
      .catch(() => setHighlightMessageId(null));
  }, [clientFromCtx, initialTarget]);

  // The composer's slash-command hints. Re-fetched when an admin adds one.
  useEffect(() => {
    void clientFromCtx.loadCommands();
  }, [clientFromCtx]);

  // Pick #general (or the first channel) once the snapshot lands.
  useEffect(() => {
    if (!activeChannelId || (status === "online" && !channels[activeChannelId])) {
      const list = Object.values(channels);
      const general = list.find((c) => c.name === "general") ?? list[0];
      if (general) setActiveChannelId(general.id);
    }
  }, [channels, activeChannelId, status]);

  // Desktop notifications for incoming messages, gated by channel preferences,
  // mute and Do Not Disturb (the rules live in client-core so they're testable).
  useEffect(() => {
    clientFromCtx.onIncomingMessage = (msg, { live }) => {
      const state = clientFromCtx.state;
      // A message you're already looking at needs no notification.
      if (document.hasFocus() && msg.channelId === activeChannelId) return;
      if (!decideNotification(state, msg, { live }).notify) return;

      const channel = state.channels[msg.channelId];
      const from = state.users[msg.userId]?.displayName ?? "Someone";
      const where = channel?.name ? ` in #${channel.name}` : "";
      platform.notify(`${from}${where}`, notificationBody(state, msg));
    };
    return () => {
      clientFromCtx.onIncomingMessage = null;
    };
  }, [clientFromCtx, activeChannelId, platform]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog((d) => (d.kind === "switcher" ? { kind: "none" } : { kind: "switcher" }));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setDialog({ kind: "search" });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setDialog((d) => (d.kind === "shortcuts" ? { kind: "none" } : { kind: "shortcuts" }));
      }
      // Dialogs close themselves on Escape; this clears the side panel.
      if (e.key === "Escape") {
        setPanel((p) => (p.kind === "none" ? p : { kind: "none" }));
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeChannel = activeChannelId ? channels[activeChannelId] : undefined;
  const title = activeChannel ? channelTitle(activeChannel, users, self?.id) : "";
  const isRoom = activeChannel?.type === "public" || activeChannel?.type === "private";

  const openChannel = useCallback((id: ID) => {
    setActiveChannelId(id);
    setHighlightMessageId(null);
    setPanel({ kind: "none" });
    setDialog({ kind: "none" });
    setSidebarOpen(false);
  }, []);
  const openThread = useCallback((rootId: ID) => setPanel({ kind: "thread", rootId }), []);
  const openProfile = useCallback((userId: ID) => setDialog({ kind: "profile", userId }), []);

  /** Opens a channel scrolled to one message, from search, pins or Later. */
  function jumpToMessage(channelId: ID, messageId: ID) {
    setDialog({ kind: "none" });
    void clientFromCtx.jumpToMessage(channelId, messageId).then(() => {
      setActiveChannelId(channelId);
      setHighlightMessageId(messageId);
    });
  }

  const closeDialog = () => setDialog({ kind: "none" });

  const connectionLabel =
    status === "online"
      ? null
      : status === "reconnecting" || status === "connecting"
        ? "reconnecting…"
        : status === "auth_failed"
          ? "signed out"
          : status === "protocol_mismatch"
            ? "Server version incompatible — update Gatherline"
            : "offline";

  useEffect(() => {
    if (status === "auth_failed") onLeaveWorkspace();
  }, [status, onLeaveWorkspace]);

  return (
    <div className={`workspace-shell relative flex h-full ${sidebarOpen ? "sidebar-open" : ""}`}>
      <DraftPersistence platform={platform} />
      {sidebarOpen && (
        <button
          className="sidebar-dismiss fixed inset-0 z-30 bg-black/60"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar
        onSearch={() => setDialog({ kind: "switcher" })}
        onSaved={() => {
          setPanel({ kind: "later" });
          setSidebarOpen(false);
        }}
        onScheduled={() => {
          setPanel({ kind: "scheduled" });
          setSidebarOpen(false);
        }}
        onFriends={() => setDialog({ kind: "friends" })}
        activeChannelId={activeChannelId}
        onSelect={openChannel}
        onBrowseChannels={() => setDialog({ kind: "browse" })}
        onNewChannel={() => setDialog({ kind: "new-channel" })}
        onNewDm={() => setDialog({ kind: "new-dm" })}
        onInvite={() => setDialog({ kind: "invite" })}
        onSwitchWorkspace={onLeaveWorkspace}
        onEditProfile={() => setDialog({ kind: "edit-profile" })}
        onManageApps={
          self?.role === "owner" || self?.role === "admin"
            ? () => setDialog({ kind: "apps" })
            : undefined
        }
        onManagePeople={
          self?.role === "owner" || self?.role === "admin"
            ? () => setDialog({ kind: "people" })
            : undefined
        }
        connectionLabel={connectionLabel}
      />

      <main inert={sidebarOpen} className="flex min-w-0 flex-1 flex-col">
        <header className="channel-header titlebar-drag flex h-[76px] shrink-0 items-center gap-3 border-b border-edge px-5">
          <button
            className="mobile-nav-toggle rounded-lg p-2 text-ink-dim hover:bg-lifted"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <button
            onClick={() => activeChannelId && setDialog({ kind: "channel-details" })}
            className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left transition-colors hover:bg-lifted"
          >
            <h2 className="truncate text-[17px] font-semibold leading-tight">
              {isRoom ? `#${title}` : title || "…"}
            </h2>
            <p className="mt-1 truncate text-xs text-ink-faint">
              {activeChannel?.topic ||
                (isRoom ? "A space to keep the conversation moving" : "Your private conversation")}
            </p>
          </button>
          {activeChannelId && <HuddleButton channelId={activeChannelId} />}
          <button
            onClick={() =>
              setPanel((p) => (p.kind === "pins" ? { kind: "none" } : { kind: "pins" }))
            }
            title="Pinned messages"
            aria-label="Pinned messages"
            aria-pressed={panel.kind === "pins"}
            className={`rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
              panel.kind === "pins"
                ? "border-copper text-copper"
                : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
            }`}
          >
            <Icon name="pin" />
          </button>
          <button
            onClick={() =>
              setPanel((p) => (p.kind === "later" ? { kind: "none" } : { kind: "later" }))
            }
            title="Saved for later"
            aria-label="Saved for later"
            aria-pressed={panel.kind === "later"}
            className={`header-secondary rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
              panel.kind === "later"
                ? "border-copper text-copper"
                : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
            }`}
          >
            <Icon name="bookmark" />
          </button>
          <button
            onClick={() =>
              setPanel((p) => (p.kind === "scheduled" ? { kind: "none" } : { kind: "scheduled" }))
            }
            title="Scheduled messages"
            aria-label="Scheduled messages"
            aria-pressed={panel.kind === "scheduled"}
            className={`header-secondary rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
              panel.kind === "scheduled"
                ? "border-copper text-copper"
                : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
            }`}
          >
            <Icon name="clock" />
          </button>
          <button
            onClick={() => setDialog({ kind: "search" })}
            aria-label="Search messages"
            title="Search messages (Ctrl F)"
            className="flex items-center gap-2 rounded-lg border border-edge px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
          >
            <Icon name="search" size={16} />
            <span className="header-secondary">Search</span>
          </button>
        </header>

        {activeChannelId ? (
          <>
            <MessageTimeline
              channelId={activeChannelId}
              highlightMessageId={highlightMessageId}
              onOpenThread={openThread}
              onChannelClick={openChannel}
              onOpenProfile={openProfile}
            />
            <HuddleStage />
            <HuddleBar />
            <JumpToLatestBar channelId={activeChannelId} />
            <Composer
              channelId={activeChannelId}
              placeholder={isRoom ? `Message #${title}` : `Message ${title}`}
              autoFocus
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-ink-faint">
            Pick a channel to start.
          </div>
        )}
      </main>

      {panel.kind === "thread" && activeChannelId && (
        <ThreadPanel
          channelId={activeChannelId}
          rootId={panel.rootId}
          onClose={() => setPanel({ kind: "none" })}
          onChannelClick={openChannel}
          onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
        />
      )}
      {panel.kind === "pins" && activeChannelId && (
        <PinsPanel
          channelId={activeChannelId}
          onClose={() => setPanel({ kind: "none" })}
          onJump={jumpToMessage}
        />
      )}
      {panel.kind === "later" && (
        <LaterPanel onClose={() => setPanel({ kind: "none" })} onJump={jumpToMessage} />
      )}
      {panel.kind === "scheduled" && (
        <ScheduledPanel onClose={() => setPanel({ kind: "none" })} onJump={openChannel} />
      )}

      {dialog.kind === "new-channel" && (
        <NewChannelDialog onClose={closeDialog} onCreated={(ch) => openChannel(ch.id)} />
      )}
      {dialog.kind === "browse" && (
        <BrowseChannelsDialog onClose={closeDialog} onOpen={openChannel} />
      )}
      {dialog.kind === "new-dm" && <NewDmDialog onClose={closeDialog} onOpen={openChannel} />}
      {dialog.kind === "invite" && <InviteDialog onClose={closeDialog} />}
      {dialog.kind === "switcher" && <QuickSwitcher onClose={closeDialog} onOpen={openChannel} />}
      {dialog.kind === "search" && <SearchDialog onClose={closeDialog} onJump={jumpToMessage} />}
      {dialog.kind === "shortcuts" && <ShortcutsDialog onClose={closeDialog} />}
      {dialog.kind === "apps" && <AppsDialog onClose={closeDialog} />}
      {dialog.kind === "people" && <PeopleDialog onClose={closeDialog} />}
      {/* Not one of the workspace's own dialogs: an app asked for this one, so
          it shows itself whenever one arrives. */}
      <ViewModal />
      {dialog.kind === "edit-profile" && <EditProfileDialog onClose={closeDialog} />}
      {dialog.kind === "friends" && (
        <FriendsDialog
          onClose={closeDialog}
          onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
        />
      )}
      {dialog.kind === "profile" && (
        <ProfileDialog userId={dialog.userId} onClose={closeDialog} onOpenDm={openChannel} />
      )}
      {dialog.kind === "channel-details" && activeChannelId && (
        <ChannelDetailsDialog
          channelId={activeChannelId}
          onClose={closeDialog}
          onLeft={() => {
            closeDialog();
            setActiveChannelId(null);
          }}
          onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
        />
      )}
    </div>
  );
}
