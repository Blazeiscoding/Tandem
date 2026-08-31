import { useEffect, useMemo, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";

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
  const [text, setText] = useState("");
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const lastTypingSent = useRef(0);

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
    if (!trimmed) return;
    client.send(channelId, trimmed, threadRootId);
    setText("");
    setMentionQuery(null);
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
    <div className="relative px-5 pb-5">
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
      <div className="rounded-xl border border-edge bg-raised transition-colors focus-within:border-copper/60">
        <textarea
          ref={box}
          value={text}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => {
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
      </div>
    </div>
  );
}
