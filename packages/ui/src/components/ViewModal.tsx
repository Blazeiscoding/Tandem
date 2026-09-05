import { useState } from "react";
import type { ModalField } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";
import { Mrkdwn } from "./Mrkdwn.js";

/**
 * A form an app asked for. The answers go straight back to that app, so this
 * deliberately looks like part of the app's message rather than part of the
 * workspace: nothing here is stored, and closing it tells the app nothing.
 */
export function ViewModal() {
  const client = useClient();
  const view = useWorkspace((s) => s.modal);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!view) return null;

  const valueOf = (field: ModalField) => values[field.actionId] ?? field.initialValue;

  function close() {
    setValues({});
    setErrors({});
    setMessage(null);
    client.dismissModal();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!view) return;
    setBusy(true);
    setMessage(null);
    // Nested the way the app will read it back: block id, then action id.
    const payload: Record<string, Record<string, string>> = {};
    for (const field of view.fields) {
      payload[field.blockId] = { ...payload[field.blockId], [field.actionId]: valueOf(field) };
    }
    try {
      const result = await client.submitModal(payload);
      if (result.ok) {
        setValues({});
        setErrors({});
      } else {
        setErrors(result.errors ?? {});
        setMessage(result.message ?? null);
      }
    } catch {
      setMessage("That did not go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={view.title} onClose={close} width={520}>
      <form onSubmit={submit}>
        {view.text && (
          <div className="mb-4 text-sm text-ink-dim">
            <Mrkdwn text={view.text} users={users} channels={channels} />
          </div>
        )}

        <div className="space-y-3.5">
          {view.fields.map((field) => (
            <div key={`${field.blockId}.${field.actionId}`}>
              <label
                htmlFor={`${field.blockId}.${field.actionId}`}
                className="mb-1 block text-[13px] font-medium"
              >
                {field.label}
                {field.optional && (
                  <span className="ml-1.5 text-[11px] font-normal text-ink-faint">optional</span>
                )}
              </label>

              {field.type === "select" ? (
                <select
                  id={`${field.blockId}.${field.actionId}`}
                  value={valueOf(field)}
                  onChange={(e) => setValues((v) => ({ ...v, [field.actionId]: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">{field.placeholder || "Choose one…"}</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.text}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  id={`${field.blockId}.${field.actionId}`}
                  value={valueOf(field)}
                  placeholder={field.placeholder}
                  rows={4}
                  onChange={(e) => setValues((v) => ({ ...v, [field.actionId]: e.target.value }))}
                  className={`${inputCls} resize-y`}
                />
              ) : (
                <input
                  id={`${field.blockId}.${field.actionId}`}
                  value={valueOf(field)}
                  placeholder={field.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [field.actionId]: e.target.value }))}
                  className={inputCls}
                />
              )}

              {field.hint && !errors[field.blockId] && (
                <p className="mt-1 text-[11px] text-ink-faint">{field.hint}</p>
              )}
              {errors[field.blockId] && (
                <p role="alert" className="mt-1 text-[11px] text-alert">
                  {errors[field.blockId]}
                </p>
              )}
            </div>
          ))}
        </div>

        {message && (
          <p role="alert" className="mt-3 text-[12px] text-alert">
            {message}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
          >
            {view.closeLabel}
          </button>
          <button type="submit" disabled={busy} className={primaryBtnCls}>
            {busy ? "Sending…" : view.submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
