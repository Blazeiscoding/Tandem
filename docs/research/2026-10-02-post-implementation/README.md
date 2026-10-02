# Post-implementation verification — 2026-10-02

Main stayed pinned to **`f07ce84362257aedeab16c9ae4c2361193eb6442`** (Tandem). This review verifies the implementations added after the earlier investigation and tests adjacent failure/lifetime boundaries. No product fix, genuine installation, registry change, tag, release or remote publication was performed.

Start with the [closure matrix and ranked follow-up plan](../../IMPROVEMENT-PLAN-2026-10-02-FOLLOWUP.md).

| Evidence                                                     | Contents                                                                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Root validation](root-validation.json)                      | Fresh forced build/typecheck/test outcomes, 1,673 passing / two skipped package tests, 22 tooling tests, 20 browser tests, cache and formatting checks, artifact identities/sizes and limits |
| [Client report](client-report.md)                            | Seven real HTTP/socket and seven DOM/storage diagnostics; selected repair controls, remaining GL-01–03 and notification/file/pagination findings                                             |
| [Server report](server-report.md)                            | Eleven child/count/fault modes, three intentional uncaught exits, queue/publication controls and integration work counts                                                                     |
| [Desktop report](desktop-report.md)                          | Fresh Windows package, four packaged regressions, native IPC/recovery and disposable identity/release/installer-gate fixtures                                                                |
| [Performance observations](root-performance.md)              | Two current search comparisons and mixed observations; selective filename candidate, rejected shapes, raw samples and method limits                                                          |
| [Mixed method review](client-mixed-method-review.md)         | Exact-replay, nonzero maintenance, sequence, saturation and harness-memory acceptance gaps                                                                                                   |
| [Real browser privacy state](root-browser-notification.json) | Actual production settings before/after synthetic storage corruption and reload                                                                                                              |
| [Browser screenshot](root-notification-after-corruption.png) | Actual full-preview selection after the malformed saved map                                                                                                                                  |

Diagnostic assertions deliberately establish observed failures; “passes” for those probes means the expected undesirable behavior was reproduced. It does not mean the application defect is repaired. Detailed reports distinguish repository regressions, new fresh acceptance, synthetic fault injection, source inspection and remaining acceptance.

## Reproduction

Use the reviewed checkout plus these harnesses. Builds and unit suites were forced, with zero cache hits. Windows, Node 24.16.0 and pnpm 10.23.0 were used; packaged Electron is 44.1.0.

```powershell
pnpm install --frozen-lockfile
pnpm exec turbo run typecheck build --concurrency=2 --force
pnpm typecheck:automation
$env:VITEST_MAX_THREADS='2'
$env:VITEST_MAX_FORKS='2'
pnpm exec turbo run test --concurrency=2 --force
node --test scripts/build-identity.test.mjs scripts/check-desktop-archive.test.mjs scripts/check-web-precompressed.test.mjs scripts/release-manifest.test.mjs scripts/desktop-ci-mode.test.mjs
node scripts/check-ci-cache.mjs
pnpm test:e2e
pnpm --filter @slackoss/client-core exec vitest run --config ../../docs/research/2026-10-02-post-implementation/client-node.config.mts
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-02-post-implementation/client-ui.config.mts
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-post-implementation/server-probes.mts
```

Desktop commands and native prerequisites are in its report. Performance runs must be sequential with runtime work idle; use the commands and limitations in the performance report. Scripts overwrite their diagnostic outputs on rerun. `root-collect.mjs` collects resulting unit/manifests and the recorded command summary; it does not rerun verification.

`root-browser.mts` creates an owned disposable fixture, serves fresh web assets, and accepts `stop` on stdin. This turn used T3 preview to sign into synthetic seeded accounts, save a private preference, inject a malformed localStorage map and reload. The fixture was stopped and removed afterward. No alternate interactive browser system was used.

Every synthetic filesystem fixture belongs to its harness and is checked before recursive cleanup. Native dialogs are instrumented; the installer fixture extracts the current Launch function and mocks process/registry behavior. It does not run the install/uninstall script. The pre-existing private audit folder remains untouched.

## Limits and corrections

Docker's Linux engine is unavailable, so no new container smoke/reuse run is claimed. Unpacked Windows testing does not establish actual installed upgrade/uninstall, release download/signing, second-device/proxy, screen-reader or low-spec/GPU behavior. No new contrast failure or unmeasured architecture gain is alleged.

The server evidence records an initial harness route typo, then the corrected control. Native post-crash inspection uses current Electron webContents because the original automation page handle became stale; Saved was opened through its actual UI handler. Initial rowid-search results preserve a rejected exploratory shape; final repeatable comparisons use the message-ID harness. These corrections are tooling history, not application failures.

The historical [deep investigation](../2026-10-02-deep/README.md) remains unchanged. The old plan receives only a follow-up pointer and the corrected independent-fixture status. New findings and unfinished contracts are ranked in the new plan.
