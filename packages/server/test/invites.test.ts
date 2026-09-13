import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import type { Invite } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer;
let base: string;
let owner: { token: string; id: string };
let member: { token: string; id: string };
let logLines: string[];

async function call<T = any>(path: string, token: string | null, method = "GET", body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

async function register(handle: string, inviteCode?: string) {
  return call<{ token: string; user: { id: string }; error?: string }>(
    "/api/auth/register",
    null,
    "POST",
    { handle, displayName: handle, password: "password123", ...(inviteCode ? { inviteCode } : {}) },
  );
}

async function invite(token: string, body: Record<string, unknown> = { expiresInHours: 24 }) {
  return (await call<{ invite: Invite }>("/api/invites", token, "POST", body)).data.invite;
}

beforeEach(async () => {
  logLines = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  // Invite-only, so a refused code is what actually keeps someone out.
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    inviteOnly: true,
    rateLimits: false,
    logger: { stream },
  });
  base = `http://127.0.0.1:${server.port}`;
  const first = await register("owner");
  owner = { token: first.data.token, id: first.data.user.id };
  const joined = await register("member", (await invite(owner.token)).code);
  member = { token: joined.data.token, id: joined.data.user.id };
});

afterEach(() => server.stop());

describe("the invites someone can see", () => {
  it("are every invite, for an administrator", async () => {
    const mine = await invite(owner.token);
    const theirs = await invite(member.token);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", owner.token)).data.invites;
    const codes = listed.map((i) => i.code);
    expect(codes).toContain(mine.code);
    expect(codes).toContain(theirs.code);
  });

  it("are only their own, for a member", async () => {
    // A code is what lets a stranger in, so one member is never shown another's.
    const ownersCode = (await invite(owner.token)).code;
    const theirs = await invite(member.token);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", member.token)).data.invites;
    expect(listed.map((i) => i.code)).toEqual([theirs.code]);
    expect(listed.map((i) => i.code)).not.toContain(ownersCode);
  });

  it("say how each one stands, and how much it has been used", async () => {
    const once = await invite(owner.token, { maxUses: 1 });
    expect((await register("first-in", once.code)).status).toBe(201);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", owner.token)).data.invites;
    const found = listed.find((i) => i.code === once.code)!;
    expect(found.uses).toBe(1);
    expect(found.status).toBe("used_up");
  });
});

describe("revoking an invite", () => {
  it("stops it letting anyone in", async () => {
    const leaked = await invite(owner.token);
    const revoked = await call<{ invite: Invite }>(
      `/api/invites/${leaked.code}`,
      owner.token,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect(revoked.data.invite.status).toBe("revoked");
    expect(revoked.data.invite.revokedAt).toBeTypeOf("number");

    const refused = await register("stranger", leaked.code);
    expect(refused.status).toBe(403);
    expect(refused.data.error).toBe("invite_required");
  });

  it("is something its creator can do", async () => {
    const own = await invite(member.token);
    expect((await call(`/api/invites/${own.code}`, member.token, "DELETE")).status).toBe(200);
    expect((await register("stranger", own.code)).status).toBe(403);
  });

  it("is something an administrator can do to anyone's", async () => {
    const theirs = await invite(member.token);
    expect((await call(`/api/invites/${theirs.code}`, owner.token, "DELETE")).status).toBe(200);
    expect((await register("stranger", theirs.code)).status).toBe(403);
  });

  it("is not something one member can do to another's, and does not confirm it exists", async () => {
    const ownersCode = (await invite(owner.token)).code;
    const refused = await call(`/api/invites/${ownersCode}`, member.token, "DELETE");
    // The same answer as for a code that was never issued.
    expect(refused).toEqual(await call("/api/invites/NOSUCHCODE", member.token, "DELETE"));
    expect(refused.status).toBe(404);
    // And the invite still works.
    expect((await register("welcome", ownersCode)).status).toBe(201);
  });

  it("can be asked twice without failing", async () => {
    const leaked = await invite(owner.token);
    await call(`/api/invites/${leaked.code}`, owner.token, "DELETE");
    const again = await call<{ invite: Invite }>(
      `/api/invites/${leaked.code}`,
      owner.token,
      "DELETE",
    );
    expect(again.status).toBe(200);
    expect(again.data.invite.status).toBe("revoked");
  });

  it("does not write the code to the request log", async () => {
    const leaked = await invite(owner.token);
    await call(`/api/invites/${leaked.code}`, owner.token, "DELETE");
    await new Promise((r) => setTimeout(r, 100));
    const log = logLines.join("");
    expect(log).toContain("/api/invites/REDACTED");
    expect(log).not.toContain(leaked.code);
  });
});

describe("an invite whose creator has been deactivated", () => {
  async function setDeactivated(id: string, deactivated: boolean) {
    const res = await call(`/api/admin/users/${id}`, owner.token, "PATCH", { deactivated });
    expect(res.status).toBe(200);
  }

  it("stops working, since nobody still here vouches for it", async () => {
    const left = await invite(member.token);
    await setDeactivated(member.id, true);
    expect((await register("stranger", left.code)).status).toBe(403);
    const listed = (await call<{ invites: Invite[] }>("/api/invites", owner.token)).data.invites;
    expect(listed.find((i) => i.code === left.code)!.status).toBe("creator_deactivated");
  });

  it("works again if they are brought back, unlike one that was revoked", async () => {
    const paused = await invite(member.token);
    await setDeactivated(member.id, true);
    await setDeactivated(member.id, false);
    expect((await register("welcome-back", paused.code)).status).toBe(201);
  });
});
