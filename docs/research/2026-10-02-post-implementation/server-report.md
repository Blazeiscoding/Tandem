# Current server implementation audit

Source: `f07ce84362257aedeab16c9ae4c2361193eb6442`, unchanged between the diagnostic runs. Runtime: Node v24.16.0, Windows. These findings use synthetic disposable workspaces, real SQLite, actual HTTP/native WebSocket transport and unaltered production timers. They contain no latency benchmark claims; the repository baseline was running separately.

Reproduce all cases from the repository root:

```powershell
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-post-implementation/server-probes.mts
```

Rerun one case with `--only retry_retention` (or another mode below). A selected rerun updates its record only if the stored source revision matches. [server-probes.mts](server-probes.mts) bounds child processes, hides their Windows windows, captures raw exit/output evidence and verifies the resolved absolute temporary root and ownership marker before recursive cleanup. [server-results.json](server-results.json) contains all 11 successful diagnostic assertions. For the three intentional process failures, success means observing the expected uncaught failure and nonzero child exit, **not** successful server behavior. An initial positive-control route typo was corrected and only that case rerun; its failed harness evidence is preserved under `harnessCorrections` and is not a product finding.

## Existing plan closure

The original server fixes are present. The new boundaries below do not reproduce the historical bugs and should receive their own acceptance cases.

| Item   | Current code and existing tests inspected                                                                                                                                                                                                                                               | Acceptance exercised by this audit                                                                                                                                                                                                                                                                                                                           | Limits of this audit's independent acceptance                                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REV-01 | `server.ts:641`, `server.ts:4244`, `server.ts:4290`: contained queue startup/timer/immediate entry points. `backgroundQueues.test.ts:66` covers scheduled fake intervals and recovery; `:98` covers real immediate continuation; `:150` uses a real delivery-timer child.               | `delivery_queue_recovery`: a real 5-second timer's injected read failure leaves one delivery pending, HTTP health remains 200, admin status reports the queue; the next native tick delivers it to real loopback HTTP and clears the failure status.                                                                                                         | The fresh probe exercises the delivery interval; it does not independently run a native 15-second scheduled recovery or every startup branch. Gateway callbacks are a separate uncovered boundary below.                                                                   |
| REV-02 | Schema v35 in `db.ts:523`; eligible-page/backoff ledger in `store.ts:1574`; draining continuation in `server.ts:1066`. `fileCleanup.test.ts:91`, `:132`, `:155`, `:163` cover restart, fairness, rejected IDs and 1,000 removals.                                                       | `current_closures`: 100 real directories make unlink fail; a real uploaded blob behind them is removed. All 100 failures are marked retrying, with no waiting entry left.                                                                                                                                                                                    | Fresh probe does not independently restart this fixture or drain 1,000 blobs; those are existing test coverage.                                                                                                                                                            |
| REV-06 | `server.ts:597`, `:695` deduplicate connected-account recounts; `gateway.ts:469` scopes authorization to each fanout. Existing public publication counts in `publicationCost.test.ts:110–149`, session/privacy checks in `sessionAuthorization.test.ts:103–155`.                        | `current_closures`: 21-message deletion attempts one recount for one connected reader; two devices of one session receive an ordinary private message with one authorization lookup. `private_publication_counts` confirms two readers require exactly two recounts, all deletion frames arrive, and public offline deletion has zero member reads/recounts. | Does not independently exercise every direct/room-wide mention, expiry/revocation or outsider case. Private audience reconstruction still has duplicated work, measured below.                                                                                             |
| REV-10 | `server.ts:663`, `:679`, `:707` contain committed effects, publish every durable frame and resynchronize after failed durable fanout. `committedPublication.test.ts:118`, `:143`; actual client reconnect in `client-core/test/history.test.ts:325`.                                    | `current_closures`: injected recount exception after a committed 21-message delete still answers 200; all 21 durable deletion frames reach the real connected reader; the socket stays open.                                                                                                                                                                 | Fresh probe does not inject a durable frame failure; existing tests cover that branch. Access-change effect failure has a separate cache recovery gap below.                                                                                                               |
| REV-15 | Schema v36 `db.ts:539`; 500 active/1,000 failed limits, retry intent/promotion in `store.ts:2734`, `:2933`; independent pump in `server.ts:891`. `deliveryRetry.test.ts:91–154` covers capacity/history/drain; `deliveryPump.test.ts:105–165` covers independence/concurrency/shutdown. | `retry_order` confirms accepted retry intent stays behind the 500 active-row limit and uses actual outbound HTTP. `retry_retention` confirms a full queue retains accepted retry intent initially. Native recovery case exercises real outbound completion.                                                                                                  | No fresh complete 1,500-event drain, ten-out concurrency stress or held-endpoint fairness benchmark here. Existing tests cover them. Retention can subsequently delete accepted intent; complete sequence order is scoped more narrowly than a broad “in order” statement. |

All production source references above and below are relative to `packages/server/src/`; test references are relative to `packages/server/test/` unless explicitly qualified.

## New findings and next work

### S1 — P1: socket and heartbeat database exceptions still terminate the server

`gateway.ts:188` catches parsing exceptions only. The session check at `:268` and hello/snapshot reads at `:214–255` execute outside that catch. The native 30-second interval at `:56–67` also performs uncaught session reads (`:476`). These callbacks bypass Fastify's HTTP error handling and the fixed server queue runner.

Evidence: [server-gateway_message_failure.log](server-gateway_message_failure.log), [server-gateway_sqlite_message_failure.log](server-gateway_sqlite_message_failure.log), [server-gateway_heartbeat_failure.log](server-gateway_heartbeat_failure.log). All three children exit 1. The WebSocket cases send a real authenticated ping; the stronger variant leaves Store methods untouched and uses SQLite's authorizer to deny reads of `sessions`, producing `access to sessions.token_hash is prohibited` in `Store.isSessionActive`, then the native WebSocket callback. The heartbeat case reaches the unaltered native interval. The [healthy heartbeat control](server-gateway_heartbeat_control.log) survives the same interval and answers health 200.

The faults are deliberately injected; this establishes exception propagation and process impact, not a frequency estimate for natural disk/database failure or an unauthenticated exploit.

Implementation: contain the complete Gateway message, heartbeat and disconnect callback boundaries; refuse delivery when permission reads fail, preserve consistent in-memory registration, log/report the failure and close affected sockets so they can reconnect. Review close/unregister broadcasts too (`gateway.ts:305`, `:328`), since merely enclosing message parsing does not cover them. Complexity: medium.

Acceptance: real-process WebSocket and native heartbeat failures leave health 200; no authorization-dependent frame is sent during an unreadable session state; after the fault clears, a new connection authenticates normally. Preserve prompt session revocation and add a close-callback failure case.

### S2 — P1: accepted retries awaiting capacity can expire silently

`store.ts:2988` marks old failed rows `retry_requested=1`, leaving their original `failed_at`. Hourly maintenance calls `pruneEventDeliveries` with a seven-day cutoff (`server.ts:4324–4325`); its SQL at `store.ts:2972` deletes every expired failed row, including those the administrator just asked to retry.

Evidence: [server-retry_retention.log](server-retry_retention.log). A real retry HTTP request accepts 1,000 historical failed rows behind 500 active rows and answers `{retried:1000, waiting:1000}`. Calling the unchanged hourly Store operation with the production cutoff removes all 1,000 requested retries: pending stays 500, retrying becomes zero and dropped remains zero. The fresh-failure control retains its 500 requested rows. The fixture's old failures model a workspace restarted after an outage; the same predicate applies when a requested retry crosses its original expiration while waiting.

Implementation: make requested retry intent survive terminal-history pruning, or give it an explicit renewed expiration/cancellation policy with accurate administrator counts. Keep unrequested terminal-history expiration and the 500 active-row cap. Complexity: small to medium.

Acceptance: request a retry near its original seven-day deadline into a full queue, run the exact maintenance operation across that deadline and restart; the accepted intent remains and subsequently drains once, or is explicitly cancelled and counted under a documented policy. Unrequested expired failures still prune.

### S3 — P2: failed access effects leave revoked private-channel caches visible until reconnect

Membership removal commits before `gateway.updateChannelAccess` (`server.ts:1883–1888`). That method first reads memberships (`gateway.ts:414–415`). `afterCommitted` logs a failure but supplies no recovery (`server.ts:663–668`, `:724`). The removed reader is absent from the private event audience (`gateway.ts:437–449`), so its durable `member.left` cannot replace the missed `channel.access` notification. Client cache removal depends on that notification (`client-core/src/workspace.ts:1375`) or the next ready snapshot (`:840`).

Evidence: [server-revocation_effect.log](server-revocation_effect.log). One membership-read exception during the committed access effect: removal answers 200; subsequent private history returns 404; the actual WorkspaceClient remains online, receives a later global event and still has the private channel, membership and previously delivered text cached. Explicit server resynchronization makes its normal reconnect remove the channel and timeline.

This is a missed revocation/cache notification, not new server access or newly leaked private data. Implementation: distinguish access effects from replaceable count/follow effects and reconnect the affected user's devices if access-state publication fails; alternatively persist/retry a targeted access refresh. Complexity: medium.

Acceptance: the same failure after private removal/invitation triggers bounded automatic recovery, clears revoked channel/history/drafts and retains correct access for other users. The committed HTTP result remains successful.

### S4 — P2 optimization: private batch publication repeats full audience reads, including offline

`server.ts:682–684` calls `Gateway.publish` separately for every committed event. Each private publish reads the complete audience again (`gateway.ts:437–449`) before discovering which members have sockets. Mention recipient deduplication at `server.ts:695–704` does not share this audience.

Evidence: [server-private_publication_counts.log](server-private_publication_counts.log), using actual HTTP deletions, delegating counters and a public-channel control:

| 50-member channel, 21-message deletion | Member-list reads | Member IDs materialized | Mention recounts |
| -------------------------------------- | ----------------: | ----------------------: | ---------------: |
| Private, no connected members          |                21 |                   1,050 |                0 |
| Public, no connected members (control) |                 0 |                       0 |                0 |
| Private, two connected readers         |                22 |                   1,100 |                2 |

Both connected readers receive all 21 deletion frames. This extends the verified public-channel improvement to private batches; it does not contradict that public control.

Implementation: avoid audience reconstruction with no authenticated recipients, then reuse the committed private-channel audience across a synchronous publication batch. Keep the audience lifetime bounded to that batch and preserve each frame, current membership checks and session revocation. Complexity: small to medium.

Acceptance: private offline batch has zero audience reads; private connected batch has one shared member-list read for the channel (also usable for mention recipients), with identical frames and recounts. Run removal/invitation, unrelated-channel and revoked-session controls. No latency benefit has yet been measured.

### S5 — P2 optimization: subscriptions of the same bot repeat eligibility and envelope work

The synchronous event transaction loads subscriptions once, but then repeats bot membership, workspace metadata and event body serialization for every subscription (`server.ts:744–780`).

Evidence: [server-integration_work_counts.log](server-integration_work_counts.log). A real message POST with one bot and 1/10/100 eligible subscriptions performs respectively 1/10/100 identical bot eligibility lookups, workspace ID reads and serializations of the same envelope. Each subscription correctly receives its own queued row. The method wrappers delegate to the actual Store; outbound is isolated. These are work counts, not timings.

Implementation: evaluate membership once per distinct bot/channel for the event, read workspace identity once and serialize the callback body once before enqueueing eligible subscriptions. Keep event type/self-actor filters, redaction, distinct delivery IDs and capacity counters. Complexity: small.

Acceptance: the 100-subscription/one-bot fixture does one eligibility lookup, one metadata read and one callback serialization while still enqueueing 100 correct deliveries. Multi-bot, removed/deactivated bot, filtered event, redaction and full-backlog controls remain correct. This is a measured remaining integration optimization; the original plan explicitly reserved aggregate capacity for later.

### S6 — P2 contract decision: historical retry order differs from complete outstanding-event order

Evidence: [server-retry_order.log](server-retry_order.log). Actual retry HTTP and delivery-pump transport, with three old failed rows and a full 500-row newer queue, receives sequences `[4,1,2,3,5,6]`. The sixth response is held to bound the probe. Only completing sequence 4 frees capacity to promote sequence 1 (`store.ts:2839–2843`, `:2933–2956`); due selection excludes failed/requested-but-not-promoted rows (`:2804–2815`). The existing drain test (`deliveryRetry.test.ts:107–110`) checks sorting only within the retried subset.

The measured inversion is definite. Its correctness classification depends on the intended manual replay contract: old events may already have been delivered after newer ones before an administrator requests replay. No bot-state corruption is asserted by this synthetic payload probe.

Next step: document whether “in order” means ordering within each replay/pending subset or a merged outstanding queue. If merged order is required, select/admit the oldest requested retry before newer undelivered events while keeping bounded active capacity; add a complete-sequence transport assertion. If historical replay is deliberately separate, expose/document that behavior for integration consumers and narrow the plan's order claim. Complexity: small for the contract clarification, medium for scheduler changes.

Suggested implementation order: S1 callback containment and S2 accepted retry retention first; S3 access recovery next; S4/S5 measured work reduction after their controls; resolve S6's replay contract alongside S2 rather than silently assuming monotonic event sequence.
