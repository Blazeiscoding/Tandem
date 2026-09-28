import type { IncomingMessage, Server as HttpServer } from "node:http";
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
import type { RateLimiter } from "./limits.js";
import { resolveClientAddress } from "./netTrust.js";

interface Client {
  ws: WebSocket;
  userId: ID;
  tokenHash: string;
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
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private store: Store,
    private workspaceName: () => string,
    /** Shared with the HTTP side, so one caller has one allowance overall. */
    private limiter: RateLimiter | null = null,
    private clientAddress: (request: IncomingMessage) => string = (request) =>
      resolveClientAddress(request.socket.remoteAddress, request.headers),
  ) {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!this.authorized(c)) continue;
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
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
    });
    server.on("upgrade", (req, socket, head) => {
      if (this.closing) {
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      // Opening sockets is cheap for the caller and not for the server, so it
      // is rationed before the handshake rather than after it. Keyed on the
      // address because there is no account yet to key on.
      const address = this.clientAddress(req);
      if (this.limiter && !this.limiter.take("socket", address).ok) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.heartbeat);
    this.closePromise = Promise.all(
      [...this.sockets].map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.once("close", () => resolve());
            ws.terminate();
          }),
      ),
    ).then(() => {});
    return this.closePromise;
  }

  /** Silent when refused: a dropped typing notice is not worth an error frame. */
  private affordEphemeral(userId: ID): boolean {
    return !this.limiter || this.limiter.take("ephemeral", userId).ok;
  }

  onlineUserIds(): ID[] {
    return [...this.byUser.keys()];
  }

  private presenceListeners = new Set<() => void>();

  /** Called whenever someone's first socket opens or last socket closes. */
  onPresenceChange(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => void this.presenceListeners.delete(listener);
  }

  private presenceChanged(): void {
    for (const listener of this.presenceListeners) {
      try {
        listener();
      } catch {
        // Whoever listens cannot stop a socket from being counted.
      }
    }
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
      if (this.closing || (client && !this.clients.has(client))) return;
      let msg: ClientToServer;
      try {
        const parsed = socketMessage.safeParse(JSON.parse(String(data)));
        if (!parsed.success) {
          ws.close(4000, "invalid message");
          return;
        }
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
        const tokenHash = hashToken(msg.token);
        const user = this.store.getSessionUser(tokenHash);
        if (!user) {
          this.send(ws, { type: "error", code: "auth_failed", message: "invalid token" });
          ws.close(4003);
          return;
        }
        // The REST side refuses a locked account; the socket has to as well, or
        // a temporary password would still hand over the whole workspace.
        if (this.store.mustChangePassword(user.id)) {
          this.send(ws, {
            type: "error",
            code: "password_change_required",
            message: "Choose a new password before using this workspace.",
          });
          ws.close(4004);
          return;
        }
        client = { ws, userId: user.id, tokenHash, alive: true };
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
          threadFollows: this.store.threadFollows(user.id),
          mentionCounts: this.store.unreadMentionCounts(user.id),
          huddles: this.huddlesVisibleTo(user.id),
          workspaceName: this.workspaceName(),
          workspaceId: this.store.getMeta("workspace_id") ?? undefined,
          friends: this.store.listFriends(user.id),
        };
        const missed =
          msg.lastSeq !== null && msg.lastSeq <= snapshot.seq
            ? this.store.eventsSince(msg.lastSeq, user.id)
            : null;
        if (msg.syncVersion === 1) snapshot.replayFrom = missed === null ? null : msg.lastSeq;
        this.send(ws, snapshot);
        if (missed !== null) {
          for (const envelope of missed) this.send(ws, { type: "event", envelope });
        } else if (msg.lastSeq !== null && msg.syncVersion !== 1) {
          this.send(ws, { type: "resync" });
        }
        if (msg.syncVersion === 1) this.send(ws, { type: "synced", seq: snapshot.seq });
        return;
      }

      if (!client) return;
      if (!this.authorized(client)) return;
      if (msg.type === "ping") {
        this.send(ws, { type: "pong" });
      } else if (msg.type === "typing") {
        // Every keystroke can send one of these, and each fans out to a whole
        // channel, so the cost of sending is far below the cost of delivering.
        if (!this.affordEphemeral(client.userId)) return;
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
        if (!this.affordEphemeral(client.userId)) return;
        // Only relay between two people actually in the same huddle.
        const room = this.huddles.get(msg.channelId);
        if (
          room?.has(client.userId) &&
          room.has(msg.to) &&
          this.store.canAccess(msg.channelId, client.userId) &&
          this.store.canAccess(msg.channelId, msg.to)
        ) {
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
      this.broadcastEphemeral(
        { type: "presence", userId: client.userId, presence: "online" },
        null,
      );
      this.presenceChanged();
    }
  }

  private unregister(client: Client): void {
    if (!this.clients.delete(client)) return;
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
        this.presenceChanged();
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

  /** Membership changes also invalidate a call and notify the affected user's devices. */
  updateChannelAccess(channelId: ID, userId: ID): void {
    const membership =
      this.store.memberships(userId).find((m) => m.channelId === channelId) ?? null;
    const channel = this.store.canAccess(channelId, userId)
      ? this.store.getChannel(channelId)
      : null;
    if (!channel) this.leaveHuddle(channelId, userId);
    this.sendToUser(userId, { type: "channel.access", channelId, channel, membership });
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
      if ((audience === null || audience.has(c.userId)) && this.authorized(c))
        this.sendRaw(c.ws, frame);
    }
  }

  /**
   * Cuts every live socket a person has. Deactivating an account revokes its
   * sessions, but an already-open WebSocket authenticated once and would
   * otherwise keep streaming the workspace to someone who has just been
   * removed from it.
   */
  disconnectUser(userId: ID): void {
    for (const client of [...(this.byUser.get(userId) ?? [])]) {
      this.revoke(client, "account deactivated");
    }
  }

  disconnectSession(tokenHash: string): void {
    for (const client of [...this.clients]) {
      if (client.tokenHash === tokenHash) this.revoke(client, "signed out");
    }
  }

  private revoke(client: Client, reason: string): void {
    this.send(client.ws, { type: "error", code: "auth_failed", message: reason });
    // Stop fanout and accepting frames immediately, without waiting for the close handshake.
    this.unregister(client);
    client.ws.close(4003, reason);
  }

  private authorized(client: Client): boolean {
    if (!this.clients.has(client)) return false;
    if (this.store.isSessionActive(client.tokenHash, client.userId)) return true;
    this.revoke(client, "session expired or revoked");
    return false;
  }

  /** Sends an ephemeral event to every socket of one user (their other devices). */
  sendToUser(userId: ID, event: EphemeralEvent): void {
    const frame = JSON.stringify({ type: "ephemeral", event } satisfies ServerToClient);
    for (const c of this.byUser.get(userId) ?? []) {
      if (this.authorized(c)) this.sendRaw(c.ws, frame);
    }
  }

  broadcastEphemeral(event: EphemeralEvent, audience: Set<ID> | null): void {
    const frame = JSON.stringify({ type: "ephemeral", event } satisfies ServerToClient);
    for (const c of this.clients) {
      if ((audience === null || audience.has(c.userId)) && this.authorized(c))
        this.sendRaw(c.ws, frame);
    }
  }

  private send(ws: WebSocket, msg: ServerToClient): void {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, frame: string): void {
    // A slow reader must reconnect and replay instead of growing an unbounded
    // queue in the host's RAM.
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.terminate();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}
