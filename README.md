# SlackOSS

Early-stage, independently developed team chat under the [MIT license](LICENSE).
See [deployment and backups](docs/DEPLOYMENT.md), [validation results and limits](docs/VALIDATION.md),
[contributing](CONTRIBUTING.md), and [security](SECURITY.md). Not affiliated with Slack or Salesforce.

Open-source team chat that **you** host. Run the server on a VPS, or click
**"Host a workspace"** in the desktop app and serve your team straight from your
own PC — like opening a Minecraft world to LAN. Teammates on the same Wi-Fi
discover your workspace automatically; anyone else connects by `ip:port` or an
invite link. Every message, file, and account lives in a single folder on the
host's machine. Keep backups of that folder.

## How people join

- **Same network** — the desktop app's Join screen lists every workspace
  advertising on the LAN (mDNS). One click to join.
- **Direct connect** — type `192.168.1.42:8543` or `chat.yourteam.dev`.
- **Invite links** — `slackoss://join?host=...&code=...` open the app pre-filled.
- **No app?** — the server also serves a full browser client at `http://host:8543/`.

The first account created on a fresh server becomes its **owner**.

## Hosting a server

### From the desktop app

Join screen → _Host a workspace on this computer_ → name it → done. The same
server code runs inside the app; the workspace folder can later be moved to a
VPS unchanged.

### Standalone (VPS, spare machine)

```sh
node slackoss-server.js --data ./data --name "My Team" --invite-only
```

Requires Node 24+. The bundled file has zero dependencies — the database is
Node's built-in SQLite. Flags: `--port`, `--host`, `--no-mdns`, `--web <dir>`,
`--invite-only`, `--public-url`, `--allow-private-hooks`.

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

| package                | what it is                                                |
| ---------------------- | --------------------------------------------------------- |
| `packages/protocol`    | Shared types: entities, WS events, REST schemas (zod)     |
| `packages/server`      | Workspace server — Fastify + ws + `node:sqlite`, pure JS  |
| `packages/client-core` | Client SDK: REST + resilient WS + local replica (zustand) |
| `packages/ui`          | React UI shared by desktop and web                        |
| `apps/desktop`         | Electron app (electron-vite, React 19, Tailwind 4)        |
| `apps/web`             | Browser client, served by the server itself               |
| `apps/server-cli`      | Bundles the server into one runnable file                 |

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

Any channel or DM can start a huddle: live audio, camera video, and screen
share. The chat server relays the handshake. Media goes directly between peers
or through your configured TURN relay when a direct connection is unavailable.
Connections form a mesh for small calls; larger meetings need an SFU.
LAN-only media is the default. See the deployment guide for STUN/TURN configuration
and HTTPS requirements for browser microphone access.

The offerer creates three media slots: microphone, camera, and screen. The answerer
adopts those slots from the offer. Creating slots independently on both ends can
produce duplicate transceivers and one-way audio in Chromium. Camera and screen
changes reuse the negotiated slots without a new offer. Real-browser tests check
audio packets in both directions and decoded camera frames.

Everyone in the call gets a tile, camera or not, in a grid that keeps its shape
and its height as people arrive — a share takes the stage and the others move to
a strip beside it. A green ring says who is talking, read from the audio level
the browser already parses out of each incoming packet rather than from a Web
Audio graph per participant, which is the version you would feel in a
six-person call. Muting is signalled to the others, so a quiet person and a
muted one do not look the same.

What a peer is _actually_ sending is stated explicitly over the same signalling
channel, not inferred from the connection: a receiver's track reports itself
unmuted once the transport is up, whether or not a frame has ever arrived
(measured in Chrome — a silent slot showed an unmuted track and 0 bytes). Left
to that, everyone would show a black rectangle for a camera nobody switched on.

### Slack-compatible integrations

Admins create apps under _Apps and integrations_. Each gets a bot user, a
`xoxb-` token and any number of incoming webhooks. Both speak Slack's shapes,
so most existing integrations work by changing the URL:

```sh
# Incoming webhook — text, Block Kit, or legacy payload=<json> form posts
curl -X POST http://your-server:8543/hooks/<token>   -H 'content-type: application/json'   -d '{"text":"build 412 is green"}'

# Web API
curl -X POST http://your-server:8543/api/chat.postMessage   -H "authorization: Bearer xoxb-..." -H 'content-type: application/json'   -d '{"channel":"#general","text":"deploy finished"}'
```

`chat.postMessage` accepts a channel id or `#name`, supports `thread_ts`, and
replies with Slack's `{ok, channel, ts}` — or `{ok:false, error}` on failure.
Block Kit payloads are flattened to text rather than rejected, so a message
written for Slack still reads sensibly, and the **buttons** in an `actions`
block are drawn as buttons.

Apps can also **answer** rather than only post:

- **Slash commands.** Register `/deploy` against a URL. Typing it posts Slack's
  form body — `command`, `text`, `channel_id`, `user_id`, `response_url`,
  `trigger_id` — and renders the reply. `response_type: "in_channel"` posts to
  everyone; anything else stays private to whoever typed it. The
  `response_url` accepts late replies for 30 minutes and five uses, so a slow
  job can answer when it finishes. `/shrug` and `/me` are built in.
- **Event subscriptions.** Point a URL at the workspace and matching events
  arrive as `{type: "event_callback", event: {…}}`, with our own event
  alongside Slack's shape. The URL has to echo an `url_verification`
  challenge before it is accepted, an app only receives events from channels
  its bot has been added to, and an app is never sent its own bot's actions —
  which is the loop every chat integration otherwise causes.

- **Interactive buttons.** Give the app an interactivity request URL and its
  buttons become live. A press posts Slack's `block_actions` payload — the
  pressed `action_id` and `value`, who pressed it, where, and a `response_url`
  — and the reply is rendered. Answering `replace_original` rewrites the
  message the button sits on and takes the buttons with it, which is how
  _Approve_ becomes _Approved, shipping 412_; `delete_original` removes it.
  Anything else answers privately to whoever pressed, or in the channel with
  `response_type: "in_channel"`.

  Only buttons are drawn so far. Selects, date pickers and modals are dropped
  rather than shown as controls that do nothing, and a button's `url` is
  ignored unless it is `http(s)` — a message is not a way to hand someone a
  `javascript:` link to click.

Both are signed like Slack's: `v0=HMAC-SHA256(v0:timestamp:body)` under the
app's signing secret, sent as `x-slack-signature` **and** `x-slackoss-signature`,
so a verifier written for Slack works unchanged.

### A note on outbound requests

These two features make the _server_ call an address an admin typed, and that
server usually sits inside the same network as a router page, a NAS, or a cloud
metadata endpoint. So every address is checked against the private ranges before
connecting, and the check runs inside the socket's own DNS lookup — a name that
resolves public once and private a moment later (DNS rebinding) still cannot get
through. Redirects are not followed, since a redirect is exactly how a vetted
host would hand us a private one.

LAN-hosted bots are a reasonable thing to want here, so this is a default rather
than a rule: `--allow-private-hooks` turns it off.

## Friends

Open **Friends** in the sidebar to find workspace members, send requests, accept
or decline invitations, and view friends' presence. Profiles also have an Add friend
action. Relationships persist on this server and are visible only to their participants.
Accounts and friends are not shared across unrelated workspace servers.

## Windows installer and validation

```sh
pnpm --filter @slackoss/desktop package --win
pnpm test:desktop
pnpm build
pnpm test:e2e
```

The EXE is written to `apps/desktop/release/`. Local builds are unsigned unless
you configure a signing certificate. CI configuration is included for server,
browser, Docker, and Windows checks; it has not been run on GitHub in this workspace.

File transfers stream through the server, a channel keeps a bounded window of
messages in memory however far back you scroll, idle attachment blobs are
evicted, and password derivations run off the main event loop with bounded
concurrency. See
[measured results](docs/VALIDATION.md) for the workload and remaining performance limits.

## Roadmap

- **Next**: the rest of interactive Block Kit — modals, selects and date
  pickers, so a button can open a form rather than only report a result.
- **Later**: an SFU for larger huddles, message forwarding, sidebar sections,
  a fuller admin console, optional Postgres and S3, and SSO.
