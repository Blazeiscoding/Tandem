import { useEffect, useMemo, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { formatBytes } from "../lib/format.js";

interface Props {
  channelId: ID;
  threadRootId?: ID;
  placeholder: string;
  autoFocus?: boolean;
}

/** Enter sends, Shift+Enter breaks the line, @ opens mention autocomplete. */
export function Composer({ channelId, threadRootId, placeholder, autoFocus }: Props) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  // Threads keep their own draft slot so a channel draft isn't clobbered.
  const draftKey = threadRootId ? `${channelId}:${threadRootId}` : channelId;
  const savedDraft = useWorkspace((s) => s.drafts[draftKey] ?? "");
  const [text, setText] = useState(savedDraft);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attached, setAttached] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);
  const dragDepth = useRef(0);
  /** True once the user has edited this conversation's draft in this session. */
  const edited = useRef(false);

  // Switching conversations swaps in that conversation's draft and clears attachments.
  useEffect(() => {
    edited.current = false;
    setText(client.state.drafts[draftKey] ?? "");
    setAttached([]);
    setMentionQuery(null);
  }, [client, draftKey]);

  // Drafts load from disk asynchronously, so they can arrive after this mounts.
  // Adopt them only while the composer is untouched, never over live typing.
  useEffect(() => {
    if (!edited.current && savedDraft) setText(savedDraft);
  }, [savedDraft]);

  // Persist as the user types. Guarded by `edited` so a freshly mounted empty
  // composer can't blank out a draft that hasn't loaded yet.
  useEffect(() => {
    if (!edited.current || text === savedDraft) return;
    const timer = setTimeout(() => client.setDraft(draftKey, text), 250);
    return () => clearTimeout(timer);
  }, [client, draftKey, text, savedDraft]);

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const incoming = [...files];
    if (incoming.length > 0) setAttached((prev) => [...prev, ...incoming].slice(0, 10));
  }

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus, channelId, threadRootId]);

  const candidates = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    return Object.values(users)
      .filter((u) => !u.deactivated)
      .filter((u) => u.handle.includes(q) || u.displayName.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, users]);

  function refreshMentionState(value: string, caret: number) {
    const upToCaret = value.slice(0, caret);
    const m = /(^|\s)@([a-z0-9._-]*)$/i.exec(upToCaret);
    if (m) {
      setMentionQuery({ start: caret - m[2]!.length - 1, query: m[2]! });
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  function insertMention(user: User) {
    if (!mentionQuery || !box.current) return;
    const caret = box.current.selectionStart;
    const next = `${text.slice(0, mentionQuery.start)}<@${user.id}> ${text.slice(caret)}`;
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const pos = mentionQuery.start + user.id.length + 4;
      box.current?.setSelectionRange(pos, pos);
      box.current?.focus();
    });
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed && attached.length === 0) return;
    client.send(channelId, trimmed, { threadRootId, files: attached });
    setText("");
    setAttached([]);
    setMentionQuery(null);
    edited.current = false;
    client.setDraft(draftKey, "");
    if (box.current) box.current.style.height = "auto";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery && candidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i + (e.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(candidates[mentionIndex]!);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      className="relative px-5 pb-5"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        // Nested elements fire leave events; only the outermost one ends the drag.
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {mentionQuery && candidates.length > 0 && (
        <ul className="absolute bottom-full left-5 right-5 z-10 mb-1 overflow-hidden rounded-xl border border-edge bg-lifted shadow-xl">
          {candidates.map((u, i) => (
            <li key={u.id}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(u);
                }}
                onMouseEnter={() => setMentionIndex(i)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
                  i === mentionIndex ? "bg-copper/15" : ""
                }`}
              >
                <Avatar user={u} size={22} />
                <span className="font-medium">{u.displayName}</span>
                <span className="font-mono text-xs text-ink-faint">@{u.handle}</span>
                {u.id === selfId && <span className="text-xs text-ink-faint">(you)</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={`rounded-xl border bg-raised transition-colors ${
          dragging ? "border-copper bg-copper/5" : "border-edge focus-within:border-copper/60"
        }`}
      >
        {attached.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-b border-edge p-2.5">
            {attached.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center gap-2 rounded-lg border border-edge bg-ground py-1 pl-2 pr-1 text-sm"
              >
                <span className="max-w-[180px] truncate">{f.name}</span>
                <span className="font-mono text-[11px] text-ink-faint">{formatBytes(f.size)}</span>
                <button
                  onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="rounded px-1 text-ink-faint transition-colors hover:text-alert"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          value={text}
          rows={1}
          placeholder={dragging ? "Drop files to attach" : placeholder}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length > 0) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onChange={(e) => {
            edited.current = true;
            setText(e.target.value);
            refreshMentionState(e.target.value, e.target.selectionStart);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
            const now = Date.now();
            if (now - lastTypingSent.current > 3000 && e.target.value.trim()) {
              lastTypingSent.current = now;
              client.sendTyping(channelId);
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setMentionQuery(null)}
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 py-3 text-[15px] outline-none placeholder:text-ink-faint"
        />
        <div className="flex items-center justify-between px-2.5 pb-2">
          <button
            onClick={() => filePicker.current?.click()}
            title="Attach a file"
            className="rounded-lg px-2 py-1 text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
          >
            📎
          </button>
          <span className="pr-1 font-mono text-[10px] text-ink-faint">
            {text.trim() || attached.length > 0 ? "Enter to send · Shift+Enter for a new line" : ""}
          </span>
        </div>
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
