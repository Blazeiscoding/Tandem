# Desktop hosting and operations audit — 27 September 2026

**Status reconciled on 29 September:** This is the historical 27 September audit. Use the [updated execution plan](../CODE-AUDIT-AND-EXECUTION-PLAN-2026-09-27.md#verified-update-claudes-september-29-work) for current evidence against `c85132b`. [PR #117](https://github.com/Blazeiscoding/SlackOSS/pull/117) closed D1. PRs #121–#124 merged local startup/network refresh, backup workers, connection/port controls and scheduled backups; they are no longer dirty worktree changes. The backup-worker portion of D6 is implemented, while the operating envelope remains partial. D2 and D3 were reproduced again, and R29-1–R29-8 record new retention, freshness, startup and measurement issues. Original source line numbers and test counts below remain historical. GitHub Actions for #117 did not start because billing/payment or a spending limit blocked them; local checks are not a hosted CI pass.

Scope: the inspected working tree of `apps/desktop`, its embedded server/backup
contracts, `docker/`, release workflows, desktop tests, and operational docs.
This includes the uncommitted hosting, rename and start-at-login changes present
on 27 September. It is a code audit and implementation plan, not evidence that
a remote phone or the specific recovery failure scenarios below were exercised.

The desktop unit suite passes **123/123**, `@slackoss/desktop` typecheck
passes, and the packaged Windows desktop E2E suite passes **2/2** (run in the
same checkout during this audit). These checks include registry adoption,
rename, backup/restore basics, tunnel failures and startup choices. No
finding below is inferred from a failed test. Risk statements distinguish a
demonstrated code path from the external condition needed to trigger it.

## What is already built and should be preserved

- A folder-independent hosted-workspace registry and legacy-folder adoption
  avoid name-slug collisions; a new name creates a new folder. Reopening and
  renaming an entry with an ID check its database identity
  ([registry.ts](../../apps/desktop/src/main/registry.ts),
  [hosting.ts](../../apps/desktop/src/main/hosting.ts#L523)).
- The server backup takes a SQLite `VACUUM INTO` snapshot, copies the
  attachment inventory that snapshot references, hashes each file, and checks
  database integrity, foreign keys and row counts. Restore verifies a staged
  copy before swapping it in
  ([backup.ts](../../packages/server/src/backup.ts#L136)).
- The controller serializes hosting operations, refuses a restore over a
  still-present listed workspace, and checks available destination space
  ([hosting.ts](../../apps/desktop/src/main/hosting.ts#L669)).
- A public link is published only after a health probe identifies the current
  server instance. The controller cancels an opening during stop/quit and
  clears public URL and proxy trust when it closes
  ([tunnel.ts](../../apps/desktop/src/main/tunnel.ts#L133),
  [hosting.ts](../../apps/desktop/src/main/hosting.ts#L1018)).
- Opt-in host-at-app-start, OS login registration on packaged Windows/macOS,
  tray behavior, and re-announcement after wake/address changes exist
  ([index.ts](../../apps/desktop/src/main/index.ts#L379),
  [index.ts](../../apps/desktop/src/main/index.ts#L754)).

## Findings, ordered by consequence

### D1 — An older desktop can silently replace a newer registry (P1, confirmed path)

This was fixed in PR #117; the following records the original failure path.

`parseRegistry` returns an empty list when the registry version is anything
other than `1` ([registry.ts](../../apps/desktop/src/main/registry.ts#L56)); the
test explicitly expects version `2` to become `[]`
([hosting.test.ts](../../apps/desktop/test/hosting.test.ts#L952)).
`loadRegistry` then treats this as a usable empty list. If it finds existing
workspace folders, adoption itself saves version `1` over the original
setting; a new start also does so
([hosting.ts](../../apps/desktop/src/main/hosting.ts#L426),
[hosting.ts](../../apps/desktop/src/main/hosting.ts#L543)). On downgrade after a
future registry-format change, entries can disappear from the list and the
newer registry can be overwritten. The workspace folders are not deleted by
this path, so this is an access/recovery and compatibility risk rather than a
claim of immediate message deletion. `startForLaunch` can also drop a selected
folder when the parsed list is empty
([hosting.ts](../../apps/desktop/src/main/hosting.ts#L835)).

**Work:** distinguish a missing registry (migration) from a present but
unsupported/malformed registry. Refuse registry mutations for the latter and
show a clear upgrade/recovery message; retain the original settings bytes.
Keep the per-entry validation policy for supported version 1 explicit. Add a
version-2 fixture proving that list/start/restore/rename/auto-start do not
rewrite it, and a version-1 migration fixture proving old folders still work.

### D2 — Restore can restart archived outbound work automatically (P1, confirmed path under stated setup)

The desktop restore verifies a selected backup and installs it into either a
new folder or the missing folder of a listed workspace with the same ID
([hosting.ts](../../apps/desktop/src/main/hosting.ts#L712)). It leaves that
entry's `startOnLaunch` selection intact. On the next app launch,
`startForLaunch` opens the restored folder
([hosting.ts](../../apps/desktop/src/main/hosting.ts#L811),
[index.ts](../../apps/desktop/src/main/index.ts#L754)). Its `startServer` path
does not pass `isolated`
([index.ts](../../apps/desktop/src/main/index.ts#L287)); ordinary server
startup immediately flushes due scheduled messages and event deliveries
([server.ts](../../packages/server/src/server.ts#L3624)). A backup taken before
the work completed can therefore replay it after a missing-folder restore.
The copied database can also accept sessions later revoked in the live
workspace. This is conditional on the backup containing such state; it is not
an observed duplicate-delivery incident.

The CLI already provides the pieces that make this risk visible:
`verify-backup` reports app destinations, pending scheduled/event work and
valid sessions ([main.ts](../../packages/server/src/main.ts#L199));
`--isolated` suppresses scheduled sends, app calls and mDNS
([server.ts](../../packages/server/src/server.ts#L186)). Desktop restore uses
`verifyBackup` but does not call `inventoryBackup`, show those effects, or
provide an isolated rehearsal. Its tests prove fresh/missing-folder restore
and then an ordinary start, but do not use queued work or a retained
start-on-launch choice
([hosting.test.ts](../../apps/desktop/test/hosting.test.ts#L1237)).

**Work:** make restore preflight show the verified backup identity, snapshot
time, reachable app destinations, pending work, sessions and host-local
configuration omitted from the archive. Introduce a persistent recovery hold
for an installed restore; auto-start must skip it, and an ordinary Start must
require an explicit activation decision. Give the operator a separate
isolated rehearsal path, enforce isolation in `createWorkspaceServer` before
timers and network publication, and prevent the rehearsal from sharing the
production port/address. Document how old sessions, integrations and due
messages are reviewed before production activation. Test a missing-folder
restore with `startOnLaunch` set and a due scheduled message: relaunch must
send nothing until the operator activates it; an isolated rehearsal must make
no outbound call or mDNS announcement.

### D3 — Backup trusts the registry label after a folder is replaced (P2, conditional)

Starting and renaming a stopped listed workspace compare its database ID to
the registry ([hosting.ts](../../apps/desktop/src/main/hosting.ts#L530),
[hosting.ts](../../apps/desktop/src/main/hosting.ts#L915)). Backup only checks
that the listed folder exists, then backs up that path and records
`lastBackupAt` for the selected entry
([hosting.ts](../../apps/desktop/src/main/hosting.ts#L675)). If that folder is
replaced by a _different valid workspace_ before backup, the backup library
will correctly certify the bytes in the replacement, but the desktop may
report it as a backup of the selected entry. The code path is confirmed; a
real folder swap has not been observed. It matters during manual recovery,
volume remounts and copied data, when an operator most needs trustworthy
labels.

**Work:** compare the source ID with the listed ID before backup (using the
running server's ID where applicable), and compare the ID in the verified
snapshot before recording success. Refuse identity mismatch and leave the
last-success date unchanged. Stage/publish the backup only after the identity
check, or report the path of a completed but mismatched copy explicitly.
Tests should swap the folder with another valid database and simulate a
replacement between preflight and snapshot completion.

### D4 — The deployment guide now gives a wrong recovery instruction (P1, confirmed)

The guide says desktop data lives under `hosted/<workspace-name>/`, that a
different name starts an empty workspace, that reopening uses the same typed
name, and that no workspace list or rename is available
([DEPLOYMENT.md](../DEPLOYMENT.md#L20)). Current code creates opaque `w-...`
folders, resolves existing workspaces by registry folder, and provides a list
and rename ([registry.ts](../../apps/desktop/src/main/registry.ts#L46),
[HostDialog.tsx](../../packages/ui/src/components/HostDialog.tsx#L982)).
Following the old guide after a restart can create a second empty workspace
with the same name, making the real one appear lost. The [registry design](../HOSTING-REGISTRY-2026-09.md)
is current, but normal operators are more likely to read deployment help.

**Work:** rewrite the desktop opening/recovery paragraphs now: choose the
existing entry from **Hosted on this computer**; use **New workspace** only
when creating a separate workspace; explain opaque folders, missing-folder
restore, explicit backup location and opt-in start at login. Add one short
manual documentation check following the fresh-install and existing-workspace
paths in a packaged build.

### D5 — Starting with the computer does not restore the stable public route (P1, confirmed behavior)

`startForLaunch` only calls `start({folder})`
([hosting.ts](../../apps/desktop/src/main/hosting.ts#L835)). Opening a named
Cloudflare connector or adopting an externally carried address is a separate
`openToAll` action
([hosting.ts](../../apps/desktop/src/main/hosting.ts#L1018)). Thus an
OS-login restart can resume LAN hosting while a saved stable public link
remains unpublished inside Gatherline. For an app-managed named tunnel the
connector is absent; for an external route, direct traffic may arrive but
generated links still lack the public URL. The current host status can say
“running” without explaining that a remote participant's stable address is
not active. A temporary Quick Tunnel should not silently re-open because its
address changes, and app startup should never weaken invite policy.

**Work:** add a separate opt-in “reopen this stable public address on app
start” preference tied to a particular workspace and carrier. After the
server starts, validate account ownership/policy, verify the current instance
through the address, publish it, and surface a persistent launch error if the
route/connector fails. Skip this when recovery hold is active. Test OS-login,
tray-hidden, offline-to-online and changed-port cases; validate the actual
participant path from a second network before calling it ready.

### D6 — The desktop process still carries synchronous database work (P2, performance gate)

`createWorkspaceServer` runs in Electron main
([index.ts](../../apps/desktop/src/main/index.ts#L287)); it uses synchronous
SQLite APIs throughout the server. Desktop backup invokes `VACUUM INTO` with
`DatabaseSync` on the same main event loop
([backup.ts](../../packages/server/src/backup.ts#L160)). For a large database,
this can delay renderer IPC, tray handling, health responses and timeout
processing. The path is proven by code; no latency threshold was measured in
this audit. Moving all hosting into a utility process before a representative
measurement would add substantial lifecycle complexity.

**Work:** run a repeatable 50k-message/attachment workload while hosting and
backing up; record main-loop delay, request latency, backup duration, RSS,
UI action latency and tunnel liveness. Set an explicit acceptance budget. If
it fails, move the hosted server and backup work behind a utility-process
boundary while keeping the controller's start/stop/status semantics and
crash recovery; add a packaged desktop smoke test for child failure.

### D7 — Release and recovery claims still lack a shipped artifact gate (P1 release work)

`desktop.yml` packages on Windows PRs and launches the unpacked app, but has
no release publication step; `electron-builder.yml` declares NSIS,
DMG, AppImage and DEB targets. There is no updater in desktop code or package
dependencies, and the guide explicitly says there is no signed public
release pipeline or automated update service
([desktop.yml](../../.github/workflows/desktop.yml),
[electron-builder.yml](../../apps/desktop/electron-builder.yml),
[DEPLOYMENT.md](../DEPLOYMENT.md#L884)). This is a product/release gap, not a
regression in the current test suite. Only Windows packaging is exercised by
the workflow; the Linux container smoke test covers a different delivery
surface ([container.yml](../../.github/workflows/container.yml)).

**Work:** define a versioned release manifest and reproducible artifact
inventory with Node/Electron/SQLite versions, checksums, signing/notarization
status and schema compatibility. Add macOS/Linux package installation and
upgrade drills on disposable machines, including launch-at-login behavior,
old-profile migration, a full backup before upgrade, isolated restore of that
backup, and rollback limits after writes resume. Keep an explicit manual
distribution/update instruction until an updater has a tested trust and
rollback model. Do not infer phone reachability, PWA secure-context behavior
or media transport from a Windows desktop smoke test.

### D8 — Backup freshness is weaker than the UI label implies (P2, operational gap)

The registry stores only `lastBackupAt`, and the host dialog displays
“Backed up <date>” without destination, verification history or restore-drill
status ([hosting.ts](../../apps/desktop/src/main/hosting.ts#L694),
[HostDialog.tsx](../../packages/ui/src/components/HostDialog.tsx#L1004)). A
verified copy on the same physical disk does not survive that disk's loss.
The current operation intentionally selects a destination each time; there
is no schedule/off-device transfer. The success message includes the chosen
path for this run, but it is not persisted as durable recovery evidence.

**Work:** model `captured`, `verified`, `off-device` and `restore-drilled`
separately. Record backup ID, workspace ID, destination and verification time
without recording credentials. Show age and destination class, keep failed
attempts visible without advancing last success, and add a scheduled/off-device
path only after live capture consistency and retention are specified.

### D9 — A live connector can leave a stale “public” status (P2, conditional)

The quick/named tunnel path verifies the current instance before opening, but
afterward its unexpected-exit callback is driven by the `cloudflared` child
exiting ([tunnel.ts](../../apps/desktop/src/main/tunnel.ts#L673)). By
comparison, externally carried addresses are periodically probed and given
up after repeated failures
([tunnel.ts](../../apps/desktop/src/main/tunnel.ts#L375)). If a connector
process remains alive while its route stops answering this workspace, the
quick/named status can still show the address as open. This is a conditional
status/reachability error, not evidence that Cloudflare failed in a test.

**Work:** give all public carriers a common current-instance reachability
state with bounded probes, a grace period for transient outages and a visible
degraded reason. Keep process exit distinct from failed route checks, and
avoid calling a host-side probe proof of reachability from every participant
network. Test a connector that stays alive while its health route fails, then
recovers; retain invite policy and the same stable URL during recovery.

## Suggested work order for Codex or Claude

1. **Prevent remaining silent surprises first:** D4 operator guide
   correction and D3 backup identity checks. D1's registry guard merged in
   PR #117; preserve its absent-key migration and version-1 entry policy in
   later work.
2. **Make restore safe as a workflow:** D2 preflight inventory, persistent
   recovery hold, isolated rehearsal, and explicit activation. Use the
   existing server verification and isolated mode; do not replace them with a
   file-copy UI. Include a test backup with sessions, due scheduled work and
   app destinations, plus the auto-start-after-restore case.
3. **Define the supported host availability path:** D5 stable-address resume
   preference, D9 liveness state and a second-network probe; a real phone trial for LAN HTTP,
   HTTPS public chat, attachment download, notification return and calls.
   Record browser/device/version and whether the origin is secure. Separate
   chat reachability from TURN/media success.
4. **Measure and harden operations:** D6 workload gate, D8 recovery evidence
   and off-device storage. Keep the previous verified backup until a new one
   is complete. Rehearse a fresh-machine restore with the original host off.
5. **Ship only through a known release path:** D7 package/update checks,
   explicit runtime inventory and full recovery drill on each supported OS.
   A release candidate is ready only when another operator can install,
   upgrade, restore and re-open the intended address without the original
   developer's account or unwritten instructions.

For review, keep regression checks proportional: focused controller and
backup tests for D1–D3, packaged Windows E2E for the complete host/restore
flow, and manual cross-device/cross-OS evidence for D5–D7. Current passing
unit and packaged desktop tests establish existing behavior; they do not
certify remote access, data durability after power loss, or signed update
distribution.
