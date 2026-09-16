import { useCallback, useEffect, useRef, useState } from "react";
import type { HostingStatus, Platform } from "../platform.js";
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

/** The workspace this computer hosted last, for offering to host it again. */
export function useLastHosted(hosting: Platform["hosting"]) {
  const [lastHosted, setLastHosted] = useState<{ workspaceName: string; port: number } | null>(
    null,
  );
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
  }, [hosting]);
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
  const [busy, setBusy] = useState<"starting" | "stopping" | null>(null);
  const operationPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const phase = status?.phase ?? (status?.running ? "running" : "stopped");
  const changing = phase === "starting" || phase === "stopping";
  const unavailable = loading || statusError || !status || changing || !!busy;

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
      setError(
        "The workspace could not start. Check that its data folder is writable and its port is available, then try again.",
      );
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
      setError(
        "The workspace could not be stopped. Check its current status; Quit Gatherline offers recovery options if stopping keeps failing.",
      );
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
        </div>
      )}
      {status?.warning && (
        <p role="alert" className="mb-4 rounded-lg border border-alert/40 bg-alert/10 p-3 text-sm">
          {status.warning}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-alert">
          {error}
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
