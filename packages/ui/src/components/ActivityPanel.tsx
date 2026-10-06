import { useEffect, useRef, useState } from "react";
import { isMessageRead } from "@slackoss/client-core";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatTime, formatWhen } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon } from "./Icon.js";
import { RefreshButton } from "./MessageListPanel.js";
import { Tooltip } from "./Tooltip.js";
import { ListStatus } from "./ListStatus.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useTabs } from "../lib/useTabs.js";
import { CoalescedLoader } from "../lib/coalescedLoader.js";

const MODES = ["unread", "mentions"] as const;
/**
 * How long a sign that Activity may be out of date waits for others like it,
 * so a burst of read, edit and count changes is one load (REV-05).
 */
export const ACTIVITY_REFRESH_DELAY_MS = 250;
type ActivityMode = (typeof MODES)[number];

export function ActivityPanel({
  onClose,
  onJump,
}: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const memberships = useWorkspace((s) => s.memberships);
  const threadFollows = useWorkspace((s) => s.threadFollows);
  const repliesRead = useWorkspace((s) => s.repliesRead);
  const mentionCounts = useWorkspace((s) => s.mentionCounts);
  const removedHistory = useWorkspace((s) => s.removedHistory);
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const [mode, setMode] = useState<ActivityMode>("unread");
  const [cursors, setCursors] = useState<(ID | undefined)[]>([undefined]);
  const tabs = useTabs({
    label: "Activity filter",
    tabs: MODES,
    selected: mode,
    onSelect(next) {
      setMode(next);
      setCursors([undefined]);
    },
  });
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.api.activity>> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const cursor = cursors.at(-1);

  // One loader for the panel's life: what each load asks for is read when it starts.
  const query = useRef({ mode, cursor });
  query.current = { mode, cursor };
  const [loader] = useState(
    () =>
      new CoalescedLoader(async (signal) => {
        const { mode, cursor } = query.current;
        setLoading(true);
        setError(null);
        try {
          const page = await client.api.activity(mode, { cursor, signal });
          if (!signal.aborted) setResult(page);
        } catch {
          if (!signal.aborted)
            setError("Could not load activity. Check your connection and try again.");
        } finally {
          if (!signal.aborted) setLoading(false);
        }
      }, ACTIVITY_REFRESH_DELAY_MS),
  );
  useEffect(() => () => loader.stop(), [loader]);

  // Another filter or page is another list: clear it and load at once.
  useEffect(() => {
    setResult(null);
    loader.now();
  }, [loader, mode, cursor]);

  // Refresh and Retry load at once, keeping what is shown until the answer.
  const asked = useRef(revision);
  useEffect(() => {
    if (asked.current === revision) return;
    asked.current = revision;
    loader.now();
  }, [loader, revision]);

  // The server refreshes this identity for mention edits, even when the unread
  // count stays the same, so every change is a reason to look again. A burst of
  // them is one load, and what is shown stays until it answers (REV-05).
  const heardCounts = useRef(mentionCounts);
  useEffect(() => {
    if (heardCounts.current === mentionCounts) return;
    heardCounts.current = mentionCounts;
    loader.soon();
  }, [loader, mentionCounts]);

  // Retention took threads from a conversation this page shows: load it again,
  // rather than go on listing what the server no longer has.
  const heardRemoved = useRef(removedHistory);
  useEffect(() => {
    const before = heardRemoved.current;
    heardRemoved.current = removedHistory;
    if (result?.messages.some((m) => removedHistory[m.channelId] !== before[m.channelId]))
      setRevision((v) => v + 1);
  }, [removedHistory, result]);

  const messages = (result?.messages ?? []).filter(
    (message) =>
      channels[message.channelId] &&
      message.channelId in memberships &&
      (mode === "mentions" || !isMessageRead(message, { memberships, threadFollows, repliesRead })),
  );

  return (
    <aside
      ref={panel}
      aria-label="Activity"
      className="flex w-[420px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          Activity
        </h2>
        <RefreshButton
          busy={loading}
          onClick={() => {
            setCursors([undefined]);
            setRevision((v) => v + 1);
          }}
        />
        <button
          aria-label="Close activity"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div
        {...tabs.listProps}
        className="m-3 mb-1 flex gap-1 rounded-xl border border-edge bg-deep/40 p-1"
      >
        {MODES.map((value) => (
          <button
            key={value}
            {...tabs.tabProps(value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${mode === value ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]" : "text-ink-faint hover:text-ink"}`}
          >
            {value === "unread" ? "Unread" : "Mentions"}
          </button>
        ))}
      </div>
      <div {...tabs.panelProps} className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={loading}>
        <p className="mb-2 px-1 text-xs text-ink-faint">
          {mode === "unread"
            ? "Unread messages in conversations you joined."
            : "Direct and room-wide mentions in conversations you joined."}
        </p>
        <ListStatus
          loading={loading}
          placeholder={!result}
          loadingLabel="Loading activity…"
          error={error}
          onRetry={() => setRevision((v) => v + 1)}
          empty={
            result && !messages.length
              ? cursors.length > 1 || result.nextCursor
                ? "Nothing unread on this page."
                : mode === "unread"
                  ? "You're caught up."
                  : "No mentions yet."
              : null
          }
          emptyIcon={mode === "unread" ? "check" : "at"}
        />
        <ul className="space-y-1">
          {messages.map((message) => {
            const unread = !isMessageRead(message, { memberships, threadFollows, repliesRead });
            const channel = channels[message.channelId]!;
            const author = users[message.userId];
            const isRoom = channel.type === "public" || channel.type === "private";
            return (
              <li
                key={message.id}
                className="group relative rounded-xl px-3 py-2.5 transition-colors hover:bg-ink/[0.035]"
              >
                {unread && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0.5 top-4 size-1.5 rounded-full bg-copper"
                  />
                )}
                <div className="flex gap-2.5">
                  <Avatar user={author} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5 text-[13px]">
                      <span className="truncate font-semibold">
                        {author?.displayName ?? "Unknown member"}
                      </span>
                      {isRoom && (
                        <span className="truncate text-ink-faint">
                          in {channelTitle(channel, users, client.state.self?.id)}
                        </span>
                      )}
                      {unread && <span className="sr-only">, unread</span>}
                      <time
                        dateTime={new Date(message.createdAt).toISOString()}
                        title={`${new Date(message.createdAt).toLocaleDateString()} ${formatTime(message.createdAt)}`}
                        className="ml-auto shrink-0 text-[12px] text-ink-faint"
                      >
                        {formatWhen(message.createdAt)}
                      </time>
                    </div>
                    {message.threadRootId && (
                      <p className="text-[12px] text-ink-faint">Thread reply</p>
                    )}
                    <div className="mt-0.5 line-clamp-3 text-sm text-ink-dim">
                      <Mrkdwn
                        text={message.text}
                        users={users}
                        channels={channels}
                        selfId={client.state.self?.id}
                      />
                    </div>
                    {message.files.length > 0 && (
                      <p className="mt-1 text-xs text-ink-faint">
                        {message.files.length} attachment{message.files.length === 1 ? "" : "s"}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px] font-medium">
                      <button
                        className="inline-flex items-center gap-1 text-ink-dim hover:text-ink"
                        onClick={() => onJump(message.channelId, message.id)}
                      >
                        Open in conversation
                        <Icon name="arrow" size={12} />
                      </button>
                      {unread && (
                        <Tooltip label="Mark this conversation read through this message">
                          <button
                            className="text-ink-faint hover:text-ink"
                            onClick={() =>
                              client.markRead(message.channelId, message.seq, { explicit: true })
                            }
                          >
                            Read through here
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <div
          hidden={cursors.length === 1 && !result?.nextCursor}
          className="mt-4 flex justify-between px-1 text-sm font-medium text-ink-dim"
        >
          <button
            disabled={loading || cursors.length === 1}
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            Previous page
          </button>
          <button
            disabled={loading || !result?.nextCursor}
            onClick={() =>
              result?.nextCursor && setCursors((values) => [...values, result.nextCursor!])
            }
          >
            Next page
          </button>
        </div>
      </div>
    </aside>
  );
}
