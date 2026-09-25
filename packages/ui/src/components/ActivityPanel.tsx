import { useEffect, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatTime } from "../lib/format.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { ListStatus } from "./ListStatus.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";

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
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const [mode, setMode] = useState<"unread" | "mentions">("unread");
  const [cursors, setCursors] = useState<(ID | undefined)[]>([undefined]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.api.activity>> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const cursor = cursors.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setResult(null);
    void client.api
      .activity(mode, { cursor, signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted) setResult(page);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load activity. Check your connection and try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, mode, cursor, revision]);

  const messages = (result?.messages ?? []).filter(
    (message) =>
      channels[message.channelId] &&
      message.channelId in memberships &&
      (mode === "mentions" || message.seq > (memberships[message.channelId] ?? 0)),
  );

  return (
    <aside
      ref={panel}
      aria-label="Activity"
      className="flex w-[420px] max-w-full shrink-0 flex-col border-l border-edge bg-ground"
    >
      <header className="flex h-[53px] shrink-0 items-center justify-between gap-2 border-b border-edge px-4">
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
      <div
        role="group"
        aria-label="Activity filter"
        className="flex gap-2 border-b border-edge p-3"
      >
        {(["unread", "mentions"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={mode === value}
            className={`flex-1 rounded-lg px-3 py-2 text-sm ${mode === value ? "bg-copper/15 text-copper" : "text-ink-dim hover:bg-lifted"}`}
            onClick={() => {
              setMode(value);
              setCursors([undefined]);
            }}
          >
            {value === "unread" ? "Unread" : "Mentions"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={loading}>
        <p className="mb-3 text-xs text-ink-faint">
          {mode === "unread"
            ? "Unread messages in conversations you joined."
            : "Direct and room-wide mentions in conversations you joined."}
        </p>
        <ListStatus
          loading={loading}
          placeholder
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
            const unread = message.seq > (memberships[message.channelId] ?? 0);
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
