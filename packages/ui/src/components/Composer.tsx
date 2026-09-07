import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ID, User } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { formatBytes } from "../lib/format.js";
import { formatScheduleTime, localDateTime, schedulePresets } from "../lib/schedule.js";
import { Icon } from "./Icon.js";
import { Mrkdwn } from "./Mrkdwn.js";
import {
  FormattingToolbar,
  formatText,
  formattingShortcut,
  MESSAGE_LIMIT,
} from "./FormattingToolbar.js";

interface Props {
  channelId: ID;
  threadRootId?: ID;
  placeholder: string;
  autoFocus?: boolean;
}

/** Something the @ picker can insert: a person, or the whole room. */
type Candidate =
  | { kind: "user"; user: User }
  | { kind: "broadcast"; token: "channel" | "here"; description: string };

const BROADCASTS = [
  { token: "channel" as const, description: "Everyone in this channel" },
  { token: "here" as const, description: "Everyone who is around now" },
];

/** Enter sends, Shift+Enter breaks the line, @ opens mention autocomplete. */
export function Composer({ channelId, threadRootId, placeholder, autoFocus }: Props) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const commands = useWorkspace((s) => s.commands);
  const selfId = useWorkspace((s) => s.self?.id);
  const channelType = useWorkspace((s) => s.channels[channelId]?.type);
  const isRoom = channelType === "public" || channelType === "private";
  // Threads keep their own draft slot so a channel draft isn't clobbered.
  const draftKey = threadRootId ? `${channelId}:${threadRootId}` : channelId;
  const savedDraft = useWorkspace((s) => s.drafts[draftKey] ?? "");
  const [text, setText] = useState(savedDraft);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [attached, setAttached] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customTime, setCustomTime] = useState("");
  const [scheduleNote, setScheduleNote] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const scheduleLock = useRef(false);
  const scheduleContext = useRef<object>({});
  const uploadController = useRef<AbortController | null>(null);
  const scheduleUploads = useRef(new WeakMap<File, ID>());
  const [preview, setPreview] = useState(false);
  const [attachmentNote, setAttachmentNote] = useState<string | null>(null);
  const autocompleteId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);
  const dragDepth = useRef(0);
  /** True once the user has edited this conversation's draft in this session. */
  const edited = useRef(false);

  // Switching conversations swaps in that conversation's draft and clears attachments.
  useEffect(() => {
    edited.current = false;
    setText(client.state.drafts[draftKey] ?? "");
    setAttached([]);
    setMentionQuery(null);
    setPreview(false);
    setAttachmentNote(null);
    setScheduleOpen(false);
    setCustomTime("");
    setScheduleNote(null);
    setScheduleError(null);
    setScheduling(false);
    scheduleLock.current = false;
    scheduleUploads.current = new WeakMap();
    scheduleContext.current = {};
    return () => {
      scheduleContext.current = {};
      uploadController.current?.abort();
    };
  }, [client, draftKey]);

  // Drafts load from disk asynchronously, so they can arrive after this mounts.
  // Adopt them only while the composer is untouched, never over live typing.
  useEffect(() => {
    if (!edited.current && savedDraft) setText(savedDraft);
  }, [savedDraft]);

  // Persist as the user types. Guarded by `edited` so a freshly mounted empty
  // composer can't blank out a draft that hasn't loaded yet.
  useEffect(() => {
    if (!edited.current || text === savedDraft) return;
    const timer = setTimeout(() => client.setDraft(draftKey, text), 250);
    return () => clearTimeout(timer);
  }, [client, draftKey, text, savedDraft]);

  // That debounce is cancelled by every keystroke, including the last one
  // before the composer unmounts or the conversation changes. This effect only
  // re-runs when the conversation does, so its cleanup still closes over the
  // conversation being left, while the refs hold what was typed into it.
  const typed = useRef({ text, savedDraft });
  typed.current = { text, savedDraft };
  useEffect(() => {
    return () => {
      if (edited.current && typed.current.text !== typed.current.savedDraft) {
        client.setDraft(draftKey, typed.current.text);
      }
    };
  }, [client, draftKey]);

  function addFiles(files: FileList | File[] | null) {
    if (!files || scheduleLock.current) return;
    const incoming = [...files];
    if (incoming.length > 0) {
      setAttachmentNote(
        attached.length + incoming.length > 10
          ? "A message can have up to 10 files. The extra files were not attached."
          : null,
      );
      setAttached((prev) => [...prev, ...incoming].slice(0, 10));
    }
  }

  useLayoutEffect(() => {
    if (!box.current) return;
    box.current.style.height = "auto";
    box.current.style.height = `${Math.min(box.current.scrollHeight, 220)}px`;
  }, [text]);

  function replaceSelection(
    replacement: string,
    start: number,
    end: number,
    selectionStart: number,
    selectionEnd = selectionStart,
  ) {
    if (scheduleLock.current) return;
    setText(text.slice(0, start) + replacement + text.slice(end));
    edited.current = true;
    setMentionQuery(null);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function format(marker: string, placeholderText: string, block = false) {
    const field = box.current;
    if (!field) return;
    const next = formatText(
      text,
      field.selectionStart,
      field.selectionEnd,
      marker,
      placeholderText,
      block,
    );
    replaceSelection(next.text, 0, text.length, next.selectionStart, next.selectionEnd);
  }

  function insertEmoji(emoji: string) {
    const start = box.current?.selectionStart ?? text.length;
    const end = box.current?.selectionEnd ?? start;
    replaceSelection(emoji, start, end, start + emoji.length);
  }

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus, channelId, threadRootId]);

  const candidates = useMemo((): Candidate[] => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    // A room-wide mention has no meaning in a DM, so it is not offered there.
    const rooms: Candidate[] = isRoom
      ? BROADCASTS.filter((b) => b.token.startsWith(q)).map((b) => ({ kind: "broadcast", ...b }))
      : [];
    const people: Candidate[] = Object.values(users)
      .filter((u) => !u.deactivated)
      .filter((u) => u.handle.includes(q) || u.displayName.toLowerCase().includes(q))
      .map((user) => ({ kind: "user", user }));
    return [...rooms, ...people].slice(0, 6);
  }, [mentionQuery, users, isRoom]);

  /**
   * Commands are offered only while the first word is still being typed —
   * once there is an argument the list would just be in the way.
   */
  const commandCandidates = useMemo(() => {
    const m = /^\/([a-zA-Z0-9_-]*)$/.exec(text);
    if (!m) return [];
    const q = m[1]!.toLowerCase();
    return commands.filter((c) => c.command.startsWith(q)).slice(0, 6);
  }, [text, commands]);

  function insertCommand(command: string) {
    if (scheduleLock.current) return;
    const next = `/${command} `;
    setText(next);
    edited.current = true;
    requestAnimationFrame(() => {
      box.current?.setSelectionRange(next.length, next.length);
      box.current?.focus();
    });
  }

  function refreshMentionState(value: string, caret: number) {
    const upToCaret = value.slice(0, caret);
    const m = /(^|\s)@([a-z0-9._-]*)$/i.exec(upToCaret);
    if (m) {
      setMentionQuery({ start: caret - m[2]!.length - 1, query: m[2]! });
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  function insertMention(candidate: Candidate) {
    if (scheduleLock.current) return;
    if (!mentionQuery || !box.current) return;
    const token = candidate.kind === "user" ? `<@${candidate.user.id}>` : `<!${candidate.token}>`;
    const caret = box.current.selectionStart;
    const next = `${text.slice(0, mentionQuery.start)}${token} ${text.slice(caret)}`;
    setText(next);
    setMentionQuery(null);
    edited.current = true;
    requestAnimationFrame(() => {
      const pos = mentionQuery.start + token.length + 1;
      box.current?.setSelectionRange(pos, pos);
      box.current?.focus();
    });
  }

  useEffect(() => setCommandIndex(0), [commandCandidates.length]);

  function send() {
    if (scheduleLock.current) return;
    const trimmed = text.trim();
    if ((!trimmed && attached.length === 0) || text.length > MESSAGE_LIMIT) return;
    client.send(channelId, trimmed, { threadRootId, files: attached });
    setText("");
    setAttached([]);
    setMentionQuery(null);
    setAttachmentNote(null);
    edited.current = false;
    client.setDraft(draftKey, "");
    if (box.current) box.current.style.height = "auto";
  }

  /** Queues the current draft for later instead of sending it now. */
  async function schedule(at: Date) {
    if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
      setScheduleError("Choose a date and time in the future.");
      return;
    }
    const trimmed = text.trim();
    if (scheduleLock.current || (!trimmed && attached.length === 0) || text.length > MESSAGE_LIMIT)
      return;
    scheduleLock.current = true;
    setScheduling(true);
    setScheduleOpen(false);
    setScheduleError(null);
    const context = scheduleContext.current;
    const controller = new AbortController();
    uploadController.current = controller;
    const current = () => scheduleContext.current === context;
    let submitted = false;
    // Keep the draft if the user leaves while the request is in flight.
    client.setDraft(draftKey, text);
    try {
      const fileIds: ID[] = [];
      for (const file of attached) {
        let id = scheduleUploads.current.get(file);
        if (!id) {
          const { file: uploaded } = await client.api.uploadFile(channelId, file, file.name, {
            signal: controller.signal,
          });
          if (!current()) return;
          id = uploaded.id;
          scheduleUploads.current.set(file, id);
        }
        fileIds.push(id);
      }
      if (!current()) return;
      submitted = true;
      await client.api.scheduleMessage(channelId, {
        text: trimmed,
        sendAt: at.getTime(),
        ...(threadRootId ? { threadRootId } : {}),
        ...(fileIds.length > 0 ? { fileIds } : {}),
      });
      if (!current()) return;
      setText("");
      setAttached([]);
      edited.current = false;
      client.setDraft(draftKey, "");
      scheduleUploads.current = new WeakMap();
      setScheduleNote(`Scheduled for ${formatScheduleTime(at.getTime())}`);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.code === "invalid_attachments")
        scheduleUploads.current = new WeakMap();
      setScheduleError(
        submitted
          ? "Could not confirm scheduling. Your draft is kept. Check Scheduled before trying again."
          : error instanceof ApiError && error.code === "file_too_large"
            ? "One of these files exceeds the workspace upload limit. Remove it and try again."
            : "Could not upload the attachments. Your draft is kept; try again when connected.",
      );
    } finally {
      if (current()) {
        scheduleLock.current = false;
        setScheduling(false);
        uploadController.current = null;
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter confirms an IME candidate; it must not send an unfinished message.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const marker = formattingShortcut(e.key);
      if (marker) {
        e.preventDefault();
        format(marker, "text");
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        send();
        return;
      }
    }
    if (commandCandidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex(
          (i) =>
            (i + (e.key === "ArrowDown" ? 1 : commandCandidates.length - 1)) %
            commandCandidates.length,
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertCommand(commandCandidates[commandIndex]!.command);
        return;
      }
      // Enter still sends: typing the whole name and hitting Enter should run
      // it, not pick something else off the list.
    }
    if (mentionQuery && candidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i + (e.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(candidates[mentionIndex]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      className="composer-shell relative shrink-0 px-5 pb-5"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        // Nested elements fire leave events; only the outermost one ends the drag.
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {!scheduling && commandCandidates.length > 0 && (
        <ul
          id={autocompleteId}
          role="listbox"
          aria-label="Commands"
          className="absolute bottom-full left-5 right-5 z-10 mb-1 overflow-hidden rounded-xl border border-edge bg-lifted shadow-xl"
        >
          {commandCandidates.map((c, i) => (
            <li
              key={c.command}
              id={`${autocompleteId}-${i}`}
              role="option"
              aria-selected={i === commandIndex}
            >
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => insertCommand(c.command)}
                onMouseEnter={() => setCommandIndex(i)}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
                  i === commandIndex ? "bg-copper/15" : ""
                }`}
              >
                <span className="font-mono text-copper">/{c.command}</span>
                {c.usageHint && (
                  <span className="font-mono text-xs text-ink-faint">{c.usageHint}</span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-ink-dim">
                  {c.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!scheduling && mentionQuery && candidates.length > 0 && (
        <ul
          id={autocompleteId}
          role="listbox"
          aria-label="Mentions"
          className="absolute bottom-full left-5 right-5 z-10 mb-1 overflow-hidden rounded-xl border border-edge bg-lifted shadow-xl"
        >
          {candidates.map((c, i) => (
            <li
              key={c.kind === "user" ? c.user.id : c.token}
              id={`${autocompleteId}-${i}`}
              role="option"
              aria-selected={i === mentionIndex}
            >
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => insertMention(c)}
                onMouseEnter={() => setMentionIndex(i)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
                  i === mentionIndex ? "bg-copper/15" : ""
                }`}
              >
                {c.kind === "user" ? (
                  <>
                    <Avatar user={c.user} size={22} />
                    <span className="font-medium">{c.user.displayName}</span>
                    <span className="font-mono text-xs text-ink-faint">@{c.user.handle}</span>
                    {c.user.id === selfId && <span className="text-xs text-ink-faint">(you)</span>}
                  </>
                ) : (
                  <>
                    <span className="flex size-[22px] items-center justify-center rounded bg-copper/25 text-[11px] font-bold text-copper">
                      @
                    </span>
                    <span className="font-medium">@{c.token}</span>
                    <span className="text-xs text-ink-faint">{c.description}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {scheduleError && (
        <p role="alert" className="mb-2 text-sm text-ink-dim">
          {scheduleError}
        </p>
      )}
      {scheduling && (
        <p role="status" className="mb-2 text-sm text-ink-faint">
          Scheduling your message…
        </p>
      )}
      {scheduleNote && (
        <p role="status" className="mb-2 text-sm text-ink-dim">
          {scheduleNote}
        </p>
      )}
      <fieldset
        disabled={scheduling}
        className={`min-w-0 rounded-xl border bg-raised shadow-[0_4px_20px_#0002] transition-colors ${
          dragging ? "border-copper bg-copper/5" : "border-edge focus-within:border-copper/60"
        }`}
      >
        <FormattingToolbar
          key={draftKey}
          onFormat={format}
          onInsert={insertEmoji}
          preview={preview}
          onTogglePreview={() => setPreview((v) => !v)}
        />
        {preview && (
          <div
            aria-label="Message preview"
            className="max-h-36 overflow-y-auto border-b border-edge px-4 py-3 text-sm"
          >
            {text.trim() ? (
              <Mrkdwn text={text} users={users} channels={channels} selfId={selfId} />
            ) : (
              <span className="text-ink-faint">Your formatted message will appear here.</span>
            )}
          </div>
        )}
        {attached.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-b border-edge p-2.5">
            {attached.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center gap-2 rounded-lg border border-edge bg-ground py-1 pl-2 pr-1 text-sm"
              >
                <span className="max-w-[180px] truncate">{f.name}</span>
                <span className="font-mono text-[11px] text-ink-faint">{formatBytes(f.size)}</span>
                <button
                  onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="rounded px-1 text-ink-faint transition-colors hover:text-alert"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          value={text}
          rows={1}
          placeholder={dragging ? "Drop files to attach" : placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={
            (mentionQuery && candidates.length) || commandCandidates.length
              ? autocompleteId
              : undefined
          }
          aria-activedescendant={
            mentionQuery && candidates.length
              ? `${autocompleteId}-${mentionIndex}`
              : commandCandidates.length
                ? `${autocompleteId}-${commandIndex}`
                : undefined
          }
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length > 0) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onChange={(e) => {
            edited.current = true;
            setText(e.target.value);
            refreshMentionState(e.target.value, e.target.selectionStart);
            const now = Date.now();
            if (now - lastTypingSent.current > 3000 && e.target.value.trim()) {
              lastTypingSent.current = now;
              client.sendTyping(channelId);
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setMentionQuery(null)}
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 py-3 text-[15px] outline-none placeholder:text-ink-faint"
        />
        {attachmentNote && (
          <p role="alert" className="px-4 pb-2 text-xs text-ink-dim">
            {attachmentNote}
          </p>
        )}
        {text.length > MESSAGE_LIMIT - 1000 && (
          <p
            aria-live="polite"
            className={`px-4 pb-2 text-right text-xs ${text.length > MESSAGE_LIMIT ? "text-alert" : "text-ink-faint"}`}
          >
            {text.length.toLocaleString()} / {MESSAGE_LIMIT.toLocaleString()} characters
            {text.length > MESSAGE_LIMIT ? " · Shorten your message to send it." : ""}
          </p>
        )}
        <div className="relative flex items-center justify-between px-2.5 pb-2">
          <span className="flex items-center gap-1">
            <button
              onClick={() => filePicker.current?.click()}
              title="Attach a file"
              aria-label="Attach a file"
              className="rounded-lg px-2 py-1 text-ink-faint transition-colors hover:bg-lifted hover:text-ink"
            >
              <Icon name="attach" />
            </button>
            {(text.trim() || attached.length > 0) && (
              <button
                onClick={() => setScheduleOpen((v) => !v)}
                title="Send later"
                aria-label="Send later"
                className={`rounded-lg px-2 py-1 transition-colors hover:bg-lifted hover:text-ink ${
                  scheduleOpen ? "text-copper" : "text-ink-faint"
                }`}
              >
                <Icon name="clock" />
              </button>
            )}
          </span>
          <span className="composer-hint ml-auto mr-3 text-[11px] text-ink-faint">
            {scheduleNote ??
              (text.trim() || attached.length > 0
                ? "Enter to send · Shift+Enter for a new line"
                : "")}
          </span>
          <button
            onClick={() => {
              send();
              box.current?.focus();
            }}
            disabled={(!text.trim() && attached.length === 0) || text.length > MESSAGE_LIMIT}
            aria-label="Send message"
            title="Send message (Enter)"
            className="flex items-center gap-2 rounded-lg bg-copper px-3 py-1.5 text-ground hover:bg-copper-deep disabled:bg-lifted disabled:text-ink-faint"
          >
            <Icon name="send" size={16} />
          </button>
          {scheduleOpen && (
            <ul className="absolute bottom-full left-2 z-20 mb-1 w-[220px] overflow-hidden rounded-xl border border-edge bg-lifted shadow-xl">
              <li className="border-b border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                Send later
              </li>
              {schedulePresets().map((p) => (
                <li key={p.label}>
                  <button
                    onClick={() => void schedule(p.at)}
                    className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-sm text-ink-dim transition-colors hover:bg-copper/15 hover:text-ink"
                  >
                    <span>{p.label}</span>
                    <span className="font-mono text-[10px] text-ink-faint">
                      {p.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </span>
                  </button>
                </li>
              ))}
              <li className="border-t border-edge p-3">
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void schedule(new Date(customTime));
                  }}
                >
                  <label className="block text-xs text-ink-faint">
                    Choose a date and time
                    <input
                      type="datetime-local"
                      required
                      value={customTime}
                      min={localDateTime(new Date())}
                      onChange={(e) => setCustomTime(e.target.value)}
                      className="mt-1 w-full min-w-0 rounded border border-edge bg-ground px-2 py-1 text-sm text-ink"
                    />
                  </label>
                  <p className="text-[10px] text-ink-faint">Uses your device's time zone.</p>
                  <button
                    type="submit"
                    disabled={!customTime}
                    className="text-xs text-copper disabled:opacity-40"
                  >
                    Schedule message
                  </button>
                </form>
              </li>
            </ul>
          )}
        </div>
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </fieldset>
    </div>
  );
}
