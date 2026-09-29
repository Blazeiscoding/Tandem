# Gatherline: complete update and optimization plan

**30 September 2026 · audited `origin/main` at `7d91fd3` · implementation status: proposed unless explicitly marked merged.**

This is the current work queue for Codex or Claude. It combines a new source inspection, controlled reproductions, dependency audits, and research into T3 Code and other chat repositories. It supersedes the execution order and open/closed labels in the older September plans. Keep their dated measurements and implementation history. The [optimization plan](OPTIMIZATION-PLAN-2026-09-30.md) contains the performance experiments; the [research record](research/2026-09-30/research-and-code-evidence.md) explains evidence and sources.

The goal is dependable communication and approachable ownership of its history. Preserve the portable SQLite workspace, shared browser/desktop interface, event sequence and nonce contracts, existing access checks, and current visual language. Select optional capabilities for a named group rather than treating every feature in another app as a release requirement.

## 1. Baseline and what is already finished

The audit covered protocol, server, client-core, UI, desktop, web, server CLI, deployment, packaging, workflows, and the older research/plans. `HEAD` matched fetched `origin/main`; no tracked product changes were present. Pre-existing `.claude/` work and `.audit-client-143/` were preserved. There were no open GitHub PRs or issues when queried. External repositories were inspected as source; their applications were not installed or benchmarked.

| Merged work                                                                                                           | Current assessment                                                                                                | What remains separate                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| #126–127: backup identity, verified retention, destination freshness, due-pass ownership                              | Guards present in desktop backup path                                                                             | Pre-upgrade database-copy retention uses a different implementation: FIX-06. Durable health and older-copy/replacement UI: OPS-01–03 |
| #128, #148: thread reads and revision-aware rollback                                                                  | A thread read no longer marks the channel read; an older failed thread operation cannot undo a newer one          | Read semantics still disagree between Activity and Threads: FIX-08. Other optimistic mutations need FIX-02                           |
| #129, #147: full outbox persistence, refusals, immediate writes and sequential window merging                         | Original 50-entry truncation, 600 ms delay, and sequential overwrite cases fixed                                  | Concurrent contexts and stale-window resurrection remain: FIX-01                                                                     |
| #130, #133–134, #144: scheduled-file reservations, broadcasts, bounds, batched drain, correct benchmark and admission | Implemented; retain these contracts                                                                               | Broader fairness/capacity measurements in optimization plan                                                                          |
| #131: outbound/action admission                                                                                       | Implemented before allocating work, with releases                                                                 | Token scopes and capability-map count ceilings: INT-01                                                                               |
| #132, #145: reader-calendar search and bounded formatter cache                                                        | Implemented; canonical zone names and 32-entry LRU                                                                | Query/index and multilingual search work: OPT-11 and UX-02                                                                           |
| #137–140: login signal, chosen-port policy, startup read failures and stopped-state controls                          | Source guards present                                                                                             | Installed OS login/shutdown/wake evidence and partial startup error visibility: FIX-04, OPS-04/08                                    |
| #141–142, #146: restore hold, separate rehearsal port, paused held schedules and matching-run stable resume           | Source guards present                                                                                             | Recovery operation interruption, replacement, and managed-route liveness: OPS-01/03/07                                               |
| Earlier interface phases                                                                                              | Routing, shared modal/menu/focus components, themes, touch menus, accessible labels and keyboard navigation exist | Real assistive/device evidence, narrower rendering subscriptions and remaining product depth                                         |

The post-fix verification recorded in #149 used product commit `d5acbac`, whose product code is identical to `7d91fd3`: forced typecheck 8/8, build 3/3, 1,192 unit/integration tests, Chromium E2E 18/18, packaged Windows E2E 3/3, and entry bundles below 500 kB. These are recorded prior runs, not new runs claimed by this document. Fresh focused reproductions below establish remaining failures. GitHub's #148 job annotations say jobs did **not start** because of account payment/spending restrictions; a failed check icon is neither an executed test failure nor a pass. See [validation history](VALIDATION.md).

## 2. Priority and execution rules

- **P1:** address next because of message integrity, recovery, privacy, missed communication, or a declared deployment requirement. An upstream advisory is a triage/patch priority; its presence alone does not prove an exploitable Gatherline path.
- **P2:** improve ordinary use and maintainability after the integrity work, or promote when it blocks a named pilot.
- **Conditional:** requires a demonstrated audience need, an architecture decision and an operating owner. It is not promised for the first release.
- **Small** means a bounded local change; **medium** spans a domain; **large** requires multiple reviewable PRs. These are scope bands, not delivery dates.

For each unchecked parent ticket, create an implementation branch from fresh `origin/main`, record the exact baseline and owner, implement the smallest useful behavior, and run the checks for that behavior. Add a focused regression for a reproduced failure. Performance tickets require an actual code change and a before/after measurement, or a documented rejection of the experiment; adding tests alone does not complete them. Update this plan with PR, merge SHA, measured result and remaining limitation. Recheck adjacent access, replay, cancellation and compatibility behavior. Keep publication and code review small enough to inspect.

## 3. Remaining defects and contracts

### FIX-01 · P1 · Make the outbox atomic across windows and preserve per-send intent

**Evidence:** `workspaceStorage.ts` serializes by a renderer-local `Platform` object. Two distinct adapters sharing storage can concurrently read the same value and lose the first accepted send. A second production-component probe restored send A in two windows; discarding A in one stored `[]`, then sending B in the other stored `[A,B]`. #147's immediate writes remain useful, but local serialization and whole-array merging do not supply a shared transaction or durable deletion. Details: [client evidence](research/2026-09-30/chat-client-comparison.md).

- [ ] Provide one atomic storage-update boundary per account/workspace: main-process transactions for desktop; transactional browser storage or verified cross-context coordination for web.
  - [ ] Define behavior for plain LAN HTTP, where some coordination APIs require a secure context. Retain a supported fallback rather than silently losing sends.
  - [ ] Replace stale whole-array replacement with per-nonce state/revision changes and delivery/discard tombstones; propagate changes to other windows.
  - [ ] Define the exact durable-acceptance point. Preserve composer input or show a recoverable pending save if durable storage fails or the process dies during a write.
  - [ ] Reproduce simultaneous accept, discard versus unrelated send/flush, refusal versus stale retry, quota failure, restart and logout. Preserve server nonce idempotency and account isolation.

**Done:** both concurrent sends survive restart; delivered/discarded entries cannot reappear; a stored refusal cannot be cleared or automatically retried by a stale window without explicit author Retry. Failure leaves recoverable input and an actionable state. This requires storage and client behavior, not only a new test.

### FIX-02 · P1 · Guard older optimistic failures outside thread state

**Evidence:** `WorkspaceClient.setChannelPrefs` rolls back unconditionally. Controlled sequence: `mentions → all` pending, then `nothing` succeeds, then first request fails; UI returns to `mentions`. #148 guards thread operations only.

- [ ] Give channel preference mutations an operation/revision boundary and reconcile server echoes.
  - [ ] Preserve a later successful choice or authoritative event when an earlier request fails.
  - [ ] Show pending/failure/retry state in Channel details and retain the chosen intent.
  - [ ] Inspect and reproduce the same pattern in DND, appearance, pins and saved items; do not mark those all broken without a reproduction.
  - [ ] Check reordered responses, cross-device updates, navigation and access revocation.

**Done:** the reproduced later preference survives; each additional affected path has its own confirmed repair and visible failure behavior.

### FIX-03 · P1 · Suppress notifications only for communication actually being viewed

**Evidence:** `WorkspaceScreen.tsx` suppresses all active-channel messages while the document has focus, including a mention in an unopened or different thread. It computes thread visibility but the suppression condition ignores it.

- [ ] Define a shared displayed-message predicate for channel messages, broadcast replies and the exact open thread.
  - [ ] Include phone overlays, covered panels, background/minimized state and the distinction between focused and reading history.
  - [ ] Preserve own-message, mute, notification level, DND and replay suppression rules.
  - [ ] Route notification taps to the correct account/workspace/message and explain relevant decisions.
  - [ ] Exercise unopened thread mentions, different open thread, ordinary visible message and mobile overlay.

**Done:** an unseen eligible reply can notify even when its channel is selected; truly viewed eligible messages do not produce duplicate interruptions.

### FIX-04 · P1 · Show a failed stable-address restart while LAN hosting continues

**Evidence:** a disposable DOM probe confirms `launchError` appears only when hosting is stopped. Stable-address resume can fail after hosting succeeds; sign-in startup then hides the window when a tray exists. The running host view and tray omit the failure.

- [ ] Render startup errors independently of hosting phase and identify which part failed.
  - [ ] Add retry/configure/dismiss actions fenced to the same workspace/run; keep working LAN hosting available.
  - [ ] Give a sign-in partial failure visible window/tray attention.
  - [ ] Clear the error on matching successful recovery or explicit dismissal, not an unrelated status update.
  - [ ] Verify successful LAN start plus failed external probe/connector, changed settings, and a later successful retry.

**Done:** the host sees and can resolve the failure in both ordinary and sign-in launches. This is a suitable small first implementation ticket.

### FIX-05 · P1 · Bound retention by all affected rows and handle maintenance failure

**Evidence:** retention caps roots at 2,000 but expands every reply into one SQL parameter list. One root with 33,000 old replies exceeds SQLite's 32,766-variable limit, rolls back, and remains stored. The hourly timer invokes retention without a failure boundary. [Server reproduction](research/2026-09-30/server-comparison.md).

- [ ] Replace unbounded placeholder lists with set-based SQL, a temporary ID set, or safe bounded chunks.
  - [ ] Preserve whole-thread retention semantics and atomic metadata/event/file-deletion ownership.
  - [ ] Budget work by actual affected rows/time and yield between safe maintenance units.
  - [ ] Catch/report timer failures, retry safely, and expose stalled retention without crashing the process.
  - [ ] Exercise one oversized thread, many roots, active replies, attachment cleanup, interruption and repeated passes.

**Done:** the oversized fixture is purged safely within a declared work budget; failure is observed and retried; no orphaned or partially visible thread is introduced.

### FIX-06 · P1 · Preserve the database copy just created before an upgrade

**Evidence:** `db.ts` sorts pre-upgrade copies by filename timestamps and prunes them separately from desktop retention. With three future-named copies and a clock rollback, a real upgrade reports a new rollback-copy path that pruning has already deleted.

- [ ] Always protect the copy made for the current upgrade.
  - [ ] Count only acceptable recovery candidates; define schema/identity/integrity checks for this copy format.
  - [ ] Handle future timestamps, malformed copies and clock rollback without losing the last valid rollback point.
  - [ ] Avoid reporting a path that no longer exists; surface pruning failure separately from successful protected backup.
  - [ ] Verify actual old-schema upgrade and recoverability with the reported copy.

**Done:** every successful upgrade retains its verified pre-upgrade copy. #126's desktop fix remains closed; this repairs a different retention path.

### FIX-07 · P1 · Decide and enforce the lifetime of old text in pending integration deliveries

**Evidence:** delete/edit redacts old event-log text, but queued `event_deliveries.body` still holds it. Controlled authorized-bot probes found old text absent from `events` and present in pending deliveries after both operations. That persistent copy can leave the host later.

- [ ] Specify the pending-delivery contract for edit, deletion, retention and loss of bot access; recommend minimizing superseded text that has not left the host.
  - [ ] Associate queued rows with message/resource IDs using an indexed representation and compatible migration.
  - [ ] Scrub/drop superseded pending content while preserving required ordering and current edit/delete events.
  - [ ] Cover root deletion, failed/restarted queues, retention and an in-flight delivery racing revocation.
  - [ ] Document that already delivered or in-flight external copies cannot be recalled and that operational backups have their own retention.

**Done:** implementation matches the published lifetime contract, pending copies respect it across restart, and the interface does not promise erasure from third-party systems.

### FIX-08 · P1 contract · Agree on channel, thread, Activity and mention read semantics

**Evidence:** R143-C5 remains open after #148. Channel cursor passing a non-broadcast reply makes Activity/`isMessageRead` call it read while Threads still counts it unread. Reading the channel never displays that reply. A previous badge-only fix was deliberately removed.

- [ ] Write the state table for root/channel messages, thread-only replies, channel-copied replies, follow/unfollow and explicit mark unread.
  - [ ] Recommended design: a thread-only reply is read through its thread; channel-copied replies may also be read in the channel. Keep unread, subscription, personal completion and shared resolution independent.
  - [ ] Plan a versioned upgrade that seeds historical thread read state from prior channel cursors where needed, so old mentions do not reappear unexpectedly.
  - [ ] Use the same rule for server counts, client Activity, Threads, badges, notification decisions and resync.
  - [ ] Verify mark-unread survives an advanced channel cursor, multi-device reads, old clients and reconnect.

**Done:** the contract and migration are agreed in the ticket and all surfaces implement it. No badge-only change that hides unseen replies.

### FIX-09 · P2 · Correct LAN IPv6 URLs and “hosted here” identity

**Evidence:** discovered IPv6 addresses are concatenated as `host:port` without brackets; the actual URL normalization rejects them. The Join screen identifies “hosted here” by port alone, so another host on the usual port can get the label.

- [ ] Share a canonical host/port URL builder for IPv4, IPv6 literals, hostname and scheme handling.
  - [ ] Match local hosting using verified workspace identity and local endpoint/interface evidence.
  - [ ] Check two computers both using port 8543, IPv6-only discovery, dual stack and changing interfaces.
  - [ ] Preserve invite/deep-link compatibility and useful errors when an address cannot be reached.

**Done:** valid discovered endpoints connect and the label identifies this computer's workspace correctly.

### FIX-10 · P1 triage · Patch and monitor the dependency/runtime advisory inventory

**Evidence:** fresh `pnpm audit --prod --json` reports four high entries representing two `fast-uri` advisories affecting lockfile versions 3.1.6 and 4.1.3. All-dependency audit reports 20 entries: seven high, eight moderate, five low, representing 14 unique advisories. This includes build/test dependencies. No Gatherline exploit was demonstrated. [Audit summary and upstream sources](research/2026-09-30/research-and-code-evidence.md).

- [ ] Trace each version to shipped server/desktop code, build/test-only tools, or a bundled Node/Electron runtime.
  - [ ] Upgrade affected compatible dependencies, including both `fast-uri` major lines; use narrow overrides only when the upstream dependency cannot yet take a compatible patch.
  - [ ] Review Vitest/esbuild/Undici advisories by their enabled feature and network exposure. Separate dependency-package findings from the Undici copy bundled in a runtime.
  - [ ] Run a frozen install, affected suites, builds and packaged smoke after changes; record any deliberately deferred major upgrade and its reachability rationale.
  - [ ] Add a scheduled dependency-review/update policy, runtime minimum/support policy and owner for security patches. Keep noisy/nonreachable tool findings from obscuring shipped exposure.

**Done:** affected shipped paths are patched or explicitly justified with source evidence, remaining tool findings are owned, and the current advisory report is attached to the change. Upstream patch ranges and advisory links are recorded, not silently frozen in this plan forever.

### FIX-11 · P1 · Enforce one active writer for a workspace directory

**Evidence:** two real servers can start the same data folder on different ports. With a 4-byte cap, each separately inventoried storage and accepted a 4-byte upload; the folder held 8 bytes. Independent schedulers, realtime state and cleanup also lack a shared owner, although duplicate scheduled delivery was not reproduced.

- [ ] Acquire exclusive ownership of the canonical workspace directory before migration, inventory, cleanup, discovery or serving.
  - [ ] Refuse a second CLI/desktop server with a useful error and the owning endpoint/process where safe.
  - [ ] Define crash/stale-lock recovery without treating an uncertain PID or different path spelling as proof the owner is gone.
  - [ ] Coordinate backup, restore/recovery and admin CLI operations with the same ownership boundary.
  - [ ] Verify simultaneous starts, symlink/path aliases, abnormal owner exit, restart and two-upload quota reproduction.

**Done:** only one active workspace writer can serve that folder, and recovery cannot activate or mutate it behind an existing owner. Single-server storage reservation behavior remains intact.

## 4. Optimization work queue

The [optimization plan](OPTIMIZATION-PLAN-2026-09-30.md) defines OPT-01–OPT-24 with implementation subitems and evidence gates. Start with measurement and the demonstrated thread-page index, then narrow row subscriptions. Process isolation, virtualization and new caches need comparison against current behavior before broad adoption.

Existing controls to preserve: 300 messages per timeline/thread window, 20 total history-cache entries per category with active views protected, 32 MiB idle attachment blobs, four concurrent file transfers, lazy image fetches, 2 MiB socket backpressure, 10-item scheduled batches, bounded admission, worker-thread desktop backup/verification/restore, lazy panels and 500 kB entry budgets. “Optimize everything” means inspect their costs and remaining boundaries, not remove correctness or rebuild them unnecessarily.

## 5. Hosting, recovery and release updates

### OPS-01 · P1 · Catalogue verified backups and safely replace an existing workspace

- [ ] Port the unmerged older-copy/replacement feature onto current main with one owner. `.claude/worktrees/o04` has six uncommitted files based on `c85132b`; its old restore and pruning paths cannot establish current safety.
  - [ ] List copies with workspace identity, schema, manifest/integrity state, creation evidence and compatibility; verify selection before replacement.
  - [ ] Require the target to be stopped; persist hold and clear automatic startup before a data swap.
  - [ ] Stage the replacement and preserve the superseded original until verification/explicit disposal.
  - [ ] Show restored accounts, sessions, apps and queued effects; retain isolated rehearsal and explicit activation.
  - [ ] Exercise wrong ID, future schema, failed settings write, full disk and interrupted swap. Preserve #126/#127/#141/#146 behavior.

**Done:** a non-developer can select and rehearse a correct older copy without publishing it or losing the present workspace. Depends on OPS-03 for interruption recovery.

### OPS-02 · P1 · Make backup health durable and demonstrate off-device recovery

- [ ] Persist last attempt, verified success, destination, copy path and categorized failure; errors currently live only in memory.
  - [ ] Display stale/unavailable-destination warnings in hosting and tray with actionable retry/folder actions.
  - [ ] Choose an explicit recovery-point/recovery-time target per support mode. A verified archive and a completed restore drill are separate states.
  - [ ] Support an operator-controlled off-device copy/recipe and restore on a fresh machine while the original is offline.
  - [ ] If archive encryption is required, design keys, loss/recovery, streaming verification and compatibility before implementing it.

**Done:** a restart cannot hide an unresolved backup failure; a second operator completes the documented drill with messages, files, identity, memberships and queued effects checked.

### OPS-03 · P1 · Recover interrupted restore/replace operations and show progress

- [ ] Add persistent staged-operation/journal state and reconcile it before ordinary hosting starts.
  - [ ] Identify safe cancellation points for verify, copy and swap; never terminate an active data swap without recovery ownership.
  - [ ] Expose progress and failure stage from the worker without sending file contents or secrets through IPC.
  - [ ] Bound waiting and handle worker crash/exit; leave a held recoverable state if completion cannot be established.
  - [ ] Drill interruption before/after each rename, app termination, disk full, locked files and restart reconciliation.

**Done:** every interrupted stage has a documented, tested recovery path and cannot auto-activate uncertain data.

### OPS-04 · P1 · Bound shutdown and cover OS termination separately

- [ ] Characterize never-settling HTTP handlers, uploads, outbound calls and a long serialized recovery operation.
  - [ ] Define graceful drain stages/deadlines and cancellation; never close SQLite underneath code that still owns it.
  - [ ] Persist/reconcile unfinished jobs before any forced process boundary; document service-manager/container stop budgets.
  - [ ] Add supported Windows/macOS/Linux lifecycle handling where meaningful. Windows shutdown/restart/logout is not equivalent to Electron's ordinary `before-quit` path.
  - [ ] Rehearse real sign-in, OS shutdown, sleep/wake, network change, no tray and port collision on declared installed platforms.

**Done:** ordinary quit completes within its declared budget, forced/OS exit preserves restart integrity, and the app reports what remains unavailable. Real OS evidence remains an external gate.

### OPS-05 · P1 · Prove historical upgrades and failed-migration recovery

- [ ] Retain anonymized/minimal genuine historical schema fixtures and a current schema/version support matrix.
  - [ ] Check unread/thread state, file references, sessions, integration queues and scheduled reservations through upgrades.
  - [ ] Exercise disk exhaustion during migration, readonly/locked files, interrupted start and the newer-schema refusal path.
  - [ ] Restore the protected pre-upgrade copy with the older supported binary; distinguish data rollback from ordinary app reinstall.

**Done:** each supported upgrade has a matching recovery artifact and drill. Existing generated old-version tests remain useful but do not alone prove every historical release.

### OPS-06 · P1 for persistent hosting · Finish fresh-machine deployment recipes

- [ ] Choose one fully supported always-on recipe and one session-scoped LAN recipe.
  - [ ] Validate trusted HTTPS, proxy WebSocket forwarding, restart service, permissions and backup destination on a fresh install.
  - [ ] Cover owner claim before exposure, invite-only defaults, stale invitation/address and second-operator handover.
  - [ ] Exercise actual container health/restart/upgrade and low-disk behavior where an engine is available; record unavailable environments honestly.
  - [ ] Explain same-origin LAN browser use separately from a public browser client connecting to a private server and its LNA permission.

**Done:** someone other than the author installs, joins, restarts, upgrades and restores the declared recipe using the guide.

### OPS-07 · P1 for public hosting · Monitor managed-connector reachability

- [ ] Apply bounded, nonoverlapping instance-identity probes to app-owned stable connectors after opening, alongside process-exit observation.
  - [ ] Use tolerance/backoff and a degraded/error state that removes an unverified address from new links when appropriate.
  - [ ] Fence callbacks to the current connector/run; reconnect after wake without duplicate processes.
  - [ ] Verify silent route failure, wrong workspace, offline probes, recoveries and a second-network visit.

**Done:** an alive connector process cannot indefinitely stand in for a verified reachable workspace. External-carrier polling already exists; preserve it.

### OPS-08 · P1 · Publish a reproducible manual release and supported-platform matrix

- [ ] Create a tag-driven release with matching version, commit, changelog, installer/server/container artifacts, hashes and dependency/runtime inventory.
  - [ ] Restore usable CI budget/account status and record local checks separately until jobs actually start.
  - [ ] Verify signed/notarized artifacts when credentials are available; keep unsigned builds clearly identified. Budget macOS/Linux implementation and installed-device checks separately.
  - [ ] Check install, upgrade, uninstall-data preservation, protocol links, credential store, notifications, screen capture, firewall, tray and login per OS/architecture.
  - [ ] Attach previous-release upgrade/restore evidence, third-party license notices and SBOM appropriate to the shipped artifact.

**Done:** a new user can obtain a verifiable release with an honest support matrix. Builder target definitions alone are not platform validation.

### OPS-09 · P2 after OPS-05/08 · Add secure update delivery

- [ ] Choose an updater compatible with the actual NSIS/macOS/Linux artifacts; Electron's built-in updater is not a drop-in assumption for every packaging target.
  - [ ] Verify trusted metadata/artifact signatures and protect version/channel policy.
  - [ ] Stage updates, handle interrupted download/install and delay activation safely while hosting.
  - [ ] Couple migration preflight and rollback artifact to the update; never silently downgrade a newer database.
  - [ ] Test old-to-new installs on every supported platform and explain unsupported update channels.

**Done:** update integrity, database compatibility and recovery are demonstrated before enabling unattended delivery.

### OPS-10 · P1 operational foundation · Add actionable health and diagnostics

- [ ] Keep cheap public liveness; add authenticated readiness/operational diagnostics with explicit privacy boundaries.
  - [ ] Report disk/freshness, schema, queue depth/age/failure, event-loop delay, socket pressure and hosting/connector state.
  - [ ] Account for physical disk occupied by SQLite, WAL, attachments, temporary files and backups separately from the existing attachment quota; define reserve thresholds, cleanup ownership and graceful low-disk failure.
  - [ ] Bound labels and history; redact sessions, signing keys, invite/token URLs and message contents.
  - [ ] Add a downloadable sanitized support bundle with user preview and no automatic external upload.
  - [ ] Set practical warning thresholds from OPT-01 measurements and provide an operator runbook.

**Done:** operators can diagnose a failed backup, stuck queue or unreachable route without opening the database or exposing private conversations.

## 6. Messaging, discovery and participation updates

### UX-01 · P2 after FIX-03/08 · Attention and personal follow-up

- [ ] Extend the existing [state tables](STATE-TABLES-2026-09.md) with thread mute/follow notification expectations and recurring quiet hours.
  - [ ] Add per-thread mute and optional followed-reply interruptions only after checking intended behavior with users.
  - [ ] Add Saved done/reopen, notes and a narrow persistent reminder lifecycle; define DND, restart, cancellation and duplicate delivery.
  - [ ] Group Activity by conversation with stable ordering and reasons; expose drafts/pending sends without conflating them with unread.
  - [ ] Compare missed asks and return time on equivalent histories; keep a simple casual-chat path.

**Done:** read, follow, done and resolve remain distinct, reminders survive restart, and catch-up improves measured tasks without hiding requests.

### UX-02 · P2 · Search for files and useful answers

- [ ] Add permission-aware filename/metadata search and an initial Files view with message/thread attribution.
  - [ ] Add newest/relevance choice, file/person/type/date filters and a paged image/file gallery.
  - [ ] Evaluate multilingual tokenization, stemming and mixed-script queries with realistic data; preserve reader-calendar date behavior.
  - [ ] Revoke cached results/previews on access change and define offline expiry. Downloaded copies cannot be recalled.
  - [ ] Keep OCR/PDF extraction/transcription separate resource-bounded jobs if demonstrated demand justifies them.

**Done:** known messages, thread answers and files are found within the agreed retrieval task budget without leaking inaccessible content. Coordinate with OPT-11/12.

### UX-03 · P2 · Profiles and availability

- [ ] Add safe avatar upload/crop, optional time zone/local time and status expiry.
  - [ ] Define online/away/offline semantics based on actual activity and sessions; the protocol's `away` value currently has no producer.
  - [ ] Resize/cache avatars under byte/pixel limits, and clear/revalidate on profile changes.
  - [ ] Keep account identity per workspace and explain what profile data is visible.

**Done:** profiles identify people, timed status clears reliably, and presence does not misrepresent a merely connected idle client.

### UX-04 · P2 · Finish composition and protect conflicting edits

- [ ] Add rendering/toolbar support for lists, quotes and labeled links, with matching composer preview where useful.
  - [ ] Add quote/forward with source attribution and destination-access review; preserve deletion semantics.
  - [ ] Introduce expected message revision for edits and a conflict UI preserving local text; ordinary edits currently overwrite unconditionally.
  - [ ] Check paste, code fences, IME, keyboard send preference and attachment retry.
  - [ ] Add link previews only through bounded outbound protections, respecting private networks, size and content lifetime.
  - [ ] Verify workspace identity before intercepting an HTTP message link as local navigation. Current matching by channel/message ID can misroute a link to a different server sharing restored IDs; retain normal external navigation when identity is uncertain.

**Done:** ordinary composition works consistently and two editors cannot silently lose one another's version.

### UX-05 · P2 · Personal organization and thread context

- [ ] Add favorites, collapsible sidebar sections, recent conversations and hiding inactive DMs, scoped to account/workspace.
  - [ ] Remember thread reading position and offer an optional full-width thread view.
  - [ ] Consider optional thread title/open-resolved state only for groups that need it; define new-reply revival.
  - [ ] Prototype answer/decision records before implementing conversation split/move; preserve attribution, links and subscription state.

**Done:** people return to the right conversation and context after navigation/restart. Structured discussion does not impose project workflow on a casual group.

### UX-06 · P2 · Member onboarding, administration and help

- [ ] Explain host, account/history scope, group identity and availability in joining; preserve invitation/destination through authentication.
  - [ ] Add a newcomer preview, optional welcome/rules/interests and useful expiry/revocation recovery.
  - [ ] Add workspace icon/name administration, configurable invite default expiry and paged/searchable member/app lists.
  - [ ] Extend Help with joining, notification, call and recovery troubleshooting using sanitized diagnostics.
  - [ ] Exercise ownership transfer already present in People, including recovery and second-operator operation; do not rebuild the existing endpoint.

**Done:** first-time members and a successor operator complete their respective tasks without relying on developer knowledge.

### UX-07 · P1 for inclusive release · Real devices, accessibility and cross-browser behavior

- [ ] Validate join, send/reply, search, settings and recovery with keyboard, NVDA/Windows and VoiceOver/macOS/iOS where supported.
  - [ ] Check focus obscured by composer/toolbars, target size/spacing, announcements, error recovery, 200%/400% zoom and high contrast.
  - [ ] Test actual iOS/Android virtual keyboard, safe areas, rotation, camera/files, touch menus and weak signal.
  - [ ] Add focused WebKit/Firefox/visual checks only around supported journeys; keep current Chromium and DOM tests.
  - [ ] Record device/browser/assistive versions, blocking failures and fixes; automated axe is supporting evidence, not certification.

**Done:** the declared support matrix has no blocking task failure. Follow WCAG 2.2 with its criterion-specific exceptions rather than claiming conformance from test count.

### UX-08 · P1 feasibility for phone-led groups · Installable web app and background push

- [ ] Prove stable HTTPS origin, manifest/service worker and install/return on real iOS/Android before building broad mobile features.
  - [ ] Design authenticated subscriptions, per-account/workspace routing, preview privacy, expiry/retry and unsubscribe/revocation.
  - [ ] Decide the push provider/relay dependency and its costs; a sleeping workspace host still cannot serve history.
  - [ ] Test locked/background receive, notification tap, denied permission, stale origin and address-change/reinstall flow.
  - [ ] Keep foreground message delivery and background call ringing as distinct support claims.

**Done:** the named phone configuration receives and opens eligible messages after locking/backgrounding. A responsive layout or a manifest alone does not close this ticket.

### UX-09 · P2 · Inactive-workspace badges and notifications

- [ ] Define a bounded background connection/counts model using each workspace's own session and notification policy.
  - [ ] Keep inactive message history unloaded unless needed; measure 1/3/10 saved-workspace idle budgets.
  - [ ] Route notification taps across workspaces with expired/revoked session handling.
  - [ ] Deduplicate interruptions across windows/devices and back off offline work.

**Done:** a second workspace can surface meaningful activity without cross-account state or unbounded idle cost. Existing switching destroys the previous client.

### UX-10 · P2 · Localization and optional cold offline reading

- [ ] Extract UI strings, locale/plural/date formatting, and verify a second language/RTL with native readers.
  - [ ] Check mixed scripts and input methods during every core change, before claiming a translated interface.
  - [ ] If offline return is required, add a versioned, bounded account/workspace cache with stale markers and logout cleanup.
  - [ ] Reconcile access changes on reconnect; describe limits of revocation while a device remains offline.

**Done:** language and offline support are each validated and explicitly scoped. Existing durable drafts/outbox are retained, not presented as a complete offline history.

### UX-11 · P2, selected by cohort · Polls, events and asynchronous media

- [ ] Choose one observed need: a simple poll, event/RSVP card, or short voice note.
  - [ ] Define close/cancel, vote visibility, author/access ownership, timezone/reminder behavior and later retrieval for coordination.
  - [ ] For voice, add preview/cancel, duration/size bounds, progress/retry, seek/speed and an accessible text alternative.
  - [ ] Scope clips, transcripts and captions separately with consent, language accuracy, processing and storage budgets.

**Done:** one complete coordination/media task improves participation; richer shared tools follow evidence rather than parity pressure.

## 7. Calls and media

### CALL-01 · P1 for call use · Device preflight and useful failures

- [ ] Add microphone/camera selection and audio-output selection where supported; remember safe per-device preferences.
  - [ ] Offer mic test and join-muted choice; handle unplug, default-device change and replacement tracks.
  - [ ] Separate cancelled screen chooser from permission/device/HTTPS failure; camera/share controls currently catch all errors silently.
  - [ ] Surface blocked audio autoplay with an explicit enable-audio action; distinguish playback failure from a connected peer with no incoming media.
  - [ ] Show actionable failure/retry while leaving text chat available.

**Done:** wrong or missing hardware is diagnosable and an actual device switch preserves a two-way call.

### CALL-02 · P1 for WAN calls · Recovery, relay and diagnostics

- [ ] Add connecting/reconnecting/failed states and bounded ICE restart/rejoin with current access checks.
  - [ ] Define participant/session identity, join acknowledgement and signaling for multiple devices before recovery: current signaling is keyed by user. Verify two devices on one account when one leaves/disconnects, so that socket cannot accidentally remove a still-connected call participant.
  - [ ] Provide authenticated expiring TURN credentials and a declared relay recipe when WAN support is promised.
  - [ ] Report selected path and sanitized loss/RTT/bitrate indicators with bounds, preserving metadata privacy.
  - [ ] Test two networks, relay-only, sleep/wake, permission denial and revoked membership; preserve current negotiated microphone/camera/screen slots.

**Done:** bidirectional media and recovery work on the declared network matrix. Public HTTPS sharing and STUN alone are insufficient proof.

### CALL-03 · P2 · Screen choice and foreground direct-call invitations

- [ ] Add a useful desktop screen/window chooser with previews and stop-sharing ownership.
  - [ ] If personal calling is needed, model invite/accept/decline/cancel/busy/timeout/missed/callback across devices.
  - [ ] Enforce contact controls and quiet hours; reuse huddle media and test conflicting device responses.
  - [ ] Treat background ringing as a separate native/OS feasibility gate after UX-08.

**Done:** callers understand whether they entered a room or invited a person, and only the intended source is shared.

## 8. Security, data ownership and integrations

### SEC-01 · P1 before open contact · Personal contact and community safeguards

- [ ] Add DM requests, block/mute and explicit effects on existing DMs, shared-channel mentions, friend requests and calls.
  - [ ] Enforce policy server-side across REST, sockets, search/counts and integrations.
  - [ ] Before open-membership pilots, add reports, scoped moderation queue/actions, reasons and appeal/contact path.
  - [ ] Add channel-limited guests with expiry and clear visible-history boundaries only when required.

**Done:** participants control unsolicited contact and public groups can handle abuse. Workspace friendship already exists; federation is separate.

### SEC-02 · P2, required by organizational pilot · Stronger authentication and policy

- [ ] Add optional TOTP with one-use recovery codes, rate limits, reauthentication and a rehearsed lost-factor flow.
  - [ ] Define who can create/invite/configure apps/moderate beyond existing role/channel/invite rules; retain old workspace intent through migration.
  - [ ] Evaluate passkeys only after stable-origin/RP identity and recovery across independently hosted workspaces are specified.
  - [ ] Add notification-content privacy and test sensitive settings changes against session revocation.

**Done:** stronger sign-in improves safety without turning backup restoration or factor loss into an unowned lockout path.

### SEC-03 · P1 threat-model review · Local storage and Electron privilege boundaries

- [ ] Document browser bearer-token/local draft exposure versus OS-protected desktop credentials; prioritize XSS prevention and meaningful lock/logout cleanup.
  - [ ] Validate sender frame/window and payload for privileged IPC; restrict generic storage keys/capabilities where practical.
  - [ ] Evaluate a restricted asset protocol and applicable Electron fuses with packaged tests; preserve sandbox/context isolation/navigation controls.
  - [ ] Assess encryption only with a clear key/recovery/shared-device model. Do not label plaintext local data alone a demonstrated exploit.

**Done:** trust boundaries are explicit and privileged actions refuse untrusted callers without breaking installed hosting or recovery.

### DATA-01 · P1 for archive-sensitive adoption · Portable logical export/import

- [ ] Define versioned messages/files/users/channels/threads/reactions/permissions manifest with checksums and an honest privacy scope.
  - [ ] Exclude live credentials/signing secrets/queued external actions by default; operational backup remains a separate complete recovery format.
  - [ ] Add progress, cancellation, duplicate-safe resume, limits, safe archive paths and a dry-run report.
  - [ ] Round-trip to a new workspace, checking attribution, private visibility and file integrity without historical notifications.

**Done:** people can leave or move without losing their intended archive or unintentionally transplanting operational authority.

### DATA-02 · P2, promote for switching pilot · First bounded migration adapter

- [ ] Import a Slack public-channel export into a new workspace using DATA-01 primitives.
  - [ ] Preview author/account claiming, channels/threads/reactions, duplicates and missing/expired file links.
  - [ ] Enforce archive/blob limits, fetch protections, resumable progress and source license/access boundaries.
  - [ ] Inventory needed integrations, coexist for one bounded workflow, and rehearse rollback before cutover.

**Done:** migration preserves the declared scope and reports absent content. Do not promise private history or full files merely because a JSON export exists.

### INT-01 · P1 resource review · Scoped bot credentials and bounded capabilities

- [ ] Specify minimally sufficient token scopes/channel controls with backward-compatible existing-app behavior.
  - [ ] Add count ceilings/expiry sweeps to triggers, response URLs and related in-memory capability maps; admission limits alone do not bound all lifetime combinations.
  - [ ] Recheck app/user/channel revocation at use and release resources on every path.
  - [ ] Check denied use, long-lifetime accumulation, restart and delegated visibility without leaking secrets.

**Done:** an app has understandable authority and cannot create unbounded live capability state within allowed request rates.

### INT-02 · P2 · Make integrations operable and explicit

- [ ] Add connection test, bot channel controls, command tryout and one verified CI/monitoring/RSS recipe needed by a pilot.
  - [ ] Show bounded delivery history, queue age, retry/backoff/dead-letter ownership and noise controls.
  - [ ] Produce native API OpenAPI/contract documentation from existing schemas where practical.
  - [ ] Add `views.update` or richer Block Kit inputs only against a tested adapter demand; unsupported controls stay explicit.

**Done:** a non-developer configures one useful integration and diagnoses/retries a failure within its declared compatibility contract.

## 9. Engineering and evidence maintenance

### ENG-01 · P2 as domains are touched · Reduce complexity without a stack rewrite

- [ ] Extract server routes/domain services and client state/actions along existing transaction and event boundaries.
  - [ ] Introduce lint rules for async ownership, hooks and unsafe assertions incrementally.
  - [ ] Typecheck root E2E and scripts where missing; package test TypeScript is already included in package configurations.
  - [ ] Keep query statements, authorization and mutation/publication ordering reviewable; preserve compatibility.

**Done:** touched domains are easier to change and check without changing product behavior or creating a second parallel architecture.

### ENG-02 · P1 ongoing · Keep validation truthful and release checks affordable

- [ ] Maintain a concise current result table keyed by commit/platform/build and a separate historical log.
  - [ ] Build matching artifacts before browser/packaged tests; avoid passing against old output.
  - [ ] Add targeted concurrent-context, crash/restart, access and load cases from confirmed findings; avoid tests that only mirror implementation.
  - [ ] Restore usable CI and use path filters, bounded artifacts and release-only distribution without hiding necessary checks.
  - [ ] Align formatter exclusions with generated desktop `out/` artifacts. The current repository-wide check includes built output unless `.gitignore` is supplied; keep source formatting enforced without reformatting generated bundles or another agent's worktree.
  - [ ] Verify sibling dependency changes against the intended merged baseline before a PR merges.

**Done:** readers can distinguish an executed pass, a blocked job, a controlled source probe and a real-device result.

## 10. Conditional architecture and expansion

| Candidate                        | Gate before implementation                                                                   | Concrete first subitems                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SFU / larger meetings            | OPT-22 demonstrates required call size exceeds mesh envelope; owner accepts relay/media cost | Compare two backends; access/signaling/room limits; bandwidth/cost; failover/observability; supported-client rollout                                   |
| Native mobile                    | UX-08 actual OS/background gaps block a named group                                          | Choose stack; secure per-server credentials; push/call lifecycle; offline limits; upgrades and accessibility; verify distribution cost                 |
| SSO/provisioning/compliance      | Named organization specifies identity/lifecycle/export needs                                 | Stable issuer/account linking; deprovision/revoke; scoped group policy; audit/retention design; operator recovery                                      |
| Federation/global identity       | A use case needs cross-server contact beyond UX-09                                           | Identity and consent; host trust; blocking/revocation; history/conflicts; encryption/moderation; protocol ownership                                    |
| End-to-end encryption            | Participants require confidentiality from the host                                           | Keys/devices/recovery; encrypted attachments; search/bot tradeoffs; metadata; authenticated membership changes; independent security review            |
| Assisted/managed hosting         | Operators cannot own uptime after OPS-06                                                     | Cost/support owner; isolation; backups/upgrades; exit/export path; abuse handling; pilot economics                                                     |
| AI/OCR/transcription/translation | Users name a retrieval/communication task and consent model                                  | Access-scoped inputs; prompt/data exposure; external processing consent; bounded jobs; factual source attribution; evaluation and cost limits          |
| Conversation split/move          | UX-05 prototype shows value beyond optional titles/decisions                                 | Same-channel first; stable links; revision/concurrent composer handling; subscriptions; visible attribution/move trail; cross-channel scope separately |

These are design/research packages, not implicit commitments. Native mobile, an SFU, a hosted service and federation each add ongoing operation; they cannot all be treated as small optimizations.

## 11. Recommended next slices and parallel ownership

1. **Integrity/recovery track:** FIX-01, FIX-05, FIX-06, FIX-07, FIX-11 and dependency FIX-10; handle each in a separate PR. FIX-07 begins with its lifetime contract.
2. **Small user-visible track:** FIX-04, FIX-09, then FIX-02/03. Implement behavior and a focused regression; these can proceed while deeper integrity work is designed.
3. **Performance track:** OPT-01 baseline, demonstrated OPT-10 thread index, OPT-05 row subscriptions, then the measured bottleneck. Keep CPU, memory, cold start, write cost and access correctness together.
4. **Product contract track:** FIX-08 then a narrow UX-01; parallel OPS-02/06 and CALL-01. Promote real-phone/push, moderation/guests or migration according to the selected group.
5. **Release track:** OPS-03/05/08 and ENG-02 before claiming broad reliability; OPS-09 follows trusted releases and rollback.

Codex and Claude can own separate domains, but one owner must hold each contract/migration and the final integration review. Reserve capacity for defect repair and empirical gates; do not publish calendar promises from this inventory.

## 12. Research gates and coverage of previous plans

- [ ] Observe complete join/send/return/find tasks in selected friend/project/community/organization groups. Participation is directional evidence, not a representative market study.
  - [ ] Record unreachable hosting separately from confusing UI, missed notifications separately from unread disagreement, and unavailable file content separately from search ranking.
  - [ ] Include a successor host, low-spec phone and assistive setup in the relevant task matrix.
  - [ ] Compare current and proposed versions on equivalent realistic histories; record failure and voluntary continued use, not only feature clicks.
  - [ ] Publish the declared support mode, device/network sample and go/no-go findings; narrow the claim when a gate fails.

| Previous IDs                           | Current disposition                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R01–08, CU, S, D and R29/R143 findings | Merged closure boundaries above; residual FIX-01–11, OPS-03–05, INT-01 and optimization experiments |
| A01–08                                 | Keep existing auth/access/recovery; SEC-01–03, FIX-07 and data-lifetime review                      |
| U01–08 / roadmap A1–4, A6, A9          | Most UI foundations shipped; UX-06/07/10 and targeted FIX behavior remain                           |
| C01–11 / roadmap A5, A7–8, B1–8        | UX-01–05, FIX-01/02/03/08, DATA-01/02 and conditional conversation repair                           |
| H01–06 / roadmap D3–8                  | CALL-01–03, OPT-22/23; SFU/native breadth conditional                                               |
| O01–08 / roadmap C1–10                 | Registry/startup core shipped; OPS-01–10, DATA-01/02, conditional assisted hosting                  |
| I01–05 / roadmap E6                    | Existing compatibility and durable delivery preserved; FIX-07, INT-01/02                            |
| E01–08                                 | OPT-01–24, OPS-05/08/09, ENG-01/02 and FIX-10                                                       |
| Roadmap A10, D1–2/D9                   | UX-07–10, bounded resources and real mobile/background delivery gates                               |
| Roadmap E1a/E1b/E2–5/E7–8, X01–07      | SEC-01/02, UX-06/11, CALL-03, conditional identity/federation/organization breadth                  |

This coverage is an inspected inventory, not a proof that every possible defect or useful feature has been discovered. Keep findings, rejected optimization experiments and new participant evidence in the plan as work continues.
