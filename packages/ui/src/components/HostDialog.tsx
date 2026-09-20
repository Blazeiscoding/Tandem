import { useCallback, useEffect, useRef, useState } from "react";
import type { HostingStatus, Platform } from "../platform.js";
import { useCopy } from "../lib/useCopy.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

type Hosting = NonNullable<Platform["hosting"]>;

/** One live status shared by the host dialog and the surrounding workspace. */
export function useHostingStatus(hosting: Platform["hosting"]) {
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [loading, setLoading] = useState(!!hosting);
  const [error, setError] = useState(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    if (!hosting) return;
    const request = ++revision.current;
    setLoading(true);
    setError(false);
    try {
      const next = await hosting.status();
      if (request !== revision.current) return;
      setStatus(next);
    } catch {
      if (request === revision.current) setError(true);
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [hosting]);

  useEffect(() => {
    setStatus(null);
    if (!hosting) {
      setLoading(false);
      setError(false);
      return;
    }
    const unsubscribe = hosting.subscribe?.((next) => {
      // A live change takes precedence over an older in-flight status read.
      revision.current++;
      setStatus(next);
      setLoading(false);
      setError(false);
    });
    void refresh();
    return () => {
      revision.current++;
      unsubscribe?.();
    };
  }, [hosting, refresh]);

  // Only the first read is "loading". Re-reading a status already on screen must
  // not blank it, or every refresh flickers the controls it is about.
  return { status, loading: loading && status === null, error, refresh };
}

/**
 * The workspace this computer hosted last, for offering to host it again.
 * Read again whenever hosting starts or stops, since either can change it.
 */
export function useLastHosted(hosting: Platform["hosting"], status: HostingStatus | null) {
  const [lastHosted, setLastHosted] = useState<{ workspaceName: string; port: number } | null>(
    null,
  );
  const phase = status ? (status.phase ?? (status.running ? "running" : "stopped")) : null;
  const hosted = status?.running ? `${status.workspaceName ?? ""}:${status.port ?? ""}` : "";
  useEffect(() => {
    if (!hosting?.lastHosted) return;
    let alive = true;
    hosting
      .lastHosted()
      .then((value) => {
        if (alive) setLastHosted(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hosting, phase, hosted]);
  return lastHosted;
}

export function HostDialog(props: {
  hosting: Hosting;
  state: ReturnType<typeof useHostingStatus>;
  /** The hosted workspace is the one already on screen, so there is nothing to open. */
  viewingHosted?: boolean;
  onClose: () => void;
  onStarted: (status: HostingStatus) => void;
}) {
  const { status, loading, error: statusError, refresh } = props.state;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<
    "starting" | "stopping" | "opening" | "closing" | "policy" | null
  >(null);
  const operationPending = useRef(false);
  const [error, setError] = useState<{ message: string; tunnel?: boolean } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  // A public address is not authorization. Require an invite by default when
  // a previously LAN-only workspace is first put on the internet.
  const [requireInvite, setRequireInvite] = useState(true);
  const { copy, label: copyLabel } = useCopy();
  const phase = status?.phase ?? (status?.running ? "running" : "stopped");
  const changing = phase === "starting" || phase === "stopping";
  const unavailable = loading || statusError || !status || changing || !!busy;
  const publicUrl = status?.openToAll?.phase === "open" ? status.openToAll.url : null;
  const tunnelError = status?.tunnelConfigurationError ?? status?.openToAllError;

  // Opening management also refreshes shells without status subscriptions.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase === "stopped") setConfirmStop(false);
  }, [phase]);

  useEffect(() => {
    if (status?.workspaceName) setName(status.workspaceName);
  }, [status?.workspaceName]);

  useEffect(() => {
    if (status?.openToAll?.phase === "open" && status.inviteOnly !== undefined)
      setRequireInvite(status.inviteOnly);
  }, [status?.inviteOnly, status?.openToAll?.phase]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (operationPending.current || unavailable || !name.trim()) return;
    operationPending.current = true;
    setBusy("starting");
    setError(null);
    try {
      const next = await props.hosting.start({ workspaceName: name.trim() });
      void refresh();
      if (next.running && next.phase !== "stopping" && next.port !== undefined)
        props.onStarted(next);
    } catch {
      setError({
        message:
          "The workspace could not start. Check that its data folder is writable and its port is available, then try again.",
      });
      await refresh();
    } finally {
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function stop() {
    if (operationPending.current || unavailable || !confirmStop) return;
    operationPending.current = true;
    setBusy("stopping");
    setError(null);
    try {
      await props.hosting.stop();
      setConfirmStop(false);
    } catch {
      setError({
        message:
          "The workspace could not be stopped. Check its current status; Quit Gatherline offers recovery options if stopping keeps failing.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function openToAll() {
    if (
      operationPending.current ||
      unavailable ||
      !props.hosting.openToAll ||
      status?.tunnelConfigurationError ||
      status?.tunnelAvailable === false
    )
      return;
    operationPending.current = true;
    setBusy("opening");
    setError(null);
    try {
      await props.hosting.openToAll({ inviteOnly: requireInvite });
    } catch (err) {
      setError({
        tunnel: true,
        message:
          err instanceof Error && /Create your own account/i.test(err.message)
            ? "Open the workspace and create its owner account first, then try again."
            : "The public link could not be opened. Check that cloudflared is installed and that this computer is online, then try again.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function endOpenToAll() {
    if (operationPending.current || !props.hosting.endOpenToAll) return;
    operationPending.current = true;
    setBusy("closing");
    setError(null);
    try {
      await props.hosting.endOpenToAll();
    } catch {
      setError({
        tunnel: true,
        message:
          "Gatherline’s Cloudflare connection could not be closed cleanly. Try again before quitting Gatherline.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function changeInvitePolicy(next: boolean) {
    if (operationPending.current || !props.hosting.setInviteOnly) return;
    const previous = requireInvite;
    setRequireInvite(next);
    operationPending.current = true;
    setBusy("policy");
    setError(null);
    try {
      await props.hosting.setInviteOnly(next);
    } catch {
      setRequireInvite(previous);
      setError({
        message: "Who may join could not be changed. The previous setting is still in use.",
      });
    } finally {
      await refresh();
      operationPending.current = false;
      setBusy(null);
    }
  }

  return (
    <Dialog
      title={
        confirmStop ? "Stop hosting?" : status?.running ? "Workspace is live" : "Host a workspace"
      }
      onClose={() => {
        if (!operationPending.current) props.onClose();
      }}
      dismissible={!busy}
      width={500}
    >
      {loading && (
        <p role="status" className="mb-4 text-sm text-ink-dim">
          Checking hosting status…
        </p>
      )}
      {statusError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm"
        >
          <p>Could not check whether this computer is hosting a workspace.</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 text-copper underline"
          >
            Retry status
          </button>
        </div>
      )}
      {!statusError && status && (status.running || changing) && (
        <div className="mb-4 space-y-3 text-sm">
          <p role="status" className="font-medium text-ink">
            {phase === "starting"
              ? "Starting workspace…"
              : phase === "stopping"
                ? "Stopping workspace…"
                : (status.workspaceName ?? "Workspace hosted on this computer")}
          </p>
          {status.running && phase !== "stopping" && (
            <p className="text-ink-dim">
              {status.backgroundAvailable === true
                ? "Closing this window keeps the workspace running in the system tray. Use the tray to reopen Gatherline or stop hosting."
                : status.backgroundAvailable === false
                  ? "Closing this window minimizes Gatherline while hosting. Keep the app running so teammates can stay connected."
                  : "Keep Gatherline running so teammates can stay connected."}
            </p>
          )}
          {!!status.lanUrls?.length && (
            <div>
              <p className="mb-1 text-ink-dim">Teammates can connect at</p>
              <ul className="space-y-1 break-all font-mono text-copper">
                {status.lanUrls.map((url) => (
                  <li key={url}>{url}</li>
                ))}
              </ul>
            </div>
          )}
          {status.running && !status.lanUrls?.length && (
            <p className="text-ink-dim">
              No network address is available. Check this computer’s network connection.
            </p>
          )}
          {status.port !== undefined && (
            <p className="text-ink-dim">
              Local port: <span className="font-mono text-ink">{status.port}</span>
            </p>
          )}
          {status.dataDir && (
            <div>
              <p className="text-ink-dim">Workspace data folder</p>
              <p className="break-all font-mono text-xs text-ink">{status.dataDir}</p>
            </div>
          )}
          {props.hosting.openToAll && (
            <div className="rounded-xl border border-edge bg-ground p-3">
              <div className="mb-1 flex items-center justify-between gap-3">
                <h3 className="font-semibold text-ink">Open to all</h3>
                {publicUrl && (
                  <span className="rounded-full bg-copper/15 px-2 py-0.5 text-xs text-copper">
                    Public
                  </span>
                )}
              </div>
              {tunnelError && (
                <p role="alert" className="mb-2 text-xs text-alert">
                  {tunnelError}
                </p>
              )}
              {publicUrl ? (
                <>
                  <p className="mb-2 text-xs text-ink-dim">
                    {status.namedTunnelUrl
                      ? "This configured address stays the same when you reopen the public link. Keep Gatherline and its Cloudflare connector running so teammates can connect."
                      : "This temporary address works from anywhere while Gatherline and cloudflared stay running."}
                  </p>
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-edge bg-raised p-2">
                    <a
                      href={publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 break-all font-mono text-xs text-copper underline"
                    >
                      {publicUrl}
                    </a>
                    <button
                      type="button"
                      onClick={() => void copy(publicUrl, "public-address")}
                      className="shrink-0 rounded px-2 py-1 text-xs text-ink-dim hover:bg-lifted"
                    >
                      {copyLabel("Copy address", "Copied", "Copy failed", "public-address")}
                    </button>
                  </div>
                  <label className="mt-3 flex items-start gap-2 text-xs text-ink-dim">
                    <input
                      type="checkbox"
                      checked={status.inviteOnly ?? requireInvite}
                      disabled={!!busy || !props.hosting.setInviteOnly}
                      onChange={(event) => void changeInvitePolicy(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Require an invite link to create an account. Recommended for every public
                      workspace.
                    </span>
                  </label>
                  <p className="mt-2 text-xs text-ink-dim">
                    {status.inviteOnly
                      ? "In the workspace, choose Workspace → Invite people, generate a code, and copy its Browser link."
                      : "Anyone with this address can create an account. Send the address only to people you trust."}
                  </p>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void endOpenToAll()}
                    className="mt-3 rounded-lg border border-edge px-3 py-2 text-xs text-ink-dim hover:text-ink disabled:opacity-40"
                  >
                    {busy === "closing" ? "Closing public link…" : "Close public link"}
                  </button>
                </>
              ) : (
                <>
                  {status.namedTunnelUrl ? (
                    <div className="space-y-2 text-xs text-ink-dim">
                      <p>Open your configured Cloudflare Tunnel at this stable address:</p>
                      <p className="break-all font-mono text-copper">{status.namedTunnelUrl}</p>
                      {status.port !== undefined && (
                        <p>
                          In Cloudflare, route this address to{" "}
                          <code className="break-all text-ink">{`http://127.0.0.1:${status.port}`}</code>
                          .
                        </p>
                      )}
                      <p>Keep Gatherline running so teammates can connect.</p>
                    </div>
                  ) : (
                    <p className="text-xs text-ink-dim">
                      Create a temporary HTTPS address through Cloudflare Tunnel. No router setup or
                      Cloudflare account is needed.
                    </p>
                  )}
                  {status.tunnelAvailable === false ? (
                    <div className="mt-3 text-xs text-ink-dim">
                      <p>Install Cloudflare’s cloudflared tool, then check again.</p>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void refresh()}
                        className="mt-2 text-copper underline disabled:opacity-40"
                      >
                        Check again
                      </button>
                    </div>
                  ) : (
                    <>
                      <label className="mt-3 flex items-start gap-2 text-xs text-ink-dim">
                        <input
                          type="checkbox"
                          checked={requireInvite}
                          disabled={!!busy}
                          onChange={(event) => setRequireInvite(event.target.checked)}
                          className="mt-0.5"
                        />
                        <span>
                          Require an invite link to create an account. Recommended and enabled by
                          default.
                        </span>
                      </label>
                      <button
                        type="button"
                        disabled={
                          unavailable ||
                          !!status.tunnelConfigurationError ||
                          status.openToAll?.phase === "opening"
                        }
                        onClick={() => void openToAll()}
                        className={`${primaryBtnCls} mt-3 w-full`}
                      >
                        {busy === "opening" || status.openToAll?.phase === "opening"
                          ? "Opening public link…"
                          : "Open to all"}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {status?.warning && (
        <p role="alert" className="mb-4 rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm">
          {status.warning}
        </p>
      )}
      {error && !(error.tunnel && tunnelError) && (
        <p role="alert" className="mb-4 text-sm text-alert">
          {error.message}
        </p>
      )}
      {!statusError && status && (status.running || changing) ? (
        confirmStop ? (
          <div>
            <p className="text-sm text-ink-dim">
              Teammates will be disconnected until hosting starts again. Messages, files and
              accounts stay in the workspace data folder.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={!!busy || changing}
                onClick={() => setConfirmStop(false)}
                className="rounded-lg border border-edge px-4 py-2.5 text-sm disabled:opacity-40"
              >
                Keep hosting
              </button>
              <button
                type="button"
                disabled={unavailable}
                onClick={() => void stop()}
                className="rounded-lg bg-alert px-4 py-2.5 text-sm font-semibold text-ground disabled:opacity-40"
              >
                {busy === "stopping" || phase === "stopping" ? "Stopping…" : "Stop hosting"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {!props.viewingHosted && (
              <button
                type="button"
                className={primaryBtnCls}
                disabled={unavailable || !status.running || status.port === undefined}
                onClick={() => props.onStarted(status)}
              >
                Open it
              </button>
            )}
            <button
              type="button"
              disabled={unavailable}
              className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
              onClick={() => {
                setError(null);
                setConfirmStop(true);
              }}
            >
              Stop hosting
            </button>
          </div>
        )
      ) : !loading && !statusError && status ? (
        <>
          <p className="mb-4 text-sm text-ink-dim">
            Your computer becomes the server. Teammates on your network can connect while Gatherline
            is running. Messages, files and accounts are stored on this machine.
          </p>
          <form onSubmit={start} className="space-y-3">
            <input
              autoFocus
              aria-label="Workspace name"
              maxLength={80}
              value={name}
              disabled={!!busy}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name (e.g. Rocket Team)"
              className={inputCls}
            />
            <button
              type="submit"
              disabled={!name.trim() || unavailable}
              className={`${primaryBtnCls} w-full`}
            >
              {busy === "starting" ? "Starting…" : "Start hosting"}
            </button>
          </form>
        </>
      ) : null}
    </Dialog>
  );
}
