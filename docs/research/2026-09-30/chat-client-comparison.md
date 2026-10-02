# Chat client audit and implementation comparisons

Date: 30 September 2026. Tandem baseline: **origin/main at 7d91fd3**, merged through #149. This report supplies source evidence and experiments for the update and optimization plans. It distinguishes reproduced defects, source gaps and work requiring physical devices or usage research.

## Method and limits

Read the client replica, persistence adapters, notification policy, message/thread rendering, search, account and call flows, and relevant existing tests. Three disposable Vitest probes exercised current production helpers/components; their recipes and results are below. The probes were removed after execution. Existing .audit-client-143/ and .claude/ work was preserved. No product code was changed.

Upstream source was read through GitHub APIs and pinned raw files. Neither upstream repository was cloned, installed or executed. The comparisons show implementation patterns; they do not establish that either app is faster than Tandem, and they are not participant research.

| Repository | Inspected revision                                                                                                                   | Scope                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Zulip      | [7a921db6dad7c71ef4c93ec7b24e229f028710a5](https://github.com/zulip/zulip/commit/7a921db6dad7c71ef4c93ec7b24e229f028710a5)           | DOM windowing and anchoring, fetch workload, view-cache eviction, thumbnail-format choice        |
| Mattermost | [cc0611f2ee9c8d8c012bb3631133d6d51e069068](https://github.com/mattermost/mattermost/commit/cc0611f2ee9c8d8c012bb3631133d6d51e069068) | Variable-height virtualization, resize observation, row subscriptions, thread/reaction selectors |

## Current mechanisms worth retaining

An optimization plan must not describe the following as missing.

| Mechanism                                       | Current evidence                                                                                                                                                                                                     | Remaining boundary                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded loaded history                          | [workspace.ts](../../../packages/client-core/src/workspace.ts):165,335–348 caps individual timeline/thread windows at 300 messages.                                                                                  | DOM rendering and loaded-data budgets are currently coupled. A 300-message window is already finite; measure its cost before introducing another renderer. |
| Inactive-history eviction                       | workspace.ts:336,1116–1178 uses a count limit of 20 for timeline caches and for thread caches, recency ordering and protection of active views.                                                                      | Count does not bound retained text/metadata bytes or decoded image memory. Do not propose adding a missing global count LRU.                               |
| Attachment concurrency and idle-byte budget     | [fileCache.ts](../../../packages/client-core/src/fileCache.ts):8–24,43–90 runs at most four body transfers and limits idle blob bytes to 32 MiB. Retained resources are protected; access invalidation revokes URLs. | The budget measures compressed blobs. It does not measure decoded pixels or total memory of active resources.                                              |
| Visible-image loading                           | [Attachments.tsx](../../../packages/ui/src/components/Attachments.tsx):46–63,242–272 observes previews with a 160 px margin and releases disabled/unmounted resources.                                               | Original images are still fetched/decoded for previews. Consider derived thumbnails only after measuring pixel-heavy workloads.                            |
| Narrow store API and memoized rows              | [context.ts](../../../packages/ui/src/context.ts):35–38 provides selector subscriptions; [MessageItem.tsx](../../../packages/ui/src/components/MessageItem.tsx):32–46 uses React memo.                               | Message rows subscribe to the entire users, channels and self objects. Relevant per-row dependencies can be narrower.                                      |
| History request reconciliation                  | workspace.ts:1178 onward and 1360–1464 guards current requests, merges post-snapshot events and bounds loaded windows.                                                                                               | Event catch-up publication cost needs profiling; batching must preserve ordering, revocation, send reconciliation and read semantics.                      |
| Immediate outbox changes and sequential merging | [DraftPersistence.tsx](../../../packages/ui/src/components/DraftPersistence.tsx):103–159 writes accepted/delivered/refused changes immediately and merges existing stored entries.                                   | #147 closed the 600 ms delay and sequential overwrite cases. Concurrent mutation and stale-window resurrection remain, as reproduced below.                |
| Thread rollback guard                           | workspace.ts:1767–1791 applies thread revisions and checks optimistic-state identity before rollback.                                                                                                                | #148's older failed thread-read case is fixed. Other optimistic paths need their own inspection.                                                           |

## Reproduced remaining defects

### CC-1: concurrent windows lose an outbox update

Priority: P1. Confidence: reproduced against production storage helper with independent adapters.

The queue in [workspaceStorage.ts](../../../packages/ui/src/lib/workspaceStorage.ts):36–63 is keyed by Platform instance. Its update operation at :145–159 separately reads and writes. Different windows have separate queues/realms. Desktop [index.ts](../../../apps/desktop/src/main/index.ts):153–158 exposes separate storage get/set IPC, without an atomic update operation.

Probe recipe:

1. Initialize a shared storage Map with an outbox key holding an empty array.
2. Create two distinct Platform adapters whose asynchronous get/set methods access that Map.
3. Call production updateWorkspaceStorage for both adapters concurrently with Promise.all; each appends a different entry.
4. Inspect durable storage after both promises settle.

Result: only **second-window-send** remained. One focused UI-helper Vitest case completed in 3 ms. This demonstrates the adapter-level race; it was not a real multi-process browser drill. The existing #147 test at draftPersistence.dom.test.tsx:264–271 waits for the first durable write before the second window sends, so it establishes sequential merging.

- [ ] Add atomic platform storage mutation: serialize the complete read/update/write in desktop main-process IPC; evaluate IndexedDB transactions or explicit cross-tab ownership for the browser.
- [ ] Preserve workspace/account scope, legacy migration and strict read-error handling.
- [ ] Exercise truly concurrent accepts with controlled storage delays, then two real windows/tabs.
- [ ] Complete when both accepted entries remain after concurrent writes and restart, including write failure/retry.

### CC-2: a stale window resurrects a discarded send

Priority: P1. Confidence: reproduced through actual DraftPersistence components.

DraftPersistence.tsx:103–109 merges each window's entire currentOutbox. Removal intent is a window-local Set. There is no shared outbox change subscription. Atomic storage mutation alone will not prevent stale entries from being reintroduced.

Probe recipe:

1. Seed shared storage with refused nonce A, text discard-me; render two clients with separate Platform adapters and actual DraftPersistence components.
2. Wait until both clients have restored A.
3. In client 1, discardSend(A); wait for the durable array to become empty.
4. In client 2, accept unrelated send B while HTTP sendMessage is mocked offline.
5. Read shared durable storage.

Result: **discard-me and unrelated-send** were both stored. One focused UI-component case completed in 247 ms. No successful network post occurred. A stale refusal state can follow the same merge shape; that variant still needs its own reproduction.

- [ ] Define shared per-nonce updates, revisions or durable tombstones; synchronize changes to other windows.
- [ ] Preserve discard/refusal intent across another window's unrelated send, flush and restart.
- [ ] Avoid turning a storage resync into uncontrolled network redelivery.
- [ ] Complete when accepted messages survive while delivered/discarded entries cannot reappear from stale windows; retain server nonce idempotency.

### CC-3: an older refusal overwrites a newer notification preference

Priority: P2. Confidence: reproduced with production WorkspaceClient.

workspace.ts:1843–1849 unconditionally restores previous channel preferences on failure. [ChannelDetailsDialog.tsx](../../../packages/ui/src/components/ChannelDetailsDialog.tsx):646,661 permits overlapping changes.

Probe recipe:

1. Start with notifyLevel mentions.
2. Set all while the first mocked API promise remains pending.
3. Set nothing and resolve the second request successfully.
4. Reject the first request, then inspect current client preferences.

Result: the client reverted to **mentions**, overwriting the later successful nothing choice. One focused client-core case completed in 3 ms.

- [ ] Add operation/revision guards and reconcile authoritative server state.
- [ ] Show a failed preference save with retry instead of silently reverting.
- [ ] Test earlier failure after later success and after a server/device echo.
- [ ] Inspect DND at workspace.ts:1858–1863, pin at :1691–1708, Saved at :1716–1732 and [appearance.ts](../../../packages/ui/src/lib/appearance.ts):35–46. These other paths have similar rollback code but are not all proven defects.
- [ ] Complete when an obsolete response cannot replace newer intent or authoritative state.

## Other source findings and product work

These items should become bounded implementation slices in the master plan, with cohort-dependent features kept separate from correctness gates.

| Item                         | Evidence / confidence                                                                                                                                                                                                                                                                          | Concrete work and completion boundary                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification visibility      | Confirmed source defect: [WorkspaceScreen.tsx](../../../packages/ui/src/screens/WorkspaceScreen.tsx):639–650 computes exact channel/thread visibility, then suppresses every message in the active channel whenever the document has focus. Unopened-thread mentions satisfy that suppression. | Define one displayed-message predicate incorporating exact thread, broadcast and covered mobile timeline. Test unseen thread mention, another open thread and mobile overlay. Decide focused/scrolled-history policy explicitly.                              |
| Read contract                | The earlier audit's R143-C5 remains open: workspace.ts:301–325 thread count and isMessageRead use differing criteria for nonbroadcast replies when the channel cursor is ahead.                                                                                                                | Decide channel/thread cursor semantics, align Activity/mention count/badge/mark-unread behavior and plan migration so old read mentions do not become unexpectedly unread. Preserve #128 and #148 fixes.                                                      |
| Message edit conflict        | Confirmed source gap: protocol rest.ts:222–224 accepts text only; server.ts:1708–1720 overwrites without revision check. MessageEditor.tsx:77–110 shows a realtime change banner but sends no baseline.                                                                                        | Add compare-and-set with preserved draft and explicit conflict choices. Test two devices and a change between last observation and commit. Scheduled-message conflict checks already exist.                                                                   |
| Message-link workspace scope | Mrkdwn.tsx:175–181 intercepts any HTTP message link with a locally known channel ID, without comparing workspace/address identity. Existing links test deliberately permits arbitrary aliases. Consequence is conditional on copied/shared IDs.                                                | Define trusted-alias behavior; keep LAN/public address aliases, route other workspace hosts appropriately and test restored copies sharing IDs. This is navigation correctness, not demonstrated unauthorized access.                                         |
| Durable acceptance           | #147 initiates immediate asynchronous persistence; workspace.ts:1515–1519 returns boolean and launches delivery; Composer.tsx:357–380 clears the draft.                                                                                                                                        | Characterize process death during pending desktop IPC and quota/key-store failures. Specify accepted-in-memory versus saved-on-device state and recovery. Preserve text/nonce/refusal behavior. Attachments intentionally require reattachment after restart. |
| Call failure feedback        | HuddleControls.tsx:20–29 swallows all camera/share errors as cancellation; HuddleBar.tsx:24 swallows refused audio playback.                                                                                                                                                                   | Classify permission/device/unsupported failures; allow retry and an explicit audio-play gesture. Verify browser cancellation behavior before prescribing messages.                                                                                            |
| Devices and track loss       | huddle.ts:104,400 uses default devices; no enumerateDevices/devicechange/selection support. Camera/screen handle ended at :421,469; microphone lacks an equivalent visible recovery flow.                                                                                                      | Device choice, remembered defaults, microphone test, hotplug fallback and ended handling; capability-dependent output selection. Verify USB/Bluetooth replacement on real hardware.                                                                           |
| Call recovery                | workspace.ts:478–481 leaves the huddle on socket close. huddle.ts:298–301 reduces connection state to a boolean, without ICE restart. gateway.ts:40,264,329–340 uses user seats and user-wide signal fanout.                                                                                   | Per-device participation and acknowledged join; bounded ICE recovery; visible disconnected/failed state; reconnect policy respecting leave/access loss. Test two devices on one account before advertising continuity.                                        |
| Multiworkspace attention     | App.tsx:106–110 destroys the previous client and :166–170 disconnects on leaving. Saved-workspace switcher has no background unread replica.                                                                                                                                                   | Decide need by cohort. If adopted, introduce a bounded background connection manager, badges, notification-click switching and tab/window deduplication; measure added socket/memory/CPU cost.                                                                |
| Threads                      | ThreadPanel.tsx:48–52,98–103 resets component-local scroll refs on opening. Follow exists; mute and per-thread mention counts do not.                                                                                                                                                          | Remember anchors across close/reopen and history; define mute separately from follow; preserve targeted jumps and read acknowledgment through new replies, deletion and image resize.                                                                         |
| Search/files                 | SearchDialog is messages only; Store.searchMessages uses FTS terms with newest-ID ordering. has:file checks attachment presence, without filename/file result indexing.                                                                                                                        | Permission-filtered file browser/index; filename/type/uploader/channel/date filters and message context. Relevance mode needs stable score/tie-break paging. Evaluate real multilingual queries before changing tokenizer.                                    |
| Composition                  | FormattingToolbar supports bold/italic/strike/code; Mrkdwn does not render labelled links, lists or blockquotes.                                                                                                                                                                               | Extend chosen syntax consistently with selection/IME/escaping preserved. Quote/forward with access-aware source links; optional previews require outbound guards and budgets.                                                                                 |
| Personal organization        | Sidebar has fixed channel/DM sections; Saved is a boolean/list.                                                                                                                                                                                                                                | Recoverable drafts/outbox view first; favorites/sections next; saved notes/reminders only with defined offline/timezone delivery semantics.                                                                                                                   |
| Accounts/profiles            | User has no avatar/timezone/status-expiry fields; Avatar is initials. Protocol away exists but current gateway emits online/offline. Password/session/recovery flows exist; no second factor.                                                                                                  | Demand-led avatar lifecycle, timezone, expiring status and away semantics. Internet-facing cohorts can justify TOTP/recovery codes or passkeys with complete reset/recovery workflows.                                                                        |
| Onboarding/admin             | Owner checklist exists; regular-member guidance is limited. People/API loads all users, Apps loads all apps, InviteDialog generates seven-day expiry.                                                                                                                                          | Member first-journey help, searchable/paged People/Apps, chosen invite expiry/use caps and workspace metadata policy. Do not reopen implemented owner claim/account lifecycle/invite authorization.                                                           |
| Accessibility/mobile         | Automated axe, keyboard and emulated-phone journeys exist. Actual software keyboard, physical phone, screen reader and wider-browser evidence is incomplete.                                                                                                                                   | WCAG 2.2 journeys, zoom/reflow/target spacing/focus/announcements; real iOS/Android keyboard, rotation, uploads, notifications and audio. Record failures before prescribing viewport/safe-area changes.                                                      |
| First paint                  | appearance.ts:25–31,49–61,91–96 starts dark and applies saved appearance asynchronously.                                                                                                                                                                                                       | Early persisted appearance bootstrap compatible with desktop storage; verify cold launch in light/system themes, including unreadable settings.                                                                                                               |

## Upstream patterns and Tandem experiments

### Zulip

The inspected [message_list_view.ts:526–529](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/web/src/message_list_view.ts#L526) maintains a 250-message DOM render window with a 50-message edge threshold. [Offset preservation at :1363–1388](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/web/src/message_list_view.ts#L1363) keeps the selected row's position during updates. This suggests independently measuring Tandem's DOM and data budgets while preserving its anchors and keyboard/read behavior.

Its [message_fetch.ts:91–96](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/web/src/message_fetch.ts#L91) distinguishes ordinary 100-message directional batches from a 2,000-message catch-up workload and [uses retry backoff at :496](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/web/src/message_fetch.ts#L496). These sizes belong to Zulip's architecture. Tandem should profile replay application before choosing publication/yield batches.

The [view-data cache](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/web/src/message_list_data_cache.ts#L16) limits cached views to 100 and evicts by recency while preserving its combined-view dataset. Tandem already has count eviction; useful follow-up is byte/pixel measurement. [thumbnail.ts:26–31](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/web/src/thumbnail.ts#L26) chooses among server-advertised preview formats, motivating a measured thumbnail experiment.

### Mattermost

Its [dynamic list architecture](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/webapp/channels/src/components/dynamic_virtualized_list/README.md) supports unknown variable row heights. The [size observer at :16,27–45](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/webapp/channels/src/components/dynamic_virtualized_list/list_item_size_observer.ts#L16) uses ResizeObserver for measured height changes. That mechanism matters for Tandem's image loads, wrapping and editing if virtualization is adopted.

[post_list_virtualized.tsx:29–35](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/webapp/channels/src/components/post_view/post_list_virtualized/post_list_virtualized.tsx#L29) defines directional overscan and initial slices; [its rendered list at :700–708](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/webapp/channels/src/components/post_view/post_list_virtualized/post_list_virtualized.tsx#L700) receives those budgets. Copying its constants does not establish an appropriate Tandem window size.

The [row connector at :23–35](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/webapp/channels/src/components/post_view/post_list_row/index.ts#L23) looks up an individual post by ID. [Post selectors](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/webapp/channels/src/packages/mattermost-redux/src/selectors/entities/posts.ts#L84) provide reaction/thread selector factories. Tandem can independently implement equivalent dependency narrowing using its existing Zustand selector API.

### Experiments in recommended order

Each experiment changes real behavior or cost, and includes validation tied to its risks. Establish repeated baseline results on stated hardware first; upstream implementation choices are hypotheses.

1. **Narrow message-row dependencies.**
   - Instrument row renders and React commit duration under unrelated user/profile/presence/channel updates.
   - Select relevant author, current-account fields, channel and mention lookup dependencies with stable references.
   - Preserve live edited names/mentions, role permissions and Saved state.
   - Complete when unrelated changes stop rerendering unaffected rows and measured commit cost improves without stale rendering.
2. **Measure and separate DOM/data windows if beneficial.**
   - Compare current 300-row rendering with smaller render windows or variable-height virtualization on text-, attachment- and thread-heavy fixtures.
   - Keep loaded history/cache limits independently configurable; include distant targeted links.
   - Preserve arrow navigation, focused menu/editor, screen-reader reading, unread/read acknowledgment, older/newer paging and scroll anchors after image resize.
   - Complete when stated interaction/frame/memory measures improve; reject a renderer that loses focus, context or read accuracy.
3. **Add safe derived media when decoded cost warrants it.**
   - Measure originals' compressed bytes, dimensions, decoded pixel estimates, heap/RSS and visible loading delay.
   - Prototype bounded server-generated preview sizes with format negotiation, original-download preservation and permission-aware invalidation.
   - Budget active and idle resources independently; handle corrupt/excessive-dimension inputs and animation policy.
   - Complete when an image-heavy view's memory/transfer cost falls without blurry text, decoder failures or access leaks.
4. **Profile and batch catch-up publication.**
   - Trace event parsing/reconciliation/store publication/React commits during replay and fresh resync.
   - Try bounded publication/yield batches only where work blocks interaction; preserve ordered durable/ephemeral semantics.
   - Verify membership revocation, held history requests, pending nonce reconciliation, message edits/deletion and notification catch-up rules.
   - Complete when catch-up responsiveness improves with identical final state and no duplicate sends/notifications.
5. **Tighten measured cache budgets.**
   - Retain current count LRU and protected active views.
   - Measure retained text/metadata bytes, blobs and decoded pixels over repeated channel/thread switching and long sessions.
   - Add byte/dimension ceilings only to demonstrated resource dimensions; avoid evict/refetch thrash.
   - Complete when memory stabilizes under the stated workload and navigation/preview latency remains acceptable.
6. **Fix cross-window correctness before parallelizing persistence.**
   - Implement CC-1 and CC-2 together so an atomic write cannot preserve obsolete discard/refusal state.
   - Test storage failure, strict restore, old-key migration, simultaneous accept/discard, process restart and multiple tabs/windows.
   - Complete when every accepted send survives and no intentionally removed send is resurrected.

## Adaptation and licensing boundary

This report proposes independently implemented patterns. It copies no upstream implementation. Zulip's pinned [LICENSE](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/LICENSE) declares Apache 2.0, with [NOTICE](https://github.com/zulip/zulip/blob/7a921db6dad7c71ef4c93ec7b24e229f028710a5/NOTICE). Mattermost's pinned [license policy](https://github.com/mattermost/mattermost/blob/cc0611f2ee9c8d8c012bb3631133d6d51e069068/LICENSE.txt#L14) explicitly places webapp and its subdirectories under Apache 2.0; other parts have different terms. Its dynamic-list documentation identifies a react-window fork origin. Any future source/dependency reuse must review the exact files and their third-party notices and preserve applicable attribution; Tandem's MIT license is not a substitute for those terms.

Relevant primary platform criteria are [WCAG 2.2](https://www.w3.org/TR/wcag/), [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) and [WebRTC](https://www.w3.org/TR/webrtc/). Use them to define keyboard/focus/target and media-state acceptance cases, then validate actual supported devices. No real-device performance or conformance claim is made here.
