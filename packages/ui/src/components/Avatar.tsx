import type { User } from "@slackoss/protocol";
import { avatarColor, initials } from "../lib/format.js";

export function Avatar({ user, size = 36 }: { user: User | undefined; size?: number }) {
  return (
    <div
      className="flex shrink-0 select-none items-center justify-center rounded-lg font-semibold text-white"
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
