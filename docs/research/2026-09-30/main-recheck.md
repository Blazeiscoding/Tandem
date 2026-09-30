# Full recheck of current main

**30 September 2026 · inspected and reproduced against `6a95898132167c7761216601399bc7d8fe590961` (`origin/main`, after #166).** This recheck includes fresh automated validation and adversarial probes of production code. It supplements the earlier repository comparisons; it does not replace their historical measurements. Implementation tasks are in [section 13 of the update plan](../../UPDATE-PLAN-2026-09-30.md#13-confirmed-follow-ups-from-the-full-recheck).

An isolated worktree was created from fetched main. The existing `.claude/`, `.audit-client-143/` and other worktrees were preserved. No competitor application was installed or benchmarked during this recheck. Source review and passing tests cannot establish that every defect has been found.

Implementation and evidence are delivered in [PR #167](https://github.com/Blazeiscoding/SlackOSS/pull/167), product candidate `60b097d38760cffd30acf02340cb8d4097670aa0`. Later documentation-only edits do not change that tested product code.

## Verification and its boundaries

Host: Windows 11 Pro `10.0.26300`, x64; Node `24.16.0`, pnpm `10.23.0`, TypeScript `5.9.3`, Electron `44.1.0`, Playwright `1.63.0`. Node reports SQLite `3.53.0` and bundled Undici `7.25.0`; these are runtime inventory, not assurances supplied by the npm audit.

| Check                                           | Fresh result                                                                              | Scope or limit                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen dependency installation                  | Passed                                                                                    | Isolated worktree; actual pinned lockfile                                                                                              |
| `pnpm exec turbo typecheck build --force`       | 10/10 tasks, no cached results                                                            | Seven typechecks and three builds, including CLI                                                                                       |
| `pnpm exec turbo test --force`                  | 1,294 passed, two skipped; all six tasks passed                                           | Server 486, client-core 110, UI 494, protocol 26, desktop 178; sixth task builds web                                                   |
| Skipped cases                                   | Windows symlink case; opt-in row timing harness                                           | A separate real NTFS junction ownership probe passed; row timing was not remeasured                                                    |
| `pnpm test:e2e`                                 | 18/18 passed                                                                              | Fresh built CLI and browser client, Chromium; fake media and emulated viewports                                                        |
| `pnpm --filter @slackoss/desktop package --dir` | Passed                                                                                    | Fresh Windows x64 unpacked artifact; successful packaging is not installed/signature verification                                      |
| `pnpm test:desktop`                             | First two scenarios passed; third failed at fixture deletion                              | EPERM while deleting an enabled backup destination after manifest creation; completion had not been awaited                            |
| Corrected desktop scenario                      | 1/1 passed                                                                                | Test waits for completed backup status and defers destination cleanup until app shutdown; subsequent complete candidate run passed 3/3 |
| Entry budget                                    | Web 472.8 kB; desktop renderer 474.3 kB                                                   | Both below 500 kB; initial builds at the audited baseline                                                                              |
| `pnpm audit --prod --json`                      | Zero reported vulnerabilities                                                             | Dependency database result; not a complete runtime or application security audit                                                       |
| `pnpm audit --json`                             | Three package entries: one low, two moderate; zero high/critical                          | Two distinct advisories; build/test dependencies below                                                                                 |
| Offline Compose checks                          | Three cases passed                                                                        | Default ICE setting, legacy variable and current-variable precedence; extracted unchanged checks from `tests/docker-smoke.mjs`         |
| Docker image/container smoke                    | Not run                                                                                   | Docker CLI exists but the Linux engine pipe is unavailable; configuration checks do not validate an image/container                    |
| Native T3 browser smoke                         | Registered a disposable owner, sent a message, reloaded, retained message at 390 px width | DOM checks showed document width 390 px; snapshot capture failed twice, so no screenshot/visual certification is claimed               |

The WebSocket guard added by this recheck passed 59 focused cases and server typechecking. After it, the complete server suite passed 487 tests with one Windows skip, and forced typecheck/build again passed all ten tasks without cache. Chromium E2E again passed 18/18 against the rebuilt CLI/web. After a fresh package build including the guard and the cleanup correction, all three Windows smoke scenarios passed. Both entry budgets remained 472.8/474.3 kB. See [validation](../../VALIDATION.md). Baseline unit counts above must not be confused with the candidate's added regression; unchanged product packages were not retested unnecessarily. The exact handle causing the first cleanup EPERM was not identified.

Prettier is checked against source using both `.prettierignore` and `.gitignore`; generated desktop `out/` files are not source formatting failures. Existing Zod pure-annotation warnings appeared in successful builds. CI runs and local runs are separate evidence; account/job-start restrictions must not be reported as executed test failures.

Final source formatting, `git diff --check`, and all 72 local file/heading links in the five updated documents passed. For the product candidate, GitGuardian passed; [Checks](https://github.com/Blazeiscoding/SlackOSS/actions/runs/36752178270), [Desktop](https://github.com/Blazeiscoding/SlackOSS/actions/runs/36752178305) and [Container](https://github.com/Blazeiscoding/SlackOSS/actions/runs/36752178117) were marked failed because their job annotations say account payments/spending restrictions prevented them from starting. No CI test execution or container pass is claimed. Restore independent CI execution under ENG-02 when account capacity is available; local validation does not remove the unexecuted platform gates.

## Coverage and repairs preserved

| Domain                     | What was inspected or exercised                                                                                                                                                                                     | Result and remaining boundary                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server/protocol/CLI        | HTTP and upgrade boundaries, authentication/access and replay paths, read predicates, scheduling/retention, message nonce records, queued integration redaction, migrations/rollback copies, ownership and shutdown | Original repairs remain present. New upgrade, retention, recovery and broadcast-unread findings below                                                                                             |
| Client-core/UI             | Pending sends, storage migration/merges, draft and composer timing, optimistic mutations/echoes, read/notification predicates, row subscriptions, request cancellation, history/file bounds and media teardown      | Existing-key outbox merges, channel preference serialization, channel/thread/cover-aware notification logic and narrow subscriptions remain. Additional initialization/input/ordering cases below |
| Desktop                    | Settings queue/bridge, backup worker lifecycle, restore staging, registry/ownership, partial startup visibility, discovery, shutdown, packaging and smoke scenarios                                                 | Real Windows junction aliases share the writer lock. Restore failure and production shutdown retry need follow-ups                                                                                |
| Web/deployment/engineering | Fresh served client/CLI, build outputs/budgets, dependency inventories, Compose interpolation, container/packaging configuration, workflow coverage and plan/status links                                           | Container execution, actual installation and independent platform/device validation remain gates                                                                                                  |

Keep these completed fixes closed: #151's set-based/yielding retention and error capture; #152's protected current upgrade copy; #153's exclusive writer hold; #154's partial startup error display; #155's URL formatting/instance identity; #156's serialized channel preferences and older-failure protection; #157's channel/thread/cover-aware notification suppression; #158's in-range dependency patches; #160's composite thread index; #161's queued text redaction; #162's existing-key per-nonce desktop merge and refusal propagation; #163's quiet-reply read agreement; #164's narrower row subscriptions; #165's indexed mentions and migration/mutation maintenance. Their prior timing measurements were not repeated here. Notification suppression intentionally treats the foreground conversation as viewed even when its timeline is scrolled back; it is not a measured pixel intersection.

An original fixed reproduction and a newly failing adjacent case are separate work. For example, the protected current upgrade copy survives the corruption probe, and both quiet-reply cursors and the broadcast explicit-unread edge can coexist.

## Confirmed findings and reproduction recipes

All probes used disposable data. Original scripts/logs are retained locally under `.git/recheck-20260930/{server,client,desktop}/`; the recipes and normalized results here are the durable review record. A successful probe exit means its assertions reproduced the stated behavior, not that the behavior was correct. Fault injection, production-helper execution, actual loopback I/O and real process exit are distinguished below.

### RECHECK-01: unauthenticated malformed upgrade terminates the server

**P1; fixed in this recheck.** At [gateway.ts](../../../packages/server/src/gateway.ts), the raw HTTP `upgrade` listener parsed the request target before any limiter/authentication and without a catch. Start a source server in a separate Node child, verify `/api/health` is 200, then send a raw TCP upgrade with target `http://[::1/ws` and ordinary WebSocket headers. The child emitted uncaught `ERR_INVALID_URL` and exited 1, with no response. No account or token was used. The direct listener was exercised; a reverse proxy can reject the malformed target before it arrives.

The guard now closes only that connection on URL parse failure. [socketTargets.test.ts](../../../packages/server/test/socketTargets.test.ts) exercises malformed absolute/protocol-relative IPv6, an invalid percent host and a wrong percent path; verifies health after each; then registers and authenticates a valid `/ws?client=regression` socket. It runs the server separately so an uncaught exception cannot be hidden by the test runner. Normal routing, admission and authentication are retained. No global exception handler was added.

### RECHECK-02: first-read initialization overwrites an acknowledged desktop send

**P1; production storage/helpers, controlled interleaving.** [workspaceStorage.ts](../../../packages/ui/src/lib/workspaceStorage.ts) reads a new scoped key and later writes its migrated/absent envelope. Those writes bypass the atomic outbox merge. Use two adapters backed by actual `createSettingsStorage` and `mergeOutboxSetting`. Pause B after its first read captures null. Let A initialize and await a merged write containing nonce `accepted-by-a`. Resume B; its absent-value initialization replaces A's committed envelope. B's empty merge leaves the persisted outbox empty.

Observed: acknowledged `[accepted-by-a]` → `[]` after B initializes → `[]` after B flushes. No crash or actual Electron IPC was simulated; the production file storage and helpers were executed. A can close normally after its acknowledged write. #162's existing-key atomic merge remains correct; initialization needs the same shared transaction.

### RECHECK-03: a fresh send has no persisted draft fallback when its save fails

**P1; production React persistence component in jsdom, injected write failure.** Mount actual `DraftPersistence`; call the production client's set-draft, send and clear-draft operations corresponding to Composer's handoff before its 600 ms timer; reject the outbox storage write. After 750 ms, persisted draft is `{}`, persisted outbox is `[]`, and client draft state is empty. Text is still in the in-memory pending send and the actionable saving warning is visible. Actual Composer keyboard interaction was not mounted in this probe.

This is not an acknowledged durable write or a silent disappearance during the live session. It establishes there are no saved bytes to recover at that captured state; process death itself was not executed. The existing #162 regression first saves the draft and correctly protects that case. Preserve current words before composer clearing, define the pending acceptance boundary and exercise this fresh-input path separately.

### RECHECK-04: drafts in different conversations overwrite across windows

**P1/P2; production React component in jsdom with shared storage.** Two `DraftPersistence` instances restore an empty legacy account/address draft key (workspace ID unset). A edits conversation `C_A`, B edits `C_B`; wait for both draft timers. Both texts remain in their respective memories, but persisted object contains only `C_B`. Draft writes replace the complete local object; the outbox's merge does not protect drafts. The stable-workspace-ID path uses the same whole-object write, but its address gate was not exercised. Require per-draft updates and a same-conversation conflict rule. No multiple browser processes were launched for this probe.

### RECHECK-05: reordered successful DND/pin/save updates defeat latest intent

**P2; actual authenticated loopback server and production client, controlled forwarding.** Hold the first request before it reaches the real server, let the second succeed, then forward the first successfully. DND soon→later ends at soon on both server and UI. Pin false→true→false and Saved false→true→false each end true on both server and UI. Separately reject both pin requests, then both Saved requests, before either reaches the server: the UI ends true while each authoritative server value remains false.

In [workspace.ts](../../../packages/client-core/src/workspace.ts), latest-only rollback guards an older failure, but does not serialize success or retain a separate confirmed value for the two-failure case. Server echoes apply the older successful operation as authoritative. Preserve #156's original guards; add confirmed/in-flight/queued intent and echo reconciliation, or a defined server revision contract.

### RECHECK-06: tombstone eviction permits very stale send resurrection

**P1/P2 contract boundary; production pure merge.** Discard nonce A, apply 500 newer terminal nonce removals, then merge A's old entry. A is stored again; the map still has only 500 tombstones. [outbox.ts](../../../packages/client-core/src/outbox.ts) intentionally limits this history. This was not an actual frozen browser-window reproduction. It disproves the plan's unconditional permanence wording; decide supported staleness and checkpoint/epoch rules before pruning a guard, rather than merely increasing a number.

### RECHECK-07: corrupt pre-upgrade candidates displace a valid older copy

**P1; real SQLite corruption and upgrade.** Create two v30 managed copies with intact schema/identity plus a valid v29 copy. In each v30 copy, query `sqlite_schema` for the `messages` root page, read the database page size, and zero that page's bytes while leaving metadata pages intact. Both corrupt copies report v30 and this workspace, while `PRAGMA quick_check` and reading history throw `database disk image is malformed`. Upgrade the live workspace v30→v31. Both corrupt candidates remain; the valid v29 copy is pruned; the new current copy and live message survive.

[db.ts](../../../packages/server/src/db.ts)'s `isRestorableCopy` checks schema/identity, not database integrity. Preserve #152's protected current copy. Candidate validation must occur before a copy can displace another rollback point; size/cost and older-schema compatibility need an explicit policy. SQLite documents that integrity checking does not substitute for [foreign-key checking](https://www.sqlite.org/pragma.html#pragma_integrity_check); choose and measure both checks as appropriate.

### RECHECK-08: retention erases nonce identity and permits an old send again

**P1 contract; real authenticated HTTP and retention.** Post a message with a fixed nonce and receive 201; make it old enough and run retention; retry the same nonce and text. Response is 201 with a new message ID and the original words. Soft-delete control instead refuses the same retry with 409 `message_deleted`. [store.ts](../../../packages/server/src/store.ts) purges `message_requests` along with message history.

This is a retry after hard purge, not simultaneous duplicate requests. Define nonce lifetime relative to offline/outbox staleness and preserve text-free terminal identity or visibly reject expired retries. Coordinate with RECHECK-06; do not retain deleted content merely to remember its identity.

### RECHECK-09: retention leaves connected unread state stale

**P2; authenticated HTTP plus an actual reader WebSocket.** Reader first receives mention count 1. Purge that old mention with `applyRetention`; authoritative count becomes `{}` and Activity has no matching item. The socket receives no post-purge count or invalidation frame, so its last live count remains 1. [server.ts](../../../packages/server/src/server.ts) intentionally emits nothing for retention. Reconnect or a later recount can reconcile it. Add a bounded maintenance refresh and invalidate relevant cached views without broadcasting one event per removed message.

### RECHECK-10: restore staging failure leaks ownership in a continuing process

**P1 recovery; exported API and actual worker, injected ENOSPC.** [backup.ts](../../../packages/server/src/backup.ts) acquires ownership, awaits staging `mkdtemp`, and only then enters cleanup protection. Inject one ENOSPC at that call. Restore rejects, the original database remains at its path and no swap is attempted; a subsequent hold in the same continuing process fails `workspace_in_use`, purpose `a restore`. The probe checked file existence, not a byte checksum; original-byte verification is a completion criterion for the repair.

The actual desktop one-job worker posts its error before teardown. Reacquisition at that message still fails; after worker exit 0 it succeeds. This demonstrates a reply-before-exit window in desktop and an unreleased handle in the exported API; it does not demonstrate a permanent Electron lock. Cover all failures after ownership acquisition and ensure cleanup completes before a retry is accepted. Interrupted two-rename swaps remain separate OPS-03 work.

### RECHECK-11: production shutdown cannot retry its failed drain

**P1 recovery; production server with one injected gateway-close rejection.** Call `stop()`, then call it again after the failure. Both return the same rejected promise, gateway close ran once, and workspace ownership is still held by `a server`. [server.ts](../../../packages/server/src/server.ts) caches `stopping` even on rejection, whereas the desktop controller clears its failed promise and presents retry. Its existing retry test uses a server mock that rejects once.

This is a controlled recovery failure, not an ordinary shutdown outage observed here. Track completed drain stages and safely resume unfinished work; simply clearing the promise could repeat unsafe stages. Keep ownership until remaining database users stop. Deadlines and forced-exit reconciliation remain OPS-04.

### RECHECK-12: explicitly unread broadcast reply still appears read

**P2 communication contract; real authenticated HTTP/store.** Read a broadcast mention through its channel. POST thread/unread at that reply: HTTP 200, following true, thread cursor 4 and newest sequence 5. Nevertheless mention counts are `{}`, Activity Unread is empty and followed `unreadOnly` is empty, immediately and after another channel-read. The channel cursor still satisfies the broadcast OR rule in [store.ts](../../../packages/server/src/store.ts).

The ordinary broadcast read rule and explicit thread-unread promise need a precedence decision. #163's quiet-reply separation remains correct; the plan's blanket statement that explicit thread-unread survives an advanced channel cursor was too broad. Decide an override/cursor design and keep server counts, Activity, Threads and the client predicate aligned.

## Dependency and runtime follow-through

The fresh all-dependency audit reports esbuild `0.27.7` through CLI `tsup` for [GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr), patched at `>=0.28.1`: its Windows development-server file-serving path is the advisory's condition. Vitest and `@vitest/mocker` `3.2.7` account for two entries of [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9), patched in `4.1.11`; the advisory distinguishes public mocker/interceptor development-server plugins from authenticated browser-mode RPC. Gatherline's current scripts run Vitest in Node/jsdom, not those exposed plugins. No shipped exploit path was demonstrated for either finding. Keep FIX-10's dependency-major tasks open and verify build/test compatibility before replacing their toolchains.

Production npm audit does not cover Node/Electron's embedded libraries, signed artifact/feed trust, application authorization or actual distribution. Preserve runtime inventory, update/rollback and release evidence tasks under FIX-10, SEC-03 and OPS-08/09.

## Remaining research and empirical gates

Source-confirmed unfinished work includes durable backup/retention health, restore swap interruption recovery, backup-worker progress/cancellation/deadlines, production shutdown deadlines, scheduled-drain error handling, managed-route ongoing verification, privileged IPC sender validation, aggregate socket/capability-map ceilings and physical-disk reserve. These have not all been reproduced as failures; retain their existing OPS/SEC/INT/OPT tasks rather than calling them new outages.

Client work still includes conditional message edit conflicts, trusted-address message-link navigation, actionable camera/share failure and audio-autoplay recovery, active decoded-image accounting and successful mixed-workload profiling. Bounded history/cache counts do not bound all active media memory. Keep actual code/measurement requirements for optimization tasks.

External gates remain Docker execution; actual OS installation/sign-in/shutdown/logout/sleep/wake; macOS/Linux packaging; network-share ownership; IPv6-only/dual-stack hosting; physical phone and assistive technology tasks; real multi-process storage death/reordering; old-client/account/logout compatibility; WAN/TURN/media permission/device-change and route-failure drills; older-binary restore and power-loss recovery. Passing fake-media/E2E or a fault-injection probe does not close these gates.
