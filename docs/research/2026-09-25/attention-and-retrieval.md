# Attention, retrieval and state contracts: follow-on research

Reviewed September 25, 2026, against checkout `3bf298f`. This extends the [earlier decision document](../../PRODUCT-RESEARCH-2026-09-25.md) and reviews the existing [state-table proposal](../../STATE-TABLES-2026-09.md). The proposal is an input, not implemented behavior. This pass combines primary documentation, research papers, source inspection and a small reproducible database experiment. It does not establish user preference or a production search failure rate.

The strongest next step is to make attention states explainable and retrieval measurable. Adding an inbox, relevance ordering or a summary button without defining what those things mean can move confusion into another screen.

## 1. Three lessons from current products

Microsoft Teams separates following threads from the controls that generate Activity entries and banners. Its documentation explicitly distinguishes following all new threads from receiving Activity notifications. That supports separate delivery and discovery concepts; it does not prove Microsoft's interface is easier to understand. [K01: Teams channel notifications](https://support.microsoft.com/en-us/teams/teams-channels/manage-channel-notifications-in-microsoft-teams)

Slack Later separates items being worked on, archived reference material and completed items, with reminders and movement back into progress. Gatherline's proposed follow-up work is therefore established functionality elsewhere. Its opportunity is a smaller, clearer personal workflow that remains useful in a casual group. Do not make a family photo someone saves acquire a task deadline or a badge to clear. [K02: Slack Later](https://slack.com/help/articles/360042650274-Save-messages-and-files-for-later)

Zulip's topic mute is more than silencing banners: it changes unread counts and some feeds, with mention exceptions. Its resolved-topic documentation explicitly permits further replies, including thanks. These are useful counterexamples to two draft assumptions: that muting should retain every unread count and that every reply must reopen a resolved discussion. Neither alternative is a universal rule. [K03: topic mute](https://zulip.com/help/mute-a-topic), [K04: resolved topics](https://zulip.com/help/resolve-a-topic)

## 2. What the draft state tables need to resolve

These are review findings, not changes to the existing draft or promises of a selected implementation.

| Draft behavior or claim                                                          | Problem to resolve                                                                                                                          | Proposed clarification and test                                                                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Followed replies interrupt at `mentions`, checked after the existing level check | Current `decideNotification` returns `level` before an unmentioned channel reply can reach that new check                                   | Compute qualifying reasons, including followed reply if enabled, before applying the level gate; then apply explicit silence and DND rules. Exercise the full truth table. |
| The four states have no side effects on one another                              | The same table makes replying follow a thread, a reply reopen a discussion, and a followed reply reopen a completed saved item              | Describe separate state dimensions with explicit transition rules. Independence of meaning does not require independence of every transition.                              |
| Any new reply reopens a resolved topic                                           | A thanks, correction of punctuation or unrelated aside can reopen completed work                                                            | Compare explicit reopening with automatic reopening in a bounded support workflow. Preserve who changed the status and why.                                                |
| Followed replies reopen completed saved items                                    | Someone else can repeatedly repopulate a personal queue the user deliberately finished                                                      | Default candidate: completion stays complete, with a separate new-replies indication. Trial automatic reopening as an explicit option.                                     |
| Muted threads remain in unread counts and mentions still interrupt               | This can be valid, but “mute” alone does not explain those effects                                                                          | Show count, feed and interruption effects together. Keep person blocking distinct from thread muting.                                                                      |
| Groups silently omit someone who cannot be added, then show a note               | The author may believe a sensitive message reached everyone selected                                                                        | Before sending, show the actual recipient list and an actionable failure for unavailable recipients. Avoid explaining that someone blocked the author.                     |
| A cancelled ring becomes a missed call for the recipient                         | An accidental short ring can create persistent unread work; replay may duplicate it                                                         | Represent cancelled, declined, expired and accepted as distinct terminal outcomes. Choose recipient history and badges deliberately.                                       |
| Missed calls are ordinary conversation messages                                  | Group-visible entries can expose a recipient's availability or generate unwanted alerts; blocked contact must not create recipient activity | Specify audience and notification policy for call history. A shared call event and a private missed-call indication need not be the same object.                           |
| Server-owned call state prevents two devices accepting                           | Ownership alone does not guarantee atomicity                                                                                                | Use a conditional transition with call identity and expiry. Test accept/accept, accept/cancel and delayed push after acceptance.                                           |
| Keep three background workspaces; poll the rest every few minutes                | Three is a proposed resource budget, not an established sweet spot; a background web page cannot guarantee polling                          | Measure desktop resource cost separately from suspended web delivery. Display stale/unknown counts honestly.                                                               |

The first finding comes from [notify.ts](../../../packages/client-core/src/notify.ts), `decideNotification`, where the `mentions` return precedes DND and the final positive reasons. Today there is no followed-thread reason. The other findings review the draft's own transitions, not demonstrated runtime defects.

Browser lifecycle documentation describes frozen tasks and discarded pages. A timer or open socket in an inactive workspace is not a substitute for background push. Preserve reading state before the browser may stop executing, and reconcile on return. This is a platform constraint; exact timing depends on browser and device. [K08: Chrome page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

### Candidate attention contract

Use this as a prototype, not an approved default:

1. Determine whether the viewer can receive this event, including membership, contact policy and session state.
2. Determine its reasons: direct message, named mention, allowed broadcast, optionally followed reply, or ordinary channel message.
3. Apply explicit person/channel/thread controls with a documented mention exception if selected. A contact block cannot be bypassed by a mention or call history entry.
4. Apply the user's chosen level and quiet period. A quiet period delays only events explicitly designed for later delivery; it does not promise that all suppressed chat will ring later.
5. Deduplicate the logical event across delivery attempts. Reconnect history should populate catch-up without replaying live-only interruptions.
6. Record a bounded explanation: why the event entered a feed and why it did or did not interrupt. Do not expose another person's private contact settings in the sender's explanation.

Decide separately whether read state is enough to dismiss a notification on a second device, whether manually marking unread re-alerts, and whether explicit self-reminders follow quiet hours. These are product decisions that need observed tasks.

### Counterevidence to “less chat means better work”

Garrett and Danziger's 2007 study analyzed 912 employed, office-working respondents from a 2006 U.S. telephone survey. IM users reported fewer interruptions and more frequent computer-mediated communication. The authors discuss IM as a way to negotiate availability. These are older, self-reported observational findings, not a causal estimate for modern group chat. They still undermine treating interruption count alone as the success metric. [K05: primary study](https://academic.oup.com/jcmc/article/13/1/23/4583029)

Measure whether someone missed an obligation, could defer a conversation comfortably, and resumed their own task. A design that lowers notifications by making helpful communication inaccessible is not a successful catch-up feature.

## 3. Retrieval: the present implementation and a measured language boundary

Source inspection found:

- [db.ts](../../../packages/server/src/db.ts) creates `messages_fts` with `fts5(text, content='messages', content_rowid='rowid')` and no explicit tokenizer.
- [store.ts](../../../packages/server/src/store.ts), `searchMessages`, quotes terms before FTS matching, applies author/channel/date/file/link filters and orders by descending message ID.
- That function permits public channels and private conversations through membership. New guest policy will require revisiting what “public” means; this is not evidence of an existing private-channel leak.
- Filenames are not indexed as separate fields in this FTS table. An attachment filter is not equivalent to filename search.

SQLite's FTS5 documentation describes the default tokenizer, BM25 relevance ordering, external-content index maintenance, and trigram substring matching. Trigram full-text queries shorter than three Unicode characters do not match; index design also changes normalization behavior. These capabilities support an experiment within the current storage architecture. They do not establish the right multilingual tokenizer or ranking for Gatherline. [K06: SQLite FTS5](https://www.sqlite.org/fts5.html)

An isolated run of [retrieval-probe.mjs](retrieval-probe.mjs) on Node `v24.16.0`, SQLite `3.53.0`, saved [these results](retrieval-probe-results.json). It used six synthetic texts and 14 text/query pairs in an in-memory database. It opened no workspace files and did not exercise the Gatherline API, permissions, throughput or an end-user task.

| Text and query                                | Default FTS5 matched? | Plain trigram FTS5 matched? | Interpretation of this fixture only                                           |
| --------------------------------------------- | --------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `The project meeting is tomorrow` / `meeting` | Yes                   | Yes                         | Full English token succeeds.                                                  |
| Same text / `meet`                            | No                    | Yes                         | Substring behavior differs from full-token behavior.                          |
| `我们明天在北京开会` / `北京`                 | No                    | No                          | A two-character substring is missed by both configurations.                   |
| Same text / `北京开会`                        | No                    | Yes                         | Longer substring is found by trigram in this case.                            |
| `日本語の会議予定です` / `会議`               | No                    | No                          | The same short-query issue occurs in this Japanese fixture.                   |
| Same text / `会議予定`                        | No                    | Yes                         | Longer substring succeeds under trigram.                                      |
| `Café résumé` / `cafe` and `resume`           | Yes                   | No                          | An unchanged switch to plain trigram loses these accent-insensitive matches.  |
| `कल दिल्ली में बैठक है` / `दिल्ली` and `बैठक` | Yes                   | Yes                         | These two Hindi cases succeed; this does not establish general Hindi quality. |

The full unspaced Chinese/Japanese strings also match under both configurations. A decomposed-accent fixture is included in the JSON. The result is narrower than “Unicode search is broken”: the current default configuration has a demonstrated segmentation boundary on these inputs, while a simple replacement creates other tradeoffs. Test meaningful queries with speakers of the pilot languages before selecting a design.

Zulip documents an English-oriented default search setup and an experimental PGroonga path for multilingual self-hosted deployments. Even an established product treats language retrieval as an operational choice. Gatherline should keep deployment simplicity in the comparison rather than adding another service before measurement. [K07: Zulip multilingual search](https://zulip.com/help/configure-multi-language-search)

### A separate diagnostic observation

While developing the fixture, a direct FTS virtual-table query combining `rowid = ?` and `MATCH ?` returned both matching rows when the row ID was bound as a JavaScript number. Binding the same value as a bigint/string or using an integer cast returned the intended row. The minimal diagnostic and output are preserved in the probe. The tokenization comparison therefore checks returned IDs in JavaScript, independently of that constraint.

This is an observed local query/binding anomaly with an unestablished cause. Gatherline's inspected search uses an outer ordinary-table `m.rowid IN (...)` predicate instead of that direct virtual-table constraint. No production access-control or corruption claim follows. Recheck this diagnostic against each release's actual embedded engine before reusing the direct query pattern.

## 4. A search evaluation that can choose an implementation

Before building semantic search, compare the existing order with lexical relevance plus filenames. Keep a newest-first option. Slack already documents result sorting, filters and searching files, so these are baseline workflow references, not novel differentiators. [K13: Slack search](https://slack.com/help/articles/202528808-Search-in-Slack)

Create a consented or synthetic fixture with known answers, including:

| Task                                                    | Correct outcome                                                   | Failure that a simple result-count metric misses                   |
| ------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Find the latest approved plan                           | Open the approved file and its decision context                   | A more recent rejected draft ranks first.                          |
| Find something by an approximate filename               | Relevant file appears even if the message body is only “attached” | Filename is absent from the searchable fields.                     |
| Find a two-character place/person term in unspaced text | Relevant permitted result is recoverable                          | A tokenizer matches the full sentence but not the remembered term. |
| Retrieve after leaving a private channel                | No inaccessible text, title, snippet, count or attachment         | A stale suggestion or preview reveals prior content.               |
| Find a quote whose source was deleted                   | The chosen deletion/attribution policy is visible                 | A derived copy silently looks like a live source.                  |
| Return from a result after reload                       | Search state and destination context are recoverable              | The correct hit exists but the navigation discards it.             |
| Search an archive after import                          | Source author/time and file accessibility remain understandable   | Import counts look right while useful links fail.                  |

Have two people independently label what answers each task, resolving disagreements explicitly. Report task completion, first useful result position, reformulations, wrong-answer confidence and retrieval time. Split by language, task type and archive size; a small pilot should report observations and sample sizes rather than a universal percentage improvement.

Ranking changes also change pagination. A descending-ID cursor is not automatically a correct cursor for relevance order. Define stable tie-breaking, what happens while messages change, whether the user is seeing a frozen result set, and how revoked access is checked on every fetch. Measure indexing overhead and result latency on realistic fixtures before adopting another storage component.

## 5. Optional AI: verify answers before selling saved time

QMSum introduces query-focused meeting summaries rather than assuming one summary meets every reader's needs. It contains 1,808 query-summary pairs over 232 meetings. This is a benchmark and task-design reference, not a current model comparison or evidence that meeting transcripts behave like Gatherline chats. Its useful implication is to test concrete questions such as what was decided and what remains unresolved. [K09: QMSum](https://aclanthology.org/2021.naacl-main.472/)

Lee and colleagues surveyed 319 knowledge workers who supplied 936 examples of AI use. Their findings connect confidence in AI with self-reported critical-thinking effort and describe verification work. This is not proof that AI causes cognitive decline or that Gatherline users will overtrust summaries. It supports measuring verification burden alongside time saved. [K10: CHI 2025 study](https://www.microsoft.com/en-us/research/publication/the-impact-of-generative-ai-on-critical-thinking-self-reported-reductions-in-cognitive-effort-and-confidence-effects-from-a-survey-of-knowledge-workers/)

If a named pilot needs summaries, start with a read-only, explicitly requested answer that cites accessible message spans and can say evidence is insufficient. Evaluate these cases before changing priority:

- A tentative proposal followed later by its rejection; the output must not call it a decision.
- Two people with the same display name; attribution must use the correct identity.
- An explicit “do not do X”; the output must preserve the negation.
- An inaccessible private reply, a revoked guest and a source deleted after indexing.
- An instruction embedded in a chat message asking the assistant to reveal other conversations or contact someone.
- A summary reopened after relevant messages were edited; freshness must be clear.

OWASP's RAG guidance calls out permission checks at retrieval time, poisoned source material and independently authorized tool actions. These are architecture requirements for the proposed feature, not evidence that existing Gatherline contains an AI vulnerability. Local inference also does not automatically solve authorization or malicious source text. [K11: OWASP RAG guidance](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html)

Compare plain catch-up, lexical search and the candidate summary using equivalent histories. Score factual correctness, attribution, omitted obligations, verification time and abstention. Human spot-checks remain necessary. Never automatically resolve a discussion, assign another person a task, or send a message solely because generated text inferred intent.

## 6. Everyday coordination should share the same semantics

Events and reminders introduce time policy even without a calendar application. RFC 5545 distinguishes floating local times, UTC times and times tied to a named zone, with recurrence rules. These concepts prevent “tomorrow” or a recurring club meeting from being reduced to a fixed duration. [K12: iCalendar specification](https://www.rfc-editor.org/info/rfc5545/)

For a first event card, specify organizer, event identity, start/end, zone, RSVP visibility, cancellation and revision. A reminder follows the current event revision, so moving a meeting does not leave the old reminder firing. Provide a bounded export only when needed; recurrence, organizer handoff and two-way calendar synchronization are separate scope. The acceptance task is whether people attend the right event at the right local time, including across a daylight-saving transition.

## 7. Decisions to carry into the next prototype

| Roadmap IDs    | Refined research recommendation                                                                                           | Evidence still needed                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| B1–B3          | Publish one attention truth table with count/feed/banner effects; completion should not silently become shared resolution | User interpretation and catch-up tasks with real histories            |
| B4             | Compare explicit reopening with automatic reopening; preserve attribution                                                 | Support/community trial including courtesy replies                    |
| B5, A9         | Add a language/query fixture before ranking work; compare filenames and lexical ordering first                            | Real query judgments, index overhead, permission and pagination tests |
| A10, D1        | Separate desktop background resources from suspended-phone delivery                                                       | Device/network matrix and resource measurements                       |
| E1a, D8        | Review actual recipients and private call outcomes; exercise concurrent terminal transitions                              | Policy prototype and foreground race tests                            |
| E4             | Model zone and event revision before reminders                                                                            | Cross-zone rescheduling task                                          |
| Conditional AI | Require demonstrable value beyond plain search/catch-up, with readable sources                                            | Controlled answer-quality and verification-time evaluation            |

## Source register

All external sources below were accessed September 25, 2026. “Not established” means a publication/update date was not verified; it does not mean the document was published today. IDs are local to this follow-on memo. Source counts are not independent observations. Product documentation establishes published behavior, not comparative usability.

| ID  | Source / responsible party                                                                                                                                                                                                                                      | Evidence type                                        | Publication date                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| K01 | [Channel notifications](https://support.microsoft.com/en-us/teams/teams-channels/manage-channel-notifications-in-microsoft-teams) — Microsoft                                                                                                                   | Official product documentation                       | Not established                       |
| K02 | [Save messages and files for later](https://slack.com/help/articles/360042650274-Save-messages-and-files-for-later) — Slack                                                                                                                                     | Official product documentation                       | Not established                       |
| K03 | [Mute or unmute a topic](https://zulip.com/help/mute-a-topic) — Zulip                                                                                                                                                                                           | Official product documentation                       | Not established                       |
| K04 | [Resolve a topic](https://zulip.com/help/resolve-a-topic) — Zulip                                                                                                                                                                                               | Official product documentation                       | Not established                       |
| K05 | [IM and interruption management](https://academic.oup.com/jcmc/article/13/1/23/4583029) — R. Kelly Garrett and James N. Danziger                                                                                                                                | Primary empirical study; observational self-report   | 2007-10-01; data collected 2006       |
| K06 | [FTS5 extension](https://www.sqlite.org/fts5.html) — SQLite maintainers                                                                                                                                                                                         | Official technical documentation                     | Living document; date not established |
| K07 | [Configure multi-language search](https://zulip.com/help/configure-multi-language-search) — Zulip                                                                                                                                                               | Official product documentation                       | Not established                       |
| K08 | [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) — Chrome for Developers                                                                                                                                                 | Browser-vendor technical documentation               | Living document; date not established |
| K09 | [QMSum](https://aclanthology.org/2021.naacl-main.472/) — Ming Zhong et al.                                                                                                                                                                                      | Primary benchmark research                           | 2021, NAACL                           |
| K10 | [AI and critical thinking](https://www.microsoft.com/en-us/research/publication/the-impact-of-generative-ai-on-critical-thinking-self-reported-reductions-in-cognitive-effort-and-confidence-effects-from-a-survey-of-knowledge-workers/) — Hao-Ping Lee et al. | Primary empirical study; self-report survey          | 2025-04, CHI                          |
| K11 | [RAG security guidance](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html) — OWASP                                                                                                                                                   | Technical guidance; not an incident-prevalence study | Living document; date not established |
| K12 | [RFC 5545](https://www.rfc-editor.org/info/rfc5545/) — IETF / Bernard Desruisseaux, editor                                                                                                                                                                      | Standards-track specification                        | 2009-09                               |
| K13 | [Search in Slack](https://slack.com/help/articles/202528808-Search-in-Slack) — Slack                                                                                                                                                                            | Official product documentation                       | Not established                       |

The potentially relevant Slacktivity paper was excluded from substantive claims because its available OpenReview PDF route returned a browser-verification page. Search snippets were insufficient to establish its sample and methods. No participants were contacted. The synthetic probe and static source review are new work; the earlier browser-suite results were not rerun for this memo.
