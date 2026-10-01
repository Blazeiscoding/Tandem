# Server investigation — 2 October 2026

Reviewed source: `a285ee6c8a67e93db01ef2d9046493ea0572a34c`. Windows x64, Node 24.16.0. Application source is unchanged. This report adds six findings or deeper reproductions to the initial review; it does not reopen completed database, mention-index, retention, ownership, backup or shutdown fixes.

Run from the repository root:

```powershell
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-deep/server-probes.mts
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-deep/server-publication-gap.mts
```

The [diagnostic script](server-probes.mts) creates an owned temporary root, runs nine bounded child processes with `windowsHide: true`, saves structured observations and raw logs, verifies the resolved cleanup target and ownership marker, then removes its disposable data. The [follow-on script](server-publication-gap.mts) runs one additional bounded real-client child. Named Store-method exceptions are injected only inside the children. Native production timers and immediate callbacks are unchanged. Other cases use real HTTP/filesystem operations or the real Store transaction/query implementation. No live workspace data is read. Counts and failure outcomes are evidence; elapsed time is not a benchmark. [Original structured results and complete captured output](server-results.json), [follow-on structured results](server-publication-gap-results.json).

## Results and next work

| Finding                                                                                   | Priority / scope  | Verified outcome                                                                                                            | Existing plan relationship                          |
| ----------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| SERVER-01: background failures terminate the process                                      | P1 / small–medium | Actual scheduled interval, scheduled immediate continuation and delivery interval each exit with code 1                     | Stronger reproduction of REV-01                     |
| SERVER-02: failed deletions starve healthy cleanup across restart                         | P1 / medium       | Healthy file remains behind 100 failures; its 21 bytes remain counted until repair and a second flush                       | Stronger reproduction of REV-02                     |
| SERVER-03: retry bypasses the integration waiting cap                                     | P2 / medium       | Authenticated HTTP retry creates 1,500 waiting rows for a subscription capped at 500                                        | New concrete slice of aggregate-capacity work       |
| SERVER-04: slow endpoint holds back another endpoint's next event                         | P2 / medium       | Fast endpoint's first event is acknowledged, but its next stays pending until the unrelated held response ends              | New queue-fairness evidence under OPT-15            |
| SERVER-05: thread deletion multiplies mention queries                                     | P2 / small–medium | 21 removed messages × 50 members = 1,050 recount calls, with zero connected users                                           | Deeper REV-06 publication evidence                  |
| SERVER-06: post-commit failure skips durable frames and reconnect cannot repair the cache | P1 / medium       | DELETE returns 500 after commit; a real client misses three deletions and retains removed content after automatic reconnect | New acknowledgement/publication/checkpoint boundary |

### SERVER-01 — Native background entry failures

Three children exited with code **1**, without deadline termination. Their captured stacks identify the production callers:

- [Scheduled interval log](server-schedule_timer_failure.log): `Store.dueScheduled` → [server.ts:4033](../../../packages/server/src/server.ts) → `Timeout._onTimeout` at 4089.
- [Scheduled continuation log](server-schedule_immediate_failure.log): one successful explicit turn returns and commits its first scheduled message; the production `setImmediate` at 4079 then encounters the injected read failure. The post-exit database contains one sent schedule, one queued schedule and one live message.
- [Delivery interval log](server-delivery_timer_failure.log): `Store.dueEventDeliveries` → delivery flush at 733/798 → production interval at 4092. The discarded rejection terminates the child under the runtime's default behavior.

The [uninjected scheduled interval control](server-schedule_timer_control.log) exits **0**, sends the due schedule and leaves exactly one message. All filesystem database snapshots pass `PRAGMA quick_check`. The delivery failure case has no pending integration deliveries; it proves host termination through that timer, not preservation or loss of a delivery backlog. These are synthetic Store read failures, not reproduced physical disk corruption or disk exhaustion.

**Next:** contain synchronous and asynchronous background entry failures, retain durable work, record failure/backoff and retry safely. Include immediate continuations and startup cleanup. Keep explicit operational callers informed. **Accept:** native child-process timers survive injected read and write failures, continue serving chat, resume after repair and stop cleanly; failed transactions publish nothing and drain jobs do not overlap. This extends the earlier helper-only evidence to actual process termination.

### SERVER-02 — Cleanup starvation, persistence and accounting

[store.ts:1560](../../../packages/server/src/store.ts) selects an unordered `LIMIT 100`. [server.ts:912](../../../packages/server/src/server.ts) leaves failed entries in that same queue. The fixture uploads a real 21-byte blob through HTTP, removes its metadata transactionally and queues it after 100 valid-ID directory paths. Those directories cause real `unlink` errors without a filesystem mock.

[Cleanup observations](server-cleanup_fairness.log): three flushes and a full stop/start/flush all retain **101 pending entries**, the healthy blob and **21 counted bytes**. After removing the owned empty directories, the first flush completes their 100 entries but still leaves the blob; the second flush removes it, leaving zero pending entries and zero counted bytes.

**Next:** persist retry eligibility and stable ordering, back off individual failures and schedule bounded continuation turns for healthy work. **Accept:** a healthy 101st entry progresses despite the first 100 failing; restart retains retry state; permanent failures remain visible; bytes are released only after successful deletion. The accounting and repair behavior currently work and must be preserved.

### SERVER-03 — Retry exceeds the advertised pending ceiling

Normal enqueue admission checks the **500** waiting-row ceiling at [store.ts:2662/2680](../../../packages/server/src/store.ts). Terminal failures are excluded from that count. [store.ts:2815](../../../packages/server/src/store.ts) restores every failed row without checking remaining waiting capacity; [server.ts:3587](../../../packages/server/src/server.ts) exposes it through authenticated administrator HTTP retry.

The [retry-capacity fixture](server-retry_capacity.log) uses normal Store enqueue/abandon operations to create two failed groups of 500 and a third waiting group of 500. `POST /api/subscriptions/:id/retry` returns **200**, `retried: 1000`; the result is **1,500 waiting rows** for that one subscription. The durable post-exit snapshot also contains 1,500 rows. `isolated: true` deliberately prevents outbound delivery while observing the admission invariant; no retry or timer is mocked.

**Impact:** repair can exceed the queue's waiting ceiling and block admission of fresh events. Failed rows can also accumulate across failure cycles until pruning; this probe demonstrates three cycles, not unlimited growth over real elapsed days.

**Next:** define whether failed history and retry-ready work share a row/byte budget. Restore a bounded ordered prefix or use a distinct durable retry backlog with bounded promotion; report remaining work rather than silently dropping it. **Accept:** repeated terminal failures followed by Retry never exceed configured ready-work limits, preserve per-subscription order/redaction and eventually drain after recovery. Include retry with an already-full waiting queue.

### SERVER-04 — Cross-endpoint batch barrier

[server.ts:736](../../../packages/server/src/server.ts) awaits `Promise.all` for the whole delivery batch. The shared in-flight promise at 725 prevents any second flush from making progress until that batch ends. The per-subscription query already preserves order; the extra batch barrier affects other subscriptions.

The [real loopback HTTP probe](server-endpoint_independence.log) queues one slow-endpoint event and two fast-endpoint events. The slow response is held. The fast endpoint acknowledges its first event and the server still answers health with **200**, but the fast second event remains pending and another flush returns the same in-flight promise. Releasing the slow response lets the fast endpoint receive its second event in order. No measured latency improvement is claimed. The production outbound deadline is bounded, defaulting to 4,000 ms at [outbound.ts:110](../../../packages/server/src/outbound.ts), so this is temporary cross-endpoint delay, not demonstrated indefinite starvation.

**Next:** consider a bounded delivery pump that refills freed slots while keeping one delivery in flight per subscription and preserving the current total concurrency/work budgets. **Accept:** an unrelated held response does not prevent a healthy endpoint's next ordered event from starting; concurrency is bounded; revocation, redaction, shutdown abort and restart deduplication remain correct. Benchmark before changing the scheduler.

### SERVER-05 — Per-message recount amplification on thread deletion

[server.ts:1069](../../../packages/server/src/server.ts) deletes every reply and root in one transaction but emits a separate deletion event for each. Publication at 600 refreshes every channel member for each deletion; 585 calculates counts even when no socket exists.

[Actual HTTP deletion](server-deletion_publication.log) of one root plus 20 replies in a 50-member private channel returns **200** and performs **21 durable publications and 1,050 `unreadMentionCounts` calls**, although no user is connected and none of the generated messages mentions anyone. This is a query-call count, not a statement-time or UI-stall measurement. Durable per-message events currently serve replay semantics; the evidence does not justify removing them wholesale.

**Next:** filter refresh recipients to live accounts and deduplicate replaceable mention invalidations across the committed mutation. Keep deletion events and durable sequence semantics. **Accept:** that fixture performs zero publication recounts with no sockets, at most one final recount per affected connected account, and still empties live/replayed threads correctly. Compare mixed chat latency before accepting further batching changes.

### SERVER-06 — Post-commit failure skips frames and passes the replay checkpoint

The same fixture injects an exception into `Store.unreadMentionCounts` after deletion commits. [server.ts:628](../../../packages/server/src/server.ts) performs publication after the transaction; the first refresh failure interrupts the remaining durable-event publications and propagates to the HTTP DELETE handler at 1896.

[Observed write boundary](server-deletion_publication.log): DELETE returns **500**; the root and all 20 replies are no longer readable; **21 deletion events remain committed**. Restoring the count method and retrying DELETE returns **404**. The refresh failure is injected; the transaction and HTTP response paths are real. This probe does not establish that every write route has the same outcome or that server-side duplication occurs.

The [real-client follow-on log](server-publication-gap.log) and [structured frame/state evidence](server-publication-gap-results.json) deepen the impact. It uses the actual `WorkspaceClient`, real HTTP history/send/delete and native Node WebSockets, with an observation-only socket subclass. No client state, transport payload or reconnect timer is mocked:

1. The reader loads a root and three replies. A root DELETE commits deletion events **5–8**, but only event **5** reaches the socket before the recount failure. The reader retains the deleted root and two replies; DELETE returns 500.
2. After restoring the count method, a normal message produces event **9**. The reader advances its checkpoint to 9; deletion events 6, 7 and 8 were never received.
3. Closing the real socket triggers automatic reconnect. The server supplies `replayFrom: 9`, snapshot seq 9 and **zero replayed events**. The client remains online with the deleted root and two replies still cached.
4. Explicitly loading latest HTTP history removes the stale timeline root and shows the later message. Thus automatic reconnect fails to repair this cache, but absolute irrecoverability is **not** claimed; the explicit latest control only verifies timeline recovery.

The causal boundaries match [workspace.ts:897](../../../packages/client-core/src/workspace.ts), which accepts a later sequence as its checkpoint; 733/777, which preserves loaded history on successful replay; and [store.ts:3119](../../../packages/server/src/store.ts), which replays only events newer than that checkpoint. Invisible channel events can legitimately create sequence gaps, so naive global-gap detection is not a complete protocol solution.

**Next:** isolate replaceable publication failures from committed mutation acknowledgement and from delivery of every remaining durable event. If durable fanout cannot complete, ensure affected connections resynchronize before later events let them pass the missed range. Preserve immediate access revocation and define idempotent delete acknowledgement. **Accept:** failures before commit roll back; refresh failures after commit produce consistent acknowledgement and do not skip the remaining deletion frames. Repeat the actual-client scenario, including later events and automatic reconnect; removed roots/replies cannot remain cached as live content. Cover permission-filtered sequence gaps and durable-fanout errors separately.

## Preserved behavior and investigation limits

The [retention fixture](server-retention_boundary.log) confirms the existing, explicitly documented whole-thread exception: one old root with 6,000 replies is removed as **6,001 rows** despite the nominal 5,000-message pass budget ([store.ts:1047](../../../packages/server/src/store.ts)). An injected outer transaction failure restores all 6,001 rows. The query uses `idx_messages_thread_page` for both roots and replies. This is **not a newly discovered correctness regression** or evidence to reopen the merged retention work. A strict stall budget still needs realistic dependent-row/byte measurements and a design that preserves thread integrity.

All ten children returned the expected outcomes: three intentionally failing background-entry children exited 1; seven controls/diagnostic cases exited 0; none timed out. No application implementation or deployment was performed. This run does not measure SQL latency, renderer timing, disk-failure frequency or production capacity. Existing revocation tests remain relevant, but these probes do not newly certify concurrent revocation of in-flight requests.
