import { useId, useState } from "react";
import { ApiError } from "@slackoss/client-core";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";
import { FriendActions } from "./FriendsDialog.js";

/** Someone else's profile, with a shortcut to open a DM with them. */
export function ProfileDialog(props: {
  userId: ID;
  onClose: () => void;
  onOpenDm: (channelId: ID) => void;
}) {
  const client = useClient();
  const user = useWorkspace((s) => s.users[props.userId]);
  const presence = useWorkspace((s) => s.presence[props.userId] ?? "offline");
  const selfId = useWorkspace((s) => s.self?.id);
  const [opening, setOpening] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  if (!user) return null;

  async function message(userId: ID, name: string) {
    if (opening) return;
    setOpening(true);
    setDmError(null);
    try {
      const channel = await client.openDm([userId]);
      props.onOpenDm(channel.id);
    } catch {
      setDmError(
        `Could not open a conversation with ${name}. Check your connection and try again.`,
      );
    } finally {
      setOpening(false);
    }
  }

  return (
    <Dialog title="Profile" onClose={props.onClose}>
      <div className="flex items-center gap-4">
        <Avatar user={user} size={64} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-lg font-bold">{user.displayName}</h3>
            {user.role !== "member" && (
              <span className="rounded-full border border-edge px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-copper">
                {user.role}
              </span>
            )}
          </div>
          <div className="font-mono text-sm text-ink-faint">@{user.handle}</div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-dim">
            <span
              className={`size-2 rounded-full ${presence === "online" ? "bg-online" : "bg-edge"}`}
            />
            {presence === "online" ? "Active now" : "Away"}
          </div>
        </div>
      </div>

      {(user.statusEmoji || user.statusText) && (
        <p className="mt-4 rounded-lg border border-edge bg-ground px-3 py-2 text-sm">
          {user.statusEmoji && <span className="mr-1.5">{user.statusEmoji}</span>}
          {user.statusText}
        </p>
      )}

      {user.id !== selfId && !user.isBot && (
        <div className="mt-4">
          <FriendActions userId={user.id} />
        </div>
      )}
      {user.id !== selfId && dmError && (
        <p role="alert" className="mt-4 text-sm text-alert">
          {dmError}
        </p>
      )}
      {user.id !== selfId && (
        <button
          // Not `disabled`, so focus stays on the button while it works and it can try again.
          aria-disabled={opening || undefined}
          onClick={() => void message(user.id, user.displayName)}
          className={`${primaryBtnCls} mt-4 w-full aria-disabled:opacity-60`}
        >
          {opening ? "Opening…" : `Message ${user.displayName}`}
        </button>
      )}
    </Dialog>
  );
}

const STATUS_PRESETS = [
  { emoji: "💬", text: "In a meeting" },
  { emoji: "🎧", text: "Heads down" },
  { emoji: "🍜", text: "Out for lunch" },
  { emoji: "🌴", text: "On holiday" },
  { emoji: "🤒", text: "Off sick" },
];

/** Edit your own name and status, in Account settings. */
export function ProfileForm() {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const [displayName, setDisplayName] = useState(self?.displayName ?? "");
  const [statusEmoji, setStatusEmoji] = useState(self?.statusEmoji ?? "");
  const [statusText, setStatusText] = useState(self?.statusText ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const id = useId();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await client.api.updateMe({
        displayName: displayName.trim() || self?.handle || "",
        statusEmoji: statusEmoji.trim(),
        statusText: statusText.trim(),
      });
      setSaved(true);
    } catch (err) {
      // What was typed stays in the form, so saving again is one press.
      setError(
        err instanceof ApiError && err.code === "invalid_request"
          ? "Your profile was not saved. A display name can be up to 80 characters and a status up to 120."
          : err instanceof ApiError && err.code === "unauthorized"
            ? "Your session has ended. Sign in again to change your profile."
            : "Your profile was not saved. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={save}
      // A change after saving is not saved yet, so the confirmation goes.
      onChange={() => setSaved(false)}
      aria-label="Your profile"
      className="space-y-4"
    >
      <div className="flex items-center gap-3">
        <Avatar user={self ?? undefined} size={48} />
        <div className="min-w-0 flex-1">
          <label
            htmlFor={`${id}-display-name`}
            className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint"
          >
            Display name
          </label>
          <input
            id={`${id}-display-name`}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80}
            className={inputCls}
          />
        </div>
      </div>

      <fieldset>
        <legend className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          Status
        </legend>
        <div className="flex gap-2">
          <input
            aria-label="Status emoji"
            value={statusEmoji}
            onChange={(e) => setStatusEmoji(e.target.value)}
            maxLength={32}
            placeholder="🙂"
            className={`${inputCls} w-16 text-center`}
          />
          <input
            aria-label="Status text"
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            maxLength={120}
            placeholder="What's happening?"
            className={inputCls}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STATUS_PRESETS.map((p) => (
            <button
              key={p.text}
              type="button"
              onClick={() => {
                setStatusEmoji(p.emoji);
                setStatusText(p.text);
                setSaved(false);
              }}
              className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-dim transition-colors hover:border-copper hover:text-ink"
            >
              {p.emoji} {p.text}
            </button>
          ))}
          {(statusEmoji || statusText) && (
            <button
              type="button"
              onClick={() => {
                setStatusEmoji("");
                setStatusText("");
                setSaved(false);
              }}
              className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint transition-colors hover:border-alert hover:text-alert"
            >
              Clear
            </button>
          )}
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      {/* Always present, so the confirmation is announced when it appears. */}
      <p role="status" className="text-sm text-online empty:hidden">
        {saved ? "Profile saved." : ""}
      </p>
      <button type="submit" disabled={busy} className={`${primaryBtnCls} w-full`}>
        {busy ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
