# Fresh project review — 3 October 2026

Reviewed main **`cd3af584ba46adace45465cb5e5c66afb238b01c`**, after the requested fast-forward pull from `36d9eab`. The pull included the F01–F15 implementations and their follow-up measurements. Findings below concern the updated code, not the earlier unimplemented baseline.

**The ordinary test journeys pass, but several important failure and lifetime boundaries remain.** Prioritize request-logging containment, reliable storage ownership and desktop shutdown, then microphone intent. The review produced documentation and reproducible research harnesses; it did not implement application fixes or publish anything.

[Evidence index and reproduction](research/2026-10-03/README.md). Detailed reports: [browser storage](research/2026-10-03/root-storage-report.md), [server](research/2026-10-03/server-report.md), [client](research/2026-10-03/client-report.md), [desktop](research/2026-10-03/desktop-report.md).

## Fresh verification

Forced builds/typechecks pass for all seven workspace projects: **10 executable tasks, zero cache hits**. Completed package runs pass **1,762 tests**, with two existing skips; automation typechecking and **28 tooling tests** pass. All **22 browser journeys** and **6 freshly packaged Windows journeys** pass, including browser process-death persistence, renderer recovery and foreign-window IPC controls.

The first combined run failed the server ownership test at `ownership.test.ts:149`: a second server was admitted where the test expected the child to hold the folder. Its focused rerun and full isolated server rerun pass. The initial failure is retained; its cause is unresolved, so it must not be dismissed as merely machine load. The package totals above describe completed successful runs, not a successful first combined run.

Fresh production dependency audit reports **zero known vulnerabilities**. Cache-input verification passes **15 mutations / 101 assertions**. Browser entry is **490.8 kB**, desktop entry **493.2 kB**, both below the 500 kB guard. The fresh Windows archive has **1,163 files / 55 dependencies**, passes its forbidden-file guard, and carries the reviewed revision with source-input dirty false. Compression guards pass for browser, CLI copy and packaged browser assets; all artifact freshness checks pass.

Passing diagnostic assertions below mean the undesirable behavior was reproduced. They are evidence of an issue, not repaired-product acceptance. Media simulation, actual HTTP/socket tests, actual packaged Electron checks and injected resource failures are identified separately in the detailed reports.

## Ranked work packages

P1 means address in the next reliability/privacy pass; P2 means follow-on correctness and lifecycle work. S is a focused change, M crosses ownership boundaries, and L needs a durable storage/recovery policy. Priorities are engineering judgments from the observed impact; natural failure frequency was not measured.

| ID  | Priority / effort    | Confirmed improvement                                                                                                       | Evidence                                                                                                                           |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| N01 | P1 / S               | A malformed query name can terminate the default server while its logger redacts the URL.                                   | [Server N1](research/2026-10-03/server-report.md#n1--p1-malformed-url-encoding-can-terminate-request-logging)                      |
| N02 | P1 / M–L             | Switching away from existing IndexedDB hides saved privacy/work; switching back discards an acknowledged fallback draft.    | [Storage investigation](research/2026-10-03/root-storage-report.md)                                                                |
| N03 | P1 / M               | Immediate normal desktop quit/window close loses the final visible draft; a write starts but does not finish before exit.   | [Native desktop evidence](research/2026-10-03/desktop-native-close-uninstrumented.json)                                            |
| N04 | P1 / S–M             | A mute made during microphone recovery is undone; joining before preference initialization ignores saved join-muted intent. | [Client C01/C02](research/2026-10-03/client-report.md)                                                                             |
| N11 | P1 conditional / S–M | A malformed restored-workspace registry row is re-adopted without its isolation hold.                                       | [Desktop report](research/2026-10-03/desktop-report.md)                                                                            |
| N05 | P2 / M               | A replacement app form inherits another form's text; old results can close or contaminate the new form.                     | [Client C03](research/2026-10-03/client-report.md#c03--p2--integration-privacy-and-lifecycle--m-separate-each-app-forms-ownership) |
| N06 | P2 / S               | Deleted/purged button labels, values and URLs survive in stored events and actual reconnect replay.                         | [Server N2](research/2026-10-03/server-report.md#n2--p2-deletion-and-retention-leave-button-content-in-replay-events)              |
| N07 | P2 / S–M             | Sent schedule records retain original text after message edit, deletion and shorter history retention.                      | [Server N3](research/2026-10-03/server-report.md#n3--p2-delivered-schedules-retain-deleted-and-superseded-text)                    |
| N08 | P2 / M               | Two concurrent submissions of one app form dispatch two real callbacks and both succeed.                                    | [Server N4](research/2026-10-03/server-report.md#n4--p2-one-modal-can-be-submitted-twice-while-its-first-response-is-pending)      |
| N09 | P2 / S–M             | A delayed `replace_original` response after deletion posts a different new message.                                         | [Server N5](research/2026-10-03/server-report.md#n5--p2-replacing-an-already-deleted-app-message-creates-a-different-message)      |
| N10 | P2 / S–M             | Retention removes history/server files but does not invalidate already-cached attachment bytes.                             | [Client C04](research/2026-10-03/client-report.md#c04--p2--f07-residual--sm-retention-still-retains-attachment-bytes)              |
| N12 | P2 / M               | Failed resource cleanup drops connector/server ownership while a listener remains alive.                                    | [Desktop lifecycle evidence](research/2026-10-03/desktop-lifecycle-fixtures.json)                                                  |

### N01 — Keep request logging within its failure boundary

[redact.ts:57](../packages/server/src/redact.ts#L57) decodes query names without catching invalid encoding. A real disposable child answers ordinary health 200, then exits 1 inside the request logger on a malformed query name. The paired logger-disabled child answers the same request and subsequent health 200. The shipped entry enables logging at [main.ts:402](../packages/server/src/main.ts#L402); route-handler error containment does not protect this earlier serializer callback.

Make redaction total over arbitrary request strings and conservatively mask malformed values. Accept with actual-child HTTP tests proving subsequent health, no process exit, and continued credential masking. This is a new boundary alongside repaired F03, not a failure of the new Gateway controls.

### N02 — Preserve durable backend ownership through failures

[deviceStore.ts:350](../packages/ui/src/lib/deviceStore.ts#L350) requires BroadcastChannel for IndexedDB and silently falls back on any opening error. After migration, localStorage no longer holds the existing values. A saved private preview then reads as first-use absence and becomes full, with no error. A draft saved and acknowledged during fallback is later removed when the older IndexedDB value wins.

Four controls cover opening failure, acknowledged fallback/recovery, missing BroadcastChannel and an actual blocked upgrade event. The production web bundle also displays the private-to-full change in a fault-controlled browser frame. Existing-store unreadability must remain distinguishable from empty first use. Preserve/reconcile fallback operations instead of deleting them, keep unknown privacy restrictive, and make recovery retryable. Accept with real persisted multi-window backend failure/recovery and upgrade controls for sign-ins, drafts, outbox and private preferences. This is residual F01/F02 acceptance, although ordinary crash persistence now passes.

### N03 — Finish local writes before a clean desktop exit

In the fresh native package, the final words are visible before a normal exit but absent from the profile afterward. Immediate quit loses them twice; plain window close and explicit pagehide followed by immediate quit do too. Waiting for ordinary persistence or acknowledged pagehide persistence preserves them. All exits are 0. An additional IPC trace records `storage:mergeDrafts` starting before `will-quit`, with no completion before exit.

Intercept final close/quit while the renderer hands over current words, then wait for the main storage queue's acknowledged completion before destroying the renderer or process. Bound recovery and show an honest retry/copy/leave outcome if storage cannot complete. Accept immediate last-keystroke close, Alt+F4, tray quit and application quit with hosting running/stopped, held/rejected writes and account isolation; restart must recover the actual last text. Native fault/death guarantees remain a separate contract. This is an Electron F01 lifetime boundary that the new browser crash journey does not cover.

### N04 — Preserve the latest microphone-off intent

[huddle.ts:153](../packages/client-core/src/huddle.ts#L153) captures mute before awaiting a replacement microphone. Muting during that wait is undone when the replacement is adopted: the new track is enabled, attached to the sender and announced unmuted. Separately, [HuddleBar.tsx:159](../packages/ui/src/components/HuddleBar.tsx#L159) allows joining before the saved call preferences load and passes `muted:false` even when the eventual saved value is true.

Treat desired mute as current user intent independent of the track; use it when attaching every replacement. Route all joins through initialized preferences or a restrictive unknown-state default. Accept held capture and preference reads, mute toggles in both directions, failures/retries and leaving during capture. Synthetic production logic/component probes establish the state/sender consequences; actual browser/desktop/device audio checks should prove silence after mute during recovery and at preference-aware join.

### N05 — Give each app form its own state and completion lifetime

The real two-app journey opens A, types words, invokes B for the same account, opens B and explicitly submits it. B's actual callback receives A's words under B's view/callback ID because [ViewModal.tsx:18](../packages/ui/src/components/ViewModal.tsx#L18) keeps state across replacement. Separate probes show an old success closes B and an old refusal marks B's fields invalid. The user must initiate the second app action and submit the new form; inherited words are visible beforehand.

Key the form lifetime by view ID, guard every result/dismissal by that ID, and decide explicit replacement/queue/refusal behavior for unsaved work. Accept two actual apps sharing field IDs, old success/refusal/failure after replacement, cancel/reopen and same-app successive forms. Do not infer automatic or unauthorized disclosure from this reproduction.

### N06/N07 — Remove all redundant message content under deletion policy

Actions survive both soft-deleted rows and event redaction, then travel over actual replay while text/files are correctly blanked. Sent schedules separately retain old message text after edit/delete; one-day history retention removes the message but not its seven-day schedule copy. The sent schedule API hides these rows, so that finding concerns database content copies.

Clear action content in tombstones/events and strip sent-schedule content once canonical posting completes, keeping required IDs/idempotency facts. Decide and migrate existing retained copies. Accept real reconnect from before creation and stored-row inspection after edit/delete/purge, while preserving live buttons, pending unsent work, ordering, completion deduplication and access checks. These are new cleanup boundaries, not newly granted channel access.

### N08/N09 — Make in-flight app intent stable

One form can be submitted by two contexts while its first callback is pending; default call limits allow both. Claim the view before dispatch and define shared/rejected in-flight repeats and retry semantics. A stable submission identifier should support app deduplication after uncertain transport; server exclusion alone cannot promise exactly-once external business effects.

For delayed replacement, resolve `replace_original`/`delete_original` intent before ordinary posting. A missing origin must yield a documented gone/no-op result instead of creating a new ID. Accept concurrent same-view requests, independent views, validation correction, transport retry, deletion during an app reply and an explicit concurrent-edit policy. Existing authorization and admission limits must remain intact.

### N10 — Complete F07 for retention events

Ordinary loaded-message deletion now removes the cache entry and revokes its URL. However, production retention emits `history.removed`; [workspace.ts:1166](../packages/client-core/src/workspace.ts#L1166) removes timeline rows without file invalidation. A known-owner attachment still returns its old readable blob while fresh authenticated GET is 404.

Invalidate the retained message/thread resources, including evicted-history and held-transfer cases, and notify open previews. Accept actual root/reply retention and eviction with unrelated authorized files preserved. The narrower unknown-owner deletion reproduction uses the public client file API; no current Search UI preview route is demonstrated. These are previously downloaded local bytes, not an HTTP authorization bypass.

### N11/N12 — Preserve isolation and ownership when metadata or cleanup fails

With a real disposable SQLite folder, an invalid version-1 restored-workspace row is discarded and rescanned as an ordinary workspace, losing `restoredHold`; start proceeds without explicit activation. Valid restored rows and unreadable-registry holds remain restrictive. Preserve safety metadata independently of optional presentation fields and make uncertain restored identity require explicit recovery. Accept malformed name/port/time fields without upgrading an uncertain folder to ordinary hosting; keep genuine new-folder adoption usable.

The resource fixtures inject cleanup rejection into production hosting controllers using real loopback listeners as adapters. A cancelled connector loses its tracked handle after close fails; an accidental usual-port isolated server similarly loses ownership before stop succeeds. Later shutdown does not revisit either live listener. Retain cleanup ownership until closure is confirmed, record failed cleanup and retry it under a bounded policy. Accept cancelled publish, failed/repeated close and accidental-port isolation cleanup, proving all owned resources eventually close. These fixtures establish controller behavior under faults; they do not establish an actual Cloudflare orphan or real public exposure.

## What the pulled repairs now establish

F03/F04/F06/F10/F11 hold under the current server/client regressions; F13's expanded query matrix passes. F05's manifest shape/input hashing and hash-bound release preparation pass their tooling tests; all built/embedded identities match. F08/F09 pass fresh packaged recovery and foreign-window journeys. Equivalent newer-page coalescing (F14), ordinary file deletion (F07), normal acknowledged browser work and process-death persistence (F01), and malformed-preference handling (F02) pass their current controls. F15's dependency-source pruning passes the archive/runtime hosting checks. These are specific verified paths, not blanket closure of every wider acceptance condition.

The new evidence changes the closure assessment for **F01, F02 and F07** at the boundaries described above. Keep those remaining conditions visible when tracking the prior plan's Done labels. The intermittent ownership test is an additional investigation watch item, not a deterministic new defect or a proven environmental failure.

## Performance and delivery follow-through

Two sequential current-code mixed runs use 20,000 historical messages, 12 people, 24 baseline devices and two five-second rounds each. Each run removes **400 expired messages / 40 attached files** through production maintenance, checks exact offline replay, and records zero errors with completed offered work. Raw workload, latency, memory and host metadata are in [run 1](research/2026-10-03/root-mixed-1.json) and [run 2](research/2026-10-03/root-mixed-2.json). These runs strengthen current F12 correctness evidence; they are not a before/after comparison or a low-spec capacity guarantee. Server and clients share one Node process, so its memory/stalls cannot be attributed to desktop main or server alone.

Only 6.8 kB of the desktop entry's 500 kB budget remains. Preserve lazy loading and measure module/transfer cost before adding to startup; this is delivery headroom, not an observed startup regression. Prior F10/F11/F13/F15 comparisons remain in the pulled [measurement report](research/2026-10-02-followup-measurements/README.md); no new universal optimization gain is claimed.

Remaining acceptance includes genuine installed previous-release upgrade/uninstall, a downloaded release, second-device/proxy/public-route behavior, assistive technology and physical call devices, and low-spec headed desktop/main/GPU references. The local Docker Linux engine is unavailable, so no new container/reuse success is claimed. These are unfinished validation conditions rather than additional alleged product defects.

## Execution order

1. N01 logger containment, preserving secret redaction.
2. N02 browser storage ownership and N03 native shutdown acknowledgement; keep the existing crash/conflict controls.
3. N04 microphone intent and N11 restored-copy isolation, independently of storage redesign.
4. N06/N07 content cleanup and N10 retained resource invalidation.
5. N05/N08/N09 app form/result/submission ownership and explicit replacement semantics.
6. N12 failed-cleanup ownership.

For each candidate fix, record the starting/candidate revision, a focused control that fails before it, normal-path regressions and integration evidence from matching artifacts. Use the narrow evidence limits above when deciding closure.
