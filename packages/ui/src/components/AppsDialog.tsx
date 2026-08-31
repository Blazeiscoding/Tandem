import { useCallback, useEffect, useState } from "react";
import type { App, ID, Webhook } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

type AppWithHooks = App & { webhooks: Webhook[] };

/** A secret shown once, with a copy button — it cannot be retrieved later. */
function SecretRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-copper/40 bg-copper/10 p-2.5">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-copper">
        {label} · shown once
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{value}</code>
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

/** Admin view for integrations: bot tokens and incoming webhooks. */
export function AppsDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const [apps, setApps] = useState<AppWithHooks[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /** Secrets from this session only; the server never returns them again. */
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
    <Dialog title="Apps and integrations" onClose={onClose} width={560}>
      <p className="mb-4 text-sm text-ink-dim">
        Each app posts as its own bot user. Tokens work with Slack&rsquo;s{" "}
        <code className="font-mono text-copper">chat.postMessage</code>, and webhooks accept the
        same payloads Slack does, so most existing integrations work by changing the URL.
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

      {apps === null && <p className="py-4 text-center font-mono text-xs text-ink-faint">loading…</p>}
      {apps?.length === 0 && (
        <p className="py-4 text-center text-sm text-ink-faint">No apps yet.</p>
      )}

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
                }}
                className="ml-auto rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-alert"
              >
                Delete
              </button>
            </div>

            {secrets[a.id] && <SecretRow label="Bot token" value={secrets[a.id]!} />}

            <ul className="mt-2 space-y-1.5">
              {a.webhooks.map((w) => (
                <li key={w.id} className="text-[12px]">
                  <div className="flex items-center gap-2 text-ink-dim">
                    <span className="text-copper">
                      #{channels[w.channelId]?.name ?? "unknown"}
                    </span>
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
                  {hookUrls[w.id] && <SecretRow label="Webhook URL" value={hookUrls[w.id]!} />}
                </li>
              ))}
            </ul>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                Add webhook to
              </span>
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
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
