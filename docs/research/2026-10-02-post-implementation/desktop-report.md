# Desktop and delivery verification after implementation

Source revision: `f07ce84362257aedeab16c9ae4c2361193eb6442` (Tandem), Windows x64, Electron 44.1.0 / embedded Node 24.19.0. Investigation date: 2026-10-02.

The original packaging, inbound IPC, backup import and crash-loop issues have substantial working fixes. A freshly built Windows unpacked application passes all four existing desktop regressions. This review establishes narrower remaining failures in freshness identity, release preparation, upgrade verification and recovery context. It does not establish an installed application's behavior.

## Evidence and scope

| Check                           | Result                                                                                                                                                                                 | Evidence                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Coordinated root baseline       | Fresh builds/typechecks pass; 1,673 unit tests pass, two skip; automation typecheck and all 20 browser E2E pass                                                                        | Root verification, not repeated by this agent                                                    |
| Fresh `package --win --dir`     | Pass; new `Tandem.exe` and ASAR built at this revision                                                                                                                                 | [Build log](desktop-package.log)                                                                 |
| Archive inventory               | 11,166,773-byte ASAR; 1,741 files, 55 dependencies; no forbidden archive paths; desktop/web manifests match this revision, dirty false; freshness checks pass                          | [Inventory JSON](desktop-package-inventory.json), [script](desktop-package-inventory.mjs)        |
| Archive/compression gates       | Both pass on the fresh package; 18 web files: 810.5 kB plain, 210.2 kB Brotli, 244.8 kB gzip                                                                                           | [Archive log](desktop-archive-gate.log), [compression log](desktop-compression-gate.log)         |
| Packaged regressions            | All four pass in 1.2 minutes, including startup/hosting, backup, restart, restore/inventory, launch settings and two renderer crashes                                                  | [Regression log](desktop-packaged-e2e.log), [existing tests](../../../tests/e2e/desktop.spec.ts) |
| Backup worker closure           | 44,577 emitted bytes across two chunks; external application package import is `zod` only                                                                                              | [Inventory JSON](desktop-package-inventory.json)                                                 |
| Native boundary/recovery probes | Inbound guard rejects auxiliary window; outbound events reach it. Four crashes preserve hosting, reach manual recovery and lose route context. Four failed loads reach native recovery | [Native JSON](desktop-native.json), [script](desktop-native.mjs)                                 |
| Tooling failure fixtures        | Omitted identity inputs, binary hash collision, malformed manifest behavior, unbound release sidecar and repeat-release checksum failure reproduced                                    | [Fixture JSON](desktop-fixtures.json), [script](desktop-fixtures.mjs)                            |
| Installer-gate profile fixture  | Current Launch function returns an old profile while the mocked new process uses a fresh one                                                                                           | [Mock JSON](desktop-install-fixture.json), [script](desktop-install-fixture.ps1)                 |

All credentials, accounts, messages and hosted workspaces used by the native harness are synthetic and local. Windows are hidden through test mode. Temporary profile directories have verified cleanup. No saved user sign-ins, workspace data or private audit folders were opened. No installer, registry, published release or tag was modified. Native dialog responses were instrumented. The failed-load case uses current emitted source output; other native cases use the fresh unpacked package. No timing claims are made from these probes.

## 1. P1: align source freshness with actual build inputs and bytes

**Confirmed.** `SHARED_INPUTS` contains only package.json, pnpm-lock.yaml and tsconfig.base.json ([build-identity.mjs:31](../../../scripts/build-identity.mjs#L31)). Turbo also depends on pnpm-workspace.yaml, .npmrc and .pnpmfile.cjs and includes the identity script in build inputs ([turbo.json:3](../../../turbo.json#L3), [turbo.json:12](../../../turbo.json#L12)). The standalone identity checker therefore has a different definition of freshness from the build cache.

The disposable fixture changes each of those three workspace/install configuration files and scripts/build-identity.mjs separately. All three artifact hashes stay unchanged, and `staleness` returns null for each. A lockfile change correctly invalidates all artifacts; a web source change correctly invalidates web. This can allow an old artifact to pass the pre-E2E source gate after a build-affecting configuration edit.

There is a separate byte-level collision: line ending normalization applies to every file using Latin-1, including binary assets ([build-identity.mjs:98](../../../scripts/build-identity.mjs#L98)). The fixture changes a binary file from bytes `00 0d 0a ff` to `00 0a ff`; real SHA-256 differs while the source input hash stays equal. A binary asset change can consequently be reported as fresh.

**Implementation, small–medium:** define one relevant-input contract shared with the build/cache configuration; include install configuration and the identity generator. Hash binary files without line normalization. For cross-platform text equivalence, use an explicit text policy or committed blob content rather than rewriting every byte sequence. Validate manifest structure before reading fields: syntactically valid `null` and a numeric revision currently throw TypeErrors at [build-identity.mjs:177](../../../scripts/build-identity.mjs#L177).

**Acceptance:** each relevant config/generator mutation changes the affected identities and produces a rebuild instruction; binary assets differing by CRLF bytes cannot collide; text fixtures behave consistently across supported checkouts; malformed manifest shapes produce actionable errors. Preserve the existing source/lockfile controls.

**Ticket mapping:** finish IMP-08's stale-output acceptance. A manifest from an older revision with identical inputs is accepted intentionally by this content-based freshness checker; the fixture records this as a control, not an independent defect. Release preparation separately requires the exact revision.

## 2. P1: prove upgrade data belongs to the application being tested

**Confirmed with the current function in a mocked fixture.** The installer gate's `Launch` chooses the first profile with an existing `Local State` file, checking the legacy @slackoss/desktop path before Tandem and Gatherline ([release-install-gates.ps1:67](../../../scripts/release-install-gates.ps1#L67), [release-install-gates.ps1:73](../../../scripts/release-install-gates.ps1#L73)). It does not tie the returned profile to the just-started process. Its upgrade marker check occurs before launching the new application ([release-install-gates.ps1:94](../../../scripts/release-install-gates.ps1#L94)).

The fixture executes only the source's Launch function with mocked process/registry operations. The synthetic old profile pre-exists; the mocked newly launched process creates its Local State in Tandem. The gate successfully returns the old @slackoss/desktop profile. Its selected profile has the upgrade marker; the active profile does not. A registry entry pointing to the new executable does not prove that executable read the old database/settings. Current source preservation behavior is not alleged to be broken; this is an acceptance-test false-positive boundary.

**Implementation, medium:** make the installed application expose its active user-data directory and build identity through a bounded diagnostic channel. Verify the launched process uses the expected profile and restored workspace/account fixture. Seed a real synthetic database, attachment and setting with the previous version; require the new version to read them before reporting upgrade success. Keep uninstall preservation separate from successful migration.

**Acceptance:** a fake/new process using a fresh profile must fail even when the legacy profile and marker remain; an actual previous-release-to-current upgrade on a disposable Windows runner must verify usable synthetic data, exact revision and protocol registration. No real install/registry execution was performed in this review.

**Ticket mapping:** IMP-08 release upgrade gate and REV-12 installed-app acceptance. [Safe mocked Launch fixture](desktop-install-fixture.ps1) extracts only the current function and mocks all process/registry actions; it does not execute the install/uninstall script.

## 3. P2: retain supported route state through renderer recovery

**Confirmed in the fresh package.** The harness creates a real local hosted workspace and account and selects a synthetic destination channel through history/popstate. It then opens Saved messages through a real Playwright UI click. Before each subsequent crash it reopens the panel through the current native renderer's DOM button handler. For all four crashes, URL/history include `/p/saved`, matching the signed-in server, and the button reports `aria-pressed=true` beforehand. Every recovery drops `/p/saved` and `history.state.tandem.view`, and the button reports false afterward. The destination channel remains. After the fourth crash's instrumented Try again, the query string is gone too. Hosted health returns HTTP 200 through all four attempts.

Automatic recovery loads the URL anew ([index.ts:912](../../../apps/desktop/src/main/index.ts#L912)); this does not preserve the old History entry's state. UI route recovery relies on matching remembered server state and only parses the hash when the page origin serves that workspace ([route.ts:157](../../../packages/ui/src/lib/route.ts#L157), [route.ts:168](../../../packages/ui/src/lib/route.ts#L168)). A desktop file page differs from the hosted server origin. The manual branch starts from the base page instead of reusing the captured location ([index.ts:938](../../../apps/desktop/src/main/index.ts#L938)).

**Implementation, medium:** retain a validated, account-scoped route checkpoint outside the renderer, with a load-generation identifier, and restore it on automatic and manual recovery. Preserve channel, thread, side panel and applicable reading position. Reject checkpoints from other accounts/workspaces and honor a pending deep link. Treat renderer usability separately from a page load event.

**Acceptance:** a packaged UI regression opens Saved messages through its button, then a thread and a dialog, crashes each state and compares the visible state afterward. Four failures reach the manual dialog; Try again restores the same place; switching account/workspace cannot restore another account's route. Hosting remains healthy, acknowledged drafts/outbox remain intact and no infinite retries occur.

**Ticket mapping:** remaining REV-09 navigation acceptance. The initial channel is selected by a supported history route; the Saved messages panel is opened through its actual UI handler. Post-crash instrumentation uses Electron's current webContents because the original Playwright page handle is stale after forceful renderer destruction. The diagnostic does not establish scroll/draft survival, real human dialog interaction, OS shutdown/logoff, or a hung renderer's usable deadline. Existing recovery success for channel/hosting and bounded failed-load retries is verified.

## 4. P2: authorize recipients of sensitive outbound IPC events

**Confirmed boundary gap, native-only prerequisite.** The new inbound guard correctly checks the main window, main-frame process/routing identity and trusted renderer URL ([ipcBoundary.ts:49](../../../apps/desktop/src/main/ipcBoundary.ts#L49)). The packaged control rejects storage read/write, hosting status and download from a hidden about:blank auxiliary BrowserWindow using the real preload. Primary reads work; rejected writes do not appear in settings; saved credentials are encrypted at rest.

However, storage merges broadcast the complete drafts/outbox value to every other BrowserWindow ([index.ts:203](../../../apps/desktop/src/main/index.ts#L203), [index.ts:221](../../../apps/desktop/src/main/index.ts#L221)). The same auxiliary window receives the exact synthetic private draft and unsent-message text while its inbound storage read remains refused. Sender authorization does not protect these recipients.

**Implementation, small:** maintain an explicit registry of trusted application renderer recipients and validate their current frame/location before sensitive sends. If multiple application windows become supported, register those deliberately rather than using getAllWindows indiscriminately. Apply the same recipient decision to all sensitive push channels.

**Acceptance:** the existing packaged primary-window control continues working; an auxiliary foreign-location window receives neither drafts nor outbox data; a trusted renderer navigated away no longer receives sensitive events; destroyed recipients are safe. Cover any deliberately supported second application window.

**Ticket mapping:** finish REV-14 / OPT-16 sender-and-recipient boundaries. The harness creates this extra native window with the preload. No ordinary UI or remote path creating it was demonstrated, so this is defense in depth rather than an established remotely reachable credential exploit.

## 5. P2: make release preparation repeatable and bind identities to publishable assets

**Confirmed repeat failure.** `prepareRelease` skips SHA256SUMS but treats every other non-sidecar file in the staging directory as an asset ([release-manifest.mjs:57](../../../scripts/release-manifest.mjs#L57)). The workflow writes notes inside that directory ([release.yml:153](../../../.github/workflows/release.yml#L153)) and excludes notes from actual publication ([release.yml:183](../../../.github/workflows/release.yml#L183)). Running preparation again includes the old notes.md in sums, then overwrites it with new notes containing those sums. The recorded notes checksum no longer matches the rewritten file. The disposable fixture reproduces this without publishing anything.

**Confirmed trust assumption, not an artifact exploit:** sidecars are independently validated, but no mapping binds a particular installer/tarball to the sidecar's bytes. A synthetic non-executable installer marker plus a correct desktop identity is accepted. The Windows workflow extracts the identity from win-unpacked while selecting the installer separately ([release.yml:121](../../../.github/workflows/release.yml#L121)). Checksums accurately describe the chosen file, but cannot prove its embedded source identity. Fresh CI staging reduces this risk; a reused local directory or incorrect asset selection remains outside the check.

**Implementation, small–medium:** enumerate the intended artifact set explicitly; keep generated notes outside asset input or exclude its exact path; make repeated preparation idempotent. Validate identity shape and required per-platform artifacts. Bind each asset to its expected artifact identity and checksum during its build/staging step; where feasible verify embedded metadata before publishing. Refuse unexpected files and ambiguous installer matches.

**Acceptance:** preparing twice produces the same publishable file set and valid checksums; notes never appear in the publication checksum list; extra/old/wrong-kind assets and swapped sidecars are rejected; every published asset has a matching tested identity and SHA-256. Preserve dirty/version/exact-revision rejection.

**Ticket mapping:** IMP-08 release tooling. No release workflow, GitHub publication, code signing or downloaded installer was executed here. Cleanup-on-failure, previous-release fetch failures and pre-existing tag identity still need CI exercises rather than source-only claims.

## Optional P3 optimization candidate: narrow packaged dependency contents

The fresh archive is now clean and small compared with the original workspace closure. Zod accounts for 5,429,652 bytes, approximately half of the listed uncompressed archive payload; Fastify and AJV together add about 2 MB. This is measured package inventory, not an initialization benchmark.

Audit which duplicate module formats, source files, locales and metadata are required by real Electron module resolution before considering a targeted packaging filter or bundling strategy. Preserve package exports and runtime dependencies. Accept only a measured archive/install-size improvement with fresh packaged backup/verify/inventory/restore, hosting and protocol tests passing. Do not remove files based on extension alone or claim startup gains from archive sizes. This is an OPT-03/REV-12 follow-up candidate, below the correctness and gate work above.

## Reproduction

Run from the repository root after coordinating builds and native runtime load:

```powershell
node docs/research/2026-10-02-post-implementation/desktop-fixtures.mjs
pnpm --filter @slackoss/desktop package --win --dir
node scripts/check-desktop-archive.mjs apps/desktop/release/win-unpacked/resources/app.asar
node scripts/check-web-precompressed.mjs apps/desktop/release/win-unpacked/resources/web
node docs/research/2026-10-02-post-implementation/desktop-package-inventory.mjs
pnpm test:desktop
node docs/research/2026-10-02-post-implementation/desktop-native.mjs
powershell -NoProfile -File docs/research/2026-10-02-post-implementation/desktop-install-fixture.ps1
```

The fresh package is an unpacked application, not an installed one. This evidence does not close the plan's explicit installed backup/restore, second-machine/proxy cache, first/second real release and genuine upgrade/uninstall acceptance tasks. Source freshness and published artifact integrity have different contracts and should remain explicit.
