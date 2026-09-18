import { memo, useState, type ReactNode } from "react";
import { useCopy } from "../lib/useCopy.js";
import { browserLink } from "../lib/deeplink.js";
import type { FileMeta, ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { formatTime } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { MessageAttachments } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { MessageEditor } from "./MessageEditor.js";
import { useShareableServer } from "./ShareableServer.js";
import { Icon } from "./Icon.js";

const QUICK_REACTIONS = ["👍", "✅", "👀", "🎉", "❤️", "😂"];

interface Props {
  message: Message;
  compact: boolean;
  inThread?: boolean;
  onOpenThread?: (rootId: ID) => void;
  onChannelClick?: (id: ID) => void;
  onOpenImage?: (file: FileMeta) => void;
  onOpenProfile?: (userId: ID) => void;
  /** Briefly flagged after jumping here from search, pins or a link. */
  highlighted?: boolean;
}

export const MessageItem = memo(function MessageItem({
  message,
  compact,
  inThread,
  onOpenThread,
  onChannelClick,
  onOpenImage,
  onOpenProfile,
  highlighted,
}: Props) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const self = useWorkspace((s) => s.self);
  const [editing, setEditing] = useState(false);
  const { copy, copied } = useCopy(1200);
  const shareable = useShareableServer();
  const isSaved = useWorkspace((s) => !!s.saved[message.id]);
  const author = users[message.userId];
  const mine = message.userId === self?.id;
  const canDelete = mine || self?.role === "owner" || self?.role === "admin";
  const mentionsMe = self ? message.text.includes(`<@${self.id}>`) : false;

  return (
    <div
      role="article"
      aria-label={`Message from ${author?.displayName ?? "unknown"}`}
      tabIndex={0}
      className={`group relative px-5 py-0.5 transition-colors hover:bg-raised/60 ${
        compact ? "" : "mt-2.5"
      } ${mentionsMe ? "border-l-2 border-copper bg-mention hover:bg-mention" : ""} ${
        highlighted ? "bg-copper/15 hover:bg-copper/15" : ""
      }`}
    >
      <div className="flex gap-2.5">
        <div className="w-9 shrink-0 pt-0.5">
          {!compact && (
            <button
              onClick={() => onOpenProfile?.(message.userId)}
              title={`View ${author?.displayName ?? "profile"}`}
              className="rounded-lg transition-opacity hover:opacity-80"
            >
              <Avatar user={author} size={36} />
            </button>
          )}
          {compact && (
            <span className="hidden select-none pt-1 text-right font-mono text-[10px] text-ink-faint group-hover:block">
              {formatTime(message.createdAt)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {(message.pinned || isSaved) && (
            <div className="mb-0.5 flex items-center gap-3 text-[11px] text-ink-faint">
              {message.pinned && (
                <span className="flex items-center gap-1 text-copper">
                  <Icon name="pin" size={12} />
                  Pinned to this channel
                </span>
              )}
              {isSaved && (
                <span className="flex items-center gap-1">
                  <Icon name="bookmark" size={12} />
                  Saved for later
                </span>
              )}
            </div>
          )}
          {!compact && (
            <div className="flex items-baseline gap-2">
              <button
                onClick={() => onOpenProfile?.(message.userId)}
                className="font-bold hover:underline"
              >
                {author?.displayName ?? "unknown"}
              </button>
              {author?.statusEmoji && (
                <span title={author.statusText} className="text-[13px]">
                  {author.statusEmoji}
                </span>
              )}
              <span className="font-mono text-[11px] text-ink-faint">
                {formatTime(message.createdAt)}
              </span>
            </div>
          )}
          {editing ? (
            <MessageEditor message={message} onClose={() => setEditing(false)} />
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
              <MessageAttachments files={message.files} onOpenImage={(f) => onOpenImage?.(f)} />
              <MessageActions message={message} />
            </>
          )}

          {message.reactions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {message.reactions.map((g) => {
                const reacted = self ? g.userIds.includes(self.id) : false;
                const names = g.userIds.map((id) => users[id]?.displayName ?? "unknown").join(", ");
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

          {!inThread && message.threadRootId && (
            <button
              onClick={() => onOpenThread?.(message.threadRootId!)}
              className="mt-1 flex items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-1 text-[13px] text-ink-faint transition-colors hover:border-edge hover:bg-raised hover:text-ink"
            >
              Also sent to the channel from a thread
              <span className="inline-flex items-center gap-1 text-copper">
                View thread
                <Icon name="arrow" size={13} />
              </span>
            </button>
          )}

          {!inThread && message.replyCount > 0 && (
            <button
              onClick={() => onOpenThread?.(message.id)}
              className="mt-1 flex items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-1 text-[13px] font-medium text-copper transition-colors hover:border-edge hover:bg-raised"
            >
              {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
              <Icon name="arrow" size={13} className="text-ink-faint" />
            </button>
          )}
        </div>
      </div>

      {!editing && (
        <div className="absolute -top-3.5 right-4 hidden max-w-[calc(100%-32px)] items-center overflow-x-auto rounded-lg border border-edge bg-lifted shadow-lg group-hover:flex group-focus-within:flex">
          {QUICK_REACTIONS.map((e) => (
            <ToolbarButton key={e} label={e} onClick={() => client.toggleReaction(message, e)} />
          ))}
          {!inThread && (
            <ToolbarButton
              label={<Icon name="thread" size={15} />}
              title="Reply in thread"
              onClick={() => onOpenThread?.(message.id)}
            />
          )}
          <ToolbarButton
            label={
              copied ? (
                <Icon name={copied.ok ? "check" : "alert"} size={15} />
              ) : (
                <Icon name="link" size={15} />
              )
            }
            title={copied && !copied.ok ? "Could not copy the link" : "Copy link to message"}
            onClick={() =>
              // A browser link opens anywhere: in a browser at the web client,
              // and in place when clicked inside the app.
              void copy(
                browserLink(shareable.serverUrl, {
                  kind: "message",
                  channelId: message.channelId,
                  messageId: message.id,
                }),
              )
            }
          />
          <ToolbarButton
            label={<Icon name="bookmark" size={15} />}
            title={isSaved ? "Remove from Later" : "Save for later"}
            active={isSaved}
            onClick={() => client.toggleSaved(message.id)}
          />
          <ToolbarButton
            label={<Icon name="markUnread" size={15} />}
            title={inThread ? "Mark unread from this reply" : "Mark unread from this message"}
            onClick={() =>
              // Inside a thread this is the thread's own unread state, and the
              // root shown at the top of the panel is itself the thread.
              inThread
                ? client.markThreadUnread(message.threadRootId ?? message.id, message.seq)
                : client.markUnread(message.channelId, message.seq)
            }
          />
          <ToolbarButton
            label={<Icon name="pin" size={15} />}
            title={message.pinned ? "Unpin from channel" : "Pin to channel"}
            active={message.pinned}
            onClick={() => client.togglePin(message)}
          />
          {mine && (
            <ToolbarButton
              label={<Icon name="edit" size={15} />}
              title="Edit message"
              onClick={() => {
                setEditing(true);
              }}
            />
          )}
          {canDelete && (
            <ToolbarButton
              label={<Icon name="trash" size={15} />}
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
});

function ToolbarButton(props: {
  label: ReactNode;
  title?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      aria-label={props.title}
      className={`flex items-center justify-center px-2 py-1.5 text-[14px] transition-colors hover:bg-copper/20 ${
        props.active ? "bg-copper/25" : ""
      }`}
    >
      {props.label}
    </button>
  );
}

/**
 * The buttons an app attached to a message. A link button is an ordinary
 * anchor; everything else calls the app back and waits, because the answer
 * usually rewrites the very message the button sits on.
 */
function MessageActions({ message }: { message: Message }) {
  const client = useClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (message.actions.length === 0) return null;

  const styles: Record<string, string> = {
    primary: "border-online bg-online/15 text-online hover:bg-online/25",
    danger: "border-alert bg-alert/15 text-alert hover:bg-alert/25",
    default: "border-edge text-ink-dim hover:border-ink-faint hover:text-ink",
  };

  async function press(actionId: string) {
    setError(null);
    setPending(actionId);
    try {
      const res = await client.api.runMessageAction(message.id, actionId);
      if (!res.ok) setError("That did not go through.");
    } catch {
      setError("That did not go through.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {message.actions.map((action) =>
        action.url ? (
          <a
            key={action.actionId}
            href={action.url}
            target="_blank"
            rel="noreferrer noopener"
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${styles.default}`}
          >
            {action.text}
          </a>
        ) : (
          <button
            key={action.actionId}
            disabled={pending !== null}
            onClick={() => void press(action.actionId)}
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${
              styles[action.style] ?? styles.default
            }`}
          >
            {pending === action.actionId ? "…" : action.text}
          </button>
        ),
      )}
      {error && (
        <span role="alert" className="text-[12px] text-alert">
          {error}
        </span>
      )}
    </div>
  );
}
