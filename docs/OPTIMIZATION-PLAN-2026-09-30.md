# Gatherline optimization plan: Electron, chat and server

**30 September 2026 · Gatherline `7d91fd3` · proposed experiments, not performance claims.** This expands the [complete update plan](UPDATE-PLAN-2026-09-30.md) following the request to study [T3 Code](https://github.com/pingdotgg/t3code/tree/ff1db030b179ef712cacc0098366d976e2877f45) and similar chat applications. Every experiment must preserve access, event order, accepted-message integrity, recovery and usable keyboard/touch interaction.

Inspected references: T3 Code `ff1db030…`, Signal Desktop `abe80d32…`, Zulip `7a921db6…`, Mattermost `cc0611f2…`, Element in the [additional chat report](research/2026-09-30/additional-chat-comparison.md), and Rocket.Chat `aa73c68a…` / Electron `d3d3f165…` in the [Rocket.Chat comparison](research/2026-09-30/rocket-chat-comparison.md). The Rocket.Chat follow-up was reconciled against Gatherline `7d70dac`, preserving #151–#165's merged work. Pinned paths, source mechanisms and caveats are in the [Electron](research/2026-09-30/electron-comparison.md), [client](research/2026-09-30/chat-client-comparison.md), and [server](research/2026-09-30/server-comparison.md) reports. Source inspection demonstrates a technique exists; none of these applications was benchmarked against Gatherline.

## 1. Preserve optimizations already present

| Existing mechanism                                                                   | Current boundary                                                       | Further question                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Timeline and thread windows of 300 messages                                          | Loaded history is bounded; old/new windows remain pageable             | Does rendering all loaded rows waste work? How much do retained text/metadata and decoded pixels cost? |
| 20 history-cache entries per category with protected active views                    | Inactive timelines and threads evict by recency                        | Count limits differ from byte/pixel limits; profile long code messages and image-heavy histories       |
| Attachment cache: 32 MiB idle blobs, four body transfers, cancellation/deduplication | Fetch/idle compressed bytes bounded; visible images load near viewport | Active blobs and decoded images can exceed compressed-byte budget; thumbnails may help                 |
| WebSocket queued-byte cutoff at 2 MiB, bounded replay/snapshot fallback              | Slow readers disconnected; durable replay retained                     | Aggregate connections, reconnect bursts and renderer application cost need measurement                 |
| Scheduled queue caps, ten-item drain, held-row backoff                               | Prior due-queue starvation/stalls improved                             | Huge retention threads, multiple integrations and other synchronous work still compete                 |
| Worker-thread desktop backup/verify/restore                                          | Heavy recovery SQLite work avoids Electron main                        | Ordinary embedded-server queries still execute in Electron main                                        |
| Lazy dialogs/panels and 500 kB entry limit                                           | Initial JavaScript size enforced                                       | Download size alone does not measure startup parse, paint, hydration or interaction                    |
| Search formatter canonicalization and 32-entry LRU                                   | Unbounded timezone retention fixed                                     | Search query plans, result hydration and admission cost remain                                         |
| Streaming file transfer, nonce idempotency, transactional reservations               | Integrity and memory foundations exist                                 | Avoid trading these away for batching or cache speed                                                   |

The corrected 200,000-message desktop workload already recorded search around 220–240 ms, a 20-reader burst around 337 ms, and retention around 150 ms longest loop stall in its environment. These exceed the documented 100 ms desktop-main target in some workloads; they do not prove every installation requires a process redesign. The new sparse-thread index probe below measured an actual candidate in the current code.

## 2. Evidence contract for every experiment

- [ ] Record baseline SHA, candidate SHA, fixture seed, runtime/build, hardware, platform, cache state and enabled features.
  - [ ] Measure cold and warm paths separately; repeat enough times to report sample count, p50/p95 and dispersion. Avoid unrelated concurrent heavy workloads during timing.
  - [ ] Capture whole-app/process-tree memory, heap/RSS, CPU/idle wakeups, bytes/request count, loop stalls and user-visible completion time as relevant.
  - [ ] Verify responses/row counts/permissions and expected results before timing; never benchmark an error response as successful work.
  - [ ] Report regressions: write amplification/index size, extra processes/threads, package bytes, battery work, latency and recovery complexity.
  - [ ] Keep the change only if its target improves and correctness/other declared budgets hold. Record rejected experiments so another agent does not repeat them without new evidence.

Suggested fixtures: small fresh workspace; 50,000 and 200,000 messages with realistic same-channel threads; sparse old thread; 1,000 channels/users when supported; attachment-heavy history with varied dimensions; 2,000 due/held schedules within configured limits; reconnect and slow-reader mix; long-lived navigation across caches. These are workload shapes, not advertised capacity.

## 3. Electron startup, packaging and process ownership

### OPT-01 · First · Establish traces and an operating envelope

**Targets:** `scripts/measure-stall.mts`, desktop main startup, `WorkspaceClient`, channel/thread/search journeys. T3 has focused client microbenchmarks; Signal records actual query execution time. Borrow the measurement separation, not their results.

- [ ] Add reproducible startup milestones: process launch, module load, settings, host ready, renderer ready, first usable conversation.
  - [ ] Profile join-only, hosting, tray sign-in, reconnect and renderer restore separately.
  - [ ] Capture query execution versus queue/serialization/IPC/render time.
  - [ ] Add mixed successful chat/search/file/replay workloads to existing stall probes.
  - [ ] Choose low-spec reference hardware and budgets; keep existing 500 kB entry and 100 ms main-loop targets visible.
  - [ ] Retain a small JSON result artifact with fixture/runtime metadata and a readable interpretation.

**Done:** subsequent optimization PRs can reproduce the same successful workload and identify which stage improved. Measurement infrastructure alone is not completion of the later code-change tickets.

### OPT-02 · Small/medium experiment · Enable compilation cache before loading main

**Reference:** T3's [early compile-cache bootstrap](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/desktop/src/boot.ts). **Gatherline:** `apps/desktop/package.json`, `src/main/index.ts`, Electron build entry.

- [ ] Prototype a small entry that enables the packaged runtime's supported compile cache before importing the real main bundle.
  - [ ] Use a private per-user cache, optional/fail-open behavior, expiry/size limits and version/architecture separation.
  - [ ] Verify writable/unwritable locations, first launch, repeat launch, update and relocated/AppImage paths.
  - [ ] Measure module-load/first-usable time, cache bytes and first-run overhead; leave coverage/test semantics explicit.

**Done:** warm startup improves measurably with acceptable cold overhead; absent or corrupt cache never prevents launch. It is not a runtime SQL optimization.

### OPT-03 · Medium experiment · Reduce packaged dependency duplication

**Reference:** T3's shared runtime-external policy and packaging closure in the Electron report. **Gatherline:** `electron.vite.config.ts`, builder configuration and runtime dependency tree.

- [ ] Inventory installer/ASAR/unpacked files and determine which code is both bundled and shipped as external packages.
  - [ ] Bundle compatible ordinary JavaScript once; preserve native/filesystem-dependent packages and required assets as externals.
  - [ ] Remove demonstrated duplicates/platform-inapplicable resources, retaining licenses and deliberate diagnostic symbols.
  - [ ] Validate built preload/worker entry imports after changing bundling.
  - [ ] Measure package/extraction size, cold resolution and first usable time on installed targets.

**Done:** package or startup improvement is demonstrated with all runtime paths intact. No current saving was established from removing source maps, which were absent from inspected output.

### OPT-04 · Large spike · Isolate the embedded server when measured stalls require it

**References:** T3 supervised backend, Signal SQL worker ownership. **Gatherline:** `index.ts` server construction, hosting controller, backup worker and CLI bundle.

- [ ] Compare the smallest isolated-backend boundary using a worker, `utilityProcess`, or supervised child, without changing participant REST/WebSocket contracts.
  - [ ] Preserve #153's directory ownership when moving the backend. Keep queues, discovery, route, port and hold state owned by one run, including the remaining recovery-boundary limitations recorded under FIX-11.
  - [ ] Add bounded readiness/start/stop/restart behavior and fence all async callbacks to that run.
  - [ ] Coordinate backup/restore, shutdown, crash recovery and IPC; never restart a held copy into ordinary use.
  - [ ] Compare UI stall p95/max, HTTP latency, total process memory, startup and recovery at 50k/200k mixed workloads.

**Done:** main-window responsiveness holds without duplicate owners/jobs or loss of accepted work. A read-worker pool is a later comparison if one isolated backend is insufficient; do not immediately copy Signal's worker count or T3's force-kill timeout.

## 4. Rendering, retained state and attention cost

### OPT-05 · Small first change · Narrow message-row subscriptions and keep references stable

**References:** Mattermost per-post selector factories; T3 stable row projection. **Gatherline:** `MessageItem.tsx`, `MessageTimeline.tsx`, `context.ts`, replica updates.

**Status:** merged in #164 (`e02d2ac`). `MessageItem` subscribed to the whole `users` and `channels` maps and to `self`, so any profile edit, channel update (including someone joining another channel) or change to your own status rendered every row on screen, in the timeline and the thread panel alike. Each row now subscribes to what it shows: its author, the people it names or who reacted to it, the channels it names or links a message in (`useMessageReferences`, `src/lib/messageReferences.ts`), and your own ID and role as two primitives. Each of those selectors does nothing while its map is the same object, which is most updates, and hands back the same object until an entry it shows changes.

Measured on `7d6272d` against the candidate with `packages/ui/test/measureRowRenders.dom.test.tsx`, which is skipped unless asked for (`MEASURE_ROWS=1 NODE_ENV=production pnpm --filter @slackoss/ui exec vitest run test/measureRowRenders.dom.test.tsx`): 300 rows (the timeline's cap) of `MessageItem`, React 19.2.8 production build under jsdom, Node 24.21.0, Linux container; `flushSync` wall time per replica change, 40 samples after 3 warm-ups, two runs each. jsdom does no layout or paint, so these compare React's work only, not what a person feels.

| Change                          | Rows rendered before → after | p50 ms before | p50 ms after |
| ------------------------------- | ---------------------------- | ------------- | ------------ |
| Profile of someone no row shows | 300 → 0                      | 106–117       | 0.41–0.42    |
| Someone joins another channel   | 300 → 0                      | 96–107        | 0.33–0.34    |
| Your own status                 | 300 → 0                      | 96–109        | 0.22–0.23    |
| Someone typing                  | 0 → 0                        | 0.09          | 0.22–0.23    |
| Save one message                | 1 → 1                        | 0.99–1.27     | 1.22–2.05    |
| Rename the author of 60 rows    | 300 → 60                     | 98–102        | 22–25        |

The cost is the selectors: every replica change now runs two per row, about 0.1 ms per change over 300 rows, and a row that does render runs them again. The web entry grew 1.0 kB, to 472.8 kB. `test/rowCommits.dom.test.tsx` holds the row counts (each row in its own `Profiler`) and checks that a renamed author, a renamed person named in a message, a renamed reactor and a renamed linked channel still show, on exactly the rows that show them, and that a change of role still offers Delete on every row.

- [x] Replace broad subscriptions to entire users/channels/self maps with the author, current role/ID and entities the row actually renders.
  - [x] Use stable derived selectors/references for mentions, reactions, pins, saved and grouped row props; avoid allocating selector arrays on every unrelated event. Saved was already one boolean per row, pins and grouping are props of the message, and the timeline's callbacks are already stable.
  - [x] Preserve live author/channel rename, permission and mention rendering; do not memoize stale authorization.
  - [ ] Measure row render/commit counts and input delay under unrelated presence/profile/channel events and busy Saved changes. Row counts and React time are measured; input delay in a real browser is not.

**Done:** unrelated changes cause materially fewer row commits with the same visible result. Prefer this low-risk change before adding a list library.

### OPT-06 · Medium spike · Separate the rendered window from loaded history

**References:** T3 LegendList with stable row keys; Zulip bounded DOM/selected-row anchoring; Mattermost measured variable-height list. **Gatherline:** `MessageTimeline`, `ThreadPanel`, `useRovingMessages`.

- [ ] Compare current bounded 300-row DOM, CSS rendering containment where safe, and a smaller/windowed DOM on realistic histories.
  - [ ] Measure variable rows after image load, edits, wrapping, thread summaries and menu opening.
  - [ ] Preserve first-visible ID/offset, tail following, around-message jumps, unread divider and Back/reload reading position.
  - [ ] Keep focused rows/menus available and support keyboard/screen-reader navigation through unmounted rows.
  - [ ] Bound any keep-mounted exception for focused/playing media. [Rocket.Chat RC-1](research/2026-09-30/rocket-chat-comparison.md#rc-1-window-rendering-without-retaining-every-media-row) shows why retaining every attachment/preview row can defeat windowing; compare redecode/reload cost and preserve accessible list/reading-position behavior.
  - [ ] Measure scroll/frame/commit cost, memory and library/entry-size overhead; include touch and real browser geometry.

**Done:** windowing beats the existing cap in a relevant task without lost anchors or inaccessible history. T3/Zulip overscan and height constants are not Gatherline defaults; reject the dependency if the current DOM is already cheap enough.

### OPT-07 · Medium · Batch replica publication during catch-up while retaining event order

**Reference:** chat fetch/event batching patterns in the client/server reports. **Gatherline:** `WorkspaceClient.applyEvent`, WebSocket reconnect/replay, store publication.

- [ ] Separate ordered event reduction from React/store notification where a burst currently causes repeated work.
  - [ ] Keep durable outbox mutations/persistence and notification/access hooks independent of delayed visual publication. `DraftPersistence` currently observes store changes; blanket subscription batching must not reopen #147's delayed-persistence gap.
  - [ ] Bound visual latency and provide a hidden-window fallback for frame-based work. Apply Element's incremental sidebar ordering and frame-coalesced visual emissions only after measuring current full-sort cost; see [ELM-1](research/2026-09-30/additional-chat-comparison.md#elm-1-batch-visual-room-list-publication-and-update-the-affected-entry).
  - [ ] Yield large replay work at bounded units and publish coherent snapshots without skipping seq/nonce reconciliation.
  - [ ] Check loaded, protected inactive and evicted history through edits/deletes/root removal and later refetch. [Rocket.Chat RC-2/3](research/2026-09-30/rocket-chat-comparison.md#rc-2-stable-selection-is-separate-from-selection-cost) refines derivation/catch-up profiling; keep Gatherline's sequence authority rather than introducing timestamp sync.
  - [ ] Apply deactivation/membership/access invalidation promptly; do not leave forbidden previews rendered until a long batch ends.
  - [ ] Deduplicate replaceable typing/presence work when safe, while retaining durable read/unread and mutation order.
  - [ ] Measure 100/1,000/10,000-event reconnect bursts within configured replay limits, interaction delay and resync bytes.

**Done:** catch-up work is smoother and bounded with identical final state and no duplicate notifications/sends. Existing durable replay remains the authority.

### OPT-08 · Small/medium · Memoize expensive derived rendering under explicit cache limits

**Reference:** T3 separates stable rows and caches code highlighting by count/bytes. **Gatherline:** `Mrkdwn`, grouping/day labels, mention/reaction lists, search highlighting and Composer suggestions.

- [ ] Profile expensive parsing/lookup/formatting before introducing caches.
  - [ ] Key cached derivations by immutable text/revision plus relevant entity/theme inputs and clear them on account change.
  - [ ] Set count/byte bounds and avoid retaining full workspaces through cached callbacks or old row objects.
  - [ ] Keep escaping/link safety and IME/selection behavior; do not add a heavyweight syntax highlighter for a micro-optimization.
  - [ ] Measure long code messages, repeated paging, burst reactions and suggestion typing with/without the cache.

**Done:** saved CPU exceeds cache overhead and memory remains bounded. T3's 50 MiB highlighting cache is a reference mechanism, not a proposed Gatherline size.

### OPT-09 · Medium · Budget active/decoded media and history bytes

**References:** T3 count-and-byte LRU, Zulip derived thumbnails. **Gatherline:** history LRU, `FileCache`, `Attachments` and lightbox.

- [ ] Measure compressed blobs, active references, decoded pixel dimensions and retained message metadata separately.
  - [ ] Assign one derivative-media owner/artifact shared with OPT-16; renderer memory and server transfer experiments must use the same access, dimensions and cleanup contract.
  - [ ] Add appropriate pixel/dimension limits and bounded server-owned thumbnails, with access checks and cleanup.
  - [ ] Avoid decoding originals for small previews; keep original file download/lightbox explicit and cancellable.
  - [ ] Consider a shared viewport observer and release offscreen decode resources without losing reserved geometry/anchors.
  - [ ] Evaluate a byte budget in addition to existing history-count LRU if long text/metadata exceeds target memory.
  - [ ] Distinguish Blink image-cache accounting from retained blobs, decoded dimensions and whole-process/GPU memory. [Rocket.Chat RC-7](research/2026-09-30/rocket-chat-comparison.md#rc-7-distinguish-browser-image-cache-pressure-from-stored-attachment-bytes) provides an event-driven pressure signal; broad frame-cache clearing needs measured refill/scroll costs and supported diagnostic APIs.

**Done:** image-heavy/long-text navigation stays within a declared memory envelope and access removal revokes local resources. Preserve current fetch deduplication, four-transfer cap and 32 MiB idle-blob budget.

## 5. SQLite, search, snapshots and maintenance

### OPT-10 · Small first candidate · Add the measured thread-history composite index

**Local evidence:** [sparse-thread probe](research/2026-09-30/server-comparison.md#3-measured-optimization-sparse-old-thread-history). `store.ts` thread pagination currently selected `(channel_id,id)`, scanning unrelated newer messages. Scratch `(thread_root_id,id)` changed the query plan.

| Controlled warm SQL reads, 30 samples | Existing indexes | Scratch composite index |
| ------------------------------------- | ---------------- | ----------------------- |
| p50                                   | 6.334 ms         | 0.066 ms                |
| p95                                   | 7.777 ms         | 0.102 ms                |

**Status:** merged in #160 (`2fd31c0`), schema v28. `(thread_root_id, id)` replaces the single-column `thread_root_id` index. [`scripts/measure-thread-index.mts`](../scripts/measure-thread-index.mts) seeds one channel with an old 50-reply thread, then top-level messages, then a busy 500-reply thread. It checks every response before timing, runs without `ANALYZE` as the server does, and compares the old index, the composite, and both, through real HTTP requests. Linux container, Xeon 2.8 GHz, 4 threads, Node 24.21.0; p50 / p95 ms over 30 warm requests:

| 200,000 messages                  | `thread_root_id` (before) | `(thread_root_id, id)` (v28) | Both         |
| --------------------------------- | ------------------------- | ---------------------------- | ------------ |
| Old thread, newest page           | 92.01 / 111.60            | 3.02 / 5.24                  | 2.12 / 2.67  |
| Busy thread, newest page          | 33.67 / 48.82             | 2.26 / 4.27                  | 2.46 / 3.42  |
| Old thread, older page (cursor)   | 3.19 / 4.32               | 3.47 / 5.46                  | 2.26 / 4.28  |
| Old thread, around a reply        | 3.90 / 6.80               | 2.78 / 3.99                  | 2.96 / 10.40 |
| Channel, newest page              | 3.95 / 7.51               | 2.35 / 3.47                  | 2.13 / 2.60  |
| Index build                       | 70 ms                     | 111 ms                       | 174 ms       |
| Database after `VACUUM`           | 38.6 MB                   | 40.7 MB                      | 42.4 MB      |
| 10,000 inserts in one transaction | 236 ms                    | 256 ms                       | 282 ms       |

At 50,000 messages the old thread's newest page went from 25.73 / 38.64 to 2.30 / 3.20 and the busy thread's from 10.80 / 13.88 to 2.46 / 4.63; the database grew from 9.8 to 10.3 MB. The old plan read the old thread through `idx_messages_channel (channel_id=?)`; v28's reads it through `idx_messages_thread_page (thread_root_id=?)` with no sort. A page with a cursor was already fast, because the cursor bounded the channel scan; the pages without one, and the `hasMoreNewer` check after them, were not. Keeping both indexes gained no reads and cost the most writes and space, so v28 replaces the old one. `packages/server/test/queryPlans.test.ts` checks the plans (thread page, has-more check, reply counts, reply existence) and a real v27 → v28 upgrade.

- [x] Add a new compatible migration for the useful composite index, after verifying target query shapes.
  - [x] Capture before/after `EXPLAIN QUERY PLAN` and check oldest/newest/around/root/deleted reply queries.
  - [ ] Compare 50k/200k sparse and dense histories with permission filters and actual HTTP response hydration. Done through HTTP with one member in a public channel; private-channel permission filters and many-member workspaces not varied.
  - [x] Measure insertion/migration time, database/WAL size and redundancy of older indexes before removing any.
  - [x] Keep cursor/result semantics identical and verify actual result count before timing.

**Done:** the relevant query improves through the full path with an acceptable write/storage cost. These synthetic warm timings are not a promised hundredfold app-wide speedup.

### OPT-11 · Medium · Optimize search from query plans and successful workload

**Gatherline:** FTS/query builders, reader-calendar filters, member/access filtering, `SearchDialog`. Preserve corrected date semantics and formatter LRU.

- [ ] Profile selective/common/empty-term modifiers, date ranges, large channels, file filters and denied channels.
  - [ ] Inspect query plans and statement time before adding composite/partial indexes or changing FTS projections.
  - [ ] Keep access filtering inside the query; avoid hydrating many rows only to discard them later.
  - [ ] Add search admission/in-flight budget if expensive successful searches saturate the host; surface useful retry.
  - [ ] Implement filename/relevance options from UX-02 with stable deterministic cursor/tie-break semantics.

**Done:** target search-to-result and main-loop cost improve for the declared query mix without ACL/date regressions or excessive index growth.

### OPT-12 · Medium · Reduce hydration and unread/thread aggregation work

**Gatherline:** `Store.hydrateMessages`, thread summaries, unread/mention/Activity counts and server snapshot.

**Status:** mention counts merged in #165 (`7d70dac`). Counting one account's unread mentions read every message in each of its channels, and a message naming the whole room, or a deletion, recounts every member of the channel, one scan each. Schema v31 adds `message_mentions` (message, channel, who it names; `'!'` for the whole room), filled by the migration from every message's text and kept by `Store` on send, edit and delete, with retention's purge cascading through the foreign key. Unread mention counts and the Activity mentions list start from it and apply FIX-08's read rule to each candidate, so they cost what this account's mentions cost. Nothing is cached: every count is still computed from the rows, under the same rule as `MENTIONS_ME`.

Measured with [`scripts/measure-unread-counts.mts`](../scripts/measure-unread-counts.mts) on `e02d2ac` against the candidate: one channel of 200,000 messages (seven in ten top-level, the rest replies in threads of ten; one in a hundred names a member, one in a thousand is `<!here>`), 50 members read to the last 300 messages, replies read to 60%, 20 followed threads each. Linux container, Xeon 2.8 GHz, 4 threads, Node 24.21.0; answers checked against the text rule before timing. Candidate figures are from two runs.

| Path                                                           | Before, p50 | After, p50     |
| -------------------------------------------------------------- | ----------- | -------------- |
| One member's unread mention counts (30 samples)                | 68 ms       | 1.2 ms         |
| Activity, mentions, first page                                 | 20 ms       | 2.0–2.1 ms     |
| Activity, unread, first page                                   | 0.7 ms      | 0.8 ms         |
| `<!here>` post over HTTP, 51 members recounted (10)            | 3,659 ms    | 76–86 ms       |
| Deletion over HTTP, 51 members recounted (10)                  | 3,724 ms    | 79–85 ms       |
| 10,000 messages through `Store.createMessage`, rolled back (5) | 1,776 ms    | 1,891–1,917 ms |
| Database after VACUUM                                          | 38.4 MiB    | 38.6 MiB       |

Sending costs about 7% more, for the scan of each message's text and a row for each one that names someone; a new message has nothing to delete, and most name nobody. The upgrade to v31 took 63–77 ms over 200,000 messages. `test/mentionIndex.test.ts` holds the table to the text rule: 400 random sends, replies, edits, deletions, reads and purges, checking every count after each step and that nothing is left for a deleted or purged message (taking out either the edit or the delete upkeep fails it), the Activity list and its paging, the query plan, and the upgrade's reading of awkward text (`<@<@U1>`, code spans, repeats, `<@U1x>`, unfinished marks, `<!here>` in a DM, deleted messages).

- [ ] Count actual SQL statements and repeated entity lookups per response/snapshot rather than assuming an N+1 problem.
  - [ ] Batch users/files/reactions/pins/follows where profiles show repeated work; reuse within a request only with valid access/revision scope.
  - [ ] Use bounded indexed aggregation for thread/unread counts and avoid repeating equivalent calculations per socket. Mention counts and the Activity mentions list are done; thread counts and the Activity unread walk are not.
  - [x] Coordinate count semantics with FIX-08 before caching them. Nothing is cached; the counts apply FIX-08's rule.
  - [ ] Measure channel/thread page and snapshot hydration at varied files/reactions/follows, including membership changes.
  - [ ] Measure page normalization separately from unread marker/count and boundary-query costs, following [Rocket.Chat RC-4](research/2026-09-30/rocket-chat-comparison.md#rc-4-separate-page-normalization-from-unreadcount-work). Preserve the current four page-scoped relation queries, #160's thread index and #165's mention index; a generic N+1 repair is not established.

**Done:** fewer queries/allocations improve the measured path with authoritative consistent counts. A stale global unread cache is not an acceptable shortcut.

### OPT-13 · Medium · Bound snapshots and large administration lists

**References:** Zulip anchor-aware fetches, Mattermost deterministic bounded queries. **Gatherline:** initial/resync snapshot, People, Apps, members and thread summaries.

- [ ] Measure snapshot bytes, SQL time, serialization and renderer processing versus member/channel/message cardinality.
  - [ ] Page/search member/app lists with stable cursors; avoid repeatedly loading every account to display one page.
  - [ ] Design a versioned lean bootstrap plus on-demand details only if snapshot cost warrants it.
  - [ ] Preserve coherent sequence watermark and authenticated channel visibility through paging/replay.
  - [ ] Exercise a permission change during fetch and recovery after an incomplete bootstrap.

**Done:** large supported workspaces connect and administer within the chosen budgets without partial-state ambiguity or content leakage.

### OPT-14 · Medium · Extend socket admission and observe backpressure

**Reference:** Mattermost bounded queues/deadlines and load counters. **Gatherline:** Fastify reception, `Gateway`, existing 2 MiB cutoff and bounded database replay.

- [ ] Define aggregate socket/account/IP/unauthenticated connection ceilings and request-reception deadlines.
  - [ ] Measure fanout serialization and repeated authorization work; retain one serialized durable payload where already present.
  - [ ] Coalesce/drop only explicitly replaceable ephemeral messages under pressure; close/resync durable slow readers safely.
  - [ ] Record queued bytes, disconnect reason and reconnect/snapshot cost with bounded labels.
  - [ ] Exercise slow uploads, idle unauthenticated sockets, slow readers and a reconnect burst.

**Done:** total retained work is bounded and overload degrades predictably. Do not replace durable database replay with a volatile ring merely to imitate another server.

### OPT-15 · Medium · Give scheduled, retention and delivery work fair bounded turns

**References:** Zulip row-aware retention, Mattermost bounded bulk operations. **Gatherline:** due schedules, retention, file-deletion ledger and event delivery queues.

- [ ] Measure work by actual dependent rows/bytes/time in addition to item count.
  - [ ] Preserve #151's table-based purge and caught/yielding passes; measure large whole-thread work before selecting smaller safe transaction boundaries.
  - [ ] Bound aggregate installed-app/failed-queue cost and capability counts, preserving per-subscription order/admission.
  - [ ] Keep retry/backoff/state wakeups explicit; do not busy-poll held or exhausted work.
  - [ ] Exercise mixed live chat with due/held jobs, oversized threads, failed integrations and deletion recovery.
  - [ ] Compare grouped visual invalidation and dependent-row/byte/time budgets using [Rocket.Chat RC-5](research/2026-09-30/rocket-chat-comparison.md#rc-5-bound-maintenance-effects-and-make-queue-ownership-explicit). Preserve ordered durable events and #153's writer ownership; introduce claims only for deliberately added concurrent workers.

**Done:** queues drain without starvation or loop stalls beyond the chosen envelope, with observable backlog/failure and safe restart semantics.

### OPT-16 · Medium · Optimize file transfer and derived-media processing

**Gatherline:** streaming uploads/downloads, `StorageBudget`, file cache and server dimension/hash handling.

- [ ] Profile server disk/hash work, chunk size/backpressure, renderer copies and the native large-download handoff.
  - [ ] Share derivative-media generation, access and cleanup ownership with OPT-09; do not create competing thumbnail formats or workers in separate PRs.
  - [ ] Offload CPU-heavy thumbnail/hash/extraction work only where measurement identifies blocking; bound worker/input/output cost.
  - [ ] Keep streaming reservations, revocation/abort cleanup and FIX-11 single-writer coordination.
  - [ ] Evaluate Range/resumable download only with authenticated ticket/lifetime and integrity semantics; do not buffer entire large files to simplify resume.
  - [ ] Measure large/small concurrent transfers, cancellation, disk pressure and retained memory.

**Done:** transfers improve measured time/loop/memory behavior while storage/access integrity remains enforced.

## 6. Idle work, IPC, recovery and diagnostics

### OPT-17 · Small/medium · Reduce idle/offscreen CPU and wakeups

**Reference:** T3 [shared visible-animation observer](https://github.com/pingdotgg/t3code/blob/ff1db030b179ef712cacc0098366d976e2877f45/apps/web/src/lib/visibleAnimation.ts), adaptive telemetry. **Gatherline:** typing/read retries, animations, presence and huddle stats.

- [ ] Inventory interval/observer/listener work with no conversation activity, with a hidden window and closed-to-tray hosting.
  - [ ] Pause visual animations and unnecessary renderer sampling offscreen/hidden, honoring reduced motion.
  - [ ] Coalesce UI-only status/typing refreshes and remove listeners on disposal; retain needed protocol heartbeats, read durability and host availability.
  - [ ] Use demand-aware diagnostic sampling and preserve immediate recovery/access events.
  - [ ] Compare idle CPU, wakeups, battery and wake-to-fresh state under joining and hosting separately.

**Done:** idle cost falls without losing notifications, live hosting, queued delivery or readable resumption. Do not indiscriminately stop every timer when hidden.

### OPT-18 · Medium · Reduce IPC/status churn through narrow contracts

**Reference:** T3 typed IPC/built-preload verification and bounded replaceable status snapshots. **Gatherline:** preload/platform storage and hosting status notifications.

- [ ] Measure IPC call/event frequency, payload bytes and settings/status serialization under connect/disconnect/presence/backup progress.
  - [ ] Send narrow changed fields or coalesced replaceable status snapshots if full updates dominate work.
  - [ ] Add atomic storage operations for FIX-01 and sender/payload validation for SEC-03 in the same boundary design.
  - [ ] Keep commands, durable events and completion/error acknowledgements lossless; do not put them in a sliding/drop queue.
  - [ ] Verify bundled bridge imports, callback teardown and renderer/backend generation fencing.

**Done:** IPC overhead decreases while its authorization and ownership contract becomes clearer.

### OPT-19 · Medium · Improve first usable paint and bounded renderer recovery

**Reference:** T3 hidden-boot unthrottling only until reveal and bounded `render-process-gone` recovery. **Gatherline:** BrowserWindow creation, persisted appearance and durable client rehydration.

- [ ] Eliminate avoidable wrong-theme flash through a minimal trusted appearance bootstrap or a measured reveal policy.
  - [ ] If hiding until ready helps, enforce a load-error/deadline fallback and restore background throttling after startup.
  - [ ] Add bounded renderer crash/OOM/load recovery without resetting the hosted server or route.
  - [ ] Rehydrate durable draft/outbox/route state and reconcile nonces under #162's accepted-send contract. Disposable-cache cleanup must never clear accepted sends.
  - [ ] Define usable milestones separately from page load, generation-fenced deadlines and persisted bounded attempts with a manual fallback; see [Rocket.Chat RC-8](research/2026-09-30/rocket-chat-comparison.md#rc-8-distinguish-loaded-from-usable-and-bound-renderer-recovery).
  - [ ] Measure paint/usable time and hidden CPU; exercise crash during send, host management and restore progress.

**Done:** first use improves and a renderer failure has a safe visible recovery path. Permanently disabling throttling is not part of this proposal.

### OPT-20 · Small/medium · Keep performance diagnostics cheap and private

**References:** T3 demand/power-aware bounded samples, Signal named SQL timings, Mattermost named journey metrics. **Gatherline:** existing user-previewed diagnostics and health route.

- [ ] Add bounded named timings for startup, channel switch, thread load, search, reconnect and backup.
  - [ ] Separate queue, SQLite, serialization, transport/IPC and rendering stages in local experiments.
  - [ ] Cap recent samples/log bytes; redact messages/credentials/token URLs and bound label cardinality.
  - [ ] Measure panel-open/closed idle overhead and stop expensive collection when not requested.
  - [ ] Extend OPS-10 support export without automatic external telemetry.
  - [ ] Add fixed-route duration/response-byte/in-flight counters with exactly-once sampling and cleanup through exceptions/aborts; keep labels private and bounded. [Rocket.Chat RC-6](research/2026-09-30/rocket-chat-comparison.md#rc-6-measure-named-routes-with-bounded-labels) is a mechanism reference, including upstream cardinality cautions.

**Done:** operators and optimization PRs get useful evidence without creating another CPU/privacy/storage problem.

### OPT-21 · Medium/large spike · Measure startup maintenance, WAL and database topology

**Reference:** SQLite WAL/backup contracts; Signal one write owner plus measured reads. **Gatherline:** startup inventory/orphans, pre-upgrade backup, migrations and checkpoints.

- [ ] Time startup stages on large message/blob sets and separate mandatory integrity work from deferrable safe cleanup.
  - [ ] Preserve #152's current rollback-copy protection and #153's directory ownership before changing startup order.
  - [ ] Measure checkpoint stalls, WAL growth, write latency, busy waits and filesystem behavior; retain durability guarantees.
  - [ ] Compare a single isolated writer with a bounded read-worker pool only when profiling justifies the latter.
  - [ ] Define read-after-write/snapshot/connection ownership and stop secondary work before closing the primary.

**Done:** faster startup or concurrent reads are measured without unsafe cleanup, lock contention, weaker power-loss behavior or excess process memory.

## 7. Media and mobile/background efficiency

### OPT-22 · Medium empirical gate · Publish a measured small-call envelope

**Gatherline:** existing microphone/camera/screen transceivers and mesh peers. No competitor's participant count is evidence of Gatherline capacity.

- [ ] Measure 2/4/6/8 participants where feasible: audio, camera, screen and relay-only paths.
  - [ ] Record sender uplink, decode CPU, frames/loss/RTT, memory and device thermal/battery behavior on stated hardware.
  - [ ] Add useful low-bandwidth/audio-only controls and sender resolution/bitrate choices where supported.
  - [ ] Avoid per-peer heavyweight audio graphs; preserve the existing stats-based speaking indicators.
  - [ ] Combine CALL-01/02 device/recovery validation with load evidence; choose an SFU only when required size exceeds the measured mesh envelope.

**Done:** supported call size and network/device assumptions are published with samples, and poor conditions have an understandable fallback.

### OPT-23 · Medium · Make screen/video work proportional to what is useful

- [ ] Profile screen/camera encoding, thumbnail tiles and fullscreen/shared-stage layouts.
  - [ ] Pause unnecessary visual rendering offscreen while preserving required media and remote state.
  - [ ] Investigate supported sender frame-rate/resolution and receiver adaptation; do not assume CSS-hiding a video stops decoding or uplink.
  - [ ] Add correct screen/window choice, permission error and track-ended cleanup from CALL-01/03.
  - [ ] If preview/window enumeration is expensive, compare one in-flight enumeration and short-lived bounded thumbnails, with refresh/cancel and source revalidation; see [Rocket.Chat RC-9](research/2026-09-30/rocket-chat-comparison.md#rc-9-cache-capture-enumeration-only-if-an-expanded-picker-needs-it). Basic screen selection already exists.
  - [ ] Measure readable screen text, frame cadence, camera quality, CPU and bandwidth across layout changes.

**Done:** reduced media cost preserves useful quality and all participants' explicit sending state. Any network subscription changes need protocol/media evidence.

### OPT-24 · Large, cohort-gated · Bound mobile/background connections and persistent caches

**Targets:** UX-08/09/10; multiple accounts, push subscriptions, idle sockets and optional cold history cache. Further primary patterns are in the additional chat report.

- [ ] Compare lightweight notification/count connections, selected polling and push for inactive workspaces under browser/OS limits.
  - [ ] Budget total account/workspace cache bytes and connection/radio work; use transactional persistence with explicit stale/revoked state.
  - [ ] Cancel stale navigation/history/preview requests and deduplicate retries/notifications across windows.
  - [ ] Version/wipe scoped caches on logout or incompatible upgrade and revalidate access on reconnect.
  - [ ] Measure real background/locked phone delivery, battery/return latency and 1/3/10 saved-workspace scenarios.

**Done:** useful background participation fits a declared resource envelope with clear provider/host dependencies. An intermittently sleeping server is not made always available by caching or push alone.

## 8. What to adopt first and what to reject without evidence

1. Preserve merged #160/#164/#165 query/subscription/mention improvements and their recorded evidence. Complete OPT-01's current mixed-workload/browser traces instead of implementing those changes again.
2. Select remaining OPT-11/12/13/15 work from measured query, hydration, snapshot or maintenance cost; retain read, outbox, ownership and access contracts.
3. Trial OPT-02/03 only if traces show module/package startup cost; add OPT-20's bounded timings as needed.
4. Select OPT-04, OPT-06/07/09/11 from actual main-loop/render/memory/query bottlenecks. Maintain FIX/OPS integrity gates alongside changes.
5. Gate OPT-22–24 on real devices and participation mode. Keep rejected experiments recorded.

Do not adopt another app's entire framework, database/service topology, cache size, timer cadence, rendering library or worker count as an optimization by itself. Avoid disabling sandboxing, signature checks, access validation, SQLite durability or background throttling globally. These choices change guarantees and require evidence well beyond a faster synthetic benchmark.

## 9. Per-PR completion record

For each completed experiment add: owner, baseline/candidate SHA, source pattern, actual code change, fixture/platform/runtime, before/after samples, correctness checks, cost/regression, and keep/reject decision. Link its PR/merge and update the main plan. An upstream implementation reference is useful provenance; measured Gatherline behavior decides whether the adaptation ships.
