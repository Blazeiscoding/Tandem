import type { User } from "@slackoss/protocol";
import { avatarColor, initials } from "../lib/format.js";

/**
 * A person's initials on a colour of their own, round as in Discord. Hidden
 * from screen readers: the name is always written beside it, or on the button
 * it sits in, and "M C Maya Chen" says the person twice.
 */
export function Avatar({ user, size = 36 }: { user: User | undefined; size?: number }) {
  return (
    <div
      aria-hidden="true"
      className="avatar-face flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
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
  // Dot, ring and overhang all scale with the avatar, so a 20px sidebar
  // avatar gets a 6px dot in a 2px ring rather than a 32px avatar's 10 in 3.
  const dot = Math.max(6, Math.round(size * 0.32));
  const cut = Math.max(2, Math.round(size / 10));
  const overhang = -Math.round(size / 16);
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar user={user} size={size} />
      <span
        className="absolute rounded-full"
        style={{
          width: dot,
          height: dot,
          right: overhang,
          bottom: overhang,
          background: online ? "var(--color-online)" : "var(--color-ink-faint)",
          boxShadow: `0 0 0 ${cut}px ${ring}`,
        }}
      />
    </span>
  );
}
