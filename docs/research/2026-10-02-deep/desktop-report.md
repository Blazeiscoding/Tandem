# Desktop and delivery deep review — 2 October 2026

Reviewed source revision `a285ee6c8a67e93db01ef2d9046493ea0572a34c`. All diagnostic changes are in this research directory; application source and existing user data were not changed. The root review rebuilt current output and ran the existing baseline suite separately. This report adds targeted evidence, not another claim that all product/platform acceptance gates are complete.

Native probes run fresh `apps/desktop/out/main/index.js` under installed Electron **44.1.0**, with its Node **24.19.0** runtime, sandbox and context isolation enabled. They use test mode, hidden windows and owned disposable user-data directories. The existing packaged ASAR was inventoried separately and has **unverified source freshness**; it was not used for IPC/crash probes. No database, attachment or log contents were extracted from that archive. Report timestamps use UTC, so captures late on 1 October UTC are 2 October in the workspace timezone.

## 1. P1: reject workspace data and build logs from production archives

**Confirmed artifact observation:** the existing local `app.asar` contains these paths under `node_modules/@slackoss/server/data/`: `workspace.db` (**200,704 bytes**), `workspace.db-wal` (**4,144,752 bytes**), `workspace.db-shm` (**32,768 bytes**), and two files totaling **83,995 bytes**. Together those workspace-data files occupy **4,462,219 bytes**. Eight workspace `.turbo` log files add **26,857 bytes**. The archive also ships **132 workspace source files**, totaling **1,496,333 bytes**, despite workspace application code being bundled into the desktop output.

**Current collector reproduction:** a minimal disposable desktop fixture used installed Electron Builder **26.15.3**, the same `files: [out/**, package.json]` policy, `asar: true`, and a linked `@slackoss/server` production dependency. Every synthetic canary was included in its archive: `data/workspace.db`, `data/workspace.db-wal`, `data/workspace.db-shm`, `data/files/synthetic-attachment` and `.turbo/turbo-test.log`. This was an unpacked directory package using the existing Electron distribution, with executable signing/resource editing disabled; no installer was made and all temporary output was removed.

The fixture uses a minimal npm-linked dependency tree. It demonstrates the current collector's behavior and does **not** establish the contents of a freshly built full Gatherline pnpm archive. The existing artifact observation makes the source-freshness distinction material, rather than hypothetical.

**Source evidence:** [electron-builder.yml:5](../../../apps/desktop/electron-builder.yml#L5) permits output/package metadata but supplies no exclusions for files automatically collected from dependencies. [desktop package.json:18](../../../apps/desktop/package.json#L18) declares source workspace packages as production dependencies. [electron.vite.config.ts:8](../../../apps/desktop/electron.vite.config.ts#L8) bundles workspace packages. [server package.json:6](../../../packages/server/package.json#L6) exports TypeScript source without a package file allowlist. `.dockerignore` excludes database/data/log paths for containers, but does not control Electron dependency packaging.

**Impact:** production artifacts can contain development workspace data and operational logs; this is also avoidable installer/extraction cost. No claim is made about sensitive contents or public distribution of this particular local archive.

**Implementation:** first add a release archive gate rejecting workspace data, databases/WAL/SHM, `.turbo`, logs, test data and other forbidden paths, including dependency paths. Then make the runtime dependency closure explicit: avoid collecting already-bundled workspace source packages or give them narrow package file allowlists and dependency exclusions that retain required third-party runtime assets/licenses. Audit the actual packaged runtime imports before pruning.

**Effort:** small release gate; medium packaging-closure fix. **Acceptance:** the synthetic fixture fails the archive gate before the fix and passes after it; a fresh full pnpm Windows package contains no canaries/user-data paths and launches hosting, preload and backup workers successfully. Inventory resulting package bytes. This extends IMP-08/OPT-03 with a confirmed release boundary, rather than just a size experiment.

Evidence: [desktop-inventory.json](desktop-inventory.json), [desktop-packaging-canary.json](desktop-packaging-canary.json). Reproduce the synthetic collector test with `node docs/research/2026-10-02-deep/desktop-packaging-canary.mjs`.

## 2. P1 boundary hardening: authorize each sensitive IPC sender

**Actual native reproduction:** the harness creates one additional **hidden `about:blank` BrowserWindow using the real packaged preload**, with sandbox enabled, context isolation enabled and Node integration disabled. From that auxiliary window, `storage:get("servers")` returns the synthetic saved credential; `storage:set` persists a marker visible to the legitimate main renderer, and `hosting:status` returns the host state. Main-process instrumentation records a foreign sender ID and `senderFrame.url === "about:blank"` for the credential read.

**Controls:** the same window's `file:download` call is rejected as `Invalid download request` before URL parsing. The legitimate primary renderer with the identical invalid payload reaches URL parsing and rejects it as `Invalid URL`. The synthetic token is OS-encrypted on disk and absent from plaintext settings. A same-origin `about:blank` child frame of the legitimate renderer has **no directly exposed preload bridge**; it can access the parent's bridge through ordinary same-origin access, and that delegated invocation is recorded as originating from the parent's main frame.

**Limits:** creating that auxiliary BrowserWindow and assigning its preload requires native harness privileges. The application's existing navigation/window-open controls prevent ordinary UI paths demonstrated here from creating this window. This is proof that sensitive handlers lack authorization, **not a demonstrated remotely reachable exploit**, nor evidence that a cross-origin iframe can access credentials. A sender/frame guard also does not protect against arbitrary script execution already inside the trusted main renderer.

**Source evidence:** [index.ts:165](../../../apps/desktop/src/main/index.ts#L165) ignores the sender for `storage:get`; line 170 does likewise for writes. Many hosting handlers at lines 450–617 ignore the sender. The guarded `file:download` at [line 65](../../../apps/desktop/src/main/index.ts#L65) checks the main WebContents ID; permission handlers at lines 829–857 already have URL/frame trust logic that can inform a shared boundary. No `senderFrame` check exists in application IPC handlers.

**Implementation:** create one shared IPC registration boundary that verifies an authorized live window, its actual sender frame and trusted renderer URL before performing sensitive work. Use an explicit authorized-window registry if genuine additional windows are supported. Add channel-specific payload schemas/limits and a narrower credential/storage command contract. Keep acknowledgements and errors lossless.

**Effort:** medium. **Acceptance:** the auxiliary window is rejected for sensitive reads/writes/hosting commands; legitimate renderer commands still work; direct foreign/child-frame requests are refused under the chosen frame policy; same-origin delegation limitations are documented. This is SEC-03/OPT-18 work and should preserve GL-01–03 storage semantics.

Evidence: [desktop-runtime.json](desktop-runtime.json). Run `node docs/research/2026-10-02-deep/desktop-diagnostics.mjs runtime`. The script wraps the real registered storage handler solely to record native event sender metadata, then removes all disposable data/processes.

## 3. P2: renderer crash/load failure needs a usable recovery path

**Actual native reproduction:** `forcefullyCrashRenderer()` leaves the existing main WebContents crashed, undestroyed and unrecovered after a bounded two-second observation. A separate fresh launch directed at a blocked local renderer port ends loading with no application recovery page or automatic replacement. The existing source has no crash/load handler that could produce a later recovery; this review does not turn the two-second observation into a startup or long-term availability budget.

**Source evidence:** [index.ts:803](../../../apps/desktop/src/main/index.ts#L803) handles navigation readiness and close, but the desktop source has no `render-process-gone`, `did-fail-load` or `unresponsive` handlers. [index.ts:887](../../../apps/desktop/src/main/index.ts#L887) discards renderer-load promises. Ordinary hosted shutdown is implemented separately and was not reset or changed by these probes.

**Impact:** a native renderer failure can leave an unusable management/chat window while the native app remains alive. The crash probe had no active hosted workspace or unsent message; recovery of hosting and acknowledged unsent work still needs explicit acceptance coverage.

**Implementation:** handle crash/load errors with bounded, generation-scoped recovery and an explicit manual fallback. Restore durable outbox/draft/navigation state; maintain existing backend ownership. Record first usable state separately from page load and retain bounded retry state. Keep user-approved force exit separate from automatic recovery.

**Effort:** medium. **Acceptance:** actual Electron crashes during a persisted send and host/restore management recover or reach a visible fallback without duplicate sends, backend restarts, retry loops or lost route state. Test broken load, repeated crash/OOM and failed shutdown separately. This remains OPT-19/IMP-05, with targeted reproduction added here.

Evidence: [desktop-runtime.json](desktop-runtime.json). OS shutdown/logoff, hung workers, physical devices and active-host crash recovery were not exercised.

## 4. P2 quick win: decouple backup imports from the full server module graph

**Current output:** a 1,161-byte backup worker imports a shared 683,837-byte module, totaling **684,998 bundled bytes**, plus Fastify, CORS, ws, Bonjour and Zod runtime dependencies. Each backup/verify/restore/inventory starts a new worker.

**Controlled import-only comparison:** installed Electron 44.1.0 in `ELECTRON_RUN_AS_NODE` mode created a fresh worker isolate for every sample. The diagnostic candidate imported `backup.ts` directly and replaced the server module **only inside a disposable bundle** with its unchanged `SERVER_VERSION` constant. There were two unmeasured warmups per variant, followed by 12 measured samples per variant in alternating order. Root and other reviewers paused heavier work during the final captured run.

| Measure                 | Current graph | Disposable light graph |
| ----------------------- | ------------: | ---------------------: |
| Initialization p50      |     180.66 ms |               74.46 ms |
| Initialization p95      |     221.73 ms |              109.59 ms |
| Worker JS heap used p50 |      17.48 MB |                8.63 MB |
| Loaded CommonJS modules |           171 |                     94 |
| Bundled module bytes    |       684,998 |                 38,858 |

**Limits:** this is import initialization under warm process/filesystem caches, not cold desktop startup, full backup throughput or a validated production patch. The invalid diagnostic job intentionally performs no database/file operation. CommonJS module count excludes ESM modules. Worker heap is an isolate metric; recorded RSS covers the whole process and must not be presented as per-worker memory. The candidate's functional backup equivalence has not been tested.

**Source evidence:** [backupWorker.ts:2](../../../apps/desktop/src/main/backupWorker.ts#L2) imports from the full server barrel; [backup.ts:23](../../../packages/server/src/backup.ts#L23) imports its version from the networking/server module, whose imports include Fastify, sockets and discovery. [index.ts:329](../../../apps/desktop/src/main/index.ts#L329) creates a worker per operation and resolves when the worker replies.

**Implementation:** move version/build constants to a dependency-light module, expose/import a focused backup entry and inspect emitted imports. Retain worker ownership/cleanup rules and add a functional packaged backup/verify/restore check before claiming the measured startup saving.

**Effort:** small. **Acceptance:** networking dependencies disappear from the backup import closure; same-data backup/verify/restore operations preserve manifests and ownership cleanup; repeated import measurements retain the improvement; packaged worker paths resolve. This is a concrete OPT-03 slice.

Evidence: [desktop-worker-benchmark.json](desktop-worker-benchmark.json), [desktop-inventory.json](desktop-inventory.json). Reproduce with the installed Electron executable in run-as-Node mode running `desktop-worker-benchmark.mjs`; use a waiting child-process wrapper with `windowsHide: true` on Windows, since directly invoking a GUI executable from PowerShell may return before it finishes.

From the repository root, this wrapper supplies that runtime and waits for completion:

```powershell
node --input-type=module -e 'import { createRequire } from "node:module"; import { resolve } from "node:path"; import { spawnSync } from "node:child_process"; const desktopRequire = createRequire(resolve("apps/desktop/package.json")); const result = spawnSync(desktopRequire("electron"), [resolve("docs/research/2026-10-02-deep/desktop-worker-benchmark.mjs")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "inherit" }); if (result.error) throw result.error; process.exit(result.status ?? 1);'
```

## 5. P2: include automation in the normal typecheck

**Executed strict no-emit check:** the two Playwright specs and their configs produce two errors under the repository's strict/noUncheckedIndexedAccess style:

- [desktop.spec.ts:62](../../../tests/e2e/desktop.spec.ts#L62): `getLastWebPreferences` is absent from the declared Electron `WebContents` API.
- [web.spec.ts:878](../../../tests/e2e/web.spec.ts#L878): `Buffer<ArrayBufferLike>` is not assignable to `BlobPart` because its backing buffer may be a `SharedArrayBuffer`.

The six root `.mts` measurement scripts pass the same diagnostic check. These findings are separate from the existing baseline test result: Playwright transpilation can execute code without checking these types.

**Source evidence:** root [package.json:12](../../../package.json#L12) runs workspace typechecks; package `include` lists do not cover root E2E/config files or measurement scripts. CI still reports the existing seven workspace typechecks correctly.

**Implementation:** add an automation tsconfig/task to ordinary checks; resolve the public/diagnostic API typing boundary explicitly and use an accepted byte-buffer representation for the Blob fixture. Include root tooling tests in the relevant fast Linux validation lane. Retain already completed cache-input and concurrency work.

**Effort:** small. **Acceptance:** the current two errors are addressed; introducing an E2E/config type error fails ordinary checks before slow packaging/browser work; source measurement scripts remain checked. This is the still-open automation slice of IMP-08.

Evidence: [desktop-typecheck.json](desktop-typecheck.json). Run `node docs/research/2026-10-02-deep/desktop-diagnostics.mjs typecheck`; it emits no application output.

## Delivery sequencing and remaining limits

First add the archive exclusion gate and IPC registration boundary. The worker-module split and automation typecheck can proceed independently, then bounded renderer recovery. Keep the existing artifact-identity/freshness/release ticket and independent-E2E-fixture ticket: absence of revision stamping still prevents proving that the packaged artifact matches current source, while `tests/e2e/web.spec.ts:1213` still depends on an earlier scenario having created Alice. Neither existing CI caching nor path-trigger coverage needs to be redone.

The diagnostic scripts clean only their verified, owned disposable directories. Helper processes use hidden windows; native application windows are hidden in test mode. No external site, live user-data directory or private audit folder was used, and no existing saved sign-ins were read. Browser interaction for the root product review remains in the T3 preview; the native Electron probes here inspect process/IPC lifecycle and do not replace that browser.

The full pnpm production archive must still be rebuilt and inspected after a packaging fix. Installer installation, protocol registration, upgrade/uninstall, signing, Docker execution, actual OS shutdown/logoff, disconnected-volume recovery and cold-start/whole-process performance remain separate acceptance gates. These diagnostic candidates are evidence for a plan, not implemented application changes.
