import type { Channel, ID, User } from "@slackoss/protocol";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** DMs and group DMs are titled by the other members' names. */
export function channelTitle(
  channel: Channel,
  users: Record<ID, User>,
  selfId: ID | undefined,
): string {
  if (channel.type === "public" || channel.type === "private") return channel.name;
  const others = (channel.memberIds ?? []).filter((id) => id !== selfId);
  if (others.length === 0) return users[selfId ?? ""]?.displayName ?? "You";
  return others.map((id) => users[id]?.displayName ?? "unknown").join(", ");
}

const AVATAR_HUES = [18, 42, 96, 152, 200, 258, 312, 340];

/** Dark enough on every hue for white initials to clear 4.5:1; cyan is the closest. */
export function avatarColor(userId: ID): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return `oklch(0.52 0.13 ${AVATAR_HUES[h % AVATAR_HUES.length]})`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}
