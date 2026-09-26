import type { HuddleState } from "@slackoss/client-core";

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
