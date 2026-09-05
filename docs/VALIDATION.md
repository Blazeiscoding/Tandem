# Validation results and limits

What has actually been run, on what, and with what result. Everything below is a
measurement from one developer machine, not a capacity claim: nothing here has
been run against a real team, a real network, or a VPS under sustained load.

Re-run everything with:

```sh
pnpm typecheck && pnpm test
pnpm build && pnpm test:e2e
pnpm --filter @slackoss/desktop package --win && pnpm test:desktop
docker build -f docker/Dockerfile -t slackoss:local . && node tests/docker-smoke.mjs
```

## Machine and versions

| | |
| --- | --- |
| Host | Windows 11 Pro 10.0.26200, Intel Core i5-12400F (6C/12T), 16 GB RAM |
| Node | 24.16.0 |
| Docker | Engine 29.1.3, Linux containers |
| Last run | 2026-09-05 |

## Automated suites

| Suite | Command | Result |
| --- | --- | --- |
| Types | `pnpm typecheck` | 8 packages, clean |
| Unit and integration | `pnpm test` | 123 tests: server 65, client-core 37, ui 9, protocol 12 |
| Browser end to end | `pnpm test:e2e` | 3 scenarios, passed |
| Packaged Windows app | `pnpm test:desktop` | 1 scenario, passed |
| Container | `node tests/docker-smoke.mjs` | passed |

The two end-to-end suites drive real software, not mocks: `test:e2e` runs the
built browser client against a real server in headless Chromium, and
`test:desktop` launches the packaged `SlackOSS.exe` through Electron.

## Server under load, in a container

`tests/docker-smoke.mjs` builds the single-file server into the published image,
runs it as a non-root user under `--memory 256m --cpus 1`, and then:

- opens 20 WebSocket clients and posts 300 messages, timing each POST
- waits for all 6,000 deliveries (20 sockets x 300 messages) to arrive
- restarts the container and checks that the messages, the accounts and an
  accepted friendship are all still there

Measured 2026-09-05:

| | |
| --- | --- |
| Memory, idle | 32.8 MiB of the 256 MiB limit |
| Memory, after 6,000 deliveries | 37.2 MiB |
| Message POST latency, median | 6.5 ms |
| Message POST latency, 95th percentile | 9.8 ms |
| Deliveries lost | 0 |
| Survived restart | yes |

Three runs the same day landed between 32.8 and 36.6 MiB idle, 36.9 and 41.3
MiB loaded, and 6.4 to 6.6 ms median, so read these as tens of MiB and
single-digit milliseconds rather than exact figures. A fourth run taken while
the machine was busy packaging the desktop app doubled the latency, which says
more about the laptop than the server. Latency is loopback on the host and
excludes network time; a LAN or WAN adds its own. What the numbers are for is
the server's own cost per message, and the fact that memory does not climb with
traffic.

## Real media, not a mock

The browser scenario intercepts `RTCPeerConnection`, opens a huddle between two
independent browser contexts, and asserts against `getStats()`:

- both peers reach `connectionState === "connected"`
- both peers report `inbound-rtp` audio `bytesReceived > 0`, so audio is
  travelling **in both directions** rather than one
- after the camera is switched on, the other side's `<video>` reports
  `videoWidth > 0`, so a frame was actually decoded
- both sides show the other as talking, from the level in the incoming packets
  — the fake capture device plays a tone, so there is something real to read
- muting one side puts a muted badge on the other side's copy of them, since
  that state is signalled rather than guessed
- after both leave, every peer connection reaches `closed`
- no uncaught page errors throughout

The two-way audio assertion exists because it caught a real bug: the answering
peer created its own media slots instead of adopting the offer's, producing
duplicate transceivers and audio that flowed only one way while the UI showed
"connected". Chromium also reports a receiver's track as unmuted once the
transport is up even when no frame has ever arrived, so what a peer is sending
is stated explicitly over signalling rather than inferred.

## Integrations, end to end

The integration tests run a real HTTP server standing in for the third-party
app, so a slash command, an event subscription and a button press are all
delivered over a socket rather than mocked. What is checked, beyond the happy
path:

- the `block_actions` payload's signature matches an HMAC computed
  independently in the test, under both `x-slack-signature` and
  `x-slackoss-signature`
- a button on a message in a private channel is a 404 to someone outside it,
  and nothing is sent onward on their behalf
- an interactivity URL that will not echo the verification challenge is
  refused, so this server cannot be aimed at an unrelated host
- a `javascript:` URL on a button is dropped rather than rendered as a link
- the whole round trip again through the browser: the button is drawn, pressing
  it calls the app, and the app's `replace_original` reply rewrites the message
  and removes the button

Schema upgrades are tested against real data, not only against a fresh
database: a workspace is created, wound back to the previous schema version
with its messages in place, and reopened, then read from and written to.

## Packaged desktop app

`pnpm test:desktop` launches the packaged EXE and checks that it boots with the
renderer sandbox on, hosts a workspace, serves the browser client from the same
process, starts and leaves a huddle, and shuts the hosted server down cleanly.

Process memory at that point, idle in a one-person hosted workspace
(`app.getAppMetrics()`, working set):

| Process | KiB |
| --- | --- |
| Browser | 137,888 |
| GPU | 111,992 |
| Tab (renderer) | 111,988 |
| Utility | 93,216 |
| Utility | 55,632 |

That is Electron's baseline, and it is the honest cost of shipping a Chromium
app. The GPU and utility processes are the runtime's, not ours. Hosting a
workspace inside the app adds the server measured above, tens of MiB, not
hundreds.

Artifacts:

| | |
| --- | --- |
| Installer | 108 MiB (`apps/desktop/release/SlackOSS Setup 0.1.0.exe`) |
| Installed | 388 MiB unpacked |
| Server container image | 56 MiB |

## Memory work behind those numbers

- **File transfers stream.** Uploads pipe from the multipart request straight to
  disk and downloads pipe from a file handle, so neither holds a whole file in
  memory. Only the first 64 KiB is retained, to read image dimensions. A
  transfer that trips the size limit has its partial blob deleted rather than
  left behind; `product.test.ts` checks the file is gone.
- **Password hashing is bounded and off the event loop.** scrypt is
  deliberately memory-hard, so unbounded concurrent logins are a memory attack.
  At most two derivations run at once and the rest get `429`, which keeps chat
  and huddles responsive while someone is logging in.
- **The timeline keeps a bounded window.** A channel holds at most 300 messages
  in memory, and therefore at most 300 rows in the DOM. Paging up drops the far
  end and marks it pageable again, so scrolling back through a year of history
  costs the same as opening the channel. The end that is dropped is hundreds of
  messages outside the viewport, and the message the reader is looking at is
  held still across the swap by anchoring on its row rather than on a
  `scrollHeight` delta, which cannot tell content added above from content
  removed below. Checked in a real browser: after six pages the DOM holds 300
  rows, not 350, and the anchored message moves by under 8 px.
- **Idle attachment blobs are evicted.** The client file cache retains a blob
  while an attachment is mounted and drops the least recently used unreferenced
  ones once idle blobs exceed 32 MiB, so scrolling back through a channel full
  of images does not accumulate object URLs for the life of the session.

## Known limits

- **Huddles are a mesh.** Every participant sends to every other participant, so
  upstream bandwidth grows with the call. Fine for a handful of people; a larger
  meeting needs an SFU, which does not exist yet. The grid has been looked at
  with five people in one call, four of them on camera, which is where the
  layout was fixed; nobody has run a call bigger than that.
- **The numbers above are one machine, one run.** No soak test, no many-user
  test, no measurement over a real network or a VPS.
- **Media requires HTTPS off localhost.** Browsers will not grant microphone
  access to a plain-HTTP origin that is not localhost, so a LAN deployment
  reached by IP needs a certificate for browser huddles. The desktop app is not
  affected.
- **Not a security audit.** Outbound webhook and event URLs are checked against
  private ranges inside the socket's own DNS lookup, and redirects are not
  followed. That addresses SSRF specifically; nobody has reviewed the whole
  surface.
- **Windows builds are unsigned** unless you supply a certificate, so SmartScreen
  will warn.
- **CI is configured but unverified.** `.github/workflows/ci.yml` runs these same
  checks on Linux and Windows runners; it has not been run on GitHub from this
  workspace.
