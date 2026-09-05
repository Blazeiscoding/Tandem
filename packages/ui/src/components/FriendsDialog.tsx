import { useState } from "react";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar, PresenceDot } from "./Avatar.js";
import { Dialog, inputCls, primaryBtnCls } from "./Dialog.js";

export function FriendActions({ userId }: { userId: ID }) {
  const client = useClient();
  const relationship = useWorkspace((s) => s.friends.find((f) => f.userId === userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update(action: "request" | "accept" | "remove") {
    setBusy(true);
    setError("");
    try {
      const result = await client.api.updateFriend(userId, action);
      client.store.setState({ friends: result.friends });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update friendship");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {!relationship && (
          <button disabled={busy} onClick={() => void update("request")} className={primaryBtnCls}>
            Add friend
          </button>
        )}
        {relationship?.status === "incoming" && (
          <button disabled={busy} onClick={() => void update("accept")} className={primaryBtnCls}>
            Accept
          </button>
        )}
        {relationship && (
          <button
            disabled={busy}
            onClick={() => void update("remove")}
            className="rounded-lg border border-edge px-3 py-2 text-xs text-ink-dim hover:bg-lifted disabled:opacity-50"
          >
            {relationship.status === "incoming"
              ? "Decline"
              : relationship.status === "outgoing"
                ? "Cancel request"
                : "Remove friend"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function FriendsDialog({
  onClose,
  onOpenProfile,
}: {
  onClose: () => void;
  onOpenProfile: (id: ID) => void;
}) {
  const friends = useWorkspace((s) => s.friends);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const presence = useWorkspace((s) => s.presence);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"friends" | "requests" | "people">("friends");
  const incoming = friends.filter((f) => f.status === "incoming").length;
  const rows = Object.values(users)
    .filter((u) => {
      if (u.id === selfId || u.isBot || u.deactivated) return false;
      const relation = friends.find((f) => f.userId === u.id);
      if (tab === "friends" && relation?.status !== "accepted") return false;
      if (tab === "requests" && (!relation || relation.status === "accepted")) return false;
      return `${u.displayName} ${u.handle}`.toLowerCase().includes(query.toLowerCase());
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <Dialog title="Friends" onClose={onClose}>
      <p className="mb-4 text-sm text-ink-dim">
        Connect with people in this workspace. Your friends and requests stay on this server.
      </p>
      <div className="mb-4 flex gap-2" aria-label="People filters">
        {(
          [
            ["friends", "Friends"],
            ["requests", `Requests${incoming ? ` (${incoming})` : ""}`],
            ["people", "Add friends"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-lg px-3 py-2 text-sm ${tab === value ? "bg-copper/15 text-copper" : "text-ink-dim hover:bg-lifted"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        aria-label="Find people"
        placeholder="Search by name or handle"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={inputCls}
      />
      <div className="mt-4 max-h-[50vh] space-y-3 overflow-y-auto">
        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-ink-faint">
            {tab === "friends"
              ? "No friends yet. Find someone in Add friends to send a request."
              : tab === "requests"
                ? "No pending requests."
                : "No people found."}
          </p>
        )}
        {rows.map((user) => (
          <div key={user.id} className="rounded-xl border border-edge bg-ground p-3">
            <button
              onClick={() => onOpenProfile(user.id)}
              className="mb-3 flex w-full items-center gap-3 text-left"
            >
              <Avatar user={user} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{user.displayName}</span>
                <span className="text-xs text-ink-faint">@{user.handle}</span>
              </span>
              <PresenceDot online={presence[user.id] === "online"} />
            </button>
            {friends.find((f) => f.userId === user.id)?.status === "outgoing" && (
              <p className="mb-2 text-xs text-ink-faint">Request sent</p>
            )}
            <FriendActions userId={user.id} />
          </div>
        ))}
      </div>
    </Dialog>
  );
}
