import { useEffect, useRef, useState } from "react";
import type { Message } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import {
  FormattingToolbar,
  formatText,
  formattingShortcut,
  MESSAGE_LIMIT,
} from "./FormattingToolbar.js";
import { Mrkdwn } from "./Mrkdwn.js";

export function MessageEditor({ message, onClose }: { message: Message; onClose: () => void }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const draftKey = `${message.channelId}:edit:${message.id}`;
  const savedDraft = useWorkspace((s) => s.drafts[draftKey]);
  const [draft, setDraft] = useState(() => client.state.drafts[draftKey] ?? message.text);
  const [baseline, setBaseline] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const saving = useRef(false);
  const touched = useRef(false);
  const changedElsewhere = message.text !== baseline;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!touched.current && savedDraft !== undefined) setDraft(savedDraft);
  }, [savedDraft]);

  function change(text: string) {
    touched.current = true;
    setDraft(text);
    client.setDraft(draftKey, text);
  }

  function select(text: string, start: number, end = start) {
    change(text);
    requestAnimationFrame(() => {
      if (!alive.current) return;
      box.current?.focus();
      box.current?.setSelectionRange(start, end);
    });
  }

  function format(marker: string, placeholder: string, block = false) {
    if (!box.current || saving.current) return;
    const next = formatText(
      draft,
      box.current.selectionStart,
      box.current.selectionEnd,
      marker,
      placeholder,
      block,
    );
    select(next.text, next.selectionStart, next.selectionEnd);
  }

  function cancel() {
    if (saving.current) return;
    client.setDraft(draftKey, "");
    onClose();
  }

  async function save() {
    if (saving.current || !draft.trim() || draft.length > MESSAGE_LIMIT) return;
    if (draft.trim() === message.text) {
      cancel();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    client.setDraft(draftKey, draft);
    try {
      await client.api.editMessage(message.id, draft.trim());
      if (!alive.current) return;
      client.setDraft(draftKey, "");
      onClose();
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof ApiError && failure.status === 404
            ? "This message is no longer available. Your unsaved edit is kept."
            : "Could not save this edit. Your text is kept; try again when connected.",
        );
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="mt-1">
      {changedElsewhere && (
        <div role="status" className="mb-2 text-xs text-ink-dim">
          This message changed while you were editing.{" "}
          <button
            disabled={busy}
            className="text-copper underline"
            onClick={() => {
              change(message.text);
              setBaseline(message.text);
              setError(null);
            }}
          >
            Use the current message
          </button>
          , or save your version below.
        </div>
      )}
      <fieldset
        disabled={busy}
        className="min-w-0 overflow-hidden rounded-lg border border-copper/60 bg-ground"
      >
        <FormattingToolbar
          onFormat={format}
          onInsert={(emoji) => {
            const start = box.current?.selectionStart ?? draft.length;
            const end = box.current?.selectionEnd ?? start;
            select(draft.slice(0, start) + emoji + draft.slice(end), start + emoji.length);
          }}
          preview={preview}
          onTogglePreview={() => setPreview((v) => !v)}
        />
        {preview && (
          <div
            aria-label="Edit preview"
            className="max-h-36 overflow-y-auto border-b border-edge px-3 py-2 text-sm"
          >
            <Mrkdwn text={draft} users={users} channels={channels} selfId={client.state.self?.id} />
          </div>
        )}
        <textarea
          ref={box}
          value={draft}
          autoFocus
          aria-label="Edit message"
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey) {
              const marker = formattingShortcut(e.key);
              if (marker) {
                e.preventDefault();
                format(marker, "text");
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!changedElsewhere) void save();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          className="block max-h-64 w-full resize-y bg-transparent px-3 py-2 text-[15px] outline-none"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-2 text-xs">
          <span className={draft.length > MESSAGE_LIMIT ? "text-alert" : "text-ink-faint"}>
            {draft.length.toLocaleString()} / {MESSAGE_LIMIT.toLocaleString()}
          </span>
          <div className="flex gap-3">
            <button type="button" className="text-ink-dim" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-copper px-3 py-1 font-medium text-ground disabled:opacity-40"
              disabled={!draft.trim() || draft.length > MESSAGE_LIMIT}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : changedElsewhere ? "Save my version" : "Save"}
            </button>
          </div>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-1 text-xs text-alert">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs text-ink-faint">
        Enter to save · Shift+Enter for a new line · Esc to cancel
      </p>
    </div>
  );
}
