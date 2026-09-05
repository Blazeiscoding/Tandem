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
  Invite,
  Message,
  SendMessageBody,
  ScheduledMessage,
  ScheduleMessageBody,
  ServerInfo,
  SlashCommand,
  EventSubscription,
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
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
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

  rtcConfig(): Promise<RTCConfiguration> {
    return this.request("GET", "/api/rtc-config", undefined, { timeoutMs: 5000 });
  }

  friends(): Promise<{ friends: Friendship[] }> {
    return this.request("GET", "/api/friends");
  }

  updateFriend(userId: ID, action: "request" | "accept" | "remove"): Promise<{ friends: Friendship[] }> {
    return this.request({ request: "POST", accept: "PUT", remove: "DELETE" }[action], `/api/friends/${encodeURIComponent(userId)}`);
  }

  register(body: {
    handle: string;
    displayName: string;
    password: string;
    inviteCode?: string;
  }): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/auth/register", body);
  }

  login(body: { handle: string; password: string }): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/auth/login", body);
  }

  logout(): Promise<{ ok: true }> {
    return this.request("POST", "/api/auth/logout");
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
    return this.request("POST", "/api/channels", body);
  }

  updateChannel(id: ID, body: UpdateChannelBody): Promise<{ channel: Channel }> {
    return this.request("PATCH", `/api/channels/${id}`, body);
  }

  joinChannel(id: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${id}/join`);
  }

  leaveChannel(id: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${id}/leave`);
  }

  inviteMember(channelId: ID, userId: ID): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${channelId}/invite-member`, { userId });
  }

  channelMembers(id: ID): Promise<{ memberIds: ID[] }> {
    return this.request("GET", `/api/channels/${id}/members`);
  }

  markRead(channelId: ID, seq: number): Promise<{ ok: true }> {
    return this.request("POST", `/api/channels/${channelId}/read`, { seq });
  }

  listMessages(
    channelId: ID,
    opts: { before?: ID; limit?: number; threadRootId?: ID } = {},
  ): Promise<{ messages: Message[] }> {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.threadRootId) params.set("threadRootId", opts.threadRootId);
    const qs = params.size > 0 ? `?${params}` : "";
    return this.request("GET", `/api/channels/${channelId}/messages${qs}`);
  }

  /** A window of messages centred on one, for jumping to it. */
  listMessagesAround(
    channelId: ID,
    messageId: ID,
    limit = 50,
  ): Promise<{ messages: Message[]; hasMoreOlder: boolean; hasMoreNewer: boolean }> {
    return this.request(
      "GET",
      `/api/channels/${channelId}/messages/around/${messageId}?limit=${limit}`,
    );
  }

  listMessagesAfter(channelId: ID, afterId: ID, limit = 50): Promise<{ messages: Message[] }> {
    return this.request(
      "GET",
      `/api/channels/${channelId}/messages/after/${afterId}?limit=${limit}`,
    );
  }

  sendMessage(channelId: ID, body: SendMessageBody): Promise<{ message: Message }> {
    return this.request("POST", `/api/channels/${channelId}/messages`, body);
  }

  editMessage(id: ID, text: string): Promise<{ message: Message }> {
    return this.request("PATCH", `/api/messages/${id}`, { text });
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
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}/api/channels/${channelId}/files`);
      if (this.token) xhr.setRequestHeader("authorization", `Bearer ${this.token}`);
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText) as { file: FileMeta });
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
      opts.signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(form);
    });
  }

  /** Raw bytes of an upload, fetched with the session token. */
  async fetchFile(fileId: ID): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/files/${fileId}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, "file_not_found");
    return res.blob();
  }

  scheduleMessage(
    channelId: ID,
    body: ScheduleMessageBody,
  ): Promise<{ scheduled: ScheduledMessage }> {
    return this.request("POST", `/api/channels/${channelId}/scheduled`, body);
  }

  listScheduled(): Promise<{ scheduled: ScheduledMessage[] }> {
    return this.request("GET", "/api/scheduled");
  }

  cancelScheduled(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/scheduled/${id}`);
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

  listPins(channelId: ID): Promise<{ messages: Message[] }> {
    return this.request("GET", `/api/channels/${channelId}/pins`);
  }

  saveMessage(id: ID): Promise<{ ok: true }> {
    return this.request("PUT", `/api/messages/${id}/save`);
  }

  unsaveMessage(id: ID): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/messages/${id}/save`);
  }

  listSaved(): Promise<{ messages: Message[] }> {
    return this.request("GET", "/api/saved");
  }

  // ---------- apps and integrations (admin only) ----------

  /** The bot token comes back once here and is never retrievable again. */
  createApp(
    body: { name: string },
  ): Promise<{ app: App; botUser: User; token: string; signingSecret: string }> {
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

  setInteractivityUrl(appId: ID, url: string): Promise<{ app: App }> {
    return this.request("PUT", `/api/apps/${appId}/interactivity`, { url });
  }

  createInvite(body: CreateInviteBody = {}): Promise<{ invite: Invite }> {
    return this.request("POST", "/api/invites", body);
  }

  search(q: string, limit = 30): Promise<{ messages: Message[] }> {
    return this.request("GET", `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
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
