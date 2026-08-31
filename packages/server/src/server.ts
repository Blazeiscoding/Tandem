import { join } from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import {
  PROTOCOL_VERSION,
  createChannelBody,
  createInviteBody,
  editMessageBody,
  loginBody,
  markReadBody,
  messageHistoryQuery,
  registerBody,
  searchQuery,
  sendMessageBody,
  updateChannelBody,
  updateMeBody,
  type EventEnvelope,
  type ID,
  type ServerInfo,
  type User,
  type WorkspaceEvent,
} from "@slackoss/protocol";
import { openDb } from "./db.js";
import { Store } from "./store.js";
import { Gateway } from "./gateway.js";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "./auth.js";
import { advertise, type MdnsHandle } from "./mdns.js";

export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  /** Directory holding workspace.db and uploads. Use ":memory:" for tests. */
  dataDir: string;
  port?: number;
  host?: string;
  /** Workspace display name; persisted on first run. */
  workspaceName?: string;
  /** When true, registration always requires an invite code (after the first user). */
  inviteOnly?: boolean;
  /** Advertise on the LAN via mDNS. Default true. */
  mdns?: boolean;
  /** Directory with the built web client; served at / so browsers can join too. */
  webDistPath?: string;
  logger?: boolean;
}

export interface WorkspaceServer {
  port: number;
  store: Store;
  gateway: Gateway;
  stop: () => Promise<void>;
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function createWorkspaceServer(opts: ServerOptions): Promise<WorkspaceServer> {
  const dbPath = opts.dataDir === ":memory:" ? ":memory:" : join(opts.dataDir, "workspace.db");
  const db = openDb(dbPath);
  const store = new Store(db);

  if (opts.workspaceName) store.setMeta("workspace_name", opts.workspaceName);
  if (!store.getMeta("workspace_name")) store.setMeta("workspace_name", "My Workspace");
  if (opts.inviteOnly !== undefined) store.setMeta("invite_only", opts.inviteOnly ? "1" : "0");
  const workspaceName = () => store.getMeta("workspace_name")!;
  const inviteOnly = () => store.getMeta("invite_only") === "1";

  const gateway = new Gateway(store, workspaceName);

  /** Append to the durable log, then fan out to connected clients. */
  const emit = (event: WorkspaceEvent, channelId: ID | null): EventEnvelope => {
    const envelope = store.appendEvent(event, channelId);
    if (event.type === "message.created") {
      store.stampMessageSeq(event.message.id, event.message.channelId, envelope.seq);
      event.message.seq = envelope.seq;
    }
    gateway.publish(envelope, channelId);
    return envelope;
  };

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });

  // Serve the browser client (if bundled) so teammates without the app can join.
  if (opts.webDistPath && existsSync(join(opts.webDistPath, "index.html"))) {
    await app.register(fastifyStatic, { root: opts.webDistPath });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/") || req.raw.url?.startsWith("/ws")) {
        return reply.status(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "invalid_request", details: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode < 500) {
      return reply
        .status(fastifyErr.statusCode)
        .send({ error: fastifyErr.code ?? "bad_request", message: fastifyErr.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  // ---------- auth plumbing ----------

  const bearerToken = (req: FastifyRequest): string | null => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7);
    return null;
  };

  const requireUser = (req: FastifyRequest): User => {
    const token = bearerToken(req);
    const user = token ? store.getSessionUser(hashToken(token)) : null;
    if (!user) throw new HttpError(401, "unauthorized");
    return user;
  };

  const requireChannelAccess = (channelId: ID, user: User) => {
    const channel = store.getChannel(channelId);
    if (!channel || !store.canAccess(channelId, user.id)) {
      throw new HttpError(404, "channel_not_found");
    }
    return channel;
  };

  // ---------- unauthenticated ----------

  app.get("/api/server-info", async (): Promise<ServerInfo> => {
    return {
      app: "slackoss",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      workspaceName: workspaceName(),
      userCount: store.userCount(),
      requiresInvite: store.userCount() > 0 && inviteOnly(),
    };
  });

  app.post("/api/auth/register", async (req, reply) => {
    const body = registerBody.parse(req.body);
    const isFirstUser = store.userCount() === 0;

    if (!isFirstUser && inviteOnly()) {
      if (!body.inviteCode || !store.consumeInvite(body.inviteCode)) {
        throw new HttpError(403, "invite_required", "a valid invite code is required to join");
      }
    }
    if (store.getUserAuthByHandle(body.handle)) {
      throw new HttpError(409, "handle_taken");
    }

    const { hash, salt } = hashPassword(body.password);
    const user = store.createUser({
      handle: body.handle,
      displayName: body.displayName,
      passwordHash: hash,
      salt,
      role: isFirstUser ? "owner" : "member",
    });

    if (isFirstUser) {
      // Bootstrap the workspace with #general.
      const general = store.createChannel({
        type: "public",
        name: "general",
        description: "This channel is for workspace-wide communication.",
        creatorId: user.id,
        memberIds: [user.id],
      });
      emit({ type: "channel.created", channel: general }, general.id);
    } else {
      emit({ type: "user.joined", user }, null);
      // Everyone lands in #general automatically.
      const general = store.getChannelByName("general");
      if (general && store.addMember(general.id, user.id)) {
        emit({ type: "member.joined", channelId: general.id, userId: user.id }, general.id);
      }
    }

    const { token, tokenHash } = newSessionToken();
    store.createSession(tokenHash, user.id);
    return reply.status(201).send({ token, user });
  });

  app.post("/api/auth/login", async (req) => {
    const body = loginBody.parse(req.body);
    const auth = store.getUserAuthByHandle(body.handle);
    if (!auth || auth.deactivated || !verifyPassword(body.password, auth.salt, auth.passwordHash)) {
      throw new HttpError(401, "invalid_credentials");
    }
    const { token, tokenHash } = newSessionToken();
    store.createSession(tokenHash, auth.id);
    const { passwordHash: _p, salt: _s, ...user } = auth;
    return { token, user };
  });

  app.post("/api/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) store.deleteSession(hashToken(token));
    return { ok: true };
  });

  // ---------- me / users ----------

  app.get("/api/me", async (req) => ({ user: requireUser(req) }));

  app.patch("/api/me", async (req) => {
    const me = requireUser(req);
    const body = updateMeBody.parse(req.body);
    const user = store.updateUser(me.id, body);
    emit({ type: "user.updated", user }, null);
    return { user };
  });

  app.get("/api/users", async (req) => {
    requireUser(req);
    return { users: store.listUsers() };
  });

  // ---------- channels ----------

  app.get("/api/channels", async (req) => {
    const me = requireUser(req);
    return { channels: store.listChannelsVisibleTo(me.id) };
  });

  app.post("/api/channels", async (req, reply) => {
    const me = requireUser(req);
    const body = createChannelBody.parse(req.body);

    if (body.type === "public" || body.type === "private") {
      if (store.getChannelByName(body.name)) throw new HttpError(409, "name_taken");
      const memberIds =
        body.type === "private"
          ? [...new Set([me.id, ...(body.memberIds ?? [])])]
          : [me.id];
      const channel = store.createChannel({
        type: body.type,
        name: body.name,
        topic: body.topic,
        description: body.description,
        creatorId: me.id,
        memberIds,
      });
      emit({ type: "channel.created", channel }, channel.id);
      return reply.status(201).send({ channel });
    }

    // dm / group_dm — idempotent on the member set.
    const memberIds = [...new Set([me.id, ...body.memberIds])].sort();
    for (const id of memberIds) {
      if (!store.getUser(id)) throw new HttpError(400, "unknown_user", id);
    }
    const dmKey = memberIds.join(":");
    const existing = store.findDmByKey(dmKey);
    if (existing) return { channel: existing };

    const channel = store.createChannel({
      type: memberIds.length === 2 ? "dm" : "group_dm",
      creatorId: me.id,
      memberIds,
      dmKey,
    });
    emit({ type: "channel.created", channel }, channel.id);
    return reply.status(201).send({ channel });
  });

  app.patch<{ Params: { id: string } }>("/api/channels/:id", async (req) => {
    const me = requireUser(req);
    const existing = requireChannelAccess(req.params.id, me);
    if (existing.type === "dm" || existing.type === "group_dm") {
      throw new HttpError(400, "cannot_edit_dm");
    }
    const body = updateChannelBody.parse(req.body);
    if (body.name && body.name !== existing.name && store.getChannelByName(body.name)) {
      throw new HttpError(409, "name_taken");
    }
    const channel = store.updateChannel(existing.id, body);
    emit({ type: "channel.updated", channel }, channel.id);
    return { channel };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/join", async (req) => {
    const me = requireUser(req);
    const channel = store.getChannel(req.params.id);
    if (!channel || channel.type !== "public") throw new HttpError(404, "channel_not_found");
    if (store.addMember(channel.id, me.id)) {
      emit({ type: "member.joined", channelId: channel.id, userId: me.id }, channel.id);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/leave", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.type === "dm") throw new HttpError(400, "cannot_leave_dm");
    if (store.removeMember(channel.id, me.id)) {
      emit({ type: "member.left", channelId: channel.id, userId: me.id }, channel.id);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/invite-member", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    const { userId } = (req.body ?? {}) as { userId?: string };
    if (!userId || !store.getUser(userId)) throw new HttpError(400, "unknown_user");
    if (channel.type === "dm" || channel.type === "group_dm") {
      throw new HttpError(400, "cannot_invite_to_dm");
    }
    if (store.addMember(channel.id, userId)) {
      emit({ type: "member.joined", channelId: channel.id, userId }, channel.id);
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/channels/:id/members", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    return { memberIds: store.memberIds(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/read", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const { seq } = markReadBody.parse(req.body);
    store.markRead(req.params.id, me.id, seq);
    return { ok: true };
  });

  // ---------- messages ----------

  app.get<{ Params: { id: string } }>("/api/channels/:id/messages", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const q = messageHistoryQuery.parse(req.query);
    const messages = store.listMessages({
      channelId: req.params.id,
      before: q.before,
      limit: q.limit,
      threadRootId: q.threadRootId,
    });
    return { messages };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/messages", async (req, reply) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const body = sendMessageBody.parse(req.body);

    if (channel.type === "public" && !store.isMember(channel.id, me.id)) {
      // Posting into a public channel you haven't joined joins you (Slack behavior).
      store.addMember(channel.id, me.id);
      emit({ type: "member.joined", channelId: channel.id, userId: me.id }, channel.id);
    }
    if (body.threadRootId) {
      const root = store.getMessage(body.threadRootId);
      if (!root || root.channelId !== channel.id || root.threadRootId) {
        throw new HttpError(400, "bad_thread_root");
      }
    }

    const message = store.createMessage({
      channelId: channel.id,
      userId: me.id,
      text: body.text,
      threadRootId: body.threadRootId ?? null,
      nonce: body.nonce ?? null,
    });
    emit({ type: "message.created", message }, channel.id);
    return reply.status(201).send({ message });
  });

  app.patch<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const existing = store.getMessage(req.params.id);
    if (!existing || !store.canAccess(existing.channelId, me.id)) {
      throw new HttpError(404, "message_not_found");
    }
    if (existing.userId !== me.id) throw new HttpError(403, "not_your_message");
    const body = editMessageBody.parse(req.body);
    const message = store.editMessage(existing.id, body.text);
    emit({ type: "message.updated", message }, message.channelId);
    return { message };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const existing = store.getMessage(req.params.id);
    if (!existing || !store.canAccess(existing.channelId, me.id)) {
      throw new HttpError(404, "message_not_found");
    }
    const isPrivileged = me.role === "owner" || me.role === "admin";
    if (existing.userId !== me.id && !isPrivileged) throw new HttpError(403, "not_your_message");
    store.deleteMessage(existing.id);
    emit(
      {
        type: "message.deleted",
        channelId: existing.channelId,
        messageId: existing.id,
        threadRootId: existing.threadRootId,
      },
      existing.channelId,
    );
    return { ok: true };
  });

  // ---------- reactions ----------

  app.put<{ Params: { id: string; emoji: string } }>(
    "/api/messages/:id/reactions/:emoji",
    async (req) => {
      const me = requireUser(req);
      const msg = store.getMessage(req.params.id);
      if (!msg || !store.canAccess(msg.channelId, me.id)) {
        throw new HttpError(404, "message_not_found");
      }
      const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
      if (store.addReaction(msg.id, me.id, emoji)) {
        emit(
          { type: "reaction.added", channelId: msg.channelId, messageId: msg.id, emoji, userId: me.id },
          msg.channelId,
        );
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; emoji: string } }>(
    "/api/messages/:id/reactions/:emoji",
    async (req) => {
      const me = requireUser(req);
      const msg = store.getMessage(req.params.id);
      if (!msg || !store.canAccess(msg.channelId, me.id)) {
        throw new HttpError(404, "message_not_found");
      }
      const emoji = decodeURIComponent(req.params.emoji).slice(0, 64);
      if (store.removeReaction(msg.id, me.id, emoji)) {
        emit(
          { type: "reaction.removed", channelId: msg.channelId, messageId: msg.id, emoji, userId: me.id },
          msg.channelId,
        );
      }
      return { ok: true };
    },
  );

  // ---------- invites & search ----------

  app.post("/api/invites", async (req, reply) => {
    const me = requireUser(req);
    const body = createInviteBody.parse(req.body ?? {});
    const invite = store.createInvite({
      createdBy: me.id,
      expiresAt: body.expiresInHours ? Date.now() + body.expiresInHours * 3600_000 : null,
      maxUses: body.maxUses ?? null,
    });
    return reply.status(201).send({ invite });
  });

  app.get("/api/search", async (req) => {
    const me = requireUser(req);
    const q = searchQuery.parse(req.query);
    return { messages: store.searchMessages(me.id, q.q, q.limit) };
  });

  // ---------- start ----------

  const port = opts.port ?? 8543;
  const host = opts.host ?? "0.0.0.0";
  gateway.attach(app.server);
  await app.listen({ port, host });
  const actualPort = (app.server.address() as { port: number }).port;

  let mdnsHandle: MdnsHandle | null = null;
  if (opts.mdns !== false) {
    mdnsHandle = advertise({ name: workspaceName(), port: actualPort });
  }

  const pruneTimer = setInterval(() => store.pruneEvents(), 3600_000);

  return {
    port: actualPort,
    store,
    gateway,
    stop: async () => {
      clearInterval(pruneTimer);
      mdnsHandle?.stop();
      gateway.close();
      await app.close();
      db.close();
    },
  };
}
