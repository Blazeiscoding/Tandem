# Research after the remote pull — 3 October 2026

Reviewed main **`cd3af584ba46adace45465cb5e5c66afb238b01c`**. The requested pull fast-forwarded `36d9eab` to this revision and brought in the earlier F01–F15 implementation. Work before the pull was not used as current-product acceptance.

Start with the [ranked twelve-package improvement review](../../IMPROVEMENT-PLAN-2026-10-03.md).

| Evidence                                                                                                                                              | What it establishes                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Validation](root-validation.json)                                                                                                                    | Completed fresh builds/typechecks, package/tooling/browser/native tests, identities, size/compression/cache/audit checks, and the preserved initial intermittent server ownership failure.                       |
| [Storage report](root-storage-report.md), [four probe results](root-storage-evidence.json)                                                            | New IndexedDB fallback/recovery loses backend ownership; private previews default to full and acknowledged fallback text is discarded.                                                                           |
| [Production-browser state](root-browser-storage.json)                                                                                                 | Healthy and fault-controlled production UI selections, using the product-native T3 browser and a disposable synthetic workspace.                                                                                 |
| [Client report](client-report.md)                                                                                                                     | Seven Node and four DOM diagnostics/controls: microphone intent, delayed join-muted preference, independent form lifetimes and actual two-app callback delivery, plus remaining retention/file-cache boundaries. |
| [Server report](server-report.md), [lifecycle results](server-results.json), [logging child/control](server-logging-control.json)                     | Complete action-content cleanup, sent-schedule copies, same-form concurrent submission, delayed replacement semantics and logging containment.                                                                   |
| [Desktop report](desktop-report.md), [uninstrumented native exits](desktop-native-close-uninstrumented.json), [IPC traces](desktop-native-close.json) | Last-keystroke loss on ordinary clean exit in the matching native package, with successful acknowledged-persistence controls.                                                                                    |
| [Desktop lifecycle fixtures](desktop-lifecycle-fixtures.json)                                                                                         | Malformed restored-row hold loss and unsuccessful resource cleanup ownership, using real disk metadata/listeners and controlled adapters.                                                                        |
| [Mixed run 1](root-mixed-1.json), [run 2](root-mixed-2.json)                                                                                          | Two sequential current-code correctness/workload observations with exact replay, nonzero production retention and zero errors; no before/after performance claim.                                                |
| [Initial server harness results](server-results-initial.json)                                                                                         | Preserved harness prerequisite errors, corrected before final reproduction; these are not product findings.                                                                                                      |

The recorded command outputs are preserved as `.txt` alongside these artifacts, with only line endings, trailing whitespace and extra final blank lines normalized. [Collection script](root-collect.mjs) gathers known completed command outcomes and actual manifests/sizes, copies terminal logs into readable evidence and checks only tracked-file formatting; it does not rerun the product tests. It avoids the pre-existing private untracked audit folder. The global mixed-run `dirty:true` includes unrelated untracked/research files; its separate `sourceChanged:false` identifies unchanged product inputs.

## Reproduction

Use the reviewed revision, Node 24+ and pnpm 10.23.0. New diagnostic assertions intentionally recognize the current defect. Their passing means the stated behavior was reproduced, not that it was repaired.

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
pnpm --filter @slackoss/desktop package --win --dir
pnpm test:desktop
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-03/root-storage.config.mts
pnpm --filter @slackoss/client-core exec vitest run --config ../../docs/research/2026-10-03/client-node.config.mts
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-03/client-ui.config.mts
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-03/server-probes.mts
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-03/server-logging-control.mts
node docs/research/2026-10-03/desktop-native-close.mjs
node docs/research/2026-10-03/desktop-native-close.mjs --no-trace
node docs/research/2026-10-03/desktop-lifecycle-fixtures.mjs
```

The first combined unit run failed an ownership assertion, not a timeout. The focused ownership and full isolated server reruns passed, then all client/UI/desktop suites completed successfully. The failure's cause remains unresolved; neither an environmental explanation nor reliable exclusivity under every concurrent condition is claimed.

Run performance separately with other runtime work idle:

```powershell
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-mixed.mts --rounds=2 --seconds=5 --history=20000 --expired=200 --out=../../docs/research/2026-10-03/root-mixed-1.json
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-mixed.mts --rounds=2 --seconds=5 --history=20000 --expired=200 --out=../../docs/research/2026-10-03/root-mixed-2.json
```

These runs share server and clients in one Node process, use one Windows host and a short warm workload. Per run, 400 expired messages and their 40 attachments are removed by production maintenance and reconnections are checked against exact replay. They do not establish server-only memory, desktop-main responsiveness, maximum capacity or reference-hardware acceptance.

## Scope and limits

Only the new research, ranked review and README pointer were added. During the review, no application source fix, existing-user data operation, genuine installation, registry modification, release/tag, PR or remote publication was performed. Baseline and diagnostic servers/accounts/profiles are disposable. Harnesses verify owned temporary directory paths before recursive deletion, stop their servers/resources and retain synthetic evidence only.

The T3 browser successfully ran the production setting check through DOM inspection and focused interaction. Screenshot snapshot attempts failed in the preview client, so no screenshot is claimed. The synthetic preference fault was applied in a second same-origin production-bundle frame; a legacy synthetic sign-in was copied to isolate its effect on preferences. Origin storage and the fixture were cleared and the server stopped afterward.

Native exits use the actual fresh unpacked package; confirmations are instrumented, and one independent run omits IPC tracing. Source-controller resource errors use loopback adapters, not actual Cloudflare failures. Client microphone probes use synthetic media; two-app form delivery and server replay use actual HTTP/socket callbacks, with DOM rendering in jsdom. The narrower search/file-cache diagnostic exercises a public client API, without asserting a current Search UI preview route.

Docker's Linux engine is unavailable. Genuine installed prior-release upgrade/uninstall, a downloaded release, second-device/proxy/public-route checks, assistive technology, physical call devices, OS logoff/power loss and low-spec desktop-main/GPU references remain open. These limits are separate from the observed findings.
