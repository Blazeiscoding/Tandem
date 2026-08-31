import type { ID, Message } from "@slackoss/protocol";
import type { WorkspaceState } from "./workspace.js";

export type NotifyDecision =
  | { notify: false; reason: "own-message" | "not-a-member" | "muted" | "level" | "dnd" }
  | { notify: true; reason: "dm" | "mention" | "all" };

/**
 * Whether an incoming message should raise a desktop notification.
 * Kept here rather than in the UI so the rules are testable and identical
 * on every client.
 */
export function decideNotification(
  state: WorkspaceState,
  message: Message,
  now = Date.now(),
): NotifyDecision {
  const self = state.self;
  if (!self || message.userId === self.id) return { notify: false, reason: "own-message" };

  const channel = state.channels[message.channelId];
  if (!channel || !(message.channelId in state.memberships)) {
    return { notify: false, reason: "not-a-member" };
  }

  const prefs = state.prefs[message.channelId] ?? { notifyLevel: "mentions", muted: false };
  if (prefs.muted) return { notify: false, reason: "muted" };
  if (prefs.notifyLevel === "nothing") return { notify: false, reason: "level" };

  const mentioned = message.text.includes(`<@${self.id}>`);
  const isDm = channel.type === "dm" || channel.type === "group_dm";

  if (prefs.notifyLevel === "mentions" && !mentioned && !isDm) {
    return { notify: false, reason: "level" };
  }

  // Do Not Disturb wins over everything except the decision to stay silent,
  // which is already settled above.
  if (self.dndUntil !== null && self.dndUntil > now) return { notify: false, reason: "dnd" };

  if (isDm) return { notify: true, reason: "dm" };
  if (mentioned) return { notify: true, reason: "mention" };
  return { notify: true, reason: "all" };
}

/** Text for a notification, with mention markup resolved to readable names. */
export function notificationBody(state: WorkspaceState, message: Message): string {
  // Deliberately permissive: an id format change should not silently stop
  // mentions from resolving to names.
  const text = message.text.replaceAll(/<@([A-Za-z0-9_-]+)>/g, (_all, id: ID) => {
    const user = state.users[id];
    return user ? `@${user.displayName}` : "@someone";
  });
  if (text.trim()) return text;
  const count = message.files.length;
  return count === 1 ? "Sent a file" : `Sent ${count} files`;
}
