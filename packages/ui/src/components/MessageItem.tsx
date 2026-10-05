import { lazy, memo, Suspense, useState, type ReactNode } from "react";
import { writeClipboard } from "../lib/useCopy.js";
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

/** The three reactions most messages get; the picker has the rest. */
const QUICK_REACTIONS = ["👍", "❤️", "😂"];

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
  // The toolbar shows on hover; while its menu is open it stays, so the menu
  // has a trigger to hang from and focus has somewhere to return to.
  const [moreOpen, setMoreOpen] = useState(false);
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
  const copyItem: MenuItem = {
    id: "link",
    label: "Copy link to message",
    icon: "link",
    // The menu has closed by now, so a notice says whether it worked.
    onSelect: () =>
      void writeClipboard(link()).then((ok) =>
        toast(
          ok
            ? { message: "Link copied.", kind: "success" }
            : { message: "Could not copy the link." },
        ),
      ),
  };
  const unreadItem: MenuItem = {
    id: "unread",
    label: unreadLabel,
    icon: "markUnread",
    onSelect: markUnread,
  };
  // Pinning changes the channel for everyone, which a guest may not.
  const pinItems: MenuItem[] =
    selfRole === "guest" ? [] : [{ id: "pin", label: pinLabel, icon: "pin", onSelect: togglePin }];
  const deleteItems: MenuItem[] = canDelete
    ? [
        {
          id: "delete",
          label: "Delete message",
          icon: "trash",
          destructive: true,
          section: true,
          disabled: deleting,
          onSelect: () => void deleteMessage(),
        },
      ]
    : [];
  /** Everything, named, for a touchscreen, where there is no toolbar. */
  const menuItems: MenuItem[] = [
    ...(inThread
      ? []
      : [{ id: "reply", label: "Reply in thread", onSelect: () => onOpenThread?.(message.id) }]),
    { id: "react", label: "Add a reaction…", onSelect: () => setPicking(true) },
    { ...copyItem, icon: undefined },
    { id: "save", label: saveLabel, onSelect: toggleSaved },
    { ...unreadItem, icon: undefined },
    ...pinItems.map((item) => ({ ...item, icon: undefined })),
    ...(mine ? [{ id: "edit", label: "Edit message", onSelect: () => setEditing(true) }] : []),
    ...deleteItems.map((item) => ({ ...item, icon: undefined, section: undefined })),
  ];
  /** What the toolbar keeps behind its last button: the less frequent half. */
  const moreItems: MenuItem[] = [copyItem, unreadItem, ...pinItems, ...deleteItems];

  return (
    <div
      role="article"
      aria-label={`Message from ${author?.displayName ?? "unknown"}`}
      tabIndex={0}
      className={`message-row group relative py-1 pl-5 pr-12 transition-colors hover:bg-ink/[0.025] ${
        compact ? "" : "mt-3"
      } ${moreOpen ? "bg-ink/[0.025]" : ""} ${
        mentionsMe ? "bg-mention shadow-[inset_2px_0_var(--color-copper)] hover:bg-mention" : ""
      } ${highlighted ? "bg-copper/15 hover:bg-copper/15" : ""}`}
    >
      <div className="flex gap-3.5">
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
              className="absolute right-0 top-0.5 hidden select-none whitespace-nowrap pt-[3px] text-[11px] text-ink-faint group-hover:block"
            >
              {formatTime(message.createdAt)}
            </time>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {(message.pinned || isSaved) && (
            <div className="mb-0.5 flex items-center gap-3 text-[12px] text-ink-faint">
              {message.pinned && (
                <span className="flex items-center gap-1">
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
                className="text-[15px] font-semibold leading-snug hover:underline"
              >
                {author?.displayName ?? "unknown"}
              </button>
              {author?.role === "guest" && <GuestTag />}
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
                  <button
                    className="font-medium text-ink underline"
                    onClick={() => setEditing(false)}
                  >
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
                <div className="message-text text-[15px] leading-[1.5] text-ink/90">
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
            <div role="group" aria-label="Reactions" className="mt-1.5 flex flex-wrap gap-1">
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
                    className={`flex h-6 items-center gap-1 rounded-full border px-2 text-[13px] transition-colors ${
                      reacted
                        ? "border-copper/50 bg-copper/10"
                        : "border-edge bg-transparent hover:border-ink-faint/50 hover:bg-ink/[0.04]"
                    }`}
                  >
                    <span>{g.emoji}</span>
                    <span
                      className={`tabular text-[12px] font-medium ${reacted ? "text-copper" : "text-ink-dim"}`}
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
              className="mt-1 inline-flex items-center gap-1.5 rounded-md text-left text-[12px] text-ink-faint transition-colors hover:text-ink"
            >
              <Icon name="thread" size={13} />
              <span>
                Also sent to the channel from a thread ·{" "}
                <span className="font-medium text-ink-dim">View thread</span>
              </span>
            </button>
          )}

          {!inThread && message.replyCount > 0 && (
            <button
              onClick={() => onOpenThread?.(message.id)}
              className="-ml-1.5 mt-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[13px] font-medium text-copper transition-colors hover:bg-ink/[0.04]"
            >
              <Icon name="thread" size={14} />
              {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
              <Icon name="arrow" size={12} className="text-ink-faint" />
            </button>
          )}
        </div>
      </div>

      {!editing && (
        <div
          className={`message-toolbar surface-float absolute -top-4 right-4 z-10 max-w-[calc(100%-32px)] items-center gap-px overflow-x-auto rounded-lg p-0.5 ${
            moreOpen ? "flex" : "hidden group-hover:flex group-focus-within:flex"
          }`}
        >
          {QUICK_REACTIONS.map((e) => (
            <ToolbarButton key={e} label={e} onClick={() => react(e)} />
          ))}
          <ToolbarButton
            label={<Icon name="smile" size={16} />}
            title="Add a reaction"
            onClick={() => setPicking(true)}
          />
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-edge" />
          {!inThread && (
            <ToolbarButton
              label={<Icon name="thread" size={16} />}
              title="Reply in thread"
              onClick={() => onOpenThread?.(message.id)}
            />
          )}
          <ToolbarButton
            label={<Icon name="bookmark" size={16} />}
            title={saveLabel}
            active={isSaved}
            onClick={toggleSaved}
          />
          {mine && (
            <ToolbarButton
              label={<Icon name="edit" size={16} />}
              title="Edit message"
              onClick={() => setEditing(true)}
            />
          )}
          <Menu
            label="More actions"
            tooltip="More actions"
            items={moreItems}
            onOpenChange={setMoreOpen}
            triggerClassName="flex size-7 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-ink/[0.08] hover:text-ink"
          />
        </div>
      )}
      {/* A touchscreen has no hover to raise the toolbar, so each message
          offers the same actions, with their names, in a menu of its own. */}
      {!editing && (
        <div className="message-more absolute right-1 top-0.5">
          <Menu
            label={`Actions for message from ${author?.displayName ?? "unknown"}`}
            items={menuItems}
            triggerClassName="flex size-9 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
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
      className={`flex size-7 items-center justify-center rounded-md text-[15px] text-ink-dim transition-colors hover:bg-ink/[0.08] hover:text-ink disabled:opacity-40 ${
        props.active ? "text-copper" : ""
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

/** Says a guest wrote it: somebody who joined with a name alone, for a day. */
export function GuestTag() {
  return (
    <span
      title="Joined as a guest"
      className="rounded border border-edge px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
    >
      Guest
    </span>
  );
}
