import type { HuddleState } from "@slackoss/client-core";
import type { ServerInfo } from "@slackoss/protocol";
import { PROTOCOL_VERSION } from "@slackoss/protocol";

/** What a report can say about the device it came from. */
export interface DiagnosticsInput {
  app: "web" | "desktop";
  address: string;
  status: string;
  /** The server's own description, or why it could not be read. */
  server: ServerInfo | { error: string };
  huddle: HuddleState | null;
  /** Messages waiting to send, counted, never quoted. */
  waitingToSend: number;
  userAgent: string;
  online: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  notifications: string;
  now: Date;
}

/**
 * A plain-text report for whoever helps when something is wrong: versions,
 * the connection and the device, and never what anybody wrote. People see
 * all of it before they copy it.
 */
export function diagnosticsReport(input: DiagnosticsInput): string {
  const server =
    "error" in input.server
      ? `not reachable (${input.server.error})`
      : `v${input.server.serverVersion}, protocol ${input.server.protocolVersion}`;
  const huddle = input.huddle
    ? `in a call with ${input.huddle.peers.length} other${input.huddle.peers.length === 1 ? "" : "s"}, ` +
      `${input.huddle.peers.filter((peer) => peer.connected).length} connected`
    : "not in a call";
  return [
    "Gatherline diagnostics",
    `Taken: ${input.now.toISOString()}`,
    `App: ${input.app === "desktop" ? "desktop app" : "browser"}, protocol ${PROTOCOL_VERSION}`,
    `Server: ${server}`,
    `Address: ${input.address}`,
    `Connection: ${input.status}${input.online ? "" : " (this device is offline)"}`,
    `Waiting to send: ${input.waitingToSend}`,
    `Huddle: ${huddle}`,
    `Notifications: ${input.notifications}`,
    `Window: ${input.width}×${input.height} at ${input.pixelRatio}×`,
    `Browser: ${input.userAgent}`,
  ].join("\n");
}
