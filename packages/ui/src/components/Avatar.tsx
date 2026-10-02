import type { User } from "@slackoss/protocol";
import { avatarColor, initials } from "../lib/format.js";

/** A person's initials on a colour of their own, round as in Discord. */
export function Avatar({ user, size = 36 }: { user: User | undefined; size?: number }) {
  return (
    <div
      className="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: user ? avatarColor(user.id) : "var(--color-lifted)",
        fontSize: size * 0.38,
      }}
    >
      {initials(user?.displayName ?? "?")}
    </div>
  );
}

export function PresenceDot({ online, size = 8 }: { online: boolean; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: online ? "var(--color-online)" : "transparent",
        border: online ? "none" : "1.5px solid var(--color-ink-faint)",
      }}
    />
  );
}

/**
 * An avatar with whether the person is here, as a dot cut into its lower
 * right corner, ringed in the surface it sits on.
 */
export function AvatarWithPresence({
  user,
  online,
  size = 32,
  ring = "var(--color-raised)",
}: {
  user: User | undefined;
  online: boolean;
  size?: number;
  /** The colour behind the avatar, so the dot reads as cut out of it. */
  ring?: string;
}) {
  const dot = Math.max(10, Math.round(size * 0.32));
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar user={user} size={size} />
      <span
        className="absolute rounded-full"
        style={{
          width: dot,
          height: dot,
          right: -2,
          bottom: -2,
          background: online ? "var(--color-online)" : "var(--color-ink-faint)",
          boxShadow: `0 0 0 3px ${ring}`,
        }}
      />
    </span>
  );
}
