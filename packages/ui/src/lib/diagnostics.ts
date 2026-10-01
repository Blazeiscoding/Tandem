import type { HuddleState } from "@slackoss/client-core";
import type { ServerInfo, WorkspaceStatus } from "@slackoss/protocol";
import { PROTOCOL_VERSION } from "@slackoss/protocol";
import { formatBytes } from "./format.js";

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
  /**
   * How the server is keeping up, for the owner and admins, or why it could
   * not be read; left out for everyone else.
   */
  workspace?: WorkspaceStatus | { error: string };
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
    ...(input.workspace ? ["", ...workspaceLines(input.workspace, input.now.getTime())] : []),
  ].join("\n");
}

/**
 * The name a saved report gets: when it was taken, so several kept side by
 * side sort by time, with nothing about the workspace or person in it.
 */
export function diagnosticsFileName(taken: Date): string {
  return `gatherline-diagnostics-${taken.toISOString().slice(0, 19).replaceAll(":", "-")}Z.txt`;
}

/** A span of time, roughly: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
function roughDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The server's own account of itself (OPS-10): sizes, queues and timings, and
 * never what is in them. It holds no message, name, file, address or token.
 */
function workspaceLines(status: WorkspaceStatus | { error: string }, now: number): string[] {
  if ("error" in status) return ["Workspace status", `Not available: ${status.error}`];
  const { database, attachments, deliveries, scheduled, retention, connections } = status;
  const loop = status.eventLoopDelayMs;
  return [
    "Workspace status",
    `Server: v${status.serverVersion}, schema ${status.schemaVersion}, up ${roughDuration(status.uptimeSeconds * 1000)}`,
    `Database: ${formatBytes(database.bytes)}, log ${formatBytes(database.walBytes)}`,
    `Attachments: ${formatBytes(attachments.bytes)}${
      attachments.limitBytes === null ? ", no limit" : ` of ${formatBytes(attachments.limitBytes)}`
    }`,
    // Servers before REV-02 do not say how removing deleted attachments goes.
    ...(attachments.removal
      ? [
          `Attachment removal: ${attachments.removal.waiting} waiting${
            attachments.removal.oldestQueuedAt === null
              ? ""
              : ` (oldest for ${roughDuration(now - attachments.removal.oldestQueuedAt)})`
          }, ${attachments.removal.retrying} retrying, ${attachments.removal.rejected} set aside`,
        ]
      : []),
    `Free disk: ${status.diskFreeBytes === null ? "unknown" : formatBytes(status.diskFreeBytes)}`,
    `App deliveries: ${deliveries.waiting} waiting${
      deliveries.oldestWaitingAt === null
        ? ""
        : ` (oldest for ${roughDuration(now - deliveries.oldestWaitingAt)})`
    }, ${deliveries.failed} given up`,
    `Scheduled messages: ${scheduled.queued} queued, ${scheduled.held} held for a retry, ${scheduled.failed} failed`,
    `History removal: ${
      !retention.enabled
        ? "off"
        : (retention.lastSuccessAt === null
            ? "not run yet"
            : `last done ${new Date(retention.lastSuccessAt).toISOString()}`) +
          (retention.failures ? `, ${plural(retention.failures, "failure")} since` : "")
    }`,
    `Connections: ${plural(connections.sockets, "socket")} for ${plural(connections.people, "person", "people")}`,
    `Event loop delay: ${
      loop
        ? `p50 ${loop.p50} ms, p99 ${loop.p99} ms, max ${loop.max} ms`
        : "not measured until the server has run a minute"
    }`,
    // Servers before REV-01 do not say, and a line would guess.
    ...(status.backgroundFailures
      ? [
          status.backgroundFailures.length === 0
            ? "Background work: all running"
            : `Background work failing: ${status.backgroundFailures
                .map(
                  (f) =>
                    `${f.queue} (${plural(f.failures, "time")} in a row, for ${roughDuration(now - f.since)})`,
                )
                .join("; ")}`,
        ]
      : []),
  ];
}
