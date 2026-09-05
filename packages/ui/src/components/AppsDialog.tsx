import { useCallback, useEffect, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { ApiError, type AppDetail } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

/** A secret with a copy button. Bot tokens are shown once; others can be re-read. */
function SecretRow({ label, value, once }: { label: string; value: string; once?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-copper/40 bg-copper/10 p-2.5">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-copper">
        {label}
        {once && " · shown once"}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {once || shown ? value : "•".repeat(24)}
        </code>
        {!once && (
          <button
            onClick={() => setShown((v) => !v)}
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-dim hover:bg-lifted hover:text-ink"
          >
            {shown ? "Hide" : "Reveal"}
          </button>
        )}
        <button
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-dim hover:bg-lifted hover:text-ink"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 mt-3 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
      {children}
    </div>
  );
}

/** Admin view for integrations: bot tokens, webhooks, commands and events. */
export function AppsDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const [apps, setApps] = useState<AppDetail[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /** Bot tokens from this session only; the server never returns them again. */
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [hookUrls, setHookUrls] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    client.api
      .listApps()
      .then((r) => setApps(r.apps))
      .catch(() => setApps([]));
  }, [client]);

  useEffect(load, [load]);

  const rooms = Object.values(channels).filter(
    (c) => (c.type === "public" || c.type === "private") && !c.archived,
  );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await client.api.createApp({ name: name.trim() });
      setSecrets((s) => ({ ...s, [r.app.id]: r.token }));
      setName("");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function addWebhook(appId: ID, channelId: ID) {
    const r = await client.api.createWebhook(appId, { channelId });
    // The path comes back relative; show the address a tool would actually call.
    setHookUrls((h) => ({ ...h, [r.webhook.id]: `${client.baseUrl}${r.url}` }));
    load();
  }

  return (
    <Dialog title="Apps and integrations" onClose={onClose} width={620}>
      <p className="mb-4 text-sm text-ink-dim">
        Each app posts as its own bot user. Tokens work with Slack&rsquo;s{" "}
        <code className="font-mono text-copper">chat.postMessage</code>, webhooks and slash commands
        speak Slack&rsquo;s shapes, and events arrive signed the way Slack signs them &mdash; so most
        existing integrations work by changing the URL.
      </p>

      <form onSubmit={create} className="mb-5 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="App name, e.g. Deploy Bot"
          className={inputCls}
        />
        <button type="submit" disabled={busy || !name.trim()} className={primaryBtnCls}>
          Create
        </button>
      </form>

      {apps === null && (
        <p className="py-4 text-center font-mono text-xs text-ink-faint">loading…</p>
      )}
      {apps?.length === 0 && <p className="py-4 text-center text-sm text-ink-faint">No apps yet.</p>}

      <ul className="space-y-3">
        {(apps ?? []).map((a) => (
          <li key={a.id} className="rounded-xl border border-edge bg-ground p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{a.name}</span>
              <button
                onClick={async () => {
                  if (!confirm(`Delete ${a.name}? Its tokens and webhooks stop working.`)) return;
                  await client.api.deleteApp(a.id);
                  load();
                  void client.loadCommands();
                }}
                className="ml-auto rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-alert"
              >
                Delete
              </button>
            </div>

            {secrets[a.id] && <SecretRow label="Bot token" value={secrets[a.id]!} once />}
            <SecretRow label="Signing secret" value={a.signingSecret} />

            <SectionLabel>Incoming webhooks</SectionLabel>
            <ul className="space-y-1.5">
              {a.webhooks.map((w) => (
                <li key={w.id} className="text-[12px]">
                  <div className="flex items-center gap-2 text-ink-dim">
                    <span className="text-copper">#{channels[w.channelId]?.name ?? "unknown"}</span>
                    <button
                      onClick={async () => {
                        await client.api.deleteWebhook(w.id);
                        load();
                      }}
                      className="ml-auto text-ink-faint hover:text-alert"
                    >
                      Remove
                    </button>
                  </div>
                  {hookUrls[w.id] && <SecretRow label="Webhook URL" value={hookUrls[w.id]!} once />}
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-ink-faint">Add to</span>
              {rooms.map((c) => (
                <button
                  key={c.id}
                  onClick={() => void addWebhook(a.id, c.id)}
                  className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-ink-dim transition-colors hover:border-copper hover:text-ink"
                >
                  #{c.name}
                </button>
              ))}
            </div>

            <SectionLabel>Slash commands</SectionLabel>
            <CommandList app={a} onChanged={load} />

            <SectionLabel>Event subscriptions</SectionLabel>
            <SubscriptionList app={a} onChanged={load} />

            <SectionLabel>Interactivity</SectionLabel>
            <InteractivityUrl app={a} onChanged={load} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

const smallInput =
  "min-w-0 rounded-lg border border-edge bg-raised px-2 py-1 text-[12px] outline-none focus:border-copper/60";

function CommandList({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.api.createCommand(app.id, {
        command: command.trim(),
        url: url.trim(),
        description: description.trim(),
      });
      setCommand("");
      setUrl("");
      setDescription("");
      onChanged();
      // The composer's hint list is loaded once, so refresh it now.
      void client.loadCommands();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : "could not add that command");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ul className="space-y-1">
        {app.commands.map((c) => (
          <li key={c.id} className="flex items-baseline gap-2 text-[12px]">
            <span className="font-mono text-copper">/{c.command}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
              {c.url}
            </span>
            <button
              onClick={async () => {
                await client.api.deleteCommand(c.id);
                onChanged();
                void client.loadCommands();
              }}
              className="text-ink-faint hover:text-alert"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-1.5 flex flex-wrap gap-1.5">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="/deploy"
          className={`${smallInput} w-24`}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bot.example.com/deploy"
          className={`${smallInput} flex-1`}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What it does"
          className={`${smallInput} w-32`}
        />
        <button
          type="submit"
          disabled={busy || !command.trim() || !url.trim()}
          className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-copper hover:text-ink disabled:opacity-40"
        >
          Add
        </button>
      </form>
      {error && <p className="mt-1 text-[11px] text-alert">{error}</p>}
    </>
  );
}

/** Native event names, so the picker does not need the server to list them. */
const EVENT_TYPES = [
  "message.created",
  "message.updated",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "member.joined",
  "channel.created",
];

function SubscriptionList({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.api.createSubscription(app.id, { url: url.trim(), eventTypes: types });
      setUrl("");
      setTypes([]);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : "could not subscribe");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ul className="space-y-1">
        {app.subscriptions.map((sub) => (
          <li key={sub.id} className="flex items-baseline gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
              {sub.url}
            </span>
            <span className="shrink-0 text-[11px] text-ink-dim">
              {sub.eventTypes.length > 0 ? `${sub.eventTypes.length} types` : "everything"}
            </span>
            <button
              onClick={async () => {
                await client.api.deleteSubscription(sub.id);
                onChanged();
              }}
              className="text-ink-faint hover:text-alert"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-1.5">
        <div className="flex gap-1.5">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://bot.example.com/events"
            className={`${smallInput} flex-1`}
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-copper hover:text-ink disabled:opacity-40"
          >
            {busy ? "Verifying…" : "Subscribe"}
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {EVENT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() =>
                setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
              }
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                types.includes(t)
                  ? "border-copper text-copper"
                  : "border-edge text-ink-faint hover:text-ink"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">
          None selected sends everything. The URL must answer the{" "}
          <code className="font-mono">url_verification</code> challenge, and the app&rsquo;s bot only
          receives events from channels it has been added to.
        </p>
      </form>
      {error && <p className="mt-1 text-[11px] text-alert">{error}</p>}
    </>
  );
}

/**
 * Where this app's button clicks go. One URL per app, like Slack's
 * interactivity request URL, and it has to answer the same verification
 * handshake a subscription does before it is accepted.
 */
function InteractivityUrl({ app, onChanged }: { app: AppDetail; onChanged: () => void }) {
  const client = useClient();
  const [url, setUrl] = useState(app.interactivityUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.api.setInteractivityUrl(app.id, url.trim());
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : "could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="flex gap-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bot.example.com/interactions"
          className={`${smallInput} flex-1`}
        />
        <button
          type="submit"
          disabled={busy || url.trim() === app.interactivityUrl}
          className="rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:border-copper hover:text-ink disabled:opacity-40"
        >
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">
        Buttons in this app&apos;s messages post Slack&apos;s{" "}
        <code className="font-mono">block_actions</code> payload here. Leave empty to turn them off.
      </p>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-alert">
          {error}
        </p>
      )}
    </form>
  );
}
