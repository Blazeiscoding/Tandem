import { lazy, memo, Suspense, useState, type ReactNode } from "react";
import { useCopy, writeClipboard } from "../lib/useCopy.js";
import { browserLink } from "../lib/deeplink.js";
import type { FileMeta, ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { formatFull, formatTime } from "../lib/format.js";
import { useMessageReferences } from "../lib/messageReferences.js";
import { Avatar } from "./Avatar.js";
import { MessageAttachments } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { useShareableServer } from "./ShareableServer.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Icon } from "./Icon.js";
import { Menu, type MenuItem } from "./Menu.js";
import { ReactionPicker } from "./ReactionPicker.js";
import { useConfirm } from "./Confirm.js";
import { Tooltip } from "./Tooltip.js";
import { useToast } from "./Toast.js";

// Editing a sent message is now and then, so the editor loads on first use.
const MessageEditor = lazy(() =>
  import("./MessageEditor.js").then((module) => ({ default: module.MessageEditor })),
);

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
  const confirm = useConfirm();
  // Only what this row shows, so a change to anyone or anything else does not
  // render it again; your own role decides what you may do to it.
  const { users, channels } = useMessageReferences(message);
  const selfId = useWorkspace((s) => s.self?.id);
  const selfRole = useWorkspace((s) => s.self?.role);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const { copy, copied } = useCopy(1200);
  const shareable = useShareableServer();
  const isSaved = useWorkspace((s) => !!s.saved[message.id]);
  const author = users[message.userId];
  const profileLabel = author ? `View ${author.displayName}'s profile` : "View profile";
  const mine = message.userId === selfId;
  const canDelete = mine || selfRole === "owner" || selfRole === "admin";
  const mentionsMe = selfId ? message.text.includes(`<@${selfId}>`) : false;
  const toast = useToast();

  /**
   * These toggles are optimistic and undo themselves when the server refuses.
   * The row that started one is hover-only and may be gone by the time the
   * refusal arrives, so the notice carries the news and the second attempt.
   */
  function reportRefusal(failure: string, run: () => Promise<boolean>) {
    void run().then((ok) => {
      if (ok) return;
      toast({
        message: failure,
        action: { label: "Try again", run: () => reportRefusal(failure, run) },
      });
    });
  }

  /** A link that opens anywhere: in a browser at the web client, and in place inside the app. */
  const link = () =>
    browserLink(shareable.serverUrl, {
      kind: "message",
      channelId: message.channelId,
      messageId: message.id,
    });
  function react(emoji: string) {
    reportRefusal("That reaction did not go through.", () => client.toggleReaction(message, emoji));
  }
  const saveLabel = isSaved ? "Remove from Saved" : "Save for later";
  function toggleSaved() {
    // Trying again repeats this intent, whatever the state is by then.
    const save = !isSaved;
    reportRefusal(
      save ? "Could not save that for later." : "Could not remove that from Saved.",
      () => client.toggleSaved(message.id, save),
    );
  }
  const unreadLabel = inThread ? "Mark unread from this reply" : "Mark unread from this message";
  function markUnread() {
    // Inside a thread this is the thread's own unread state, and the root
    // shown at the top of the panel is itself the thread.
    if (inThread) client.markThreadUnread(message.threadRootId ?? message.id, message.seq);
    else client.markUnread(message.channelId, message.seq);
  }
  const pinLabel = message.pinned ? "Unpin from channel" : "Pin to channel";
  function togglePin() {
    reportRefusal(
      message.pinned ? "Could not unpin that message." : "Could not pin that message.",
      () => client.togglePin(message),
    );
  }
  async function deleteMessage() {
    if (deleting) return;
    const go = await confirm({
      title: "Delete this message?",
      body: "Everyone in the conversation stops seeing it.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!go) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      await client.api.deleteMessage(message.id);
    } catch {
      setDeleteError(true);
    } finally {
      setDeleting(false);
    }
  }
  const menuItems: MenuItem[] = [
    ...(inThread
      ? []
      : [{ id: "reply", label: "Reply in thread", onSelect: () => onOpenThread?.(message.id) }]),
    { id: "react", label: "Add a reaction…", onSelect: () => setPicking(true) },
    {
      id: "link",
      label: "Copy link to message",
      // The menu has closed by now, so a notice says whether it worked.
      onSelect: () =>
        void writeClipboard(link()).then((ok) =>
          toast(
            ok
              ? { message: "Link copied.", kind: "success" }
              : { message: "Could not copy the link." },
          ),
        ),
    },
    { id: "save", label: saveLabel, onSelect: toggleSaved },
    { id: "unread", label: unreadLabel, onSelect: markUnread },
    { id: "pin", label: pinLabel, onSelect: togglePin },
    ...(mine ? [{ id: "edit", label: "Edit message", onSelect: () => setEditing(true) }] : []),
    ...(canDelete
      ? [
          {
            id: "delete",
            label: "Delete message",
            destructive: true,
            disabled: deleting,
            onSelect: () => void deleteMessage(),
          },
        ]
      : []),
  ];

  return (
    <div
      role="article"
      aria-label={`Message from ${author?.displayName ?? "unknown"}`}
      tabIndex={0}
      className={`message-row group relative py-0.5 pl-4 pr-12 transition-colors hover:bg-deep/40 ${
        compact ? "" : "mt-4"
      } ${
        mentionsMe ? "bg-mention shadow-[inset_2px_0_var(--color-copper)] hover:bg-mention" : ""
      } ${highlighted ? "bg-copper/15 hover:bg-copper/15" : ""}`}
    >
      <div className="flex gap-4">
        <div className="relative w-10 shrink-0 pt-0.5">
          {!compact && (
            <Tooltip label={profileLabel}>
              <button
                aria-label={profileLabel}
                onClick={() => onOpenProfile?.(message.userId)}
                className="rounded-full transition-opacity hover:opacity-80"
              >
                <Avatar user={author} size={40} />
              </button>
            </Tooltip>
          )}
          {compact && (
            // Out of the flow and on one line, so showing it cannot make the
            // row taller. A time that wrapped to two lines here grew the row
            // under a resting pointer, and the timeline then lost its place
            // at the bottom when a side panel opened.
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              title={formatFull(message.createdAt)}
              className="absolute right-0 top-0.5 hidden select-none whitespace-nowrap pt-1 text-[10px] text-ink-faint group-hover:block"
            >
              {formatTime(message.createdAt)}
            </time>
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
                className="text-[15px] font-semibold hover:underline"
              >
                {author?.displayName ?? "unknown"}
              </button>
              {author?.statusEmoji && (
                <span title={author.statusText} className="text-[13px]">
                  {author.statusEmoji}
                </span>
              )}
              <time
                dateTime={new Date(message.createdAt).toISOString()}
                title={formatFull(message.createdAt)}
                className="text-[12px] text-ink-faint"
              >
                {formatTime(message.createdAt)}
              </time>
            </div>
          )}
          {editing ? (
            <ErrorBoundary
              fallback={
                <p role="alert" className="mt-1 text-sm text-ink-dim">
                  The editor could not load. Reload the app to try again.{" "}
                  <button className="text-copper underline" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </p>
              }
            >
              <Suspense
                fallback={
                  <p role="status" className="mt-1 text-sm text-ink-faint">
                    Opening the editor…
                  </p>
                }
              >
                <MessageEditor message={message} onClose={() => setEditing(false)} />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <>
              {message.text && (
                <div className="message-text text-[15px] leading-[1.4] text-ink/90">
                  <Mrkdwn
                    text={message.text}
                    users={users}
                    channels={channels}
                    selfId={selfId}
                    onChannelClick={onChannelClick}
                  />
                  {message.editedAt && (
                    <span className="ml-1.5 text-[11px] text-ink-faint">(edited)</span>
                  )}
                </div>
              )}
              <MessageAttachments files={message.files} onOpenImage={(f) => onOpenImage?.(f)} />
              <MessageActions message={message} />
              {deleteError && (
                <p role="alert" className="mt-2 text-xs text-alert">
                  Could not confirm whether the message was deleted. Check your connection before
                  trying again.
                </p>
              )}
            </>
          )}

          {message.reactions.length > 0 && (
            <div role="group" aria-label="Reactions" className="mt-1 flex flex-wrap gap-1">
              {message.reactions.map((g) => {
                const reacted = selfId ? g.userIds.includes(selfId) : false;
                // "you" last, as people say it, and never your own name.
                const others = g.userIds
                  .filter((id) => id !== selfId)
                  .map((id) => users[id]?.displayName ?? "someone");
                const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(
                  reacted ? [...others, "you"] : others,
                );
                const count = g.userIds.length;
                return (
                  <button
                    key={g.emoji}
                    type="button"
                    title={names}
                    aria-label={`${g.emoji} ${count} ${count === 1 ? "reaction" : "reactions"}, from ${names}`}
                    aria-pressed={reacted}
                    onClick={() => react(g.emoji)}
                    className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-0.5 text-[13px] transition-colors ${
                      reacted
                        ? "border-copper bg-copper/15"
                        : "border-transparent bg-lifted hover:border-edge"
                    }`}
                  >
                    <span>{g.emoji}</span>
                    <span
                      className={`text-[12px] font-semibold ${reacted ? "text-copper" : "text-ink-dim"}`}
                    >
                      {g.userIds.length}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {!inThread && message.threadRootId && (
            <button
              onClick={() => onOpenThread?.(message.threadRootId!)}
              className="mt-1 flex items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-1 text-[13px] text-ink-faint transition-colors hover:border-edge hover:bg-lifted hover:text-ink"
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
              className="mt-1 flex items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-1 text-[13px] font-semibold text-copper transition-colors hover:border-edge hover:bg-lifted"
            >
              {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
              <Icon name="arrow" size={13} className="text-ink-faint" />
            </button>
          )}
        </div>
      </div>

      {!editing && (
        <div className="message-toolbar absolute -top-4 right-4 hidden max-w-[calc(100%-32px)] items-center overflow-x-auto rounded-lg border border-edge bg-raised shadow-lg group-hover:flex group-focus-within:flex">
          {QUICK_REACTIONS.map((e) => (
            <ToolbarButton key={e} label={e} onClick={() => react(e)} />
          ))}
          <ToolbarButton
            label={<Icon name="smile" size={15} />}
            title="Add a reaction"
            onClick={() => setPicking(true)}
          />
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
            onClick={() => void copy(link())}
          />
          <ToolbarButton
            label={<Icon name="bookmark" size={15} />}
            title={saveLabel}
            active={isSaved}
            onClick={toggleSaved}
          />
          <ToolbarButton
            label={<Icon name="markUnread" size={15} />}
            title={unreadLabel}
            onClick={markUnread}
          />
          <ToolbarButton
            label={<Icon name="pin" size={15} />}
            title={pinLabel}
            active={message.pinned}
            onClick={togglePin}
          />
          {mine && (
            <ToolbarButton
              label={<Icon name="edit" size={15} />}
              title="Edit message"
              onClick={() => setEditing(true)}
            />
          )}
          {canDelete && (
            <ToolbarButton
              label={<Icon name="trash" size={15} />}
              title="Delete message"
              disabled={deleting}
              onClick={() => void deleteMessage()}
            />
          )}
        </div>
      )}
      {/* A touchscreen has no hover to raise the toolbar, so each message
          offers the same actions, with their names, in a menu of its own. */}
      {!editing && (
        <div className="message-more absolute right-1 top-0.5">
          <Menu
            label={`Actions for message from ${author?.displayName ?? "unknown"}`}
            items={menuItems}
            triggerClassName="flex size-9 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
          />
        </div>
      )}
      {picking && <ReactionPicker onPick={react} onClose={() => setPicking(false)} />}
    </div>
  );
});

function ToolbarButton(props: {
  label: ReactNode;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const button = (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.title}
      className={`flex items-center justify-center px-2 py-1.5 text-sm transition-colors hover:bg-lifted disabled:opacity-40 ${
        props.active ? "bg-copper/25" : ""
      }`}
    >
      {props.label}
    </button>
  );
  return props.title ? <Tooltip label={props.title}>{button}</Tooltip> : button;
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
