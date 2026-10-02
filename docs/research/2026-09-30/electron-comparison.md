# Desktop improvements and optimization research, 30 September 2026

Tandem inspected baseline: `7d91fd3ff676fa88641b7f45f1353d1fd043d441` (`origin/main`, after #149). This is source inspection, two disposable local reproductions, and upstream source research. It is not a new cross-platform installation, power-loss, capacity, or media validation run.

Reference snapshots are pinned so this research can be reproduced:

- [T3 Code](https://github.com/pingdotgg/t3code/tree/ff1db030b179ef712cacc0098366d976e2877f45): `ff1db030b179ef712cacc0098366d976e2877f45`. Read the source-only checkout; did not install dependencies or run its code. Excluded `.repos` from the application comparison.
- [Signal Desktop](https://github.com/signalapp/Signal-Desktop/tree/abe80d32445e53b047b42d10c5b751c4fbfbbfc0): `abe80d32445e53b047b42d10c5b751c4fbfbbfc0`. Read selected SQL and application source through GitHub's API; did not install or run it.
- Electron documentation was also checked at [v44.1.0](https://github.com/electron/electron/tree/v44.1.0/docs), the version declared by Tandem, rather than treating future Electron API changes as defects in the current application.

These repositories demonstrate implementation patterns. No comparative benchmark here shows that either application's choices make Tandem faster. T3 Code is MIT licensed and [requires retention of its notice for copied substantial portions](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/LICENSE). Signal Desktop's [license is AGPL-3.0](https://github.com/signalapp/Signal-Desktop/blob/abe80d32445e53b047b42d10c5b751c4fbfbbfc0/LICENSE). Use Signal as an architectural reference; copying code requires a separate license compatibility decision. An Effect framework migration is not a prerequisite for adapting the patterns below.

## What the latest desktop fixes actually close

| Behavior                                              | Evidence at the inspected baseline                                                                                                                                                                                           | Boundary that remains                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persist recovery hold before restoring                | [hosting.ts](../../../apps/desktop/src/main/hosting.ts), lines 931–971, saves the held entry before calling the restore worker. Failed save refuses restoration; an applicable launch choice is cleared before installation. | Replacing an existing workspace is still an unmerged feature; interrupted filesystem swaps and real power-loss durability need their own recovery contract.               |
| Rehearse away from an existing public forwarding port | Same file, lines 679–737, requests port `0` and rejects default/listed ports. [index.ts](../../../apps/desktop/src/main/index.ts), lines 312–320, applies loopback binding, server isolation and no mDNS.                    | This protects the app's listed/default routes. It does not revoke copied session secrets or constrain software deliberately forwarding a newly discovered rehearsal port. |
| Keep held copies from pruning recovery archives       | `hosting.ts`, lines 1172–1175, skips both copying and retention for held entries.                                                                                                                                            | Backup health and recovery-drill history are not persisted as an operator-facing record.                                                                                  |
| Publish only the run started at launch                | `hosting.ts`, lines 1321–1369, fences resumed public publication by workspace folder and run number; `openToAll`, lines 1582–1587, repeats its run check when the operation takes its turn.                                  | Public-route resume failures can still be hidden by the running UI and tray-only launch.                                                                                  |
| Keep good recovery copies and verify identity         | `hosting.ts`, lines 863–891 and 1091–1126, checks source and snapshot identity and keeps the new verified copy while filling the quota with verified archives.                                                               | Reuse these semantics in the backup catalogue/replacement feature. Do not reinstate filename-only retention.                                                              |

The old statement that all remaining local work is complete is too broad. The remaining items below include source-confirmed local defects, implementable improvements, and explicitly labelled device or failure-injection gates.

## Confirmed local findings and concrete work

### D30-1: show partial startup failure while hosting continues (P1, reproduced)

`reopenPublicAfterLaunch` records `launchError` when the configured address changes or cannot reopen. [HostDialog.tsx](../../../packages/ui/src/components/HostDialog.tsx), lines 1496–1505, renders it only in the stopped branch. The running branch omits it. At OS sign-in, `index.ts`, lines 837–839, creates no window if LAN hosting is running and a tray exists. The tray at lines 624–660 also omits this error.

A disposable DOM probe on this baseline rendered the same error with `running: true` and `running: false`: absent in the running panel, present in the stopped panel. The one probe passed in 115 ms and was removed; it is evidence of current behavior, not a retained regression test. A failure also recorded in `openToAllError` may appear in the public-link panel, so the clearest missing case is the changed-address branch, which only sets `launchError`.

- [ ] Render startup failure independently of hosting phase, with LAN availability stated accurately.
  - [ ] Offer the relevant correction or retry; preserve the matching workspace/run checks.
  - [ ] Give a tray-only sign-in launch visible attention or open its recovery controls when startup succeeds only partially.
  - [ ] Clear the error after the relevant success or an explicit dismissal; unrelated settings writes must not erase it.
  - [ ] Verify changed-address and failed-probe cases while hosting remains available, including a simulated sign-in launch and then an installed-system drill.

Done when the operator can discover and resolve partial startup failure without first stopping a working LAN server. This is a small production behavior change suitable for the next scoped PR.

### D30-2: measure continued reachability for app-owned tunnels (P1, source-confirmed gap)

[tunnel.ts](../../../apps/desktop/src/main/tunnel.ts), lines 621–645, verifies the public instance before reporting an app-owned tunnel open; lines 673–690 detect child-process exit. There is no subsequent HTTP identity probe for that route. In contrast, externally carried routes already poll at lines 418–435 with a default 30-second interval and three-miss tolerance. A live connector process is not sufficient evidence that DNS, routing or the upstream connection still works. A silent live-process outage was not reproduced against real Cloudflare in this audit.

- [ ] Apply a nonoverlapping, bounded reachability check to app-owned routes after opening.
  - [ ] Keep separate facts for connector process health, last verified public reachability, and the address being published.
  - [ ] Tolerate short outages; fence callbacks to the current run and cancel checks on stop/quit.
  - [ ] Provide a persistent degraded-state message and explicit retry. If automatic reconnection is added, bound its backoff and prevent overlapping/orphan connectors.
  - [ ] Exercise wrong-instance responses, timeout, network wake, a transient blip, sustained route failure and recovery from a second network.

Done when a route that stops reaching this instance stops being presented as verified availability within a declared detection window, without a reconnection storm.

### D30-3: make discovered LAN addresses and ownership accurate (P2, source-confirmed)

`index.ts`, lines 177–178, prefers IPv4 but falls back to a raw IPv6 address. [JoinScreen.tsx](../../../packages/ui/src/screens/JoinScreen.tsx), lines 394 and 468–480, interpolates `host:port` without IPv6 brackets. A disposable call to the actual [normalizeServerUrl](../../../packages/client-core/src/api.ts) produced `Invalid URL` for `2001:db8::1:8543`, and `http://[2001:db8::1]:8543` for the bracketed address. It does not establish that the server currently listens successfully on an IPv6-only LAN.

The same Join screen labels a discovery as “hosted here” when its port matches the local host's port, without checking host or workspace identity. Two machines using the default port satisfy that condition. [mdns.ts](../../../packages/server/src/mdns.ts), lines 12–20, advertises name/version/protocol but no stable workspace ID.

- [ ] Introduce a shared address formatter for discovery display, normalization and connection.
  - [ ] Handle bracketed IPv6, valid IPv4 and hostnames; decide supported handling of link-local scope identifiers.
  - [ ] Match local interfaces or verified workspace/instance identity before claiming “hosted here”; do not trust a port number as identity.
  - [ ] Cover two hosts using port 8543, IPv6-only discovery, multi-interface machines, stale advertisements and address changes.
  - [ ] Declare and exercise the actual IPv4/IPv6 listening envelope before claiming IPv6 hosting support.

Done when discovery produces usable addresses for the declared network support and never labels another same-port host as local.

## T3 Code patterns to evaluate for Tandem

### T3-1: cache compilation before loading the packaged main bundle

[compileCache.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/compileCache.ts#L7) enables Node's disk compilation cache in a per-user location and treats failure as optional. [boot.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/boot.ts#L1) loads it before the main bundle. It skips AppImage launches because changing mount paths defeat cache reuse. This is a startup experiment, not a general runtime speedup.

- [ ] Profile Tandem launch into a joined workspace and launch into hosting, separating process startup, module loading, settings, server startup and first usable paint.
  - [ ] Prototype an early bootstrap using the packaged Electron runtime's supported compile-cache API; catch missing API/unwritable cache and continue normally.
  - [ ] Use a private cache location, define expiry/size cleanup, and account for version/architecture changes and AppImage paths.
  - [ ] Compare fresh-cache and repeated launches, including installer upgrades and an unavailable cache.
  - [ ] Disable it for test/coverage runs if it affects coverage precision.

Tandem's entry is currently `out/main/index.js` in [package.json](../../../apps/desktop/package.json). A bootstrap must run before static imports evaluate; simply calling the cache API at the end of `index.ts` misses the initial bundle. Done when repeated launch improvement is measured, first-launch overhead is acceptable, and cache failure cannot block opening or recovery.

### T3-2: bundle ordinary JavaScript once and retain only required runtime externals

[T3's desktop build](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/vite.config.ts#L8) bundles ordinary JavaScript and uses a [shared runtime-external policy](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/scripts/lib/desktop-external-packages.ts#L1) for native addons or packages requiring real filesystem assets. The package stage installs that reduced closure. Its [artifact exclusions](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/scripts/build-desktop-artifact.ts#L944) omit maps, staging duplicates and platform-inapplicable resources.

Tandem's [electron.vite.config.ts](../../../apps/desktop/electron.vite.config.ts) currently bundles workspace server/protocol packages and externalizes real dependencies. Its packaged `app.asar` present during inspection was 17,677,539 bytes; that is an artifact observation, not a fresh build measurement for this audit. No `.map` files were found in the inspected web/desktop build output, so source-map removal has no established current saving here.

- [ ] Inventory the actual installer, ASAR, unpacked files and production dependency closure before changing packaging.
  - [ ] Trial bundling compatible JavaScript dependencies and avoid shipping duplicate bundled/external copies.
  - [ ] Keep native modules and filesystem-dependent assets external/unpacked as required; measure dependency resolution and startup effects.
  - [ ] Preserve notices, required assets and crash-debugging symbols in a deliberate artifact rather than silently stripping useful evidence.
  - [ ] Compare installer size, extraction time, cold/warm startup and all declared OS/architecture smoke scenarios.

Done when a smaller package retains runtime behavior on installed systems and its measured startup does not regress. Do not import T3's dependency list unchanged.

### T3-3: isolate a long-lived backend and supervise its ownership

[DesktopBackendManager.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/backend/DesktopBackendManager.ts#L476) runs a separate backend process, probes readiness, supervises exits and has bounded restart delay. Its stop path sets `desiredRunning` false before clearing restart work. [DesktopBackendPool.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/backend/DesktopBackendPool.ts#L150) ties backend ownership to scoped lifecycle rather than allowing orphan children.

Tandem runs its ordinary server in Electron main; only backup/verify/restore use workers. [VALIDATION.md](../../VALIDATION.md#database-work-and-the-desktop-window) records corrected 200,000-message search, concurrent-reader and retention stalls above its 100 ms budget. Process isolation can protect window responsiveness even when it does not make SQL faster.

- [ ] Reproduce and profile the budget overruns on target hardware before selecting worker threads, `utilityProcess`, or a separately spawned backend.
  - [ ] Prototype the hosting-controller boundary without changing the REST/WebSocket participant contract.
  - [ ] Keep one owner for the database, public route, queue timers and discovery; tie IPC responses and exit callbacks to a run generation.
  - [ ] Add readiness failure, bounded supervised retry, stop cancellation and orphan-process recovery without repeatedly activating held copies.
  - [ ] Preserve backup coordination, shutdown drains, chosen ports, startup intent and app-owned tunnel lifetime.
  - [ ] Compare UI stall percentiles, end-to-end request latency, memory overhead and crash recovery under mixed load.

Done when the declared responsiveness budget holds with no duplicate server, duplicated outbound work or lost accepted send. T3's two-second termination grace is not Tandem's data-durability contract. Its `ELECTRON_RUN_AS_NODE` backend also means its security-fuse choices cannot be copied blindly.

### T3-4: temporarily avoid hidden startup throttling, then restore it

[DesktopWindow.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/window/DesktopWindow.ts#L408) boots a hidden renderer unthrottled, then [restores background throttling at first reveal](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/window/DesktopWindow.ts#L813). Tandem normally creates a visible window immediately, and already avoids creating a window after successful tray-only sign-in, so this pattern is conditional on a first-paint change.

- [ ] Compare the existing immediate window with a hidden-until-ready window and a bounded load-failure fallback.
  - [ ] If hidden startup delays the first usable paint, temporarily unthrottle only that startup interval.
  - [ ] Restore background throttling immediately after boot; keep hidden/minimized CPU and battery budgets.
  - [ ] Verify first reveal on Windows, macOS and Linux, plus loading errors and a permanently hidden sign-in launch.

Done when first usable paint improves without leaving hidden renderers continuously expensive. Disabling throttling permanently is not the recommendation.

### T3-5: recover a failed renderer without resetting the hosted workspace

[T3's renderer recovery](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/window/DesktopWindow.ts#L775) watches `render-process-gone`, logs the reason and bounds reload attempts. Tandem's main process has no corresponding recovery handler.

- [ ] Add a visible recovery path for renderer crash/OOM/load failure while keeping the server and public route owned.
  - [ ] Rehydrate the latest durable outbox, drafts and route; reconcile accepted sends with existing nonces.
  - [ ] Bound attempts and provide an actionable fallback after repeated boot failure.
  - [ ] Verify crash during a send, hosting, restore progress and an active huddle; do not silently restart the backend as a side effect.

Done when a renderer failure leaves an understandable path back to the workspace and preserves durable client work. This is resilience work; reducing the underlying memory leak remains separate.

### T3-6: use typed IPC boundaries and verify the built preload

[DesktopIpc.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/ipc/DesktopIpc.ts#L217) decodes unknown payloads and encodes results. Some privileged [snapshot methods check sender ownership](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/ipc/methods/snapShot.ts#L34). Its [preload verifier](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/scripts/verify-preload-bundle.mjs#L119) checks allowed sandbox imports and executes the bundled bridge in a controlled verification environment. Its [bundle regression](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/scripts/main-process-bundle.test.mjs#L10) checks that worker/lazy-import output does not reexecute startup.

Tandem's main process validates the sender for window reveal/deep-link consumption, but most settings and hosting handlers lack that check. The preload exposes generic storage keys. Existing sandboxing, isolation, disabled Node integration, CSP and blocked navigation reduce the exposed surface; this audit demonstrated no remote privilege escalation. Electron's [v44 security guidance](https://github.com/electron/electron/blob/v44.1.0/docs/tutorial/security.md#17-validate-the-sender-of-all-ipc-messages) supports closing this defense-in-depth gap.

- [ ] Establish one trusted-main-frame sender guard for privileged IPC and apply it consistently.
  - [ ] Validate payloads and result contracts; restrict generic renderer storage to supported client keys or expose dedicated operations.
  - [ ] Reject unauthorized frames/windows before dialogs, credential decoding or hosting mutations.
  - [ ] If bundling changes, verify the packaged preload under sandbox rules and verify worker output cannot execute desktop startup twice.
  - [ ] Evaluate a restricted asset scheme and applicable fuses against packaged behavior, downloads, media and the selected backend architecture.

Done when callers outside the intended renderer cannot invoke privileged operations and packaged artifacts retain a narrow, functional bridge. Adopt contract/ownership checks without requiring T3's entire Effect layer graph.

### T3-7: keep diagnostics bounded and cheaper when idle

[DesktopTelemetryPublisher.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/telemetry/DesktopTelemetryPublisher.ts#L125) samples at different intervals according to diagnostic demand, battery/idle/thermal state and uses sliding queues for recent snapshots. [DesktopObservability.ts](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/app/DesktopObservability.ts#L275) rotates output logs. Tandem already has a user-previewed [diagnostics report](../../../packages/ui/src/lib/diagnostics.ts), but lacks detailed hosting/query/backup health.

- [ ] Extend local diagnostics with app/runtime versions, process resource use, loop stalls, hosting/public-route state and backup freshness.
  - [ ] Collect expensive metrics on demand; cap recent samples/log bytes and make idle sampling cheap.
  - [ ] Keep logs free of messages, credentials, tokens and raw connector secrets, with an explicit preview/export action.
  - [ ] Coalesce replaceable status snapshots; never drop durable messages, app jobs or backup actions through a sliding queue.
  - [ ] Measure diagnostic overhead and idle CPU with the panel closed/open and after closing to the tray.

Done when support gains useful bounded evidence without an unrequested remote telemetry service or continuous high-rate polling.

## Signal Desktop patterns for database work

[MainSQL](https://github.com/signalapp/Signal-Desktop/blob/abe80d32445e53b047b42d10c5b751c4fbfbbfc0/ts/sql/main.main.ts#L322) routes ordinary reads to workers, retains paging on a designated connection and routes writes to the primary. Its [worker](https://github.com/signalapp/Signal-Desktop/blob/abe80d32445e53b047b42d10c5b751c4fbfbbfc0/ts/sql/mainWorker.node.ts) measures actual SQL execution time. The controller [records cumulative/max timings and slow queries](https://github.com/signalapp/Signal-Desktop/blob/abe80d32445e53b047b42d10c5b751c4fbfbbfc0/ts/sql/main.main.ts#L555); it [terminates secondary workers before the primary](https://github.com/signalapp/Signal-Desktop/blob/abe80d32445e53b047b42d10c5b751c4fbfbbfc0/ts/sql/main.main.ts#L487).

- [ ] Add named query timing and queue-delay measurement to Tandem's capacity experiments before introducing a pool.
  - [ ] Separate time spent waiting for a worker, executing SQLite, serializing results and delivering them to the UI.
  - [ ] If a pool is warranted, bound admission and response maps, use one write owner, and define read-after-write/snapshot behavior explicitly.
  - [ ] Keep pagination/snapshot operations on the connection that owns their state; coordinate WAL checkpoints and shutdown.
  - [ ] Compare a single isolated backend against a small read pool at the intended message and attachment sizes.

Done when the chosen topology meets measured latency/stall budgets and authorization, transaction, scheduler and migration behavior remain intact. Signal's four-worker count and 40 ms logging threshold are reference choices, not Tandem defaults. A worker pool adds memory and connection/locking complexity; moving the existing server off Electron main may solve the window problem with less change.

## Recovery, OS integration and release tasks that remain

- [ ] **Finish verified backup browsing and confirmed replacement.** The `feat/replace-from-backup` worktree at `c85132b` contains six uncommitted files and is not shipped.
  - [ ] Port its feature onto current main with one owner; its old replacement lacks the current persisted hold/inventory, and its retention helper reinstates the superseded filename-only algorithm.
  - [ ] Catalogue verified ID, schema, creation time and recoverability; keep unverified/damaged entries clearly distinct.
  - [ ] Require a stopped target, verify matching identity, persist hold before installation, clear auto-start, preserve the superseded original and expose inventory/rehearsal/activation.
  - [ ] Regress wrong ID, incompatible schema, unreadable settings, interruption, failed staging and queued work/session behavior while preserving #126/#127/#141/#146.
  - [ ] Done when a nondeveloper can safely choose, replace, inspect, activate and undo a recovery copy without erasing the original.
- [ ] **Persist backup health and demonstrate recovery.** `hosting.ts:382` stores failures only in memory; `lastBackupAt` and schedule `lastAt` do not represent a completed restore drill.
  - [ ] Persist last attempt, success, verified destination/path and actionable failure category; show overdue/offline-destination failures outside an easily missed dialog.
  - [ ] Choose recovery-point and recovery-time targets, then restore on a fresh machine with the original offline and check identity/messages/files/memberships and app/job/session inventory.
  - [ ] Record verified-copy status and real-drill status separately; consider encrypted/off-machine copies when the workspace's threat/recovery needs require them.
  - [ ] Done when the operator can tell whether a usable copy exists and a dated drill meets the chosen targets.
- [ ] **Make long recovery operations observable and recover interruption.** `index.ts:275–294` has worker completion/error/exit handling but no progress/cancellation/deadline. Serialized shutdown waits behind accepted operations. `backup.ts:394–397` swaps two directory names and rolls back caught exceptions; abrupt process loss is a separate case.
  - [ ] Add progress and safe cancellation before installation, with a journal or other deterministic staged/superseded-folder reconciliation.
  - [ ] Define ownership and recovery after each copy/verify/rename boundary, disk-full, worker exit and settings-write failure.
  - [ ] Keep active database writes/swap ownership intact; do not enforce a deadline by closing the database underneath a handler or killing installation mid-swap.
  - [ ] Done when interruption leaves either the verified original or a held verified replacement discoverable, with no silent ordinary activation.
- [ ] **Exercise real OS shutdown and sign-in.** The application drains on `before-quit`, but Electron v44 [does not emit that event on Windows logout/restart/shutdown](https://github.com/electron/electron/blob/v44.1.0/docs/api/app.md#event-before-quit). No `query-session-end`, `session-end` or power shutdown handling is present.
  - [ ] Define best-effort shutdown handling per OS and rely on durable/crash-recoverable state for forced termination, including a tray-only Windows process with no window.
  - [ ] Run installed Windows and signed/notarized macOS login registration, disable/approval, logout/reboot, sleep/wake, network change and public-route resume drills.
  - [ ] Keep Linux login support explicitly absent unless an intentional `.desktop`/service strategy is implemented; Electron's login-item API is macOS/Windows-specific.
  - [ ] Done when the guide accurately distinguishes app quit, user login, OS shutdown and unattended service hosting, with dated machine evidence.
- [ ] **Build a deliberate distribution and upgrade path.** [electron-builder.yml](../../../apps/desktop/electron-builder.yml) declares NSIS, DMG, AppImage and DEB targets; the desktop workflow exercises Windows. Target definitions are not verified installation evidence. No release workflow or updater is implemented.
  - [ ] Declare supported OS/architecture/minimum-version matrix; publish matching installer/server/container artifacts, checksums, notices, SBOM and schema/backup compatibility metadata.
  - [ ] Exercise clean install, upgrade, uninstall with data retained, protocol registration, firewall/LAN, tray/dock, media permissions, notifications and secure-store continuity.
  - [ ] Test downgrade/rollback using a compatible preserved backup rather than reopening a newer schema with an older server.
  - [ ] Add authenticated updates only after artifact trust, migration backups, graceful drains, interruption handling and rollback policy are concrete; test the pinned updater/library version rather than assuming latest documentation applies.
  - [ ] Done when a user can install and recover the declared release on each supported platform without a developer environment.

## Recommended order and stale claims to reconcile

1. Close D30-1 and D30-3 in small scoped changes; keep D30-2's route semantics explicit.
2. Add bounded local diagnostics and query/startup measurements, then select compile-cache/bundling experiments from actual costs.
3. Port backup catalogue/replacement with the current safety invariants and interruption recovery; complete the fresh-machine drill.
4. Decide backend isolation against target-machine measurements, with database ownership and lifecycle already specified.
5. Produce installable releases and complete real OS/device/network validation; consider updates after that foundation.

[REMAINING-WORK-2026-09.md](../../REMAINING-WORK-2026-09.md) calls O04 done and says nothing ordinary exceeded 100 ms. Corrected measurements in `VALIDATION.md` show common-word/phrase search around 220–240 ms, twenty readers 337 ms and retention 150 ms at 200,000 messages on one Linux machine. Backup workers are implemented; that does not settle the broader isolation decision. O01's missing older-backup list/replacement and E07's missing distribution workflow remain accurate. A generic “all local work is merged” status should give way to explicit evidence and the local tasks above.
