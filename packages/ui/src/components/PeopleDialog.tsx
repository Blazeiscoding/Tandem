import { useEffect, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Dialog } from "./Dialog.js";
import { Avatar } from "./Avatar.js";
import { formatDay } from "../lib/format.js";

type Person = User & { lastSeenAt: number | null };

/**
 * Running the workspace: who has an account, what they can do, and taking that
 * away when someone leaves. Deactivating is the important one — until this
 * existed, a former colleague's token kept working forever.
 */
export function PeopleDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ID | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = () => {
    void client.api
      .listAllUsers()
      .then((r) => setPeople(r.users))
      .catch(() => setError("Could not load the member list."));
  };
  useEffect(load, [client]);

  async function change(
    person: Person,
    patch: { role?: "member" | "admin"; deactivated?: boolean },
  ) {
    setError(null);
    setBusy(person.id);
    try {
      await client.api.updateUserAdmin(person.id, patch);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err.code, err.message) : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  const isOwner = self?.role === "owner";
  const visible = (people ?? []).filter((p) => showInactive || !p.deactivated);
  const inactiveCount = (people ?? []).filter((p) => p.deactivated).length;

  return (
    <Dialog title="People" onClose={onClose} width={560}>
      {error && (
        <p role="alert" className="mb-3 text-[12px] text-alert">
          {error}
        </p>
      )}

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
              className={`flex items-center gap-3 rounded-lg px-2 py-2 ${
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
                <div className="flex shrink-0 items-center gap-1.5">
                  {!person.isBot && !person.deactivated && (
                    <button
                      disabled={busy === person.id}
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
                    disabled={busy === person.id}
                    onClick={() => void change(person, { deactivated: !person.deactivated })}
                    className={`rounded-lg border px-2 py-1 text-[12px] transition-colors disabled:opacity-40 ${
                      person.deactivated
                        ? "border-edge text-ink-dim hover:border-online hover:text-online"
                        : "border-edge text-ink-dim hover:border-alert hover:text-alert"
                    }`}
                  >
                    {person.deactivated ? "Reactivate" : "Deactivate"}
                  </button>
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

      <p className="mt-4 text-[11px] text-ink-faint">
        Deactivating signs someone out everywhere and stops them signing back in. Their messages
        stay where they are, as the rest of the conversation still needs them.
      </p>
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
