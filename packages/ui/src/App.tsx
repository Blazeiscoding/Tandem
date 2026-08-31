import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceClient } from "@slackoss/client-core";
import { PlatformContext } from "./context.js";
import type { HostingStatus, Platform, SavedServer } from "./platform.js";
import { parseDeepLink } from "./lib/deeplink.js";
import { JoinScreen } from "./screens/JoinScreen.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { Dialog, inputCls, primaryBtnCls } from "./components/Dialog.js";

type Session =
  | { view: "loading" }
  | { view: "join"; autoProbe?: string; inviteCode?: string }
  | {
      view: "workspace";
      client: WorkspaceClient;
      server: SavedServer;
      /** Set when a slackoss://message link opened this workspace. */
      target?: { channelId: string; messageId: string } | null;
    };

export function App({ platform }: { platform: Platform }) {
  const [savedServers, setSavedServers] = useState<SavedServer[]>([]);
  const [session, setSession] = useState<Session>({ view: "loading" });
  const [hostDialogOpen, setHostDialogOpen] = useState(false);
  const clientRef = useRef<WorkspaceClient | null>(null);
  /** Which workspace is open, so a deep link to it can skip reconnecting. */
  const openServerUrl = useRef<string | null>(null);

  const persistServers = useCallback(
    (list: SavedServer[]) => {
      setSavedServers(list);
      void platform.storage.set("servers", list);
    },
    [platform],
  );

  const openWorkspace = useCallback(
    (
      server: SavedServer,
      list: SavedServer[],
      target?: { channelId: string; messageId: string } | null,
    ) => {
      clientRef.current?.destroy();
      const client = new WorkspaceClient(server.url, server.token);
      clientRef.current = client;
      client.connect();
      const updated = [
        { ...server, lastUsedAt: Date.now() },
        ...list.filter((s) => s.url !== server.url),
      ];
      persistServers(updated);
      openServerUrl.current = server.url;
      setSession({ view: "workspace", client, server, target: target ?? null });
    },
    [persistServers],
  );

  // Boot: restore saved servers, auto-open the most recent one.
  useEffect(() => {
    void platform.storage.get<SavedServer[]>("servers").then((stored) => {
      const list = stored ?? [];
      setSavedServers(list);
      if (list.length > 0) {
        openWorkspace(list[0]!, list);
      } else {
        setSession({ view: "join" });
      }
    });
    return () => clientRef.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // slackoss:// links: join a workspace, or jump to a specific message.
  const handleDeepLink = useCallback(
    (raw: string) => {
      const link = parseDeepLink(raw);
      if (!link) return;
      void platform.storage.get<SavedServer[]>("servers").then((stored) => {
        const list = stored ?? [];
        const known = list.find((s) => s.url === link.serverUrl);
        if (link.kind === "message") {
          // Already looking at this workspace: just move, don't reconnect.
          if (openServerUrl.current === link.serverUrl) {
            setSession((prev) =>
              prev.view === "workspace"
                ? { ...prev, target: { channelId: link.channelId, messageId: link.messageId } }
                : prev,
            );
            return;
          }
          // Otherwise it needs credentials we already hold.
          if (known) {
            openWorkspace(known, list, {
              channelId: link.channelId,
              messageId: link.messageId,
            });
          } else {
            setSession({ view: "join", autoProbe: link.serverUrl });
          }
          return;
        }
        if (known) openWorkspace(known, list);
        else
          setSession({
            view: "join",
            autoProbe: link.serverUrl,
            inviteCode: link.code ?? undefined,
          });
      });
    },
    [openWorkspace, platform],
  );

  useEffect(() => {
    if (!platform.deepLinks) return;
    void platform.deepLinks.consumePending().then((url) => {
      if (url) handleDeepLink(url);
    });
    return platform.deepLinks.subscribe(handleDeepLink);
  }, [platform, handleDeepLink]);

  const leaveWorkspace = useCallback(() => {
    clientRef.current?.destroy();
    clientRef.current = null;
    openServerUrl.current = null;
    setSession({ view: "join" });
  }, []);

  const forgetServer = useCallback(
    (url: string) => {
      persistServers(savedServers.filter((s) => s.url !== url));
    },
    [persistServers, savedServers],
  );

  return (
    <PlatformContext.Provider value={platform}>
      <div className="h-full">
        {session.view === "loading" && (
          <div className="flex h-full items-center justify-center font-mono text-sm text-ink-faint">
            starting…
          </div>
        )}
        {session.view === "join" && (
          <JoinScreen
            platform={platform}
            savedServers={savedServers}
            autoProbe={session.autoProbe}
            inviteCode={session.inviteCode}
            onConnected={(server) => openWorkspace(server, savedServers)}
            onForget={forgetServer}
            onHostClick={platform.hosting ? () => setHostDialogOpen(true) : undefined}
          />
        )}
        {session.view === "workspace" && (
          <WorkspaceScreen
            key={session.server.url}
            client={session.client}
            platform={platform}
            initialTarget={session.target ?? null}
            onLeaveWorkspace={leaveWorkspace}
          />
        )}
        {hostDialogOpen && platform.hosting && (
          <HostDialog
            hosting={platform.hosting}
            onClose={() => setHostDialogOpen(false)}
            onStarted={(status) => {
              setHostDialogOpen(false);
              setSession({ view: "join", autoProbe: `localhost:${status.port}` });
            }}
          />
        )}
      </div>
    </PlatformContext.Provider>
  );
}

function HostDialog(props: {
  hosting: NonNullable<Platform["hosting"]>;
  onClose: () => void;
  onStarted: (status: HostingStatus) => void;
}) {
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void props.hosting.status().then(setStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await props.hosting.start({ workspaceName: name.trim() });
      props.onStarted(s);
    } catch {
      setError("The server couldn't start. Is another app using the port?");
      setBusy(false);
    }
  }

  if (status?.running) {
    return (
      <Dialog title="Workspace is live" onClose={props.onClose}>
        <p className="mb-3 text-sm text-ink-dim">
          A workspace server is already running on this computer.
        </p>
        <ul className="mb-4 space-y-1 font-mono text-sm text-copper">
          {(status.lanUrls ?? []).map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            className={primaryBtnCls}
            onClick={() => props.onStarted(status)}
          >
            Open it
          </button>
          <button
            className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim hover:text-ink"
            onClick={async () => {
              await props.hosting.stop();
              setStatus(await props.hosting.status());
            }}
          >
            Stop hosting
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Host a workspace" onClose={props.onClose}>
      <p className="mb-4 text-sm text-ink-dim">
        Your computer becomes the server — like opening a game to LAN. Teammates on your network
        will see it instantly; everything stays on this machine.
      </p>
      <form onSubmit={start} className="space-y-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name (e.g. Rocket Team)"
          className={inputCls}
        />
        {error && <p className="text-sm text-alert">{error}</p>}
        <button type="submit" disabled={!name.trim() || busy} className={`${primaryBtnCls} w-full`}>
          {busy ? "Starting…" : "Start hosting"}
        </button>
      </form>
    </Dialog>
  );
}
