import { useEffect, useState } from "react";
import { channelPermissions, type ID, type NotifyLevel } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

type Tab = "about" | "members" | "notifications";

const DEFAULT_PREFS = { notifyLevel: "mentions" as NotifyLevel, muted: false };

const LEVELS: { value: NotifyLevel; label: string; hint: string }[] = [
  { value: "all", label: "Every message", hint: "Notify me whenever anyone posts here." },
  { value: "mentions", label: "Mentions only", hint: "Only when someone @-mentions me." },
  { value: "nothing", label: "Nothing", hint: "Never notify me about this channel." },
];

/** Channel topic and description, plus who's in it. */
export function ChannelDetailsDialog(props: {
  channelId: ID;
  onClose: () => void;
  onLeft: () => void;
  onOpenProfile: (userId: ID) => void;
}) {
  const client = useClient();
  const channel = useWorkspace((s) => s.channels[props.channelId]);
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const self = useWorkspace((s) => s.self);
  const selfId = self?.id;
  const membership = useWorkspace((s) => s.memberships[props.channelId]);
  const [tab, setTab] = useState<Tab>("about");
  const [memberIds, setMemberIds] = useState<ID[]>([]);
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [name, setName] = useState(channel?.name ?? "");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [description, setDescription] = useState(channel?.description ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState(false);
  const [membersAttempt, setMembersAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setMembersError(false);
    void client.api
      .channelMembers(props.channelId)
      .then((r) => {
        if (active) setMemberIds(r.memberIds);
      })
      .catch(() => {
        if (active) setMembersError(true);
      });
    return () => {
      active = false;
    };
  }, [client, props.channelId, membersAttempt]);

  if (!channel) return null;
  const isRoom = channel.type === "public" || channel.type === "private";
  const permissions = channelPermissions(self ?? undefined, channel, !!membership);

  async function saveAbout(e: React.FormEvent) {
    e.preventDefault();
    if (!permissions.manage || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await client.api.updateChannel(props.channelId, { name: name.trim(), topic, description });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save channel details.");
    } finally {
      setBusy(false);
    }
  }

  async function addMember(userId: ID) {
    if (!permissions.invite || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.inviteMember(props.channelId, userId);
      setMemberIds((prev) => [...new Set([...prev, userId])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this person.");
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(archived: boolean) {
    if (!permissions.manage || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.updateChannel(props.channelId, { archived });
      setConfirmArchive(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change archive status.");
    } finally {
      setBusy(false);
    }
  }

  const notMembers = Object.values(users).filter(
    (u) => !memberIds.includes(u.id) && !u.deactivated && !u.isBot,
  );

  return (
    <Dialog
      title={isRoom ? `#${channel.name}` : "Conversation"}
      onClose={props.onClose}
      width={480}
    >
      {error && (
        <p role="alert" className="mb-3 text-sm text-alert">
          {error}
        </p>
      )}
      <div className="mb-4 flex gap-1 rounded-lg bg-ground p-1">
        {(["about", "members", "notifications"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t ? "bg-lifted text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            {t === "members"
              ? `Members (${memberIds.length})`
              : t === "notifications"
                ? "Notifications"
                : "About"}
          </button>
        ))}
      </div>

      {tab === "notifications" ? (
        <NotificationSettings channelId={props.channelId} />
      ) : tab === "about" ? (
        isRoom ? (
          <form onSubmit={saveAbout} className="space-y-3">
            <label className="block text-sm">
              Channel name
              <input
                aria-label="Channel name"
                className={inputCls}
                value={name}
                required
                maxLength={80}
                readOnly={!permissions.manage || busy}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
              />
            </label>
            {!permissions.manage && (
              <p className="text-sm text-ink-faint">
                Channel details are managed by its creator and workspace administrators.
              </p>
            )}
            <div>
              <label className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                Topic
              </label>
              <input
                aria-label="Channel topic"
                maxLength={250}
                value={topic}
                readOnly={!permissions.manage || busy}
                onChange={(e) => {
                  setTopic(e.target.value);
                  setSaved(false);
                }}
                placeholder="What's this channel about right now?"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                Description
              </label>
              <textarea
                aria-label="Channel description"
                maxLength={500}
                value={description}
                readOnly={!permissions.manage || busy}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setSaved(false);
                }}
                rows={3}
                placeholder="The longer story, shown to anyone who opens the channel."
                className={`${inputCls} resize-none`}
              />
            </div>
            <div className="flex items-center gap-3">
              {permissions.manage && (
                <button type="submit" disabled={busy} className={primaryBtnCls}>
                  {busy ? "Saving…" : saved ? "Saved" : "Save changes"}
                </button>
              )}
              {membership && channel.name !== "general" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await client.api.leaveChannel(props.channelId);
                      props.onLeft();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Could not leave channel.");
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim transition-colors hover:border-alert hover:text-alert"
                >
                  Leave channel
                </button>
              )}
            </div>
            <div className="rounded-lg border border-edge p-3 text-sm">
              <p className="mb-2 text-ink-dim">
                {channel.archived
                  ? "Archived. History remains available; new posts and replies are paused."
                  : "Archiving keeps history and drafts. Scheduled messages wait until the channel is reopened."}
              </p>
              {permissions.manage &&
                (channel.archived ? (
                  <button
                    type="button"
                    disabled={busy}
                    className={primaryBtnCls}
                    onClick={() => void setArchived(false)}
                  >
                    Reopen channel
                  </button>
                ) : confirmArchive ? (
                  <div>
                    <p className="mb-2">Archive #{channel.name} for everyone?</p>
                    <button
                      type="button"
                      disabled={busy}
                      className={primaryBtnCls}
                      onClick={() => void setArchived(true)}
                    >
                      Confirm archive
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="ml-3"
                      onClick={() => setConfirmArchive(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    className="text-alert underline"
                    onClick={() => setConfirmArchive(true)}
                  >
                    Archive channel
                  </button>
                ))}
            </div>
          </form>
        ) : (
          <p className="py-4 text-center text-sm text-ink-faint">
            Direct conversations have no topic to set.
          </p>
        )
      ) : tab === "members" ? (
        <div>
          {membersError && (
            <p role="alert" className="mb-3 text-sm text-alert">
              Could not load members.{" "}
              <button onClick={() => setMembersAttempt((n) => n + 1)} className="underline">
                Retry
              </button>
            </p>
          )}
          <ul className="mb-4 max-h-[260px] space-y-0.5 overflow-y-auto">
            {memberIds.map((id) => {
              const u = users[id];
              return (
                <li key={id}>
                  <button
                    onClick={() => props.onOpenProfile(id)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-lifted"
                  >
                    <Avatar user={u} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {u?.displayName ?? "unknown"}
                      {id === selfId && <span className="text-ink-faint"> (you)</span>}
                    </span>
                    {u?.statusEmoji && <span>{u.statusEmoji}</span>}
                    <span
                      className={`size-2 rounded-full ${
                        presence[id] === "online" ? "bg-online" : "bg-edge"
                      }`}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
          {permissions.invite && !membersError && notMembers.length > 0 && (
            <div>
              <div className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                Add someone
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {notMembers.map((u) => (
                  <li key={u.id}>
                    <button
                      onClick={() => addMember(u.id)}
                      disabled={busy}
                      className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-dim transition-colors hover:border-copper hover:text-ink"
                    >
                      + {u.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

function NotificationSettings({ channelId }: { channelId: ID }) {
  const client = useClient();
  // Select the stored value only — a fallback object built inside the selector
  // would be a new reference every render and spin the store subscription.
  const stored = useWorkspace((s) => s.prefs[channelId]);
  const prefs = stored ?? DEFAULT_PREFS;

  return (
    <div className="space-y-4">
      <fieldset className="space-y-1.5" disabled={prefs.muted}>
        <legend className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          Notify me about
        </legend>
        {LEVELS.map((level) => (
          <label
            key={level.value}
            className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
              prefs.notifyLevel === level.value
                ? "border-copper bg-copper/10"
                : "border-edge hover:border-ink-faint"
            } ${prefs.muted ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              type="radio"
              name="notify-level"
              checked={prefs.notifyLevel === level.value}
              onChange={() => client.setChannelPrefs(channelId, { notifyLevel: level.value })}
              className="mt-0.5 accent-copper"
            />
            <span>
              <span className="block text-sm font-medium">{level.label}</span>
              <span className="block text-xs text-ink-faint">{level.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-edge px-3 py-2.5">
        <input
          type="checkbox"
          checked={prefs.muted}
          onChange={(e) => client.setChannelPrefs(channelId, { muted: e.target.checked })}
          className="mt-0.5 accent-copper"
        />
        <span>
          <span className="block text-sm font-medium">Mute this channel</span>
          <span className="block text-xs text-ink-faint">
            It stays in your sidebar but never notifies you, and unread messages don't stand out.
          </span>
        </span>
      </label>
    </div>
  );
}
