import type { ID } from "./entities.js";

/**
 * WebRTC negotiation payloads. The server relays these untouched — it never
 * sees or carries media, only the handshake between peers.
 *
 * Deliberately plain objects rather than DOM types: this package is shared
 * with the server, which has no lib.dom.
 */
export type HuddleSignal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | {
      kind: "ice";
      candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
    };

/** Who is currently in a channel's huddle. */
export interface HuddleState {
  channelId: ID;
  userIds: ID[];
}

/**
 * Deterministic tie-break for who sends the offer, so two peers learning about
 * each other at the same moment don't both offer (WebRTC "glare").
 */
export function shouldInitiateOffer(selfId: ID, otherId: ID): boolean {
  return selfId < otherId;
}
