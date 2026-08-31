import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileMeta, ID } from "@slackoss/protocol";
import type { PendingMessage } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { formatDay, sameDay } from "../lib/format.js";
import { MessageItem } from "./MessageItem.js";
import { Lightbox, PendingAttachments } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface Props {
  channelId: ID;
  onOpenThread: (rootId: ID) => void;
  onChannelClick: (id: ID) => void;
}

export function MessageTimeline({ channelId, onOpenThread, onChannelClick }: Props) {
  const client = useClient();
  const timeline = useWorkspace((s) => s.timelines[channelId]);
  const pending = useWorkspace((s) => s.pending);
  const typing = useWorkspace((s) => s.typing[channelId]);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const loadingOlder = useRef(false);
  const [lightboxFile, setLightboxFile] = useState<FileMeta | null>(null);

  useEffect(() => {
    pinnedToBottom.current = true;
    void client.loadTimeline(channelId);
  }, [client, channelId]);

  const items = timeline?.items ?? [];
  const channelPending = pending.filter((p) => p.channelId === channelId && !p.threadRootId);
  const typers = Object.keys(typing ?? {})
    .filter((id) => id !== selfId)
    .map((id) => users[id]?.displayName ?? "someone");

  // Keep the view pinned to the newest message unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, channelPending.length, typers.length, channelId]);

  // Reading the latest message marks the channel read.
  useEffect(() => {
    if (pinnedToBottom.current && document.hasFocus()) client.markRead(channelId);
  }, [client, channelId, items.length]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (pinnedToBottom.current && document.hasFocus()) client.markRead(channelId);

    if (el.scrollTop < 400 && timeline?.hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      const prevHeight = el.scrollHeight;
      void client.loadTimeline(channelId, { older: true }).finally(() => {
        // Preserve the visual position after older messages prepend.
        requestAnimationFrame(() => {
          el.scrollTop += el.scrollHeight - prevHeight;
          loadingOlder.current = false;
        });
      });
    }
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto pb-3">
      {!timeline?.hasMore && timeline?.loaded && (
        <ChannelIntro channelId={channelId} />
      )}
      {items.map((msg, i) => {
        const prev = items[i - 1];
        const newDay = !prev || !sameDay(prev.createdAt, msg.createdAt);
        const compact =
          !newDay &&
          !!prev &&
          prev.userId === msg.userId &&
          msg.createdAt - prev.createdAt < GROUP_WINDOW_MS &&
          prev.replyCount === 0;
        return (
          <div key={msg.id}>
            {newDay && <DayDivider ts={msg.createdAt} />}
            <MessageItem
              message={msg}
              compact={compact}
              onOpenThread={onOpenThread}
              onChannelClick={onChannelClick}
              onOpenImage={setLightboxFile}
            />
          </div>
        );
      })}
      {channelPending.map((p) => (
        <PendingRow key={p.nonce} pending={p} />
      ))}
      <div className="h-5 px-5 pt-1 text-[12px] italic text-ink-faint">
        {typers.length > 0 &&
          `${typers.slice(0, 3).join(", ")} ${typers.length === 1 ? "is" : "are"} typing…`}
      </div>
      {lightboxFile && (
        <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />
      )}
    </div>
  );
}

function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="relative my-3 flex items-center px-5" role="separator">
      <div className="h-px flex-1 bg-edge" />
      <span className="rounded-full border border-edge bg-raised px-3 py-0.5 text-[11px] font-medium text-ink-dim">
        {formatDay(ts)}
      </span>
      <div className="h-px flex-1 bg-edge" />
    </div>
  );
}

function ChannelIntro({ channelId }: { channelId: ID }) {
  const channel = useWorkspace((s) => s.channels[channelId]);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  if (!channel) return null;
  const isRoom = channel.type === "public" || channel.type === "private";
  return (
    <div className="px-5 pb-2 pt-8">
      <h2 className="text-xl font-bold">
        {isRoom
          ? `#${channel.name}`
          : (channel.memberIds ?? [])
              .filter((id) => id !== selfId)
              .map((id) => users[id]?.displayName ?? "unknown")
              .join(", ") || "Just you"}
      </h2>
      <p className="mt-1 text-sm text-ink-dim">
        {isRoom
          ? channel.description ||
            `This is the very beginning of #${channel.name}. Say something to get it going.`
          : "This conversation is just between you. It starts here."}
      </p>
    </div>
  );
}

function PendingRow({ pending }: { pending: PendingMessage }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  return (
    <div className="px-5 py-0.5 opacity-60">
      <div className="flex gap-2.5">
        <div className="w-9 shrink-0" />
        <div className="min-w-0 flex-1 text-[15px]">
          {pending.text && <Mrkdwn text={pending.text} users={users} channels={channels} />}
          <PendingAttachments
            attachments={pending.attachments}
            progress={pending.uploadProgress}
          />
          {pending.failed ? (
            <span className="ml-2 text-[12px] text-alert">
              Not sent.{" "}
              <button className="underline" onClick={() => client.retrySend(pending.nonce)}>
                Retry
              </button>{" "}
              ·{" "}
              <button className="underline" onClick={() => client.discardSend(pending.nonce)}>
                Discard
              </button>
            </span>
          ) : (
            <span className="ml-2 font-mono text-[11px] text-ink-faint">sending…</span>
          )}
        </div>
      </div>
    </div>
  );
}
