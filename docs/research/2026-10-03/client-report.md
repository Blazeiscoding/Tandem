# Client review — 2026-10-03

Reviewed revision: **`cd3af584ba46adace45465cb5e5c66afb238b01c`**, after pulling the F01–F15 implementation. This review found three additional client work packages and two remaining attachment boundaries. It changed only its new research files. Application source, existing tests, previous research and `.audit-client-143/data` were untouched.

**Eleven fresh diagnostic/control tests pass: seven Node tests and four DOM tests.** Diagnostics deliberately assert the undesirable current behavior; passing is evidence of the problem, not a fix. [Session evidence](client-state-evidence.json), [attachment evidence](client-files-evidence.json), [UI and real-app evidence](client-ui-evidence.json).

## C01 — P1 · Microphone privacy · S/M: a mute chosen during recovery is undone

Start an unmuted call, hold the asynchronous replacement-microphone result, press Mute, then let capture resolve. The real `HuddleSession` reports muted during the wait, but afterward sets the replacement track **enabled**, attaches it to the microphone sender and broadcasts **`muted: false`**. The new microphone starts unmuted despite the more recent explicit mute.

The replacement samples mute once at [huddle.ts:153](../../../packages/client-core/src/huddle.ts#L153), before the capture await at [huddle.ts:163](../../../packages/client-core/src/huddle.ts#L163). Adoption at [huddle.ts:169](../../../packages/client-core/src/huddle.ts#L169) reapplies that old value; the intervening [toggleMic:261](../../../packages/client-core/src/huddle.ts#L261) affects only the old track. [HuddleControls.tsx:65](../../../packages/ui/src/components/HuddleControls.tsx#L65) keeps Mute available during recovery, so this is an interaction the UI permits.

Controls hold: replacement of an already-muted microphone stays muted, and leaving during acquisition stops the returned microphone. This narrows the bug to mute changes made while replacement is pending, rather than all recovery or terminal cleanup.

**Fix:** keep the person's desired mute state independently of whichever track currently exists. Apply the latest intent when adopting and attaching every new microphone. Preserve the recovery deduplication and destruction checks.

**Acceptance:** delay successful/failed recovery, toggle mute in both directions and repeatedly, and assert the final track, UI and peer announcement match the latest intent. In a real browser/device call, verify no audio is sent after the user mutes while device replacement is pending. Keep the pre-muted and leave-during-capture controls.

**Limit:** this probe uses production session logic with synthetic tracks, capture and peer connections. It proves an enabled track is handed to the sender and an unmuted signal is emitted; it does not record transmitted audio, model a physical unplug event or establish natural occurrence frequency.

## C02 — P1 · Microphone privacy · S: joining can ignore the saved microphone-off choice

Hold a valid saved `{ joinMuted: true }` preference read. The actual `HuddleButton` remains enabled, and clicking Start a huddle calls `joinHuddle` with **`muted: false`**. Resolve the read; the next click correctly passes **`muted: true`**. This needs only a delayed successful read, not corruption or a failed storage backend.

The preference initializes to `joinMuted: false, loaded: false` at [callPreferences.ts:20](../../../packages/ui/src/lib/callPreferences.ts#L20), then resolves asynchronously at [callPreferences.ts:38](../../../packages/ui/src/lib/callPreferences.ts#L38). [HuddleBar.tsx:159](../../../packages/ui/src/components/HuddleBar.tsx#L159) consumes `joinMuted` without waiting for `loaded`. The Getting started join path at [WorkspaceScreen.tsx:861](../../../packages/ui/src/screens/WorkspaceScreen.tsx#L861) has the same source-level dependency; only the header button was independently exercised here. [HuddleSession.startLocalAudio:122](../../../packages/client-core/src/huddle.ts#L122) applies the passed mute value to the acquired track.

**Fix:** route all joins through one preference-aware boundary that waits for acknowledged initialization, or safely joins muted until the preference is known. Provide a usable state if loading fails instead of guessing the saved microphone-off choice. Keep account/device scope explicit.

**Acceptance:** delay the storage read and join immediately through header and Getting started; a saved microphone-off choice must never yield an enabled local track. Cover rejection, malformed preferences, retry, a deliberately stored microphone-on choice and changed workspace navigation. Verify actual startup capture in a browser and desktop app.

**Limit:** the DOM test observes the real component's call to a controlled `joinHuddle`; it does not acquire a microphone. The production session's adoption logic explains the consequence. This is separate from the root review's new IndexedDB fallback finding: the read in this test succeeds with the correct stored choice.

## C03 — P2 · Integration privacy and lifecycle · M: separate each app form's ownership

**Actual two-app callback reproduction:** register two separate apps on a disposable real workspace, verify their interactivity endpoints, issue valid action triggers and open app A's form over WebSocket. Type synthetic private words into the production `ViewModal`. Invoke a valid app B action for the same account, then open its second form. B's form displays A's words. Explicitly pressing B's Submit sends those exact words through the real authenticated view-submission endpoint to **app B's actual callback**, with B's view ID and callback ID.

The same-account second action is a required prerequisite, such as someone invoking another app in a second window/device while the first form is open. No unauthorized trigger, unsolicited arbitrary-app modal, automatic submit or silent exfiltration was demonstrated. The inherited words are visible before the user submits them.

Two focused completion diagnostics establish the adjacent lifecycle problem:

- Submit A, close it, open B, then complete A successfully: production `submitModal` clears **B**.
- Submit A, close it, open B, then return A's field refusal: B inherits A's busy state before completion and displays A's rejection afterward.

`ViewModal` owns one long-lived `values/errors/busy` state at [ViewModal.tsx:18](../../../packages/ui/src/components/ViewModal.tsx#L18), indexed only by block/action at [ViewModal.tsx:36](../../../packages/ui/src/components/ViewModal.tsx#L36). A new `view.open` directly replaces the view at [workspace.ts:1512](../../../packages/client-core/src/workspace.ts#L1512), without giving the form state a new identity. After its awaited request, [workspace.ts:1556](../../../packages/client-core/src/workspace.ts#L1556) closes whichever modal is current; [ViewModal.tsx:58](../../../packages/ui/src/components/ViewModal.tsx#L58) similarly installs an old result into current component state.

**Fix:** give each view ID an independent form instance/lifetime, clear or explicitly preserve state only for that view, and guard dismissals/results by the submitted view ID. Decide whether a second form should replace, queue or be refused, with clear behavior for unsaved input. Ensure old requests cannot clear, fill, block or attach errors to a different app's form.

**Acceptance:** two real apps with identical field IDs retain separate values and callback destinations. After cancel/replacement, old success, refusal and network failure cannot change B's fields, error, focus, busy state or visibility. Cover successive forms from the same app and server invalidation while a form is open; retain trigger/account/permission checks.

**Limits:** the cross-app journey uses actual production server, HTTP, SQLite, WebSocket, trigger checks, React component and callback delivery, all with disposable synthetic identities. Rendering is in jsdom, so no real browser layout/focus geometry is claimed. Old-completion cases control the REST response directly to isolate ownership; their stale-result outcome was not separately reproduced with a delayed real third-party endpoint.

## C04 — P2 · F07 residual · S/M: retention still retains attachment bytes

The F07 implementation fixes ordinary deleted-message invalidation when the attachment's owner was known. Our real HTTP/socket control loads a timeline and file, deletes the message, and confirms both cache entry removal and blob revocation. The new source also independently indexes channel/message ownership and subscribes active previews to invalidation.

**Remaining ordinary lifecycle:** load a real attachment through its timeline, then age the synthetic fixture's message and call the production retention sweep. One message is removed, its `history.removed` event arrives and it disappears from the client timeline. Fresh authenticated file GET returns **404**. The old cache URL is nevertheless still returned and its synthetic bytes remain readable. The handler at [workspace.ts:1166](../../../packages/client-core/src/workspace.ts#L1166) removes history without invalidating affected resources; the new invalidation is only in the separate `message.deleted` branch at [workspace.ts:1196](../../../packages/client-core/src/workspace.ts#L1196).

**Narrower API boundary:** search returns a real message and attachment without loading a timeline. Calling the public `client.files.get` for it creates a cache entry with no owner. Delete the message through actual HTTP and receive the event; fresh GET returns 404 but the cached bytes remain. [fileOwner:701](../../../packages/client-core/src/workspace.ts#L701) examines only timelines/threads/pages, and [invalidateMessage:185](../../../packages/client-core/src/fileCache.ts#L185) skips unknown owners. Unknown entries are purged on channel invalidation, which is a useful separate control in the implementation.

Current Search, Activity and saved/pinned list UIs render names/counts and jump to a loaded conversation; they do not directly render the attachment preview. Consequently, the search reproduction establishes the public client API boundary, **not a demonstrated current search-preview UI route**. The retention reproduction already has a known owner and does not depend on this limitation.

**Fix:** invalidate retained files on whole-thread retention, including reply attachments and files whose history has been evicted. Store the bounded ownership needed by that event independently of the history window, or choose a conservative channel revalidation policy. For direct file API use, carry ownership from the message/file consumer or deliberately invalidate unknown entries when a message in their possible channel disappears.

**Acceptance:** real retention removes root/reply attachments from cache and notifies an open lightbox; fresh refetch shows unavailable. Repeat after actual history eviction and while a transfer is held. Other authorized files remain shared. Cover files acquired without timeline history and unknown-owner deletion under the documented public API contract.

**Limits:** these are stale already-downloaded local bytes, not a server authorization bypass, and bytes previously seen cannot be retroactively unrevealed. The retention age adjustment touches only the disposable fixture database; the actual maintenance and publication are production methods. No retention-triggered visible lightbox journey was run, and no new performance claim is made.

## Reproduction and scope

Run from the repository root:

```powershell
pnpm --filter @slackoss/client-core exec vitest run --config ../../docs/research/2026-10-03/client-node.config.mts
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-03/client-ui.config.mts
```

The suites write only their three owned evidence JSON files. [Node session harness](client-state.test.ts), [real attachment harness](client-files.test.ts), [UI/two-app harness](client-ui.dom.test.tsx). Every disk-backed workspace gets its own generated OS-temp directory; cleanup verifies the absolute directory's parent and ownership prefix before deletion. All three are removed and recorded. The modal workspace is in-memory and both its server and callback server are stopped.

Root-owned baseline tests/build/browser journeys remain separate evidence. This review inspected the new client file cache/ownership and equivalent-newer-load implementation and the changed UI storage/composer paths; it does not restate the previous F01/F02/F14 findings as new failures. The root independently owns the new IndexedDB fallback investigation. Genuine independent-browser storage transactions, native process-death preservation, screen readers, physical calls and real geometry remain broader acceptance boundaries.
