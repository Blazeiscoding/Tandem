import { join } from "node:path";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import {
  PROTOCOL_VERSION,
  channelPermissions,
  canRemoveChannelMember,
  canSetChannelManager,
  channelManagerBody,
  createChannelBody,
  channelPrefsBody,
  savedMessagesQuery,
  pinnedMessagesQuery,
  followedThreadsQuery,
  threadFollowBody,
  threadReadBody,
  adminUserBody,
  createAppBody,
  createCommandBody,
  createSubscriptionBody,
  interactivityBody,
  messageActionBody,
  viewSubmitBody,
  createWebhookBody,
  runCommandBody,
  createInviteBody,
  scheduleMessageBody,
  rescheduleBody,
  editScheduledBody,
  changePasswordBody,
  editMessageBody,
  loginBody,
  markReadBody,
  markUnreadBody,
  messageHistoryQuery,
  threadHistoryQuery,
  registerBody,
  parseSearchQuery,
  hasSearchCriteria,
  searchQuery,
  activityQuery,
  sendMessageBody,
  updateChannelBody,
  updateMeBody,
  type EventEnvelope,
  type ID,
  type MessageAction,
  type Message,
  type ModalView,
  type ServerInfo,
  type User,
  type WorkspaceEvent,
} from "@slackoss/protocol";
import { openDb } from "./db.js";
import { Store } from "./store.js";
import { StorageBudget } from "./storageBudget.js";
import { Gateway } from "./gateway.js";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "./auth.js";
import { advertise, type MdnsHandle } from "./mdns.js";
import { imageSize } from "./imageSize.js";
import { blocksToActions, parseView, payloadToText } from "./blockKit.js";
import { OutboundError, postToUrl } from "./outbound.js";
import { eventActorId, signatureHeaders, toSlackEvent } from "./integrations.js";
import { BUILTIN_COMMANDS } from "./commands.js";
import { secretToken, ulid } from "./ids.js";

export const SERVER_VERSION = "0.1.0";

/** How many times an unexplained delivery error is retried before giving up. */
const SCHEDULED_ATTEMPTS = 3;

/** Delivered queue rows are kept this long as proof of completion. */
const SCHEDULED_RETENTION_MS = 7 * 24 * 3600_000;

/** Delays after failures; the eighth failed attempt becomes terminal. */
const EVENT_DELIVERY_RETRY_MS = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  3600_000,
  6 * 3600_000,
];
const EVENT_DELIVERY_ATTEMPTS = EVENT_DELIVERY_RETRY_MS.length + 1;
const EVENT_DELIVERY_RETENTION_MS = 7 * 24 * 3600_000;

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
  /** Attachment storage cap in bytes, including pending uploads. Zero/omitted is unlimited. */
  maxStorageBytes?: number;
  /**
   * How long an upload may sit unattached before it counts as abandoned.
   * Default 24 hours. Must outlast the gap between choosing a file and sending
   * it, including a client that is offline in between.
   */
  abandonedUploadTtlMs?: number;
  /**
   * The address others reach this server on, e.g. "https://chat.team.dev".
   * Used to build the `response_url` handed to slash commands. Set it when a
   * reverse proxy sits in front; otherwise the request's own Host is used.
   */
  publicUrl?: string;
  /**
   * Lets slash commands and event subscriptions call private addresses
   * (192.168.x, 10.x, localhost…). Off by default: the server can reach the
   * host's whole LAN, and an admin-typed URL should not become a probe of it.
   * Turn it on deliberately when the bot really does run on the same network.
   */
  allowPrivateHooks?: boolean;
  logger?: boolean;
  /** Private deployments default to LAN-only media with no external ICE service. */
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
}

export interface WorkspaceServer {
  port: number;
  store: Store;
  gateway: Gateway;
  /**
   * The code needed to claim an unowned workspace from off this machine. Null
   * once someone owns it. The host prints it; it is not served over the API.
   */
  claimCode: string | null;
  /** Posts anything now due. Runs on a timer; exposed so tests need not wait. */
  flushScheduled: () => void;
  /** Retries a bounded batch of committed attachment deletions. */
  flushFileDeletions: () => Promise<void>;
  /** Frees uploads nobody attached. Runs on a timer; exposed so tests need not wait. */
  expireAbandonedUploads: () => number;
  /** Delivers a bounded batch of committed integration events. */
  flushEventDeliveries: () => Promise<void>;
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
  if (
    opts.maxStorageBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxStorageBytes) || opts.maxStorageBytes < 0)
  ) {
    throw new Error("maxStorageBytes must be a non-negative safe integer");
  }
  // Zero would sweep uploads the moment they land, taking working ones with it.
  if (
    opts.abandonedUploadTtlMs !== undefined &&
    (!Number.isSafeInteger(opts.abandonedUploadTtlMs) || opts.abandonedUploadTtlMs <= 0)
  ) {
    throw new Error("abandonedUploadTtlMs must be a positive safe integer");
  }
  const dbPath = opts.dataDir === ":memory:" ? ":memory:" : join(opts.dataDir, "workspace.db");
  const db = openDb(dbPath);
  const store = new Store(db);

  if (opts.workspaceName) store.setMeta("workspace_name", opts.workspaceName);
  if (!store.getMeta("workspace_name")) store.setMeta("workspace_name", "My Workspace");
  // Slack payloads carry a team id; ours is generated once and never changes.
  if (!store.getMeta("workspace_id")) store.setMeta("workspace_id", ulid());
  if (!store.getMeta("default_channel_id")) {
    const general = store.getChannelByName("general");
    if (general?.type === "public") store.setMeta("default_channel_id", general.id);
  }
  if (opts.inviteOnly !== undefined) store.setMeta("invite_only", opts.inviteOnly ? "1" : "0");
  const workspaceName = () => store.getMeta("workspace_name")!;
  const inviteOnly = () => store.getMeta("invite_only") === "1";

  /**
   * A workspace with no owner is up for grabs. Until one exists, the account
   * that becomes owner must come either from the machine running the server or
   * from someone holding the code it printed at startup — otherwise the first
   * stranger to find it on the network owns it.
   */
  if (store.userCount() === 0 && !store.getMeta("claim_code")) {
    store.setMeta("claim_code", secretToken());
  }
  const claimCode = () => store.getMeta("claim_code") || null;
  /** Whatever the client called itself. Shown back to its owner, never trusted. */
  const deviceName = (req: FastifyRequest) => String(req.headers["user-agent"] ?? "").slice(0, 200);
  /**
   * Whether this request came from the machine running the server.
   *
   * Behind a reverse proxy every request arrives from loopback, which would
   * hand the local bypass to the whole internet. So a request that shows any
   * sign of having been forwarded is never local, and neither is any request to
   * a server configured with a public URL.
   */
  const isLocalRequest = (req: FastifyRequest) => {
    if (opts.publicUrl) return false;
    if (
      ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"].some(
        (name) => req.headers[name] !== undefined,
      )
    )
      return false;
    const ip = (req.ip || "").replace(/^::ffff:/, "");
    return ip === "127.0.0.1" || ip === "::1";
  };

  const gateway = new Gateway(store, workspaceName);

  const recordEvent = (event: WorkspaceEvent, channelId: ID | null): EventEnvelope => {
    const envelope = store.appendEvent(event, channelId);
    if (event.type === "message.created") {
      store.stampMessageSeq(event.message.id, event.message.channelId, envelope.seq);
      event.message.seq = envelope.seq;
      // Every way a reply can be written arrives here, so following belongs
      // here too rather than in each of the routes that can create one.
      if (event.message.threadRootId) {
        store.autoFollowThread(event.message.threadRootId, event.message.userId, envelope.seq);
      }
    }
    enqueueSubscriberDeliveries(envelope, channelId);
    return envelope;
  };
  /**
   * A reply follows its thread for its author and the root's author. Their
   * other devices only learn that from the handshake unless we say so, so tell
   * them here — after the commit that created the follow row.
   */
  const publishThreadFollows = (envelope: EventEnvelope): void => {
    const event = envelope.event;
    if (event.type !== "message.created" || !event.message.threadRootId) return;
    const root = store.getMessage(event.message.threadRootId);
    // Everyone following it needs the new watermark, not just the two accounts
    // this reply may have signed up.
    const recipients = new Set([
      ...store.threadFollowers(event.message.threadRootId),
      event.message.userId,
      ...(root ? [root.userId] : []),
    ]);
    for (const userId of recipients) {
      const state = store.threadFollow(userId, event.message.threadRootId);
      if (state) gateway.sendToUser(userId, { type: "thread.follow", state });
    }
  };
  /**
   * Recomputes and sends unread mention counts. Only the people whose counts
   * can have changed are told, so an ordinary message costs nothing.
   */
  const pushMentionCounts = (userIds: Iterable<ID>): void => {
    for (const userId of new Set(userIds)) {
      gateway.sendToUser(userId, { type: "mentions", counts: store.unreadMentionCounts(userId) });
    }
  };

  /**
   * A message arriving or leaving changes the counts of whoever it names.
   * Deletion is read from the event's own copy, since the row is already gone.
   */
  const publishMentionChanges = (envelope: EventEnvelope): void => {
    const event = envelope.event;
    if (event.type === "message.created") {
      pushMentionCounts(
        store.mentionedMemberIds(event.message.channelId, event.message.text, event.message.userId),
      );
    } else if (event.type === "message.deleted" && event.channelId) {
      pushMentionCounts(store.memberIds(event.channelId));
    }
  };

  const publish = (envelope: EventEnvelope, channelId: ID | null) => {
    gateway.publish(envelope, channelId);
    void flushEventDeliveries();
    publishThreadFollows(envelope);
    publishMentionChanges(envelope);
  };
  /** Commit synchronous state and its event log before exposing any side effects. */
  const mutate = <T>(
    work: (record: typeof recordEvent, afterCommit: (effect: () => void) => void) => T,
  ): T => {
    const events: { envelope: EventEnvelope; channelId: ID | null }[] = [];
    const effects: (() => void)[] = [];
    const result = store.transaction(() =>
      work(
        (event, channelId) => {
          const envelope = recordEvent(event, channelId);
          events.push({ envelope, channelId });
          return envelope;
        },
        (effect) => effects.push(effect),
      ),
    );
    // Access revocation must happen before fanout, but only after a successful commit.
    for (const effect of effects) effect();
    for (const { envelope, channelId } of events) publish(envelope, channelId);
    return result;
  };

  /** Adds every eligible subscriber beside the event, inside its transaction. */
  const enqueueSubscriberDeliveries = (envelope: EventEnvelope, channelId: ID | null): void => {
    const subs = store.listAllSubscriptions();
    if (subs.length === 0) return;
    const payload = toSlackEvent(envelope.event);
    if (!payload) return;
    const actor = eventActorId(envelope.event);

    for (const { subscription, app: owner } of subs) {
      if (
        subscription.eventTypes.length > 0 &&
        !subscription.eventTypes.includes(envelope.event.type)
      ) {
        continue;
      }
      // Never hand an app back its own bot's actions — that is how a bot that
      // replies to messages ends up replying to itself forever.
      if (actor !== null && actor === owner.botUserId) continue;
      // An app sees a channel only once its bot has been added to it, so
      // subscribing does not quietly expose every private conversation.
      if (channelId !== null && !store.isMember(channelId, owner.botUserId)) continue;

      const body = JSON.stringify({
        type: "event_callback",
        event_id: `Ev${envelope.seq}`,
        event_time: Math.floor(Date.now() / 1000),
        team_id: store.getMeta("workspace_id"),
        event: payload,
        // Our own event beside Slack's shape, so a native app need not
        // reverse-engineer the mapping.
        slackoss: { type: envelope.event.type, seq: envelope.seq },
      });
      store.enqueueEventDelivery(subscription.id, channelId, envelope.seq, body);
    }
  };

  let eventDeliveryFlush: Promise<void> | null = null;
  /**
   * Delivers in sequence per subscription and in parallel across endpoints.
   * A receiver can see a duplicate if this process dies after its HTTP 2xx but
   * before the row is deleted; event_id remains stable so it can deduplicate.
   */
  const flushEventDeliveries = (): Promise<void> => {
    if (eventDeliveryFlush) return eventDeliveryFlush;
    eventDeliveryFlush = (async () => {
      let remaining = 50;
      while (remaining > 0) {
        const due = store.dueEventDeliveries(Date.now(), Math.min(10, remaining));
        if (due.length === 0) break;
        remaining -= due.length;
        await Promise.all(
          due.map(async (delivery) => {
            try {
              const retryHeaders: Record<string, string> =
                delivery.attempts > 0
                  ? {
                      "x-slack-retry-num": String(delivery.attempts),
                      "x-slack-retry-reason": "http_error",
                    }
                  : {};
              const res = await postToUrl(delivery.url, delivery.body, "application/json", {
                allowPrivate: opts.allowPrivateHooks,
                headers: {
                  ...signatureHeaders(delivery.signingSecret, delivery.body),
                  ...retryHeaders,
                },
              });
              if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
              store.completeEventDelivery(delivery.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : "unknown delivery error";
              const delay =
                EVENT_DELIVERY_RETRY_MS[
                  Math.min(delivery.attempts, EVENT_DELIVERY_RETRY_MS.length - 1)
                ]!;
              const failure = store.failEventDelivery(
                delivery.id,
                message,
                Date.now() + delay,
                EVENT_DELIVERY_ATTEMPTS,
              );
              // Deleting the subscription/app or revoking channel membership
              // while the request was in flight deliberately removed the row.
              if (!failure) return;
              app.log.warn(
                {
                  subscriptionId: delivery.subscriptionId,
                  eventSeq: delivery.eventSeq,
                  attempt: failure.attempts,
                  terminal: failure.terminal,
                  err: message,
                },
                failure.terminal
                  ? "event subscription delivery abandoned"
                  : "event subscription delivery will retry",
              );
            }
          }),
        );
      }
    })().finally(() => {
      eventDeliveryFlush = null;
    });
    return eventDeliveryFlush;
  };

  /** Posts a message and fans it out. Used by the API and the scheduler alike. */
  const postMessage = (input: {
    channelId: ID;
    userId: ID;
    text: string;
    threadRootId: ID | null;
    nonce: string | null;
    fileIds: ID[];
    actions?: MessageAction[];
    /** For a reply: show it in the channel's own timeline as well. */
    broadcast?: boolean;
    /** Marks this queue row delivered in the same transaction as the message. */
    scheduledId?: ID;
  }) => {
    const events: EventEnvelope[] = [];
    const message = store.transaction(() => {
      const channel = store.getChannel(input.channelId);
      if (!channel || !store.canAccess(channel.id, input.userId))
        throw new HttpError(404, "channel_not_found");
      if (store.getUser(input.userId)?.deactivated) throw new HttpError(403, "account_deactivated");
      const requestHash = hashToken(
        JSON.stringify([
          input.channelId,
          input.text,
          input.threadRootId,
          input.broadcast ?? false,
          [...input.fileIds].sort(),
        ]),
      );
      if (input.nonce !== null) {
        const previous = store.messageRequest(input.userId, input.nonce);
        if (previous) {
          const existing = store.getMessage(previous.messageId);
          if (!existing) throw new HttpError(409, "message_deleted");
          if (
            (previous.requestHash !== null && previous.requestHash !== requestHash) ||
            existing.channelId !== input.channelId ||
            existing.threadRootId !== input.threadRootId
          ) {
            throw new HttpError(409, "nonce_conflict");
          }
          return existing;
        }
      }
      if (channel.archived) throw new HttpError(400, "channel_archived");
      if (input.threadRootId) {
        const root = store.getMessage(input.threadRootId);
        if (!root || root.channelId !== channel.id || root.threadRootId)
          throw new HttpError(400, "bad_thread_root");
      }
      if (channel.type === "public" && !store.isMember(channel.id, input.userId)) {
        store.addMember(channel.id, input.userId);
        events.push(
          recordEvent(
            { type: "member.joined", channelId: channel.id, userId: input.userId },
            channel.id,
          ),
        );
      }
      const created = store.createMessage(input);
      if (!store.attachFiles(input.fileIds, created.id, input.channelId, input.userId))
        throw new HttpError(400, "invalid_attachments");
      const hydrated = store.getMessage(created.id)!;
      if (input.nonce !== null)
        store.recordMessageRequest(input.userId, input.nonce, created.id, requestHash);
      if (input.scheduledId) store.markScheduledSent(input.scheduledId, created.id);
      events.push(recordEvent({ type: "message.created", message: hydrated }, input.channelId));
      return hydrated;
    });
    for (const event of events) publish(event, input.channelId);
    return message;
  };

  // Uploads live beside the database so one folder is the whole workspace.
  const filesDir = opts.dataDir === ":memory:" ? null : join(opts.dataDir, "files");
  if (filesDir) mkdirSync(filesDir, { recursive: true });
  const maxFileSize = opts.maxFileSize ?? 100 * 1024 * 1024;
  const blobPath = (fileId: string) => join(filesDir!, fileId);
  const storage = new StorageBudget(filesDir, opts.maxStorageBytes || null);
  const abandonedUploadTtlMs = opts.abandonedUploadTtlMs ?? 24 * 3600_000;

  let fileCleanup: Promise<void> | null = null;
  const flushFileDeletions = (): Promise<void> => {
    if (fileCleanup) return fileCleanup;
    fileCleanup = (async () => {
      for (const id of store.pendingFileDeletions()) {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
          app.log.error({ fileId: id }, "invalid attachment cleanup id");
          continue;
        }
        try {
          if (filesDir) await unlink(blobPath(id));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            app.log.warn({ fileId: id, err }, "attachment cleanup deferred");
            continue;
          }
        }
        store.completeFileDeletion(id);
        storage.release(id);
      }
    })()
      .catch((err) => {
        app.log.error({ err }, "attachment cleanup failed; pending work retained");
      })
      .finally(() => {
        fileCleanup = null;
      });
    return fileCleanup;
  };

  /**
   * Frees uploads nobody ever sent. Without this an attachment chosen and then
   * thought better of holds its bytes for the life of the workspace, which the
   * storage cap turns from untidy into a workspace that slowly fills up.
   */
  const expireAbandonedUploads = (): number => {
    const ids = store.abandonedFileIds(Date.now() - abandonedUploadTtlMs);
    if (ids === null) {
      app.log.error("scheduled queue unreadable; abandoned uploads left alone this round");
      return 0;
    }
    if (ids.length === 0) return 0;
    store.transaction(() => {
      store.deleteFiles(ids);
      store.queueFileDeletions(ids);
    });
    app.log.info({ count: ids.length }, "expired abandoned uploads");
    return ids.length;
  };

  /**
   * Blobs on disk that no `files` row accounts for. A process killed between
   * writing the bytes and recording them leaves one behind: it counts against
   * the workspace cap, and without this nothing would ever ask to delete it.
   *
   * Safe only before uploads can start, since a blob being written right now
   * has no row yet either. It runs once, at startup, for that reason.
   */
  const reconcileOrphanedBlobs = (): number => {
    if (!filesDir) return 0;
    const orphans = store.unknownFileIds(storage.storedIds());
    if (orphans.length === 0) return 0;
    // Through the usual queue, so a blob that will not delete is retried rather
    // than lost track of, and its bytes are released when it really goes.
    store.queueFileDeletions(orphans);
    app.log.warn({ count: orphans.length }, "queued orphaned attachment blobs");
    return orphans.length;
  };

  const removeMessage = (existing: Message) =>
    mutate((emit) => {
      const fileIds = store.fileIdsForMessage(existing.id);
      store.deleteFiles(fileIds);
      store.queueFileDeletions(fileIds);
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
    });

  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });
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

  /** How this server is addressed from outside, for URLs we hand to apps. */
  const requestOrigin = (req: FastifyRequest): string => {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/$/, "");
    const proto =
      String(req.headers["x-forwarded-proto"] ?? "")
        .split(",")[0]
        ?.trim() || "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
      .split(",")[0]
      ?.trim();
    return host ? `${proto}://${host}` : `http://localhost:${opts.port ?? 8543}`;
  };

  /**
   * Routes an account may reach while it still holds a password someone else
   * chose: replacing that password, and getting out.
   */
  const ALLOWED_WHILE_LOCKED = new Set(["/api/auth/password", "/api/auth/logout"]);

  const requireUser = (req: FastifyRequest): User => {
    const token = bearerToken(req);
    const user = token ? store.getSessionUser(hashToken(token)) : null;
    if (!user) throw new HttpError(401, "unauthorized");
    // Checked here rather than per route, so a route added later is covered.
    if (
      !ALLOWED_WHILE_LOCKED.has(req.routeOptions.url ?? "") &&
      store.mustChangePassword(user.id)
    ) {
      throw new HttpError(
        403,
        "password_change_required",
        "Choose a new password before using this workspace.",
      );
    }
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

  app.get("/api/health", async () => {
    db.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  app.get("/api/rtc-config", async (req, reply) => {
    requireUser(req);
    reply.header("Cache-Control", "no-store");
    return { iceServers: opts.iceServers ?? [] };
  });

  // Bound simultaneous password derivations; each scrypt job uses substantial
  // memory. Do the expensive work off the event loop so calls/chat stay responsive.
  let authJobs = 0;
  const beginAuth = () => {
    if (authJobs >= 2) throw new HttpError(429, "auth_busy", "Please retry in a moment");
    authJobs++;
  };

  app.get("/api/server-info", async (req): Promise<ServerInfo> => {
    const userCount = store.userCount();
    return {
      app: "slackoss",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      workspaceName: workspaceName(),
      userCount,
      requiresInvite: userCount > 0 && inviteOnly(),
      requiresClaim: userCount === 0 && !!claimCode() && !isLocalRequest(req),
      schedulingIdempotency: true,
      downloadTickets: true,
    };
  });

  app.post("/api/auth/register", async (req, reply) => {
    const body = registerBody.parse(req.body);
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.password);
    } finally {
      authJobs--;
    }
    // Everything after hashing is synchronous: concurrent registrations cannot
    // both become owner or consume the same final invitation use.
    const { token, user } = mutate((emit) => {
      const isFirstUser = store.userCount() === 0;

      if (store.getUserAuthByHandle(body.handle)) {
        throw new HttpError(409, "handle_taken");
      }

      if (isFirstUser) {
        const expected = claimCode();
        if (expected && !isLocalRequest(req) && body.claimCode !== expected) {
          throw new HttpError(
            403,
            "claim_required",
            "this workspace has no owner yet; enter the claim code its host printed at startup",
          );
        }
      }

      if (!isFirstUser && inviteOnly()) {
        if (!body.inviteCode || !store.consumeInvite(body.inviteCode)) {
          throw new HttpError(403, "invite_required", "a valid invite code is required to join");
        }
      }
      const { hash, salt } = credentials;
      const user = store.createUser({
        handle: body.handle,
        displayName: body.displayName,
        passwordHash: hash,
        salt,
        role: isFirstUser ? "owner" : "member",
      });

      if (isFirstUser) {
        // Single use: the workspace now has an owner and cannot be claimed again.
        store.setMeta("claim_code", "");
        // Bootstrap the workspace with #general.
        const general = store.createChannel({
          type: "public",
          name: "general",
          description: "This channel is for workspace-wide communication.",
          creatorId: user.id,
          memberIds: [user.id],
        });
        store.setMeta("default_channel_id", general.id);
        emit({ type: "channel.created", channel: general }, general.id);
      } else {
        emit({ type: "user.joined", user }, null);
        // Renaming the default room must not change who new accounts join.
        const defaultId = store.getMeta("default_channel_id");
        const preferred = defaultId ? store.getChannel(defaultId) : null;
        const general =
          preferred?.type === "public" && !preferred.archived
            ? preferred
            : store.listChannelsVisibleTo(user.id).find((c) => c.type === "public" && !c.archived);
        if (general && store.addMember(general.id, user.id)) {
          emit({ type: "member.joined", channelId: general.id, userId: user.id }, general.id);
        }
      }

      const { token, tokenHash } = newSessionToken();
      store.createSession(tokenHash, user.id, deviceName(req));
      return { token, user };
    });
    return reply.status(201).send({ token, user });
  });

  app.post("/api/auth/login", async (req) => {
    const body = loginBody.parse(req.body);
    const auth = store.getUserAuthByHandle(body.handle);
    beginAuth();
    let valid = false;
    try {
      valid =
        !!auth &&
        !auth.deactivated &&
        (await verifyPassword(body.password, auth.salt, auth.passwordHash));
    } finally {
      authJobs--;
    }
    const latest = auth ? store.getUserAuthByHandle(auth.handle) : null;
    if (
      !auth ||
      !valid ||
      !latest ||
      latest.deactivated ||
      latest.passwordHash !== auth.passwordHash ||
      latest.salt !== auth.salt
    ) {
      throw new HttpError(401, "invalid_credentials");
    }
    const { token, tokenHash } = newSessionToken();
    store.createSession(tokenHash, auth.id, deviceName(req));
    const { passwordHash: _p, salt: _s, ...user } = latest;
    return { token, user, mustChangePassword: store.mustChangePassword(auth.id) };
  });

  app.post("/api/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) {
      const tokenHash = hashToken(token);
      store.deleteSession(tokenHash);
      gateway.disconnectSession(tokenHash);
    }
    return { ok: true };
  });

  /**
   * Changing a password proves you know the current one, then signs out
   * everywhere else. A password is usually changed because someone else might
   * know it; leaving their sessions running would defeat the whole exercise.
   */
  app.post("/api/auth/password", async (req) => {
    const me = requireUser(req);
    const body = changePasswordBody.parse(req.body);
    const auth = store.getUserAuthByHandle(me.handle);
    if (!auth) throw new HttpError(404, "user_not_found");
    beginAuth();
    let valid = false;
    try {
      valid = await verifyPassword(body.currentPassword, auth.salt, auth.passwordHash);
    } finally {
      authJobs--;
    }
    if (!valid)
      throw new HttpError(403, "invalid_credentials", "that is not your current password");
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(body.newPassword);
    } finally {
      authJobs--;
    }
    // Hashing yields: sign-out, deactivation, or another reset may have happened meanwhile.
    requireUser(req);
    const latest = store.getUserAuthByHandle(me.handle);
    if (!latest || latest.passwordHash !== auth.passwordHash || latest.salt !== auth.salt) {
      throw new HttpError(
        409,
        "credentials_changed",
        "Your password changed while this request was running. Sign in again.",
      );
    }
    const keep = hashToken(bearerToken(req)!);
    const revokedSessions = store.transaction(() => {
      store.setPassword(me.id, credentials.hash, credentials.salt);
      return store.revokeSessions(me.id, { exceptTokenHash: keep });
    });
    for (const revoked of revokedSessions) {
      gateway.disconnectSession(revoked);
    }
    return { ok: true };
  });

  /** Everywhere this account is signed in, so its owner can see and end them. */
  app.get("/api/auth/sessions", async (req) => {
    const me = requireUser(req);
    const current = hashToken(bearerToken(req)!);
    const currentId = store.sessionIdFor(current);
    return {
      sessions: store
        .listSessions(me.id)
        .map((session) => ({ ...session, current: session.id === currentId })),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", async (req) => {
    const me = requireUser(req);
    const revoked = store.revokeSessions(me.id, { id: req.params.id });
    if (revoked.length === 0) throw new HttpError(404, "session_not_found");
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    return { ok: true };
  });

  /** "Sign out my other devices" — the one asking stays signed in. */
  app.delete("/api/auth/sessions", async (req) => {
    const me = requireUser(req);
    const keep = hashToken(bearerToken(req)!);
    const revoked = store.revokeSessions(me.id, { exceptTokenHash: keep });
    for (const tokenHash of revoked) gateway.disconnectSession(tokenHash);
    return { revoked: revoked.length };
  });

  // ---------- me / users ----------

  app.get("/api/me", async (req) => ({ user: requireUser(req) }));

  app.patch("/api/me", async (req) => {
    const me = requireUser(req);
    const body = updateMeBody.parse(req.body);
    return mutate((emit) => {
      const user = store.updateUser(me.id, body);
      emit({ type: "user.updated", user }, null);
      return { user };
    });
  });

  app.get("/api/users", async (req) => {
    requireUser(req);
    return { users: store.listUsers() };
  });

  // ---------- channels ----------

  const publishFriends = (a: ID, b: ID) => {
    for (const id of [a, b])
      gateway.sendToUser(id, { type: "friends", friends: store.listFriends(id) });
  };
  app.get("/api/friends", async (req) => ({ friends: store.listFriends(requireUser(req).id) }));
  app.post<{ Params: { id: string } }>("/api/friends/:id", async (req) => {
    const me = requireUser(req);
    const other = store.getUser(req.params.id);
    if (!other || other.deactivated || other.isBot || other.id === me.id)
      throw new HttpError(400, "invalid_friend");
    store.requestFriend(me.id, other.id);
    publishFriends(me.id, other.id);
    return { friends: store.listFriends(me.id) };
  });
  app.put<{ Params: { id: string } }>("/api/friends/:id", async (req) => {
    const me = requireUser(req);
    if (!store.acceptFriend(me.id, req.params.id)) throw new HttpError(404, "request_not_found");
    publishFriends(me.id, req.params.id);
    return { friends: store.listFriends(me.id) };
  });
  app.delete<{ Params: { id: string } }>("/api/friends/:id", async (req) => {
    const me = requireUser(req);
    store.removeFriend(me.id, req.params.id);
    publishFriends(me.id, req.params.id);
    return { friends: store.listFriends(me.id) };
  });

  app.get("/api/channels", async (req) => {
    const me = requireUser(req);
    return { channels: store.listChannelsVisibleTo(me.id) };
  });

  app.post("/api/channels", async (req, reply) => {
    const me = requireUser(req);
    const body = createChannelBody.parse(req.body);
    return mutate((emit) => {
      if (body.type === "public" || body.type === "private") {
        if (store.getChannelByName(body.name)) throw new HttpError(409, "name_taken");
        const memberIds =
          body.type === "private" ? [...new Set([me.id, ...(body.memberIds ?? [])])] : [me.id];
        for (const id of memberIds) {
          if (!store.getUser(id)) throw new HttpError(400, "unknown_user", id);
        }
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
        reply.status(201);
        return { channel };
      }

      // dm / group_dm — idempotent on the member set.
      const memberIds = [...new Set([me.id, ...body.memberIds])].sort();
      for (const id of memberIds) {
        if (!store.getUser(id)) throw new HttpError(400, "unknown_user", id);
      }
      const dmKey = memberIds.join(":");
      const existing = store.findDmByKey(dmKey);
      if (existing) {
        if ([...(existing.memberIds ?? [])].sort().join(":") === dmKey)
          return { channel: existing };
        // Legacy groups may still have the original key after someone left.
        // Never restore that person's access to the group's intervening history.
        store.retireDmKey(existing.id);
      }

      const channel = store.createChannel({
        type: memberIds.length === 2 ? "dm" : "group_dm",
        creatorId: me.id,
        memberIds,
        dmKey,
      });
      emit({ type: "channel.created", channel }, channel.id);
      reply.status(201);
      return { channel };
    });
  });

  app.patch<{ Params: { id: string } }>("/api/channels/:id", async (req) => {
    const me = requireUser(req);
    const existing = requireChannelAccess(req.params.id, me);
    if (existing.type === "dm" || existing.type === "group_dm") {
      throw new HttpError(400, "cannot_edit_dm");
    }
    const body = updateChannelBody.parse(req.body);
    if (!channelPermissions(me, existing, store.isMember(existing.id, me.id)).manage) {
      throw new HttpError(403, "channel_management_required");
    }
    if (body.name && body.name !== existing.name && store.getChannelByName(body.name)) {
      throw new HttpError(409, "name_taken");
    }
    return mutate((emit) => {
      const channel = store.updateChannel(existing.id, body);
      emit({ type: "channel.updated", channel }, channel.id);
      return { channel };
    });
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/join", async (req) => {
    const me = requireUser(req);
    const channel = store.getChannel(req.params.id);
    if (!channel || channel.type !== "public") throw new HttpError(404, "channel_not_found");
    if (channel.archived) throw new HttpError(400, "channel_archived");
    mutate((emit) => {
      if (store.addMember(channel.id, me.id)) {
        emit({ type: "member.joined", channelId: channel.id, userId: me.id }, channel.id);
      }
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/leave", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.type === "dm") throw new HttpError(400, "cannot_leave_dm");
    mutate((emit, afterCommit) => {
      if (store.removeMember(channel.id, me.id)) {
        afterCommit(() => gateway.updateChannelAccess(channel.id, me.id));
        emit({ type: "member.left", channelId: channel.id, userId: me.id }, channel.id);
        if (channel.type === "group_dm")
          emit({ type: "channel.updated", channel: store.getChannel(channel.id)! }, channel.id);
        if (channel.managerIds?.includes(me.id))
          emit({ type: "channel.updated", channel: store.getChannel(channel.id)! }, channel.id);
      }
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/invite-member", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    const { userId } = (req.body ?? {}) as { userId?: string };
    if (typeof userId !== "string" || !store.getUser(userId))
      throw new HttpError(400, "unknown_user");
    if (channel.type === "dm" || channel.type === "group_dm") {
      throw new HttpError(400, "cannot_invite_to_dm");
    }
    if (!channelPermissions(me, channel, store.isMember(channel.id, me.id)).invite) {
      throw new HttpError(403, "channel_invite_forbidden");
    }
    mutate((emit, afterCommit) => {
      if (store.addMember(channel.id, userId)) {
        afterCommit(() => gateway.updateChannelAccess(channel.id, userId));
        emit({ type: "member.joined", channelId: channel.id, userId }, channel.id);
      }
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/channels/:id/members/:userId",
    async (req) => {
      const me = requireUser(req);
      const channel = requireChannelAccess(req.params.id, me);
      const target = store.getUser(req.params.userId);
      if (
        !canRemoveChannelMember(me, target ?? undefined, channel, store.isMember(channel.id, me.id))
      ) {
        throw new HttpError(403, "channel_removal_forbidden");
      }
      mutate((emit, afterCommit) => {
        if (store.removeMember(channel.id, req.params.userId)) {
          afterCommit(() => gateway.updateChannelAccess(channel.id, req.params.userId));
          if (channel.managerIds?.includes(req.params.userId))
            emit({ type: "channel.updated", channel: store.getChannel(channel.id)! }, channel.id);
          emit(
            { type: "member.left", channelId: channel.id, userId: req.params.userId },
            channel.id,
          );
        }
      });
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string; userId: string } }>(
    "/api/channels/:id/managers/:userId",
    async (req) => {
      const me = requireUser(req);
      const channel = requireChannelAccess(req.params.id, me);
      const target = store.getUser(req.params.userId);
      const { manager } = channelManagerBody.parse(req.body);
      if (
        !canSetChannelManager(
          me,
          target ?? undefined,
          channel,
          store.isMember(channel.id, me.id),
          manager,
        )
      ) {
        throw new HttpError(403, "channel_manager_assignment_forbidden");
      }
      if (!store.isMember(channel.id, req.params.userId))
        throw new HttpError(409, "channel_membership_required");
      return mutate((emit) => {
        const changed = store.setChannelManager(channel.id, req.params.userId, manager);
        const updated = store.getChannel(channel.id)!;
        if (changed) emit({ type: "channel.updated", channel: updated }, channel.id);
        return { channel: updated };
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/channels/:id/members", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    return { memberIds: store.memberIds(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/read", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const { seq } = markReadBody.parse(req.body);
    if (!store.isMember(req.params.id, me.id)) throw new HttpError(404, "channel_not_found");
    const acknowledged = store.markRead(req.params.id, me.id, seq);
    gateway.sendToUser(me.id, {
      type: "channel.read",
      channelId: req.params.id,
      seq: acknowledged,
    });
    pushMentionCounts([me.id]);
    return { ok: true, seq: acknowledged };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/unread", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const { seq } = markUnreadBody.parse(req.body);
    if (!store.isMember(req.params.id, me.id)) throw new HttpError(404, "channel_not_found");
    const seqNow = store.markUnread(req.params.id, me.id, seq);
    gateway.sendToUser(me.id, { type: "channel.unread", channelId: req.params.id, seq: seqNow });
    pushMentionCounts([me.id]);
    return { ok: true, seq: seqNow };
  });

  // ---------- messages ----------

  app.get<{ Params: { id: string; rootId: string } }>(
    "/api/channels/:id/threads/:rootId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const query = threadHistoryQuery.parse(req.query);
      const root = store.getMessage(req.params.rootId);
      if (!root || root.channelId !== req.params.id || root.threadRootId)
        throw new HttpError(404, "thread_not_found");
      if (query.around) {
        const target = store.getMessage(query.around);
        if (!target || target.channelId !== root.channelId || target.threadRootId !== root.id)
          throw new HttpError(404, "message_not_found");
      }
      return {
        root,
        ...store.threadHistory(root.channelId, root.id, query),
        seq: store.currentSeq(),
      };
    },
  );

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
    return { messages, readThroughSeq: store.lastMessageSeq(req.params.id) };
  });

  app.get<{ Params: { id: string; messageId: string } }>(
    "/api/channels/:id/messages/around/:messageId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const { limit } = messageHistoryQuery.parse(req.query);
      const target = store.getMessage(req.params.messageId);
      if (!target || target.channelId !== req.params.id)
        throw new HttpError(404, "message_not_found");
      const rootId = target.threadRootId ?? target.id;
      if (target.threadRootId && !store.getMessage(rootId))
        throw new HttpError(404, "thread_not_found");
      return {
        ...store.listMessagesAround(req.params.id, rootId, limit),
        threadRootId: target.threadRootId,
      };
    },
  );

  app.get<{ Params: { id: string; messageId: string } }>(
    "/api/channels/:id/messages/after/:messageId",
    async (req) => {
      const me = requireUser(req);
      requireChannelAccess(req.params.id, me);
      const { limit } = messageHistoryQuery.parse(req.query);
      return { messages: store.listMessagesAfter(req.params.id, req.params.messageId, limit) };
    },
  );

  app.post<{ Params: { id: string } }>("/api/channels/:id/messages", async (req, reply) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const body = sendMessageBody.parse(req.body);

    const message = postMessage({
      channelId: channel.id,
      userId: me.id,
      text: body.text,
      threadRootId: body.threadRootId ?? null,
      nonce: body.nonce ?? null,
      fileIds: body.fileIds ?? [],
      broadcast: body.alsoSendToChannel ?? false,
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
    return mutate((emit) => {
      const message = store.editMessage(existing.id, body.text);
      emit({ type: "message.updated", message }, message.channelId);
      return { message };
    });
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const me = requireUser(req);
    const existing = store.getMessage(req.params.id);
    if (!existing || !store.canAccess(existing.channelId, me.id)) {
      throw new HttpError(404, "message_not_found");
    }
    const isPrivileged = me.role === "owner" || me.role === "admin";
    if (existing.userId !== me.id && !isPrivileged) throw new HttpError(403, "not_your_message");

    removeMessage(existing);
    await flushFileDeletions();
    return { ok: true };
  });

  // ---------- files ----------

  app.get("/api/storage", async (req) => {
    requireUser(req);
    return {
      usedBytes: storage.usedBytes,
      limitBytes: storage.limitBytes,
      maxFileBytes: maxFileSize,
      availableBytes:
        storage.limitBytes === null ? null : Math.max(0, storage.limitBytes - storage.usedBytes),
    };
  });

  app.post<{ Params: { id: string } }>("/api/channels/:id/files", async (req, reply) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (!filesDir) throw new HttpError(501, "uploads_disabled");

    const part = await req.file();
    if (!part) throw new HttpError(400, "no_file");

    const id = ulid();
    let size = 0;
    let headerSize = 0;
    const header: Buffer[] = [];
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        if (!storage.reserve(id, chunk.length)) {
          done(
            new HttpError(
              507,
              "storage_quota_exceeded",
              "Workspace attachment storage is full. Ask the host to free space or raise the limit.",
            ),
          );
          return;
        }
        size += chunk.length;
        if (headerSize < 64 * 1024) {
          const part = Buffer.from(chunk.subarray(0, 64 * 1024 - headerSize));
          header.push(part);
          headerSize += part.length;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(part.file, meter, createWriteStream(blobPath(id), { flags: "wx" }));
      if (part.file.truncated)
        throw new HttpError(413, "file_too_large", `files must be under ${maxFileSize} bytes`);
      // Upload streaming yields; access may have been revoked while bytes arrived.
      requireUser(req);
      requireChannelAccess(channel.id, me);
      const dims = part.mimetype.startsWith("image/") ? imageSize(Buffer.concat(header)) : null;
      const file = store.createFile({
        id,
        channelId: channel.id,
        userId: me.id,
        name: part.filename.slice(0, 255),
        mime: part.mimetype,
        size,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      });
      return reply.status(201).send({ file });
    } catch (err) {
      try {
        await unlink(blobPath(id));
        storage.release(id);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") storage.release(id);
        else store.queueFileDeletions([id]);
      }
      throw err;
    }
  });

  /**
   * A one-shot ticket for downloading one file.
   *
   * A browser saving a file to disk cannot send an Authorization header on the
   * navigation that does it, so without this the only way to reach an
   * auth-gated file is to fetch the whole thing into memory first. That turns
   * every large download into a browser-sized blob. The ticket lets the
   * download be an ordinary navigation the browser streams straight to disk.
   *
   * It is short-lived and spent on first use, so the copy that appears in a URL
   * is worth little for long. Access is checked again when it is redeemed
   * rather than trusted from when it was issued.
   */
  const DOWNLOAD_TOKEN_TTL_MS = 60_000;

  app.post<{ Params: { id: string } }>("/api/files/:id/download-token", async (req, reply) => {
    const me = requireUser(req);
    const file = store.getFile(req.params.id);
    if (!file || !filesDir || !store.canAccess(file.channelId, me.id)) {
      throw new HttpError(404, "file_not_found");
    }
    try {
      const stored = await stat(blobPath(file.id));
      if (!stored.isFile() || stored.size !== file.size) throw new Error("file unavailable");
    } catch {
      throw new HttpError(404, "file_not_found");
    }
    // Disk access yields; issue nothing if the session or file disappeared.
    requireUser(req);
    if (!store.getFile(file.id) || !store.canAccess(file.channelId, me.id)) {
      throw new HttpError(404, "file_not_found");
    }
    const { token, tokenHash } = newSessionToken();
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    store.createDownloadToken(tokenHash, file.id, me.id, hashToken(bearerToken(req)!), expiresAt);
    reply.header("cache-control", "no-store");
    return { token, expiresAt };
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/api/files/:id",
    { logLevel: "silent" }, // Never put a redeemable ticket in request logs.
    async (req, reply) => {
      // A ticket stands in for the header a navigation cannot carry. Whoever
      // spends it still has to pass the checks its issuer passed.
      const ticket = req.query.download;
      let viewerId: ID;
      let sessionHash: string;
      if (ticket !== undefined) {
        if (req.method !== "GET" || typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket))
          throw new HttpError(404, "file_not_found");
        reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
        const spent = store.consumeDownloadToken(hashToken(ticket));
        if (!spent || spent.fileId !== req.params.id) throw new HttpError(404, "file_not_found");
        const viewer = store.getSessionUser(spent.sessionHash);
        if (!viewer || viewer.id !== spent.userId || store.mustChangePassword(viewer.id)) {
          throw new HttpError(404, "file_not_found");
        }
        viewerId = viewer.id;
        sessionHash = spent.sessionHash;
      } else {
        viewerId = requireUser(req).id;
        sessionHash = hashToken(bearerToken(req)!);
      }

      const file = store.getFile(req.params.id);
      if (!file || !filesDir || !store.canAccess(file.channelId, viewerId)) {
        throw new HttpError(404, "file_not_found");
      }
      let body;
      let handle;
      try {
        handle = await open(blobPath(file.id), "r");
        const stored = await handle.stat();
        if (!stored.isFile() || stored.size !== file.size) throw new Error("file unavailable");
        // Disk access yields; sign-out, deletion or private-room departure may have happened.
        const current = store.getSessionUser(sessionHash);
        if (
          !current ||
          !store.getFile(file.id) ||
          store.mustChangePassword(current.id) ||
          !store.canAccess(file.channelId, current.id)
        )
          throw new Error("file access changed");
        body = handle.createReadStream();
      } catch {
        await handle?.close();
        throw new HttpError(404, "file_not_found");
      }
      const encodedName = encodeURIComponent(file.name);
      // Content is immutable once uploaded, so let clients cache it hard.
      return reply
        .header("content-type", file.mime)
        .header("x-content-type-options", "nosniff")
        .header("content-length", String(file.size))
        .header("cache-control", ticket ? "no-store" : "private, max-age=31536000, immutable")
        .header("referrer-policy", "no-referrer")
        .header("accept-ranges", "none")
        .header(
          "content-disposition",
          `${ticket ? "attachment" : "inline"}; filename*=UTF-8''${encodedName}`,
        )
        .send(body);
    },
  );

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
      mutate((emit) => {
        if (store.addReaction(msg.id, me.id, emoji)) {
          emit(
            {
              type: "reaction.added",
              channelId: msg.channelId,
              messageId: msg.id,
              emoji,
              userId: me.id,
            },
            msg.channelId,
          );
        }
      });
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
      mutate((emit) => {
        if (store.removeReaction(msg.id, me.id, emoji)) {
          emit(
            {
              type: "reaction.removed",
              channelId: msg.channelId,
              messageId: msg.id,
              emoji,
              userId: me.id,
            },
            msg.channelId,
          );
        }
      });
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
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(secretToken());
    } finally {
      authJobs--;
    }
    requireAdmin(req);
    const result = mutate((emit) => {
      const { hash, salt } = credentials;
      const bot = store.createBotUser(botHandle(body.name), body.name, hash, salt);
      const signingSecret = secretToken();
      const created = store.createApp({
        name: body.name,
        botUserId: bot.id,
        createdBy: me.id,
        signingSecret,
      });

      const token = secretToken("xoxb-");
      store.addAppToken(created.id, hashToken(token));
      emit({ type: "user.joined", user: bot }, null);

      // The bot token is shown once and only stored hashed; the signing secret
      // stays readable to admins because verification needs the key itself.
      return { app: created, botUser: bot, token, signingSecret };
    });
    return reply.status(201).send(result);
  });

  app.get("/api/apps", async (req) => {
    requireAdmin(req);
    const apps = store.listApps();
    return {
      apps: apps.map((a) => ({
        ...a,
        webhooks: store.listWebhooks(a.id),
        commands: store.listSlashCommands(a.id),
        subscriptions: store.listSubscriptions(a.id),
        signingSecret: store.appSigningSecret(a.id) ?? "",
      })),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/apps/:id", async (req) => {
    requireAdmin(req);
    if (!store.getApp(req.params.id)) throw new HttpError(404, "not_found");
    store.transaction(() => store.deleteApp(req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/apps/:id/webhooks", async (req, reply) => {
    const me = requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = createWebhookBody.parse(req.body);
    const channel = requireChannelAccess(body.channelId, me);

    const token = secretToken();
    const webhook = mutate((emit) => {
      const created = store.createWebhook({
        appId: owner.id,
        channelId: channel.id,
        tokenHash: hashToken(token),
      });
      // The bot must be in the channel to post to it.
      if (store.addMember(channel.id, owner.botUserId)) {
        emit({ type: "member.joined", channelId: channel.id, userId: owner.botUserId }, channel.id);
      }
      return created;
    });
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

    if (channel.type !== "public" && !store.isMember(channel.id, found.app.botUserId)) {
      return reply.status(403).send({ ok: false, error: "not_in_channel" });
    }
    postMessage({
      channelId: channel.id,
      userId: found.app.botUserId,
      text,
      threadRootId: null,
      nonce: null,
      fileIds: [],
      actions: blocksToActions(payload.blocks),
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

    if (channel.type !== "public" && !store.isMember(channel.id, owner.botUserId)) {
      return reply.status(403).send({ ok: false, error: "not_in_channel" });
    }

    const text = payloadToText(body);
    if (!text) return reply.status(400).send({ ok: false, error: "no_text" });

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
      actions: blocksToActions(body.blocks),
    });
    // `ts` is Slack's message identifier; ours is the message id.
    return { ok: true, channel: channel.id, ts: message.id, message };
  });

  // ---------- slash commands ----------

  /**
   * Where a command's delayed replies go. Slack gives an app 30 minutes and
   * five uses of a `response_url`; so do we. Purely in memory — a reply that
   * outlives a restart is not worth a table.
   */
  interface ResponseTarget {
    channelId: ID;
    invokerId: ID;
    botUserId: ID;
    threadRootId: ID | null;
    expiresAt: number;
    usesLeft: number;
  }
  const responseTargets = new Map<string, ResponseTarget>();

  const newResponseUrl = (
    target: Omit<ResponseTarget, "expiresAt" | "usesLeft">,
    origin: string,
  ): string => {
    const now = Date.now();
    for (const [k, v] of responseTargets) if (v.expiresAt < now) responseTargets.delete(k);
    const token = secretToken();
    responseTargets.set(token, { ...target, expiresAt: now + 30 * 60_000, usesLeft: 5 });
    return `${origin}/api/commands/response/${token}`;
  };

  /** A private note back to the person who ran the command. */
  const sayEphemeral = (channelId: ID, toUserId: ID, fromUserId: ID, text: string): void => {
    gateway.sendToUser(toUserId, {
      type: "ephemeral.message",
      channelId,
      id: ulid(),
      userId: fromUserId,
      text,
      createdAt: Date.now(),
    });
  };

  /**
   * Turns whatever an app answered with into a message. `in_channel` posts for
   * everyone as the bot; anything else stays private to the person who typed
   * the command, which is Slack's default and the safer one.
   */
  const deliverCommandReply = (
    target: Omit<ResponseTarget, "expiresAt" | "usesLeft">,
    raw: string,
    contentType: string,
    /** The message a button lives on, which the app may ask to replace. */
    originMessageId?: ID,
  ): void => {
    const trimmed = raw.trim();
    if (!trimmed) return; // an empty 200 is a silent acknowledgement

    let payload: {
      text?: unknown;
      blocks?: unknown;
      response_type?: unknown;
      replace_original?: unknown;
      delete_original?: unknown;
    } = {};
    if (contentType.includes("json") || trimmed.startsWith("{")) {
      try {
        payload = JSON.parse(trimmed) as typeof payload;
      } catch {
        payload = { text: trimmed };
      }
    } else {
      payload = { text: trimmed };
    }

    // Slack lets a button's handler rewrite the message it sits on, which is
    // how "Approve" becomes "Approved by @alice" with the buttons gone.
    if (
      originMessageId &&
      (payload.replace_original === true || payload.delete_original === true)
    ) {
      const existing = store.getMessage(originMessageId);
      if (existing) {
        if (payload.delete_original === true) {
          removeMessage(existing);
          void flushFileDeletions();
          return;
        }
        const replacement = payloadToText(payload);
        if (replacement) {
          mutate((emit) => {
            store.clearMessageActions(existing.id);
            const updated = store.editMessage(existing.id, replacement);
            emit({ type: "message.updated", message: updated }, updated.channelId);
          });
        }
        return;
      }
    }

    const text = payloadToText(payload);
    if (!text) return;

    if (payload.response_type === "in_channel") {
      postMessage({
        channelId: target.channelId,
        userId: target.botUserId,
        text,
        threadRootId: target.threadRootId,
        nonce: null,
        fileIds: [],
        actions: blocksToActions(payload.blocks),
      });
    } else {
      sayEphemeral(target.channelId, target.invokerId, target.botUserId, text);
    }
  };

  app.post<{ Params: { id: string } }>("/api/apps/:id/commands", async (req, reply) => {
    requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = createCommandBody.parse(req.body);
    if (BUILTIN_COMMANDS.has(body.command) || store.slashCommandByName(body.command)) {
      throw new HttpError(409, "command_taken", `/${body.command} is already in use`);
    }
    const command = store.createSlashCommand({
      appId: owner.id,
      command: body.command,
      url: body.url,
      description: body.description ?? "",
      usageHint: body.usageHint ?? "",
    });
    return reply.status(201).send({ command });
  });

  app.delete<{ Params: { id: string } }>("/api/commands/:id", async (req) => {
    requireAdmin(req);
    if (!store.deleteSlashCommand(req.params.id)) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  /** Every command anyone can run, for the composer's hint list. */
  app.get("/api/commands", async (req) => {
    requireUser(req);
    const builtins = [...BUILTIN_COMMANDS.entries()].map(([command, b]) => ({
      command,
      description: b.description,
      usageHint: b.usageHint,
      builtin: true,
    }));
    const fromApps = store.listAllSlashCommands().map((c) => ({
      command: c.command,
      description: c.description,
      usageHint: c.usageHint,
      builtin: false,
    }));
    return { commands: [...builtins, ...fromApps] };
  });

  /** Runs `/whatever …` typed in a channel. */
  app.post<{ Params: { id: string } }>("/api/channels/:id/commands", async (req) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const body = runCommandBody.parse(req.body);
    const threadRootId = body.threadRootId ?? null;

    const parsed = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(body.text.trim());
    if (!parsed) throw new HttpError(400, "not_a_command");
    const name = parsed[1]!.toLowerCase();
    const argText = parsed[2]!.trim();

    const builtin = BUILTIN_COMMANDS.get(name);
    if (builtin) {
      const text = builtin.run(argText, me);
      if (text === null) throw new HttpError(400, "usage", `usage: /${name} ${builtin.usageHint}`);
      postMessage({
        channelId: channel.id,
        userId: me.id,
        text,
        threadRootId,
        nonce: null,
        fileIds: [],
      });
      return { ok: true };
    }

    const found = store.slashCommandByName(name);
    if (!found) throw new HttpError(404, "unknown_command", `/${name} is not a command here`);

    // The bot has to be in the channel to answer in it.
    mutate((emit) => {
      if (store.addMember(channel.id, found.app.botUserId)) {
        emit(
          { type: "member.joined", channelId: channel.id, userId: found.app.botUserId },
          channel.id,
        );
      }
    });

    const target = {
      channelId: channel.id,
      invokerId: me.id,
      botUserId: found.app.botUserId,
      threadRootId,
    };
    const form = new URLSearchParams({
      command: `/${name}`,
      text: argText,
      team_id: store.getMeta("workspace_id") ?? "",
      team_domain: workspaceName(),
      channel_id: channel.id,
      channel_name: channel.name,
      user_id: me.id,
      user_name: me.handle,
      api_app_id: found.app.id,
      response_url: newResponseUrl(target, requestOrigin(req)),
      trigger_id: newTrigger({
        userId: me.id,
        channelId: channel.id,
        appId: found.app.id,
        botUserId: found.app.botUserId,
      }),
    }).toString();

    try {
      const res = await postToUrl(found.command.url, form, "application/x-www-form-urlencoded", {
        allowPrivate: opts.allowPrivateHooks,
        headers: signatureHeaders(store.appSigningSecret(found.app.id) ?? "", form),
      });
      if (res.status < 200 || res.status >= 300) {
        sayEphemeral(
          channel.id,
          me.id,
          found.app.botUserId,
          `\`/${name}\` failed: the app answered ${res.status}.`,
        );
        return { ok: false, error: "command_failed" };
      }
      deliverCommandReply(target, res.body, res.contentType);
      return { ok: true };
    } catch (err) {
      const why =
        err instanceof OutboundError && err.code === "blocked_host"
          ? err.message
          : "the app did not answer";
      sayEphemeral(channel.id, me.id, found.app.botUserId, `\`/${name}\` failed: ${why}.`);
      return { ok: false, error: "command_failed" };
    }
  });

  /** Slack's `response_url`: how an app replies after its first few seconds. */
  app.post<{ Params: { token: string } }>("/api/commands/response/:token", async (req, reply) => {
    const target = responseTargets.get(req.params.token);
    if (!target || target.expiresAt < Date.now()) {
      responseTargets.delete(req.params.token);
      return reply.status(404).send({ ok: false, error: "expired_url" });
    }
    if (--target.usesLeft <= 0) responseTargets.delete(req.params.token);

    const raw = req.body;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    deliverCommandReply(target, text, "application/json");
    return { ok: true };
  });

  // ---------- people ----------

  /**
   * Everyone with an account, for an admin who has to run this workspace: who
   * they are, what they can do, and when they were last seen. Bots are in the
   * list because a forgotten bot is exactly the account worth noticing.
   */
  app.get("/api/admin/users", async (req) => {
    requireAdmin(req);
    const lastSeen = store.lastSeenByUser();
    return {
      users: store.listUsers().map((u) => ({ ...u, lastSeenAt: lastSeen[u.id] ?? null })),
    };
  });

  /**
   * Change what someone can do, or take their access away.
   *
   * The rules are about who may act on whom, and they are deliberately narrow:
   * the owner is untouchable and cannot be locked out of their own server, an
   * admin cannot demote or deactivate another admin (a workspace should not be
   * losable to an argument between two of them), and nobody can act on
   * themselves — an admin cannot quietly promote themselves to owner or lock
   * themselves out by accident.
   */
  app.patch<{ Params: { id: string } }>("/api/admin/users/:id", async (req) => {
    const me = requireAdmin(req);
    const body = adminUserBody.parse(req.body);
    const target = store.getUser(req.params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "cannot_change_self");
    if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
    if (target.role === "admin" && me.role !== "owner") {
      throw new HttpError(403, "admins_are_equals", "only the owner can change another admin");
    }
    if (body.role !== undefined && target.isBot) {
      throw new HttpError(400, "bots_have_no_role");
    }

    return mutate((emit, afterCommit) => {
      const updated = store.updateUser(target.id, {
        role: body.role,
        deactivated: body.deactivated,
      });

      if (body.deactivated === true) {
        // Revoking access has to reach what is already in their hands: every
        // session token, and every socket that authenticated with one.
        store.deleteSessionsFor(target.id);
        afterCommit(() => gateway.disconnectUser(target.id));
      }
      // Everyone sees the change, so a deactivated person drops out of the member
      // lists and the composer's autocomplete without a reload.
      emit({ type: "user.updated", user: updated }, null);
      return { user: updated };
    });
  });

  /**
   * Password recovery for an installation with no email: an admin issues a
   * temporary password and reads it to the person over whatever channel they
   * trust. It is shown once, all their sessions end, and they are expected to
   * change it. The rules match those above — the owner cannot be reset by an
   * admin, and nobody resets themselves, since that is what the ordinary
   * password change is for.
   */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/password", async (req) => {
    const authorize = () => {
      const me = requireAdmin(req);
      const target = store.getUser(req.params.id);
      if (!target) throw new HttpError(404, "user_not_found");
      if (target.id === me.id) throw new HttpError(400, "cannot_reset_self");
      if (target.isBot) throw new HttpError(400, "bots_have_no_password");
      if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
      if (target.role === "admin" && me.role !== "owner") {
        throw new HttpError(403, "admins_are_equals", "only the owner can reset another admin");
      }
      return target;
    };
    authorize();
    const temporaryPassword = secretToken().slice(0, 16);
    beginAuth();
    let credentials: Awaited<ReturnType<typeof hashPassword>>;
    try {
      credentials = await hashPassword(temporaryPassword);
    } finally {
      authJobs--;
    }
    const target = authorize();
    const revokedSessions = store.transaction(() => {
      store.setPassword(target.id, credentials.hash, credentials.salt, true);
      return store.revokeSessions(target.id);
    });
    for (const tokenHash of revokedSessions) {
      gateway.disconnectSession(tokenHash);
    }
    return { temporaryPassword };
  });

  /**
   * Hands the workspace to someone else. Only the owner can do it, and they
   * become an admin rather than losing their access — a workspace with no owner
   * is the state this whole area exists to prevent.
   */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/owner", async (req) => {
    const me = requireUser(req);
    if (me.role !== "owner") throw new HttpError(403, "owner_only");
    const target = store.getUser(req.params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "already_owner");
    if (target.isBot || target.deactivated) throw new HttpError(400, "invalid_owner");
    return mutate((emit) => {
      const newOwner = store.updateUser(target.id, { role: "owner" });
      const formerOwner = store.updateUser(me.id, { role: "admin" });
      emit({ type: "user.updated", user: newOwner }, null);
      emit({ type: "user.updated", user: formerOwner }, null);
      return { owner: newOwner, previousOwner: formerOwner };
    });
  });

  // ---------- interactive buttons and modals ----------

  /**
   * A `trigger_id` is permission to open one modal, on behalf of one person,
   * for a short while. Slack gives an app three seconds to use it; three
   * minutes is friendlier to a self-hosted app on a cold start and still short
   * enough that a leaked id is worthless. In memory, like a response_url.
   */
  interface Trigger {
    userId: ID;
    channelId: ID;
    appId: ID;
    botUserId: ID;
    expiresAt: number;
  }
  const triggers = new Map<string, Trigger>();

  const newTrigger = (trigger: Omit<Trigger, "expiresAt">): string => {
    const now = Date.now();
    for (const [k, v] of triggers) if (v.expiresAt < now) triggers.delete(k);
    const id = ulid();
    triggers.set(id, { ...trigger, expiresAt: now + 3 * 60_000 });
    return id;
  };

  /** An open modal, waiting for the person it was shown to. */
  interface OpenView {
    view: ModalView;
    userId: ID;
    channelId: ID;
    appId: ID;
    botUserId: ID;
    expiresAt: number;
  }
  const openViews = new Map<ID, OpenView>();

  /**
   * Slack's views.open. The trigger_id decides who sees it, so an app cannot
   * open a modal in front of someone who did not just ask for one.
   */
  app.post("/api/views.open", async (req, reply) => {
    const token = bearerToken(req);
    const owner = token ? store.appForToken(hashToken(token)) : null;
    if (!owner) return reply.status(401).send({ ok: false, error: "invalid_auth" });

    const body = (req.body ?? {}) as { trigger_id?: unknown; view?: unknown };
    const trigger = typeof body.trigger_id === "string" ? triggers.get(body.trigger_id) : undefined;
    if (!trigger || trigger.expiresAt < Date.now()) {
      if (typeof body.trigger_id === "string") triggers.delete(body.trigger_id);
      return reply.status(400).send({ ok: false, error: "expired_trigger_id" });
    }
    // The trigger belongs to whoever it was issued for, and to that app alone.
    if (trigger.appId !== owner.id) {
      return reply.status(403).send({ ok: false, error: "trigger_not_yours" });
    }
    triggers.delete(body.trigger_id as string);

    const id = ulid();
    const { droppedFields, ...view } = parseView(body.view, id);
    if (view.fields.length === 0) {
      // Either there was nothing to fill in, or everything in it was a control
      // we cannot draw. Saying so beats showing an empty box.
      return reply
        .status(400)
        .send({ ok: false, error: droppedFields > 0 ? "unsupported_elements" : "no_inputs" });
    }

    const now = Date.now();
    for (const [k, v] of openViews) if (v.expiresAt < now) openViews.delete(k);
    openViews.set(id, {
      view,
      userId: trigger.userId,
      channelId: trigger.channelId,
      appId: owner.id,
      botUserId: owner.botUserId,
      expiresAt: now + 30 * 60_000,
    });
    gateway.sendToUser(trigger.userId, { type: "view.open", view });
    return { ok: true, view: { id, callback_id: view.callbackId } };
  });

  /**
   * Someone filled the form in and pressed submit. The values go to the app as
   * Slack's `view_submission`; field errors it answers with come back to the
   * client so they can be shown against the fields they belong to.
   */
  app.post<{ Params: { id: string } }>("/api/views/:id/submit", async (req) => {
    const me = requireUser(req);
    const body = viewSubmitBody.parse(req.body);
    const open = openViews.get(req.params.id);
    // A view belongs to the one person it was opened for.
    if (!open || open.userId !== me.id || open.expiresAt < Date.now()) {
      openViews.delete(req.params.id);
      throw new HttpError(404, "view_not_found");
    }
    const owner = store.getApp(open.appId);
    if (!owner?.interactivityUrl) {
      openViews.delete(open.view.id);
      throw new HttpError(400, "no_interactivity_url");
    }

    // Only the fields the app actually asked for, in Slack's nested shape.
    const values: Record<string, Record<string, unknown>> = {};
    const missing: Record<string, string> = {};
    for (const field of open.view.fields) {
      const raw = body.values[field.blockId]?.[field.actionId] ?? "";
      const value = raw.trim();
      if (!value && !field.optional) {
        missing[field.blockId] = "This is required.";
        continue;
      }
      // A select can only answer with something it offered. Otherwise a
      // hand-written request could hand the app a value it never listed, and
      // an app is entitled to trust its own options.
      if (field.type === "select" && value && !field.options.some((o) => o.value === value)) {
        missing[field.blockId] = "Choose one of the options.";
        continue;
      }
      values[field.blockId] = {
        ...values[field.blockId],
        [field.actionId]:
          field.type === "select"
            ? { type: "static_select", selected_option: value ? { value } : null }
            : { type: "plain_text_input", value },
      };
    }
    // Required fields are checked here as well as in the browser: the app
    // should never have to defend against a submission the form itself forbids.
    if (Object.keys(missing).length > 0) return { ok: false, errors: missing };

    const payload = JSON.stringify({
      type: "view_submission",
      team: { id: store.getMeta("workspace_id") ?? "", domain: workspaceName() },
      user: { id: me.id, username: me.handle, name: me.displayName },
      api_app_id: owner.id,
      trigger_id: newTrigger({
        userId: me.id,
        channelId: open.channelId,
        appId: owner.id,
        botUserId: owner.botUserId,
      }),
      view: {
        id: open.view.id,
        type: "modal",
        callback_id: open.view.callbackId,
        private_metadata: open.view.privateMetadata,
        title: { type: "plain_text", text: open.view.title },
        state: { values },
      },
    });
    const form = new URLSearchParams({ payload }).toString();

    try {
      const res = await postToUrl(
        owner.interactivityUrl,
        form,
        "application/x-www-form-urlencoded",
        {
          allowPrivate: opts.allowPrivateHooks,
          headers: signatureHeaders(store.appSigningSecret(owner.id) ?? "", form),
        },
      );
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, errors: {}, message: `The app answered ${res.status}.` };
      }
      const answered = res.body.trim();
      if (answered.startsWith("{")) {
        const parsed = JSON.parse(answered) as {
          response_action?: unknown;
          errors?: Record<string, string>;
        };
        // Slack's shape for "your answers are not acceptable, here is why".
        if (parsed.response_action === "errors" && parsed.errors) {
          return { ok: false, errors: parsed.errors };
        }
      }
      openViews.delete(open.view.id);
      return { ok: true };
    } catch (err) {
      const why =
        err instanceof OutboundError && err.code === "blocked_host"
          ? err.message
          : "the app did not answer";
      return { ok: false, errors: {}, message: `That did not go through: ${why}.` };
    }
  });

  /**
   * Slack's url_verification handshake, worth keeping for more than
   * compatibility: an endpoint that cannot echo the challenge has not agreed to
   * receive anything, so this is also what stops the server being aimed at an
   * unrelated host as a way of flooding it.
   */
  const verifyCallbackUrl = async (url: string, appId: ID): Promise<void> => {
    const challenge = secretToken();
    const probe = JSON.stringify({ type: "url_verification", token: "", challenge });
    let answered: string;
    try {
      const res = await postToUrl(url, probe, "application/json", {
        allowPrivate: opts.allowPrivateHooks,
        headers: signatureHeaders(store.appSigningSecret(appId) ?? "", probe),
      });
      answered = res.body.trim();
      if (answered.startsWith("{")) {
        answered = String((JSON.parse(answered) as { challenge?: unknown }).challenge ?? "");
      }
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof OutboundError ? err.code : "unreachable",
        (err as Error).message,
      );
    }
    if (answered !== challenge) {
      throw new HttpError(
        400,
        "challenge_failed",
        "the endpoint did not echo the url_verification challenge",
      );
    }
  };

  /**
   * Where this app's button clicks are delivered. Verified the same way a
   * subscription URL is: an endpoint that cannot echo the challenge has not
   * agreed to receive anything, which is also what stops this server being
   * aimed at an unrelated host.
   */
  app.put<{ Params: { id: string } }>("/api/apps/:id/interactivity", async (req) => {
    requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = interactivityBody.parse(req.body);

    if (!body.url) {
      store.setInteractivityUrl(owner.id, "");
      return { app: store.getApp(owner.id) };
    }
    await verifyCallbackUrl(body.url, owner.id);
    store.setInteractivityUrl(owner.id, body.url);
    return { app: store.getApp(owner.id) };
  });

  /**
   * Someone pressed a button. This posts Slack's `block_actions` payload to
   * the owning app and renders whatever comes back, so an integration written
   * for Slack works unchanged.
   */
  app.post<{ Params: { id: string } }>("/api/messages/:id/actions", async (req) => {
    const me = requireUser(req);
    const body = messageActionBody.parse(req.body);
    const message = store.getMessage(req.params.id);
    if (!message) throw new HttpError(404, "message_not_found");
    const channel = requireChannelAccess(message.channelId, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");

    const action = message.actions.find((a) => a.actionId === body.actionId);
    // A stale button — the message was edited or its buttons cleared — is a
    // 404 rather than a silent success, so the UI can say so.
    if (!action) throw new HttpError(404, "action_not_found");
    // A link button is handled entirely in the client; nothing to call.
    if (action.url) throw new HttpError(400, "link_action");

    const owner = store.appForBotUser(message.userId);
    if (!owner) throw new HttpError(400, "not_an_app_message");
    if (!owner.interactivityUrl) throw new HttpError(400, "no_interactivity_url");

    const target = {
      channelId: channel.id,
      invokerId: me.id,
      botUserId: owner.botUserId,
      threadRootId: message.threadRootId,
    };
    const responseUrl = newResponseUrl(target, requestOrigin(req));
    const payload = JSON.stringify({
      type: "block_actions",
      // Slack sends this as a form field named payload; so do we below.
      team: { id: store.getMeta("workspace_id") ?? "", domain: workspaceName() },
      user: { id: me.id, username: me.handle, name: me.displayName },
      api_app_id: owner.id,
      channel: { id: channel.id, name: channel.name },
      message: { ts: message.id, text: message.text, user: message.userId },
      container: { type: "message", message_ts: message.id, channel_id: channel.id },
      trigger_id: newTrigger({
        userId: me.id,
        channelId: channel.id,
        appId: owner.id,
        botUserId: owner.botUserId,
      }),
      response_url: responseUrl,
      actions: [
        {
          type: "button",
          action_id: action.actionId,
          block_id: action.blockId,
          text: { type: "plain_text", text: action.text },
          value: action.value,
          style: action.style === "default" ? undefined : action.style,
          action_ts: String(Date.now() / 1000),
        },
      ],
    });
    const form = new URLSearchParams({ payload }).toString();

    try {
      const res = await postToUrl(
        owner.interactivityUrl,
        form,
        "application/x-www-form-urlencoded",
        {
          allowPrivate: opts.allowPrivateHooks,
          headers: signatureHeaders(store.appSigningSecret(owner.id) ?? "", form),
        },
      );
      if (res.status < 200 || res.status >= 300) {
        sayEphemeral(
          channel.id,
          me.id,
          owner.botUserId,
          `That button failed: the app answered ${res.status}.`,
        );
        return { ok: false, error: "action_failed" };
      }
      deliverCommandReply(target, res.body, res.contentType, message.id);
      return { ok: true };
    } catch (err) {
      const why =
        err instanceof OutboundError && err.code === "blocked_host"
          ? err.message
          : "the app did not answer";
      sayEphemeral(channel.id, me.id, owner.botUserId, `That button failed: ${why}.`);
      return { ok: false, error: "action_failed" };
    }
  });

  // ---------- outgoing event subscriptions ----------

  app.post<{ Params: { id: string } }>("/api/apps/:id/subscriptions", async (req, reply) => {
    requireAdmin(req);
    const owner = store.getApp(req.params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const body = createSubscriptionBody.parse(req.body);

    await verifyCallbackUrl(body.url, owner.id);

    const subscription = store.createSubscription({
      appId: owner.id,
      url: body.url,
      eventTypes: body.eventTypes ?? [],
    });
    return reply.status(201).send({ subscription });
  });

  app.delete<{ Params: { id: string } }>("/api/subscriptions/:id", async (req) => {
    requireAdmin(req);
    if (!store.deleteSubscription(req.params.id)) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/retry", async (req) => {
    requireAdmin(req);
    if (!store.getSubscription(req.params.id)) throw new HttpError(404, "not_found");
    const retried = store.retryFailedEventDeliveries(req.params.id);
    void flushEventDeliveries();
    return { ok: true, retried };
  });

  // ---------- scheduled messages ----------

  app.post<{ Params: { id: string } }>("/api/channels/:id/scheduled", async (req, reply) => {
    const me = requireUser(req);
    const channel = requireChannelAccess(req.params.id, me);
    const body = scheduleMessageBody.parse(req.body);
    const requestHash = hashToken(
      JSON.stringify([
        channel.id,
        body.text,
        body.threadRootId ?? null,
        [...(body.fileIds ?? [])].sort(),
        body.sendAt,
      ]),
    );
    const result = store.transaction(() => {
      if (body.nonce) {
        const previous = store.scheduledRequest(me.id, body.nonce);
        if (previous) {
          if (previous.requestHash !== requestHash) throw new HttpError(409, "nonce_conflict");
          const scheduled = store.getScheduled(previous.scheduledId);
          if (!scheduled)
            throw new HttpError(
              410,
              "scheduled_removed",
              "This scheduling request was already accepted, but its queue record has been removed. It will not be recreated.",
            );
          return { scheduled, replayed: true };
        }
      }
      if (channel.archived) throw new HttpError(400, "channel_archived");
      if (body.sendAt <= Date.now()) {
        throw new HttpError(400, "send_at_in_past", "pick a time in the future");
      }
      // Queuing validates what sending validates, so a message cannot sit in the
      // queue for hours only to be rejected when it comes due.
      if (body.threadRootId) {
        const root = store.getMessage(body.threadRootId);
        if (!root || root.channelId !== channel.id || root.threadRootId) {
          throw new HttpError(400, "bad_thread_root");
        }
      }
      if (!store.unattachedFiles(body.fileIds ?? [], channel.id, me.id)) {
        throw new HttpError(400, "invalid_attachments");
      }
      const scheduled = store.scheduleMessage({
        channelId: channel.id,
        userId: me.id,
        text: body.text,
        threadRootId: body.threadRootId ?? null,
        fileIds: body.fileIds ?? [],
        sendAt: body.sendAt,
      });
      if (body.nonce) store.recordScheduledRequest(me.id, body.nonce, scheduled.id, requestHash);
      return { scheduled, replayed: false };
    });
    return reply.status(result.replayed ? 200 : 201).send({ scheduled: result.scheduled });
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

  /** The recovery path for a held or failed message: a past time sends it now. */
  app.patch<{ Params: { id: string } }>("/api/scheduled/:id", async (req) => {
    const me = requireUser(req);
    const scheduled = store.getScheduled(req.params.id);
    if (!scheduled || scheduled.userId !== me.id || scheduled.status === "sent") {
      throw new HttpError(404, "not_found");
    }
    const body = rescheduleBody.parse(req.body);
    requireChannelAccess(scheduled.channelId, me);
    store.rescheduleMessage(scheduled.id, body.sendAt);
    return { scheduled: store.getScheduled(scheduled.id)! };
  });

  app.patch<{ Params: { id: string } }>("/api/scheduled/:id/text", async (req) => {
    const me = requireUser(req);
    const scheduled = store.getScheduled(req.params.id);
    if (!scheduled || scheduled.userId !== me.id || scheduled.status === "sent") {
      throw new HttpError(404, "not_found");
    }
    requireChannelAccess(scheduled.channelId, me);
    const body = editScheduledBody.parse(req.body);
    if (!body.text.trim() && scheduled.fileIds.length === 0) {
      throw new HttpError(400, "empty_message", "A message needs text or attachments.");
    }
    if (!store.editScheduledText(scheduled.id, body.text, body.expectedText)) {
      throw new HttpError(
        409,
        "scheduled_changed",
        "This scheduled message has changed. Refresh before editing again.",
      );
    }
    return { scheduled: store.getScheduled(scheduled.id)! };
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
    mutate((emit) => {
      if (store.addPin(message.channelId, message.id, me.id)) {
        emit(
          { type: "pin.added", channelId: message.channelId, messageId: message.id, userId: me.id },
          message.channelId,
        );
      }
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/pin", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    mutate((emit) => {
      if (store.removePin(message.id)) {
        emit(
          { type: "pin.removed", channelId: message.channelId, messageId: message.id },
          message.channelId,
        );
      }
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/channels/:id/pins", async (req) => {
    const me = requireUser(req);
    requireChannelAccess(req.params.id, me);
    const query = pinnedMessagesQuery.parse(req.query);
    return store.listPins(req.params.id, query.limit, query.cursor);
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

  app.put<{ Params: { id: string } }>("/api/messages/:id/follow", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const body = threadFollowBody.parse(req.body ?? {});
    const state = store.setThreadFollow(me.id, message.id, body.following);
    if (!state) throw new HttpError(404, "message_not_found");
    gateway.sendToUser(me.id, { type: "thread.follow", state });
    return { state };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/thread/read", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const body = threadReadBody.parse(req.body ?? {});
    const state = store.markThreadRead(me.id, message.id, body.seq);
    if (!state) throw new HttpError(404, "message_not_found");
    gateway.sendToUser(me.id, { type: "thread.follow", state });
    return { state };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/thread/unread", async (req) => {
    const me = requireUser(req);
    const message = requireVisibleMessage(req.params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const { seq } = markUnreadBody.parse(req.body);
    const state = store.markThreadUnread(me.id, message.id, seq);
    if (!state) throw new HttpError(404, "message_not_found");
    gateway.sendToUser(me.id, { type: "thread.follow", state });
    return { state };
  });

  app.get("/api/threads/followed", async (req) => {
    const me = requireUser(req);
    const query = followedThreadsQuery.parse(req.query);
    return store.followedThreads(me.id, query.limit, query.cursor, query.unreadOnly === "true");
  });

  app.get("/api/saved", async (req) => {
    const me = requireUser(req);
    const query = savedMessagesQuery.parse(req.query);
    return store.listSaved(me.id, query.limit, query.cursor);
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

  app.get("/api/activity", async (req) => {
    const me = requireUser(req);
    const query = activityQuery.parse(req.query);
    const matches = store.activityMessages(me.id, { ...query, limit: query.limit + 1 });
    const messages = matches.slice(0, query.limit);
    return { messages, nextCursor: matches.length > query.limit ? messages.at(-1)!.id : null };
  });

  app.get("/api/search", async (req) => {
    const me = requireUser(req);
    const q = searchQuery.parse(req.query);
    if (q.channelId) requireChannelAccess(q.channelId, me);
    const parsed = parseSearchQuery(q.q);
    // A query of nothing but stray punctuation should return nothing, not everything.
    if (!hasSearchCriteria(parsed) && !q.channelId) return { messages: [], nextCursor: null };
    const matches = store.searchMessages(me.id, parsed, q.limit + 1, q);
    const messages = matches.slice(0, q.limit);
    return { messages, nextCursor: matches.length > q.limit ? messages.at(-1)!.id : null };
  });

  // ---------- start ----------

  const port = opts.port ?? 8543;
  const host = opts.host ?? "0.0.0.0";
  gateway.attach(app.server);
  try {
    await app.listen({ port, host });
  } catch (err) {
    await gateway.close();
    await app.close();
    db.close();
    throw err;
  }
  const actualPort = (app.server.address() as { port: number }).port;

  let mdnsHandle: MdnsHandle | null = null;
  if (opts.mdns !== false) {
    mdnsHandle = advertise({ name: workspaceName(), port: actualPort });
  }

  /**
   * Posts anything that has come due. Runs on a timer and once at startup, so
   * messages scheduled while the server was down still go out.
   *
   * Nothing is dropped silently. Delivery marks the queue row sent inside the
   * message transaction, so a crash between the two replays rather than losing
   * or duplicating the message. An obstacle that the author can clear holds the
   * row; one they cannot fails it. Either way the reason is theirs to read.
   */
  const flushScheduled = () => {
    for (const item of store.dueScheduled()) {
      const channel = store.getChannel(item.channelId);
      const held = !channel
        ? "That channel no longer exists."
        : channel.archived
          ? "That channel is archived."
          : !store.canAccess(channel.id, item.userId)
            ? "You are no longer a member of that channel."
            : store.getUser(item.userId)?.deactivated
              ? "Your account is deactivated."
              : null;
      if (held) {
        store.holdScheduled(item.id, held);
        continue;
      }
      try {
        postMessage({
          channelId: item.channelId,
          userId: item.userId,
          text: item.text,
          threadRootId: item.threadRootId,
          nonce: null,
          fileIds: item.fileIds,
          scheduledId: item.id,
        });
      } catch (err) {
        const code = err instanceof HttpError ? err.code : null;
        if (code === "bad_thread_root") {
          store.failScheduled(item.id, "The message this replied to was deleted.");
        } else if (code === "invalid_attachments") {
          store.failScheduled(item.id, "Its attachments are no longer available.");
        } else if (store.countScheduledAttempt(item.id) >= SCHEDULED_ATTEMPTS) {
          store.failScheduled(item.id, "Sending failed repeatedly, so it was not posted.");
        } else {
          store.holdScheduled(item.id, "Sending failed. It will be tried again shortly.");
        }
      }
    }
  };
  flushScheduled();
  void flushEventDeliveries();
  reconcileOrphanedBlobs();
  expireAbandonedUploads();
  void flushFileDeletions();
  const scheduleTimer = setInterval(() => {
    flushScheduled();
    void flushFileDeletions();
  }, 15_000);
  const eventDeliveryTimer = setInterval(() => void flushEventDeliveries(), 5_000);

  const pruneTimer = setInterval(() => {
    store.pruneEvents();
    store.pruneScheduled(Date.now() - SCHEDULED_RETENTION_MS);
    store.pruneSessions();
    store.pruneDownloadTokens();
    store.pruneEventDeliveries(Date.now() - EVENT_DELIVERY_RETENTION_MS);
    // After pruning the queue, so a scheduled message that has just gone stops
    // holding its attachments in the same round rather than an hour later.
    if (expireAbandonedUploads() > 0) void flushFileDeletions();
  }, 3600_000);
  let stopping: Promise<void> | null = null;

  return {
    port: actualPort,
    store,
    gateway,
    /** Set only while the workspace still has no owner. */
    claimCode: claimCode(),
    flushScheduled,
    flushFileDeletions,
    expireAbandonedUploads,
    flushEventDeliveries,
    stop: () => {
      if (stopping) return stopping;
      clearInterval(scheduleTimer);
      clearInterval(eventDeliveryTimer);
      clearInterval(pruneTimer);
      mdnsHandle?.stop();
      stopping = (async () => {
        await gateway.close();
        await app.close();
        await Promise.all([flushFileDeletions(), eventDeliveryFlush ?? Promise.resolve()]);
        db.close();
      })();
      return stopping;
    },
  };
}
