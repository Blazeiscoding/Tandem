import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceClient } from "@slackoss/client-core";
import { PlatformContext } from "./context.js";
import type { HostingStatus, Platform, SavedServer } from "./platform.js";
import { parseDeepLink } from "./lib/deeplink.js";
import { JoinScreen } from "./screens/JoinScreen.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { Dialog, inputCls, primaryBtnCls } from "./components/Dialog.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { parseSavedServers } from "./lib/savedServers.js";

type Session =
  | { view: "loading" }
  | { view: "restore_failed" }
  | { view: "join"; autoProbe?: string; inviteCode?: string }
  | {
      view: "workspace";
      id: number;
      client: WorkspaceClient;
      server: SavedServer;
      /** Set when a slackoss://message link opened this workspace. */
      target?: { channelId: string; messageId: string } | null;
    };

export function App({ platform }: { platform: Platform }) {
  const [savedServers, setSavedServers] = useState<SavedServer[]>([]);
  const savedServersRef = useRef<SavedServer[]>([]);
  const [session, setSession] = useState<Session>({ view: "loading" });
  const [hostDialogOpen, setHostDialogOpen] = useState(false);
  const clientRef = useRef<WorkspaceClient | null>(null);
  const connectionId = useRef(0);
  const navigation = useRef(0);
  const restoredServers = useRef(false);
  const saveVersion = useRef(0);
  const [saveError, setSaveError] = useState(false);
  const [forgetConfirm, setForgetConfirm] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const forgetting = useRef(false);
  const deferredDeepLink = useRef<string | null>(null);
  const [forgetError, setForgetError] = useState(false);
  /** Which workspace is open, so a deep link to it can skip reconnecting. */
  const openServerUrl = useRef<string | null>(null);

  const persistServers = useCallback(
    async (list: SavedServer[]) => {
      const version = ++saveVersion.current;
      savedServersRef.current = list;
      setSavedServers(list);
      try {
        await platform.storage.set("servers", list);
        if (version === saveVersion.current) setSaveError(false);
      } catch {
        if (version === saveVersion.current) setSaveError(true);
      }
    },
    [platform],
  );

  const openWorkspace = useCallback(
    (
      server: SavedServer,
      list: SavedServer[],
      target?: { channelId: string; messageId: string } | null,
    ) => {
      navigation.current++;
      clientRef.current?.destroy();
      const client = new WorkspaceClient(server.url, server.token);
      clientRef.current = client;
      client.connect();
      const updated = [
        { ...server, lastUsedAt: Date.now() },
        ...list.filter((s) => s.url !== server.url),
      ];
      void persistServers(updated);
      openServerUrl.current = server.url;
      setSession({
        view: "workspace",
        id: ++connectionId.current,
        client,
        server,
        target: target ?? null,
      });
    },
    [persistServers],
  );

  const restoreServers = useCallback(async () => {
    const ticket = ++navigation.current;
    setSession({ view: "loading" });
    try {
      const list = parseSavedServers(
        await platform.storage.get<unknown>("servers", { strict: true }),
      );
      if (ticket !== navigation.current) return;
      restoredServers.current = true;
      savedServersRef.current = list;
      setSavedServers(list);
      if (list.length > 0) {
        openWorkspace(list[0]!, list);
      } else {
        setSession({ view: "join" });
      }
    } catch {
      if (ticket === navigation.current) setSession({ view: "restore_failed" });
    }
  }, [openWorkspace, platform]);

  // A locked key store or unreadable settings must not silently erase sign-ins.
  useEffect(() => {
    void restoreServers();
    return () => {
      navigation.current++;
      clientRef.current?.destroy();
    };
  }, [restoreServers]);

  // slackoss:// links: join a workspace, or jump to a specific message.
  const handleDeepLink = useCallback(
    async (raw: string) => {
      const link = parseDeepLink(raw);
      if (!link) return;
      if (forgetting.current) {
        deferredDeepLink.current = raw;
        return;
      }
      setForgetConfirm(false);
      const ticket = ++navigation.current;
      try {
        const list = restoredServers.current
          ? savedServersRef.current
          : parseSavedServers(await platform.storage.get<unknown>("servers", { strict: true }));
        if (ticket !== navigation.current) return;
        restoredServers.current = true;
        savedServersRef.current = list;
        setSavedServers(list);
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
      } catch {
        if (ticket === navigation.current) setSession({ view: "restore_failed" });
      }
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
    navigation.current++;
    clientRef.current?.destroy();
    clientRef.current = null;
    openServerUrl.current = null;
    setSession({ view: "join" });
  }, []);

  const forgetServer = useCallback(
    (url: string) => {
      void persistServers(savedServers.filter((s) => s.url !== url));
    },
    [persistServers, savedServers],
  );

  const endSession = useCallback(
    (server: SavedServer, client: WorkspaceClient) => {
      // A late logout response must not remove a newer sign-in to the same workspace.
      void persistServers(
        savedServersRef.current.filter(
          (saved) => saved.url !== server.url || saved.token !== server.token,
        ),
      );
      if (clientRef.current === client) leaveWorkspace();
    },
    [persistServers, leaveWorkspace],
  );

  async function forgetSavedSignIns() {
    if (forgetting.current) return;
    forgetting.current = true;
    setForgetBusy(true);
    setForgetError(false);
    const ticket = ++navigation.current;
    try {
      // Deliberate reset of credentials only; drafts and other settings remain.
      await platform.storage.set("servers", []);
      if (ticket !== navigation.current) return;
      savedServersRef.current = [];
      restoredServers.current = true;
      setSavedServers([]);
      setSaveError(false);
      setForgetConfirm(false);
      setSession({ view: "join" });
    } catch {
      if (ticket === navigation.current) setForgetError(true);
    } finally {
      forgetting.current = false;
      setForgetBusy(false);
      const link = deferredDeepLink.current;
      deferredDeepLink.current = null;
      if (link) {
        setForgetConfirm(false);
        void handleDeepLink(link);
      }
    }
  }

  return (
    <PlatformContext.Provider value={platform}>
      <ErrorBoundary>
        <div className="flex h-full flex-col">
          {platform.kind === "desktop" &&
            (saveError || session.view === "loading" || session.view === "restore_failed") && (
              <div className="titlebar-drag h-10 shrink-0 border-b border-edge" />
            )}
          {saveError && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-3 border-b border-alert/30 bg-raised px-4 py-3 text-sm text-ink"
            >
              <span className="flex-1">
                Could not save changes to sign-ins on this device. This session can continue.
                {platform.kind === "desktop"
                  ? " Unlock your system key store and retry; new sign-ins are never saved as plain text."
                  : " Check browser storage and retry before closing."}
              </span>
              <button
                type="button"
                className="shrink-0 text-copper underline"
                onClick={() => void persistServers(savedServersRef.current)}
              >
                Retry saving
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {session.view === "loading" && (
              <div className="flex h-full items-center justify-center font-mono text-sm text-ink-faint">
                starting…
              </div>
            )}
            {session.view === "restore_failed" && (
              <div className="flex h-full items-center justify-center bg-ground p-6">
                <div className="max-w-md space-y-4 text-center text-ink">
                  <h1 className="text-xl font-semibold">Saved sign-ins could not be opened</h1>
                  <p role="alert" className="text-sm text-ink-dim">
                    {platform.kind === "desktop"
                      ? "Unlock your system key store, or use the OS account that saved these sign-ins, and retry. The saved data is still on this device."
                      : "Browser storage could not be read. The saved data is kept; retry after resolving the storage problem."}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      className={primaryBtnCls}
                      onClick={() => void restoreServers()}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      className="rounded-lg px-3 py-2 text-sm hover:bg-lifted"
                      onClick={() => {
                        setForgetError(false);
                        setForgetConfirm(true);
                      }}
                    >
                      Forget saved sign-ins
                    </button>
                  </div>
                </div>
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
                key={session.id}
                client={session.client}
                platform={platform}
                initialTarget={session.target ?? null}
                onLeaveWorkspace={leaveWorkspace}
                onSignedOut={() => endSession(session.server, session.client)}
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
            {forgetConfirm && (
              <Dialog
                title="Forget saved sign-ins?"
                onClose={() => {
                  if (!forgetBusy) setForgetConfirm(false);
                }}
                dismissible={!forgetBusy}
              >
                <p className="text-sm text-ink-dim">
                  Remove saved sign-ins on this device and sign in again. Drafts, queued messages
                  and hosted workspaces stay on this device.
                </p>
                {forgetError && (
                  <p role="alert" className="mt-3 text-sm text-alert">
                    Could not update saved sign-ins. Check access to the settings file and retry.
                  </p>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-lg px-3 py-2 text-sm hover:bg-lifted"
                    disabled={forgetBusy}
                    onClick={() => setForgetConfirm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={primaryBtnCls}
                    disabled={forgetBusy}
                    onClick={() => void forgetSavedSignIns()}
                  >
                    {forgetBusy ? "Forgetting…" : "Forget and sign in again"}
                  </button>
                </div>
              </Dialog>
            )}
          </div>
        </div>
      </ErrorBoundary>
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
          <button className={primaryBtnCls} onClick={() => props.onStarted(status)}>
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
