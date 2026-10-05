# Tandem

[Explore the project atlas](docs/PROJECT-VISUALIZER.html): an offline, interactive
guide to every tracked file, the code's architecture and flows, implemented
improvements, measured optimizations and open findings. Download/open the HTML in
a browser, or run `pnpm visualizer:serve`. [Regeneration guide](docs/visualizer/README.md).

Your people. Your place. Your server. Previously named SlackOSS.

The product and Windows executable are now **Tandem**. Existing `@slackoss/*`
package names, `SLACKOSS_*` settings, data locations, application ID, Docker volume
names and `slackoss://` links are intentionally retained for compatibility. No data
migration is needed. The working name has not been trademark-cleared.

The interface follows the [chaicode.com look](https://ui.chaicode.com/) and
stays quiet: warm near-black Onyx and warm-paper White themes that follow the
device, chaicode orange reserved for what needs you, a pale-cream highlight
phrase, warm hairline cards, buttons with asymmetric corners, frosted menus and
a faint hexagon glow, bundled Manrope, Montserrat, Onest and Geist Mono type,
the conversation set as a card into the window, drawn line icons, menus split by
what they concern (the workspace's name, or your own), keyboard-accessible
controls, narrow-window navigation, and a capped live timeline that follows new
messages without growing indefinitely. See the
[UI and UX plan](docs/UX-PLAN-2026-10-05.md) and
[frontend checks and measurements](docs/VALIDATION.md#tandem-frontend-refresh).
To regenerate the checked-in desktop icons from the SVG, install Playwright's
Chromium and run `node scripts/generate-icons.mjs`. Normal packaging uses the
checked-in assets and does not need this step.

Early-stage, independently developed team chat under the [MIT license](LICENSE).
See [deployment and backups](docs/DEPLOYMENT.md), [validation results and limits](docs/VALIDATION.md),
[contributing](CONTRIBUTING.md), and [security](SECURITY.md). Not affiliated with Slack or Salesforce.

The [current implementation plan](docs/IMPLEMENTATION-PLAN-2026-10-01.md) orders the
17 reviewed issues and further improvements into scoped work with implementation status and acceptance checks.
The [September update backlog](docs/UPDATE-PLAN-2026-09-30.md) retains detailed tickets and implementation history.
The [optimization plan](docs/OPTIMIZATION-PLAN-2026-09-30.md) covers Electron, chat and server improvements researched from T3 Code and other applications.
The [2 October improvement plan](docs/IMPROVEMENT-PLAN-2026-10-02.md) reviews the current code and prioritizes remaining reliability, performance and delivery work with evidence and acceptance checks.
Its [deep investigation and reproducible evidence](docs/research/2026-10-02-deep/README.md) cover real failure paths, client lifecycle, desktop packaging/IPC, and measured optimization candidates.
The [3 October review](docs/IMPROVEMENT-PLAN-2026-10-03.md) checks the latest fixes and records further storage, shutdown, microphone and integration lifecycle improvements with fresh reproducible evidence.
The [4 October implementation](docs/IMPLEMENTATION-2026-10-04.md) addresses those twelve findings and records regression and integration validation.
The [UI and UX improvement plan](docs/UX-PLAN-2026-10-05.md) reviews the desktop app and browser client screen by screen and orders hierarchy, navigation, first-run, search, settings and phone work into phases with acceptance checks.

Open-source team chat that **you** host. Run the server on a VPS, or click
**"Host a workspace"** in the desktop app and serve your team straight from your
own PC — like opening a Minecraft world to LAN. Teammates on the same Wi-Fi
discover your workspace automatically; anyone else connects by `ip:port` or an
invite link. Every message, file, and account lives in a single folder on the
host's machine. Keep backups of that folder.

## Try it

Any of these gives you a workspace at `http://localhost:8543`. From a clone, with
Node 24+ and pnpm 10:

- **In a browser**, served by the standalone server:

  ```sh
  pnpm install
  pnpm build
  node apps/server-cli/dist/slackoss-server.js --data ./demo-data --name "Demo Team"
  ```

- **In the desktop app** on Windows: `pnpm --filter @slackoss/desktop package --win`,
  install `apps/desktop/release/Tandem Setup 0.1.0.exe`, and choose
  **Host a workspace on this computer**.
- **With Docker**: `docker compose -f docker/docker-compose.yml up -d --build`.

A new workspace is empty. To have a team to look at, run this in another
terminal before anyone signs up:

```sh
node scripts/seed-demo.mjs
```

It adds four people, `maya` (the owner), `sam`, `priya` and `alex`, who share the
password it prints, with channels, a thread, reactions, a mention, a pinned
checklist, an image, statuses and a direct message. It leaves a workspace that
already has accounts alone. Give it another address as its first argument, your
own `--password`, and, from another computer, the `--claim-code` the server printed.
Because the accounts share a password, keep them out of a workspace other people
can reach.

Then open `http://localhost:8543`, sign in as `maya`, and try:

- [ ] Reply to Sam's direct message, and find alex's mention of you in **Activity**.
- [ ] In #design, open the thread on Priya's mockup, reply, react, and click the image to see it full size.
- [ ] Find the pinned checklist in #engineering with the pin button in the channel header.
- [ ] Press **Ctrl+K** to jump to a channel or a person, and **Search** for `checklist`.
- [ ] Choose **Send later** beside Send, then find the message under **Scheduled**.
- [ ] Sign in as `sam` in a private window, message each other, and start a **Huddle** from both.
- [ ] Open **Workspace → Invite people** for a link that opens in any browser.
- [ ] As the owner, change someone's role in **Workspace → People**, or add an incoming webhook in **Apps and integrations**.
- [ ] Narrow the window to a phone's width and keep chatting.

## How people join

- **Same network** — the desktop app's Join screen lists every workspace
  advertising on the LAN (mDNS). One click to join.
- **Direct connect** — type `192.168.1.42:8543` or `chat.yourteam.dev`.
- **Invite links** — `http://host:8543/#/join/<code>` opens the workspace in any
  browser with the invite code filled in. The desktop app has its own form of the
  same link, `tandem://join?host=...&code=...` (older `slackoss://` links
  still open).
- **No app?** — the server also serves a full browser client at `http://host:8543/`.

The first account created on a fresh server becomes its **owner**.

## Hosting a server

### From the desktop app

Join screen → _Host a workspace on this computer_ → name it → done. The same
server code runs inside the app; the workspace folder can later be moved to a
VPS unchanged.

To share that workspace outside your network without changing router settings,
install Cloudflare's `cloudflared`, create the owner account, then open
**Manage hosting → Open to all**. Tandem starts a temporary Cloudflare Quick
Tunnel and shows an HTTPS address. Leave **Require an invite link to create an
account** selected (the default), then use
**Workspace → Invite people** to generate and copy a browser invite link. Send
that link to the people you want to join.

The host opens the tunnel before sending the link. A visitor's click reaches the
already-running tunnel; it does not start one on the visitor's computer. Keep
Tandem running until everyone is finished. Closing the public link, stopping
hosting, or quitting invalidates the temporary address. See the
[Cloudflare Tunnel setup and commands](docs/DEPLOYMENT.md#temporary-internet-sharing-with-cloudflare-tunnel).

For an address that does not change, put one you already have under **Your own
address** in Manage hosting: a Tailscale Funnel, a reverse proxy, or any tunnel
of your own that forwards HTTP and WebSockets to the port shown there. **Open to
all** verifies that it reaches this workspace and uses it in new links.
Tandem does not start or stop that outside connector, so **Close public
link** does not take the address off the internet; stop the Funnel, proxy, or
tunnel yourself, or stop hosting. Existing invite links keep the same address,
but their codes still expire or run out of uses normally. See
[Use an address you already have](docs/DEPLOYMENT.md#use-an-address-you-already-have).

If you own a domain on Cloudflare, Tandem can run a remotely managed
Cloudflare connector for you instead. See
[A stable address Tandem runs for you](docs/DEPLOYMENT.md#a-stable-address-tandem-runs-for-you).

### Standalone (VPS, spare machine)

```sh
node slackoss-server.js --data ./data --name "My Team" --invite-only
```

Requires Node 24+. The bundled file has zero dependencies — the database is
Node's built-in SQLite. Flags: `--port`, `--host`, `--no-mdns`, `--web <dir>`,
`--invite-only`, `--access-policy` (`guest_allowed` lets people join with a
display name alone), `--public-url`, `--allow-private-hooks`.

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
snoozing, invites, LAN discovery, in-app hosting, member administration, and a
browser client served by the server itself.

Search covers every channel you can see, with modifiers:

```
from:@alice  in:#general  has:link  has:file  type:pdf  after:2026-01-01  before:2026-02-01
```

Free text finds what messages say and the names of files attached to them, so
`budget` finds `Q3 Budget.xlsx`. `type:` asks for one kind of file: `image`,
`video`, `audio`, `pdf`, `document`, `spreadsheet`, `presentation` or
`archive`. Modifiers combine with each other and with free text, and never
widen what you are allowed to see — naming a channel you are not in returns
nothing.

Search hits, pins and saved items open the channel scrolled to that exact
message, with the surrounding history loaded around it. Every message has a
link, `http://host:8543/#/c/<channel>/m/<message>`, that opens it in a browser,
waits through signing in if it has to, and opens it in place when clicked inside
a message. `tandem://` links open the desktop app directly — an invite link
lands on the join screen with the code filled in. Older `slackoss://` links
open the same way.

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
`auth.test` and `views.open` are there too. Slack's own Web API SDK is tested
against this server — its form-encoded calls, its error handling, and the
`auth.test` call Bolt makes before it will start. [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) is the full
contract — every supported method and field, each event and what it becomes,
and each place this server differs from Slack.
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
  which is the loop every chat integration otherwise causes. Delivery is queued
  with the event, retried in order after failures or restarts, and reported in
  Apps and integrations. Receivers should deduplicate by `event_id` because a
  crash after their HTTP success can cause the same event to arrive again.

- **Interactive buttons.** Give the app an interactivity request URL and its
  buttons become live. A press posts Slack's `block_actions` payload — the
  pressed `action_id` and `value`, who pressed it, where, and a `response_url`
  — and the reply is rendered. Answering `replace_original` rewrites the
  message the button sits on and takes the buttons with it, which is how
  _Approve_ becomes _Approved, shipping 412_; `delete_original` removes it.
  Anything else answers privately to whoever pressed, or in the channel with
  `response_type: "in_channel"`.

  A button's `url` is ignored unless it is `http(s)` — a message is not a way
  to hand someone a `javascript:` link to click.

- **Modals.** A button press (or a slash command) hands the app a
  `trigger_id`; `views.open` turns that into a form in front of the person who
  pressed it, and nobody else. Submitting posts Slack's `view_submission` with
  `view.state.values`, `callback_id` and `private_metadata`, and an app can
  answer `response_action: "errors"` to send them back to a field with a
  reason. A trigger opens one form, expires in three minutes, and belongs to
  the app it was issued to.

  Forms carry plain-text inputs and static selects. A date picker or a
  multi-select is dropped rather than drawn as a control that does nothing, and
  a view left with no fields at all is refused outright — a form that silently
  lost half its questions is worse than no form.

Everything an app receives is signed like Slack's: `v0=HMAC-SHA256(v0:timestamp:body)` under the
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

## Running the workspace

**People** in the sidebar (owner and admins) lists everyone with an account,
what they can do, and when they were last seen. Someone who leaves is
**deactivated**: their sessions are revoked, the app they already have open is
disconnected and drops back to the join screen, and they cannot sign in again.
Their messages stay where they are, because the rest of the conversation still
needs them, but anything they had queued to send later is held rather than
posted in the name of someone who no longer has access. Reactivating undoes all
of it. Apps are in the same list: deactivating one silences its token and its
webhooks without deleting the app or losing its configuration.

Roles are deliberately blunt. An admin can promote and remove members; only the
owner can change another admin, the owner's own account cannot be touched, and
nobody can change their own — so a workspace cannot be lost to an argument
between two admins, or to a misclick.

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
you configure a signing certificate. CI checks cover the server, browser, Docker,
and Windows app. See [CI duration and caching](docs/CI.md) for the build reuse,
installer selection and measured baseline; optimized remote timings remain to be measured.

File transfers stream through the server, a channel keeps a bounded window of
messages in memory however far back you scroll, idle attachment blobs are
evicted, and password derivations run off the main event loop with bounded
concurrency. See
[measured results](docs/VALIDATION.md) for the workload and remaining performance limits.

## Roadmap

- **Next**: the rest of Block Kit's inputs — date pickers, multi-selects,
  checkboxes — and `views.update` so a form can change as it is filled in.
- **Later**: an SFU for larger huddles, message forwarding, sidebar sections,
  optional Postgres and S3, and SSO.
