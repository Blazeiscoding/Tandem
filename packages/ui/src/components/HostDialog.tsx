import { useCallback, useEffect, useRef, useState } from "react";
import type {
  HostedWorkspaces,
  HostingStart,
  HostingStatus,
  LastHosted,
  Platform,
} from "../platform.js";
import { useHostingStatus } from "../lib/hosting.js";
import { useCopy } from "../lib/useCopy.js";
import { formatDay, formatTime } from "../lib/format.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

type Hosting = NonNullable<Platform["hosting"]>;

/**
 * Every workspace hosted on this computer, read again whenever hosting
 * starts or stops. Null until read, and on an app with no list to read.
 */
function useHostedWorkspaces(hosting: Hosting, phase: string, revision: number) {
  const [hosted, setHosted] = useState<HostedWorkspaces | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!hosting.list) return;
    let alive = true;
    hosting
      .list()
      .then((value) => {
        if (!alive) return;
        setHosted(value);
        setFailed(false);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [hosting, phase, revision]);
  return { hosted, failed };
}

/** "today, 3:04 PM" or "Monday, September 22, 3:04 PM". */
function backedUpWhen(at: number): string {
  const day = formatDay(at);
  return `${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}, ${formatTime(at)}`;
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
    | "starting"
    | "stopping"
    | "opening"
    | "closing"
    | "policy"
    | "address"
    | "backing-up"
    | "removing"
    | "restoring"
    | null
  >(null);
  const operationPending = useRef(false);
  const [error, setError] = useState<{ message: string; tunnel?: boolean } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  /** Null while the saved address is shown; a string while it is being edited. */
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  // A public address is not authorization. Require an invite by default when
  // a previously LAN-only workspace is first put on the internet.
  const [requireInvite, setRequireInvite] = useState(true);
  const { copy, label: copyLabel } = useCopy();
  const phase = status?.phase ?? (status?.running ? "running" : "stopped");
  const changing = phase === "starting" || phase === "stopping";
  const unavailable = loading || statusError || !status || changing || !!busy;
  const publicUrl = status?.openToAll?.phase === "open" ? status.openToAll.url : null;
  const externallyCarried = !!status?.publicAddress && !status.publicAddressManaged;
  const tunnelError = status?.publicAddressError ?? status?.openToAllError;
  const savedAddress = status?.publicAddressSetting ?? "";
  const addressValue = addressDraft ?? savedAddress;
  const addressDirty = addressDraft !== null && addressDraft.trim() !== savedAddress;

  // Opening management also refreshes shells without status subscriptions.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase === "stopped") setConfirmStop(false);
  }, [phase]);

  useEffect(() => {
    if (status?.inviteOnly !== undefined) setRequireInvite(status.inviteOnly);
  }, [status?.inviteOnly]);

  const [listRevision, setListRevision] = useState(0);
  const { hosted, failed: listFailed } = useHostedWorkspaces(props.hosting, phase, listRevision);
  /** What the last backup or removal from the list did, until another starts. */
  const [backupNote, setBackupNote] = useState<{ ok: boolean; text: string } | null>(null);
  const backupFn = props.hosting.backup;
  const forgetFn = props.hosting.forget;
  const restoreFn = props.hosting.restore;

  async function restoreBackup() {
    if (!restoreFn || operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("restoring");
    setBackupNote(null);
    try {
      const restored = await restoreFn();
      if (restored)
        setBackupNote({
          ok: true,
          text: `Restored ${restored.name}. Start it from the list when you are ready.`,
        });
    } catch (reason) {
      const why = reason instanceof Error && reason.message ? ` ${reason.message}` : "";
      setBackupNote({ ok: false, text: `The backup was not restored.${why}` });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function removeMissing(folder: string, name: string) {
    if (!forgetFn || operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("removing");
    setBackupNote(null);
    try {
      await forgetFn(folder);
    } catch (reason) {
      const why = reason instanceof Error && reason.message ? ` ${reason.message}` : "";
      setBackupNote({ ok: false, text: `${name} could not be removed from the list.${why}` });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  async function backUp(folder: string, name: string) {
    if (!backupFn || operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("backing-up");
    setBackupNote(null);
    try {
      const made = await backupFn(folder);
      if (made) setBackupNote({ ok: true, text: `Backed up ${name} to ${made.path}` });
    } catch (reason) {
      const why = reason instanceof Error && reason.message ? ` ${reason.message}` : "";
      setBackupNote({ ok: false, text: `The backup of ${name} did not finish.${why}` });
    } finally {
      setListRevision((n) => n + 1);
      operationPending.current = false;
      setBusy(null);
    }
  }

  const backupStatus = backupNote && (
    <p
      role={backupNote.ok ? "status" : "alert"}
      className={`mb-3 break-words text-sm ${backupNote.ok ? "text-ink-dim" : "text-alert"}`}
    >
      {backupNote.text}
    </p>
  );

  const existing = hosted?.workspaces ?? [];
  const runningEntry = existing.find((w) => w.running);
  const typed = name.trim().toLowerCase();
  const sameName = typed ? existing.find((w) => w.name.trim().toLowerCase() === typed) : undefined;

  function start(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    void launch({ workspaceName: name.trim() });
  }

  async function launch(request: HostingStart) {
    if (operationPending.current || unavailable) return;
    operationPending.current = true;
    setBusy("starting");
    setError(null);
    try {
      const next = await props.hosting.start(request);
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
      status?.publicAddressError ||
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
        message: externallyCarried
          ? "Gatherline could not stop publishing this address. Try again, then stop its external tunnel or proxy separately."
          : "Gatherline’s Cloudflare connection could not be closed cleanly. Try again before quitting Gatherline.",
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

  async function saveAddress() {
    if (operationPending.current || !props.hosting.setPublicAddress || addressDraft === null)
      return;
    operationPending.current = true;
    setBusy("address");
    setAddressError(null);
    try {
      await props.hosting.setPublicAddress(addressDraft.trim());
      setAddressDraft(null);
    } catch (err) {
      // The main process says exactly what is wrong with the address; a
      // rewritten message here would only be vaguer than the real one.
      setAddressError(
        err instanceof Error && err.message
          ? err.message
          : "The address could not be saved. Try again.",
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
              <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                {publicUrl
                  ? `Public link open at ${publicUrl}`
                  : status.openToAll?.phase === "opening"
                    ? "Opening public link"
                    : "Public link closed"}
              </p>
              {tunnelError && (
                <p role="alert" className="mb-2 text-xs text-alert">
                  {tunnelError}
                </p>
              )}
              {publicUrl ? (
                <>
                  <p className="mb-2 text-xs text-ink-dim">
                    {!status.publicAddress
                      ? "This temporary address works from anywhere while Gatherline and cloudflared stay running."
                      : status.publicAddressManaged
                        ? "This configured address stays the same when you reopen the public link. Keep Gatherline and its Cloudflare connector running so teammates can connect."
                        : "This configured address stays the same when you reopen it. Gatherline can stop publishing the address, but only you can stop its external tunnel or proxy and make it unreachable."}
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
                    {busy === "closing"
                      ? externallyCarried
                        ? "Stopping use of address…"
                        : "Closing public link…"
                      : externallyCarried
                        ? "Stop using address"
                        : "Close public link"}
                  </button>
                </>
              ) : (
                <>
                  {status.publicAddress ? (
                    <div className="space-y-2 text-xs text-ink-dim">
                      <p>Open this workspace at your own address, which does not change:</p>
                      <p className="break-all font-mono text-copper">{status.publicAddress}</p>
                      {status.port !== undefined && (
                        <p>
                          {status.publicAddressManaged ? "In Cloudflare, route" : "Send"} this
                          address to{" "}
                          <code className="break-all text-ink">{`http://127.0.0.1:${status.port}`}</code>
                          .
                        </p>
                      )}
                      <p>Keep Gatherline running so teammates can connect.</p>
                      {externallyCarried && (
                        <p>
                          Its external tunnel or proxy may already make this workspace reachable.
                          Gatherline requires invites when you save the address; stop the carrier
                          separately when you want the address itself to become unreachable.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-ink-dim">
                      Create a temporary HTTPS address through Cloudflare Tunnel. No router setup or
                      Cloudflare account is needed.
                    </p>
                  )}
                  {props.hosting.setPublicAddress && (
                    <div className="mt-3 border-t border-edge pt-3">
                      <label
                        htmlFor="public-address"
                        className="block text-xs font-medium text-ink-dim"
                      >
                        Your own address
                      </label>
                      <p id="public-address-help" className="mt-1 text-xs text-ink-dim">
                        Already have a Tailscale Funnel, reverse proxy, or tunnel of your own
                        pointing here? Enter its address to reuse the same link every time. Leave it
                        empty to{" "}
                        {status.publicAddressManaged
                          ? "use the configured Cloudflare address"
                          : "create a temporary address"}
                        .
                      </p>
                      <div className="mt-2 flex gap-2">
                        <input
                          id="public-address"
                          type="url"
                          inputMode="url"
                          spellCheck={false}
                          placeholder="https://box.tail1234.ts.net"
                          value={addressValue}
                          disabled={!!busy || status.publicAddressLocked}
                          aria-describedby={`public-address-help${addressError ? " public-address-error" : ""}`}
                          aria-invalid={!!addressError}
                          aria-errormessage={addressError ? "public-address-error" : undefined}
                          onChange={(event) => {
                            setAddressDraft(event.target.value);
                            setAddressError(null);
                          }}
                          className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2 py-1.5 font-mono text-xs text-ink disabled:opacity-40"
                        />
                        <button
                          type="button"
                          disabled={!!busy || !addressDirty || status.publicAddressLocked}
                          onClick={() => void saveAddress()}
                          className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-dim hover:text-ink disabled:opacity-40"
                        >
                          {busy === "address" ? "Saving…" : "Save"}
                        </button>
                      </div>
                      {status.publicAddressLocked && (
                        <p className="mt-2 text-xs text-ink-dim">
                          This address comes from an environment variable, so it cannot be changed
                          here.
                        </p>
                      )}
                      {addressError && (
                        <p
                          id="public-address-error"
                          role="alert"
                          className="mt-2 text-xs text-alert"
                        >
                          {addressError}
                        </p>
                      )}
                    </div>
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
                          !!status.publicAddressError ||
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
            {backupStatus && <div className="w-full">{backupStatus}</div>}
            {runningEntry && runningEntry.lastBackupAt === null && backupFn && (
              <p className="w-full text-xs text-ink-dim">
                This workspace has not been backed up from this computer yet.
              </p>
            )}
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
            {backupFn && status.folder && (
              <button
                type="button"
                disabled={unavailable}
                className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
                onClick={() => void backUp(status.folder!, status.workspaceName ?? "the workspace")}
              >
                {busy === "backing-up" ? "Backing up…" : "Back up now"}
              </button>
            )}
          </div>
        )
      ) : !loading && !statusError && status ? (
        <>
          <p className="mb-4 text-sm text-ink-dim">
            Your computer becomes the server. Teammates on your network can connect while Gatherline
            is running. Messages, files and accounts are stored on this machine.
          </p>
          {listFailed && (
            <p role="alert" className="mb-4 text-sm text-alert">
              Could not read the list of workspaces hosted on this computer, so none can start.
              Check that Gatherline&rsquo;s settings file can be read, then open this again.
            </p>
          )}
          {backupStatus}
          {existing.length > 0 && (
            <section aria-label="Hosted on this computer" className="mb-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-dim">
                Hosted on this computer
              </h3>
              <ul className="space-y-2">
                {existing.map((w) => (
                  <li
                    key={w.folder}
                    className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">{w.name}</p>
                      <p className="text-xs text-ink-dim">
                        {w.missing
                          ? "Its folder is missing, so it cannot start"
                          : `Port ${w.port}${
                              backupFn
                                ? w.lastBackupAt === null
                                  ? " · Not backed up yet"
                                  : ` · Backed up ${backedUpWhen(w.lastBackupAt)}`
                                : ""
                            }`}
                      </p>
                    </div>
                    {backupFn && !w.missing && (
                      <button
                        type="button"
                        disabled={unavailable}
                        aria-label={`Back up ${w.name}`}
                        onClick={() => void backUp(w.folder, w.name)}
                        className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
                      >
                        Back up
                      </button>
                    )}
                    {w.missing && forgetFn ? (
                      <button
                        type="button"
                        disabled={unavailable}
                        aria-label={`Remove ${w.name} from the list`}
                        onClick={() => void removeMissing(w.folder, w.name)}
                        className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
                      >
                        Remove
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={unavailable || w.missing}
                        aria-label={`Start hosting ${w.name}`}
                        onClick={() => void launch({ folder: w.folder })}
                        className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-sm text-ink hover:border-copper disabled:opacity-40"
                      >
                        Start
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {hosted!.unreadable.length > 0 && (
                <p className="mt-2 text-xs text-ink-dim">
                  Could not read the workspace in{" "}
                  {hosted!.unreadable.length === 1 ? "the folder" : "the folders"}{" "}
                  {hosted!.unreadable.join(", ")}, so it is not listed.
                </p>
              )}
              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-dim">
                New workspace
              </h3>
            </section>
          )}
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
            {sameName && (
              <p className="text-xs text-ink-dim">
                {sameName.name} is already hosted here. Start it from the list to keep its messages;
                this starts a separate, empty workspace.
              </p>
            )}
            <button
              type="submit"
              disabled={!name.trim() || unavailable}
              className={`${primaryBtnCls} w-full`}
            >
              {busy === "starting"
                ? "Starting…"
                : existing.length > 0
                  ? "Start new workspace"
                  : "Start hosting"}
            </button>
          </form>
          {restoreFn && (
            <button
              type="button"
              disabled={unavailable}
              onClick={() => void restoreBackup()}
              className="mt-3 w-full rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim hover:text-ink disabled:opacity-40"
            >
              {busy === "restoring" ? "Restoring…" : "Restore from a backup…"}
            </button>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
