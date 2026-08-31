import { useEffect } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Composer } from "./Composer.js";
import { MessageItem } from "./MessageItem.js";

interface Props {
  channelId: ID;
  rootId: ID;
  onClose: () => void;
  onChannelClick: (id: ID) => void;
}

export function ThreadPanel({ channelId, rootId, onClose, onChannelClick }: Props) {
  const client = useClient();
  const root = useWorkspace(
    (s) => s.timelines[channelId]?.items.find((m) => m.id === rootId) ?? null,
  );
  const replies = useWorkspace((s) => s.threads[rootId]);
  const pending = useWorkspace((s) => s.pending).filter((p) => p.threadRootId === rootId);

  useEffect(() => {
    void client.loadThread(rootId, channelId);
  }, [client, rootId, channelId]);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-edge bg-ground">
      <header className="flex h-[53px] shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 className="font-bold">Thread</h2>
        <button
          onClick={onClose}
          aria-label="Close thread"
          className="rounded-lg px-2 py-1 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto py-2">
        {root && (
          <MessageItem message={root} compact={false} inThread onChannelClick={onChannelClick} />
        )}
        {(replies?.length ?? 0) > 0 && (
          <div className="my-2 flex items-center gap-2 px-5">
            <span className="text-[11px] font-medium text-ink-faint">
              {replies!.length} {replies!.length === 1 ? "reply" : "replies"}
            </span>
            <div className="h-px flex-1 bg-edge" />
          </div>
        )}
        {(replies ?? []).map((msg, i) => {
          const prev = replies![i - 1];
          const compact =
            !!prev && prev.userId === msg.userId && msg.createdAt - prev.createdAt < 300_000;
          return (
            <MessageItem
              key={msg.id}
              message={msg}
              compact={compact}
              inThread
              onChannelClick={onChannelClick}
            />
          );
        })}
        {pending.map((p) => (
          <div key={p.nonce} className="px-5 py-1 text-[15px] opacity-60">
            {p.text}
            <span className="ml-2 font-mono text-[11px] text-ink-faint">
              {p.failed ? "failed" : "sending…"}
            </span>
          </div>
        ))}
      </div>
      <Composer channelId={channelId} threadRootId={rootId} placeholder="Reply…" autoFocus />
    </aside>
  );
}
