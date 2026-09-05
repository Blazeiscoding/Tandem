import { broadcastLabel, broadcastsIn, type ID, type Message } from "@slackoss/protocol";
import type { WorkspaceState } from "./workspace.js";

export type NotifyDecision =
  | {
      notify: false;
      reason: "own-message" | "not-a-member" | "muted" | "level" | "dnd" | "not-here";
    }
  | { notify: true; reason: "dm" | "mention" | "broadcast" | "all" };

export interface NotifyContext {
  now?: number;
  /**
   * Whether this message is arriving as it is sent, rather than being replayed
   * after a reconnect. `@here` asks the people who are around right now, so a
   * message caught up on an hour later must not ring.
   */
  live?: boolean;
}

/**
 * Whether an incoming message should raise a desktop notification.
 * Kept here rather than in the UI so the rules are testable and identical
 * on every client.
 */
export function decideNotification(
  state: WorkspaceState,
  message: Message,
  context: NotifyContext = {},
): NotifyDecision {
  const { now = Date.now(), live = true } = context;
  const self = state.self;
  if (!self || message.userId === self.id) return { notify: false, reason: "own-message" };

  const channel = state.channels[message.channelId];
  if (!channel || !(message.channelId in state.memberships)) {
    return { notify: false, reason: "not-a-member" };
  }

  const prefs = state.prefs[message.channelId] ?? { notifyLevel: "mentions", muted: false };
  if (prefs.muted) return { notify: false, reason: "muted" };
  if (prefs.notifyLevel === "nothing") return { notify: false, reason: "level" };

  const named = message.text.includes(`<@${self.id}>`);
  const broadcasts = broadcastsIn(message.text);
  // A room-wide mention only reaches a room: in a DM it is just words.
  const isDm = channel.type === "dm" || channel.type === "group_dm";
  const addressed = named || (!isDm && broadcasts.size > 0);

  if (prefs.notifyLevel === "mentions" && !addressed && !isDm) {
    return { notify: false, reason: "level" };
  }

  // Do Not Disturb wins over everything except the decision to stay silent,
  // which is already settled above.
  if (self.dndUntil !== null && self.dndUntil > now) return { notify: false, reason: "dnd" };

  if (isDm) return { notify: true, reason: "dm" };
  if (named) return { notify: true, reason: "mention" };
  if (!isDm && broadcasts.size > 0) {
    // @channel reaches everyone in it; @here only the people who are here.
    if (broadcasts.has("channel") || live) return { notify: true, reason: "broadcast" };
    return { notify: false, reason: "not-here" };
  }
  return { notify: true, reason: "all" };
}

/** Text for a notification, with mention markup resolved to readable names. */
export function notificationBody(state: WorkspaceState, message: Message): string {
  // Deliberately permissive: an id format change should not silently stop
  // mentions from resolving to names.
  const text = message.text
    .replaceAll(/<@([A-Za-z0-9_-]+)>/g, (_all, id: ID) => {
      const user = state.users[id];
      return user ? `@${user.displayName}` : "@someone";
    })
    .replaceAll(/<!(channel|here|everyone)>/g, (_all, who: string) => broadcastLabel(who));
  if (text.trim()) return text;
  const count = message.files.length;
  return count === 1 ? "Sent a file" : `Sent ${count} files`;
}
