import { useEffect, useRef, useState } from "react";
import type { ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatDay, formatTime } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";

interface Props {
  title: string;
  emptyHint: string;
  load: (
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<{ messages: Message[]; nextCursor?: string | null }>;
  /** Re-runs `load` whenever this changes (channel switch, save toggled). */
  reloadKey: string;
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

  return (
    <aside
      aria-label={props.title}
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge bg-ground"
    >
      <header className="flex h-[53px] shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 className="font-bold">{props.title}</h2>
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
          className="rounded-lg px-2 py-1 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          ✕
        </button>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={busy}>
        {error && (
          <p role="alert" className="mb-3 text-sm text-ink-dim">
            Could not load {props.title.toLowerCase()}. The last loaded page is kept.{" "}
            <button
              disabled={busy}
              className="text-copper underline"
              onClick={() => retry.current?.()}
            >
              Retry
            </button>
          </p>
        )}
        {busy && (
          <p role="status" className="py-3 text-center font-mono text-xs text-ink-faint">
            Loading messages…
          </p>
        )}
        {messages?.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-ink-faint">{props.emptyHint}</p>
        )}
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
                      {m.threadRootId ? "Open reply" : "Open message"}
                    </button>
                  </div>
                </li>
              );
            })}
        </ul>
      </div>
      <footer className="border-t border-edge px-4 py-2 text-[11px] text-ink-faint">
        <div role="status">
          {messages?.length ?? 0} {messages?.length === 1 ? "message" : "messages"} · Page{" "}
          {page + 1}
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
export function LaterPanel(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  const savedSignature = useWorkspace((s) => Object.keys(s.saved).sort().join(","));
  return (
    <MessageListPanel
      title="Later"
      emptyHint="Save a message with the 🔖 button and it shows up here."
      load={(cursor, signal) => client.api.listSaved(cursor, signal)}
      reloadKey={`saved:${savedSignature}`}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}
