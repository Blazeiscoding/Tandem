import { Fragment, type ReactNode } from "react";
import type { ID, User } from "@slackoss/protocol";
import type { Channel } from "@slackoss/protocol";

interface Props {
  text: string;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  selfId?: ID;
  onChannelClick?: (id: ID) => void;
}

/**
 * Renders Slack-mrkdwn-compatible message text:
 * ```blocks```, `code`, *bold*, _italic_, ~strike~, <@USER>, <#CHANNEL>, URLs.
 */
export function Mrkdwn({ text, users, channels, selfId, onChannelClick }: Props) {
  const blocks = text.split(/```/);
  return (
    <span className="whitespace-pre-wrap break-words leading-[1.45]">
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="my-1 block overflow-x-auto rounded-md border border-edge bg-ground px-3 py-2 font-mono text-[13px]"
          >
            {block.replace(/^\n/, "")}
          </code>
        ) : (
          <Fragment key={i}>
            {renderInline(block, { users, channels, selfId, onChannelClick })}
          </Fragment>
        ),
      )}
    </span>
  );
}

// The escape alternative has to come first: it consumes "\_" before the italic
// rule can pair that underscore with a later one. Without it ¯\_(ツ)_/¯ arrives
// italicised and missing both underscores.
const INLINE_RE =
  /(\\[*_~`\\])|(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)|(<@[A-Za-z0-9_-]+>)|(<#[A-Za-z0-9_-]+>)|(https?:\/\/[^\s<>]+)/g;

function renderInline(
  text: string,
  ctx: Pick<Props, "users" | "channels" | "selfId" | "onChannelClick">,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      // An escaped formatting character is simply that character.
      out.push(tok.slice(1));
    } else if (m[2]) {
      out.push(
        <code
          key={key++}
          className="rounded bg-lifted px-1 py-px font-mono text-[13px] text-copper"
        >
          {tok.slice(1, -1)}
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
      out.push(
        <a
          key={key++}
          href={tok}
          target="_blank"
          rel="noreferrer"
          className="text-copper underline decoration-copper/40 hover:decoration-copper"
        >
          {tok}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
