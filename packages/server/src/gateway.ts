import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type ClientToServer,
  type EphemeralEvent,
  type EventEnvelope,
  type ID,
  type Presence,
  type ReadySnapshot,
  type ServerToClient,
} from "@slackoss/protocol";
import type { Store } from "./store.js";
import { hashToken } from "./auth.js";

interface Client {
  ws: WebSocket;
  userId: ID;
  alive: boolean;
}

/**
 * Holds every live socket, answers "who may see this event", and fans out
 * durable + ephemeral events. Event visibility: global events go to everyone;
 * events on a public channel go to everyone; events on private/dm channels go
 * to current members only.
 */
export class Gateway {
  private clients = new Set<Client>();
  private byUser = new Map<ID, Set<Client>>();
  private heartbeat: NodeJS.Timeout;

  constructor(
    private store: Store,
    private workspaceName: () => string,
  ) {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, 30_000);
  }

  attach(server: HttpServer, path = "/ws"): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.terminate();
  }

  onlineUserIds(): ID[] {
    return [...this.byUser.keys()];
  }

  presenceMap(): Record<ID, Presence> {
    const out: Record<ID, Presence> = {};
    for (const u of this.store.listUsers()) out[u.id] = "offline";
    for (const id of this.byUser.keys()) out[id] = "online";
    return out;
  }

  private onConnection(ws: WebSocket): void {
    let client: Client | null = null;
    const authTimer = setTimeout(() => {
      if (!client) ws.close(4001, "hello timeout");
    }, 10_000);

    ws.on("pong", () => {
      if (client) client.alive = true;
    });

    ws.on("message", (data) => {
      let msg: ClientToServer;
      try {
        msg = JSON.parse(String(data)) as ClientToServer;
      } catch {
        return;
      }

      if (msg.type === "hello" && !client) {
        clearTimeout(authTimer);
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.send(ws, {
            type: "error",
            code: "protocol_mismatch",
            message: `server speaks protocol v${PROTOCOL_VERSION}`,
          });
          ws.close(4002);
          return;
        }
        const user = this.store.getSessionUser(hashToken(msg.token));
        if (!user) {
          this.send(ws, { type: "error", code: "auth_failed", message: "invalid token" });
          ws.close(4003);
          return;
        }
        client = { ws, userId: user.id, alive: true };
        this.register(client);

        const snapshot: ReadySnapshot = {
          type: "ready",
          seq: this.store.currentSeq(),
          self: user,
          users: this.store.listUsers(),
          channels: this.store.listChannelsVisibleTo(user.id),
          memberships: this.store.memberships(user.id),
          channelLastSeq: this.store.channelLastSeqMap(user.id),
          presence: this.presenceMap(),
          workspaceName: this.workspaceName(),
        };
        this.send(ws, snapshot);

        // Replay anything the client missed while offline.
        if (msg.lastSeq !== null && msg.lastSeq < snapshot.seq) {
          const missed = this.store.eventsSince(msg.lastSeq, user.id);
          if (missed === null) {
            this.send(ws, { type: "resync" });
          } else {
            for (const envelope of missed) this.send(ws, { type: "event", envelope });
          }
        }
        return;
      }

      if (!client) return;
      if (msg.type === "ping") {
        this.send(ws, { type: "pong" });
      } else if (msg.type === "typing") {
        if (this.store.canAccess(msg.channelId, client.userId)) {
          this.broadcastEphemeral(
            { type: "typing", channelId: msg.channelId, userId: client.userId },
            this.audienceForChannel(msg.channelId),
          );
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (client) this.unregister(client);
    });
    ws.on("error", () => ws.terminate());
  }

  private register(client: Client): void {
    this.clients.add(client);
    let set = this.byUser.get(client.userId);
    const firstSocket = !set;
    if (!set) this.byUser.set(client.userId, (set = new Set()));
    set.add(client);
    if (firstSocket) {
      this.broadcastEphemeral({ type: "presence", userId: client.userId, presence: "online" }, null);
    }
  }

  private unregister(client: Client): void {
    this.clients.delete(client);
    const set = this.byUser.get(client.userId);
    if (set) {
      set.delete(client);
      if (set.size === 0) {
        this.byUser.delete(client.userId);
        this.broadcastEphemeral(
          { type: "presence", userId: client.userId, presence: "offline" },
          null,
        );
      }
    }
  }

  /** null audience = all connected users. */
  private audienceForChannel(channelId: ID): Set<ID> | null {
    const ch = this.store.getChannel(channelId);
    if (!ch) return new Set();
    if (ch.type === "public") return null;
    return new Set(this.store.memberIds(channelId));
  }

  /** Fan a durable event out to every connected client allowed to see it. */
  publish(envelope: EventEnvelope, channelId: ID | null): void {
    const audience = channelId === null ? null : this.audienceForChannel(channelId);
    const frame = JSON.stringify({ type: "event", envelope } satisfies ServerToClient);
    for (const c of this.clients) {
      if (audience === null || audience.has(c.userId)) this.sendRaw(c.ws, frame);
    }
  }

  broadcastEphemeral(event: EphemeralEvent, audience: Set<ID> | null): void {
    const frame = JSON.stringify({ type: "ephemeral", event } satisfies ServerToClient);
    for (const c of this.clients) {
      if (audience === null || audience.has(c.userId)) this.sendRaw(c.ws, frame);
    }
  }

  private send(ws: WebSocket, msg: ServerToClient): void {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, frame: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}
