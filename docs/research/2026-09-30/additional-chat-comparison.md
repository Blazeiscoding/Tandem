# Additional chat optimization comparisons, 30 September 2026

Gatherline source baseline: `7d91fd3ff676fa88641b7f45f1353d1fd043d441` (`origin/main`, after #149). These are source-supported experiment candidates. No dependencies were installed, no upstream application was run, and no comparative speed or memory result was measured.

## Pinned upstream snapshots

| Repository                                                                                                     | Inspected snapshot                         | Scope                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| [Element Web](https://github.com/element-hq/element-web/tree/37d17a9bce859d4e10e027bace43cb67d10240fb)         | `37d17a9bce859d4e10e027bace43cb67d10240fb` | Room-list updates, thumbnail generation, worker-backed storage and background indexing |
| [Element Desktop](https://github.com/element-hq/element-desktop/tree/264c591b9cbec73782fc6c95aa94b4dc9ac32754) | `264c591b9cbec73782fc6c95aa94b4dc9ac32754` | Optional local search-index initialization, IPC, recovery and shutdown                 |

The inspected files declare `AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial`; both repositories contain the corresponding license files. Gatherline currently uses [MIT](../../../LICENSE). The plan below adapts mechanisms through an independent implementation. Reusing Element code or adding its native indexing dependency requires a separate dependency/license decision; source availability does not make the code MIT licensed.

## ELM-1: batch visual room-list publication and update the affected entry

**Observed mechanism.** Element's [RoomListStoreV3](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/stores/room-list-v3/RoomListStoreV3.ts#L458) uses a pending flag and `requestAnimationFrame` to emit one list update for rapid changes within a frame. Its adjacent `addRoomAndEmit` reinserts the affected room into its sorted structure before scheduling the emission. Backfilled timeline events are excluded from the live room-recency update path.

**Gatherline fit.** [context.ts](../../../packages/ui/src/context.ts) already uses Zustand selector subscriptions. This is not a missing basic subscription mechanism. However, [Sidebar.tsx](../../../packages/ui/src/components/Sidebar.tsx#L78) scans channels and sorts the complete DM list whenever `channels`, `memberships` or `channelLastSeq` changes. [workspace.ts](../../../packages/client-core/src/workspace.ts#L702) applies each event separately. A busy reconnect or several active channels may therefore repeatedly invalidate derived navigation work; the cost needs a trace.

- [ ] Record event application, sidebar derivation and React commit counts for ordinary traffic and reconnect bursts.
  - [ ] Compare 50, 500 and 2,000 joined channels/DMs with 1,000 ordered mixed events; include membership changes, backfill, unread changes and currently open threads.
  - [ ] Preserve existing narrow selectors; first try memoized per-entry derivation and stable sorted results before adopting a skip list.
  - [ ] Trial batching only replaceable visual publication, with a maximum latency and a fallback when frames are suspended in a hidden window.
  - [ ] Keep ordered replica application, sequence advancement, durable outbox writes, notifications and authorization transitions outside a lossy visual queue.
  - [ ] Fence pending work to the client/workspace generation and cancel it on sign-out, reset or disconnect disposal.

**Decision evidence:** fewer redundant sidebar computations and commits, improved p95 frame time and typing latency, and no delayed unread/notification state or lost events. Reject extra indexing complexity if the existing list remains inexpensive at the declared workspace size.

## ELM-2: deliver a thumbnail separately from the original media

**Observed mechanism.** Element's [image-media.ts](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/utils/image-media.ts#L22) generates an aspect-preserving thumbnail within 800 × 600 using canvas and asynchronous blob conversion. [ContentMessages.ts](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/ContentMessages.ts#L138) uploads the thumbnail separately, gates ordinary images on size savings, and retains compatibility fallbacks. [MediaEventHelper](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/utils/MediaEventHelper.ts#L25) keeps source and thumbnail resources lazy and revokes generated object URLs on destruction.

**Gatherline fit.** [Attachments.tsx](../../../packages/ui/src/components/Attachments.tsx#L47) already loads images near the viewport, reserves their dimensions and requests asynchronous decoding. [FileCache](../../../packages/client-core/src/fileCache.ts) already deduplicates transfers, limits them to four, cancels released work and caps idle blobs at 32 MiB. The remaining distinction is that an inline preview fetches the original file, even though it is displayed within 380 × 300. The 8 MiB inline cutoff limits compressed bytes, not decoded pixels or active retained resources. A 4,000 × 3,000 RGBA bitmap represents approximately 45.8 MiB of pixel data; that calculation is illustrative, not an observed Chromium allocation.

- [ ] Profile image-heavy channels for transfer bytes, decode time, renderer/GPU memory and frame time before adding derivatives.
  - [ ] Use a fixture with large-dimension, small-compressed images, ordinary phone photos, animated images and corrupt files; scroll in both directions and open the lightbox.
  - [ ] Prototype a distinct authenticated thumbnail resource and cache key while preserving access checks, expiry/deletion behavior and original downloads.
  - [ ] Choose client-generated versus server-generated derivatives from measured upload cost, trust requirements and supported clients; cap pixel dimensions, decoding time and concurrent generation.
  - [ ] Keep generation away from Electron main/server request-loop stalls; retain a file-card fallback when preview generation or decoding fails.
  - [ ] Store dimensions and derivative identity deliberately; preserve existing layout reservation, cancellation, object-URL cleanup and transfer limits.
  - [ ] Include derivative bytes in quota, garbage collection, backup/restore and retention accounting, and avoid duplicates for files that gain little from resizing.
  - [ ] Treat remote avatars as a future user-profile feature: current [Avatar.tsx](../../../packages/ui/src/components/Avatar.tsx) renders initials and does not download avatar images.

**Decision evidence:** lower network/decode cost and bounded decoded-media memory on target hardware, with acceptable generation/storage overhead and no preview authorization bypass. Element's dimensions and thresholds are reference choices; set Gatherline's values from display size, device-pixel ratio and measurements.

## ELM-3: put a growing local replica in asynchronous storage behind an explicit contract

**Observed mechanism.** Element's [createMatrixClient.ts](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/utils/createMatrixClient.ts#L191) configures `IndexedDBStore` with a worker factory when browser storage is available. Its [factory](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/workers/indexeddbWorkerFactory.ts#L9) creates a separate worker entry; the [worker](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/workers/indexeddb.worker.ts#L9) delegates requests to the Matrix SDK storage backend. [MatrixClientPeg](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/MatrixClientPeg.ts#L243) awaits store startup and can fall back to an in-memory store if initialization fails.

**Gatherline fit.** Browser [platform.ts](../../../packages/ui/src/platform.ts#L252) currently reads/writes JSON in `localStorage`; desktop uses an IPC-backed settings store. [workspaceStorage.ts](../../../packages/ui/src/lib/workspaceStorage.ts) serializes per-key operations and scopes them to account/workspace identity. These choices serve relatively small local work, not a persisted entire message archive. A larger offline replica would make asynchronous indexed storage relevant, but replacing small settings does not establish a performance win.

- [ ] Measure present draft/outbox serialization and storage latency during typing and large accepted-send queues.
  - [ ] Keep the accepted-send durability repair ahead of storage optimization; acknowledge a send only under the selected durable-write contract.
  - [ ] If offline history is adopted, persist paged records and sync checkpoints transactionally rather than repeatedly serializing the whole replica.
  - [ ] Scope records to verified workspace/account identity and declared address trust; migrate existing data without resurrecting cleared work.
  - [ ] Compare direct IndexedDB with a worker-owned database; measure structured-clone/queue overhead before adding a worker.
  - [ ] Bound queued operations and worker response maps; distinguish quota, eviction, blocked upgrades, unexpected close and worker failure.
  - [ ] Make an unavailable durable store visible. An in-memory fallback can keep reading available, but cannot silently satisfy a promise that accepted sends survive restart.
  - [ ] Verify browser eviction/private mode, concurrent tabs, migration interruption, reload and renderer failure; keep a working desktop/browser storage interface.

**Decision evidence:** less main-thread storage work under a measured workload, preserved acknowledgment semantics, and recovery from storage failure. IndexedDB is conditional architecture work, not a prerequisite for the current online-only message history.

## ELM-4: make optional offline search indexing checkpointed and cooperative

**Observed mechanism.** Element Desktop's [seshat.ts](https://github.com/element-hq/element-desktop/blob/264c591b9cbec73782fc6c95aa94b4dc9ac32754/src/seshat.ts#L23) dynamically loads an optional native event index and exposes initialization, live commit, historical batch, search, checkpoint and shutdown operations. Web [EventIndex.ts](https://github.com/element-hq/element-web/blob/37d17a9bce859d4e10e027bace43cb67d10240fb/apps/web/src/indexing/EventIndex.ts#L450) drives a cancellable round-robin crawler. It fetches at most 100 events per crawl, yields at a configurable delay with a 100 ms floor, waits five seconds when idle, and advances persisted checkpoints alongside historical insertion.

**Gatherline fit.** [SearchDialog.tsx](../../../packages/ui/src/components/SearchDialog.tsx) calls the server's paginated search API; Gatherline already has server-side SQLite FTS. Element's local index primarily supports searching data that its server cannot search in plaintext. Gatherline's present architecture does not need a second search engine merely to match Element. The transferable technique is resumable bounded indexing if an offline-history or encrypted-search requirement is adopted.

- [ ] Establish whether a target cohort needs offline search and how much history it expects to keep locally.
  - [ ] Start from the scoped local-replica decision above; define permitted history, disk budget, eviction, device revocation and account cleanup.
  - [ ] Make catch-up incremental and idempotent, with cursor/checkpoint progress committed with the corresponding records.
  - [ ] Prioritize live traffic over catch-up; bound batches/concurrency and pause or reduce optional work under user activity, battery or resource pressure.
  - [ ] Apply edits, deletes and retention to the index, and reconcile missing events after reconnect rather than returning stale private data.
  - [ ] Cancel work on logout/workspace switch/quit; prevent checkpoint completion from a previous generation entering the new account.
  - [ ] Expose progress, incomplete coverage and rebuild/recovery explicitly; preserve server search as the normal online path where appropriate.

**Decision evidence:** useful offline coverage within a chosen disk/network/power budget, acceptable live-chat latency during catch-up, and correct results after edits/deletes/resume. Evaluate the existing storage/FTS ecosystem before introducing a native addon; its packaging and schema recovery are material maintenance costs.

## Measurement protocol for these candidates

- [ ] Record baseline commit, packaged app/runtime version, OS, hardware, fixture sizes and whether a run uses hosting or a remote server.
  - [ ] Measure cold and warm runs separately; retain repeated-run distributions rather than selecting the fastest attempt.
  - [ ] Separate event decoding/application, derived-state computation, React commits, storage queue wait and transfer/decode time.
  - [ ] Record renderer, Electron main and GPU memory separately where supported; compressed blob bytes are not the process memory budget.
  - [ ] Include visible, minimized, tray-only and wake/reconnect workloads so a foreground win does not hide idle cost.
  - [ ] Change one mechanism at a time and compare the same deterministic fixture with tracing disabled and enabled.
  - [ ] Set acceptance budgets before the production PR and retain a disable/fallback path for optional experiments.

Treat the upstream source as a design reference, and Gatherline's measured before/after result as the evidence for adopting it. A benchmark harness alone does not complete the corresponding production task.

## Recommended placement in the main execution plan

| Pattern                                      | Placement                                                 | First reviewable artifact                                                               |
| -------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ELM-1 visual batching/incremental navigation | Near-term renderer measurement experiment                 | Trace of sidebar work during reconnect plus a bounded prototype if the cost is material |
| ELM-2 media derivatives                      | Near-term decoded-media experiment                        | Before/after image fixture report and authenticated derivative design                   |
| ELM-3 asynchronous local replica             | Conditional on measured storage stalls or offline history | Durability contract and storage comparison, after the accepted-send fix                 |
| ELM-4 checkpointed offline index             | Cohort-dependent product/architecture work                | Offline-history/search requirement and bounded catch-up design                          |

Existing 300-message timeline bounds, 20 total history-cache entries per category with active views protected, four concurrent file fetches, 32 MiB idle blob budget, socket limits, ten-row scheduled batches and backup workers remain present. These comparisons extend the measured optimization surface; they do not reopen those mechanisms as missing features.
