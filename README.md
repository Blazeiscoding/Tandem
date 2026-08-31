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

## What works today

Channels (public and private), DMs and group DMs, threads, reactions, mentions,
typing indicators, presence, unread tracking, file and image sharing with
inline previews and a lightbox, pins, saved items, per-conversation drafts that
survive a restart, user profiles and statuses, channel topics and member
management, per-channel notification preferences with mute, Do Not Disturb
snoozing, invites, LAN discovery, in-app hosting, and a browser client served
by the server itself.

Search covers every channel you can see, with modifiers:

```
from:@alice  in:#general  has:link  has:file  after:2026-01-01  before:2026-02-01
```

Modifiers combine with each other and with free text, and never widen what you
are allowed to see — naming a channel you are not in returns nothing.

Search hits, pins and saved items open the channel scrolled to that exact
message, with the surrounding history loaded around it. Every message has a
`slackoss://message?…` permalink, and `slackoss://` links open the desktop app
directly — an invite link lands on the join screen with the code filled in.

Messages can also be queued for later (🕘 in the composer) and reviewed or
called back from the Scheduled panel. The queue lives on the server, so a
message still goes out if the sender's app is closed, and one scheduled while
the server was down is sent the next time it starts.

### Huddles

Any channel or DM can start a huddle: live audio plus screen share, over
WebRTC. The server only relays the handshake — media goes peer to peer and
never touches it, so a self-hosted workspace stays private by construction.
Connections form a mesh, which suits the handful of people a small team puts
in a call; an SFU is the answer beyond that.

## Roadmap

- **Next**: video in huddles alongside screen share, an SFU for larger rooms,
  message forwarding, sidebar sections.
- **After**: a Slack-compatible integration API (incoming webhooks, slash
  commands, bot tokens, Block Kit rendering) so existing Slack apps port over,
  plus an admin console, optional Postgres and S3, and SSO.
