import { useState } from "react";
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
  if (!user) return null;

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
      {user.id !== selfId && (
        <button
          onClick={async () => {
            const channel = await client.openDm([user.id]);
            props.onOpenDm(channel.id);
          }}
          className={`${primaryBtnCls} mt-4 w-full`}
        >
          Message {user.displayName}
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

/** Edit your own name and status. */
export function EditProfileDialog(props: { onClose: () => void }) {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const [displayName, setDisplayName] = useState(self?.displayName ?? "");
  const [statusEmoji, setStatusEmoji] = useState(self?.statusEmoji ?? "");
  const [statusText, setStatusText] = useState(self?.statusText ?? "");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await client.api.updateMe({
        displayName: displayName.trim() || self?.handle || "",
        statusEmoji: statusEmoji.trim(),
        statusText: statusText.trim(),
      });
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Your profile" onClose={props.onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar user={self ?? undefined} size={48} />
          <div className="min-w-0 flex-1">
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint">
              Display name
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            Status
          </label>
          <div className="flex gap-2">
            <input
              value={statusEmoji}
              onChange={(e) => setStatusEmoji(e.target.value)}
              placeholder="🙂"
              className={`${inputCls} w-16 text-center`}
            />
            <input
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
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
                }}
                className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint transition-colors hover:border-alert hover:text-alert"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <button type="submit" disabled={busy} className={`${primaryBtnCls} w-full`}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </Dialog>
  );
}
