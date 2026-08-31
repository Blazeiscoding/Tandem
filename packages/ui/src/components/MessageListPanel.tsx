import { useEffect, useState } from "react";
import type { ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatDay, formatTime } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";

interface Props {
  title: string;
  emptyHint: string;
  load: () => Promise<{ messages: Message[] }>;
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

  useEffect(() => {
    let active = true;
    setMessages(null);
    props
      .load()
      .then((r) => {
        if (active) setMessages(r.messages);
      })
      .catch(() => {
        if (active) setMessages([]);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reloadKey]);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-edge bg-ground">
      <header className="flex h-[53px] shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 className="font-bold">{props.title}</h2>
        <button
          onClick={props.onClose}
          aria-label={`Close ${props.title}`}
          className="rounded-lg px-2 py-1 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        {messages === null && (
          <p className="py-6 text-center font-mono text-xs text-ink-faint">loading…</p>
        )}
        {messages?.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-ink-faint">{props.emptyHint}</p>
        )}
        <ul className="space-y-2">
          {(messages ?? []).map((m) => {
            const channel = channels[m.channelId];
            return (
              <li key={m.id}>
                <button
                  onClick={() => props.onJump(m.channelId, m.id)}
                  className="w-full rounded-xl border border-edge bg-raised p-3 text-left transition-colors hover:border-copper/50"
                >
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
                          <Mrkdwn text={m.text} users={users} channels={channels} selfId={selfId} />
                        ) : (
                          <span className="italic">
                            {m.files.length} {m.files.length === 1 ? "file" : "files"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <footer className="border-t border-edge px-4 py-2 text-[11px] text-ink-faint">
        {messages?.length ?? 0} {messages?.length === 1 ? "message" : "messages"}
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
      load={() => client.api.listPins(props.channelId)}
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
  const savedCount = useWorkspace((s) => Object.keys(s.saved).length);
  return (
    <MessageListPanel
      title="Later"
      emptyHint="Save a message with the 🔖 button and it shows up here."
      load={() => client.api.listSaved()}
      reloadKey={`saved:${savedCount}`}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}
