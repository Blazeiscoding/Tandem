# Rocket.Chat comparison: chat, server and Electron

**30 September 2026 · Gatherline `7d70dac` · source research and proposed follow-ups.** This extends the [update plan](../../UPDATE-PLAN-2026-09-30.md) and [optimization plan](../../OPTIMIZATION-PLAN-2026-09-30.md). Rocket.Chat was not included in the comparison published in #150; this is the requested additional review.

## Scope and pinned sources

| Repository                                                                                                               | Inspected commit                           | Scope                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [Rocket.Chat](https://github.com/RocketChat/Rocket.Chat/tree/aa73c68a02653abdca01807355873d9703d11457)                   | `aa73c68a02653abdca01807355873d9703d11457` | Message rendering/selectors, reconnect reconciliation, history paging, maintenance, notification queue and metrics |
| [Rocket.Chat Electron](https://github.com/RocketChat/Rocket.Chat.Electron/tree/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868) | `d3d3f1659dbd4717c7736fb25a9d7bdbb4979868` | Image-resource pressure, startup diagnostics/recovery, capture enumeration and inactive-server views               |

Selected source files were read through GitHub's API and kept under ignored `.git/research/rocket-chat/`. Neither application was installed, executed or benchmarked. These are default-branch snapshots, not a supported-release or capacity claim. Issue reports supplied search leads; the implementation statements below rely on pinned code. Official documentation was retrieved through search; direct fetches of the documentation pages were restricted.

The [core license](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/LICENSE) specifies MIT outside its enterprise directories and third-party exceptions. [Enterprise code](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/ee/LICENSE) has separate terms; the repository is not uniformly MIT. The [desktop license](https://github.com/RocketChat/Rocket.Chat.Electron/blob/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868/LICENSE) is MIT. Retain applicable notices if copying substantial code; these recommendations concern mechanisms rather than imported code.

## What already changed in Gatherline

The earlier comparison began at `b3209ab`. Before this report was written, `origin/main` advanced to `7d70dac`; relevant source and plan statuses were rechecked. Preserve these merged changes:

- **#151:** temporary-table retention, caught/yielding passes and retention status. A very large thread remains whole and alone; its latency/WAL cost still needs measurement.
- **#153:** one active workspace writer through an OS-backed SQLite file lock.
- **#160:** composite thread-history index, migration and recorded HTTP measurements.
- **#162–163:** cross-window outbox intent and agreed channel/thread read semantics.
- **#164:** narrow message-row subscriptions; real browser input/layout measurements remain open.
- **#165:** indexed mention counts and Activity mentions. Thread summaries, Activity unread traversal and snapshot costs remain candidates.

This follow-up did not rerun those fixes' tests or reproduce their published timings. The main plans retain their results and limitations.

## RC-1: window rendering without retaining every media row

**Observed:** Rocket.Chat's [message list](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/client/views/room/MessageList/MessageList.tsx#L266) uses Virtua's `VList`, with selected rows kept mounted. Its [retention hook](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/client/views/room/MessageList/hooks/useKeepMountedMessages.ts#L3) keeps file/preview rows alive to avoid reloading embeds; its own comments warn that expanding this policy defeats virtualization in media-heavy histories.

**Fit:** Gatherline already bounds loaded timeline/thread history to 300 messages. OPT-06 compares that DOM against a smaller rendered window; OPT-09 covers media resources. A list library is an experiment, not a missing baseline control.

- [ ] Compare current rendering with windowing on text, images, long code and actively playing audio/video.
  - [ ] Specify which focused/playing rows may stay mounted and bound that set; keep durable UI state outside recycled rows where practical.
  - [ ] Preserve scroll anchors, IME/edit text, menu focus, accessible list navigation and playback state.
  - [ ] Measure mounted rows, renderer/GPU memory where available, frame/commit time and re-fetch/redecode work through repeated paging.

**Decision:** adopt only when relevant interaction/memory improves without permanent retention of all attachment rows. Do not copy Rocket.Chat's keep-mounted policy or Virtua merely because they are present upstream.

## RC-2: stable selection is separate from selection cost

**Observed:** [useMessages](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/client/views/room/MessageList/hooks/useMessages.ts#L19) memoizes its room predicate and uses `useShallow` around a filtered/sorted selection. This can preserve an equal result's reference; the selector still evaluates a filter/sort over the underlying message state.

**Fit:** #164 already supplies Gatherline's narrow message-row subscriptions. Retain it. Further candidates are measured sidebar/list derivation and burst publication under OPT-07, alongside the [Element comparison](additional-chat-comparison.md#elm-1-batch-visual-room-list-publication-and-update-the-affected-entry).

- [ ] Measure derivation time separately from React commits in current browser traces.
  - [ ] Include unrelated account/channel updates and mixed reconnect events with many retained histories.
  - [ ] Preserve stable entity references and consider incremental list ordering only when full derivation is material.
  - [ ] Check author/mention/channel rename and role changes; equality checks must not preserve stale access or visible names.

**Decision:** fewer commits alone do not establish lower total CPU or input delay. A new global message store/full sort offers no demonstrated benefit over Gatherline's scoped histories.

## RC-3: reconnect must reconcile edits and deletions, with explicit coverage

**Observed:** [useLoadMissedMessages](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/client/views/root/hooks/useLoadMissedMessages.ts#L12) calls REST sync using the newest loaded creation timestamp and oldest loaded timestamp, applies updated messages and removes returned deletion IDs. Its comments explicitly exclude edits to older, unloaded history, which is fetched again later.

**Fit:** Gatherline already has ordered sequence replay, snapshot fallback, nonce reconciliation and bounded histories. Preserve that authority. The transferable point for OPT-07/24 is explicit loaded-cache coverage and a coherent update/delete result, not switching to timestamp synchronization.

- [ ] Profile reconnect work for the loaded channel, open thread and protected inactive cache entries.
  - [ ] Verify edits, deletes, root removal, retention and access changes across loaded, evicted and later-refetched history.
  - [ ] Keep durable event reduction, outbox persistence and authorization immediate; batch only safe visual publication.
  - [ ] Preserve sequence gaps/reset semantics and bound pending request/application work. Creation timestamps do not replace Gatherline's event sequence.

**Decision:** catch-up gets cheaper while authoritative final state remains identical. No new sync protocol is justified by this source comparison.

## RC-4: separate page normalization from unread/count work

**Observed:** [history paging](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/server/lib/messages/loadRoomHistory.ts#L104) uses `count + 1` to discover a page boundary. [Unread metadata](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/server/lib/messages/loadRoomHistory.ts#L214) uses a first-unread query and database count. Its [message model](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/packages/models/src/models/Messages.ts#L41) declares indexes for distinct query shapes.

**Fit:** Gatherline already keyset-paginates, uses four page-scoped relation queries in [hydrateMessages](../../../packages/server/src/store.ts), and has indexed mention counts and the composite thread index. This is not evidence of a generic N+1 problem. Remaining OPT-12 candidates are thread summaries, Activity unread traversal and repeated snapshot work.

- [ ] Record statement counts, query plans, examined/returned rows and normalization allocations on the current code.
  - [ ] Compare page-plus-one with existing `EXISTS` checks only on a demonstrated expensive path.
  - [ ] Keep unread position separate from the pagination boundary; opening a partly read history must not truncate the requested page.
  - [ ] Preserve Gatherline's ID ordering, access predicates and implemented read rule; compare 50k/200k fixtures with write/index costs.

**Decision:** optimize the measured remaining query. Rocket.Chat's timestamp cursor and in-memory tie-break are not reasons to replace Gatherline's stable ID cursor.

## RC-5: bound maintenance effects and make queue ownership explicit

**Observed:** [attachment cleanup](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/server/lib/rooms/cleanRoomHistory.ts#L58) batches file-only updates and one bulk invalidation per 1,000 selected messages. This does not bound its whole retention implementation: the same path gathers thread IDs and supports broader deletion. [Notification claims](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/packages/models/src/models/NotificationQueue.ts#L71) atomically set a sending lease; the [worker](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/server/lib/notifications/queue/NotificationQueue.ts#L40) yields between cycles. Errored rows are excluded and the queue has a TTL; this is not a universal retry/backoff contract.

**Fit:** #151/#153 already repair Gatherline retention and enforce directory ownership. Current event delivery has a serialized flush, 50-item pass, groups of 10, subscription ordering and retry/backoff. OPT-15 should measure remaining fairness and publication cost rather than replace these protections.

- [ ] Measure live post/search latency, event-loop delay, peak memory and WAL/backlog growth during maintenance.
  - [ ] Include a whole thread larger than 5,000 messages and high dependent-file/reaction volume.
  - [ ] Consider grouped visual invalidation only with preserved durable sequence, delete/edit order and replay.
  - [ ] Introduce durable claims only if deliberately adding concurrent workers; retain single-directory ownership, crash recovery and idempotency.

**Decision:** lower maintenance interference with eventual correctness and actionable failure status. Upstream's chunk size, lease duration and TTL are not Gatherline defaults.

## RC-6: measure named routes with bounded labels

**Observed:** [REST middleware](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/server/api/v1/middlewares/metrics.ts#L27) measures request duration, response size and active requests, separating overlapping API mounts. Ordinary labels use route paths; optional user-agent and method-call labels need separate cardinality review. Some [other metrics](https://github.com/RocketChat/Rocket.Chat/blob/aa73c68a02653abdca01807355873d9703d11457/apps/meteor/server/lib/metrics/lib/metrics.ts#L157) include account/connection/IP labels.

**Fit:** extend OPT-20/OPS-10 with small local diagnostics; a full external monitoring stack is optional.

- [ ] Add fixed-route duration, response-byte and in-flight counters with exactly one sample per request.
  - [ ] Balance counters through exceptions/aborts and record incomplete responses accurately.
  - [ ] Bound samples/label vocabulary; omit concrete URLs, account IDs, IPs, message content, tokens and raw user agents.
  - [ ] Compare collection enabled/disabled for latency, throughput, idle CPU and memory; vary IDs/URLs to verify bounded cardinality.

**Decision:** diagnostics identify the next bottleneck without becoming a material resource cost or exposing conversation data.

## RC-7: distinguish browser image-cache pressure from stored attachment bytes

**Observed:** desktop [preload](https://github.com/RocketChat/Rocket.Chat.Electron/blob/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868/src/preload.ts#L77) samples `webFrame.getResourceUsage().images.size` after navigation with a 30-second trailing debounce and clears the frame cache above 50 MiB. It is event-driven, not a periodic poll. Electron documents this as [Blink cache accounting](https://www.electronjs.org/docs/latest/api/web-frame#webframegetresourceusage), not whole-process/GPU memory; its cache-clearing documentation warns of refill costs.

**Fit:** Gatherline's 32 MiB idle-blob cache, four-transfer cap and near-viewport fetch are present. OPT-09 still needs active/decoded-media budgets; OPT-20 can collect supporting evidence.

- [ ] Measure retained blobs, dimensions, Blink image-cache accounting where supported, process/GPU memory and redecode/refetch cost separately.
  - [ ] Feature-detect the pinned runtime's diagnostic APIs while retaining the sandboxed preload/bridge; use diagnostic-tool measurements when an API is unavailable.
  - [ ] Prefer thumbnails and releasing offscreen resources before trialing broad cache clearing.
  - [ ] Compare image-heavy navigation, lightbox return and hidden-window recovery; preserve anchors and access revocation.

**Decision:** lower measured memory without refill/scroll regressions. The 50 MiB upstream threshold neither bounds total image memory nor replaces Gatherline's blob budget.

## RC-8: distinguish loaded from usable, and bound renderer recovery

**Observed:** [bootWatchdog](https://github.com/RocketChat/Rocket.Chat.Electron/blob/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868/src/servers/bootWatchdog.ts#L195) is development/opt-in, bounds in-memory console/timeline entries, and watches committed navigation, unresponsive states and crashes. Its report appends to a file; the in-memory limits alone do not prove a disk bound. [Injected recovery](https://github.com/RocketChat/Rocket.Chat.Electron/blob/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868/src/injected.ts#L56) limits attempts to two and declines recovery when its counter cannot be persisted. Its [reload path](https://github.com/RocketChat/Rocket.Chat.Electron/blob/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868/src/ui/main/serverView/index.ts#L691) clears several storage classes.

**Fit:** OPT-19/20 can use explicit readiness and bounded recovery. Preserve #162's durable accepted-send contract and backend/recovery ownership.

- [ ] Define renderer usable milestones and generation-fenced deadlines independently of page load.
  - [ ] Persist/bound attempts, offer manual recovery when exhausted, and leave hosted server/route/recovery operations intact.
  - [ ] Rehydrate drafts/outbox and reconcile accepted sends; never treat their storage as disposable cache.
  - [ ] Redact stage diagnostics, cap/rotate disk output and verify healthy startup overhead, wedge detection and repeated-crash recovery.

**Decision:** a failed renderer becomes discoverable and recoverable without looping or discarding accepted work. Gatherline retains its sandbox, context isolation and narrow bridge rather than copying upstream web preferences.

## RC-9: cache capture enumeration only if an expanded picker needs it

**Observed:** [desktopCapturerCache](https://github.com/RocketChat/Rocket.Chat.Electron/blob/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868/src/screenSharing/desktopCapturerCache.ts#L98) uses separate screen/window buckets, an in-flight operation and cooldown; initial screens are awaited and windows refresh asynchronously.

**Fit:** Gatherline already has a trusted-renderer handler, Cancel plus named-screen selection, and system-picker support. CALL-03 adds window choice/previews; OPT-23 measures media cost.

- [ ] Measure expanded picker enumeration/open p50/p95 on supported OSes with many windows.
  - [ ] If caching is justified, deduplicate work, bound thumbnail bytes/pixels, allow refresh/cancel and invalidate changed permissions/sources.
  - [ ] Revalidate the selected source before capture; an old cached preview is not authorization to share it.

**Decision:** the expanded picker opens faster while displaying current choices. No thumbnail cache is needed merely to match upstream's architecture.

## Product comparisons and conditional scope

Rocket.Chat's [official overview](https://docs.rocket.chat/docs) covers channels, discussions, threads, files, search and integrations, making those workflows relevant comparisons. Its [published release notes](https://docs.rocket.chat/docs/rocketchat-release-notes) describe draft indicators, paged/around-reply loading, call-device preflight, and fixes for reading-position/accessibility regressions. These are published descriptions, not measured Gatherline improvements or an independently validated feature matrix.

- [ ] Under UX-01/05, compare room/thread draft discoverability and return-to-history tasks; existing drafts/history paging must remain.
- [ ] Under CALL-01, evaluate the actual mic/camera preflight task and recovery from a denied/missing device.
- [ ] Under OPT-06/UX-07, include return position, contextual-panel opening and accessible list announcements in any windowing experiment.

Omnichannel customer support, federation, enterprise policy and native mobile are separate product/operational decisions in the main plan. This review did not inspect the native mobile repository or establish commercial-edition parity. Rocket.Chat's [monitoring guide](https://docs.rocket.chat/docs/access-workspace-logs) provides an operating precedent; Gatherline can start with bounded local diagnostics instead of importing its monitoring/deployment stack.

Desktop [inactive server panes](https://github.com/RocketChat/Rocket.Chat.Electron/blob/d3d3f1659dbd4717c7736fb25a9d7bdbb4979868/src/ui/components/ServersView/ServerPane.tsx#L184) use per-server persistent partitions and hide inactive views. Hiding does not prove suspension or bounded aggregate resources. UX-09/OPT-24 still need explicit 1/3/10-workspace connection, memory and idle measurements.

## Adoption order

1. Preserve the merged thread index, narrow subscriptions, mention index, read contract, outbox and ownership/retention repairs. Do not reopen them as absent.
2. Run current browser/mixed-workload traces and add bounded stage/route diagnostics where useful.
3. Select the measured remaining bottleneck: rendered-window/media memory, derivation/publication, hydration/Activity unread or maintenance interference.
4. Prototype boot recovery or capture caching only against a demonstrated failure/cost, with durable state and installed-platform evidence.

Every adaptation needs an actual implementation and before/after successful-workload evidence, or a documented rejection. These source patterns refine the existing OPT tickets; they do not establish that Rocket.Chat is faster or that Gatherline needs its database/framework/service topology.

## Publication checks

Five touched/new Markdown files passed checks for 58 local file/heading links. The 21 pinned upstream file citations matched inspected sources and their line anchors were within those files. Repository source formatting passed with the standard source/build exclusions; `git diff --check` passed. These documentation checks are separate from the application, installed-device and performance validation still required for an implementation.
