import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileMeta, ID } from "@slackoss/protocol";
import type { EphemeralMessage, PendingMessage } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { formatDay, sameDay } from "../lib/format.js";
import { MessageItem } from "./MessageItem.js";
import { Lightbox, PendingAttachments } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface Anchor {
  id: string;
  /** Distance from the top of the viewport to the top of that row. */
  offset: number;
}

/** The first row reaching into the viewport, and where it currently sits. */
function topAnchor(el: HTMLElement): Anchor | null {
  for (const row of el.querySelectorAll<HTMLElement>("[data-mid]")) {
    if (row.offsetTop + row.offsetHeight > el.scrollTop) {
      return { id: row.dataset.mid!, offset: row.offsetTop - el.scrollTop };
    }
  }
  return null;
}

/** Puts that row back where it was, whatever changed around it. */
function restoreAnchor(el: HTMLElement, anchor: Anchor | null): void {
  if (!anchor) return;
  const row = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(anchor.id)}"]`);
  if (row) el.scrollTop = row.offsetTop - anchor.offset;
}

interface Props {
  channelId: ID;
  /** When set, scroll to this message and flash it. */
  highlightMessageId?: ID | null;
  onOpenThread: (rootId: ID) => void;
  onChannelClick: (id: ID) => void;
  onOpenProfile: (userId: ID) => void;
}

export function MessageTimeline({
  channelId,
  highlightMessageId,
  onOpenThread,
  onChannelClick,
  onOpenProfile,
}: Props) {
  const client = useClient();
  const timeline = useWorkspace((s) => s.timelines[channelId]);
  const pending = useWorkspace((s) => s.pending);
  const ephemerals = useWorkspace((s) => s.ephemerals[channelId]);
  const typing = useWorkspace((s) => s.typing[channelId]);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const loadingOlder = useRef(false);
  const [lightboxFile, setLightboxFile] = useState<FileMeta | null>(null);
  const loadingNewer = useRef(false);
  const highlightRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  /** Suppresses paging while a jump's programmatic scroll settles. */
  const settlingJump = useRef(false);

  useEffect(() => {
    // A jump anchors the view; only a plain channel open tails the newest.
    if (highlightMessageId) return;
    pinnedToBottom.current = true;
    void client.loadTimeline(channelId);
  }, [client, channelId, highlightMessageId]);

  const items = timeline?.items ?? [];
  const channelPending = pending.filter((p) => p.channelId === channelId && !p.threadRootId);
  // Bring the jumped-to message into view once it has rendered.
  useEffect(() => {
    if (!highlightMessageId) return;
    pinnedToBottom.current = false;
    settlingJump.current = true;
    const frame = requestAnimationFrame(() => {
      highlightRef.current?.scrollIntoView({ block: "center" });
    });
    // scrollIntoView fires scroll events of its own; ignore them.
    const settle = setTimeout(() => {
      settlingJump.current = false;
      lastScrollTop.current = scroller.current?.scrollTop ?? 0;
    }, 500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [highlightMessageId, items.length]);
  const typers = Object.keys(typing ?? {})
    .filter((id) => id !== selfId)
    .map((id) => users[id]?.displayName ?? "someone");

  // Keep the view pinned to the newest message unless the user scrolled up.
  // An anchored view must never be yanked to the bottom: that both loses the
  // jumped-to message and reads as a scroll-to-bottom, which pages forward.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !pinnedToBottom.current) return;
    if (highlightMessageId || timeline?.hasMoreNewer) return;
    el.scrollTop = el.scrollHeight;
  }, [
    items.length,
    channelPending.length,
    typers.length,
    channelId,
    highlightMessageId,
    timeline?.hasMoreNewer,
  ]);

  // Live messages arriving in a long-running channel eventually trim the oldest
  // ones off the top. That removes content above the viewport, which would
  // slide everything up by exactly the height that vanished. Give it back.
  const lastFirstId = useRef<ID | null>(null);
  const lastChannel = useRef<ID | null>(null);
  const lastScrollHeight = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const firstId = items[0]?.id ?? null;
    // Message ids sort lexicographically, so a *later* first id means the top
    // was trimmed, while an earlier one means older messages were prepended.
    // Comparing across a channel switch would be meaningless.
    const trimmedTop =
      lastChannel.current === channelId &&
      lastFirstId.current !== null &&
      firstId !== null &&
      firstId > lastFirstId.current;
    if (trimmedTop && !pinnedToBottom.current && !loadingOlder.current) {
      el.scrollTop -= lastScrollHeight.current - el.scrollHeight;
    }
    lastFirstId.current = firstId;
    lastChannel.current = channelId;
    lastScrollHeight.current = el.scrollHeight;
  });

  // The scroller is reused across channels, so its position carries over.
  useEffect(() => {
    lastScrollTop.current = scroller.current?.scrollTop ?? 0;
  }, [channelId]);

  // Reading the latest message marks the channel read.
  useEffect(() => {
    // Only reading the newest messages counts as catching up.
    if (timeline?.hasMoreNewer) return;
    if (pinnedToBottom.current && document.hasFocus()) client.markRead(channelId);
  }, [client, channelId, items.length, timeline?.hasMoreNewer]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (pinnedToBottom.current && document.hasFocus() && !timeline?.hasMoreNewer) {
      client.markRead(channelId);
    }

    // Page forward only when the user actively scrolls down to the bottom of
    // an anchored view — otherwise a window shorter than the viewport would
    // cascade through every page back to the tail on its own.
    const scrolledDown = el.scrollTop > lastScrollTop.current + 1;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    lastScrollTop.current = el.scrollTop;
    if (
      scrolledDown &&
      atBottom &&
      !settlingJump.current &&
      timeline?.hasMoreNewer &&
      !loadingNewer.current
    ) {
      loadingNewer.current = true;
      void client.loadNewer(channelId).finally(() => {
        loadingNewer.current = false;
      });
    }

    if (el.scrollTop < 400 && timeline?.hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      // A height delta cannot hold the position here: the page both prepends
      // above the viewport and may drop trimmed messages far below it, and only
      // the part above should move the scroll. Hold one message still instead.
      const anchor = topAnchor(el);
      void client.loadTimeline(channelId, { older: true }).finally(() => {
        requestAnimationFrame(() => {
          restoreAnchor(el, anchor);
          loadingOlder.current = false;
        });
      });
    }
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto pb-3">
      {!timeline?.hasMore && timeline?.loaded && <ChannelIntro channelId={channelId} />}
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
          <div
            key={msg.id}
            data-mid={msg.id}
            ref={msg.id === highlightMessageId ? highlightRef : undefined}
          >
            {newDay && <DayDivider ts={msg.createdAt} />}
            <MessageItem
              message={msg}
              compact={compact}
              onOpenThread={onOpenThread}
              onChannelClick={onChannelClick}
              onOpenImage={setLightboxFile}
              onOpenProfile={onOpenProfile}
              highlighted={msg.id === highlightMessageId}
            />
          </div>
        );
      })}
      {channelPending.map((p) => (
        <PendingRow key={p.nonce} pending={p} />
      ))}
      {(ephemerals ?? []).map((e) => (
        <EphemeralRow key={e.id} message={e} channelId={channelId} />
      ))}
      <div className="h-5 px-5 pt-1 text-[12px] italic text-ink-faint">
        {typers.length > 0 &&
          `${typers.slice(0, 3).join(", ")} ${typers.length === 1 ? "is" : "are"} typing…`}
      </div>
      {lightboxFile && <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}
    </div>
  );
}

/**
 * A slash command's private answer. Marked plainly as unshared, because the
 * worst thing this could do is let someone think the channel saw it.
 */
function EphemeralRow({ message, channelId }: { message: EphemeralMessage; channelId: ID }) {
  const client = useClient();
  const author = useWorkspace((s) => s.users[message.userId]);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  return (
    <div className="group flex gap-3 px-5 py-1.5">
      <div className="w-9 shrink-0" />
      <div className="min-w-0 flex-1 rounded-lg border border-dashed border-edge bg-raised/60 px-3 py-2">
        <div className="mb-0.5 flex items-center gap-2">
          {author && <span className="text-[13px] font-semibold">{author.displayName}</span>}
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            Only visible to you
          </span>
          <button
            onClick={() => client.dismissEphemeral(channelId, message.id)}
            className="ml-auto text-[11px] text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
        <div className="text-[15px] leading-relaxed text-ink-dim">
          <Mrkdwn text={message.text} users={users} channels={channels} />
        </div>
      </div>
    </div>
  );
}

/** Shown while the view is parked mid-history after a jump. */
export function JumpToLatestBar({ channelId }: { channelId: ID }) {
  const client = useClient();
  const anchored = useWorkspace((s) => s.timelines[channelId]?.hasMoreNewer ?? false);
  if (!anchored) return null;
  return (
    <div className="flex justify-center px-5 pb-1">
      <button
        onClick={() => void client.jumpToLatest(channelId)}
        className="rounded-full border border-copper/50 bg-copper/15 px-3 py-1 text-[12px] font-medium text-copper transition-colors hover:bg-copper/25"
      >
        You're viewing older messages · Jump to latest ↓
      </button>
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
          <PendingAttachments attachments={pending.attachments} progress={pending.uploadProgress} />
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
