import { useEffect, useRef, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { WorkspaceClient } from "@slackoss/client-core";
import { ClientContext, useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { channelTitle } from "../lib/format.js";
import { Sidebar } from "../components/Sidebar.js";
import { MessageTimeline } from "../components/MessageTimeline.js";
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

interface Props {
  client: WorkspaceClient;
  platform: Platform;
  onLeaveWorkspace: () => void;
}

type DialogKind = "none" | "new-channel" | "browse" | "new-dm" | "invite" | "switcher" | "search";

/** Only one right-hand panel is open at a time. */
type SidePanel = { kind: "none" } | { kind: "thread"; rootId: ID } | { kind: "pins" } | { kind: "later" };

export function WorkspaceScreen({ client, platform, onLeaveWorkspace }: Props) {
  return (
    <ClientContext.Provider value={client}>
      <WorkspaceInner platform={platform} onLeaveWorkspace={onLeaveWorkspace} />
    </ClientContext.Provider>
  );
}

function WorkspaceInner({
  platform,
  onLeaveWorkspace,
}: {
  platform: Platform;
  onLeaveWorkspace: () => void;
}) {
  const status = useWorkspace((s) => s.status);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const self = useWorkspace((s) => s.self);
  const [activeChannelId, setActiveChannelId] = useState<ID | null>(null);
  const [panel, setPanel] = useState<SidePanel>({ kind: "none" });
  const [dialog, setDialog] = useState<DialogKind>("none");
  const clientFromCtx = useClient();
  const drafts = useWorkspace((s) => s.drafts);

  // Pick #general (or the first channel) once the snapshot lands.
  useEffect(() => {
    if (!activeChannelId) {
      const list = Object.values(channels);
      const general = list.find((c) => c.name === "general") ?? list[0];
      if (general) setActiveChannelId(general.id);
    }
  }, [channels, activeChannelId]);

  // Drafts live on disk per server, so an accidental quit doesn't lose them.
  const draftStorageKey = `drafts:${clientFromCtx.baseUrl}`;
  const draftsLoaded = useRef(false);

  useEffect(() => {
    draftsLoaded.current = false;
    void platform.storage.get<Record<string, string>>(draftStorageKey).then((stored) => {
      if (stored && Object.keys(stored).length > 0) clientFromCtx.hydrateDrafts(stored);
      draftsLoaded.current = true;
    });
  }, [clientFromCtx, platform, draftStorageKey]);

  useEffect(() => {
    // Until the stored drafts arrive, this component's empty initial state
    // would overwrite them on disk.
    if (!draftsLoaded.current) return;
    const timer = setTimeout(() => void platform.storage.set(draftStorageKey, drafts), 600);
    return () => clearTimeout(timer);
  }, [drafts, platform, draftStorageKey]);

  // Desktop notifications for incoming messages when unfocused or elsewhere.
  useEffect(() => {
    clientFromCtx.onIncomingMessage = (msg) => {
      const away = !document.hasFocus() || msg.channelId !== activeChannelId;
      if (!away) return;
      const ch = clientFromCtx.state.channels[msg.channelId];
      const isMember = msg.channelId in clientFromCtx.state.memberships;
      if (!ch || !isMember) return;
      const mentioned = self ? msg.text.includes(`<@${self.id}>`) : false;
      const isDm = ch.type === "dm" || ch.type === "group_dm";
      if (!isDm && !mentioned) return;
      const from = clientFromCtx.state.users[msg.userId]?.displayName ?? "Someone";
      const where = isDm ? "" : ` in #${ch.name}`;
      platform.notify(`${from}${where}`, msg.text.replaceAll(/<@([A-Z0-9]+)>/g, "@someone"));
    };
    return () => {
      clientFromCtx.onIncomingMessage = null;
    };
  }, [clientFromCtx, activeChannelId, platform, self]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog((d) => (d === "switcher" ? "none" : "switcher"));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setDialog("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeChannel = activeChannelId ? channels[activeChannelId] : undefined;
  const title = activeChannel ? channelTitle(activeChannel, users, self?.id) : "";
  const isRoom = activeChannel?.type === "public" || activeChannel?.type === "private";

  function openChannel(id: ID) {
    setActiveChannelId(id);
    setPanel({ kind: "none" });
    setDialog("none");
  }

  const connectionLabel =
    status === "online"
      ? null
      : status === "reconnecting" || status === "connecting"
        ? "reconnecting…"
        : status === "auth_failed"
          ? "signed out"
          : "offline";

  useEffect(() => {
    if (status === "auth_failed") onLeaveWorkspace();
  }, [status, onLeaveWorkspace]);

  return (
    <div className="flex h-full">
      <Sidebar
        activeChannelId={activeChannelId}
        onSelect={openChannel}
        onBrowseChannels={() => setDialog("browse")}
        onNewChannel={() => setDialog("new-channel")}
        onNewDm={() => setDialog("new-dm")}
        onInvite={() => setDialog("invite")}
        onSwitchWorkspace={onLeaveWorkspace}
        connectionLabel={connectionLabel}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="titlebar-drag flex h-[53px] shrink-0 items-center gap-3 border-b border-edge px-5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-bold leading-tight">
              {isRoom ? `#${title}` : title || "…"}
            </h2>
            {activeChannel?.topic && (
              <p className="truncate text-xs text-ink-faint">{activeChannel.topic}</p>
            )}
          </div>
          <button
            onClick={() =>
              setPanel((p) => (p.kind === "pins" ? { kind: "none" } : { kind: "pins" }))
            }
            title="Pinned messages"
            className={`rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
              panel.kind === "pins"
                ? "border-copper text-copper"
                : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
            }`}
          >
            📌
          </button>
          <button
            onClick={() =>
              setPanel((p) => (p.kind === "later" ? { kind: "none" } : { kind: "later" }))
            }
            title="Saved for later"
            className={`rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors ${
              panel.kind === "later"
                ? "border-copper text-copper"
                : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
            }`}
          >
            🔖
          </button>
          <button
            onClick={() => setDialog("search")}
            className="rounded-lg border border-edge px-3 py-1.5 text-[13px] text-ink-faint transition-colors hover:border-ink-faint hover:text-ink"
          >
            Search <kbd className="ml-1 font-mono text-[10px]">Ctrl F</kbd>
          </button>
        </header>

        {activeChannelId ? (
          <>
            <MessageTimeline
              channelId={activeChannelId}
              onOpenThread={(rootId) => setPanel({ kind: "thread", rootId })}
              onChannelClick={openChannel}
            />
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
        />
      )}
      {panel.kind === "pins" && activeChannelId && (
        <PinsPanel
          channelId={activeChannelId}
          onClose={() => setPanel({ kind: "none" })}
          onJump={openChannel}
        />
      )}
      {panel.kind === "later" && (
        <LaterPanel onClose={() => setPanel({ kind: "none" })} onJump={openChannel} />
      )}

      {dialog === "new-channel" && (
        <NewChannelDialog onClose={() => setDialog("none")} onCreated={(ch) => openChannel(ch.id)} />
      )}
      {dialog === "browse" && (
        <BrowseChannelsDialog onClose={() => setDialog("none")} onOpen={openChannel} />
      )}
      {dialog === "new-dm" && <NewDmDialog onClose={() => setDialog("none")} onOpen={openChannel} />}
      {dialog === "invite" && <InviteDialog onClose={() => setDialog("none")} />}
      {dialog === "switcher" && (
        <QuickSwitcher onClose={() => setDialog("none")} onOpen={openChannel} />
      )}
      {dialog === "search" && (
        <SearchDialog onClose={() => setDialog("none")} onJump={openChannel} />
      )}
    </div>
  );
}
