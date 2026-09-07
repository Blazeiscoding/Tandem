import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { accountError, deviceLabel } from "../lib/account.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

const button =
  "rounded-lg border border-edge px-3 py-2 text-sm text-ink-dim hover:bg-lifted hover:text-ink disabled:opacity-40";
type Confirmation =
  { kind: "device"; session: SessionInfo } | { kind: "others" } | { kind: "signout" };

export function AccountDialog({
  onClose,
  onSignedOut,
}: {
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const alive = useRef(true);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (confirmation) {
      confirmationPanel.current?.focus();
      confirmationPanel.current?.scrollIntoView({ block: "nearest" });
    }
  }, [confirmation]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await client.api.listSessions();
      if (alive.current) setSessions(result.sessions);
    } catch (err) {
      if (alive.current) setLoadError(accountError(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (newPassword !== repeatPassword) {
      setError("The new passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a different password from your current one.");
      return;
    }
    setBusy(true);
    try {
      await client.api.changePassword(currentPassword, newPassword);
      if (!alive.current) return;
      setCurrentPassword("");
      setNewPassword("");
      setRepeatPassword("");
      setNotice(
        "Password changed. Your other devices have been signed out; this device stays signed in.",
      );
      await load();
    } catch (err) {
      if (alive.current) setError(accountError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (confirmation.kind === "signout") {
        await client.api.logout();
        onSignedOut();
        return;
      }
      if (confirmation.kind === "device") await client.api.revokeSession(confirmation.session.id);
      else await client.api.revokeOtherSessions();
      if (!alive.current) return;
      setNotice(
        confirmation.kind === "device"
          ? "That device has been signed out."
          : "Your other devices have been signed out.",
      );
      setConfirmation(null);
      await load();
    } catch (err) {
      if (alive.current) setError(accountError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const otherSessions = sessions.filter((session) => !session.current);
  return (
    <Dialog title="Account settings" onClose={onClose} width={620}>
      <p className="mb-5 text-sm text-ink-dim">
        Signed in as <span className="font-medium text-ink">{self?.displayName}</span> · @
        {self?.handle}
      </p>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-alert/30 bg-alert/10 p-3 text-sm text-alert"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-online/30 bg-online/10 p-3 text-sm text-online"
        >
          {notice}
        </p>
      )}
      <section aria-labelledby="account-password-title">
        <h3 id="account-password-title" className="font-semibold">
          Change password
        </h3>
        <p className="mb-3 mt-1 text-sm text-ink-dim">
          Changing your password signs out your other devices.
        </p>
        <form onSubmit={(event) => void changePassword(event)}>
          <fieldset disabled={busy || confirmation !== null} className="space-y-3">
            <label className="block text-sm">
              Current password
              <input
                className={`${inputCls} mt-1`}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                maxLength={256}
              />
            </label>
            <label className="block text-sm">
              New password
              <input
                className={`${inputCls} mt-1`}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                maxLength={256}
                aria-describedby="account-password-hint"
              />
            </label>
            <p id="account-password-hint" className="text-xs text-ink-faint">
              Use at least 8 characters. A long, unique password is best.
            </p>
            <label className="block text-sm">
              Confirm new password
              <input
                className={`${inputCls} mt-1`}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={repeatPassword}
                onChange={(e) => setRepeatPassword(e.target.value)}
                required
                minLength={8}
                maxLength={256}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-dim">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(e) => setShowPassword(e.target.checked)}
              />
              Show passwords
            </label>
            <button className={primaryBtnCls} type="submit">
              {busy && !confirmation ? "Saving…" : "Update password"}
            </button>
          </fieldset>
        </form>
      </section>

      <section aria-labelledby="account-devices-title" className="mt-6 border-t border-edge pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 id="account-devices-title" className="font-semibold">
            Signed-in devices
          </h3>
          <button className={button} disabled={busy || loading} onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <p className="mt-1 text-sm text-ink-dim">
          Each sign-in appears separately. Remove a device you no longer use.
        </p>
        {loadError && (
          <p role="alert" className="mt-3 text-sm text-alert">
            {loadError}
          </p>
        )}
        {loading && (
          <p role="status" className="mt-3 text-sm text-ink-faint">
            Loading devices…
          </p>
        )}
        {!loading && !loadError && sessions.length === 0 && (
          <p className="mt-3 text-sm text-ink-dim">
            No active devices were returned. Refresh to check your session.
          </p>
        )}
        <ul className="mt-3 divide-y divide-edge" aria-busy={loading}>
          {sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {deviceLabel(session.userAgent)}{" "}
                  {session.current && <span className="ml-1 text-xs text-online">This device</span>}
                </p>
                <p className="mt-1 text-xs text-ink-faint">
                  Last active {new Date(session.lastSeenAt).toLocaleString()}
                </p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  Signed in {new Date(session.createdAt).toLocaleString()}
                </p>
              </div>
              {!session.current && (
                <button
                  className={button}
                  disabled={busy || confirmation !== null}
                  aria-label={`Sign out ${deviceLabel(session.userAgent)}, signed in ${new Date(session.createdAt).toLocaleString()}`}
                  onClick={() => {
                    setConfirmation({ kind: "device", session });
                    setError(null);
                  }}
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
        {otherSessions.length > 0 && (
          <button
            className={`${button} mt-3`}
            disabled={busy || confirmation !== null}
            onClick={() => {
              setConfirmation({ kind: "others" });
              setError(null);
            }}
          >
            Sign out all other devices
          </button>
        )}
      </section>

      <div className="mt-5 border-t border-edge pt-4">
        <button
          className={button}
          disabled={busy || confirmation !== null}
          onClick={() => {
            setConfirmation({ kind: "signout" });
            setError(null);
          }}
        >
          Sign out of this workspace
        </button>
        <p className="mt-2 text-xs text-ink-faint">
          Switching workspaces keeps you signed in. Signing out removes this device's saved sign-in.
        </p>
      </div>
      {confirmation && (
        <section
          ref={confirmationPanel}
          tabIndex={-1}
          aria-label="Confirm sign out"
          className="mt-4 rounded-xl border border-alert/40 bg-ground p-4"
        >
          <h3 className="font-semibold">
            {confirmation.kind === "signout"
              ? "Sign out of this workspace?"
              : confirmation.kind === "others"
                ? "Sign out your other devices?"
                : `Sign out ${deviceLabel(confirmation.session.userAgent)}?`}
          </h3>
          <p className="mt-2 text-sm text-ink-dim">
            {confirmation.kind === "signout"
              ? "You will need your password to sign in again. Your account's saved drafts stay on this device."
              : "Affected devices will need to sign in again. Your current device stays connected."}
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button className={button} disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel
            </button>
            <button className={primaryBtnCls} disabled={busy} onClick={() => void confirm()}>
              {busy ? "Signing out…" : "Confirm sign out"}
            </button>
          </div>
        </section>
      )}
    </Dialog>
  );
}
