# Further review evidence — 4 October 2026

These harnesses inspect the working source after N01–N12, based on `7886b4a`. Their diagnostic assertions deliberately match undesirable current behavior. They are research, not repaired-product acceptance, and are excluded from normal package test suites. See the [ranked report](../../MORE-IMPROVEMENTS-2026-10-04.md).

Run from the repository root with installed workspace dependencies and Node 24:

```powershell
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-04-next/root/root.config.mts --reporter=verbose
pnpm --filter @slackoss/client-core exec vitest run --config ../../docs/research/2026-10-04-next/client/client-node.config.mts --reporter=verbose
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-04-next/client/client-ui.config.mts --reporter=verbose
node docs/research/2026-10-04-next/desktop/lifecycle-next.mjs
```

The TypeScript restore harness can run through the repository's installed tsx loader:

```powershell
$reviewTsx = node -e "const {createRequire}=require('node:module'); const r=createRequire(process.cwd()+'/packages/server/package.json'); process.stdout.write(r.resolve('tsx/esm'));"
node --import $reviewTsx docs/research/2026-10-04-next/server/restore-gap.mts
```

Restore results describe Windows directory replacement with an open SQLite database. Other operating systems may produce different consequences; the harness explicitly asserts the recorded Windows failure. It uses owned temporary workspaces and synthetic credentials, and restores its patched rename function before cleanup.

The root suite uses production hooks/App/storage/gate code over fake-indexeddb and jsdom. Held replies expose asynchronous ordering; the sign-in presentation substitute invokes the workspace screen's public callbacks. Root JSON files record the observed outcomes. Client controls use actual HTTP/socket/SQLite and React components; held ordering and selected failures are injected. Desktop controls extract the actual startup adapter, retaining production controller/server/settings and substituting only infrastructure necessary for disposable loopback operation. No harness touches a real profile or publishes a public listener.

| Evidence                                                    | Scope                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [preferences-evidence.json](root/preferences-evidence.json) | Composer refused read, two notification reply races, concurrent first-address registration and sequential refusal control.       |
| [join-evidence.json](root/join-evidence.json)               | Saved-sign-in cancellation, ordinary probe cancellation control and abandoned password completion.                               |
| [signins-evidence.json](root/signins-evidence.json)         | Forgotten sign-in restored by another window and a newly saved sign-in overwritten.                                              |
| [state-results.txt](client/state-results.txt)               | Reordered Follow/Unfollow, sequential control and repeated Mark unread rollback.                                                 |
| [ui-results.txt](client/ui-results.txt)                     | Search deletion/retention/edit, Pins with/without timeline, Profile dismissal versus New message, and real workspace navigation. |
| [restore-gap.json](server/restore-gap.json)                 | Held target refusal, normal restore and concurrent start during publication.                                                     |
| [lifecycle-next.json](desktop/lifecycle-next.json)          | Healthy startup/shutdown, failed post-listen invite-policy write and held backup before cleanup deadline.                        |
