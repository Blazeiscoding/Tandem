import type { HuddleState } from "@slackoss/client-core";
import type { ID, User } from "@slackoss/protocol";

export type HuddleView = "docked" | "expanded" | "hidden";

/** Anyone sending video, which is when the stage has something to show. */
export function huddleHasVideo(huddle: HuddleState | null): boolean {
  if (!huddle) return false;
  return (
    huddle.localCameraStream !== null ||
    huddle.localScreenStream !== null ||
    huddle.peers.some((p) => p.cameraStream !== null || p.screenStream !== null)
  );
}

/** Who is in a channel's huddle, by name: you first, as "you", then everyone else. */
export function huddleNames(
  ids: readonly ID[],
  users: Record<ID, User>,
  selfId: ID | undefined,
): string[] {
  const others = ids.filter((id) => id !== selfId).map((id) => users[id]?.displayName ?? "someone");
  return selfId && ids.includes(selfId) ? ["you", ...others] : others;
}
