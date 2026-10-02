import { useEffect, useRef, useState } from "react";
import { isMessageRead } from "@slackoss/client-core";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatTime } from "../lib/format.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon } from "./Icon.js";
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
      className="flex w-[420px] max-w-full shrink-0 flex-col border-l border-edge bg-raised"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-edge px-4">
        <h2 ref={heading} tabIndex={-1} className="font-bold outline-none">
          Activity
        </h2>
        <button
          className="ml-auto text-xs text-copper disabled:opacity-40"
          disabled={loading}
          onClick={() => {
            setCursors([undefined]);
            setRevision((v) => v + 1);
          }}
        >
          Refresh
        </button>
        <button
          aria-label="Close activity"
          className="rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div {...tabs.listProps} className="flex gap-2 border-b border-edge p-3">
        {MODES.map((value) => (
          <button
            key={value}
            {...tabs.tabProps(value)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm ${mode === value ? "bg-copper/15 text-copper" : "text-ink-dim hover:bg-lifted"}`}
          >
            {value === "unread" ? "Unread" : "Mentions"}
          </button>
        ))}
      </div>
      <div {...tabs.panelProps} className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={loading}>
        <p className="mb-3 text-xs text-ink-faint">
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
        />
        <ul className="space-y-3">
          {messages.map((message) => {
            const unread = !isMessageRead(message, { memberships, threadFollows, repliesRead });
            return (
              <li key={message.id} className="rounded-xl border border-edge bg-raised p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-copper">
                    {channelTitle(channels[message.channelId]!, users, client.state.self?.id)}
                  </span>
                  {unread && <span className="rounded bg-copper/15 px-1 text-copper">Unread</span>}
                  <time
                    dateTime={new Date(message.createdAt).toISOString()}
                    className="ml-auto text-ink-faint"
                  >
                    {new Date(message.createdAt).toLocaleDateString()}{" "}
                    {formatTime(message.createdAt)}
                  </time>
                </div>
                <p className="mb-1 text-xs font-medium text-ink-dim">
                  {users[message.userId]?.displayName ?? "Unknown member"}
                  {message.threadRootId ? " · Thread reply" : ""}
                </p>
                <div className="text-sm">
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
                <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-copper">
                  <button
                    className="underline"
                    onClick={() => onJump(message.channelId, message.id)}
                  >
                    Open in conversation
                  </button>
                  {unread && (
                    <Tooltip label="Mark this conversation read through this message">
                      <button
                        onClick={() =>
                          client.markRead(message.channelId, message.seq, { explicit: true })
                        }
                      >
                        Read through here
                      </button>
                    </Tooltip>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex justify-between text-sm text-copper">
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
