import { useState } from "react";
import type { FileMeta, ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { formatTime } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { MessageAttachments } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";

const QUICK_REACTIONS = ["👍", "✅", "👀", "🎉", "❤️", "😂"];

interface Props {
  message: Message;
  compact: boolean;
  inThread?: boolean;
  onOpenThread?: (rootId: ID) => void;
  onChannelClick?: (id: ID) => void;
  onOpenImage?: (file: FileMeta) => void;
}

export function MessageItem({
  message,
  compact,
  inThread,
  onOpenThread,
  onChannelClick,
  onOpenImage,
}: Props) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const self = useWorkspace((s) => s.self);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const isSaved = useWorkspace((s) => !!s.saved[message.id]);
  const author = users[message.userId];
  const mine = message.userId === self?.id;
  const canDelete = mine || self?.role === "owner" || self?.role === "admin";
  const mentionsMe = self ? message.text.includes(`<@${self.id}>`) : false;

  function saveEdit() {
    const t = draft.trim();
    if (t && t !== message.text) void client.api.editMessage(message.id, t);
    setEditing(false);
  }

  return (
    <div
      className={`group relative px-5 py-0.5 hover:bg-raised/60 ${compact ? "" : "mt-2.5"} ${
        mentionsMe ? "border-l-2 border-copper bg-mention hover:bg-mention" : ""
      }`}
    >
      <div className="flex gap-2.5">
        <div className="w-9 shrink-0 pt-0.5">
          {!compact && <Avatar user={author} size={36} />}
          {compact && (
            <span className="hidden select-none pt-1 text-right font-mono text-[10px] text-ink-faint group-hover:block">
              {formatTime(message.createdAt)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {(message.pinned || isSaved) && (
            <div className="mb-0.5 flex items-center gap-2 text-[11px] text-ink-faint">
              {message.pinned && <span className="text-copper">📌 Pinned to this channel</span>}
              {isSaved && <span>🔖 Saved for later</span>}
            </div>
          )}
          {!compact && (
            <div className="flex items-baseline gap-2">
              <span className="font-bold">{author?.displayName ?? "unknown"}</span>
              <span className="font-mono text-[11px] text-ink-faint">
                {formatTime(message.createdAt)}
              </span>
            </div>
          )}
          {editing ? (
            <div className="mt-1">
              <textarea
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    saveEdit();
                  }
                  if (e.key === "Escape") setEditing(false);
                }}
                className="block w-full resize-none rounded-lg border border-copper/60 bg-ground px-3 py-2 text-[15px] outline-none"
                rows={Math.min(6, draft.split("\n").length)}
              />
              <p className="mt-1 text-xs text-ink-faint">Enter to save · Esc to cancel</p>
            </div>
          ) : (
            <>
              {message.text && (
                <div className="text-[15px]">
                  <Mrkdwn
                    text={message.text}
                    users={users}
                    channels={channels}
                    selfId={self?.id}
                    onChannelClick={onChannelClick}
                  />
                  {message.editedAt && (
                    <span className="ml-1.5 text-[11px] text-ink-faint">(edited)</span>
                  )}
                </div>
              )}
              <MessageAttachments
                files={message.files}
                onOpenImage={(f) => onOpenImage?.(f)}
              />
            </>
          )}

          {message.reactions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {message.reactions.map((g) => {
                const reacted = self ? g.userIds.includes(self.id) : false;
                const names = g.userIds
                  .map((id) => users[id]?.displayName ?? "unknown")
                  .join(", ");
                return (
                  <button
                    key={g.emoji}
                    title={names}
                    onClick={() => client.toggleReaction(message, g.emoji)}
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[13px] transition-colors ${
                      reacted
                        ? "border-copper/60 bg-copper/15"
                        : "border-edge bg-raised hover:border-ink-faint"
                    }`}
                  >
                    <span>{g.emoji}</span>
                    <span className="font-mono text-[11px] text-ink-dim">{g.userIds.length}</span>
                  </button>
                );
              })}
            </div>
          )}

          {!inThread && message.replyCount > 0 && (
            <button
              onClick={() => onOpenThread?.(message.id)}
              className="mt-1 flex items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-1 text-[13px] font-medium text-copper transition-colors hover:border-edge hover:bg-raised"
            >
              {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
              <span className="text-ink-faint">→</span>
            </button>
          )}
        </div>
      </div>

      {!editing && (
        <div className="absolute -top-3.5 right-4 hidden items-center overflow-hidden rounded-lg border border-edge bg-lifted shadow-lg group-hover:flex">
          {QUICK_REACTIONS.map((e) => (
            <ToolbarButton key={e} label={e} onClick={() => client.toggleReaction(message, e)} />
          ))}
          {!inThread && (
            <ToolbarButton label="↩" title="Reply in thread" onClick={() => onOpenThread?.(message.id)} />
          )}
          <ToolbarButton
            label="🔖"
            title={isSaved ? "Remove from Later" : "Save for later"}
            active={isSaved}
            onClick={() => client.toggleSaved(message.id)}
          />
          <ToolbarButton
            label="📌"
            title={message.pinned ? "Unpin from channel" : "Pin to channel"}
            active={message.pinned}
            onClick={() => client.togglePin(message)}
          />
          {mine && (
            <ToolbarButton
              label="✎"
              title="Edit message"
              onClick={() => {
                setDraft(message.text);
                setEditing(true);
              }}
            />
          )}
          {canDelete && (
            <ToolbarButton
              label="🗑"
              title="Delete message"
              onClick={() => {
                if (confirm("Delete this message?")) void client.api.deleteMessage(message.id);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ToolbarButton(props: {
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      className={`px-2 py-1.5 text-[14px] transition-colors hover:bg-copper/20 ${
        props.active ? "bg-copper/25" : ""
      }`}
    >
      {props.label}
    </button>
  );
}
