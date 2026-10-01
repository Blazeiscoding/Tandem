# Client/UI investigation — 2 October 2026

Reviewed application source: `a285ee6c8a67e93db01ef2d9046493ea0572a34c`. Application code and existing tests are unchanged. The isolated diagnostic suites pass **six state/lifecycle cases and three DOM cases**. They assert the current problematic behavior, so passing these diagnostics does not mean the issues are fixed.

All servers use in-memory databases, ephemeral localhost ports, disposable accounts, disabled mDNS and disabled rate limits. No live workspace data is read or changed, and these harnesses perform no recursive filesystem cleanup. Structured results are [client-state-evidence.json](client-state-evidence.json) and [client-ui-evidence.json](client-ui-evidence.json).

## New confirmed lifecycle issue

**A destroyed client can send a new corrective pin write that undoes its replacement client's newer intent.** In the real-server reproduction, client A starts a pin whose forwarding is held, then successfully unpins. A is destroyed. Client B reconnects using the same still-valid account session and successfully pins the message. Releasing A's earlier request makes its choice helper issue a new unpin; the server and B both end unpinned. A makes one pin call and two unpin calls, with the second unpin initiated after destruction.

The cause spans [workspace.ts](../../../packages/client-core/src/workspace.ts): `destroy()` at 592–619 does not invalidate the choice map; `choose()` at 2120–2139 immediately starts each request; the completion path at 2157–2162 can initiate a corrective request without checking the stopped state or a client generation. Existing convergence tests cover reordered requests while a client remains active. This case crosses the terminal client lifetime.

The **logout control** uses the real logout endpoint before releasing the old request. A still attempts one repair, but revoked-session authorization prevents the mutation; another account's pin remains intact. This is an authorized stale-client lifecycle bug while a saved session remains valid, **not an authentication bypass**. Only pin was reproduced across the terminal lifetime; DND/save use the same helper but require their own regressions.

Recommended work: fence completion and repair by client lifetime, clear terminal choice ownership, and add cancellation where a request has not yet been sent. Preserve existing active-client intent convergence. Acceptance should recreate close/reopen with a replacement client, plus logout/revocation, and assert no newly initiated old-client repair can undo the replacement's choice. Repeat for pin, save and DND with failure/reconnect orders.

The October implementation record's description of GL-13 as “one in-flight write with latest queued intent” is stronger than current code. The diagnostic observes pin and unpin overlap before releasing the first request, followed by correction. The full serialized-write acceptance remains a separate open requirement; ordinary reordered active-client convergence is not disproved by this investigation.

## Stronger evidence for the planned optimizations

| Diagnostic                   | Observed result                                                                                                                                                                                                          | Current source and plan mapping                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Unrelated thread-cache event | A real top-level socket arrival replaces reply arrays/pages in both loaded threads; serialized replies are identical.                                                                                                    | `workspace.ts:1177–1198`; REV-03                                           |
| Visible thread commit        | The same kind of unrelated HTTP/socket arrival causes **one additional ThreadPanel commit**, with unchanged visible text.                                                                                                | `ThreadPanel.tsx:35–43`, `:79`, `:133`; REV-03                             |
| Production link provider     | Changing only the simulated host bridge's connected count commits **30/30 mounted message rows**. Address-set entries remain equal but its identity changes.                                                             | `ShareableServer.tsx:65–99`, `MessageItem.tsx:56`, `Mrkdwn.tsx:32`; REV-03 |
| Activity invalidation burst  | Ten separately delivered equal-count mentions frames cause **ten requests**, **ten observations of the previous result being absent**, and **nine aborted superseded requests**. The final authoritative result returns. | `ActivityPanel.tsx:53–71`, `workspace.ts:1333–1334`; REV-05                |
| Equivalent initial history   | Two identical unloaded timeline calls cause **two real HTTP requests**; neither fetch signal is aborted on destruction. Both delayed responses return afterward, and neither is installed.                               | `api.ts:268–334`, `workspace.ts:1495–1519`, `:592–597`; REV-05             |
| Private-response growth      | 1,000 unique plus five repeated real private-response frames retain **1,005 items**, **1,031,130 UTF-8 text bytes**, and **six entries sharing one ID**.                                                                 | `workspace.ts:2734–2739`, `MessageTimeline.tsx:443`; REV-04                |

These strengthen the existing plan without reopening implemented history reconciliation, entity-based row subscriptions, history eviction or file-transfer limits. The preserved late-response guard is an explicit control in the history probe.

## Scope and limitations

- State cases use actual `WorkspaceClient`, actual HTTP APIs and actual server/client socket transport. Pin reproductions intentionally delay the first API call **before forwarding it**; subsequent mutations and their echoes are real. This models an outstanding reordered request, not a measured network schedule or packaged close/reopen journey.
- DOM cases mount the actual `ShareableServerProvider`, `MessageItem`, `ThreadPanel` and `ActivityPanel`. The desktop hosting bridge emits controlled status fixtures; real Electron IPC is not run. React Profiler counts come from the development test runtime in jsdom, which does no browser layout/paint or meaningful scroll geometry.
- The DOM harness installs real `ws` transport and Node-compatible abort constructors because Node fetch/EventTarget and jsdom event constructors otherwise conflict. These are harness compatibility adapters, not mocked request/event delivery. Browser-specific transport behavior remains a browser gate.
- Activity/history probes hold delivery **after obtaining a real HTTP response**. They establish request counts, controller state, result blanking and installation guards; they do not establish wasted body-transfer bytes or an improvement in latency. Activity invalidations are spaced across effect turns; same-turn updates can batch.
- Private responses are injected at the production gateway's account-targeted response boundary and reach the real client socket. No external slash-command provider is invoked. Reported text bytes are the encoded contents, not process memory, decoded pixels or retained-heap measurements.
- There are no comparative timing, battery, renderer-memory or capacity claims in these artifacts.

## Reproduce

Run from the repository root:

```powershell
pnpm --filter @slackoss/client-core exec vitest run --config ../../docs/research/2026-10-02-deep/client-node.config.mts
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-02-deep/client-ui.config.mts
```

Each suite replaces only its own JSON evidence artifact. The custom configs use one worker and isolate research diagnostics from the application's ordinary tests. Final runs report six state tests and three DOM tests passing with no unhandled errors. Earlier failed DOM attempts exposed only cross-realm harness incompatibilities; the final artifacts contain the completed diagnostic observations.
