# Gatherline: deeper research and revised product direction

**Research period: September 24–25, 2026. Audience: friends, families, communities, students, teams and organizations.**

Gatherline's next step should be **dependable everyday communication that ordinary people can join and someone can confidently operate**. A larger feature catalogue alone will not establish that. The strongest near-term investments connect the features already present: invitation → first conversation → reliable return → useful retrieval → recovery when a device or host changes.

This is the decision document. The [revised delivery roadmap](PRODUCT-ROADMAP-2026-09-24.md) contains backlog IDs, acceptance criteria and sequencing. The [product audit](PRODUCT-AUDIT-2026-09-24.md) records inspected code, the browser walkthrough and screenshots. Supporting studies cover [workplace workflows](research/2026-09-24/workplace-research.md), [personal/community use](research/2026-09-24/community-research.md) and [hosting/operations](research/2026-09-24/operations-research.md). The [source register](research/2026-09-24/SOURCE-REGISTER.md) records provenance and limitations for the deeper review.

## 1. What this research establishes

The review combines current Gatherline source, a seeded local browser walkthrough, primary competitor documentation, public first-hand discussions, maintainer issue threads and research on attention and voice communication. The deeper source register contains **80 topic entries across 78 distinct URLs**, including 15 first-hand discussions/issues, four empirical studies and a separate research/design position. Those URLs are not independent observations; several share a vendor or policy. The review compares complete tasks across workplace, social and self-hosted products. Sources were selected for relevance and counterexamples, rather than agreement with a proposed feature.

Four evidence levels must stay separate:

| Evidence                                | What it supports                                               | What it cannot establish                                          |
| --------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Gatherline runtime observation          | A particular flow worked or failed in the reviewed environment | Every device, network, release or workload behaves the same       |
| Gatherline source inspection            | A code path, supported contract or absent inspected mechanism  | Frequency of failures or whether users find it confusing          |
| Official external documentation         | Published product behavior, limits and design choices          | Independent reliability, usability or superiority                 |
| First-hand reports and research studies | Concrete problems, counterarguments and hypotheses             | Representative market demand or guaranteed benefit for Gatherline |

The first pass actually exercised sign-in, conversations, replies, attachments, search, attention views, people, invitations, apps, account/device settings and single-person huddle controls. It reproduced navigation losing the selected channel after reload. `pnpm build` passed with cache hits, and the existing browser suite passed **12 scenarios in 38.6 seconds**. Those are September 24 results, not additional tests from this document-only research pass.

No competitor hands-on benchmark, user interviews, real-phone trials, WAN call evaluation, fresh packaged-desktop test or production-scale assessment was performed. The research therefore supports prioritization and test design; it does not establish product-market fit. Public complaints are self-selected, sometimes promotional and sometimes corrected by other participants. Older reports were checked against newer documentation where material.

## 2. What changes from the first plan

| Earlier emphasis                                 | Revision                                                                                                                | Why                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Improve the core, then broaden mobile delivery   | Decide stable reachability and phone delivery immediately; deliver them before a phone-led pilot depends on the product | A participant who cannot return or receive a message cannot benefit from better catch-up |
| Treat blocking/reporting as a community package  | Separate personal contact controls from moderator tooling; bring DM consent and blocking forward                        | Private groups also need control over who contacts them                                  |
| Improve existing huddles                         | Add a separately scoped direct-call invitation lifecycle                                                                | Starting a room and calling a person are different promises                              |
| Expand Activity, Saved and notification settings | Define unread, follow-up and interruption states together first                                                         | Extra surfaces can increase uncertainty and create another queue to clear                |
| Add titles and resolved threads                  | Keep quote replies lightweight; prototype conversation repair after routing works                                       | Casual replies should stay easy; useful structure often emerges later                    |
| Make backups accessible                          | Include deployment settings, compatibility and isolated restoration                                                     | Restored data must be usable without accidentally sending scheduled work twice           |
| Native export and import after general polish    | Make portability a gate for history-sensitive adoption; rehearse coexistence                                            | Teams may depend on old files, partners and automations more than on a new interface     |
| “For everyone” through a wide backlog            | Use a universal core with reversible presets and different cohort gates                                                 | Families, public communities and organizations have conflicting defaults                 |

The revised roadmap incorporates these changes. They supersede the initial sequence; they are not extra work added to an unchanged twelve-week promise.

## 3. Competitive lessons worth borrowing

These are documented workflow references, not an overall quality ranking. The linked memos carry fuller counterevidence and source IDs.

| Product or family        | Useful lesson                                                                                    | Boundary for Gatherline                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack                    | Later, search, thread subscriptions and Lists already cover many proposed ideas                  | Better follow-through is parity until task trials show a meaningful advantage. [Workplace W01–W07](research/2026-09-24/workplace-research.md)                                                                          |
| Microsoft Teams          | Following a conversation and receiving an interruption are separate policies                     | Clear state explanations matter as much as an inbox. Cross-organization access has administrative dependencies. [W08–W09, W14](research/2026-09-24/workplace-research.md)                                              |
| Zulip                    | Conversations can be reorganized after they diverge, with continuity for links and subscriptions | Start with same-channel repair; prevent accidental visibility expansion. [W12](research/2026-09-24/workplace-research.md)                                                                                              |
| Twist                    | Read and done can be independent                                                                 | An optional personal workflow should not turn every social conversation into work. Its development-hiatus notice also limits momentum claims. [W10–W11](research/2026-09-24/workplace-research.md)                     |
| Basecamp                 | A bounded recurring question can replace coordination work                                       | Trial one recipe with pause/end controls before a workflow builder. [W16](research/2026-09-24/workplace-research.md)                                                                                                   |
| Campfire                 | Guided self-hosting and phone access are existing competitive expectations                       | Free/self-hosted alone is weak differentiation; compare onboarding, recovery and migration. [W17–W18](research/2026-09-24/workplace-research.md)                                                                       |
| Pumble                   | Free hosted alternatives can retain extensive history                                            | Compare whole ownership and switching costs, not Slack's free limit alone. [W19](research/2026-09-24/workplace-research.md)                                                                                            |
| Discord                  | Interest-based onboarding, discussion views and personal boundaries support communities          | Avoid channel/role confusion and unnecessary setup for a small group. [Community C01–C05](research/2026-09-24/community-research.md)                                                                                   |
| Discourse                | A useful chat can become a durable discussion                                                    | Preserve attribution and destination access; a transcript dump is not always an answer. [C06–C07](research/2026-09-24/community-research.md)                                                                           |
| Signal                   | Identity disclosure, discoverability and contact permission are distinct decisions               | Explain server-local accounts and invite context without requiring phone-number identity. [C08–C09](research/2026-09-24/community-research.md)                                                                         |
| WhatsApp                 | Polls, events and findable shared media solve routine group coordination                         | These can matter more than elaborate task management for families and clubs. [C10–C11](research/2026-09-24/community-research.md)                                                                                      |
| Telegram                 | Shared media, broadcast modes and multi-device continuity aid everyday use                       | Describe confidentiality accurately; cloud chat and E2EE are different models. [C12](research/2026-09-24/community-research.md)                                                                                        |
| Matrix / Element         | Cross-server relationships and encrypted history require identity and recovery design            | Federation and E2EE are separate projects with participant-facing consequences. [C13–C14, C18](research/2026-09-24/community-research.md)                                                                              |
| Stoat                    | Delivery and return journeys determine whether a switch lasts                                    | February complaints must be qualified by its later July release; stale feature comparisons mislead. [C16–C17](research/2026-09-24/community-research.md)                                                               |
| Mattermost / Rocket.Chat | Mobile distribution, service limits and release support are product obligations                  | State exactly which dependencies the host and participant inherit. [Operations O01–O03, O14, O18](research/2026-09-24/operations-research.md)                                                                          |
| Colanode                 | Local persistent data and synchronization are a stronger contract than optimistic sending        | Gatherline can test bounded offline history without committing to a CRDT rewrite. [R07: repository](https://github.com/colanode/colanode)                                                                              |
| Google Chat              | Export coverage and externally hosted conversations can have different ownership boundaries      | Show what can be exported and which host controls retention. [R14: export](https://support.google.com/chat/answer/10126829?hl=en), [R15: external retention](https://support.google.com/chat/answer/16053860?hl=en-IN) |

The defensible positioning hypothesis is: **a welcoming place to talk, with understandable attention controls and practical control over your group's history**. Its differentiators must be demonstrated by easier joining, clearer return paths and successful recovery. “Unlimited history,” “free Slack” and “self-hosted” are insufficient on their own.

## 4. Slack criticism: the useful conclusions and the overclaims to avoid

**Attention:** users report both missed replies and too much noise; others value the existing tools. “Turn everything down” is not a universal solution. An email field study found different adaptations to removing notifications, while a small notification-free study found benefits alongside anxiety and disconnection. Smartphone batching research is relevant but does not establish a single ideal policy for group chat. Offer visible controls and compare missed obligations as well as interruption counts. [R01: field study](https://www.microsoft.com/en-us/research/publication/notifications-and-awareness-a-field-study-of-alert-usage-and-preferences/), [R02: notification-free study](https://arxiv.org/abs/1612.02314), [R03: batching study](https://static1.squarespace.com/static/57a40c19414fb54f51f8095f/t/614a55faa7b89e25f4e48ad1/1632261627146/2019%2Bfitz%2Bbatching.pdf)

**Knowledge:** long streams make finding an outcome difficult for some users. That supports testing better retrieval and explicit answers, not claiming Slack lacks search, documents or tasks. Keep exact-message context and clarify who declared an outcome authoritative. The [workplace study](research/2026-09-24/workplace-research.md) contrasts complaints with users describing successful retrieval and automation.

**Cost and history:** Slack Free's documented visibility/deletion limits can motivate switching, but cost comparisons need current region, term and actual usage. The deeper review found localized/promotion differences between pricing pages. Count hosting, maintenance, backups and media traffic before claiming savings. [Slack limits](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces), [pricing comparison caveat](research/2026-09-24/workplace-research.md)

**Lock-in:** partner conversations, useful integrations and historical attachments are switching costs. First-hand discussion describes keeping Slack for those reasons even when alternatives appeal. Rehearse one project before an organization-wide cutover; partial Slack API support is not ecosystem compatibility. [R04: adoption discussion](https://news.ycombinator.com/item?id=46671952), [R10: official GitHub integration workflow](https://docs.github.com/en/integrations/how-tos/slack/use-github-in-slack)

**Trust:** Slack already offers a hide-person control, with stated exceptions; hiding content is different from refusing contact. Its native AI documentation also states access and training protections. Avoid blanket assertions that it has no personal boundaries or that every AI feature trains on private messages. Gatherline must document its own host access, provider behavior and permission enforcement. [R11: hiding people](https://slack.com/intl/en-gb/help/articles/16905395872019-Hide-a-person-in-Slack), [R12: native AI security](https://slack.com/intl/en-gb/help/articles/28310650165907-Security-for-Slack-AI)

## 5. Ten coherent improvement packages

Priority reflects an observed gap, breadth of impact and dependency order. These are judgment-based rankings, not fabricated reach estimates. Effort and release gates are in the roadmap. Packages below share work; estimates must not be added as if they were independent.

### 1. Join and return without assistance — A1–A4, D1–D2, C3

Preserve the intended conversation through invitation, sign-in, notification tap, Back and reload. Add searchable People/Friends with a direct Message action, independent of becoming friends. Offer one stable HTTPS hosting path and make host availability understandable. Test an installed web app before funding native applications. The PWA experiment must include actual locked iOS/Android devices, permission refusal, expired subscriptions and network changes. [WebKit's documented platform path](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

**First slice:** route-backed conversation plus a phone installation/receive/tap prototype. **Stop condition:** if the hosting model cannot keep a pilot reachable, solve that before expanding catch-up. A notification service cannot wake a powered-off workspace host.

### 2. Control personal contact — E1a, E2, A4

Add contact requests, blocking and clear shared-group effects. Separately give moderators reports, a queue, action reasons and a contact/appeal path before open-membership use. Preview guest access and expiry. A private family and a public community need different defaults, but each participant needs comprehensible boundaries.

**First slice:** one documented policy covering DM requests, existing conversations, mentions and calls, then server-enforced controls. **Acceptance:** a blocked or expired participant cannot bypass the policy through another supported path; legitimate shared-group access behaves as described.

### 3. Make calling a person distinct from opening a room — D3–D5, D8

The inspected protocol supports huddle membership and signaling; the UI waits for others to join. Add explicit invite, accept/decline, cancel, timeout, busy and missed-call states for direct calls, with consent and quiet-hours rules. Keep joinable channel rooms available. Device selection and network recovery remain separate prerequisites for a call that actually works.

**First slice:** foreground direct-call invitations using the existing media path. **Acceptance:** cancellation on one device dismisses the other; duplicate devices do not create duplicate calls; missed-call history agrees with what happened. Background ringing requires additional platform verification and must not be promised merely because message push works.

### 4. Explain attention and follow-through — B1–B4

Use three independent states: unread, personally unfinished and subscribed. Define what revives a completed item and what quiet hours suppress. Expose a small “why this appeared” explanation and preview notification settings with example events.

Gatherline already returns notification decision reasons in [notify.ts](../packages/client-core/src/notify.ts). Its followed-thread state is separate, and the foreground UI suppresses notifications for the active channel. Evaluate unseen replies within that channel and replies to followed threads without a mention; those are source-derived test cases, not reproduced incidents. **First slice:** clarify the contract and add done/reopen to Saved. **Acceptance:** fewer missed asks in comparable tasks, without making casual users process every conversation.

### 5. Keep replies easy; add structure when useful — A8, B4, B6, B8

Provide quote reply in the main conversation as well as threaded reply. Later allow same-channel splitting of a digression, optional titles and an outcome with source links. Preserve attribution, reading position and stable links, and show a move trail. Start outcomes within source access; wider sharing requires explicit destination review.

**First slice:** quote reply and an outcome prototype. **Acceptance:** people distinguish a personal bookmark, accepted answer and group decision; a moved conversation does not strand a draft or expose content to a new audience. [Zulip repair precedent](https://zulip.com/help/move-content-to-another-topic)

### 6. Find the thing, not just the message — B5, D2, E4

Add filename retrieval, Files results and a conversation shared-items view. Play supported uploaded audio/video inline, with an understandable fallback and data/storage controls; this is independent of recording voice notes. Progress to photos, links, polls and events in that same retrieval model. Offer relevance/newest sorting and useful empty states; preserve permission checks for previews, counts and downloads.

**First slice:** find an old attachment by an approximate filename and open its original context. **Acceptance:** known-item tasks improve across DMs and threads; removed membership denies server access. Previously downloaded copies cannot be remotely recalled.

### 7. Make ownership survive a failure — C1–C5

Provide host health, backup freshness, a deployment configuration inventory and guided fresh-destination restoration. Explicitly distinguish a replacement host from a test clone. Restored scheduled messages and integration deliveries must remain inactive during a recovery rehearsal. Keep compatible release artifacts and explain upgrade failure paths.

**First slice:** manual recovery using existing backup primitives. **Acceptance:** a non-developer restores messages/files and knows which network settings or secrets need re-entry, without triggering duplicate external actions. C1 concerns desktop host registry/folder naming; the server already has immutable workspace identity and scoped local draft/outbox storage. [Operations analysis](research/2026-09-24/operations-research.md)

### 8. Support adoption without abandoning history — C7–C8, E6

Ship versioned native portability before encouraging serious switching. Bound the first Slack importer to a new workspace and content actually available in the export. Report missing attachments, unsupported objects and historical authors. Keep passwords out of account migration and provide secure first-login claiming.

**First slice:** native round trip, then one pilot's export dry run and one required integration recipe. **Acceptance:** history and unavailable items reconcile; imported history does not send live notification floods; the pilot can explain what still requires the old tool. Arbitrary Slack apps and seamless live merges stay outside the first adapter.

### 9. Let one person belong to several spaces — A10, D9

The current [workspace switch](../packages/ui/src/App.tsx) destroys the previous client. Saved workspaces therefore do not establish simultaneous live subscriptions. Define workspace-specific badges, background delivery, account separation and a click-through to the correct context. Budget connections and memory instead of keeping every timeline fully loaded.

Offline is another explicit contract: persisted drafts/outbox already help, but cold-start readable message history requires more. Trial a bounded, opt-in cache with account scoping, storage limits and cleanup. Offline stale copies cannot learn about revocation until reconnecting. **First slice:** truthful inactive-workspace status and notification architecture; offline history is separately funded after demand is observed. [Local-first design distinction](https://www.inkandswitch.com/essay/local-first/)

### 10. Add everyday coordination and inclusion — E3–E4, D6, A6–A9

Prioritize small polls, event/RSVP cards and short voice notes for groups that need them. Include cancellation, time zones, optional reminders and retrieval. Basic voice recording/playback, transcription and live captions are separate investments. Research with multilingual communities shows both the value of voice and retrieval/transcription challenges; it does not justify assuming accurate transcription for every language. [C15: primary study](https://reitmaier.io/publications/chi2022_asr_opportunities/Reitmaier_2022_ASR-Opportunities-Challenges.pdf)

Start keyboard, screen-reader, zoom, mixed-script and low-end phone trials during foundation work. Themes and translation breadth can follow; accessible core journeys cannot wait for a later polish phase. Use WCAG 2.2 as test criteria, not an unearned certification. [R09: standard](https://www.w3.org/TR/WCAG22/)

## 6. Deliver “for everyone” through different complete journeys

| Cohort                 | Minimum useful journey                                             | Gate before expanding that pilot                                                                                   |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Friends/families       | Invite → reply/photo → receive on phone → call → find shared media | Stable availability, real-phone return, contact controls; working call path if calls are the reason to adopt       |
| Clubs/communities      | Join → choose interests → participate → attend event → get help    | Newcomer visibility preview; public groups also require moderation and anti-abuse controls                         |
| Students/project teams | Ask → get answer → follow up → retrieve file → invite collaborator | Understandable attention, guest boundaries, actual integration needs; migration when replacing an existing archive |
| Organizations          | Provision → collaborate → revoke access → upgrade → restore/export | Recovery, support envelope and access policy; SSO/provisioning when a named pilot requires them                    |

Starter presets should change defaults without creating incompatible editions. Do not require tasks, topics or read receipts for casual groups. Do not make every organization maintain a friend graph. Separate host controls from participant screens. “Everyone” also includes people who cannot or will not operate a server: validate an assisted always-on deployment option before assuming every group has an available technical host.

## 7. Sequence, capacity and decision gates

The [roadmap's revised twelve-week plan](PRODUCT-ROADMAP-2026-09-24.md#5-recommended-delivery-sequence) is a conditional planning envelope for two engineers, not a staffing commitment. Twenty-four engineer-weeks becomes roughly **17–18 feature engineer-weeks** after reserving 25–30% for integration, pilot feedback and defects. Phone delivery, recovery and navigation can consume most of that capacity. Do not promise all ten packages in that window.

Start with two weeks of foundation slices and experiments: routing, touch, identity/host registry design, a restore rehearsal and real-phone reachability. Then select the largest demonstrated adoption blocker. For phone-led groups, protect push/reachability and defer expanded catch-up. For desktop-led private groups, a narrow follow-up improvement may fit first. Public-community and migration pilots have their own gates; they cannot inherit readiness from an unrelated private pilot.

Initial engineering ranges refined by operations research are: push feasibility about one week, bounded PWA/push delivery **3–6 engineer-weeks**, guided recovery **2–4**, initial release/upgrade discipline **2–4**, dependable small calls **3–6**, native portability **3–5**, and a bounded Slack adapter **3–6**. They overlap existing roadmap items and exclude unbounded support or extra native platforms. Re-estimate after inspecting the actual vertical slice; lower confidence remains around background calls and deployment diversity.

Keep native mobile, an SFU, federation, E2EE, a broad AI assistant, a full project-management suite and managed SaaS billing conditional. None is rejected forever. Each needs a demonstrated blocker, a maintenance owner and a separately scoped design.

## 8. Research and release plan that can disprove these recommendations

Recruit 6–8 whole pilot groups across the four cohorts, with different technical confidence, languages and devices. This is directional discovery, not a representative survey. Include the person operating the host and the person least inclined to install another app.

1. **Before the trial:** ask participants to show a recent missed reply, an unsuccessfully retrieved item and the last invitation that needed help. Inventory must-keep partners, apps and history. Record evidence without collecting private content unnecessarily.
2. **Observed baseline:** invite a newcomer; respond from a phone; return after a day; find a named file and an answer; join a call across networks; switch between two workspaces. Record assistance, wrong turns, time and failures per cohort.
3. **Host baseline:** create a stable address, describe sleep/quit behavior, back up, update and restore onto a fresh isolated destination. Record missing knowledge and elapsed hands-on work.
4. **Compare one change:** counterbalance current/prototype order where feasible; use equivalent histories. Measure missed obligations alongside catch-up time. Separate learning effects from interface benefit.
5. **Observe continued use:** run a two-week group trial with weekly check-ins. Ask why anyone returned to the old tool. Voluntary group return matters more than raw messages or notification opens.
6. **Release review:** use the roadmap's proposed task gates, publish device/network matrix and sample sizes, resolve access/data-loss blockers and choose the next package from evidence.

Retain negative evidence. If people ignore completion controls, simplify them. If a group needs dependable photos and events more than structured discussions, change its sequence. If a missing external integration prevents migration, improving colors will not resolve it. If nobody wants to host, test assisted deployment before constructing a business model around an assumed volunteer operator.

The operating-cost worksheet should use actual provider quotes and observed workloads: compute/power, domain/connectivity, attachments and backup growth, media relay traffic, push service, release distribution and operator/support hours. Keep one-time setup separate from recurring cost. Software license price alone is not total cost, and a competitor's capacity table is not a Gatherline benchmark.

**Recommended next commitment:** deliver and measure one trustworthy join/return/recover experience across several kinds of group, then expand retrieval and coordination from observed needs. This is broad in audience and deliberately bounded in each release.
