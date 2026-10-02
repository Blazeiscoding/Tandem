# Follow-up improvement plan — 2026-10-02

Reviewed main: **`f07ce84362257aedeab16c9ae4c2361193eb6442`**, Tandem.

**Most implemented fixes hold; “all plan points done” is not yet supported.** GL-01–03 storage acknowledgement remains unfinished. Installed-app, release/upgrade, assistive-technology and reference-performance acceptance remain open. This investigation added documentation and disposable research harnesses, without implementing product fixes.

## Verified baseline

Fresh forced typechecks pass for all seven workspace projects, and all three application builds pass. The forced package suite passes **1,673 tests**, with two documented skips. Automation typechecking, **22 tooling tests**, **20 browser journeys**, and **four freshly packaged Windows journeys** pass. Tracked-file formatting passes. Turbo's real input check passes **15 mutations / 101 assertions**. Production dependency audit reports zero known vulnerabilities.

Web entry: **479,829 bytes**. Desktop entry: **481,509 bytes**. Both pass their guards. Fresh desktop archive: **1,741 files / 55 dependencies**, **11,166,773 bytes**, no forbidden data/workspace paths. Package and embedded-web manifests match the reviewed revision with source-input dirty false. Compression/content guards pass for web, CLI copy and packaged web.

New diagnostic assertions deliberately recognize current failures; their passing does not mean the failures are fixed. See the [research index](research/2026-10-02-post-implementation/README.md), [validation record](research/2026-10-02-post-implementation/root-validation.json), and detailed [server](research/2026-10-02-post-implementation/server-report.md), [client](research/2026-10-02-post-implementation/client-report.md) and [desktop](research/2026-10-02-post-implementation/desktop-report.md) reports.

## Previous-plan closure matrix

“Verified” applies to the stated behavior, not every wider acceptance condition.

| Package        | Current verification                                                                                                                                             | Remaining condition or adjacent finding                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| REV-01         | Queue containment, native delivery-timer recovery and regressions hold.                                                                                          | Gateway callbacks: F03.                                                          |
| REV-02         | Real healthy blob drains behind 100 real failed removals; backoff/restart tests pass.                                                                            | No new queue failure established.                                                |
| REV-03         | Real client preserves unrelated thread references; provider implementation/regressions present.                                                                  | Historical Profiler comparison not repeated.                                     |
| REV-04         | 37 socket frames leave nine private answers / 320,427 characters; repeated IDs replace.                                                                          | Screen-reader and physical scrolling acceptance.                                 |
| REV-05         | Equivalent tail requests share one transfer; destruction aborts/ignores late results; Activity tests pass.                                                       | Equivalent forward requests: F14.                                                |
| REV-06         | Two sockets of one session require one authorization lookup; public offline deletion avoids member reads.                                                        | Private batches/integration enqueue: F10/F11.                                    |
| REV-07         | Focused worker is 44,577 bytes; packaged backup/restore regression passes.                                                                                       | Installed app and fresh comparative Electron timing.                             |
| REV-08         | Automation typecheck passes; independent browser fixtures merged in #238; all 20 pass.                                                                           | Docker recipe inspected, local engine unavailable. Old fixture status was stale. |
| REV-09         | Four crashes preserve hosting; fourth reaches Try again; failed-load retries bounded.                                                                            | Saved messages closes on recovery: F08.                                          |
| REV-10         | Failed recount cannot suppress 21 committed deletion frames or change HTTP success.                                                                              | Failed access effects: F06.                                                      |
| REV-11 / GL-13 | Destroyed A initiates no queued/repair unpin after B replaces it; wider tests pass.                                                                              | Already-delivered writes/cross-device ordering remain explicit limits.           |
| REV-12         | Fresh clean archive, guards and four unpacked-app journeys pass.                                                                                                 | Genuine installed upgrade/uninstall acceptance.                                  |
| REV-13         | Decode guards pass across three copies; browser compression/cache journey passes.                                                                                | Installed host, second device, proxy and changed-assets update.                  |
| REV-14         | Native foreign-window reads/writes/hosting/download rejected; primary storage works.                                                                             | Outbound sensitive events: F09.                                                  |
| REV-15         | Limits, independent pump and existing regressions hold.                                                                                                          | Requested-retry retention/order scope: F04.                                      |
| GL-01–03       | Partial persistence exists; remaining acknowledgement contract explicitly Not started. Fresh send clears before held write; same-draft conflict loses a version. | Finish F01. No process-death loss claimed from these controls.                   |
| IMP-08         | Current artifacts match and tooling/package controls pass.                                                                                                       | Freshness/release/upgrade assurance: F05. No actual release run here.            |
| IMP-07         | Two current Windows runs complete with zero recorded errors.                                                                                                     | Replay/retention/memory methodology and reference acceptance: F12.               |

Persistent thread position is now implemented and covered by the fresh browser suite; the original product-backlog sentence predates it. Existing search syntax, filename/type matching and fresh file-access denial pass their regressions. New findings concern narrower boundaries.

## Ranked work packages

Effort: **S** focused change; **M** several ownership boundaries; **L** storage/protocol migration and broader acceptance. Each needs an owner and candidate revision when implementation starts.

### F01 — P1 · Client/storage · L · Finish GL-01–03

Production Composer clears fresh text while outbox storage is held: text is in memory but absent from durable fixture values. Competing same-draft texts retain only the second. Browser read/merge/write is not transactional across independent contexts.

Establish acknowledged ownership for initialization, migration and draft/outbox transitions; retain fresh text until acknowledgement and preserve conflicting versions under an explicit recoverable policy. Keep workspace/account identity and migration trust explicit.

**Accept:** independent browser contexts and native restart/death controls prove acknowledged outbox preservation, safe initialization and both conflict texts recoverable. Failed writes stay visible/retryable; accepted-send deduplication holds. Shared-device/DOM controls alone cannot close this. [Evidence](research/2026-10-02-post-implementation/client-report.md).

### F02 — P1 · Notification privacy · S strict-read fix, M shared ownership

Malformed browser storage silently loads full previews. Actual production-browser reload changes saved “Nothing about it” to “The message.” Sequential second-window saves erase another account's acknowledged private choice; same-account windows ignore external changes.

Use strict reads and validate saved maps; unreadable state stays private. Store/merge per account through acknowledged ownership and subscribe to changes. Decide alias/workspace scope and migrate only approved identities.

**Accept:** corrupt/refused reads yield private content with retry guidance; independent windows cannot erase another account's choice or retain stale full previews. Preserve account separation and failed-save feedback. [Evidence and screenshot](research/2026-10-02-post-implementation/client-report.md).

### F03 — P1 · Server reliability · M · Contain Gateway callbacks

Three real children exit 1 after socket/native heartbeat session-read exceptions. One uses actual SQLite read denial with Store methods untouched; healthy control survives.

Contain complete message, heartbeat and close/unregister boundaries; fail authorization closed, report failure and close affected sockets for recovery.

**Accept:** real faults leave HTTP health 200, emit no permission-dependent frame during failed reads, then reconnect normally. Preserve revocation and add disconnect-failure controls. Fault consequences are proven; natural frequency is unknown. [Server S1](research/2026-10-02-post-implementation/server-report.md).

### F04 — P1 · Durable integrations · S/M · Preserve accepted retry intent

HTTP accepts 1,000 retries waiting behind 500 active rows; unchanged seven-day pruning deletes all 1,000 with no dropped count.

Separate requested intent from terminal-history expiry, or renew it under an explicit observable cancellation policy. Resolve replay ordering alongside this: measured sequence is `4,1,2,3,5,6`; replay-subset order holds, global order does not.

**Accept:** cross expiry and restart with a full queue, then drain accepted intent exactly once; unrequested history still prunes and capacity remains 500. Document historical replay or test merged outstanding ordering. Consumer corruption was not established. [Server S2/S6](research/2026-10-02-post-implementation/server-report.md).

### F05 — P1 · Build/release assurance · M · Finish identity and upgrade proof

Split into three reviewable changes:

1. Include relevant install/workspace configuration and identity-generator inputs in freshness; hash binary bytes exactly, normalize explicit text formats only, validate manifest shapes.
2. Verify the launched application's actual profile and usable previous-version data. The current mocked gate selects a legacy marker while the new process uses a fresh profile.
3. Enumerate publishable assets, keep notes outside checksum inputs, make preparation repeatable and bind assets to tested identity. Current second preparation hashes old notes then rewrites them.

**Accept:** input mutations invalidate correct artifacts; binary CRLF changes differ; malformed manifests give actionable guidance. A fresh-profile upgrade fails despite an old marker; a genuine disposable installed upgrade reads previous database/attachments/settings. Repeated preparation yields valid checksums and rejects wrong assets/sidecars. [Desktop findings 1/2/5](research/2026-10-02-post-implementation/desktop-report.md).

These demonstrate gate weaknesses, not broken application migration or a published artifact exploit.

### F06 — P2 · Access recovery · M

A failed post-commit access effect leaves a removed user's actual client online with its private channel and previous content until reconnect. Fresh HTTP correctly returns 404.

Resynchronize affected devices or durably retry targeted access refreshes when access-state publication fails.

**Accept:** bounded automatic recovery clears revoked channel/history/local work, preserves committed HTTP success and leaves unaffected users correct. This is cached prior data, not newly granted access. [Server S3](research/2026-10-02-post-implementation/server-report.md).

### F07 — P2 · Client resources · M · Invalidate files independently of history

Deleted-message bytes remain available through an old blob URL despite server 404. Access loss also retains a file when history metadata is absent; that probe seeds absence rather than replaying eviction.

Keep bounded file-to-message/channel ownership; cancel/purge on deletion, revocation and auth loss, notifying active previews.

**Accept:** actual history eviction followed by real access loss invalidates URLs; pending transfers cannot reinstall them; open previews explain unavailability; authorized files remain shared. Previously downloaded bytes cannot be retroactively unrevealed. [Client finding 2](research/2026-10-02-post-implementation/client-report.md).

### F08 — P2 · Desktop recovery · M · Restore the complete place

Saved messages opened through its UI is selected before four crashes and closed after every recovery. Channel and hosting survive; manual Try again also loses query context.

Checkpoint validated account-scoped routes outside the renderer; automatic/manual recovery share context and honor pending deep links.

**Accept:** packaged channel/thread/panel/dialog journeys restore visible state, with account isolation, acknowledged local work, healthy hosting and bounded usable recovery. [Desktop finding 3](research/2026-10-02-post-implementation/desktop-report.md).

### F09 — P2 · Desktop boundary · S · Authorize outbound recipients

A harness-created foreign native window cannot read storage but receives complete drafts/outbox broadcasts. No ordinary remote/UI path creating it was demonstrated.

Register/validate trusted recipients before sensitive pushes; review all such channels.

**Accept:** foreign/navigated-away windows receive no sensitive values; legitimate primary and supported secondary windows remain correct. Retain the native-only prerequisite in the threat claim. [Desktop finding 4](research/2026-10-02-post-implementation/desktop-report.md).

### F10 — P2 optimization · Private publication · S/M

Deleting a 21-message private thread in a 50-member channel materializes **1,050 member IDs offline**, versus zero for public. Two readers cause 22 reads / 1,100 IDs; both still receive all deletion frames.

Skip audience reconstruction without recipients and share committed audiences within one synchronous batch.

**Accept:** offline private batch has zero audience reads; online batch shares one channel read and retains identical frames/counts. Check membership changes, revocation and unrelated channels. Work reduction is measured; latency benefit remains to measure. [Server S4](research/2026-10-02-post-implementation/server-report.md).

### F11 — P2 optimization · Integration enqueue · S

One bot with 1/10/100 subscriptions repeats identical eligibility, metadata and serialization work 1/10/100 times.

Evaluate each distinct bot/channel once; read workspace identity and serialize the common envelope once per event.

**Accept:** 100 correct distinct deliveries with one shared check/read/serialization; preserve deactivation, filtering, redaction and backlog controls. Compare successful posting cost before/after. [Server S5](research/2026-10-02-post-implementation/server-report.md).

### F12 — P2 · Measurement correctness · M

Two Windows runs record post p50 **7.34/7.65 ms**, p95 **20.66/24.68 ms**, zero recorded errors. One Node event-loop maximum reaches **195.95 ms**; cause unresolved.

The fixture expires nothing under retention. Reconnect checks `synced`, not exact replay contents; seeded message sequences exceed the event checkpoint. Receipt maps/closed sockets are retained in the measured process, confounding memory/stalls.

Seed nonzero expired history/attachments through production maintenance; use consistent events and independent snapshot/replay references; add deliberate offline gaps. Bound harness state, separate server/client memory, record durations and offered/completed load. Profile remaining stalls before architectural isolation.

**Accept:** skipped retention or omitted/reordered replay makes the harness fail; normal runs prove exact results and actual cleanup. Establish repeated low-spec headed/browser and actual desktop-main/GPU references. Current runs cannot close a 100 ms desktop-main target. [Method review](research/2026-10-02-post-implementation/client-mixed-method-review.md), [runs](research/2026-10-02-post-implementation/root-mixed.json), [repeat](research/2026-10-02-post-implementation/root-mixed-repeat.json).

### F13 — P2 conditional optimization · Search · S prototype, M acceptance

A message-ID UNION candidate on the current 200,000-message / 1% file fixture preserves exact reference IDs and hydrated content for 15 selected cases. Filename-heavy queries improve; common and hidden-only words regress. Reject a blanket rewrite.

Prototype a selected sparse/name-heavy branch, retaining the common-word window and ACL-selective behavior. Earlier author/date candidates remain open; compare query shape before adding indexes.

**Accept:** repeat successful measurements across common/rare/hidden words, filenames, modifiers/cursors, DM/private ACLs, multi-file/deleted messages and reordered inserts. Include write/index cost if migrating. One host, ASCII fixture and 15 warm samples support a prototype, not general equivalence. [Measurements and decision](research/2026-10-02-post-implementation/root-performance.md).

### F14 — P3 optimization · Forward history · S

Equivalent newer-page calls issue two transfers and abort one; resulting rows are correct. Join equivalent cursor/window requests and replace changed windows. Accept one transfer with both callers settled and preserved live replay, anchoring/order/uniqueness and destruction. [Client finding 3](research/2026-10-02-post-implementation/client-report.md).

### F15 — P3 conditional optimization · Dependency contents · M

Zod occupies **5,429,652 bytes**, roughly half the clean archive payload. Audit required formats/locales/metadata before runtime-safe pruning/bundling. Require package-size comparison and packaged hosting, backup, migrations and error controls. Inventory alone proves no startup/memory benefit. [Inventory](research/2026-10-02-post-implementation/desktop-package-inventory.json).

## Execution order and closure

- **Reliability:** F03 → F04 → F06; F10/F11 after access/publication controls stay sound.
- **Client:** F02 strict-read fix can start immediately; F01 supports shared preference ownership. Then F07; F14 is lower priority.
- **Desktop/release:** F05 as three changes; F08/F09 independently; genuine installed/release acceptance follows corrected gates.
- **Performance:** F12 before capacity/architecture conclusions. Prototype F13 selectively, retaining rejected controls. F15 only when delivery cost justifies it.

Record owner, starting/candidate revisions, focused correctness controls and matching-artifact integration evidence. Performance closure requires comparable successful measurements and an explicit keep/reject decision.

Open acceptance: Docker engine/reuse smoke; genuine installer/upgrade/uninstall and downloaded release; second-device/proxy headers and asset update; screen reader/private answers; physical-device calls/accessibility; low-spec desktop-main/GPU and public-route reachability. These are explicit outstanding conditions, not new alleged defects.
