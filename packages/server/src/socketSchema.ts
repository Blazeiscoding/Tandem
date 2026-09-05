import { z } from "zod";

const id = z.string().min(1).max(128);
const signal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().max(100_000) }),
  z.object({ kind: z.literal("answer"), sdp: z.string().max(100_000) }),
  z.object({ kind: z.literal("media"), camera: z.boolean(), screen: z.boolean() }),
  z.object({ kind: z.literal("ice"), candidate: z.object({
    candidate: z.string().max(4096), sdpMid: z.string().max(128).nullable(),
    sdpMLineIndex: z.number().int().nonnegative().max(100).nullable(),
  }) }),
]);

export const socketMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string().min(1).max(256), lastSeq: z.number().int().nonnegative().nullable(), protocolVersion: z.number().int() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("typing"), channelId: id }),
  z.object({ type: z.literal("huddle.join"), channelId: id }),
  z.object({ type: z.literal("huddle.leave"), channelId: id }),
  z.object({ type: z.literal("huddle.signal"), channelId: id, to: id, signal }),
]);
