import { useCallback, useEffect, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";
import { Avatar } from "./Avatar.js";
import { formatDay } from "../lib/format.js";
import { accountError } from "../lib/account.js";
import { useCopy } from "../lib/useCopy.js";
import { AuditHistory } from "./AuditHistory.js";

type Person = User & { lastSeenAt: number | null };

/**
 * Running the workspace: who has an account, what they can do, and taking that
 * away when someone leaves. Deactivating is the important one — until this
 * existed, a former colleague's token kept working forever.
 */
export function PeopleDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const liveUsers = useWorkspace((s) => s.users);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ID | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: "reset" | "transfer"; person: Person } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [issued, setIssued] = useState<{ person: Person; password: string } | null>(null);
  const [reveal, setReveal] = useState(false);
  const alive = useRef(true);
  const actionPanel = useRef<HTMLDivElement>(null);
  const clipboard = useCopy();
  const isAdmin = self?.role === "owner" || self?.role === "admin";

  const load = useCallback(async () => {
    try {
      const result = await client.api.listAllUsers();
      if (alive.current) setPeople(result.users);
    } catch {
      if (alive.current) setError("Could not load the member list. Try refreshing.");
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (action || issued) actionPanel.current?.focus();
  }, [action, issued]);

  async function change(
    person: Person,
    patch: { role?: "member" | "admin"; deactivated?: boolean },
  ) {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(person.id);
    try {
      await client.api.updateUserAdmin(person.id, patch);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err.code, err.message) : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmAction(event: React.FormEvent) {
    event.preventDefault();
    if (!action || busy) return;
    if (action.kind === "transfer" && confirmation !== action.person.handle) return;
    setBusy(action.person.id);
    setError(null);
    setNotice(null);
    try {
      if (action.kind === "reset") {
        const result = await client.api.resetPassword(action.person.id);
        if (!alive.current) return;
        setIssued({ person: action.person, password: result.temporaryPassword });
        setReveal(false);
      } else {
        const result = await client.api.transferOwnership(action.person.id);
        if (!alive.current) return;
        client.store.setState((state) => ({
          users: {
            ...state.users,
            [result.owner.id]: result.owner,
            [result.previousOwner.id]: result.previousOwner,
          },
          self: state.self?.id === result.previousOwner.id ? result.previousOwner : state.self,
        }));
        setNotice(
          `${action.person.displayName} now owns this workspace. You are an administrator.`,
        );
      }
      setAction(null);
      setConfirmation("");
      await load();
    } catch (err) {
      if (alive.current) setError(accountError(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  function beginAction(kind: "reset" | "transfer", person: Person) {
    setAction({ kind, person });
    setConfirmation("");
    setError(null);
    setNotice(null);
  }

  const isOwner = self?.role === "owner";
  const currentPeople = (people ?? []).map((person) => ({ ...person, ...liveUsers[person.id] }));
  const visible = currentPeople.filter((p) => showInactive || !p.deactivated);
  const inactiveCount = currentPeople.filter((p) => p.deactivated).length;
  const secondaryBtn =
    "rounded-lg border border-edge px-3 py-2 text-sm text-ink-dim hover:bg-lifted hover:text-ink disabled:opacity-40";

  if (!isAdmin)
    return (
      <Dialog title="People" onClose={onClose}>
        <p className="text-sm text-ink-dim">
          Only workspace owners and administrators can manage accounts.
        </p>
      </Dialog>
    );

  return (
    <Dialog title="People" onClose={onClose} width={680} dismissible={!busy}>
      {error && (
        <p role="alert" className="mb-3 text-[12px] text-alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 rounded-lg bg-online/10 p-3 text-sm text-online">
          {notice}
        </p>
      )}

      {issued ? (
        <div ref={actionPanel} tabIndex={-1} className="outline-none">
          <h3 className="font-semibold">Password reset for {issued.person.displayName}</h3>
          <p className="mt-2 text-sm text-ink-dim">
            All of @{issued.person.handle}'s devices are signed out. Share this temporary password
            privately and ask them to change it in Account settings after signing in.
          </p>
          <label className="mt-4 block text-sm">
            Temporary password
            <input
              className={`${inputCls} mt-1 font-mono`}
              value={issued.password}
              readOnly
              type={reveal ? "text" : "password"}
              autoComplete="off"
              onFocus={(event) => event.target.select()}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={secondaryBtn} onClick={() => setReveal((value) => !value)}>
              {reveal ? "Hide password" : "Show password"}
            </button>
            <button
              className={secondaryBtn}
              onClick={() => void clipboard.copy(issued.password, issued.password)}
            >
              {clipboard.label(
                "Copy password",
                "Copied",
                "Copy failed — select and copy manually",
                issued.password,
              )}
            </button>
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            This password will no longer be visible after you dismiss this screen. It is not saved
            on this device.
          </p>
          <button
            className={`${primaryBtnCls} mt-5`}
            disabled={!!busy}
            onClick={() => {
              setIssued(null);
              setReveal(false);
            }}
          >
            Done
          </button>
        </div>
      ) : action ? (
        <div ref={actionPanel} tabIndex={-1} className="outline-none">
          <h3 className="font-semibold">
            {action.kind === "reset"
              ? `Reset ${action.person.displayName}'s password?`
              : `Transfer ownership to ${action.person.displayName}?`}
          </h3>
          <p className="mt-2 text-sm text-ink-dim">
            {action.kind === "reset"
              ? `This replaces @${action.person.handle}'s password and signs out all their devices. A temporary password will appear here for you to share privately.`
              : `@${action.person.handle} will become the workspace owner. You will remain an administrator. Only the new owner will be able to transfer ownership again.`}
          </p>
          <form onSubmit={(event) => void confirmAction(event)}>
            {action.kind === "transfer" && (
              <label className="mt-4 block text-sm">
                Type {action.person.handle} to confirm
                <input
                  className={`${inputCls} mt-1`}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!!busy}
                  required
                />
              </label>
            )}
            {busy && (
              <p role="status" className="mt-3 text-sm text-ink-dim">
                Saving the change. Keep this window open…
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                className={secondaryBtn}
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setAction(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button
                className={primaryBtnCls}
                type="submit"
                disabled={
                  !!busy || (action.kind === "transfer" && confirmation !== action.person.handle)
                }
              >
                {busy
                  ? "Saving…"
                  : action.kind === "reset"
                    ? "Reset password"
                    : "Transfer ownership"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-ink-dim">Manage workspace access and account recovery.</p>
            <button
              className={secondaryBtn}
              disabled={!!busy}
              onClick={() => {
                setError(null);
                void load();
              }}
            >
              Refresh
            </button>
          </div>

          <ul className="space-y-1">
            {visible.map((person) => {
              // The rules the server enforces, said out loud so the buttons that
              // would be refused are simply not offered.
              const protectedTarget =
                person.id === self?.id ||
                person.role === "owner" ||
                (person.role === "admin" && !isOwner);
              return (
                <li
                  key={person.id}
                  className={`flex flex-wrap items-center gap-3 rounded-lg px-2 py-2 ${
                    person.deactivated ? "opacity-50" : ""
                  }`}
                >
                  <Avatar user={person} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{person.displayName}</span>
                      <span className="truncate font-mono text-[11px] text-ink-faint">
                        @{person.handle}
                      </span>
                      {person.isBot && (
                        <span className="rounded bg-lifted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                          app
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-faint">
                      {person.deactivated
                        ? "Deactivated"
                        : person.role === "owner"
                          ? "Owner"
                          : person.role === "admin"
                            ? "Admin"
                            : "Member"}
                      {person.lastSeenAt && !person.deactivated && (
                        <> · last seen {formatDay(person.lastSeenAt)}</>
                      )}
                    </div>
                  </div>

                  {!protectedTarget && (
                    <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
                      {!person.isBot && !person.deactivated && (
                        <button
                          disabled={!!busy}
                          onClick={() =>
                            void change(person, {
                              role: person.role === "admin" ? "member" : "admin",
                            })
                          }
                          className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-copper hover:text-ink disabled:opacity-40"
                        >
                          {person.role === "admin" ? "Make member" : "Make admin"}
                        </button>
                      )}
                      <button
                        disabled={!!busy}
                        onClick={() => void change(person, { deactivated: !person.deactivated })}
                        className={`rounded-lg border px-2 py-1 text-[12px] transition-colors disabled:opacity-40 ${
                          person.deactivated
                            ? "border-edge text-ink-dim hover:border-online hover:text-online"
                            : "border-edge text-ink-dim hover:border-alert hover:text-alert"
                        }`}
                      >
                        {person.deactivated ? "Reactivate" : "Deactivate"}
                      </button>
                      {!person.isBot && !person.deactivated && (
                        <>
                          <button
                            className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim hover:border-copper hover:text-ink disabled:opacity-40"
                            disabled={!!busy}
                            onClick={() => beginAction("reset", person)}
                          >
                            Reset password
                          </button>
                          {isOwner && (
                            <button
                              className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim hover:border-copper hover:text-ink disabled:opacity-40"
                              disabled={!!busy}
                              onClick={() => beginAction("transfer", person)}
                            >
                              Transfer ownership
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {people === null && <p className="text-sm text-ink-faint">Loading…</p>}

          {inactiveCount > 0 && (
            <button
              onClick={() => setShowInactive((v) => !v)}
              className="mt-3 text-[12px] text-ink-faint underline transition-colors hover:text-ink"
            >
              {showInactive
                ? "Hide deactivated"
                : `Show ${inactiveCount} deactivated ${inactiveCount === 1 ? "account" : "accounts"}`}
            </button>
          )}

          <div>
            <AuditHistory />
          </div>

          <p className="mt-4 text-[11px] text-ink-faint">
            Deactivating signs someone out everywhere and stops them signing back in. Their messages
            stay where they are, as the rest of the conversation still needs them.
          </p>
        </>
      )}
    </Dialog>
  );
}

/**
 * The server's error codes, in words someone running a workspace would use.
 * An ApiError's message falls back to the raw code, so anything unrecognised
 * is only worth showing when the server actually wrote a sentence.
 */
function errorText(code: string, message?: string): string {
  switch (code) {
    case "owner_is_protected":
      return "The owner's account cannot be changed here.";
    case "admins_are_equals":
      return "Only the owner can change another admin.";
    case "cannot_change_self":
      return "You cannot change your own account.";
    case "user_not_found":
      return "That account is gone. Reopen this list.";
    case "bots_have_no_role":
      return "An app has no role to change.";
    case "admin_only":
      return "You do not have permission to do that.";
    default:
      return message && message !== code ? message : "That did not work.";
  }
}
