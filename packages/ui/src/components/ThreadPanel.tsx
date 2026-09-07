import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileMeta, ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Composer } from "./Composer.js";
import { MessageItem } from "./MessageItem.js";
import { Lightbox, PendingAttachments } from "./Attachments.js";

interface Props {
  channelId: ID;
  rootId: ID;
  targetId?: ID;
  readActive?: boolean;
  onClose: () => void;
  onChannelClick: (id: ID) => void;
  onOpenProfile: (userId: ID) => void;
}

export function ThreadPanel({
  channelId,
  rootId,
  targetId,
  readActive = true,
  onClose,
  onChannelClick,
  onOpenProfile,
}: Props) {
  const client = useClient();
  const page = useWorkspace((s) => s.threadPages[rootId]);
  const root = useWorkspace((s) =>
    s.threadPages[rootId]?.loaded
      ? s.threadPages[rootId]!.root
      : (s.timelines[channelId]?.items.find((m) => m.id === rootId) ?? null),
  );
  const replies = useWorkspace((s) => s.threads[rootId]);
  const pending = useWorkspace((s) => s.pending).filter((p) => p.threadRootId === rootId);
  const [lightboxFile, setLightboxFile] = useState<FileMeta | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(!targetId);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const targetPositioned = useRef(false);
  const readContext = useRef<string | null>(null);
  const contextKey = `${channelId}:${rootId}:${targetId ?? ""}`;

  function readVisibleReplies() {
    if (
      readContext.current !== contextKey ||
      !readActive ||
      !page?.loaded ||
      page.loading ||
      page.hasMoreNewer ||
      !follow.current ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    client.markRead(
      channelId,
      Math.max(root?.seq ?? 0, ...(replies ?? []).map((message) => message.seq)),
    );
  }

  useEffect(() => {
    readVisibleReplies();
    window.addEventListener("focus", readVisibleReplies);
    document.addEventListener("visibilitychange", readVisibleReplies);
    return () => {
      window.removeEventListener("focus", readVisibleReplies);
      document.removeEventListener("visibilitychange", readVisibleReplies);
    };
  }, [client, channelId, replies, page?.loaded, page?.loading, page?.hasMoreNewer, readActive]);

  function load(direction: "latest" | "older" | "newer") {
    const container = scroller.current;
    if (direction === "latest") {
      follow.current = true;
      anchor.current = null;
    } else if (container) {
      const visible = [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
        (el) => el.getBoundingClientRect().bottom > container.getBoundingClientRect().top,
      );
      if (visible)
        anchor.current = { id: visible.dataset.reply!, top: visible.getBoundingClientRect().top };
      follow.current = false;
    }
    void client.loadThread(rootId, channelId, direction);
  }

  useEffect(() => {
    follow.current = !targetId;
    readContext.current = contextKey;
    targetPositioned.current = false;
    anchor.current = null;
    void client.loadThread(rootId, channelId, "latest", targetId);
  }, [client, rootId, channelId, targetId]);

  useLayoutEffect(() => {
    const container = scroller.current;
    if (!container) return;
    if (targetId && !targetPositioned.current && page?.loaded && !page.loading) {
      const target = [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
        (el) => el.dataset.reply === targetId,
      );
      if (target) {
        container.scrollTop +=
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          container.clientHeight / 2 +
          target.clientHeight / 2;
        targetPositioned.current = true;
        follow.current = false;
        return;
      }
    }
    if (anchor.current && !page?.loading) {
      const saved = anchor.current;
      const element = [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
        (el) => el.dataset.reply === saved.id,
      );
      if (element) container.scrollTop += element.getBoundingClientRect().top - saved.top;
      anchor.current = null;
    } else if (follow.current) container.scrollTop = container.scrollHeight;
  }, [replies, page?.loading, pending.length, targetId]);

  return (
    <aside
      aria-label="Thread"
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge bg-ground"
    >
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
      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          readVisibleReplies();
        }}
        className="min-h-0 flex-1 overflow-y-auto py-2"
        aria-busy={page?.loading}
      >
        {root && (
          <MessageItem
            message={root}
            compact={false}
            inThread
            onChannelClick={onChannelClick}
            onOpenImage={setLightboxFile}
            onOpenProfile={onOpenProfile}
          />
        )}
        {(replies?.length ?? 0) > 0 && (
          <div className="my-2 flex items-center gap-2 px-5">
            <span className="text-[11px] font-medium text-ink-faint">
              {replies!.length}
              {root && root.replyCount > replies!.length ? ` of ${root.replyCount}` : ""}{" "}
              {root?.replyCount === 1 ? "reply" : "replies"}
            </span>
            <div className="h-px flex-1 bg-edge" />
          </div>
        )}
        {page?.error && (
          <div role="alert" className="px-5 py-3 text-sm text-ink-dim">
            {page.error}{" "}
            <button
              className="text-copper underline"
              disabled={page.loading}
              onClick={() => load("latest")}
            >
              Retry
            </button>
          </div>
        )}
        {page?.loading && (
          <p role="status" className="px-5 py-2 text-sm text-ink-faint">
            Loading replies…
          </p>
        )}
        {page?.hasMoreOlder && (
          <button
            className="w-full px-5 py-2 text-sm text-copper disabled:opacity-50"
            disabled={page.loading}
            onClick={() => load("older")}
          >
            Load older replies
          </button>
        )}
        {page?.loaded && !page.error && !root && (
          <p className="px-5 py-3 text-sm text-ink-faint">The original message was deleted.</p>
        )}
        {page?.loaded && root && !replies?.length && (
          <p className="px-5 py-3 text-sm text-ink-faint">
            No replies yet. Start the conversation.
          </p>
        )}
        {(replies ?? []).map((msg, i) => {
          const prev = replies![i - 1];
          const compact =
            !!prev && prev.userId === msg.userId && msg.createdAt - prev.createdAt < 300_000;
          return (
            <div key={msg.id} data-reply={msg.id}>
              <MessageItem
                message={msg}
                highlighted={msg.id === targetId}
                compact={compact}
                inThread
                onChannelClick={onChannelClick}
                onOpenImage={setLightboxFile}
                onOpenProfile={onOpenProfile}
              />
            </div>
          );
        })}
        {page?.hasMoreNewer && (
          <div className="flex justify-center gap-4 py-2 text-sm text-copper">
            <button disabled={page.loading} onClick={() => load("newer")}>
              Load newer replies
            </button>
            <button disabled={page.loading} onClick={() => load("latest")}>
              Jump to latest
            </button>
          </div>
        )}
        {pending.map((p) => (
          <div key={p.nonce} className="px-5 py-1 text-[15px] opacity-60">
            {p.text}
            <PendingAttachments attachments={p.attachments} progress={p.uploadProgress} />
            <span className="ml-2 font-mono text-[11px] text-ink-faint">
              {p.failed ? (p.failureReason ?? "Could not send this reply.") : "sending…"}
            </span>
            {p.failed && (
              <div className="flex gap-3 text-xs text-copper">
                <button onClick={() => client.retrySend(p.nonce)}>Retry</button>
                <button onClick={() => client.discardSend(p.nonce)}>Discard</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {root && (
        <Composer channelId={channelId} threadRootId={rootId} placeholder="Reply…" autoFocus />
      )}
      {lightboxFile && <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}
    </aside>
  );
}
