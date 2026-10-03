# Browser storage fallback investigation — 2026-10-03

Reviewed **`cd3af584ba46adace45465cb5e5c66afb238b01c`**, after the requested remote pull. This is an adjacent failure in the new F01 storage implementation and its interaction with F02. The previous corruption-read and ordinary acknowledged-write repairs are present; this report does not reclassify their original reproductions as unfixed.

## Observed failures

Four diagnostic tests exercise production `deviceStore`, `webPlatform` and the notification preference hook. Their assertions intentionally establish current undesirable behavior. [Harness](root-storage.dom.test.tsx), [configuration](root-storage.config.mts), [observations](root-storage-evidence.json).

1. Save `none` into IndexedDB and verify it is acknowledged. The legacy localStorage key is absent. Make a subsequent database open fail. The new platform falls back to localStorage, reads an absent preference, reports no read error and selects **`full`**. Its notification formatter includes the synthetic sender, channel and message words.
2. Save a draft into IndexedDB. During an open failure, acknowledge a new draft through the fallback backend. Restore database opening. The next client reads the **old IndexedDB draft** and removes the fallback key containing the newer acknowledged words.
3. Leave IndexedDB readable but remove BroadcastChannel capability. Production code chooses localStorage without attempting to read the existing database.
4. Hold an actual version-1 database connection containing a private preference. Production requests its version-2 upgrade; the real `blocked` event causes fallback to empty localStorage. No production function is mocked in this case. The database implementation is fake-indexeddb, so this is an actual API event/transaction control rather than a real browser upgrade journey.

The same privacy outcome was verified using the fresh production web bundle in the T3 collaborative browser. The main application saved **Nothing about it**. A second, same-origin disposable frame loaded that bundle with `indexedDB.open` deliberately failing in its own realm; it selected **The message**, with no read warning. The synthetic saved sign-in was copied into legacy storage to isolate preference behavior. Without that copy, fallback also makes the saved sign-in appear absent. [Browser observations](root-browser-storage.json).

This browser check uses a controlled open failure and a child frame, not an unmodified whole-page reload or an observed spontaneous browser failure. It proves the production UI/setting consequence under that fault. No actual operating-system notification was sent or captured. Snapshot attempts failed in the preview client; DOM inspection and UI interaction provided the evidence, and no screenshot is claimed. The fixture, synthetic origin storage and server were removed afterward.

## Cause and recommendation

[deviceStore.ts:350](../../../packages/ui/src/lib/deviceStore.ts#L350) makes IndexedDB use depend on BroadcastChannel; [deviceStore.ts:355](../../../packages/ui/src/lib/deviceStore.ts#L355) treats any database opening error as permission to switch to localStorage. That backend has no indication that its missing keys belong to an existing, unavailable database. The notification's strict read therefore succeeds with `null`, and [notificationPreview.ts:195](../../../packages/ui/src/lib/notificationPreview.ts#L195) applies the first-use full-preview default.

On recovery, [deviceStore.ts:255](../../../packages/ui/src/lib/deviceStore.ts#L255) gives an existing database value unconditional priority over the fallback key. The completed transaction removes that key at [deviceStore.ts:225](../../../packages/ui/src/lib/deviceStore.ts#L225), erasing the acknowledged fallback draft rather than preserving or reconciling it.

**P1, M/L:** establish durable ownership of the chosen backend and an explicit recovery/migration policy. An unavailable existing store must remain distinguishable from a first-use empty store. Keep privacy restrictive and provide retry guidance while its value is unknown. Preserve fallback operations with enough identity/base information to reconcile them transactionally on recovery; never silently delete acknowledged alternative work. Use IndexedDB for ownership even when cross-window notification needs a different transport.

The standard explicitly treats blocked upgrades as waiting for other database connections; they are not evidence of an empty database. See [IndexedDB opening algorithm](https://w3c.github.io/IndexedDB/#opening). The recommendation to preserve unreadability and ownership is an inference from that API contract and the observed application behavior.

**Acceptance:** prime real persisted sign-ins, drafts, outbox and private preferences; test opening error/timeout, an upgrade held by an older tab, missing BroadcastChannel and simultaneous mixed-backend windows. On retry/restart, every acknowledged version must remain recoverable and sends deduplicated. Private settings cannot become full because the owner cannot be read. Fresh profiles must still start normally, and any intentionally supported fallback must have an explicit reconciliation contract.

## Reproduce

```powershell
pnpm --filter @slackoss/ui exec vitest run --config ../../docs/research/2026-10-03/root-storage.config.mts
```

All four tests pass by reproducing their stated failure/control. Only their owned evidence JSON is written; they use a fresh in-memory IndexedDB factory and isolated jsdom storage per case. No product file or previous evidence is changed.
