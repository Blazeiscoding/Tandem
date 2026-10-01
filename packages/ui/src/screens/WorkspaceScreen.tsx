import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ID } from "@slackoss/protocol";
import {
  WorkspaceClient,
  decideNotification,
  isMessageOnScreen,
  notificationBody,
} from "@slackoss/client-core";
import { ClientContext, OpenMessageContext, useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { channelTitle } from "../lib/format.js";
import { Sidebar, type OtherWorkspace } from "../components/Sidebar.js";
import { JumpToLatestBar, MessageTimeline } from "../components/MessageTimeline.js";
import { Composer } from "../components/Composer.js";
import { ThreadPanel } from "../components/ThreadPanel.js";
import { huddleHasVideo, type HuddleView } from "../lib/huddleView.js";
import { useCallPreferences } from "../lib/callPreferences.js";
import { QuickSwitcher } from "../components/QuickSwitcher.js";
import { PinsPanel, SavedPanel, ThreadsPanel } from "../components/MessageListPanel.js";
import { ProfileDialog } from "../components/ProfileDialog.js";
import type { AccountSection } from "../components/AccountDialog.js";
import { ShortcutsDialog } from "../components/ShortcutsDialog.js";
import { HuddleBar, HuddleButton } from "../components/HuddleBar.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { GettingStarted } from "../components/GettingStarted.js";
import { LazyDialog, LazyPanel } from "../components/LazyView.js";
import { ViewModal } from "../components/ViewModal.js";
import { FriendsDialog } from "../components/FriendsDialog.js";
import { Icon } from "../components/Icon.js";
import { DraftPersistence } from "../components/DraftPersistence.js";
import { NotificationBanner } from "../components/NotificationBanner.js";
import { useMessageAnnouncer } from "../components/MessageAnnouncer.js";
import { WorkspaceStorageGate } from "../components/WorkspaceStorageGate.js";
import { ShareableServerProvider } from "../components/ShareableServer.js";
import { hasOpenModal } from "../components/Modal.js";
import { Tooltip } from "../components/Tooltip.js";
import { isImeKey } from "../lib/textInput.js";
import { useLastConversation } from "../lib/lastConversation.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import {
  ROUTE_VIEWS,
  currentRoute,
  writeRoute,
  type RouteDialog,
  type RouteView,
} from "../lib/route.js";
import { useHistoryKeys } from "../lib/historyKeys.js";

const ActivityPanel = lazy(() =>
  import("../components/ActivityPanel.js").then((module) => ({ default: module.ActivityPanel })),
);
const AppsDialog = lazy(() =>
  import("../components/AppsDialog.js").then((module) => ({ default: module.AppsDialog })),
);
const PeopleDialog = lazy(() =>
  import("../components/PeopleDialog.js").then((module) => ({ default: module.PeopleDialog })),
);
const AccountDialog = lazy(() =>
  import("../components/AccountDialog.js").then((module) => ({ default: module.AccountDialog })),
);
// Opened now and then rather than on every visit, so they load on first use
// and keep what every visit downloads under half a megabyte.
const ScheduledPanel = lazy(() =>
  import("../components/ScheduledPanel.js").then((module) => ({ default: module.ScheduledPanel })),
);
const SearchDialog = lazy(() =>
  import("../components/SearchDialog.js").then((module) => ({ default: module.SearchDialog })),
);
// Forms opened now and then, and the video stage shown only during a call
// with video, load on first use too.
const NewChannelDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({ default: module.NewChannelDialog })),
);
const BrowseChannelsDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({
    default: module.BrowseChannelsDialog,
  })),
);
const NewDmDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({ default: module.NewDmDialog })),
);
const InviteDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({ default: module.InviteDialog })),
);
const HuddleStage = lazy(() =>
  import("../components/HuddleStage.js").then((module) => ({ default: module.HuddleStage })),
);
const DiagnosticsDialog = lazy(() =>
  import("../components/DiagnosticsDialog.js").then((module) => ({
    default: module.DiagnosticsDialog,
  })),
);
const ChannelDetailsDialog = lazy(() =>
  import("../components/ChannelDetailsDialog.js").then((module) => ({
    default: module.ChannelDetailsDialog,
  })),
);

interface Props {
  client: WorkspaceClient;
  platform: Platform;
  /** A message to open on arrival, from a link to it. */
  initialTarget?: { channelId: ID; messageId: ID } | null;
  onLeaveWorkspace: () => void;
  onSignedOut: () => void;
  /** This device's other saved workspaces, for the sidebar's switcher. */
  otherWorkspaces?: OtherWorkspace[];
  onOpenWorkspace?: (url: string) => void;
}

type DialogKind =
  | { kind: "none" }
  | { kind: "friends" }
  | { kind: "new-channel" }
  | { kind: "browse" }
  | { kind: "new-dm"; initialMemberIds?: ID[] }
  | { kind: "invite" }
  | { kind: "switcher" }
  | { kind: "search" }
  | { kind: "account"; section?: AccountSection }
  | { kind: "profile"; userId: ID }
  | { kind: "channel-details" }
  | { kind: "shortcuts" }
  | { kind: "diagnostics" }
  | { kind: "apps" }
  | { kind: "people" };

/** The opposite of the query in theme.css that turns the sidebar into a drawer. */
const WIDE = "(min-width: 761px) and (min-height: 481px)";

/** Whether the sidebar is a drawer now, so a history entry's open drawer can open. */
function drawerLayout(): boolean {
  return typeof window.matchMedia === "function" && !window.matchMedia(WIDE).matches;
}

/** The dialog an address names, as the screen holds it. */
function dialogFromRoute(dialog: RouteDialog | null | undefined): DialogKind {
  if (!dialog) return { kind: "none" };
  if (dialog.name === "account")
    return dialog.section ? { kind: "account", section: dialog.section } : { kind: "account" };
  if (dialog.name === "details") return { kind: "channel-details" };
  return { kind: dialog.name };
}

/** The part of an open dialog the address keeps, if it keeps any. */
function routeDialogOf(dialog: DialogKind): RouteDialog | null {
  switch (dialog.kind) {
    case "account":
      return dialog.section ? { name: "account", section: dialog.section } : { name: "account" };
    case "channel-details":
      return { name: "details" };
    case "people":
    case "apps":
    case "invite":
    case "shortcuts":
      return { name: dialog.kind };
    default:
      return null;
  }
}

/** Only one right-hand panel is open at a time. */
type SidePanel =
  | { kind: "none" }
  | { kind: "thread"; rootId: ID; targetId?: ID }
  | { kind: "pins" }
  | { kind: "saved" }
  | { kind: "threads" }
  | { kind: "scheduled" }
  | { kind: "activity" };

export function WorkspaceScreen({
  client,
  platform,
  initialTarget,
  onLeaveWorkspace,
  onSignedOut,
  otherWorkspaces,
  onOpenWorkspace,
}: Props) {
  return (
    <ClientContext.Provider value={client}>
      <div className="flex h-full min-h-0 flex-col">
        {platform.kind === "desktop" && (
          <div className="titlebar-drag flex h-10 shrink-0 items-center border-b border-edge px-4 text-[11px] text-ink-faint">
            Gatherline · Your workspace
          </div>
        )}
        <div className="min-h-0 flex-1">
          <WorkspaceStorageGate
            client={client}
            platform={platform}
            onLeaveWorkspace={onLeaveWorkspace}
            onSignedOut={onSignedOut}
          >
            <ShareableServerProvider platform={platform}>
              <WorkspaceInner
                platform={platform}
                initialTarget={initialTarget ?? null}
                onLeaveWorkspace={onLeaveWorkspace}
                onSignedOut={onSignedOut}
                otherWorkspaces={otherWorkspaces}
                onOpenWorkspace={onOpenWorkspace}
              />
            </ShareableServerProvider>
          </WorkspaceStorageGate>
        </div>
      </div>
    </ClientContext.Provider>
  );
}

function WorkspaceInner({
  platform,
  initialTarget,
  onLeaveWorkspace,
  onSignedOut,
  otherWorkspaces,
  onOpenWorkspace,
}: {
  platform: Platform;
  initialTarget: { channelId: ID; messageId: ID } | null;
  onLeaveWorkspace: () => void;
  onSignedOut: () => void;
  otherWorkspaces?: OtherWorkspace[];
  onOpenWorkspace?: (url: string) => void;
}) {
  const status = useWorkspace((s) => s.status);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const self = useWorkspace((s) => s.self);
  const clientFromCtx = useClient();
  const calls = useCallPreferences();
  const serverUrl = clientFromCtx.baseUrl;
  // Where the address, or Back and a reload, left this workspace. A link to a
  // message says where to go instead.
  const [initialRoute] = useState(() => (initialTarget ? null : currentRoute(serverUrl)));
  const [activeChannelId, setActiveChannelId] = useState<ID | null>(
    initialTarget?.channelId ?? initialRoute?.channelId ?? null,
  );
  const [highlightMessageId, setHighlightMessageId] = useState<ID | null>(
    initialTarget?.messageId ?? null,
  );
  const [panel, setPanel] = useState<SidePanel>(
    initialRoute?.threadRootId
      ? { kind: "thread", rootId: initialRoute.threadRootId }
      : initialRoute?.view
        ? { kind: initialRoute.view }
        : { kind: "none" },
  );
  const [dialog, setDialog] = useState<DialogKind>(() => dialogFromRoute(initialRoute?.dialog));
  const [sidebarOpen, setSidebarOpen] = useState(
    () => initialRoute?.drawer === true && drawerLayout(),
  );
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  /**
   * Whether the history entry on screen is a step this screen added to open
   * the phone drawer. Closing the drawer without going anywhere goes Back
   * through it, so a phone's Back button closes the drawer, and afterwards
   * leaves the conversation as it would have before.
   */
  const drawerStep = useRef(false);
  // Below a laptop's width a side panel covers the conversation, as theme.css
  // lays it out, so what it covers leaves the Tab order and the screen
  // reader's reading as the page does behind a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  const panelCovers = narrow && panel.kind !== "none";
  const closeDrawer = useCallback(() => {
    if (drawerStep.current) {
      drawerStep.current = false;
      window.history.back();
      return;
    }
    setSidebarOpen(false);
  }, []);
  const [huddleView, setHuddleView] = useState<HuddleView>("docked");
  const huddleVideo = useWorkspace((s) => huddleHasVideo(s.huddle));
  // Once the video is gone, the next video starts in view again, above the chat.
  useEffect(() => {
    if (!huddleVideo) setHuddleView("docked");
  }, [huddleVideo]);
  /** The video covers the chat, which stays mounted underneath so it keeps its place. */
  const chatCovered = huddleView === "expanded" && huddleVideo;
  const navigation = useRef(0);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  useEffect(
    () => () => {
      navigation.current++;
      clientFromCtx.cancelMessageJump();
    },
    [clientFromCtx],
  );

  useEffect(() => {
    if (dialog.kind !== "none") setSidebarOpen(false);
  }, [dialog.kind]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const nav = document.querySelector<HTMLElement>('[aria-label="Workspace navigation"]');
    const previous = document.activeElement as HTMLElement | null;
    nav?.querySelector<HTMLElement>("button")?.focus();
    const onTab = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasOpenModal() || event.key !== "Tab") return;
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
    const wide = window.matchMedia(WIDE);
    const onResize = () => {
      if (wide.matches && sidebarOpenRef.current) closeDrawer();
    };
    wide.addEventListener("change", onResize);
    return () => wide.removeEventListener("change", onResize);
  }, [closeDrawer]);

  // Load the linked message's surrounding history, then navigate to it. This
  // must set state rather than rely on the useState initialisers above: the
  // screen keeps its key across deep links, so it re-renders without remounting.
  useEffect(() => {
    if (!initialTarget) return;
    const { channelId, messageId } = initialTarget;
    jumpToMessage(channelId, messageId);
    return () => {
      navigation.current++;
    };
  }, [clientFromCtx, initialTarget]);

  // The composer's slash-command hints. Re-fetched when an admin adds one.
  useEffect(() => {
    void clientFromCtx.loadCommands();
  }, [clientFromCtx]);

  /**
   * A conversation the app, not the person, moved to. Arriving there replaces
   * the history entry, so Back does not lead to somewhere unavailable.
   */
  const replaceRoute = useRef<ID | null>(null);
  /**
   * Bumped when a link or the address itself names where to be. The place may
   * be the one already on screen, and the address still needs writing back.
   */
  const [routeRequest, setRouteRequest] = useState(0);

  // With nothing in the address or history to say where to be, open the
  // conversation this account last had open here, once it has been read.
  const lastConversation = useLastConversation();
  const restoring = useRef(!initialTarget && !initialRoute);

  // Pick #general (or the first channel) once the snapshot lands, and move
  // there from a conversation this account cannot see or that has gone.
  useEffect(() => {
    if (!activeChannelId || (status === "online" && !channels[activeChannelId])) {
      const list = Object.values(channels).filter((c) => !c.archived);
      const general = list.find((c) => c.name === "general") ?? list[0];
      if (!general) return;
      if (!activeChannelId && restoring.current) {
        if (lastConversation.remembered === undefined) return;
        restoring.current = false;
        const last = lastConversation.remembered && channels[lastConversation.remembered];
        if (last && !last.archived) {
          replaceRoute.current = last.id;
          setActiveChannelId(last.id);
          return;
        }
      }
      if (activeChannelId) {
        setNavigationError(
          "That conversation is not available. It may have been deleted, or you may not have access to it.",
        );
        setPanel((p) => (p.kind === "thread" ? { kind: "none" } : p));
      }
      replaceRoute.current = general.id;
      setActiveChannelId(general.id);
    }
  }, [channels, activeChannelId, status, lastConversation.remembered]);

  const { remember } = lastConversation;
  useEffect(() => {
    if (activeChannelId && status === "online" && channels[activeChannelId])
      remember(activeChannelId);
  }, [activeChannelId, channels, status, remember]);

  // The address follows the conversation and the thread or panel beside it,
  // so Back, Forward and a reload return to them, and Back closes a panel.
  const routeThread = panel.kind === "thread" ? panel.rootId : null;
  const routeView = (ROUTE_VIEWS as readonly string[]).includes(panel.kind)
    ? (panel.kind as RouteView)
    : null;
  // A settings or list dialog is a place too, so Back closes it and a reload
  // reopens it. Moving between Account settings' sections, or closing a
  // dialog the account may not open, rewrites the entry instead of adding one.
  const routeDialog = routeDialogOf(dialog);
  const routeDialogName = routeDialog?.name ?? null;
  const routeDialogSection = routeDialog?.section ?? null;
  const replaceDialogStep = useRef(false);
  /**
   * Whether the history entry on screen is a step this screen added to open
   * the dialog. Closing that dialog goes Back through it, so Back afterwards
   * does not open again what was just dismissed.
   */
  const dialogStep = useRef(false);
  /** The conversation, thread or panel last written, beneath any dialog. */
  const lastPlace = useRef<string | null>(null);
  useEffect(() => {
    if (!activeChannelId) return;
    // Going somewhere from the drawer takes the drawer's step's place, so Back
    // from there returns to where things were before the drawer opened.
    const leavingDrawer = drawerStep.current && !sidebarOpen;
    const replace =
      replaceRoute.current === activeChannelId || replaceDialogStep.current || leavingDrawer;
    if (replaceRoute.current === activeChannelId) replaceRoute.current = null;
    replaceDialogStep.current = false;
    const place = `${activeChannelId}/${routeThread ?? ""}/${routeView ?? ""}`;
    // Only a dialog or the drawer opening over the same place makes a step
    // of its own to go Back through.
    const samePlace = lastPlace.current === place;
    const openingDialog = routeDialogName !== null && !dialogStep.current && samePlace;
    const openingDrawer = sidebarOpen && !drawerStep.current && samePlace && !routeDialogName;
    lastPlace.current = place;
    const step = writeRoute(
      serverUrl,
      {
        channelId: activeChannelId,
        threadRootId: routeThread,
        ...(routeView ? { view: routeView } : {}),
        ...(routeDialogName
          ? {
              dialog: {
                name: routeDialogName,
                ...(routeDialogSection ? { section: routeDialogSection } : {}),
              },
            }
          : {}),
        ...(sidebarOpen ? { drawer: true } : {}),
      },
      replace ? "replace" : "auto",
    );
    if (!routeDialogName) dialogStep.current = false;
    else if (step === "push") dialogStep.current = openingDialog;
    if (!sidebarOpen) drawerStep.current = false;
    else if (step === "push") drawerStep.current = openingDrawer;
  }, [
    serverUrl,
    activeChannelId,
    routeThread,
    routeView,
    routeDialogName,
    routeDialogSection,
    sidebarOpen,
    routeRequest,
  ]);

  // People and Apps are for administrators. An address can name them all the
  // same, so they close for anyone else once the account is known.
  const isAdmin = self?.role === "owner" || self?.role === "admin";
  useEffect(() => {
    if (self && !isAdmin && (dialog.kind === "people" || dialog.kind === "apps")) {
      replaceDialogStep.current = true;
      setDialog({ kind: "none" });
    }
  }, [self, isAdmin, dialog.kind]);

  useEffect(() => {
    const onPopState = () => {
      const route = currentRoute(serverUrl);
      if (!route) return;
      navigation.current++;
      clientFromCtx.cancelMessageJump();
      setNavigating(false);
      setNavigationError(null);
      setActiveChannelId(route.channelId);
      setHighlightMessageId(null);
      const view = route.view;
      setPanel((p) =>
        route.threadRootId
          ? p.kind === "thread" && p.rootId === route.threadRootId
            ? p
            : { kind: "thread", rootId: route.threadRootId }
          : view
            ? p.kind === view
              ? p
              : { kind: view }
            : p.kind === "none"
              ? p
              : { kind: "none" },
      );
      dialogStep.current = false;
      drawerStep.current = false;
      setDialog(dialogFromRoute(route.dialog));
      setSidebarOpen(route.drawer === true && drawerLayout());
      setRouteRequest((n) => n + 1);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [serverUrl, clientFromCtx]);

  useHistoryKeys(platform.kind === "desktop");

  useEffect(() => {
    clientFromCtx.focusConversation(activeChannelId);
    return () => clientFromCtx.focusConversation(null);
  }, [clientFromCtx, activeChannelId]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A foreground form owns its keys. Shortcuts must not replace a busy
      // dialog, or let its Escape dismiss a thread behind it as well.
      if (e.defaultPrevented || hasOpenModal() || isImeKey(e)) return;
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
      // Dialogs close themselves on Escape; this closes the phone drawer, or
      // with none open, the side panel.
      if (e.key === "Escape") {
        if (sidebarOpenRef.current) closeDrawer();
        else setPanel((p) => (p.kind === "none" ? p : { kind: "none" }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDrawer]);

  const activeChannel = activeChannelId ? channels[activeChannelId] : undefined;
  const title = activeChannel ? channelTitle(activeChannel, users, self?.id) : "";
  const isRoom = activeChannel?.type === "public" || activeChannel?.type === "private";

  const openChannel = useCallback(
    (id: ID) => {
      navigation.current++;
      clientFromCtx.cancelMessageJump();
      setNavigating(false);
      setNavigationError(null);
      setActiveChannelId(id);
      setHighlightMessageId(null);
      setPanel({ kind: "none" });
      setDialog({ kind: "none" });
      setSidebarOpen(false);
    },
    [clientFromCtx],
  );
  const openThread = useCallback((rootId: ID) => setPanel({ kind: "thread", rootId }), []);
  const openProfile = useCallback((userId: ID) => setDialog({ kind: "profile", userId }), []);

  /**
   * Opens a thread from the Threads list. The row already names its root, so
   * unlike a jump there is nothing to resolve before showing it.
   */
  function openThreadInChannel(channelId: ID, rootId: ID) {
    navigation.current++;
    setNavigationError(null);
    setNavigating(false);
    setDialog({ kind: "none" });
    setActiveChannelId(channelId);
    setHighlightMessageId(rootId);
    setPanel({ kind: "thread", rootId });
  }

  /** Opens a channel scrolled to one message, from search, pins or Saved. */
  function jumpToMessage(channelId: ID, messageId: ID) {
    const ticket = ++navigation.current;
    setDialog({ kind: "none" });
    setNavigationError(null);
    setNavigating(true);
    void clientFromCtx
      .jumpToMessage(channelId, messageId)
      .then((rootId) => {
        if (ticket !== navigation.current || rootId === undefined) return;
        setActiveChannelId(channelId);
        setHighlightMessageId(rootId ?? messageId);
        setPanel(rootId ? { kind: "thread", rootId, targetId: messageId } : { kind: "none" });
        setRouteRequest((n) => n + 1);
      })
      .catch(() => {
        if (ticket === navigation.current)
          setNavigationError(
            "Could not open this message. It may have been deleted, access may have changed, or the workspace may be offline.",
          );
      })
      .finally(() => {
        if (ticket === navigation.current) setNavigating(false);
      });
  }

  // One function for the life of the screen, so links in every message can
  // hold it without each message redrawing whenever this screen does.
  const jumpTo = useRef(jumpToMessage);
  jumpTo.current = jumpToMessage;
  const openMessage = useCallback((channelId: ID, messageId: ID) => {
    jumpTo.current(channelId, messageId);
  }, []);

  const closeDialog = () => {
    if (dialogStep.current) {
      // The entry before this one is the same place without the dialog.
      dialogStep.current = false;
      window.history.back();
      return;
    }
    setDialog({ kind: "none" });
  };

  const announcer = useMessageAnnouncer();
  const { hear, forget } = announcer;
  const openThreadId = panel.kind === "thread" ? panel.rootId : null;
  /**
   * What covers the conversation now, read when a message arrives. On a phone
   * the open drawer covers everything, and a side panel covers the timeline;
   * an expanded huddle video covers the timeline too.
   */
  const covered = useRef({ channel: false, thread: false });
  covered.current = {
    channel: panelCovers || chatCovered || (sidebarOpen && drawerLayout()),
    thread: sidebarOpen && drawerLayout(),
  };
  // What the last conversation received is not news in the next one.
  useEffect(() => forget(), [activeChannelId, forget]);

  // Desktop notifications for incoming messages, gated by channel preferences,
  // mute and Do Not Disturb (the rules live in client-core so they're testable).
  // Installed as the screen commits, not after: a message arriving between a
  // conversation appearing and a passive effect running would otherwise be
  // judged against the one before, and notify about what is on screen.
  useLayoutEffect(() => {
    clientFromCtx.onIncomingMessage = (msg, { live }) => {
      const state = clientFromCtx.state;
      // Read to a screen reader what reaches the conversation on screen, but
      // not what a reconnect catches up on: that is history, not news.
      const inChannel = msg.channelId === activeChannelId && (!msg.threadRootId || msg.broadcast);
      const inThread = msg.threadRootId !== null && msg.threadRootId === openThreadId;
      if (live && (inChannel || inThread)) {
        hear({
          from: state.users[msg.userId]?.displayName ?? "Someone",
          text: notificationBody(state, msg),
          inThread: !inChannel,
        });
      }
      // A message you're already looking at needs no notification. One in a
      // thread that is not open is not in view just because its channel is.
      const onScreen = isMessageOnScreen(msg, {
        focused: document.hasFocus() && document.visibilityState !== "hidden",
        channelId: activeChannelId,
        channelVisible: !covered.current.channel,
        threadRootId: openThreadId,
        threadVisible: !covered.current.thread,
      });
      if (onScreen) return;
      if (!decideNotification(state, msg, { live }).notify) return;

      const channel = state.channels[msg.channelId];
      const from = state.users[msg.userId]?.displayName ?? "Someone";
      const where = channel?.name ? ` in #${channel.name}` : "";
      // A click opens the message it names, through the same jump that
      // search results, pins and links use.
      platform.notify(`${from}${where}`, notificationBody(state, msg), () =>
        openMessage(msg.channelId, msg.id),
      );
    };
    return () => {
      clientFromCtx.onIncomingMessage = null;
    };
  }, [clientFromCtx, activeChannelId, openThreadId, hear, openMessage, platform]);

  const connectionLabel =
    status === "online"
      ? null
      : status === "reconnecting" || status === "connecting"
        ? "reconnecting…"
        : status === "auth_failed"
          ? "signed out"
          : status === "protocol_mismatch"
            ? "Server version incompatible — update Gatherline"
            : status === "password_change_required"
              ? "Choose a new password to carry on"
              : "offline";

  useEffect(() => {
    // Signing out is what leads back to the screen that can replace a password:
    // signing in again lands on it, holding the password it needs to replace.
    if (status === "auth_failed" || status === "password_change_required") onSignedOut();
  }, [status, onSignedOut]);

  const screen = (
    <div className={`workspace-shell relative flex h-full ${sidebarOpen ? "sidebar-open" : ""}`}>
      <DraftPersistence platform={platform} />
      {/* Outside main, which goes inert while the phone drawer is open. */}
      {announcer.region}
      {sidebarOpen && (
        <button
          className="sidebar-dismiss fixed inset-0 z-30 bg-black/60"
          aria-label="Close navigation"
          onClick={closeDrawer}
        />
      )}
      <Sidebar
        onSearch={() => setDialog({ kind: "switcher" })}
        onSaved={() => {
          setPanel({ kind: "saved" });
          setSidebarOpen(false);
        }}
        onScheduled={() => {
          setPanel({ kind: "scheduled" });
          setSidebarOpen(false);
        }}
        onFriends={() => setDialog({ kind: "friends" })}
        onActivity={() => {
          setPanel({ kind: "activity" });
          setSidebarOpen(false);
        }}
        onThreads={() => {
          setPanel({ kind: "threads" });
          setSidebarOpen(false);
        }}
        activeChannelId={activeChannelId}
        onSelect={openChannel}
        onBrowseChannels={() => setDialog({ kind: "browse" })}
        onNewChannel={() => setDialog({ kind: "new-channel" })}
        onNewDm={() => setDialog({ kind: "new-dm" })}
        onInvite={() => setDialog({ kind: "invite" })}
        onSwitchWorkspace={onLeaveWorkspace}
        otherWorkspaces={otherWorkspaces}
        onOpenWorkspace={onOpenWorkspace}
        onEditProfile={() => setDialog({ kind: "account", section: "profile" })}
        onAccountSettings={() => setDialog({ kind: "account" })}
        onShortcuts={() => setDialog({ kind: "shortcuts" })}
        gettingStarted={
          <GettingStarted
            onNewChannel={() => setDialog({ kind: "new-channel" })}
            onInvite={() => setDialog({ kind: "invite" })}
            onNotifications={() => setDialog({ kind: "account", section: "notifications" })}
            activeChannelName={activeChannel && isRoom ? `#${activeChannel.name}` : null}
            onTryHuddle={() => {
              if (!activeChannelId) return;
              setSidebarOpen(false);
              clientFromCtx
                .joinHuddle(activeChannelId, { muted: calls.joinMuted })
                .catch((err: unknown) => {
                  setNavigationError(
                    err instanceof Error
                      ? `Could not start a huddle: ${err.message}`
                      : "Could not start a huddle. Check your connection and try again.",
                  );
                });
            }}
          />
        }
        onDiagnostics={() => setDialog({ kind: "diagnostics" })}
        onManageApps={isAdmin ? () => setDialog({ kind: "apps" }) : undefined}
        onManagePeople={isAdmin ? () => setDialog({ kind: "people" }) : undefined}
        connectionLabel={connectionLabel}
      />

      <main inert={sidebarOpen || panelCovers} className="flex min-w-0 flex-1 flex-col">
        <NotificationBanner storage={platform.storage} />
        {navigating && (
          <p role="status" className="px-5 py-2 text-sm text-ink-faint">
            Opening message…
          </p>
        )}
        {navigationError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-edge px-5 py-2 text-sm text-ink-dim"
          >
            {navigationError}
            <button className="text-copper" onClick={() => setNavigationError(null)}>
              Dismiss
            </button>
          </div>
        )}
        <header className="channel-header titlebar-drag flex h-[76px] shrink-0 items-center gap-3 border-b border-edge px-5">
          <button
            id="open-navigation"
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
            <p className="channel-topic mt-1 truncate text-xs text-ink-faint">
              {activeChannel?.topic ||
                (isRoom ? "A space to keep the conversation moving" : "Your private conversation")}
            </p>
          </button>
          {activeChannelId && <HuddleButton channelId={activeChannelId} />}
          <Tooltip label="Pinned messages">
            <button
              onClick={() =>
                setPanel((p) => (p.kind === "pins" ? { kind: "none" } : { kind: "pins" }))
              }
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
          </Tooltip>
          <Tooltip label="Saved messages">
            <button
              onClick={() =>
                setPanel((p) => (p.kind === "saved" ? { kind: "none" } : { kind: "saved" }))
              }
              aria-label="Saved messages"
              aria-pressed={panel.kind === "saved"}
              className={`header-secondary rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
                panel.kind === "saved"
                  ? "border-copper text-copper"
                  : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
              }`}
            >
              <Icon name="bookmark" />
            </button>
          </Tooltip>
          <Tooltip label="Scheduled messages">
            <button
              onClick={() =>
                setPanel((p) => (p.kind === "scheduled" ? { kind: "none" } : { kind: "scheduled" }))
              }
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
          </Tooltip>
          <Tooltip label="Search messages" keys="Ctrl/Cmd F">
            <button
              onClick={() => setDialog({ kind: "search" })}
              aria-label="Search messages"
              className="flex items-center gap-2 rounded-lg border border-edge px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
            >
              <Icon name="search" size={16} />
              <span className="header-secondary">Search</span>
            </button>
          </Tooltip>
        </header>

        {activeChannelId ? (
          <>
            {/* The stage sits above the chat, and when expanded, over it. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Mounted while there is video at all, even put away: the stage brings
                  itself back when someone starts sharing. */}
              {huddleVideo && (
                <ErrorBoundary
                  fallback={
                    <p role="alert" className="border-b border-edge px-5 py-3 text-sm text-ink-dim">
                      The huddle's video could not load. The call carries on; reload the app to see
                      video.
                    </p>
                  }
                >
                  <Suspense fallback={null}>
                    <HuddleStage view={huddleView} onViewChange={setHuddleView} />
                  </Suspense>
                </ErrorBoundary>
              )}
              <div inert={chatCovered} className="flex min-h-0 flex-1 flex-col">
                <MessageTimeline
                  readActive={
                    dialog.kind === "none" && panel.kind === "none" && !sidebarOpen && !chatCovered
                  }
                  channelId={activeChannelId}
                  highlightMessageId={highlightMessageId}
                  onOpenThread={openThread}
                  onChannelClick={openChannel}
                  onOpenProfile={openProfile}
                />
              </div>
            </div>
            <HuddleBar view={huddleView} onViewChange={setHuddleView} />
            <div hidden={chatCovered} className="contents">
              <JumpToLatestBar
                channelId={activeChannelId}
                onJump={() => setHighlightMessageId(null)}
              />
              <Composer
                channelId={activeChannelId}
                placeholder={isRoom ? `Message #${title}` : `Message ${title}`}
                autoFocus
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-ink-faint">
            Pick a channel to start.
          </div>
        )}
      </main>

      {panel.kind === "thread" && activeChannelId && (
        <ThreadPanel
          readActive={dialog.kind === "none" && !sidebarOpen}
          channelId={activeChannelId}
          rootId={panel.rootId}
          targetId={panel.targetId}
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
      {panel.kind === "saved" && (
        <SavedPanel onClose={() => setPanel({ kind: "none" })} onJump={jumpToMessage} />
      )}
      {panel.kind === "threads" && (
        <ThreadsPanel onClose={() => setPanel({ kind: "none" })} onJump={openThreadInChannel} />
      )}
      {panel.kind === "activity" && (
        <LazyPanel name="Activity" onClose={() => setPanel({ kind: "none" })}>
          <ActivityPanel onClose={() => setPanel({ kind: "none" })} onJump={jumpToMessage} />
        </LazyPanel>
      )}
      {panel.kind === "scheduled" && (
        <LazyPanel name="Scheduled messages" onClose={() => setPanel({ kind: "none" })}>
          <ScheduledPanel onClose={() => setPanel({ kind: "none" })} onJump={openChannel} />
        </LazyPanel>
      )}

      {(dialog.kind === "new-channel" ||
        dialog.kind === "browse" ||
        dialog.kind === "new-dm" ||
        dialog.kind === "invite") && (
        <LazyDialog
          loading={
            dialog.kind === "new-channel"
              ? "Loading new channel"
              : dialog.kind === "browse"
                ? "Loading channels"
                : dialog.kind === "new-dm"
                  ? "Loading new message"
                  : "Loading invite"
          }
          onClose={closeDialog}
        >
          {dialog.kind === "new-channel" && (
            <NewChannelDialog onClose={closeDialog} onCreated={(ch) => openChannel(ch.id)} />
          )}
          {dialog.kind === "browse" && (
            <BrowseChannelsDialog onClose={closeDialog} onOpen={openChannel} />
          )}
          {dialog.kind === "new-dm" && (
            <NewDmDialog
              initialMemberIds={dialog.initialMemberIds}
              onClose={closeDialog}
              onOpen={openChannel}
            />
          )}
          {dialog.kind === "invite" && <InviteDialog onClose={closeDialog} />}
        </LazyDialog>
      )}
      {dialog.kind === "switcher" && <QuickSwitcher onClose={closeDialog} onOpen={openChannel} />}
      {dialog.kind === "search" && (
        <LazyDialog loading="Loading search" onClose={closeDialog}>
          <SearchDialog channelId={activeChannelId} onClose={closeDialog} onJump={jumpToMessage} />
        </LazyDialog>
      )}
      {dialog.kind === "shortcuts" && <ShortcutsDialog onClose={closeDialog} />}
      {dialog.kind === "diagnostics" && (
        <LazyDialog loading="Loading diagnostics" onClose={closeDialog}>
          <DiagnosticsDialog onClose={closeDialog} />
        </LazyDialog>
      )}
      {(((dialog.kind === "apps" || dialog.kind === "people") && isAdmin) ||
        dialog.kind === "account") && (
        <LazyDialog key={dialog.kind} loading="Loading settings" onClose={closeDialog}>
          {dialog.kind === "apps" && <AppsDialog onClose={closeDialog} />}
          {dialog.kind === "people" && <PeopleDialog onClose={closeDialog} />}
          {dialog.kind === "account" && (
            <AccountDialog
              onClose={closeDialog}
              onSignedOut={onSignedOut}
              section={dialog.section}
              onSectionChange={(section) => {
                replaceDialogStep.current = true;
                setDialog({ kind: "account", section });
              }}
            />
          )}
        </LazyDialog>
      )}
      {/* Not one of the workspace's own dialogs: an app asked for this one, so
          it shows itself whenever one arrives. */}
      <ViewModal />
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
        <LazyDialog loading="Loading channel details" onClose={closeDialog}>
          <ChannelDetailsDialog
            key={activeChannelId}
            channelId={activeChannelId}
            onChangeParticipants={(memberIds) =>
              setDialog({ kind: "new-dm", initialMemberIds: memberIds })
            }
            onClose={closeDialog}
            onLeft={() => {
              // Going somewhere else at once, so no step Back to wait for.
              dialogStep.current = false;
              setDialog({ kind: "none" });
              setActiveChannelId(null);
            }}
            onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
          />
        </LazyDialog>
      )}
    </div>
  );
  return <OpenMessageContext.Provider value={openMessage}>{screen}</OpenMessageContext.Provider>;
}
