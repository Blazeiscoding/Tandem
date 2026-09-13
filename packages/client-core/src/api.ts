import type {
  App,
  Channel,
  ChannelPrefs,
  ChannelPrefsBody,
  CreateChannelBody,
  CreateInviteBody,
  FileMeta,
  Friendship,
  ID,
  AuditEntry,
  Invite,
  Message,
  SendMessageBody,
  ScheduledMessage,
  ScheduleMessageBody,
  ServerInfo,
  StorageUsage,
  SessionInfo,
  SlashCommand,
  ThreadFollow,
  FollowedThread,
  EventSubscription,
  EditScheduledBody,
  UpdateChannelBody,
  UpdateMeBody,
  User,
  Webhook,
} from "@slackoss/protocol";

/** One entry in the composer's `/` hint list. */
export interface CommandHint {
  command: string;
  description: string;
  usageHint: string;
  /** Answered by the server itself rather than an installed app. */
  builtin: boolean;
}

/** An app with everything hanging off it, as the admin screen needs it. */
export interface AppDetail extends App {
  webhooks: Webhook[];
  commands: SlashCommand[];
  subscriptions: EventSubscription[];
  /** Readable by admins: apps need it to verify our signatures. */
  signingSecret: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Typed REST client for one workspace server. */
export class Api {
  constructor(
    public baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts?.timeoutMs
        ? opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
          : AbortSignal.timeout(opts.timeoutMs)
        : opts?.signal,
    });
    if (!res.ok) {
      let code = "http_error";
      let message: string | undefined;
      try {
        const data = (await res.json()) as { error?: string; message?: string };
        code = data.error ?? code;
        message = data.message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  serverInfo(timeoutMs = 4000): Promise<ServerInfo> {
    return this.request<ServerInfo>("GET", "/api/server-info", undefined, { timeoutMs });
  }

  storageUsage(signal?: AbortSignal): Promise<StorageUsage> {
    return this.request("GET", "/api/storage", undefined, { timeoutMs: 10_000, signal });
  }

  async downloadUrl(fileId: ID): Promise<string> {
    if (!(await this.serverInfo()).downloadTickets)
      throw new ApiError(409, "download_upgrade_required");
    const result = await this.request<{ token: string; expiresAt: number }>(
      "POST",
      `/api/files/${fileId}/download-token`,
      undefined,
      { timeoutMs: 10_000 },
    );
    if (typeof result.token !== "string" || !/^[a-f0-9]{64}$/.test(result.token))
      throw new ApiError(502, "invalid_response");
    return `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}?download=${result.token}`;
  }

  rtcConfig(): Promise<RTCConfiguration> {
    return this.request("GET", "/api/rtc-config", undefined, { timeoutMs: 5000 });
  }

  friends(): Promise<{ friends: Friendship[] }> {
    return this.request("GET", "/api/friends");
  }

  updateFriend(
    userId: ID,
    action: "request" | "accept" | "remove",
  ): Promise<{ friends: Friendship[] }> {
    return this.request(
      { request: "POST", accept: "PUT", remove: "DELETE" }[action],
      `/api/friends/${encodeURIComponent(userId)}`,
    );
  }

  register(body: {
    handle: string;
    displayName: string;
    password: string;
    inviteCode?: string;
    claimCode?: string;
  }): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/auth/register", body);
  }

  login(body: {
    handle: string;
    password: string;
  }): Promise<{ token: string; user: User; mustChangePassword?: boolean }> {
    return this.request("POST", "/api/auth/login", body);
  }

  logout(): Promise<{ ok: true }> {
    return this.request("POST", "/api/auth/logout", undefined, { timeoutMs: 10_000 });
  }

  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: true }> {
    return this.request(
      "POST",
      "/api/auth/password",
      { currentPassword, newPassword },
      { timeoutMs: 20_000 },
    );
  }

  listSessions(): Promise<{ sessions: SessionInfo[] }> {
    return this.request("GET", "/api/auth/sessions", undefined, { timeoutMs: 10_000 });
  }

  revokeSession(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`, undefined, {
      timeoutMs: 10_000,
    });
  }

  revokeOtherSessions(): Promise<{ revoked: number }> {
    return this.request("DELETE", "/api/auth/sessions", undefined, { timeoutMs: 10_000 });
  }

  resetPassword(userId: ID): Promise<{ temporaryPassword: string }> {
    return this.request(
      "POST",
      `/api/admin/users/${encodeURIComponent(userId)}/password`,
      undefined,
      { timeoutMs: 20_000 },
    );
  }

  transferOwnership(userId: ID): Promise<{ owner: User; previousOwner: User }> {
    return this.request("POST", `/api/admin/users/${encodeURIComponent(userId)}/owner`, undefined, {
      timeoutMs: 10_000,
    });
  }

  me(): Promise<{ user: User }> {
    return this.request("GET", "/api/me");
  }

  updateMe(body: UpdateMeBody): Promise<{ user: User }> {
    return this.request("PATCH", "/api/me", body);
  }

  listUsers(): Promise<{ users: User[] }> {
    return this.request("GET", "/api/users");
  }

  listChannels(): Promise<{ channels: Channel[] }> {
    return this.request("GET", "/api/channels");
  }

  createChannel(body: CreateChannelBody): Promise<{ channel: Channel }> {
    return this.request("POST", "/api/channels", body, { timeoutMs: 10_000 });
  }

  updateChannel(id: ID, body: UpdateChannelBody): Promise<{ channel: Channel }> {
    return this.request("PATCH", `/api/channels/${id}`, body, { timeoutMs: 10_000 });
  }

  joinChannel(id: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${id}/join`);
  }

  leaveChannel(id: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${id}/leave`, undefined, { timeoutMs: 10_000 });
  }

  inviteMember(channelId: ID, userId: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${channelId}/invite-member`, { userId });
  }

  channelMembers(id: ID): Promise<{ memberIds: ID[] }> {
    return this.request("GET", `/api/channels/${id}/members`, undefined, { timeoutMs: 10_000 });
  }

  setChannelManager(channelId: ID, userId: ID, manager: boolean): Promise<{ channel: Channel }> {
    return this.request(
      "PATCH",
      `/api/channels/${channelId}/managers/${userId}`,
      { manager },
      { timeoutMs: 10_000 },
    );
  }

  removeChannelMember(channelId: ID, userId: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/channels/${channelId}/members/${userId}`, undefined, {
      timeoutMs: 10_000,
    });
  }

  markRead(channelId: ID, seq: number, signal?: AbortSignal): Promise<{ ok: true; seq?: number }> {
    return this.request(
      "POST",
      `/api/channels/${channelId}/read`,
      { seq },
      { timeoutMs: 10_000, signal },
    );
  }

  listMessages(
    channelId: ID,
    opts: { before?: ID; limit?: number; threadRootId?: ID } = {},
  ): Promise<{ messages: Message[]; readThroughSeq?: number }> {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.threadRootId) params.set("threadRootId", opts.threadRootId);
    const qs = params.size > 0 ? `?${params}` : "";
    return this.request("GET", `/api/channels/${channelId}/messages${qs}`, undefined, {
      timeoutMs: 10_000,
    });
  }

  /** A window of messages centred on one, for jumping to it. */
  listMessagesAround(
    channelId: ID,
    messageId: ID,
    limit = 50,
  ): Promise<{
    messages: Message[];
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    threadRootId?: ID | null;
  }> {
    return this.request(
      "GET",
      `/api/channels/${channelId}/messages/around/${messageId}?limit=${limit}`,
      undefined,
      { timeoutMs: 10_000 },
    );
  }

  listMessagesAfter(channelId: ID, afterId: ID, limit = 50): Promise<{ messages: Message[] }> {
    return this.request(
      "GET",
      `/api/channels/${channelId}/messages/after/${afterId}?limit=${limit}`,
      undefined,
      { timeoutMs: 10_000 },
    );
  }

  threadHistory(
    channelId: ID,
    rootId: ID,
    opts: { before?: ID; after?: ID; around?: ID; limit?: number } = {},
  ): Promise<{
    root: Message;
    messages: Message[];
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    seq: number;
  }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(opts))
      if (value !== undefined) query.set(key, String(value));
    return this.request(
      "GET",
      `/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootId)}?${query}`,
      undefined,
      { timeoutMs: 10_000 },
    );
  }

  sendMessage(channelId: ID, body: SendMessageBody): Promise<{ message: Message }> {
    return this.request("POST", `/api/channels/${channelId}/messages`, body);
  }

  editMessage(id: ID, text: string): Promise<{ message: Message }> {
    return this.request("PATCH", `/api/messages/${id}`, { text }, { timeoutMs: 10_000 });
  }

  deleteMessage(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${id}`);
  }

  addReaction(messageId: ID, emoji: string): Promise<{ ok: true }> {
    return this.request("PUT", `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  removeReaction(messageId: ID, emoji: string): Promise<{ ok: true }> {
    return this.request(
      "DELETE",
      `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    );
  }

  /** Uploads one file to a channel; attach the returned id to a message. */
  async uploadFile(
    channelId: ID,
    file: Blob,
    name: string,
    opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<{ file: FileMeta }> {
    const form = new FormData();
    form.append("file", file, name);

    // XHR rather than fetch: it reports upload progress, which large files need.
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new ApiError(0, "aborted"));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}/api/channels/${channelId}/files`);
      xhr.timeout = 300_000;
      if (this.token) xhr.setRequestHeader("authorization", `Bearer ${this.token}`);
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { file: FileMeta });
          } catch {
            reject(new ApiError(0, "invalid_response"));
          }
        } else {
          let code = "upload_failed";
          try {
            code = (JSON.parse(xhr.responseText) as { error?: string }).error ?? code;
          } catch {
            /* non-JSON error body */
          }
          reject(new ApiError(xhr.status, code));
        }
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, "network_error")));
      xhr.addEventListener("abort", () => reject(new ApiError(0, "aborted")));
      xhr.addEventListener("timeout", () => reject(new ApiError(0, "upload_timeout")));
      const abort = () => xhr.abort();
      opts.signal?.addEventListener("abort", abort, { once: true });
      xhr.addEventListener("loadend", () => opts.signal?.removeEventListener("abort", abort));
      xhr.send(form);
    });
  }

  /** Raw bytes of an upload, fetched with the session token. */
  async fetchFile(fileId: ID, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/files/${fileId}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(300_000),
    });
    if (!res.ok)
      throw new ApiError(
        res.status,
        res.status === 404 ? "file_not_found" : "file_download_failed",
      );
    return res.blob();
  }

  async scheduleMessage(
    channelId: ID,
    body: ScheduleMessageBody,
  ): Promise<{ scheduled: ScheduledMessage }> {
    if (body.nonce && !(await this.serverInfo()).schedulingIdempotency) {
      throw new ApiError(
        409,
        "scheduling_upgrade_required",
        "Update this workspace server before using recoverable scheduling.",
      );
    }
    return this.request("POST", `/api/channels/${channelId}/scheduled`, body, {
      timeoutMs: 15_000,
    });
  }

  listScheduled(signal?: AbortSignal): Promise<{ scheduled: ScheduledMessage[] }> {
    return this.request("GET", "/api/scheduled", undefined, { signal, timeoutMs: 10_000 });
  }

  cancelScheduled(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/scheduled/${id}`, undefined, { timeoutMs: 10_000 });
  }

  /** Requeues a held or failed message. A past time sends it on the next flush. */
  rescheduleMessage(id: ID, sendAt: number): Promise<{ scheduled: ScheduledMessage }> {
    return this.request("PATCH", `/api/scheduled/${id}`, { sendAt }, { timeoutMs: 10_000 });
  }

  editScheduledMessage(id: ID, body: EditScheduledBody): Promise<{ scheduled: ScheduledMessage }> {
    return this.request("PATCH", `/api/scheduled/${id}/text`, body, { timeoutMs: 10_000 });
  }

  setChannelPrefs(channelId: ID, body: ChannelPrefsBody): Promise<{ prefs: ChannelPrefs }> {
    return this.request("PATCH", `/api/channels/${channelId}/prefs`, body);
  }

  pinMessage(id: ID): Promise<{ ok: true }> {
    return this.request("PUT", `/api/messages/${id}/pin`);
  }

  unpinMessage(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${id}/pin`);
  }

  listPins(
    channelId: ID,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<{ messages: Message[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "30" });
    if (cursor) query.set("cursor", cursor);
    return this.request("GET", `/api/channels/${channelId}/pins?${query}`, undefined, {
      signal,
      timeoutMs: 10_000,
    });
  }

  saveMessage(id: ID): Promise<{ ok: true }> {
    return this.request("PUT", `/api/messages/${id}/save`);
  }

  unsaveMessage(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${id}/save`);
  }

  listSaved(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ messages: Message[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "30" });
    if (cursor) query.set("cursor", cursor);
    return this.request("GET", `/api/saved?${query}`, undefined, { signal, timeoutMs: 10_000 });
  }

  markUnread(channelId: ID, seq: number): Promise<{ ok: true; seq: number }> {
    return this.request("POST", `/api/channels/${channelId}/unread`, { seq });
  }

  markThreadUnread(rootId: ID, seq: number): Promise<{ state: ThreadFollow }> {
    return this.request("POST", `/api/messages/${rootId}/thread/unread`, { seq });
  }

  setThreadFollow(rootId: ID, following: boolean): Promise<{ state: ThreadFollow }> {
    return this.request("PUT", `/api/messages/${rootId}/follow`, { following });
  }

  markThreadRead(rootId: ID, seq: number): Promise<{ state: ThreadFollow }> {
    return this.request("POST", `/api/messages/${rootId}/thread/read`, { seq });
  }

  listFollowedThreads(
    opts: { cursor?: string; unreadOnly?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ threads: FollowedThread[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: "30" });
    if (opts.cursor) query.set("cursor", opts.cursor);
    if (opts.unreadOnly) query.set("unreadOnly", "true");
    return this.request("GET", `/api/threads/followed?${query}`, undefined, {
      signal,
      timeoutMs: 10_000,
    });
  }

  // ---------- apps and integrations (admin only) ----------

  /** The bot token comes back once here and is never retrievable again. */
  createApp(body: {
    name: string;
  }): Promise<{ app: App; botUser: User; token: string; signingSecret: string }> {
    return this.request("POST", "/api/apps", body);
  }

  listApps(): Promise<{ apps: AppDetail[] }> {
    return this.request("GET", "/api/apps");
  }

  deleteApp(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/apps/${id}`);
  }

  createWebhook(appId: ID, body: { channelId: ID }): Promise<{ webhook: Webhook; url: string }> {
    return this.request("POST", `/api/apps/${appId}/webhooks`, body);
  }

  /** Replaces every bot token the app has; the old ones stop working at once. */
  replaceAppToken(appId: ID): Promise<{ token: string }> {
    return this.request("POST", `/api/apps/${appId}/token`);
  }

  replaceSigningSecret(appId: ID): Promise<{ signingSecret: string }> {
    return this.request("POST", `/api/apps/${appId}/signing-secret`);
  }

  /** A new URL for the same webhook and channel; the old URL stops working. */
  replaceWebhookUrl(id: ID): Promise<{ webhook: Webhook; url: string }> {
    return this.request("POST", `/api/webhooks/${id}/url`);
  }

  deleteWebhook(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/webhooks/${id}`);
  }

  createCommand(
    appId: ID,
    body: { command: string; url: string; description?: string; usageHint?: string },
  ): Promise<{ command: SlashCommand }> {
    return this.request("POST", `/api/apps/${appId}/commands`, body);
  }

  deleteCommand(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/commands/${id}`);
  }

  /** The server calls the URL to verify it before this resolves. */
  createSubscription(
    appId: ID,
    body: { url: string; eventTypes?: string[] },
  ): Promise<{ subscription: EventSubscription }> {
    return this.request("POST", `/api/apps/${appId}/subscriptions`, body);
  }

  deleteSubscription(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/subscriptions/${id}`);
  }

  retrySubscription(id: ID): Promise<{ ok: true; retried: number }> {
    return this.request("POST", `/api/subscriptions/${id}/retry`);
  }

  /** Every command that can be typed here, built-ins included. */
  listCommands(): Promise<{ commands: CommandHint[] }> {
    return this.request("GET", "/api/commands");
  }

  runCommand(channelId: ID, body: { text: string; threadRootId?: ID }): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/channels/${channelId}/commands`, body);
  }

  /** Presses a button an app put on a message. */
  runMessageAction(messageId: ID, actionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.request("POST", `/api/messages/${messageId}/actions`, { actionId });
  }

  /** Sends a filled-in modal; field errors come back keyed by block id. */
  submitView(
    viewId: ID,
    values: Record<string, Record<string, string>>,
  ): Promise<{ ok: boolean; errors?: Record<string, string>; message?: string }> {
    return this.request("POST", `/api/views/${viewId}/submit`, { values });
  }

  /** Everyone with an account, with when they were last seen. Admins only. */
  listAllUsers(): Promise<{ users: (User & { lastSeenAt: number | null })[] }> {
    return this.request("GET", "/api/admin/users", undefined, { timeoutMs: 10_000 });
  }

  /** Change someone's role, or take their access away. Admins only. */
  updateUserAdmin(
    userId: ID,
    patch: { role?: "member" | "admin"; deactivated?: boolean; canInvite?: boolean },
  ): Promise<{ user: User }> {
    return this.request("PATCH", `/api/admin/users/${userId}`, patch);
  }

  setInteractivityUrl(appId: ID, url: string): Promise<{ app: App }> {
    return this.request("PUT", `/api/apps/${appId}/interactivity`, { url });
  }

  createInvite(body: CreateInviteBody = {}): Promise<{ invite: Invite }> {
    return this.request("POST", "/api/invites", body);
  }

  /** A page of what administrators have changed, newest first. */
  listAudit(before?: string): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
    return this.request(
      "GET",
      `/api/admin/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    );
  }

  /** Every invite for an administrator; one's own for everyone else. Newest first. */
  listInvites(): Promise<{ invites: Invite[] }> {
    return this.request("GET", "/api/invites");
  }

  /** Stops an invite letting anyone else in. Already-revoked is not an error. */
  revokeInvite(code: string): Promise<{ invite: Invite }> {
    return this.request("DELETE", `/api/invites/${encodeURIComponent(code)}`);
  }

  activity(
    mode: "unread" | "mentions",
    opts: { cursor?: ID; signal?: AbortSignal } = {},
  ): Promise<{ messages: Message[]; nextCursor: ID | null }> {
    const params = new URLSearchParams({ mode });
    if (opts.cursor) params.set("cursor", opts.cursor);
    return this.request("GET", `/api/activity?${params}`, undefined, {
      signal: opts.signal,
      timeoutMs: 10_000,
    });
  }

  search(
    q: string,
    limit = 30,
    opts: { cursor?: ID; channelId?: ID; signal?: AbortSignal } = {},
  ): Promise<{ messages: Message[]; nextCursor: ID | null }> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.channelId) params.set("channelId", opts.channelId);
    return this.request("GET", `/api/search?${params}`, undefined, {
      timeoutMs: 10_000,
      signal: opts.signal,
    });
  }
}

/** Normalize whatever the user typed ("192.168.1.4:8543", "chat.foo.com", full URL) into a base URL. */
export function normalizeServerUrl(input: string, defaultPort = 8543): string {
  let s = input.trim();
  if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  const url = new URL(s);
  if (!url.port && url.protocol === "http:") url.port = String(defaultPort);
  return url.origin;
}
