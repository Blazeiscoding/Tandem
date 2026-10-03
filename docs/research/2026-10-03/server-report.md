# Server and protocol follow-up review — 3 October 2026

Reviewed **`cd3af584ba46adace45465cb5e5c66afb238b01c`**, after the requested remote pull, on Windows with Node **24.16.0**. No production code was changed. This report distinguishes new boundaries from the earlier F01–F15 findings and uses ordinary synthetic chat/form content, disposable in-memory SQLite workspaces, actual HTTP, actual WebSocket replay, and loopback app callbacks.

The previous server follow-up findings are repaired in the pulled source. Five additional opportunities are reproduced below: request logging robustness, complete message-content cleanup, redundant sent-schedule content, same-view submission exclusion, and replacement behavior after a message disappears. These diagnostic assertions pass by recognizing the current incorrect behavior; their passing does **not** indicate a product fix.

## Validation and previous findings

- A fresh isolated server suite passes **63 files / 601 tests**, with the existing Windows symlink-path skip: [server-suite-rerun.log](server-suite-rerun.txt). This includes the new Gateway failures, retry retention, private publication and integration-work regressions.
- The root's first broader concurrent run recorded a real failure at `ownership.test.ts:149`: a second server was returned instead of `WorkspaceInUseError` while the child was expected to hold the folder. A focused rerun passes **8 tests / 1 skip**, then the full server rerun passes. See [server-ownership-rerun.log](server-ownership-rerun.txt) and [original root run](root-tests.txt). The original failure's cause remains unresolved; passing reruns do not prove it was environmental or close a possible intermittent ownership issue. Preserve that result and investigate recurrence in CI before making stronger exclusivity claims.
- All four fresh lifecycle probes pass their diagnostic assertions: [server-results.json](server-results.json). They exercise deletion/purge with real replay, schedule send/edit/delete/purge, concurrent modal submit, and a held button response arriving after deletion.
- The logging robustness child/control pair passes its diagnostic assertions: [server-logging-control.json](server-logging-control.json). The expected failed child exits 1; the control survives.

| Prior item | Current code and verification                                                                                                                                                                                                  | Limits of the fresh verification                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F03        | `gateway.ts:62`, `:86`, `:254`, `:388`, `:615` contain heartbeat, complete message/upgrade/close work and unreadable authorization. `gatewayFailures.test.ts` passes in the full suite, including state cleanup and reconnect. | Existing heartbeat regressions advance its timer; this review did not repeat the previous 30-second native fault campaign. The new logging finding below is a separate callback boundary. |
| F04        | `store.ts:2980` excludes accepted `retry_requested=1` intent from history pruning; `:2902` renews abandoned retry history. All 10 `deliveryRetry.test.ts` cases pass, including the restart/drain retention control.           | Historical replay ordering is now explicitly scoped by the updated test/documentation; no global ordering defect is reasserted.                                                           |
| F06        | `gateway.ts:501` catches failed access refresh and `:668` resynchronizes the affected user's devices immediately. The actual-client regression is `client-core/test/recovery.test.ts:171`.                                     | Actual-client suite validation belongs to the root/client audit; this server report confirms the implementation and test exist, rather than claiming a new independent client journey.    |
| F10        | `gateway.ts:582` skips durable offline fanout and shares each committed batch's audiences; `server.ts:696` and `:631` reuse them for deletion recount recipients. The new `publicationCost.test.ts` controls pass.             | No new latency benchmark was run.                                                                                                                                                         |
| F11        | `server.ts:765` shares bot eligibility, workspace identity and callback serialization within an event. `integrationWork.test.ts` passes in the full suite.                                                                     | No new latency benchmark was run.                                                                                                                                                         |
| F13        | The selective candidate-list branch is present at `store.ts:3593`; the expanded `searchPlans.test.ts` matrix passes in the full suite.                                                                                         | No additional performance or universal search-equivalence claim.                                                                                                                          |

Source references below are relative to `packages/server/src/` and correspond to the reviewed SHA, not the earlier plan's line numbers. Protocol permissions, REST/socket validation and search interfaces were inspected; no separate new protocol defect is claimed.

## N1 — P1: malformed URL encoding can terminate request logging

**Confirmed runtime robustness failure.** `redact.ts:57` calls `decodeURIComponent(name)` without containing malformed encoding. Its request serializer at `redact.ts:94` is invoked by Pino/Fastify incoming-request logging, before the HTTP route handler's normal error boundary. `server.ts:1299` enables this serializer when logging is enabled; the shipped server entry explicitly enables logging at `main.ts:402`.

The bounded in-memory child first returns health **200** for an ordinary request. A health request containing an invalid percent-encoded query name then exits **1** with `URIError: URI malformed`, with the stack passing through `redactUrl`, the request serializer, Pino and Fastify's `LogController.incomingRequest`. An identical child with logging disabled answers the same malformed query **200**, then answers a fresh ordinary health request **200**. This establishes the logging-specific process impact under the shipped server's logger setting. It does not measure natural frequency or claim effects beyond the one disposable server.

**Improve:** make URL redaction total over arbitrary request strings. Contain decoding errors and conservatively mask malformed parameter values, retaining useful route shape and preserving existing credential redaction. Logging must not terminate request processing.

**Accept:** logged real HTTP with valid and malformed percent encodings, with and without `=`, returns a controlled response and subsequent health stays 200; secret parameters still stay masked; malformed input cannot cause the fallback to print a credential. A real-child regression must catch process exits, since direct `redactUrl` unit tests alone cannot prove the logger boundary is safe.

Effort: **S**. Evidence/reproduction: [server-logging-control.mts](server-logging-control.mts), [raw child/control JSON](server-logging-control.json), [log](server-logging-control.txt). This is additional to repaired F03; the Gateway fix is functioning.

## N2 — P2: deletion and retention leave button content in replay events

**Confirmed over actual authenticated WebSocket replay.** `store.ts:987` soft-deletes and blanks message text without clearing `actions`. `store.ts:3274` redacts old creation/update events by setting text to empty and files to an empty array at `:3280`–`:3283`, while leaving button labels, values and URLs present. Retention uses the same event-redaction function (`store.ts:1112`). Reconnect sends those retained event bodies (`gateway.ts:316`); `Store.eventsSince` reads their persisted payloads at `store.ts:3303`.

The probe sends an ordinary app message containing a **Meeting RSVP** button and an example meeting-details URL, deletes it through the normal owner HTTP API, then connects a real socket from the prior checkpoint. The replayed creation message has correctly empty text/files, but still contains the original action label, value and URL, followed by the deletion. The soft-deleted database row also retains its action JSON. A second message aged in the disposable fixture and purged through the unchanged production retention method has the same metadata in real replay. Ordinary history omits both messages.

**Implication:** message-associated content still controlled by the server remains readable in its event history after removal. A final deletion frame correctly clears normal client state, but cannot remove the earlier bytes already transmitted during replay. This is current-authorized-member replay and stored-content cleanup; no new channel access or outside-party disclosure is asserted.

**Improve:** include action labels, values and URLs in the content-redaction policy and clear actions on soft-deleted rows. Keep identifiers/order needed for replay, and keep live actions on surviving messages. Review superseded button replacement under the same policy.

**Accept:** delete and purge app messages with populated actions, reconnect from before creation, and verify no old label/value/URL survives in any persisted/replayed content. Preserve blank text/file redaction, replay order, deletion/history removal, and actions on unrelated live messages. Existing access controls must remain intact.

Effort: **S**. Evidence: `actions` in [server-results.json](server-results.json); [server-probes.mts](server-probes.mts). Related to the older queued-text cleanup policy, but **not** a recurrence of the fixed old text-in-delivery-body defect or F07's file-cache issue.

## N3 — P2: delivered schedules retain deleted and superseded text

**Confirmed stored-content lifecycle gap.** A schedule duplicates the message text at creation (`store.ts:2100`). On delivery, `markScheduledSent` (`store.ts:2254`) records `status='sent'` and the message ID, then releases file reservations, without clearing `text` or `file_ids`. Message edit/delete does not scrub the sent schedule's copy. Retention only nulls its message pointer (`store.ts:1101`); `pruneScheduled` (`store.ts:2318`) subsequently removes sent rows after the separate seven-day window (`server.ts:124`, `:4348`).

Using normal schedule HTTP creation, the exposed unchanged production scheduler, and normal message edit/delete HTTP:

- Deleting a sent **The meeting starts at ten.** message leaves that exact text in its `sent` schedule row.
- Editing a delivered message from **The venue is the small room.** to **The venue is the large room.** changes the canonical message while the schedule retains the original text.
- Aging a delivered message and its schedule time by two days in the disposable fixture, then applying production one-day history retention, removes the message and nulls the schedule pointer but leaves **Bring the agenda to the meeting.** in the sent row. Production seven-day schedule pruning retains it.

`GET /api/scheduled` correctly omits these sent rows; therefore this is a redundant database content copy, not demonstrated ordinary API access to removed words. Backup inclusion follows from backing up this database, but this probe did not independently export a backup. Future/held/failed unsent schedules remain legitimate user work and must keep their text.

**Improve:** strip content from sent schedule completion records in the same posting transaction, retaining only the completion/idempotency metadata actually needed. If a feature needs sent content, resolve the canonical message under current access/retention rules instead of retaining an independently expiring original copy. Migrate existing sent content under the selected policy.

**Accept:** after delivery, edit, delete and short history retention, the original text is absent from stored sent schedule records while completion/replayed scheduling requests still behave correctly. Preserve outstanding schedule text, attachments, exactly-once accepted send behavior, and restart/retry status.

Effort: **S/M**. Evidence: `scheduled` in [server-results.json](server-results.json). This is a new content-copy boundary, not F04's accepted integration-retry retention.

## N4 — P2: one modal can be submitted twice while its first response is pending

**Confirmed duplicate callback dispatch.** `server.ts:3466` reads the open view, validates its owner/capability and fields, then admits an app call at `:3512`. It awaits the callback at `:3537` and deletes the view only after successful response processing (`:3569`). There is no per-view pending claim during the await. Account/app call limits permit multiple distinct calls and do not enforce one submission per view.

With the default admission limits enabled, a normally issued trigger opens a valid one-field modal through `views.open`. Two concurrent owner submissions with identical ordinary values are held by a real loopback app. The app receives **two `view_submission` callbacks with the same view ID and answers**, and both HTTP requests return **200 / `{ok:true}`**. A later sequential repetition returns **404**, confirming that completion removes the view but the in-flight interval remains open.

No duplicate business side effect was performed; the app stub records callback dispatch only. The tested trigger/view ownership and channel authorization controls work. A single disabled submit button cannot establish server exclusion across contexts or retried requests.

**Improve:** claim a valid view synchronously before dispatch, then share or explicitly reject same-view in-flight repeats. Release it under a documented retry policy on callback errors/field-validation errors. For side-effecting app flows, stable submission identity lets the app safely deduplicate a retry after an uncertain response; server exclusion alone cannot guarantee exactly-once external side effects.

**Accept:** two concurrent requests for one view cause one callback and predictable results for both callers, while two different views can proceed independently. App field errors permit correction; transport failure/retry has an explicit policy; ownership, expiry, capacity and revocation remain correct.

Effort: **M**. Evidence: `submission` in [server-results.json](server-results.json).

## N5 — P2: replacing an already-deleted app message creates a different message

**Confirmed ordinary in-flight consistency error.** `deliverCommandReply` checks for replacement/deletion directives at `server.ts:2962`, looks up the origin at `:2964`, and handles them only while it exists. If the origin is missing, execution falls through to the ordinary `in_channel` post at `:2982`.

The probe posts **Please confirm attendance.** with an **Attend** button, invokes it through normal HTTP, and holds the real app response. The owner deletes the original through normal HTTP. The app then returns a valid `replace_original:true`, `response_type:'in_channel'` answer with **RSVP recorded.** The action request returns **200 / `{ok:true}`**; the original remains deleted, but a **different new message ID** appears with the replacement text.

This is replacement intent being interpreted as a new send after a race. It does not recreate the original row or prove that an independently requested ordinary app reply should be refused. It is separate from the capability revocation checks, which are still needed.

**Improve:** resolve replacement/deletion intent before the general posting path; a missing origin should produce a documented no-op/gone outcome. Consider a message revision policy for an origin edited while a replacement is pending, preserving intentional app updates without silently overwriting newer user edits.

**Accept:** immediate and delayed replacement/deletion against a removed origin never create a new message. Existing origins still replace/delete correctly, ordinary replies still post normally, and thread/channel access revocations remain effective. Add an explicit concurrent-edit decision/control.

Effort: **S** for the missing-origin branch, **M** if adding revision semantics. Evidence: `replacement` in [server-results.json](server-results.json).

## Reproduction and evidence limits

From the repository root:

```powershell
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-03/server-probes.mts
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-03/server-logging-control.mts
pnpm --filter @slackoss/server exec vitest run test/ownership.test.ts
pnpm --filter @slackoss/server test
```

The scripts write only their owned JSON reports. Lifecycle fixtures use in-memory databases and loopback servers; disk inspection reaches the disposable Store's actual SQLite connection. No existing user database/data directory or private `.audit-client-143` content is opened. Retention time is established by fixture row timestamps, not by waiting days. App callbacks are synthetic loopback endpoints, explicitly allowed for this fixture. No latency/scaling/real-installer results are claimed.

The initial lifecycle harness mistakenly enabled `isolated:true`, a mode intentionally disabling scheduler/outbound execution. Its expected send/callback assertions failed for that prerequisite; this was corrected before the final successful run. [Initial JSON](server-results-initial.json) and [initial log](server-probes-initial.txt) are preserved. Those two harness failures are **not** application findings. The final results contain only the four complete lifecycle cases; logging has its separate complete report.

Suggested sequence: N1 logger containment; N2/N3 complete content lifecycle; N4 submission ownership; N5 replacement semantics. Preserve the repaired F03/F04/F06/F10/F11 controls throughout. Keep the initial intermittent ownership result visible even though both isolated reruns pass.
