import { useEffect, useState } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

type Tab = "about" | "members";

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
  const selfId = useWorkspace((s) => s.self?.id);
  const [tab, setTab] = useState<Tab>("about");
  const [memberIds, setMemberIds] = useState<ID[]>([]);
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [description, setDescription] = useState(channel?.description ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void client.api
      .channelMembers(props.channelId)
      .then((r) => setMemberIds(r.memberIds))
      .catch(() => setMemberIds([]));
  }, [client, props.channelId]);

  if (!channel) return null;
  const isRoom = channel.type === "public" || channel.type === "private";

  async function saveAbout(e: React.FormEvent) {
    e.preventDefault();
    await client.api.updateChannel(props.channelId, { topic, description });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function addMember(userId: ID) {
    await client.api.inviteMember(props.channelId, userId);
    setMemberIds((prev) => [...prev, userId]);
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
      <div className="mb-4 flex gap-1 rounded-lg bg-ground p-1">
        {(["about", "members"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t ? "bg-lifted text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            {t === "members" ? `Members (${memberIds.length})` : "About"}
          </button>
        ))}
      </div>

      {tab === "about" ? (
        isRoom ? (
          <form onSubmit={saveAbout} className="space-y-3">
            <div>
              <label className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                Topic
              </label>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What's this channel about right now?"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="The longer story, shown to anyone who opens the channel."
                className={`${inputCls} resize-none`}
              />
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" className={primaryBtnCls}>
                {saved ? "Saved" : "Save changes"}
              </button>
              {channel.name !== "general" && (
                <button
                  type="button"
                  onClick={async () => {
                    await client.api.leaveChannel(props.channelId);
                    props.onLeft();
                  }}
                  className="rounded-lg border border-edge px-4 py-2.5 text-sm text-ink-dim transition-colors hover:border-alert hover:text-alert"
                >
                  Leave channel
                </button>
              )}
            </div>
          </form>
        ) : (
          <p className="py-4 text-center text-sm text-ink-faint">
            Direct conversations have no topic to set.
          </p>
        )
      ) : (
        <div>
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
          {isRoom && notMembers.length > 0 && (
            <div>
              <div className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                Add someone
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {notMembers.map((u) => (
                  <li key={u.id}>
                    <button
                      onClick={() => addMember(u.id)}
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
      )}
    </Dialog>
  );
}
