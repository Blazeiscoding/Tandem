import { useEffect, useState } from "react";
import {
  channelPermissions,
  canRemoveChannelMember,
  canSetChannelManager,
  type ID,
  type NotifyLevel,
} from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { useTabs } from "../lib/useTabs.js";
import { Avatar } from "./Avatar.js";
import { Dialog, inputCls } from "./Dialog.js";
import { ListStatus } from "./ListStatus.js";
import { buttonClass } from "./Button.js";

type Tab = "about" | "members" | "notifications";
const TABS: readonly Tab[] = ["about", "members", "notifications"];

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
  onChangeParticipants: (memberIds: ID[]) => void;
}) {
  const client = useClient();
  const channel = useWorkspace((s) => s.channels[props.channelId]);
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const self = useWorkspace((s) => s.self);
  const selfId = self?.id;
  const membership = useWorkspace((s) => props.channelId in s.memberships);
  const [tab, setTab] = useState<Tab>("about");
  const tabs = useTabs({ label: "Channel details", tabs: TABS, selected: tab, onSelect: setTab });
  const [memberIds, setMemberIds] = useState<ID[]>([]);
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [name, setName] = useState(channel?.name ?? "");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [description, setDescription] = useState(channel?.description ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState(false);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersAttempt, setMembersAttempt] = useState(0);
  const [removingId, setRemovingId] = useState<ID | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [managerChange, setManagerChange] = useState<{ userId: ID; manager: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    setMembersLoading(true);
    void client.api
      .channelMembers(props.channelId)
      .then((r) => {
        if (active) {
          setMemberIds(r.memberIds);
          setMembersLoaded(true);
          setMembersError(false);
        }
      })
      .catch(() => {
        if (active) setMembersError(true);
      })
      .finally(() => {
        if (active) setMembersLoading(false);
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

  async function removeMember(userId: ID) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.removeChannelMember(props.channelId, userId);
      setMemberIds((ids) => ids.filter((id) => id !== userId));
      setRemovingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove this person.");
    } finally {
      setBusy(false);
    }
  }

  async function changeManager(userId: ID, manager: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.api.setChannelManager(props.channelId, userId, manager);
      setManagerChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change channel manager.");
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
      <div {...tabs.listProps} className="mb-4 flex gap-1 rounded-lg bg-ground p-1">
        {TABS.map((t) => (
          <button
            key={t}
            {...tabs.tabProps(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t ? "bg-lifted text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            {t === "members"
              ? membersLoaded
                ? `Members (${memberIds.length})`
                : "Members"
              : t === "notifications"
                ? "Notifications"
                : "About"}
          </button>
        ))}
      </div>

      <div {...tabs.panelProps}>
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
                  Channel details are managed by its creator, channel managers and workspace
                  administrators.
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
                  <button type="submit" disabled={busy} className={buttonClass("primary")}>
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
                      className={buttonClass("primary")}
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
                        className={buttonClass("primary")}
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
            {!isRoom && membership && (
              <div className="mb-3 text-sm">
                <p className="mb-2 text-ink-dim">
                  Changing participants opens a conversation for the selected people. This
                  conversation's history stays here.
                </p>
                <button
                  disabled={busy || membersLoading || membersError}
                  className={buttonClass("primary")}
                  onClick={() => props.onChangeParticipants(memberIds)}
                >
                  Change participants
                </button>
              </div>
            )}
            {channel.type === "group_dm" && membership && (
              <div className="mb-3 text-sm">
                {confirmLeave ? (
                  <>
                    <p className="mb-2 text-ink-dim">
                      Leave this group conversation? You will lose access to its history and call.
                      Other participants keep their history. Starting again with these people will
                      not restore access to this history.
                    </p>
                    <button
                      disabled={busy}
                      className="text-alert underline"
                      onClick={async () => {
                        setBusy(true);
                        setError(null);
                        try {
                          await client.api.leaveChannel(props.channelId);
                          props.onLeft();
                        } catch (err) {
                          setError(
                            err instanceof Error ? err.message : "Could not leave conversation.",
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Confirm leave
                    </button>
                    <button disabled={busy} className="ml-3" onClick={() => setConfirmLeave(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="text-alert underline"
                    disabled={busy}
                    onClick={() => setConfirmLeave(true)}
                  >
                    Leave group conversation
                  </button>
                )}
              </div>
            )}
            <button
              disabled={membersLoading || busy}
              onClick={() => setMembersAttempt((n) => n + 1)}
              className="mb-3 text-sm underline"
            >
              Refresh members
            </button>
            <ListStatus
              loading={membersLoading}
              placeholder={!membersLoaded}
              loadingLabel="Loading members…"
              error={
                membersError ? "Could not load members. Check your connection and try again." : null
              }
              onRetry={() => setMembersAttempt((n) => n + 1)}
              empty={
                membersLoaded && !membersError && memberIds.length === 0
                  ? "No members were returned. Refresh to check this conversation."
                  : null
              }
            />
            <ul
              aria-label="Channel members"
              aria-busy={membersLoading}
              className="mb-4 max-h-[260px] space-y-0.5 overflow-y-auto"
            >
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
                        {id === channel.creatorId && (
                          <span className="ml-2 text-xs text-ink-faint">Creator</span>
                        )}
                        {channel.managerIds?.includes(id) && (
                          <span className="ml-2 text-xs text-copper">Channel manager</span>
                        )}
                      </span>
                      {u?.statusEmoji && <span>{u.statusEmoji}</span>}
                      <span
                        className={`size-2 rounded-full ${
                          presence[id] === "online" ? "bg-online" : "bg-edge"
                        }`}
                      />
                    </button>
                    {channel.managerIds !== undefined &&
                      canSetChannelManager(
                        self ?? undefined,
                        u,
                        channel,
                        !!membership,
                        !channel.managerIds.includes(id),
                      ) &&
                      (managerChange?.userId === id ? (
                        <div className="mb-2 rounded-lg border border-edge p-3 text-sm">
                          <p className="mb-2">
                            {managerChange.manager
                              ? `Make ${u?.displayName} a manager of #${channel.name}? They can edit, rename and archive this room and remove ordinary members. They cannot appoint other managers.`
                              : `Remove ${u?.displayName}'s manager role? They remain a member of this channel.`}
                          </p>
                          <button
                            disabled={busy || membersLoading || membersError}
                            className="text-copper underline"
                            onClick={() => void changeManager(id, managerChange.manager)}
                          >
                            Confirm role change
                          </button>
                          <button
                            disabled={busy}
                            className="ml-3"
                            onClick={() => setManagerChange(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          disabled={busy || membersLoading || membersError}
                          className="mb-2 ml-2 text-xs text-copper underline"
                          aria-label={`${channel.managerIds.includes(id) ? "Remove manager role from" : "Make channel manager:"} ${u?.displayName}`}
                          onClick={() => {
                            setRemovingId(null);
                            setManagerChange({
                              userId: id,
                              manager: !channel.managerIds?.includes(id),
                            });
                          }}
                        >
                          {channel.managerIds.includes(id)
                            ? "Remove manager role"
                            : "Make channel manager"}
                        </button>
                      ))}
                    {canRemoveChannelMember(self ?? undefined, u, channel, !!membership) &&
                      (removingId === id ? (
                        <div className="mb-2 rounded-lg border border-edge p-3 text-sm">
                          <p className="mb-2">
                            Remove {u?.displayName} from #{channel.name}?{" "}
                            {channel.type === "public"
                              ? "This public channel remains readable, and they can rejoin."
                              : "They will lose access to this private channel and its call until invited back."}{" "}
                            Their messages remain.
                          </p>
                          <button
                            disabled={busy || membersLoading || membersError}
                            onClick={() => void removeMember(id)}
                            className="text-alert underline"
                          >
                            Confirm removal
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => setRemovingId(null)}
                            className="ml-3"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          disabled={busy || membersLoading || membersError}
                          aria-label={`Remove ${u?.displayName}`}
                          onClick={() => {
                            setManagerChange(null);
                            setRemovingId(id);
                          }}
                          className="mb-2 ml-2 text-xs text-alert underline"
                        >
                          Remove
                        </button>
                      ))}
                  </li>
                );
              })}
            </ul>
            {permissions.invite && !membersLoading && !membersError && notMembers.length > 0 && (
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
      </div>
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
