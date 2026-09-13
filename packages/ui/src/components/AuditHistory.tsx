import { useState } from "react";
import type { AuditEntry, ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { formatDay, formatTime } from "../lib/format.js";

/**
 * One entry as a sentence an administrator would say. Names are looked up at
 * the moment of reading, so a renamed person reads under their current name;
 * the record itself keeps only ids.
 */
export function describeAuditEntry(
  entry: AuditEntry,
  users: Record<ID, User>,
  selfId: ID | undefined,
): string {
  const name = (id: string | null | undefined, fallback: string) =>
    !id ? fallback : id === selfId ? "you" : (users[id]?.displayName ?? fallback);
  const actor = entry.actorId === null ? "The host" : capitalise(name(entry.actorId, "Someone"));
  const target = name(entry.targetId, "an account");
  const app = typeof entry.details.name === "string" ? entry.details.name : "an app";
  const d = entry.details;
  // Each detail read defensively: an entry written by a newer server, or one
  // missing a field, should read as a shorter sentence rather than "undefined".
  const has = (key: string) => typeof d[key] === "string" || typeof d[key] === "number";
  const at = (key: string, before: string) => (has(key) ? `${before}${d[key]}` : "");

  switch (entry.action) {
    case "user.role_changed":
      return has("from") && has("to")
        ? `${actor} changed ${possessive(target)} role from ${d.from} to ${d.to}`
        : `${actor} changed ${possessive(target)} role`;
    case "user.deactivated":
      return `${actor} deactivated ${target}`;
    case "user.reactivated":
      return `${actor} reactivated ${target}`;
    case "user.password_reset":
      return `${actor} reset ${possessive(target)} password`;
    case "user.invite_permission_granted":
      return `${actor} allowed ${target} to create invite codes`;
    case "user.invite_permission_removed":
      return `${actor} stopped ${target} creating invite codes`;
    case "account.recovered":
      return `The host recovered ${possessive(target)} account from the server's command line${
        d.madeOwner ? " and made them the owner" : ""
      }`;
    case "workspace.ownership_transferred":
      return `${actor} handed the workspace over to ${target}`;
    case "app.created":
      return `${actor} created the app ${app}`;
    case "app.deleted":
      return `${actor} deleted the app ${app}`;
    case "app.token_replaced":
      return `${actor} replaced ${possessive(app)} bot token`;
    case "app.signing_secret_replaced":
      return `${actor} replaced ${possessive(app)} signing secret`;
    case "app.interactivity_url_changed":
      return d.cleared
        ? `${actor} turned off ${possessive(app)} buttons and forms`
        : `${actor} changed where ${possessive(app)} buttons and forms go${at("host", ", to ")}`;
    case "webhook.created":
      return `${actor} added a webhook for ${app}`;
    case "webhook.url_replaced":
      return `${actor} replaced a webhook URL for ${app}`;
    case "webhook.deleted":
      return `${actor} removed a webhook from ${app}`;
    case "command.created":
      return `${actor} added ${has("command") ? d.command : "a command"} to ${app}${at("host", ", calling ")}`;
    case "command.deleted":
      return `${actor} removed ${typeof d.command === "string" ? d.command : "a command"} from ${app}`;
    case "subscription.created":
      return `${actor} started sending events to ${app}${at("host", " at ")}`;
    case "subscription.retried":
      return has("retried")
        ? `${actor} retried ${d.retried} failed ${d.retried === 1 ? "delivery" : "deliveries"} for ${app}`
        : `${actor} retried failed deliveries for ${app}`;
    case "subscription.deleted":
      return `${actor} stopped sending events to ${app}${at("host", " at ")}`;
    case "invite.created":
      return `${actor} created an invite code`;
    case "invite.revoked":
      return `${actor} revoked an invite code`;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function possessive(text: string): string {
  if (text === "you") return "your";
  return text.endsWith("s") ? `${text}'` : `${text}'s`;
}

/**
 * What administrators have changed, for a workspace that has to be able to say
 * who deactivated someone or replaced an app's token. Closed until asked for:
 * it is something looked up, not something to read every time.
 */
export function AuditHistory() {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function load(before?: string) {
    setBusy(true);
    setError(false);
    try {
      const page = await client.api.listAudit(before);
      setEntries((current) => (before && current ? [...current, ...page.entries] : page.entries));
      setCursor(page.nextCursor);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true);
          void load();
        }}
        className="mt-3 text-[12px] text-ink-faint underline transition-colors hover:text-ink"
      >
        Show recent changes
      </button>
    );
  }

  return (
    <section className="mt-4" aria-label="Recent changes">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        Recent changes
      </div>
      {entries?.length === 0 && (
        <p className="text-sm text-ink-faint">Nothing has been changed yet.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="max-h-64 space-y-1 overflow-y-auto text-[13px]">
          {entries.map((entry) => (
            <li key={entry.id} className="flex gap-3 rounded px-1 py-1">
              <span className="min-w-0 flex-1 text-ink-dim">
                {describeAuditEntry(entry, users, selfId)}
              </span>
              <time
                dateTime={new Date(entry.at).toISOString()}
                className="shrink-0 text-[11px] text-ink-faint"
              >
                {formatDay(entry.at)} {formatTime(entry.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-alert">
          Could not load recent changes. Try again.
        </p>
      )}
      <div className="mt-2 flex gap-3">
        {(cursor || error) && (
          <button
            disabled={busy}
            onClick={() => void load(error && !entries ? undefined : (cursor ?? undefined))}
            className="text-[12px] text-ink-faint underline transition-colors hover:text-ink disabled:opacity-40"
          >
            {error ? "Try again" : "Show older changes"}
          </button>
        )}
        {busy && <span className="text-[12px] text-ink-faint">Loading…</span>}
      </div>
    </section>
  );
}
