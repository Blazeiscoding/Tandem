import type { Channel, User } from "./entities.js";

/** Visibility must be checked separately; administrators do not gain private-room access. */
export function channelPermissions(user: User | undefined, channel: Channel, isMember: boolean) {
  const room = channel.type === "public" || channel.type === "private";
  const active = !!user && !user.deactivated && !user.isBot;
  const administrator = user?.role === "owner" || user?.role === "admin";
  const manage = active && room && (administrator || (isMember && channel.creatorId === user.id));
  return {
    manage,
    invite: active && room && !channel.archived && (isMember || administrator),
  };
}
