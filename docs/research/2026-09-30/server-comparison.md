# Server, data and operations: current findings and comparable implementations

**Research date: 30 September 2026. Inspected Tandem baseline: `7d91fd3`, merged through #149.** This is source inspection and controlled local experimentation for the execution plan. No product files were changed. Experiments used in-memory databases or new temporary directories; no existing hosted workspace was opened. The observed runtime was Windows, Node **24.16.0**, and installed Fastify **5.12.1**. Full-suite results belong to the main audit; this report does not claim to have rerun those suites.

Recommendations below are engineering judgments. A confirmed reproduction, a source-verified missing mechanism, and a candidate optimization are distinguished. Competitor implementations show possible designs and tradeoffs; they do not establish Tandem performance or demand for a feature.

## 1. Preserve the work already completed

| Existing behavior                                                                                                                             | Current source evidence                                                                      | Remaining boundary                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A newly accepted schedule spends the account's post budget once; a matching nonce replay returns before charging it                           | `server.ts:3394–3461`; `limits.test.ts:333–388`, #144                                        | This closes the reproduced scheduling admission bypass. Delivery should continue to avoid charging an already accepted send again.                    |
| Search formatter caching canonicalizes the zone and keeps at most 32 entries                                                                  | `protocol/src/search.ts:64–96`; three cache cases in `protocol/test/search.test.ts`, #145    | The former unbounded retained formatter cache is closed. Expensive search admission is a separate capacity concern.                                   |
| Scheduled files have transactional exclusive reservations; broadcast intent survives scheduling and delivery                                  | `db.ts:404–419`; `server.ts:3369–3463`; `store.ts:1806–1844,1956–1974`                       | Do not reopen the old ordinary-send/file collision. Historical upgrade fixtures still need broader coverage.                                          |
| Outstanding schedules are capped; due rows drain in small batches; held rows back off and wake on access restoration                          | `server.ts:102–110,3780–3852`; `store.ts:1905–1951`                                          | The queue does not imply all maintenance, replay or thread deletion work is similarly bounded.                                                        |
| Slash commands, buttons and submissions have account/app in-flight limits and account rate admission                                          | `server.ts:430–467,2644,3051,3220`; `limits.ts:71–78`                                        | Four outstanding calls per account and sixteen per app do not cap all retained capability maps or the number of installed subscriptions.              |
| Outbound integrations have connection-time private-address checks, a response byte cap, an overall deadline and shutdown cancellation         | `outbound.ts:104–254`; `server.ts:620–631`                                                   | Preserve these checks. A dependency advisory involving another URL parser is not proof that this outbound path is exploitable.                        |
| Per-subscription event delivery is durable, ordered and bounded at 500 pending rows                                                           | `store.ts:2431–2590`; `server.ts:641–716`                                                    | Aggregate subscription/failed-row size and old message copies in queued bodies remain separate questions.                                             |
| Slow WebSocket readers are disconnected above a 2 MiB queued-byte threshold; replay is bounded and falls back to a snapshot                   | `gateway.ts:221–230,438–446`; `store.ts:2849–2874`                                           | Keep these controls. Connection cardinality, aggregate buffered bytes, and reconnect snapshot cost remain unmeasured.                                 |
| Uploads stream with per-chunk space reservations; denied/revoked uploads are cleaned up; orphan blobs are reconciled at startup               | `server.ts:809–891,1750–1812`; `storageBudget.ts`                                            | This is a single-server attachment budget, not a physical-volume quota or coordination between two servers using one directory.                       |
| Backups include database/blobs and verify checksums, integrity, foreign keys and row counts; migrations take a database-only pre-upgrade copy | `backup.ts:146–273`; `db.ts:469–560`                                                         | An application backup and a pre-upgrade database copy are different recovery sets. Clock changes expose a remaining defect in the latter's retention. |
| Package source and package tests are typechecked                                                                                              | Package `tsconfig.json` includes `src` and `test`; UI also includes its Vitest configuration | The older blanket claim that no tests are typechecked is incorrect. Root `tests/`, root scripts and browser configurations need their own coverage.   |

Local source links: [server](../../../packages/server/src/server.ts), [store](../../../packages/server/src/store.ts), [database/migrations](../../../packages/server/src/db.ts), [gateway](../../../packages/server/src/gateway.ts), [backup](../../../packages/server/src/backup.ts), [search](../../../packages/protocol/src/search.ts).

## 2. Confirmed defects to schedule before expanding deployment claims

### SR-1 — P1: a large expired thread defeats retention

**Confirmed.** `store.ts:867–916` limits the selection to 2,000 roots, then collects every reply and constructs a single placeholder for every message. One thread can exceed SQLite's parameter ceiling. The hourly maintenance callback at `server.ts:3854–3863` does not catch a thrown retention error.

Controlled reproduction:

1. Open the current schema in memory; add one user and one public channel.
2. Insert one old root and **33,000** old replies to that root in one transaction.
3. Run `store.transaction(() => store.purgeMessagesBefore(2))`, with fixture creation times set to `1`.
4. The installed SQLite reports `MAX_VARIABLE_NUMBER=32766`; the operation throws **`too many SQL variables`**. All **33,001** rows remain after rollback.

This proves the failed purge. The uncaught hourly-callback path is source evidence; a production process crash was not executed as part of this probe. SQLite documents the relevant parameter limit in [Implementation Limits](https://www.sqlite.org/limits.html).

- [ ] Replace the unbounded expanded parameter list with SQL set membership, a temporary ID table, or safe bounded batches.
  - [ ] Preserve the contract that a root and its replies disappear consistently; define how an exceptionally large thread can yield without exposing broken intermediate state.
  - [ ] Bound work by actual message/dependent-row volume or measured elapsed time, rather than root count alone.
  - [ ] Give maintenance callbacks a visible error/retry path so one unsuccessful sweep does not become an uncaught timer exception.
  - [ ] Exercise more than 32,766 selected messages, many small roots, a huge thread, a newer reply that prevents expiry, attachments, follows, pins, saves, request rows and restart/repeated passes.
  - [ ] Measure loop delay and database growth while new posts and reads continue; record the chosen work budget and why it fits the supported host.

**Done:** the reproduced fixture purges correctly, related objects and files follow the documented contract, a failed pass rolls back safely and reports an actionable error, and subsequent passes resume without permanent starvation. Raising SQLite's parameter limit alone does not meet this criterion.

### SR-2 — P1: deleted or superseded text survives in integration delivery bodies

**Confirmed.** `store.editMessage()` and `deleteMessage()` call `redactMessageEvents()` (`store.ts:830–851,2810–2840`). That reaches `events.payload`. Meanwhile `server.ts:568–608` writes a separate copy into `event_deliveries.body` through `store.ts:2443–2469`. This queued body is not scrubbed by edit/delete/retention, and failed deliveries can retain it until their later pruning.

Controlled reproduction used a real loopback HTTP server in isolated mode, which suppresses external calls while preserving queue creation. A fixture bot was added to the channel and given a valid subscription row through the store. HTTP post → delete, and HTTP post → edit, each produced:

| Inspection after mutation                      | Deleted original | Earlier edited text |
| ---------------------------------------------- | ---------------- | ------------------- |
| Old text still in workspace event-log payloads | `false`          | `false`             |
| Old text still in a pending integration body   | **`true`**       | **`true`**          |

Delivery is ordered, so the edited-text inspection advanced the first fixture's two queue rows before inspecting the second fixture's creation body. No real external app received fixture content. This does not mean already delivered third-party copies can be erased; it identifies a persistent copy still controlled by Tandem.

- [ ] Define the pending-delivery deletion/edit contract alongside the existing event-log privacy contract.
  - [ ] Associate queued message events with an indexed message ID, including safe backfill for current queued/failed bodies.
  - [ ] Scrub superseded text or discard invalidated content while preserving delivery ordering, event identity and receiver expectations; document the chosen behavior.
  - [ ] Cover deletion, root deletion, edits and retention in the same mutation boundary as local privacy changes.
  - [ ] Handle retries/restarts and terminally failed queues; do not silently restore an older body during retry.
  - [ ] Make the limitation for an outbound body already handed to the network explicit; avoid promises about erasing another app's data.

**Done:** the old text is absent from all pending and failed bodies under Tandem's control after the relevant operation, and a repaired subscriber never receives that old text from those rows. Existing event-log redaction remains intact.

### SR-3 — P1: retention can remove the new pre-upgrade recovery copy

**Confirmed.** `db.ts:501–509` sorts pre-upgrade copies by the timestamp embedded in their names, then removes all but three. It does not protect the copy it just verified. If the clock moves backwards, three existing later-named copies can cause the newly created copy to be removed before migrations start.

Controlled reproduction:

1. Create a valid schema-v26 workspace in a new temporary directory.
2. Put **three valid schema-v26 databases** in `pre-upgrade/`, using the existing naming format with January 2040 timestamps.
3. Open the workspace with current `openDb()` and record `onUpgradeBackup`'s path.
4. The upgrade to v27 succeeds. **`existsSync(reportedPath) === false`**; the three future-named older copies remain.

The second probe used actual databases, not empty placeholder files. This is the database-only pre-upgrade retention implementation; the desktop application's separate backup-retention fix in #126 should remain marked closed.

- [ ] Exclude the newly verified copy from candidates for removal regardless of clock order.
  - [ ] Make the retain/remove policy explicit when timestamps are duplicated, in the future, malformed, or affected by a clock rollback.
  - [ ] Refuse to proceed if the just-created recovery copy is no longer available; avoid reporting a nonexistent path.
  - [ ] Add checks for backward clocks, duplicate timestamps and removal errors alongside the existing upgrade-copy tests.
  - [ ] Verify that files a person placed in the directory outside the managed naming format remain untouched.

**Done:** the upgrade's reported recovery path exists and opens at the pre-upgrade schema after every successful upgrade in these cases; pruning preserves it and keeps the intended older recovery points.

### SR-4 — P1: the same data directory can run under two independent servers

**Confirmed.** `createWorkspaceServer()` opens the database at `server.ts:316–318`; no exclusive workspace ownership is acquired. `StorageBudget` inventories existing blobs once (`storageBudget.ts:23–32`). Different server instances then maintain independent counters for the same files.

Controlled reproduction started two `createWorkspaceServer()` instances on different loopback ports with the same new data directory and a **4-byte** storage cap. After an owner registered, a legitimate 4-byte attachment uploaded to each instance:

```text
bothServersStarted: true
firstUpload: 201
secondUpload: 201
configuredCap: 4
actualBlobBytes: 8
```

Both servers ran within the probe process, so this establishes that independent server instances can own the same directory and violate the cap. The source also lacks a separate-process lock. Duplicate scheduled delivery was not reproduced and is not claimed here. Split socket fanout, competing cleanup and duplicated outbound work are further risks to characterize.

- [ ] Acquire exclusive ownership of the canonical workspace directory before opening/migrating it, reconciling files, announcing it or accepting traffic.
  - [ ] Detect aliases/junctions that resolve to the same directory.
  - [ ] Give a second launch a useful refusal identifying the current owner without exposing secrets.
  - [ ] Define crash recovery for stale ownership records, including PID reuse and races between two simultaneous starts.
  - [ ] Coordinate CLI, desktop, restore and account recovery with the ownership mechanism; a filesystem operation should not replace files underneath an active owner.
  - [ ] Verify simultaneous process starts, graceful exit, abrupt death, aliases, same-directory uploads and queue operations.

**Done:** a second writer is refused before it can alter the workspace, the cap reproduction cannot occur, and a new legitimate owner can start after the previous process exits or crashes. SQLite WAL support for multiple database connections is not sufficient application coordination.

## 3. Measured optimization: sparse old-thread history

**Candidate with controlled evidence.** The thread history query at `store.ts:930–954` filters on `channel_id` and `thread_root_id`, then orders by ID. Existing indexes are `(channel_id, id)` and `(thread_root_id)` (`db.ts:63–64`). On this runtime, `EXPLAIN QUERY PLAN` selected the channel index, scanning past unrelated newer messages in a channel to find an old sparse thread.

The in-memory fixture had **50,051 messages in one channel**: one root, its 50 old replies, then 50,000 unrelated newer top-level messages. IDs were ascending, zero-padded strings. Thirty repeated reads requested the newest 50 replies; each result was checked to contain 50 rows. A scratch-only index on `(thread_root_id, id)` changed the plan:

| Warm SQL reads | Existing indexes                                                  | Scratch composite index                                            |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Plan           | `SEARCH messages USING INDEX idx_messages_channel (channel_id=?)` | `SEARCH messages USING INDEX audit_thread_page (thread_root_id=?)` |
| p50            | **6.334 ms**                                                      | **0.066 ms**                                                       |
| p95            | **7.777 ms**                                                      | **0.102 ms**                                                       |

These are SQL timings on a favorable synthetic fixture, without HTTP, hydration, permission checks, disk I/O or cold caches. They do not establish a general 96× endpoint improvement. No product index was added.

- [ ] Compare `(thread_root_id, id)` and a narrower partial index against representative thread queries and deletion/retention patterns.
  - [ ] Record `EXPLAIN QUERY PLAN` before/after on sparse old threads, active long threads, pagination and channel history at 50,000 and 200,000 messages.
  - [ ] Check every returned ID and permission boundary; preserve cursor order and broadcast behavior.
  - [ ] Measure HTTP latency, event-loop delay, inserts/edits/deletes, database/WAL size and migration time on disk as well as warm SQL.
  - [ ] Add a migration only once the read benefit and write/storage cost are understood.

**Done:** the accepted index has repeatable improvement on the target old-thread workload, no meaningful regression on the supported mixed workload, and a migration that preserves data. Keep the existing keyset pagination; this experiment does not justify replacing SQLite or adding an external search service.

## 4. Pinned comparable repositories: useful patterns and traps

The following source was read through GitHub's API without installing or executing it. SHA pins describe exactly what was inspected; a changing default branch is not a stable research citation. Borrowing a design idea does not authorize copying code under another project's license.

| Repository at inspected SHA                                                                                                                                                                                    | Source observation                                                                                                                                                       | Fit for Tandem                                                                                                                                       | Risk / proof before adoption                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zulip** `7a921db6dad7c71ef4c93ec7b24e229f028710a5` — [retention.py](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/zerver/lib/retention.py#L71)                                | Uses bounded message batches, transaction boundaries for associated objects, and progress reporting.                                                                     | Apply message-volume-aware maintenance and progress/error evidence to SR-1, including resumable repeated passes.                                     | Zulip's archive-before-delete design intentionally retains a recovery copy. Copying that policy would change Tandem's erasure promise; use the batching idea while deciding retention semantics explicitly.                              |
| **Zulip** same SHA — [message_fetch.py](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/zerver/views/message_fetch.py#L109)                                                       | Accepts bounded ranges around an anchor, validates combinations, and returns explicit anchor/history-boundary information.                                               | Preserve existing Tandem history caps and compare a clearer around-message contract for thread/search navigation and deleted anchors.                | Tandem already supports cursor and around-message loading. A larger competitor fetch ceiling is not a reason to raise ours; benchmark bytes, hydration and client cache use.                                                             |
| **Zulip** same SHA — [event_queue.py](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/zerver/tornado/event_queue.py#L392)                                                         | Compresses some read-flag events together. The inspected source itself records an ordering problem involving read/unread reversals.                                      | Consider coalescing redundant ephemeral updates such as typing or presence when under load.                                                          | Do not blindly coalesce durable read/unread transitions. Preserve revision/order semantics and test opposite actions while disconnected. The inspected code is a caution as well as an example.                                          |
| **Mattermost** `cc0611f2ee9c8d8c012bb3631133d6d51e069068` — [web_conn.go](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/server/channels/app/platform/web_conn.go#L34) | Uses a bounded active send queue, a finite replay ring, read/write deadlines and an early threshold for dropping noncritical events.                                     | Extend Tandem's existing queued-byte cutoff with admission ceilings, slow-reader counters and preferential dropping of replaceable ephemeral events. | Tandem already serializes durable fanout once and uses durable database replay. Replacing that with a new in-memory ring can weaken restart recovery; require load evidence before adding a second queue.                                |
| **Mattermost** same SHA — [web_hub.go](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/server/channels/app/platform/web_hub.go#L453)                                    | Measures broadcast-buffer occupancy and coordinates session-state invalidation.                                                                                          | Measure backlog/drop/resync behavior; profile repeated authorization work per socket and retain immediate revocation.                                | A cached permission result must expire and be invalidated on deactivation, logout and channel access changes. Avoid stale authorization in exchange for speed.                                                                           |
| **Mattermost** same SHA — [post_store.go](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/server/channels/store/sqlstore/post_store.go#L1548)                           | Some sync paths order by an update timestamp plus ID; bulk deletion/export/indexing use limited batches, and a thread query chunks IDs to remain below parameter limits. | Use deterministic composite cursors and bounded streaming for future native export/import, and query-plan-led index review for current histories.    | Tandem's durable event sequence already represents edits and deletes. Do not introduce a parallel timestamp sync protocol without demonstrating why existing replay is insufficient; timestamp ties and rollback need explicit handling. |
| **Mattermost** same SHA — [metrics.go](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/server/channels/app/metrics.go#L12)                                              | Records named user journeys such as channel switching and thread-view loading, as well as desktop CPU/memory observations.                                               | Define local, opt-in benchmark/diagnostic measurements for channel switch, search-to-thread and host loop responsiveness.                            | Metrics can add privacy and label-cardinality cost. Tandem need not send user-linked performance data to an external service to obtain useful local evidence.                                                                            |

These references support individual implementation observations. PostgreSQL, clustering, Redis, an SFU and a large telemetry service are not prerequisites for adapting the useful patterns to this single-host SQLite product.

## 5. Source-verified residual work, grouped for reviewable changes

### SE-1 — P1 for public/untrusted hosting: request reception and connection budgets

`server.ts:944–952` configures `forceCloseConnections` but no request/connection reception limits. A controlled instantiation of installed Fastify with these options reported `requestTimeout: 0`, `timeout: 0`, `headersTimeout: 60000`. This is verified configuration, not an executed large-scale denial-of-service attack. Fastify recommends a nonzero request timeout for direct deployments without a reverse proxy in its [Server reference](https://fastify.dev/docs/v5.8.x/Reference/Server/#requesttimeout); the runtime query above verifies the inspected installed version independently of that documentation page.

- [ ] Configure documented, overridable request-reception deadlines, with an appropriate upload policy.
  - [ ] Admit uploads by account, address and workspace in-flight count as well as per-minute rate and bytes; release every reservation after abort/refusal.
  - [ ] Put an aggregate ceiling on authenticated and unauthenticated WebSocket connections. The existing address opening rate and 10-second hello deadline remain useful but are not a concurrent-connection limit.
  - [ ] Include huddle join/leave in a suitable state-change budget: `gateway.ts:248–254` currently bypasses `affordEphemeral()`, while typing and signalling spend it.
  - [ ] Characterize slow partial JSON, stalled multipart streams, repeated join/leave, many sockets for one session, NAT cohorts and recovery after refusal.

**Done:** resource bounds hold under these inputs while normal slow-network uploads, reconnect bursts and a multi-person NAT cohort can complete. Reverse-proxy recommendations supplement the server's own controls.

### SE-2 — P1: bounded shutdown and failure reporting

`stop()` aborts app calls, closes sockets/listener and drains tracked async handlers before closing SQLite (`server.ts:3908–3927`). This correctly prevents handlers using an already closed database. The drain loop has no deadline. CLI signal handling at `main.ts:440–442` also lacks an explicit failure path. Known outbound calls already have deadlines; an arbitrary never-settling path is a source risk, not a reproduced hang in this review.

- [ ] Define cancellation ownership for upload streams, password work, background jobs and callbacks.
  - [ ] Add an operator-visible shutdown deadline and useful diagnostics naming unfinished operation classes.
  - [ ] Preserve database ownership until every operation that can touch it is stopped; simply racing a timeout and closing SQLite is unsafe.
  - [ ] Give CLI/service-manager exits and desktop stop/force-quit a consistent recovery story and exit status.
  - [ ] Exercise stalled input, slow app/DNS, locked file deletion, active hashing, repeat signals and shutdown during a maintenance batch.

**Done:** normal shutdown completes within the declared target; timeout/failure is explicit and recoverable, with no handler accessing a closed database or partially acknowledged mutation.

### SE-3 — P1/P2: capability lifetime, scopes and aggregate integration cost

`responseTargets`, `triggers` and `openViews` have TTLs and expiry checks (`server.ts:2411–2421,2932–2939,2951–2986`) but no hard cardinality caps. Sweeps scan their full maps when creating another entry. #131's account/app admission bounds the creation rate but does not establish a global retained-memory ceiling. App tokens identify an app (`store.ts:2175–2185`) without a stored scope model. Per-subscription delivery has its own 500-row cap, while the number of subscriptions is unrestricted.

- [ ] Bound retained capabilities per user, app and workspace; refuse before issuing a capability that cannot be retained.
  - [ ] Use a bounded periodic expiry mechanism and release entries promptly after app deletion, access revocation and view completion.
  - [ ] Cap/document aggregate subscription queues, retained failed bodies and installed subscription count; surface refusal to admins.
  - [ ] Add a versioned scope model before expanding the bot API, starting with existing send and view methods and an explicit migration policy for old tokens.
  - [ ] Test capacity, expiry, replay, revocation, restart and refusal without allocating a bot join/trigger/response URL first.

**Done:** total retained resources remain within documented ceilings and scope/refusal behavior preserves existing SDK interoperability and immediate capability revocation. Fine scopes can be delivered separately from the urgent count bounds.

### SE-4 — P1/P2: physical disk, upgrades and recovery sets

The attachment budget excludes SQLite, WAL, backups, pre-upgrade copies and superseded directories; the deployment guide already tells operators to leave headroom. `openDb()` sets a synchronous 5-second SQLite busy timeout (`db.ts:522`). Package tests cover upgrades and newer scheduling migrations, but `upgrade.test.ts:35` primarily starts two schema levels behind current; that is not a complete released-data matrix or disk-full drill.

- [ ] Provide disk/headroom reporting for database, WAL, uploads, backup destinations and superseded recovery directories.
  - [ ] Make low-space failures actionable; avoid authorizing capture/restore/migration from attachment-cap arithmetic alone.
  - [ ] Exercise older released schema/data fixtures, invalid scheduled/file relationships, upgrade interruption, write errors and restart.
  - [ ] Document and validate rollback as matching data, blobs, build and deployment settings; preserve valid full recovery copies.
  - [ ] Measure lock contention and 5-second busy waits on the desktop host before claiming all database work is below a UI stall budget.
  - [ ] Move additional blocking operations to an owned worker only when measurement warrants it and SR-4 ownership/cancellation is settled.

**Done:** an interrupted or space-constrained upgrade has a verifiable recovery route, ordinary failures do not produce a misleading success indicator, and supported data-storage locations are explicit. Tests need filesystem fault injection or controlled fixtures; exhausting the user's real volume is unnecessary.

### SE-5 — P2: observability and reproducible mixed-workload capacity

`/api/health` checks `SELECT 1` and returns an instance ID (`server.ts:1111–1115`). `/api/storage` reports the attachment accounting counter. There is no inspected queue-age, loop-delay, WAL/disk or maintenance-health endpoint. Container smoke covers 20 sockets, 300 posts and persistence; desktop stall scripts now cover larger histories and due work, but they do not establish a complete supported deployment envelope.

- [ ] Add an admin/local diagnostics view for loop delay, process RSS, connection/queued-byte counts, scheduled held/failed/oldest age, delivery backlog/drop age, file-deletion backlog and maintenance errors.
  - [ ] Keep unauthenticated liveness small; define authenticated readiness separately.
  - [ ] Use bounded labels and samples; exclude message bodies, credentials, private channel names and per-user identifiers from generic metrics.
  - [ ] Publish a mixed benchmark at 50k/200k histories with concurrent posts, timeline/thread/search reads, reconnect/replay, room-wide mentions, a slow reader, uploads, retention and backup.
  - [ ] Profile query plans and CPU before optimizing. `gateway.ts:206,210` reads the user list twice per handshake, and `authorized()` performs a session lookup per socket on fanout; these are concrete profiling targets.
  - [ ] Record p50/p95/p99, loop delay, RSS, database/WAL growth, queued bytes, refused work and correctness checks at declared participant/socket counts.

**Done:** supported-host recommendations are backed by repeatable mixed-load results with an explicit envelope, and an operator can distinguish a healthy listener from stuck maintenance or a backed-up app. Candidate optimizations must preserve revocation, ordered replay and accepted-work durability.

### SE-6 — P2: conflict-aware message editing

`editMessageBody` accepts only text (`protocol/src/rest.ts:222–224`); HTTP edits perform an unconditional update (`server.ts:1708–1721`, `store.ts:830–840`). The UI detects some live conflicts, but a stale client can still overwrite a newer edit accepted through another window.

- [ ] Introduce an expected revision or compare-and-set contract for ordinary edits, following the existing scheduled-text conflict approach.
  - [ ] Offer reload-current and deliberate overwrite through an explicit user action.
  - [ ] Handle retries, equal-text replays, same-millisecond edits and deleted messages.
  - [ ] Preserve old-event redaction and implement SR-2's pending-body policy.

**Done:** two windows editing one version cannot silently lose the newer accepted edit; conflict and deliberate overwrite are distinguishable in the API and UI.

### SE-7 — P2: portable export/import with bounded resources

Backups restore an operational workspace, including sessions/signing material and queued effects. No inspected native logical export/import route or CLI exists. A portable history export is a separate product and trust contract.

- [ ] Define a versioned manifest, channel/user/message/file mappings, attachment checksums and supported omissions.
  - [ ] Stream deterministic cursor batches rather than retaining an entire workspace in RAM; use stable composite cursors where the chosen order needs a tie-breaker.
  - [ ] Apply access scope consistently to private channels, DMs, files, reply roots, edited/deleted content and any export audit record.
  - [ ] Exclude operational credentials, sessions and active queues by default; require deliberate authorization for a full recovery archive.
  - [ ] Implement import preview, size/count budgets, missing-file/conflict reports and resumable idempotent application.
  - [ ] Add supported Slack formats only after the native round trip works; remote attachment links and inaccessible content need a truthful missing-content report.

**Done:** a large exported workspace can be inspected and imported within declared disk/RAM bounds, duplicate imports do not duplicate history, refusal leaves the destination usable, and restricted content is never broadened by mappings. This depends on SR-4 ownership and the defined deletion/restore contracts.

### SE-8 — P2/P3: policy, member/app paging and administration

Creating a channel currently requires membership, not a workspace-configured create-channel permission (`server.ts:1406–1444`). `/api/users` returns all users; `/api/apps` returns all apps and all their configuration/subscriptions (`server.ts:1367–1370,2056–2070`). Existing invite permission, channel manager rules, audit history and app-secret replacement should remain closed work.

- [ ] Add workspace policy controls for channel creation and selected app/moderation actions only after defining the intended community/organization cohort.
  - [ ] Page/search member and app administration without breaking the small-workspace realtime snapshot; measure when snapshot pagination is necessary.
  - [ ] Add a workspace icon and explicit default invite-expiry policy; the name is already configurable and must not be listed as absent.
  - [ ] Define audit export/retention intentionally; automatically trimming accountability history to save disk is a policy change.
  - [ ] Consider TOTP/recovery codes, account deletion and richer moderation as separately scoped features, with recovery/access migration requirements.

**Done:** selected policy controls have clear ownership and upgrade defaults, large lists remain usable within measured budgets, and revocation/deactivation continue reaching open sockets and app capabilities. Enterprise identity features should follow demonstrated cohort needs.

### SE-9 — P2: architecture, type coverage and release evidence

At this baseline `server.ts` has **3,930** lines, `store.ts` **3,023**, and the client `workspace.ts` **2,149**. Root scripts/browser tests lack a dedicated TypeScript task, while package tests are already included. There is no inspected ESLint configuration or OpenAPI description. CI is path-filtered for PRs; Windows packaging is configured, but no release-publication workflow was found.

- [ ] Extract cohesive server domains in small steps, preserving one transaction/event publication boundary and shared admission/auth/cancellation helpers.
  - [ ] Begin with isolated scheduler, delivery, file-maintenance or capability-lifetime logic touched by the confirmed tickets; avoid a blanket rewrite.
  - [ ] Add root script/E2E configuration checking and a narrow lint baseline for async promises, hooks and unsafe escaping; pay existing errors before enforcing rules broadly.
  - [ ] Describe the native API from existing schemas or generated contracts; keep runtime validation authoritative and define version/deprecation policy.
  - [ ] Restore dependable CI execution before presenting skipped/refused jobs as release validation.
  - [ ] Publish versioned server/container/desktop artifacts deliberately, with checksums, provenance/dependency evidence and platform install/upgrade/rollback drills.

**Done:** changed domains retain behavior and meaningful regression coverage, all claimed static checks execute on their intended files, and a release can be obtained and recovered on its supported platforms. A package target declaration or a green local unit suite is insufficient installed-platform evidence.

## 6. Suggested dependency order and experiment register

1. **Data/recovery correctness:** SR-3 pre-upgrade copy, SR-4 workspace ownership, SR-1 retention, SR-2 queued-content privacy. These are real product changes with focused reproductions.
2. **Resource and lifecycle bounds:** SE-1 reception/socket/upload admission, SE-2 shutdown, urgent SE-3 capability/queue count bounds. Tie limits to operator diagnostics and reversible refusals.
3. **Measure and optimize:** the thread-history index, SE-5 mixed workload and targeted fanout/snapshot work; include SE-4 disk/lock evidence.
4. **Operator/product expansion:** SE-6 edit conflicts, SE-7 portable migration, scoped integrations, policy and paged administration. Carry explicit defaults and data migration review.
5. **Distribution/maintenance:** SE-9 contract/static checks/domain extraction and release gates can proceed in parallel in small slices; installed-platform/real-network evidence remains a separate requirement.

Do not make all optional cohort features prerequisites for a small local pilot. Conversely, closed earlier fixes should not hide the confirmed new failures merely because unit counts increased.

| Ignored local probe                                            | Scope                                                                    | Recorded result                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `.git/audit30-retention.ts`                                    | Current Store, one root + 33,000 old replies, in memory                  | Parameter-limit error; rollback retained all 33,001 messages.                   |
| `.git/audit30-delivery-redaction.ts`                           | Loopback HTTP post/delete/edit, isolated queue, fixture bot/subscription | Old text absent from events but present in pending integration bodies.          |
| `.git/audit30-upgrade-backup.ts`                               | Real v26 databases in a new temporary directory                          | v27 upgrade succeeded; reported new recovery file did not exist.                |
| `.git/audit30-workspace-ownership.ts`                          | Two independent server instances, one disposable on-disk workspace       | Both started; two 4-byte uploads accepted despite a 4-byte cap.                 |
| `.git/audit30-fastify.ts`                                      | Installed Fastify factory and current relevant options                   | Fastify 5.12.1; request timeout 0, socket timeout 0, header timeout 60 seconds. |
| `.git/audit30-query-plans.ts` / `.git/audit30-thread-index.ts` | Current SQL and a scratch-only in-memory composite index                 | Query-plan change; fixture and timing limits recorded in section 3.             |

The scripts are local evidence, not shipped tests or required tracked artifacts. The recipes above carry their conditions into the durable plan. No claim here requires access to the user's production workspace or execution of competitor code.
