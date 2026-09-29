import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@slackoss/client-core";
import type { ID } from "@slackoss/protocol";
import { parseSearchQuery } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { useRecentSearches, type RecentSearch } from "../lib/recentSearches.js";
import { channelTitle, formatTime } from "../lib/format.js";
import { Dialog, inputCls } from "./Dialog.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { isImeKey } from "../lib/textInput.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { buttonClass } from "./Button.js";

const MODIFIER_HELP = [
  { token: "from:@name", what: "by one person" },
  { token: "in:#channel", what: "in one channel" },
  { token: "has:link", what: "contains a link" },
  { token: "has:file", what: "has an attachment" },
  { token: "after:2026-01-01", what: "after a day" },
  { token: "before:2026-02-01", what: "before a day" },
];

/** A YYYY-MM-DD day in the reader's own date style, without moving it a day. */
function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString(undefined, {
    timeZone: "UTC",
  });
}

/** Shows the modifiers, then what the current query was understood to mean. */
function SearchHints({ query }: { query: string }) {
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const chips: string[] = [
    ...parsed.from.map((h) => `from @${h}`),
    ...parsed.in.map((c) => `in #${c}`),
    ...parsed.has.map((h) => (h === "link" ? "has a link" : "has a file")),
    ...(parsed.afterDay ? [`after ${dayLabel(parsed.afterDay)}`] : []),
    ...(parsed.beforeDay ? [`before ${dayLabel(parsed.beforeDay)}`] : []),
  ];

  if (chips.length === 0 && parsed.invalid.length === 0) {
    return (
      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
        {MODIFIER_HELP.map((m) => (
          <span key={m.token}>
            <code className="font-mono text-copper">{m.token}</code> {m.what}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-ink-faint">Filtering:</span>
      {chips.map((c) => (
        <span key={c} className="rounded-full border border-edge px-2 py-0.5 text-copper">
          {c}
        </span>
      ))}
      {parsed.invalid.map((token) => (
        <span key={token} className="rounded-full border border-alert/40 px-2 py-0.5 text-alert">
          not a date: {token}
        </span>
      ))}
      {parsed.terms.length > 0 && (
        <span className="text-ink-faint">matching “{parsed.terms.join(" ")}”</span>
      )}
    </div>
  );
}

/** Full-text message search over the workspace. */
export function SearchDialog(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
  channelId?: ID | null;
}) {
  const client = useClient();
  const recent = useRecentSearches();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof client.api.search>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("");
  const [author, setAuthor] = useState("");
  const [has, setHas] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [submitted, setSubmitted] = useState<{ query: string; channelId?: ID } | null>(null);
  const highlightTerms = useMemo(
    () => parseSearchQuery(submitted?.query ?? "").terms,
    [submitted?.query],
  );
  const [cursors, setCursors] = useState<(ID | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const request = useRef<AbortController | null>(null);
  const failed = useRef<(() => void) | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const query = [
    q.trim(),
    author && `from:${author}`,
    has && `has:${has}`,
    after && `after:${after}`,
    before && `before:${before}`,
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => () => request.current?.abort(), []);

  async function search(
    criteria: { query: string; channelId?: ID },
    cursor: ID | undefined,
    nextPage: number,
    nextCursors: (ID | undefined)[],
  ) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    failed.current = () => {
      void search(criteria, cursor, nextPage, nextCursors);
    };
    setBusy(true);
    setError(null);
    try {
      const found = await client.api.search(criteria.query, 30, {
        cursor,
        channelId: criteria.channelId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResults(found);
      setSubmitted(criteria);
      setPage(nextPage);
      setCursors(nextCursors);
      if (nextPage === 0) recent.remember(criteria);
      list.current?.closest('[role="dialog"]')?.scrollTo({ top: 0 });
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof ApiError && err.code === "invalid_search_date"
            ? err.message
            : "Could not search this workspace. Check your connection and try again.",
        );
    } finally {
      if (request.current === controller && !controller.signal.aborted) setBusy(false);
    }
  }

  function run(e: React.FormEvent) {
    e.preventDefault();
    if ((!query && !scope) || query.length > 200) return;
    void search({ query, channelId: scope || undefined }, undefined, 0, [undefined]);
  }

  function repeat(entry: RecentSearch) {
    setQ(entry.query);
    setScope(entry.channelId ?? "");
    setAuthor("");
    setHas("");
    setAfter("");
    setBefore("");
    void search(entry, undefined, 0, [undefined]);
  }

  return (
    <Dialog title="Search messages" onClose={props.onClose} width={560}>
      <form onSubmit={run} className="mb-3 space-y-2">
        <div className="flex gap-2">
          <input
            autoFocus
            aria-label="Search messages"
            maxLength={200}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // A form submits on Enter from a text field, which would run the
              // search on the Enter that picked an input method's candidate.
              if (e.key === "Enter" && isImeKey(e.nativeEvent)) e.preventDefault();
            }}
            placeholder="Search every channel you can see"
            className={inputCls}
          />
          <button
            type="submit"
            className={buttonClass("primary")}
            disabled={busy || (!query && !scope) || query.length > 200}
          >
            Search
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-ink-faint">
            Conversation
            <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All conversations</option>
              {Object.values(channels).map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {channelTitle(ch, users, client.state.self?.id ?? "")}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-faint">
            From
            <select className={inputCls} value={author} onChange={(e) => setAuthor(e.target.value)}>
              <option value="">Anyone</option>
              {Object.values(users).map((user) => (
                <option key={user.id} value={user.handle}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-faint">
            Contains
            <select className={inputCls} value={has} onChange={(e) => setHas(e.target.value)}>
              <option value="">Anything</option>
              <option value="file">Files</option>
              <option value="link">Links</option>
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className="py-2 text-xs text-copper"
              onClick={() => {
                setScope("");
                setAuthor("");
                setHas("");
                setAfter("");
                setBefore("");
              }}
            >
              Clear filters
            </button>
          </div>
          <label className="min-w-0 text-xs text-ink-faint">
            After
            <input
              type="date"
              className={inputCls}
              value={after}
              onChange={(e) => setAfter(e.target.value)}
            />
          </label>
          <label className="min-w-0 text-xs text-ink-faint">
            Before
            <input
              type="date"
              className={inputCls}
              value={before}
              onChange={(e) => setBefore(e.target.value)}
            />
          </label>
        </div>
        {props.channelId && scope !== props.channelId && (
          <button
            type="button"
            className="text-xs text-copper"
            onClick={() => setScope(props.channelId!)}
          >
            Search this conversation
          </button>
        )}
        {query.length > 200 && (
          <p role="alert" className="text-xs text-ink-dim">
            Shorten the search or remove a filter (200 characters maximum).
          </p>
        )}
      </form>
      {(recent.items.length > 0 || recent.error) && (
        <details open={!results} className="mb-3 rounded-lg border border-edge p-3">
          <summary className="cursor-pointer text-sm font-medium">Recent searches</summary>
          <div className="mb-2 mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
            <span>Saved on this device for this account and workspace.</span>
            <button
              disabled={busy || recent.busy}
              className="shrink-0 text-copper underline disabled:opacity-40"
              onClick={recent.clear}
            >
              Clear recent searches
            </button>
          </div>
          {recent.error && (
            <p role="status" className="mb-2 text-xs text-ink-dim">
              {recent.error}
            </p>
          )}
          <ul aria-label="Recent searches" className="space-y-1">
            {recent.items.map((entry) => {
              const channel = entry.channelId ? channels[entry.channelId] : undefined;
              const scopeLabel = entry.channelId
                ? channel
                  ? channelTitle(channel, users, client.state.self?.id ?? "")
                  : "Unavailable conversation"
                : "All conversations";
              return (
                <li
                  key={JSON.stringify([entry.query, entry.channelId])}
                  className="flex items-center gap-2"
                >
                  <button
                    disabled={busy || (!!entry.channelId && !channel)}
                    className="min-w-0 flex-1 rounded px-2 py-1 text-left text-sm hover:bg-lifted disabled:opacity-40"
                    onClick={() => repeat(entry)}
                  >
                    <span className="block truncate">{entry.query || "All messages"}</span>
                    <span className="block truncate text-xs text-ink-faint">{scopeLabel}</span>
                  </button>
                  <button
                    disabled={recent.busy}
                    aria-label={`Remove recent search: ${entry.query || "All messages"} (${scopeLabel})`}
                    className="rounded p-1.5 text-ink-faint hover:bg-lifted hover:text-ink disabled:opacity-40"
                    onClick={() => recent.remove(entry)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <SearchHints query={query} />
      {results && (
        <p role="status" className="mb-2 text-xs text-ink-faint">
          {results.messages.length} results · Page {page + 1} · Newest first
          {submitted?.query ? ` · “${submitted.query}”` : ""}
        </p>
      )}
      <ListStatus
        loading={busy}
        placeholder={!results}
        loadingLabel="Searching…"
        error={error}
        onRetry={() => failed.current?.()}
        empty={results?.messages.length === 0 ? "Nothing matched. Try different words." : null}
      />
      {results && (
        <>
          <ul
            ref={list}
            className="space-y-2"
            aria-busy={busy}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const buttons = [
                ...(list.current?.querySelectorAll<HTMLButtonElement>("[data-search-open]") ?? []),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (index < 0) return;
              e.preventDefault();
              buttons[
                Math.max(0, Math.min(buttons.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))
              ]?.focus();
            }}
          >
            {results.messages
              .filter((m) => !!channels[m.channelId])
              .map((m) => {
                const ch = channels[m.channelId];
                return (
                  <li key={m.id} className="rounded-lg border border-edge bg-ground p-3">
                    <div className="mb-1 flex items-baseline gap-2 text-[12px] text-ink-faint">
                      <span className="font-medium text-copper">
                        {ch
                          ? channelTitle(ch, users, client.state.self?.id ?? "")
                          : "Unavailable conversation"}
                      </span>
                      <span>{users[m.userId]?.displayName}</span>
                      <time
                        dateTime={new Date(m.createdAt).toISOString()}
                        className="ml-auto text-right"
                      >
                        {new Date(m.createdAt).toLocaleDateString()} {formatTime(m.createdAt)}
                      </time>
                    </div>
                    <div className="text-sm">
                      <Mrkdwn
                        text={m.text}
                        users={users}
                        channels={channels}
                        highlightTerms={highlightTerms}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
                      <span>
                        {m.threadRootId ? "Thread reply" : "Message"}
                        {m.files.length > 0
                          ? ` · ${m.files.length} attachment${m.files.length === 1 ? "" : "s"}`
                          : ""}
                      </span>
                      <button
                        data-search-open
                        className="text-copper underline"
                        disabled={busy || !ch}
                        onClick={() => props.onJump(m.channelId, m.id)}
                      >
                        Open in conversation
                      </button>
                    </div>
                  </li>
                );
              })}
          </ul>
          <div className="mt-4 flex justify-between text-sm text-copper">
            <button
              disabled={busy || page === 0}
              onClick={() =>
                submitted &&
                void search(submitted, cursors[page - 1], page - 1, cursors.slice(0, page))
              }
            >
              Previous page
            </button>
            <button
              disabled={busy || !results.nextCursor}
              onClick={() =>
                submitted &&
                results.nextCursor &&
                void search(submitted, results.nextCursor, page + 1, [
                  ...cursors,
                  results.nextCursor,
                ])
              }
            >
              Next page
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
