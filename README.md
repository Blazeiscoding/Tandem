# SlackOSS

Open-source team chat that **you** host. Run the server on a VPS, or click
**"Host a workspace"** in the desktop app and serve your team straight from your
own PC — like opening a Minecraft world to LAN. Teammates on the same Wi-Fi
discover your workspace automatically; anyone else connects by `ip:port` or an
invite link. Every message, file, and account lives in a single folder on the
host's machine, forever.

## How people join

- **Same network** — the desktop app's Join screen lists every workspace
  advertising on the LAN (mDNS). One click to join.
- **Direct connect** — type `192.168.1.42:8543` or `chat.yourteam.dev`.
- **Invite links** — `slackoss://join?host=...&code=...` open the app pre-filled.
- **No app?** — the server also serves a full browser client at `http://host:8543/`.

The first account created on a fresh server becomes its **owner**.

## Hosting a server

### From the desktop app
Join screen → *Host a workspace on this computer* → name it → done. The same
server code runs inside the app; the workspace folder can later be moved to a
VPS unchanged.

### Standalone (VPS, spare machine)
```sh
node slackoss-server.js --data ./data --name "My Team" --invite-only
```
Requires Node 24+. The bundled file has zero dependencies — the database is
Node's built-in SQLite. Flags: `--port`, `--host`, `--no-mdns`, `--web <dir>`,
`--invite-only`.

### Docker
```sh
docker compose -f docker/docker-compose.yml up -d
```
Data persists in the `slackoss-data` volume. Put Caddy or any reverse proxy in
front for HTTPS on the public internet; for hosting from home, port-forward or
use Tailscale.

## Development

pnpm monorepo (Node 24+, pnpm 10):

```sh
pnpm install
pnpm --filter @slackoss/server dev      # workspace server on :8543
pnpm --filter @slackoss/desktop dev     # Electron app
pnpm test                               # server integration tests
pnpm typecheck
```

| package | what it is |
| --- | --- |
| `packages/protocol` | Shared types: entities, WS events, REST schemas (zod) |
| `packages/server` | Workspace server — Fastify + ws + `node:sqlite`, pure JS |
| `packages/client-core` | Client SDK: REST + resilient WS + local replica (zustand) |
| `packages/ui` | React UI shared by desktop and web |
| `apps/desktop` | Electron app (electron-vite, React 19, Tailwind 4) |
| `apps/web` | Browser client, served by the server itself |
| `apps/server-cli` | Bundles the server into one runnable file |

### How sync works
Every mutation appends to a per-workspace event log with a monotonic `seq` and
fans out over WebSocket. Clients keep a local replica, render from it
instantly (sends are optimistic, reconciled by nonce), and on reconnect replay
everything after their last `seq` — flaky Wi-Fi and laptop sleep are painless.

## Status / roadmap

Phase 1 (this repo today): channels, private channels, DMs & group DMs,
threads, reactions, mentions, typing, presence, unread tracking, full-text
search, invites, LAN discovery, in-app hosting, browser client.

Next: files & images (P2), pins/saved/scheduled (P2), huddles via WebRTC (P3),
Slack-compatible webhooks + slash commands + bot API (P4), admin console (P4).
