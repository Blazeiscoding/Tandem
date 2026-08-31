import type {
  Channel,
  CreateChannelBody,
  CreateInviteBody,
  ID,
  Invite,
  Message,
  SendMessageBody,
  ServerInfo,
  UpdateChannelBody,
  UpdateMeBody,
  User,
} from "@slackoss/protocol";

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
