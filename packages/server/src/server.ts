import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import {
  PROTOCOL_VERSION,
  createChannelBody,
  channelPrefsBody,
  createAppBody,
  createWebhookBody,
  createInviteBody,
  scheduleMessageBody,
  editMessageBody,
  loginBody,
  markReadBody,
  messageHistoryQuery,
  registerBody,
  parseSearchQuery,
  hasSearchCriteria,
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
import { imageSize } from "./imageSize.js";
import { payloadToText } from "./blockKit.js";
import { secretToken } from "./ids.js";

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
  /** Max upload size in bytes. Default 100 MB. */
  maxFileSize?: number;
  logger?: boolean;
}

export interface WorkspaceServer {
  port: number;
  store: Store;
  gateway: Gateway;
  /** Posts anything now due. Runs on a timer; exposed so tests need not wait. */
  flushScheduled: () => void;
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

  /** Posts a message and fans it out. Used by the API and the scheduler alike. */
  const postMessage = (input: {
    channelId: ID;
    userId: ID;
    text: string;
    threadRootId: ID | null;
    nonce: string | null;
    fileIds: ID[];
  }) => {
    const created = store.createMessage({
      channelId: input.channelId,
      userId: input.userId,
      text: input.text,
      threadRootId: input.threadRootId,
      nonce: input.nonce,
    });
    if (input.fileIds.length > 0) {
      store.attachFiles(input.fileIds, created.id, input.channelId, input.userId);
    }
    // Re-read so the broadcast event carries the attachments.
    const message = store.getMessage(created.id)!;
    emit({ type: "message.created", message }, input.channelId);
    return message;
  };

  // Uploads live beside the database so one folder is the whole workspace.
  const filesDir = opts.dataDir === ":memory:" ? null : join(opts.dataDir, "files");
  if (filesDir) mkdirSync(filesDir, { recursive: true });
  const maxFileSize = opts.maxFileSize ?? 100 * 1024 * 1024;
  const blobPath = (fileId: string) => join(filesDir!, fileId);

  const app = Fastify({ logger: opts.logger ?? false });
  // The default allow-list is GET/HEAD/POST only, which silently breaks
  // reactions, edits, deletes, pins and saves in the browser.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(multipart, { limits: { fileSize: maxFileSize, files: 1 } });

  // Slack-style integrations often post `payload=<json>` as a form rather than
  // JSON, so accept that shape too. Small enough not to warrant a plugin.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    },
  );

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
      // Named channels carry no memberIds, so announce the founding members
      // explicitly or clients won't know they belong to it.
      for (const userId of memberIds) {
        emit({ type: "member.joined", channelId: channel.id, userId }, channel.id);
      }
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

  app.get<{ Params: { id: string; messageId: string } }>(
    "/api/channels/:id/messages/around/:messageId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const limit = Math.min(Number((req.query as { limit?: string }).limit) || 50, 200);
      return store.listMessagesAround(req.params.id, req.params.messageId, limit);
    },
  );

  app.get<{ Params: { id: string; messageId: string } }>(
    "/api/channels/:id/messages/after/:messageId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const limit = Math.min(Number((req.query as { limit?: string }).limit) || 50, 200);
      return { messages: store.listMessagesAfter(req.params.id, req.params.messageId, limit) };
    },
  );

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

    const message = postMessage({
      channelId: channel.id,
      userId: me.id,
      text: body.text,
      threadRootId: body.threadRootId ?? null,
      nonce: body.nonce ?? null,
      fileIds: body.fileIds ?? [],
    });
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

    // Drop the blobs along with the message so deleted content really goes.
    const fileIds = store.fileIdsForMessage(existing.id);
    store.deleteFiles(fileIds);
    if (filesDir) {
      await Promise.all(fileIds.map((id) => unlink(blobPath(id)).catch(() => {})));
    }
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

  // ---------- files ----------

  app.post<{ Params: { id: string } }>("/api/channels/:id/files", async (req, reply) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (!filesDir) throw new HttpError(501, "uploads_disabled");

    const part = await req.file();
    if (!part) throw new HttpError(400, "no_file");

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      throw new HttpError(413, "file_too_large", `files must be under ${maxFileSize} bytes`);
    }
    if (part.file.truncated) {
      throw new HttpError(413, "file_too_large", `files must be under ${maxFileSize} bytes`);
    }

    const dims = part.mimetype.startsWith("image/") ? imageSize(buffer) : null;
    const file = store.createFile({
      channelId: channel.id,
      userId: me.id,
      name: part.filename.slice(0, 255),
      mime: part.mimetype,
      size: buffer.byteLength,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    });
    await writeFile(blobPath(file.id), buffer);
    return reply.status(201).send({ file });
  });

  app.get<{ Params: { id: string } }>("/api/files/:id", async (req, reply) => {
    const me = requireUser(req);
    const file = store.getFile(req.params.id);
    if (!file || !filesDir || !store.canAccess(file.channelId, me.id)) {
      throw new HttpError(404, "file_not_found");
    }
    let body: Buffer;
    try {
      body = await readFile(blobPath(file.id));
    } catch {
      throw new HttpError(404, "file_not_found");
    }
    // Content is immutable once uploaded, so let clients cache it hard.
    return reply
      .header("content-type", file.mime)
      .header("content-length", String(file.size))
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(body);
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

  // ---------- apps, webhooks and the Slack-compatible API ----------

  const requireAdmin = (req: FastifyRequest): User => {
    const me = requireUser(req);
    if (me.role !== "owner" && me.role !== "admin") throw new HttpError(403, "admin_only");
    return me;
  };

  /** A handle for the app's bot user that cannot collide with a person's. */
  const botHandle = (name: string): string => {
    const base =
      name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-|-$/g, "")
        .slice(0, 24) || "bot";
    let handle = `${base}-bot`;
    let n = 2;
    while (store.getUserAuthByHandle(handle)) handle = `${base}-bot-${n++}`;
    return handle;
  };

  app.post("/api/apps", async (req, reply) => {
    const me = requireAdmin(req);
    const body = createAppBody.parse(req.body);

    // A bot posts as a real (non-human) user, so messages render normally.
    const { hash, salt } = hashPassword(secretToken());
    const bot = store.createBotUser(botHandle(body.name), body.name, hash, salt);
    const created = store.createApp({ name: body.name, botUserId: bot.id, createdBy: me.id });

    const token = secretToken("xoxb-");
    store.addAppToken(created.id, hashToken(token));
    emit({ type: "user.joined", user: bot }, null);

    // The token is shown once and only stored hashed.
    return reply.status(201).send({ app: created, botUser: bot, token });
  });

  app.get("/api/apps", async (req) => {
    requireAdmin(req);
    const apps = store.listApps();
    return {
      apps: apps.map((a) => ({ ...a, webhooks: store.listWebhooks(a.id) })),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/apps/:id", async (req) => {
    requireAdmin(req);
    if (!store.getApp(req.params.id)) throw new HttpError(404, "not_found");
    store.deleteApp(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/apps/:id/webhooks", async (req, reply) => {
    const me = requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = createWebhookBody.parse(req.body);
    const channel = requireChannelAccess(body.channelId, me);

    const token = secretToken();
    const webhook = store.createWebhook({
      appId: owner.id,
      channelId: channel.id,
      tokenHash: hashToken(token),
    });
    // The bot must be in the channel to post to it.
    if (store.addMember(channel.id, owner.botUserId)) {
      emit({ type: "member.joined", channelId: channel.id, userId: owner.botUserId }, channel.id);
    }
    return reply.status(201).send({ webhook, url: `/hooks/${token}` });
  });

  app.delete<{ Params: { id: string } }>("/api/webhooks/:id", async (req) => {
    requireAdmin(req);
    if (!store.deleteWebhook(req.params.id)) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  /**
   * Incoming webhook, shaped like Slack's: POST a JSON body with `text` and/or
   * `blocks`. Form-encoded `payload=<json>` is accepted too, since many older
   * integrations send it that way.
   */
  app.post<{ Params: { token: string } }>("/hooks/:token", async (req, reply) => {
    const found = store.webhookForToken(hashToken(req.params.token));
    if (!found) return reply.status(404).send({ ok: false, error: "invalid_webhook" });

    let payload: { text?: unknown; blocks?: unknown } = {};
    const raw = req.body as Record<string, unknown> | string | undefined;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        return reply.status(400).send({ ok: false, error: "invalid_payload" });
      }
    } else if (raw && typeof raw === "object") {
      if (typeof raw.payload === "string") {
        try {
          payload = JSON.parse(raw.payload) as typeof payload;
        } catch {
          return reply.status(400).send({ ok: false, error: "invalid_payload" });
        }
      } else {
        payload = raw as typeof payload;
      }
    }

    const text = payloadToText(payload);
    if (!text) return reply.status(400).send({ ok: false, error: "no_text" });

    const channel = store.getChannel(found.webhook.channelId);
    if (!channel || channel.archived) {
      return reply.status(404).send({ ok: false, error: "channel_not_found" });
    }
    postMessage({
      channelId: channel.id,
      userId: found.app.botUserId,
      text,
      threadRootId: null,
      nonce: null,
      fileIds: [],
    });
    // Slack replies with the literal string "ok"; tools check for it.
    return reply.type("text/plain").send("ok");
  });

  /**
   * Slack Web API compatible send, so existing bot code works by pointing at
   * this server. Errors use Slack's `{ok:false, error}` shape.
   */
  app.post("/api/chat.postMessage", async (req, reply) => {
    const token = bearerToken(req);
    const owner = token ? store.appForToken(hashToken(token)) : null;
    if (!owner) return reply.status(401).send({ ok: false, error: "invalid_auth" });

    const body = (req.body ?? {}) as {
      channel?: string;
      text?: unknown;
      blocks?: unknown;
      thread_ts?: string;
    };
    if (typeof body.channel !== "string" || !body.channel) {
      return reply.status(400).send({ ok: false, error: "channel_not_found" });
    }

    // Slack accepts an id or a #name; so do we.
    const named = body.channel.replace(/^#/, "");
    const channel = store.getChannel(body.channel) ?? store.getChannelByName(named);
    if (!channel || channel.archived) {
      return reply.status(404).send({ ok: false, error: "channel_not_found" });
    }

    const text = payloadToText(body);
    if (!text) return reply.status(400).send({ ok: false, error: "no_text" });

    if (store.addMember(channel.id, owner.botUserId)) {
      emit({ type: "member.joined", channelId: channel.id, userId: owner.botUserId }, channel.id);
    }

    let threadRootId: ID | null = null;
    if (body.thread_ts) {
      const root = store.getMessage(body.thread_ts);
      // An unknown thread parent is not worth failing the whole send over.
      if (root && root.channelId === channel.id && !root.threadRootId) threadRootId = root.id;
    }

    const message = postMessage({
      channelId: channel.id,
      userId: owner.botUserId,
      text,
      threadRootId,
      nonce: null,
      fileIds: [],
    });
    // `ts` is Slack's message identifier; ours is the message id.
    return { ok: true, channel: channel.id, ts: message.id, message };
  });

  // ---------- scheduled messages ----------

  app.post<{ Params: { id: string } }>("/api/channels/:id/scheduled", async (req, reply) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const body = scheduleMessageBody.parse(req.body);
    if (body.sendAt <= Date.now()) {
      throw new HttpError(400, "send_at_in_past", "pick a time in the future");
    }
    const scheduled = store.scheduleMessage({
      channelId: channel.id,
      userId: me.id,
      text: body.text,
      threadRootId: body.threadRootId ?? null,
      fileIds: body.fileIds ?? [],
      sendAt: body.sendAt,
    });
    return reply.status(201).send({ scheduled });
  });

  app.get("/api/scheduled", async (req) => {
    const me = requireUser(req);
    return { scheduled: store.listScheduled(me.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/scheduled/:id", async (req) => {
    const me = requireUser(req);
    const scheduled = store.getScheduled(req.params.id);
    // Only the author may cancel, and a missing one is simply gone.
    if (!scheduled || scheduled.userId !== me.id) throw new HttpError(404, "not_found");
    store.deleteScheduled(scheduled.id);
    return { ok: true };
  });

  // ---------- pins & saved items ----------

  /** Resolves a message the caller is allowed to see, or 404s. */
  const requireVisibleMessage = (messageId: ID, user: User) => {
    const message = store.getMessage(messageId);
    if (!message || !store.canAccess(message.channelId, user.id)) {
      throw new HttpError(404, "message_not_found");
    }
    return message;
  };

  app.put<{ Params: { id: string } }>("/api/messages/:id/pin", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (store.addPin(message.channelId, message.id, me.id)) {
      emit(
        { type: "pin.added", channelId: message.channelId, messageId: message.id, userId: me.id },
        message.channelId,
      );
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/pin", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (store.removePin(message.id)) {
      emit(
        { type: "pin.removed", channelId: message.channelId, messageId: message.id },
        message.channelId,
      );
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/channels/:id/pins", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    return { messages: store.listPins(req.params.id) };
  });

  app.put<{ Params: { id: string } }>("/api/messages/:id/save", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (store.addSaved(me.id, message.id)) {
      gateway.sendToUser(me.id, { type: "saved", messageId: message.id, saved: true });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/save", async (req) => {
    const me = requireUser(req);
    if (store.removeSaved(me.id, req.params.id)) {
      gateway.sendToUser(me.id, { type: "saved", messageId: req.params.id, saved: false });
    }
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/channels/:id/prefs", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    if (!store.isMember(req.params.id, me.id)) throw new HttpError(400, "not_a_member");
    const body = channelPrefsBody.parse(req.body ?? {});
    const prefs = store.setChannelPrefs(req.params.id, me.id, body);
    if (!prefs) throw new HttpError(404, "channel_not_found");
    // Preferences are personal: only this user's own devices need to know.
    gateway.sendToUser(me.id, { type: "prefs", channelId: req.params.id, prefs });
    return { prefs };
  });

  app.get("/api/saved", async (req) => {
    const me = requireUser(req);
    return { messages: store.listSaved(me.id) };
  });

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
    const parsed = parseSearchQuery(q.q);
    // A query of nothing but stray punctuation should return nothing, not everything.
    if (!hasSearchCriteria(parsed)) return { messages: [] };
    return { messages: store.searchMessages(me.id, parsed, q.limit) };
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

  /**
   * Posts anything that has come due. Runs on a timer and once at startup, so
   * messages scheduled while the server was down still go out.
   */
  const flushScheduled = () => {
    for (const item of store.dueScheduled()) {
      // Drop it first: a message that fails to post must not retry forever.
      store.deleteScheduled(item.id);
      const channel = store.getChannel(item.channelId);
      if (!channel || channel.archived || !store.canAccess(item.channelId, item.userId)) continue;
      postMessage({
        channelId: item.channelId,
        userId: item.userId,
        text: item.text,
        threadRootId: item.threadRootId,
        nonce: null,
        fileIds: item.fileIds,
      });
    }
  };
  flushScheduled();
  const scheduleTimer = setInterval(flushScheduled, 15_000);

  const pruneTimer = setInterval(() => store.pruneEvents(), 3600_000);

  return {
    port: actualPort,
    store,
    gateway,
    flushScheduled,
    stop: async () => {
      clearInterval(scheduleTimer);
      clearInterval(pruneTimer);
      mdnsHandle?.stop();
      gateway.close();
      await app.close();
      db.close();
    },
  };
}
