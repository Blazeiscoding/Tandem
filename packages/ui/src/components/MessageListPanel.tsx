import { useEffect, useRef, useState, type ReactNode } from "react";
import { threadReadSeq } from "@slackoss/client-core";
import type { ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatDay, formatTime } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";

interface Props {
  title: string;
  emptyHint: ReactNode;
  /** One thing to do about an empty list, such as clearing its filter. */
  emptyAction?: { label: string; run: () => void };
  load: (
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<{ messages: Message[]; nextCursor?: string | null }>;
  /** Re-runs `load` whenever this changes (channel switch, save toggled). */
  reloadKey: string;
  /** A control for the header, left of Refresh — a filter, usually. */
  headerExtra?: ReactNode;
  /** Extra detail beside a row's channel, such as an unread count. */
  itemBadge?: (message: Message) => ReactNode;
  /** Overrides the row's action wording when "Open message" is wrong. */
  jumpLabel?: (message: Message) => string;
  /** Wording for the row count, singular and plural. Defaults to messages. */
  countNoun?: [string, string];
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}

/**
 * Right-hand panel listing a set of messages — pins for a channel, or the
 * user's saved items. Shares the thread panel's shape so the layout stays put.
 */
export function MessageListPanel(props: Props) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const retry = useRef<(() => void) | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  async function loadPage(
    cursor: string | undefined,
    targetPage: number,
    targetCursors: (string | undefined)[],
  ) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    retry.current = () => void loadPage(cursor, targetPage, targetCursors);
    setBusy(true);
    setError(false);
    try {
      const result = await props.load(cursor, controller.signal);
      if (controller.signal.aborted) return;
      setMessages(result.messages);
      setPage(targetPage);
      setCursors(targetCursors);
      setNextCursor(result.nextCursor ?? null);
      scroller.current?.scrollTo({ top: 0 });
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (request.current === controller && !controller.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    setMessages(null);
    setNextCursor(null);
    setPage(0);
    setCursors([undefined]);
    void loadPage(undefined, 0, [undefined]);
    return () => {
      request.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, props.reloadKey]);
  const { panel, heading } = usePanelFocus({ takeFocus: true });

  return (
    <aside
      ref={panel}
      aria-label={props.title}
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge bg-ground"
    >
      <header className="flex h-[53px] shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 ref={heading} tabIndex={-1} className="font-bold outline-none">
          {props.title}
        </h2>
        {props.headerExtra}
        <button
          disabled={busy}
          className="ml-auto mr-3 text-xs text-copper disabled:opacity-40"
          onClick={() => void loadPage(undefined, 0, [undefined])}
        >
          Refresh
        </button>
        <button
          onClick={props.onClose}
          aria-label={`Close ${props.title}`}
          className="rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={busy}>
        <ListStatus
          loading={busy}
          placeholder={messages === null}
          loadingLabel="Loading messages…"
          error={
            error
              ? `Could not load ${props.title.toLowerCase()}.${
                  messages ? " The last loaded page is kept." : ""
                }`
              : null
          }
          onRetry={() => retry.current?.()}
          empty={messages?.length === 0 ? props.emptyHint : null}
          emptyAction={props.emptyAction}
        />
        <ul className="space-y-2">
          {(messages ?? [])
            .filter((message) => channels[message.channelId])
            .map((m) => {
              const channel = channels[m.channelId];
              return (
                <li key={m.id}>
                  <div className="w-full rounded-xl border border-edge bg-raised p-3 text-left">
                    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-faint">
                      <span className="font-medium text-copper">
                        {channel
                          ? channel.name
                            ? `#${channel.name}`
                            : channelTitle(channel, users, selfId)
                          : "unknown"}
                      </span>
                      {props.itemBadge?.(m)}
                      <span className="ml-auto font-mono">
                        {formatDay(m.createdAt)} · {formatTime(m.createdAt)}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Avatar user={users[m.userId]} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold">
                          {users[m.userId]?.displayName ?? "unknown"}
                        </div>
                        <div className="line-clamp-4 text-sm text-ink-dim">
                          {m.text ? (
                            <Mrkdwn
                              text={m.text}
                              users={users}
                              channels={channels}
                              selfId={selfId}
                            />
                          ) : (
                            <span className="italic">
                              {m.files.length} {m.files.length === 1 ? "file" : "files"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      className="mt-2 text-xs text-copper underline"
                      onClick={() => props.onJump(m.channelId, m.id)}
                    >
                      {props.jumpLabel?.(m) ?? (m.threadRootId ? "Open reply" : "Open message")}
                    </button>
                  </div>
                </li>
              );
            })}
        </ul>
      </div>
      <footer className="border-t border-edge px-4 py-2 text-[11px] text-ink-faint">
        <div role="status">
          {messages?.length ?? 0}{" "}
          {messages?.length === 1
            ? (props.countNoun?.[0] ?? "message")
            : (props.countNoun?.[1] ?? "messages")}{" "}
          · Page {page + 1}
        </div>
        {(page > 0 || nextCursor) && (
          <div className="mt-2 flex justify-between text-xs">
            <button
              disabled={busy || page === 0}
              className="text-copper disabled:opacity-40"
              onClick={() => void loadPage(cursors[page - 1], page - 1, cursors)}
            >
              Previous page
            </button>
            <button
              disabled={busy || !nextCursor}
              className="text-copper disabled:opacity-40"
              onClick={() => {
                if (nextCursor)
                  void loadPage(nextCursor, page + 1, [...cursors.slice(0, page + 1), nextCursor]);
              }}
            >
              Next page
            </button>
          </div>
        )}
      </footer>
    </aside>
  );
}

/** Pinned messages for one channel. */
export function PinsPanel(props: {
  channelId: ID;
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  // Re-fetch whenever the set of pinned messages in view changes.
  const pinSignature = useWorkspace((s) =>
    (s.timelines[props.channelId]?.items ?? [])
      .filter((m) => m.pinned)
      .map((m) => m.id)
      .join(","),
  );
  return (
    <MessageListPanel
      title="Pinned"
      emptyHint="Nothing pinned here yet. Pin a message to keep it handy for everyone in the channel."
      load={(cursor, signal) => client.api.listPins(props.channelId, signal, cursor)}
      reloadKey={`${props.channelId}:${pinSignature}`}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}

/** The user's saved messages, across every channel they can see. */
export function SavedPanel(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  const savedSignature = useWorkspace((s) => Object.keys(s.saved).sort().join(","));
  return (
    <MessageListPanel
      title="Saved"
      emptyHint={
        <>
          Choose <Icon name="bookmark" size={13} className="inline align-[-2px]" /> Save for later
          in a message&rsquo;s actions and it shows up here.
        </>
      }
      load={(cursor, signal) => client.api.listSaved(cursor, signal)}
      reloadKey={`saved:${savedSignature}`}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}

/**
 * Threads this account follows, most recently active first. Unlike Saved and
 * Pinned, a row stands for a conversation rather than a single message, so it
 * carries its own unread count and opens the thread instead of the message.
 */
export function ThreadsPanel(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [unread, setUnread] = useState<Record<ID, number>>({});
  // Following, unfollowing and reading all change what belongs in this list,
  // including reading a channel past a thread's replies.
  const followSignature = useWorkspace((s) =>
    Object.values(s.threadFollows)
      .filter((f) => f.following)
      .map((f) => `${f.rootId}:${Math.min(f.lastSeq, threadReadSeq(f, s.memberships))}`)
      .sort()
      .join(","),
  );
  return (
    <MessageListPanel
      title="Threads"
      countNoun={["thread", "threads"]}
      emptyHint={
        unreadOnly
          ? "No unread replies. Threads you follow show up here when someone answers."
          : "Reply to a message, or follow a thread, and it shows up here."
      }
      emptyAction={
        unreadOnly ? { label: "Show all threads", run: () => setUnreadOnly(false) } : undefined
      }
      headerExtra={
        <button
          onClick={() => setUnreadOnly((on) => !on)}
          aria-pressed={unreadOnly}
          className={`ml-3 rounded-lg border px-2 py-0.5 text-[11px] transition-colors ${
            unreadOnly
              ? "border-copper text-copper"
              : "border-edge text-ink-faint hover:border-ink-faint hover:text-ink"
          }`}
        >
          Unread only
        </button>
      }
      load={async (cursor, signal) => {
        const result = await client.api.listFollowedThreads({ cursor, unreadOnly }, signal);
        setUnread(Object.fromEntries(result.threads.map((t) => [t.root.id, t.unreadCount])));
        return { messages: result.threads.map((t) => t.root), nextCursor: result.nextCursor };
      }}
      reloadKey={`threads:${unreadOnly}:${followSignature}`}
      itemBadge={(m) =>
        unread[m.id] ? (
          <span className="rounded-full bg-copper/15 px-2 text-copper">
            {unread[m.id]} new {unread[m.id] === 1 ? "reply" : "replies"}
          </span>
        ) : null
      }
      jumpLabel={() => "Open thread"}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}
