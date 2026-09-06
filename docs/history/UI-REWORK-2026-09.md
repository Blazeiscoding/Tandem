> **Historical artifact — not a description of this codebase.**
>
> This handoff describes a UI rework that is not present in this checkout.
> Verified against the source on September 6, 2026, the following claims below
> do not hold here: the Workbench theme, bundled IBM Plex fonts, the toast and
> confirmation providers, the emoji picker, formatting controls, and
> unread-mention counts are all absent, and the UI has 16 tests rather than the
> 36 this document reports. In the other direction, it lists upload progress as
> missing when `PendingAttachments` already had it.
>
> It is kept because its intent is worth reading before anyone redesigns these
> surfaces again — not as a record of what shipped. Reconcile any part of it
> against the source before building on it. Current status lives in
> [`../IMPROVEMENT-PLAN-2026-09.md`](../IMPROVEMENT-PLAN-2026-09.md).

# UI rework — September 2026

Handoff notes for whoever picks this up next. Everything below is in the
working tree and **uncommitted**; nothing has been pushed.

The whole change is confined to presentation plus one small piece of client
state. No server, protocol, or storage changes.

---

## 1. What happened, in order

The session started as "improve the UI" and went through three rounds:

1. **A structural pass** on the existing navy-and-mint theme — replacing emoji
   affordances with drawn icons, collapsing the sidebar footer into a menu,
   slimming the header. That work survived.
2. **A rejected palette.** The navy-and-mint theme was rejected as "too plain,
   no character". Four visual directions were drawn as working specimens; the
   one picked was **Workbench**, and the theme was rebuilt around it.
3. **Feature and polish rounds** — motion, a markdown toolbar, and the product
   furniture a chat app is expected to have.

---

## 2. The theme: "Workbench"

`packages/ui/src/theme.css` is the single source of truth and carries the
reasoning in its header comment. The short version:

The app's premise is that you can point at the machine it runs on, so the
interface is built like a piece of equipment rather than a consumer chat
product.

|               |                                                                             |
| ------------- | --------------------------------------------------------------------------- |
| Ground        | Warm near-black — `#0f0f0e` rail, `#151412` timeline, `#1c1b18` panels      |
| Accent (live) | Amber `#e0a13c` — unread, active, present, addressed to you, primary action |
| Accent (echo) | Cyan `#6fbfc7` — what the machine repeats back: code, links, channel refs   |
| Type          | IBM Plex Mono for machine facts, IBM Plex Sans for message prose            |
| Corners       | 2px, via a remapped Tailwind radius scale                                   |

**Two rules worth not breaking:**

- **Nothing decorative may use amber or cyan.** They carry meaning. If you need
  another colour for a non-state purpose, use an ink weight.
- **Mono is for machine facts only** — handles, channels, timestamps, counts,
  addresses, invite codes. Prose is never mono.

### Fonts are bundled, not fetched

`@fontsource/ibm-plex-{sans,mono}` are dependencies of `@slackoss/ui`,
`@slackoss/web` and `@slackoss/desktop`, imported from each app's `index.css`.
This is deliberate: a workspace on a laptop on a LAN with no internet has to
render identically to one on a VPS, and it should not be making requests to
Google. **Do not replace these with a `<link>` to Google Fonts.**

### Desktop chrome follows the ramp

`apps/desktop/src/main/index.ts` sets `backgroundColor` to the timeline tone
and the `titleBarOverlay` to the rail tone at **height 32**. Both `JoinScreen`
and `WorkspaceScreen` reserve exactly `h-8`. If you change one, change all
three or the window controls will overlap the app.

---

## 3. Two behavioural changes (most likely to be argued with)

Both are single-function reverts if you disagree.

- **People are named by handle inline** — `mira`, not `Mira Chandrasekar` — in
  bylines, mentions, DM rows and the mention picker. Display names still front
  the surfaces that are _about_ a person: profile, member list, people admin.
  One function decides: `personLabel` in `packages/ui/src/lib/format.ts`.
- **Timestamps are 24-hour with seconds** (`02:01:14`). `formatTime`, same file.

---

## 4. New modules

| File                           | What it is                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `lib/markdown.ts`              | Pure `(text, start, end) → {text, start, end}` transforms for the formatting controls. 22 unit tests.  |
| `lib/useMarkdownControls.ts`   | Shared hook: transforms + shortcuts + caret restore. Used by both the composer and the message editor. |
| `lib/hoverProps.ts`            | `chain()` — composes a handler onto a cloned child's existing one.                                     |
| `components/FormattingBar.tsx` | The nine formatting controls.                                                                          |
| `components/EmojiPicker.tsx`   | Curated (~110), keyword-searchable, offline.                                                           |
| `components/Tooltip.tsx`       | Styled tooltip that also teaches the shortcut.                                                         |
| `components/Toast.tsx`         | `useToast()` — `done(text, undo?)` / `fail(text)`.                                                     |
| `components/Confirm.tsx`       | `useConfirm()` — promise-based, replaces `window.confirm`.                                             |
| `components/ContextMenu.tsx`   | Right-click menu, measured and clamped to the viewport.                                                |
| `components/PersonCard.tsx`    | `PersonHover` — profile card on the byline and avatar.                                                 |

`ToastProvider` and `ConfirmProvider` are mounted in `App.tsx`. Anything using
`useToast` or `useConfirm` must be under them.

### Markdown support was extended

`Mrkdwn.tsx` now does line-level parsing on top of the existing inline rules:
blockquotes (`> `), bulleted lists (`- `/`• `), numbered lists (`1. `), and
Slack's `<url|label>` links. Consecutive lines of the same kind group into one
block. **The toolbar and the renderer must stay in step** — a button that emits
syntax the renderer ignores is worse than no button.

---

## 5. Motion

Defined once in `theme.css` under the Motion heading. The rule: _equipment
moves mechanically_ — 90/150/200ms, one shared ease, no overshoot, nothing
travels more than ~5px. Amber is the only thing that pulses, because a pulse
reports a condition rather than answering a click.

`prefers-reduced-motion` is handled properly rather than with a blanket
duration cut: the four infinite loops (`live-pulse`, `prompt-blink`,
`typing-dot`, `shimmer`) are switched **off and held visible**, because
shortening a loop to `0.01ms` freezes a dot mid-fade.

Live message arrivals animate; opening a channel does not. `MessageTimeline`
keeps a set of ids already on screen so a channel switch doesn't flutter fifty
rows.

---

## 6. Client-core change

One addition to `WorkspaceState`:

```ts
/** channelId -> unread messages that address this person. */
unreadMentions: Record<ID, number>;
```

Incremented in the `message.created` handler when `addressesMe(text, selfId)`
and the message is newer than `memberships[channelId]`; zeroed in `markRead`.
`addressesMe` is the single definition of "speaks to me" (direct `<@id>` or a
room-wide mention) — keep the badge and the notification rules using it so they
cannot drift.

Drives the sidebar mention badge. A **muted** channel with a mention keeps its
weight rather than going grey: muting means "don't ring", not "doesn't concern
me".

---

## 7. Bugs found and fixed along the way

Recording these because several were latent before this session:

1. **Caret race.** Restoring the selection in a `requestAnimationFrame` runs
   after the browser has delivered the next keystrokes, so typing right after a
   toolbar click scrambled the word (`next` → `xtne`). Now a layout effect.
2. **`display: contents` receives no pointer events.** `Tooltip` and
   `PersonHover` both wrapped their child in such a span, so neither ever
   opened. Both now use `cloneElement` to attach handlers to the child itself.
   _The tooltips were shipped broken earlier in the session and only found when
   the hover card failed the same way._
3. **Context menu closed on any scroll**, including the scroll that brought the
   row into view and any momentum still settling. The scroll listener is armed
   one frame late.
4. **`toggleLineStyle` on an empty line did nothing** — an all-blank selection
   counted as "already a list", so it stripped instead of applying.
5. **…and then left the inserted `1. ` selected**, so the next keystroke
   replaced it. A collapsed caret now stays collapsed.
6. **`Ctrl+K` collision.** Link would have shadowed the global quick switcher,
   and since a text field holds focus almost always, the switcher would have
   become unreachable. Link is `Ctrl+Shift+U` (Slack's own choice), and
   consumed combos call `stopPropagation`.
7. **Reaction picker clipped** by the hover rail's `overflow-x-auto`. It now
   hangs off the row and flips up when the message is low on screen.
8. **Copy-link reported success when the clipboard write was refused.**
9. **Side panels were on the rail tone** instead of the raised tone, inverting
   the elevation model — a substring match in a bulk find-and-replace ate the
   more specific rule.
10. **Hover rail stacking.** It hangs above its row's top edge over the previous
    message; a message arriving just below (whose entrance transform creates a
    stacking context) could paint over it.

---

## 8. Tests

- `packages/ui` — 36 tests (`markdown`, `mrkdwn`, `deeplink`)
- `packages/client-core` — 42 tests
- `packages/server` — 75 tests
- e2e — 6/6 (`npx playwright test`)

**Three test files were edited, each for a real behaviour change, not to make
red go green:**

- `mrkdwn.test.tsx` — mentions now render as `@alice`; the test asserts the
  handle _and_ asserts the display name is absent, so the intent is pinned.
- `web.spec.ts` — `getByTitle("Reply in thread")` no longer matches now that
  the rail uses real tooltips; it asserts on the accessible name. The People
  admin is reached via the sidebar settings menu.
- `notify.test.ts` — fixture gains `unreadMentions: {}`.

### The e2e suite earned its keep

Refactoring the composer onto the shared hook, a string-index slice deleted
more than intended. Typecheck caught the helper functions. It did **not** catch
the three deleted draft-lifecycle effects — that broke draft persistence
silently, and only the e2e test found it. Run the full suite after touching
`Composer.tsx`.

---

## 9. Running it

```bash
pnpm --filter @slackoss/web dev --port 5199        # UI, hot-reloaded
node apps/server-cli/dist/slackoss-server.js \
  --data <dir> --port 18544 --host 127.0.0.1 --no-mdns --name Northwind
```

Then connect to `127.0.0.1:18544` from the web client.

`pnpm --filter slackoss-server build` bundles the **already-built** web client,
so run `pnpm --filter @slackoss/web build` first or you will test a stale UI.
This wasted a full e2e cycle during the session.

The e2e suite uses port **18543** — do not leave a demo server on it.

---

## 10. Known gaps

Deliberately not done, roughly in order of value:

- Keyboard navigation of the message list (arrow keys between messages).
- Link unfurls / previews.
- Channel member list in a side panel rather than only in the details dialog.
- Search: no term highlighting in results, no recent searches.
- Upload progress for attachments (the pending row shows only "sending…").
- `Attachments.tsx` still uses emoji as file-type badges. Left alone as content
  markers rather than affordances, but they are the last emoji in the chrome.
- No light theme. Two of the four rejected directions needed one; if that ever
  comes back, every surface, border and state token needs a second value.
