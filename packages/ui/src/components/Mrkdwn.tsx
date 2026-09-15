import { Fragment, useContext, type ReactNode } from "react";
import { broadcastLabel, type ID, type User } from "@slackoss/protocol";
import type { Channel } from "@slackoss/protocol";
import { OpenMessageContext } from "../context.js";
import { parseDeepLink } from "../lib/deeplink.js";

interface Props {
  text: string;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  selfId?: ID;
  onChannelClick?: (id: ID) => void;
  highlightTerms?: readonly string[];
}

/**
 * Renders Slack-mrkdwn-compatible message text:
 * ```blocks```, `code`, *bold*, _italic_, ~strike~, <@USER>, <#CHANNEL>, URLs.
 */
export function Mrkdwn({
  text,
  users,
  channels,
  selfId,
  onChannelClick,
  highlightTerms = [],
}: Props) {
  const openMessage = useContext(OpenMessageContext);
  const blocks = text.split(/```/);
  const terms = [...new Set(highlightTerms.filter((term) => term.trim().length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = terms.length
    ? new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu")
    : null;
  const highlight = (value: string): ReactNode => {
    if (!pattern) return value;
    const parts: ReactNode[] = [];
    let previous = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > previous) parts.push(value.slice(previous, match.index));
      parts.push(
        <mark key={match.index} className="rounded-sm bg-copper/25 text-ink">
          {match[0]}
        </mark>,
      );
      previous = match.index + match[0].length;
    }
    if (previous < value.length) parts.push(value.slice(previous));
    return parts;
  };
  return (
    <span className="whitespace-pre-wrap break-words leading-[1.45]">
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="my-1 block overflow-x-auto rounded-md border border-edge bg-ground px-3 py-2 font-mono text-[13px]"
          >
            {highlight(trimAtFences(block, true, true))}
          </code>
        ) : (
          <Fragment key={i}>
            {renderInline(trimAtFences(block, i > 0, i < blocks.length - 1), {
              users,
              channels,
              selfId,
              onChannelClick,
              openMessage,
              highlight,
            })}
          </Fragment>
        ),
      )}
    </span>
  );
}

/**
 * A code block is a block of its own, so the line break people type against a
 * fence, just inside or just outside it, would otherwise draw a blank line.
 */
function trimAtFences(text: string, afterFence: boolean, beforeFence: boolean): string {
  let trimmed = text;
  if (afterFence && trimmed.startsWith("\n")) trimmed = trimmed.slice(1);
  if (beforeFence && trimmed.endsWith("\n")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

// The escape alternative has to come first: it consumes "\_" before the italic
// rule can pair that underscore with a later one. Without it ¯\_(ツ)_/¯ arrives
// italicised and missing both underscores.
const INLINE_RE =
  /(\\[*_~`\\])|(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)|(<@[A-Za-z0-9_-]+>)|(<#[A-Za-z0-9_-]+>)|(<!(?:channel|here|everyone)>)|(https?:\/\/[^\s<>]+)/g;

function renderInline(
  text: string,
  ctx: Pick<Props, "users" | "channels" | "selfId" | "onChannelClick"> & {
    openMessage?: ((channelId: ID, messageId: ID) => void) | null;
    highlight: (value: string) => ReactNode;
  },
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(ctx.highlight(text.slice(last, m.index)));
    const tok = m[0];
    if (m[1]) {
      // An escaped formatting character is simply that character.
      out.push(ctx.highlight(tok.slice(1)));
    } else if (m[2]) {
      out.push(
        <code
          key={key++}
          className="rounded bg-lifted px-1 py-px font-mono text-[13px] text-copper"
        >
          {ctx.highlight(tok.slice(1, -1))}
        </code>,
      );
    } else if (m[3]) {
      out.push(<strong key={key++}>{renderInline(tok.slice(1, -1), ctx)}</strong>);
    } else if (m[4]) {
      out.push(<em key={key++}>{renderInline(tok.slice(1, -1), ctx)}</em>);
    } else if (m[5]) {
      out.push(<s key={key++}>{renderInline(tok.slice(1, -1), ctx)}</s>);
    } else if (m[6]) {
      const id = tok.slice(2, -1);
      const user = ctx.users[id];
      const isMe = id === ctx.selfId;
      out.push(
        <span
          key={key++}
          className={`rounded px-1 font-medium ${isMe ? "bg-copper/30 text-copper" : "bg-mention text-copper"}`}
        >
          @{user?.displayName ?? "unknown"}
        </span>,
      );
    } else if (m[7]) {
      const id = tok.slice(2, -1);
      const ch = ctx.channels[id];
      out.push(
        <button
          key={key++}
          type="button"
          onClick={() => ctx.onChannelClick?.(id)}
          className="rounded bg-mention px-1 font-medium text-copper hover:underline"
        >
          #{ch?.name ?? "unknown"}
        </button>,
      );
    } else if (m[8]) {
      // A room-wide mention. Always styled as addressing you, because it is.
      out.push(
        <span
          key={key++}
          className="rounded bg-copper/30 px-1 font-medium text-copper"
          title={
            tok === "<!here>"
              ? "Everyone in this channel who is around now"
              : "Everyone in this channel"
          }
        >
          {broadcastLabel(tok.slice(2, -1))}
        </span>,
      );
    } else if (m[9]) {
      // A link to a message in this workspace opens it here, instead of in a
      // new window of the app. A click asking for a new tab or window still
      // gets one.
      const link = parseDeepLink(tok);
      const { openMessage } = ctx;
      const openHere =
        openMessage && link?.kind === "message" && ctx.channels[link.channelId]
          ? (event: React.MouseEvent) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              openMessage(link.channelId, link.messageId);
            }
          : undefined;
      out.push(
        <a
          key={key++}
          href={tok}
          target="_blank"
          rel="noreferrer"
          onClick={openHere}
          className="text-copper underline decoration-copper/40 hover:decoration-copper"
        >
          {ctx.highlight(tok)}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(ctx.highlight(text.slice(last)));
  return out;
}
