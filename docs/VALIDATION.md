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

|          |                                                                     |
| -------- | ------------------------------------------------------------------- |
| Host     | Windows 11 Pro 10.0.26200, Intel Core i5-12400F (6C/12T), 16 GB RAM |
| Node     | 24.16.0                                                             |
| Docker   | Engine 29.1.3, Linux containers                                     |
| Last run | 2026-09-06                                                          |

## Automated suites

| Suite                | Command                                   | Result                                                      | Last run   |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------- | ---------- |
| Types                | `pnpm exec turbo typecheck build --force` | 7 packages typechecked; all 10 typecheck/build tasks passed | 2026-09-08 |
| Unit and integration | `pnpm test`                               | 289 tests: server 203, client-core 58, ui 16, protocol 12   | 2026-09-12 |
| Browser end to end   | `pnpm test:e2e`                           | 7 scenarios, passed                                         | 2026-09-06 |
| Packaged Windows app | `pnpm test:desktop`                       | 1 scenario, passed                                          | 2026-09-05 |
| Container            | `node tests/docker-smoke.mjs`             | passed                                                      | 2026-09-05 |

The last combined verification including tests used `pnpm exec turbo test typecheck build --force`:
all 14 tasks passed without cached results, including the web, desktop and server CLI builds.

The September 7–8 feature phases were checked with typechecking and production builds only,
as requested by the user. Account controls, thread/search pagination, composer/editor changes,
scheduling controls, unread synchronization, Activity and history-loading changes have not yet
had their automated interaction/regression suites run. The September 9 thread-following work
mark-unread, channel-copied replies and mention-count work is the exception: it has thirty
permanent regressions across the server and client, so the totals above were re-measured on
that run rather than carried forward. Its browser layer was checked with a
disposable Playwright review, which is not part of the totals. The latest build completed with
existing Zod annotation warnings.
Splitting account/administration views reduced the main browser/desktop renderer from
roughly 502 kB to 477 kB before compression, removing the 500 kB chunk warning.

The last two rows were not re-run for the reliability work recorded in
`IMPROVEMENT-PLAN-2026-09.md`; their dates are the last run that did happen.
Packaging and the container image are unchanged by that work, but "unchanged
code" is an argument, not a measurement, so the dates say what they say.

### What the suites actually cover

Named so that a gap is visible as a gap, rather than hidden inside a total.

The core transaction phases add `packages/server/test/transactions.test.ts` (20
rollback/concurrency cases across registration, invitations, accounts, channels,
messages and apps) and `packages/server/test/fileCleanup.test.ts` (3 cases covering
attachment rollback, cleanup retry across restart, and session revocation during upload).

| File                                                          | What it holds to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/server/test/server.test.ts`                         | REST and socket behaviour of a live workspace: auth, channels, messages, threads, search, pins, huddle signalling, scheduling, admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/server/test/product.test.ts`                        | Self-hosted concerns: streamed uploads and size limits, bot-token boundaries, forward migration from a v8 database, owner protection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/server/test/reliability.test.ts`                    | Send idempotency and transaction rollback, page-size validation, session-scoped sign-out, expired sockets losing incoming/outgoing access, huddle seats following channel access, and scheduled delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/server/test/accounts.test.ts`                       | Owner claims behind forwarded headers, session-list privacy and revocation scope, password changes/reset permissions, authorization changes during hashing, and ownership transfer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/server/test/integrations.test.ts`                   | Slash commands, event subscriptions with signatures, interactivity, modals, and webhooks. Also durable outgoing delivery: retrying a refused endpoint without letting later events overtake it, re-signing each attempt over an unchanged body and event id, giving up on a dead endpoint together with its backlog, an administrator retrying that backlog in order, keeping retry to administrators, refusing to queue past the per-endpoint ceiling and reporting what was dropped, discarding queued events when the bot loses channel membership, and resuming an unfinished delivery after a restart. Also revocation while an app is being used: an app deleted or deactivated mid-request whose answer is dropped without the command appearing to fail, a response_url spent once its channel is archived, its bot is taken out of a private room, or its app is gone, a trigger refused for an archived room, and a form submitted after its room closed never reaching the app. |
| `packages/server/test/backup.test.ts`                         | Backup/restore round trip; missing blobs/inventory, unsafe paths, misleading schema metadata, overlapping directories, damaged bytes, and live writes during snapshot capture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/server/test/threads.test.ts`                        | Thread following: auto-follow on reply, respected unfollows, per-account read cursors and clamping, follower fanout, snapshot delivery, unread-only paging, deleted roots, lost channel access, marking a channel or thread unread, replies sent to the channel as well, and unread mention counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/client-core/test/workspace.test.ts`                 | Timeline paging and the bounded message cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/client-core/test/recovery.test.ts`                  | Reconnect replay, resync preserving drafts, live membership changes, durable outbox, and sends when the browser's secure-context randomUUID API is unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/server/test/storage.test.ts`                        | The workspace attachment cap: reporting usage, refusing an upload that would not fit without leaving a reservation or blob behind, freeing space on deletion, counting existing blobs after a restart, holding the limit against simultaneous uploads, releasing an oversized file's bytes, a cap lowered below what is stored, and rejecting a cap that is not a size. Also abandoned uploads: freeing one nobody sent, leaving a sent one and one a scheduled message still needs, declining to sweep when the scheduled queue cannot be read, reclaiming a blob left by a crash between writing and recording it, and refusing an expiry window of zero.                                                                                                                                                                                                                                                                                                                                |
| `packages/server/test/recovery.test.ts`                       | A password someone else chose closing the workspace over both REST and the socket until its owner replaces it, and host recovery: listing accounts, recovering an owner no admin can reset, handing the workspace over, reviving a deactivated account, and refusing an unknown handle or a directory that is not a workspace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/client-core/test/unread.test.ts`                    | Marking unread holding against the timeline's own acknowledgement, the hold lifting on leaving or an explicit read, surviving a resync, and rolling back when the server refuses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/client-core/test/{fileCache,huddle,notify}.test.ts` | Blob-cache lifetime and invalidation, huddle session state, and notification rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/ui/test/connection.test.ts`                         | Which reason a failed connection reports, and protocol-compatibility messages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/ui/test/mrkdwn.test.tsx`                            | Message rendering and escaping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/ui/test/deeplink.test.ts`                           | `slackoss://` link parsing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/e2e/web.spec.ts`                                       | Seven browser journeys, including served-browser onboarding, owner claim-code rejection/retry behind forwarded headers, real WebRTC, long-channel scrolling, and sign-out of an open app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Known gaps: no test drives the desktop hosting controls, and no component-level
interaction tests exist — the UI package renders to static markup only, so
anything requiring a click is covered end-to-end or not at all.

The two end-to-end suites drive real software, not mocks: `test:e2e` runs the
built browser client against a real server in headless Chromium, and
`test:desktop` launches the packaged `Gatherline.exe` through Electron.

## Gatherline frontend refresh

The capped-timeline browser scenario covers the redesigned production UI at 1280 × 820
and 390 × 844, including reduced-motion mode. It sends 315 additional live
messages to a channel, checks the DOM stays capped at 300 messages, and verifies
that the latest message remains in the viewport. It also checks disk-backed
draft persistence, dialog focus trapping/restoration, keyboard-accessible message
actions, IME composition, the send button, and narrow-window navigation.

In the final local run, 37 input events with the capped timeline loaded took
3.5 ms median, 12.5 ms p95, and 15 ms maximum to the next animation-frame callback.
This measures input-handler-to-rAF timing, **not** presentation latency or a
guaranteed frame rate. It excludes network delivery and is not a controlled
before/after benchmark; Windows packaging was running concurrently.

Unchanged message rows are memoized with stable callbacks, and draft persistence
has its own store subscriber instead of re-rendering the workspace shell.
Following the live tail now depends on the last message ID, not only the row
count, which stops a full 300-row timeline from losing its auto-scroll behavior.
Hidden message toolbars are laid out only on hover or keyboard focus. No UI
runtime dependencies, remote fonts, or animation libraries were added.

## Server under load, in a container

After building `slackoss:local`, `tests/docker-smoke.mjs` runs that image
as a non-root user under `--memory 256m --cpus 1`, and then:

- opens 20 WebSocket clients and posts 300 messages, timing each POST
- waits for all 6,000 deliveries (20 sockets x 300 messages) to arrive
- restarts the container and checks that the messages, the accounts and an
  accepted friendship are all still there

Measured 2026-09-06:

|                                       |                                |
| ------------------------------------- | ------------------------------ |
| Memory, idle                          | 36.29 MiB of the 256 MiB limit |
| Memory, after 6,000 deliveries        | 40.99 MiB                      |
| Message POST latency, median          | 7.25 ms                        |
| Message POST latency, 95th percentile | 11.27 ms                       |
| Deliveries lost                       | 0                              |
| Survived restart                      | yes                            |

Earlier runs on September 5 reported 32.8–36.6 MiB idle, 36.9–41.3 MiB
loaded, and 6.4–6.6 ms median. Results vary with other work on the machine.
These POST timings include the local Docker networking path, not a real LAN
or WAN. The sample demonstrates delivery and restart persistence under this
short workload; it does not establish sustained capacity or absence of leaks.

The history integration tests each seed hundreds of messages through real HTTP
requests. Their five-second default deadline was exceeded during concurrent
builds and browser tests. They now have a scoped 20-second deadline and always
dispose their clients, including after failures. In isolation, their measured
durations were approximately 1.5 and 1.2 seconds.

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
- a modal opens only for the person whose trigger it is, the trigger is spent
  after one use, and one app cannot open a form on another app's trigger
- a required field left empty, or a select answered with something that was
  never offered, is refused before the app is asked about it — an app is
  entitled to trust its own options
- the whole round trip again through the browser, twice: the button is drawn,
  pressing it calls the app and its `replace_original` reply rewrites the
  message; and a button opens the app's form, a refusal comes back attached to
  the field it belongs to, and the accepted answer reaches the app with the
  values that were typed

Taking someone's access away is checked for what it has to reach, not just the
flag it sets. The token already in their hands stops working, the WebSocket
they already had open is closed, signing in again is refused, a message they
had queued for later is held rather than posted in their name, and reactivating
restores all of it. A deactivated app goes quiet the same way: its bot token
and its webhooks both stop, without the app being deleted or its configuration
lost.

The rules about who may act on whom are tested from the losing side — an admin
cannot deactivate another admin or the owner, nobody can change their own
account, and a member cannot reach any of it. In the browser, the app a
deactivated person still has open drops back to the join screen on its own.

Schema upgrades are tested against real data, not only against a fresh
database: a workspace is created, wound back to the previous schema version
with its messages in place, and reopened, then read from and written to.

## Packaged desktop app

`pnpm test:desktop` launches the packaged EXE and checks that it boots with the
renderer sandbox on, hosts a workspace, serves the browser client from the same
process, starts and leaves a huddle, and shuts the hosted server down cleanly.

Process memory at that point, idle in a one-person hosted workspace
(`app.getAppMetrics()`, working set):

| Process        | KiB     |
| -------------- | ------- |
| Browser        | 140,652 |
| GPU            | 117,976 |
| Tab (renderer) | 115,808 |
| Utility        | 94,216  |
| Utility        | 56,124  |

These working sets total roughly 512 MiB after a one-person huddle in the hosted
workspace. Shared pages may be counted in multiple processes, so the sum is not
unique physical RAM consumption. This includes Electron, the renderer, media
services, and the embedded server; it does not isolate their incremental costs.
The desktop client has a substantially larger footprint than the standalone server.
This is not yet a demonstration of very-low-memory desktop voice calling.

Before the branding refresh, production renderer minification reduced JavaScript
from 1,000.67 kB to 428.63 kB. The Gatherline desktop renderer is now 437.95 kB of
JavaScript and 33.08 kB of CSS, including the new interface. Minification reduces shipped code size;
it does not by itself establish a frame-rate or RAM improvement. Docker build
contexts also exclude browser traces, test screenshots, and local agent metadata.

Artifacts:

|                        |                                                             |
| ---------------------- | ----------------------------------------------------------- |
| Installer              | 108 MiB (`apps/desktop/release/Gatherline Setup 0.1.0.exe`) |
| Installed              | 388 MiB unpacked                                            |
| Server container image | 56 MiB                                                      |

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
