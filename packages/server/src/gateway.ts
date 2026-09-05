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
import { socketMessage } from "./socketSchema.js";

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
  /**
   * channelId -> user ids currently in that channel's huddle. Purely live
   * state: a huddle exists only while people are in it, so it is never
   * written to the event log and does not survive a restart.
   */
  private huddles = new Map<ID, Set<ID>>();
  private heartbeat: NodeJS.Timeout;
  private sockets = new Set<WebSocket>();

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
    const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
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
    for (const ws of this.sockets) ws.terminate();
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
    this.sockets.add(ws);
    let client: Client | null = null;
    const authTimer = setTimeout(() => {
      if (!client) ws.terminate();
    }, 10_000);

    ws.on("pong", () => {
      if (client) client.alive = true;
    });

    ws.on("message", (data) => {
      let msg: ClientToServer;
      try {
        const parsed = socketMessage.safeParse(JSON.parse(String(data)));
        if (!parsed.success) { ws.close(4000, "invalid message"); return; }
        msg = parsed.data;
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
          savedMessageIds: this.store.savedMessageIds(user.id),
          huddles: this.huddlesVisibleTo(user.id),
          workspaceName: this.workspaceName(),
          friends: this.store.listFriends(user.id),
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
      } else if (msg.type === "huddle.join") {
        if (this.store.canAccess(msg.channelId, client.userId)) {
          this.joinHuddle(msg.channelId, client.userId);
        }
      } else if (msg.type === "huddle.leave") {
        this.leaveHuddle(msg.channelId, client.userId);
      } else if (msg.type === "huddle.signal") {
        // Only relay between two people actually in the same huddle.
        const room = this.huddles.get(msg.channelId);
        if (room?.has(client.userId) && room.has(msg.to)) {
          this.sendToUser(msg.to, {
            type: "huddle.signal",
            channelId: msg.channelId,
            from: client.userId,
            signal: msg.signal,
          });
        }
      }
    });

    ws.on("close", () => {
      this.sockets.delete(ws);
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
        // Dropping offline must also drop them from any huddle, or the room
        // keeps a ghost participant nobody can call.
        for (const channelId of [...this.huddles.keys()]) {
          this.leaveHuddle(channelId, client.userId);
        }
        this.broadcastEphemeral(
          { type: "presence", userId: client.userId, presence: "offline" },
          null,
        );
      }
    }
  }

  // ---------- huddles ----------

  private huddlesVisibleTo(userId: ID): Record<ID, ID[]> {
    const out: Record<ID, ID[]> = {};
    for (const [channelId, members] of this.huddles) {
      if (this.store.canAccess(channelId, userId)) out[channelId] = [...members];
    }
    return out;
  }

  private joinHuddle(channelId: ID, userId: ID): void {
    let room = this.huddles.get(channelId);
    if (!room) this.huddles.set(channelId, (room = new Set()));
    if (room.has(userId)) return;
    room.add(userId);
    this.publishHuddle(channelId);
  }

  private leaveHuddle(channelId: ID, userId: ID): void {
    const room = this.huddles.get(channelId);
    if (!room?.delete(userId)) return;
    // An empty huddle is no huddle at all.
    if (room.size === 0) this.huddles.delete(channelId);
    this.publishHuddle(channelId);
  }

  /** Tells the channel who is in its huddle now. */
  private publishHuddle(channelId: ID): void {
    this.broadcastEphemeral(
      { type: "huddle.participants", channelId, userIds: [...(this.huddles.get(channelId) ?? [])] },
      this.audienceForChannel(channelId),
    );
  }

  /** Participants of one channel's huddle, for tests and diagnostics. */
  huddleParticipants(channelId: ID): ID[] {
    return [...(this.huddles.get(channelId) ?? [])];
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

  /** Sends an ephemeral event to every socket of one user (their other devices). */
  sendToUser(userId: ID, event: EphemeralEvent): void {
    const frame = JSON.stringify({ type: "ephemeral", event } satisfies ServerToClient);
    for (const c of this.byUser.get(userId) ?? []) this.sendRaw(c.ws, frame);
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
    // A slow reader must reconnect and replay instead of growing an unbounded
    // queue in the host's RAM.
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.terminate(); return; }
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}
