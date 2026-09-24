# Operations research: what makes self-hosted chat usable beyond developers

Research and synthesis: **September 24–25, 2026**. External sources were accessed September 24; source comparison and the final memo were completed September 25. This memo reads official deployment and product documentation alongside firsthand issue reports and maintainer replies. The accompanying [source ledger](operations-sources.json) records 24 sources, their claims and limitations. Issue reports demonstrate possible failure modes, not their prevalence. Product limits can change; development documentation can lead released behavior. Recommendations and effort estimates below are our analysis, not competitor claims.

## The adoption gap is operational continuity

Gatherline already has verified CLI backups, automatic database copies before upgrades, account/session administration, retention, storage accounting and configurable TURN. It also supports stable addresses, not just temporary sharing. The missing experience is helping ordinary people keep a group reachable, preserve it and recover it. Source evidence: [backup implementation](../../../packages/server/src/backup.ts), [hosting controller](../../../apps/desktop/src/main/hosting.ts), [deployment guide](../../DEPLOYMENT.md).

There is no single universal blocker. A missing push notification may disqualify a family group but not an always-open operations dashboard. Lack of Slack import can disqualify an established team but not a new club. SSO can be mandatory for one organization and irrelevant to another. Evaluate complete journeys for each cohort rather than making enterprise procurement the definition of readiness.

## 1. Mobile delivery is a service and identity decision

Mattermost's store-distributed native apps require its compatible hosted push service; running an independent push service entails building compatible mobile apps. That adds signing, publishing, upgrades and support to the operator's workload. This is a constraint of that native distribution model, not proof that every self-hosted messenger needs a paid relay. [O01: Mattermost mobile FAQ](https://docs.mattermost.com/deployment-guide/mobile/mobile-faq)

The free-service comparison is nuanced:

| Product               | Verified boundary                                                                                                                                                                           | What it teaches Gatherline                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Rocket.Chat Community | Hosted push allowance is 10,000 notifications/month; custom delivery needs credentials and infrastructure.                                                                                  | Show service allowance and delivery failures before users quietly miss messages. |
| Rocket.Chat Starter   | Free for up to 50 users, with unlimited push listed; exceeding the limit restricts adding users, not access to existing data. Community is a different edition with different capabilities. | Publish separate software, service and operational limits.                       |
| Self-hosted Zulip     | Free push for up to 10 users; qualifying communities can apply for free unlimited push. The server itself remains freely usable without a plan.                                             | Do not imply all groups must pay merely because a commercial tier exists.        |

Sources: [O02: Rocket.Chat push](https://docs.rocket.chat/docs/push), [O03: Starter and Community](https://www.rocket.chat/get-started), [O04: Zulip self-hosted billing](https://pro.zulip.com/help/self-hosted-billing). These are current published terms, not lifetime guarantees.

Counterevidence matters. Apple supports standards-based push for Home Screen web apps, requested after user interaction; it does not require Apple Developer Program membership. Campfire explicitly offers a PWA with badges/push and currently distributes its software free under MIT. A native app is therefore not a prerequisite for testing Gatherline's mobile proposition. [O05: WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [O06: Campfire](https://once.com/campfire)

Privacy is also separable from delivery. Zulip documents encrypted notification content between server and device; its forwarding service still sees delivery metadata, and the workspace server still knows the content. This disproves the blanket assumption that useful push must reveal message text to intermediaries. [O07: Zulip push design](https://zulip.readthedocs.io/en/latest/production/mobile-push-notifications.html)

**Recommendation:** split D1 into an installation/reachability spike and a delivery project. Specify stable origin, subscription recovery, per-device preferences, content privacy, retries, expired subscriptions and diagnostic receipts. Require an actual locked-phone receive/tap test. Estimate **1 week for feasibility, then 3–6 engineer-weeks for a bounded supported PWA/push release**, with native distribution estimated separately. These are planning ranges, not promises.

## 2. A temporary link is excellent for trying, insufficient for continuity

Cloudflare says Quick Tunnels are for development/testing, have no uptime SLA, generate random subdomains and impose 200 in-flight requests. That figure is not a 200-person capacity guarantee. Gatherline's temporary public link is useful, but should lead into a stable-address journey when a group starts depending on it. [O08: Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

Service-worker registration and scope are origin-bound. Therefore, changing a workspace's public origin does not automatically transfer its installed web app and subscriptions; this is an inference from the browser model. Gatherline already has a protocol workspaceId and scoped local draft/outbox identity. Preserve those identities while adding an explicit address-change recovery flow. C1 concerns the desktop registry and name-derived hosting folders; it must not recreate protocol workspace identity. [O09: service-worker specification](https://www.w3.org/TR/service-workers/)

Element's deployment guide makes a stronger, product-specific distinction: its Matrix server name forms user identity and cannot simply be renamed without resetting the database. Gatherline need not inherit that constraint; it should make its own identity/address contract deliberate before federation or passkeys. [O10: ESS Pro preparation](https://docs.element.io/latest/element-server-suite-pro/preparing-ess-pro-poc/)

**Required for everyday remote use:** one understandable stable HTTPS option, certificate/connector health, a host availability explanation and clear messages when the host sleeps. Automatic start does not solve power cuts, ISP outages or a disconnected laptop. An always-on appliance/VPS recipe or assisted hosting can be sufficient; a complete managed SaaS business is not immediately required.

## 3. Recovery must include the deployment and its side effects

Mattermost requires protecting database, configuration/certificates and files, and recommends stopping for a consistent backup. It distinguishes backups, high availability and disaster recovery: they solve different failures. [O11: Mattermost recovery](https://docs.mattermost.com/deployment-guide/backup-disaster-recovery)

Zulip distinguishes full backups from portable logical exports. Its restore instructions require compatible OS/PostgreSQL versions and include secrets; external object storage and certificates require separate treatment. Element's current ESS Pro procedure also includes chart values, generated secrets, deployment markers and media, besides databases. [O12: Zulip backups](https://zulip.readthedocs.io/en/latest/production/export-and-import.html), [O13: Element recovery](https://docs.element.io/latest/element-server-suite-pro/administration/backup-and-restore/)

Gatherline's narrower SQLite-plus-files architecture is an advantage, but its current backup manifest does not capture arbitrary environment settings, external tunnel-token files or the desktop host registry. A verified message archive is not proof that the group will regain the same address, TURN settings or retention policy. C2 should show exactly which operational settings are included, omitted or need re-entry, without casually placing secrets in an unencrypted export.

There is another necessary gate: **a restore drill must not activate a second live copy of automation.** Gatherline flushes due scheduled messages and integration deliveries at startup ([server startup](../../../packages/server/src/server.ts), lines 3568–3617). Add an isolated recovery-preview mode or equivalent documented isolation before validating a restored copy. Verify historical content, then explicitly choose whether this is a replacement server or a test clone. This is a source-derived risk to design around, not a claim that an incident occurred.

Retain C2 as a launch gate. Add free-space preflight, version compatibility, external configuration inventory, restore isolation and evidence of a fresh-machine drill. Estimate **2–4 engineer-weeks** using existing primitives; scheduled/off-device backups remain a separate package.

## 4. Upgrades consume real operator time

Rocket.Chat documents six-month standard support and twelve-month LTS support. After EOL, cloud-dependent services stop working and official clients may cease connecting. A free server is not necessarily independent of an upstream service's compatibility policy. [O14: Rocket.Chat lifecycle](https://docs.rocket.chat/docs/version-durability)

Zulip's upgrade documentation notes that upgrade-time memory can exceed steady-state needs, and simple rollback is intended for minor releases; schema changes complicate downgrades. “It runs on this machine” is weaker than “this machine can safely update it.” [O15: Zulip upgrades](https://zulip.readthedocs.io/en/latest/production/upgrade.html)

A concrete maintainer discussion illustrates dependency cost. Zulip's Helm users faced Bitnami image changes; a proposed swap to stock images was challenged because the charts depended on image-specific behavior. A maintainer pointed to end-to-end chart tests as part of validating the replacement. This affected that deployment path, not every Zulip installation. [O16: docker-zulip issue #506 and replies](https://github.com/zulip/docker-zulip/issues/506)

A September 2026 Element report initially blamed an Android regression. The reporter later fixed missing server-side transport configuration; a subsequent commenter reported the deployment update resolved compatibility. The lesson is versioned client/server diagnostics, not “Element calls are broken.” [O17: resolved deployment report](https://github.com/element-hq/element-x-android/issues/7659#issuecomment-5573012627)

**Recommendation:** C5 needs a supported-version policy, update preflight, retained matching installer/container artifacts and a rollback drill. Separate cross-platform packaging from automatic updates. Budget **2–4 weeks for initial Windows release/upgrade discipline**, then **3–6 weeks for verified additional platforms**, with automatic update infrastructure separately scoped. Avoid promising rollback to an old binary after incompatible database changes.

## 5. Calls require a second connectivity test

Mattermost separates HTTPS/WebSocket signalling from media connectivity and treats TURN as a fallback when direct media paths fail. It offers integrated calls at small scale; extra media services and recording infrastructure are conditional. Its current edition rules also differentiate one-to-one, group and dedicated media service capabilities. These are product choices, not architectural limits Gatherline must copy. [O18: Calls deployment](https://docs.mattermost.com/deployment-guide/calls/calls-deployment-guide)

Element's current self-hosting instructions require a LiveKit SFU plus MatrixRTC authorization. An operator report describes confusing a client-reachable media address with localhost and difficulty configuring the standalone image. Good documentation and connection testing can be as valuable as another calling feature. [O19: Element Call deployment](https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md), [O20: operator report #3525](https://github.com/element-hq/element-call/issues/3525)

A Mattermost operator reported calls connecting and later dropping with Docker/private-address and coturn errors, despite a separate TURN test succeeding. The issue was closed as not planned; the public report alone does not establish a confirmed product defect. It does justify testing sustained application media rather than only probing relay availability. [O21: Calls report #1143](https://github.com/mattermost/mattermost-plugin-calls/issues/1143)

Gatherline already accepts TURN configuration. Its priority is device selection, recovery after socket interruption, credential lifecycle and a diagnostic that confirms two-way audio across different networks. Test 2/4/6/8 participants as proposed experiments, not promised supported limits. Include a phone switching Wi-Fi/mobile data, device unplug and sleep/wake. Budget **3–6 weeks for the combined dependable-small-call package**. SFU selection should follow measured demand.

## 6. Migration fidelity means people and meaning, not just rows

Slack exports contain file links; coverage depends on plan and approval. Its current Free export documentation limits file links to the last 90 days. An importer cannot reconstruct content the source export never supplies. [O22: Slack exports](https://slack.com/help/articles/201658943-Export-your-workspace-data)

Zulip's importer documents account/role mapping, conversion of threads into topics, settings that must be configured again and first-login handling because passwords are not exported. Importing is into a new organization, a deliberate way to bound merge complexity. [O23: Zulip Slack import](https://zulip.com/help/import-from-slack)

A firsthand code-audit issue describes chunk-boundary thread fragmentation, malformed timestamps, unusual display names and missing file metadata. These are reported findings, not all independently reproduced here or asserted still unfixed; use them as fixture ideas. [O24: importer issue #39650](https://github.com/zulip/zulip/issues/39650)

**Recommendation:** promote C7 ahead of broad switching campaigns. Keep the first Slack adapter limited to a new workspace and available public-channel exports. Add an import manifest, missing-content report, inactive historical authors, secure account claiming, notification suppression, resumable blob transfer and preservation of source IDs. Reject unsafe archive paths and bound expansion. Offer a dry run and a reversible cutover. Budget **3–5 weeks for native portability, plus 3–6 for a validated first adapter**; broad live merging is extra.

## 7. What changes in the roadmap

| Gate                              | Necessary for                                          | Change                                                                                      |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Reachability and stable address   | Groups expecting access when the original host is away | Add a C2/D1 readiness check before everyday remote pilots.                                  |
| Locked-phone receive/reply        | Phone-led groups expecting asynchronous notifications  | Promote D1 above B1/B2 for that cohort; do not add it on top of the same twelve-week scope. |
| Restore and upgrade drill         | Groups entrusting durable history to Gatherline        | Keep C2/C5 mandatory; include deployment settings and safe test-clone behavior.             |
| Sustained two-way media           | Groups choosing Gatherline for calls                   | Combine D3/D4/D5 into a measurable small-call release.                                      |
| Faithful bounded migration        | Established teams unwilling to abandon history         | Promote C7/C8 for switching pilots; optional for brand-new groups.                          |
| SSO/SCIM, HA clusters, federation | Specific organizational or cross-server needs          | Retain conditional scope; do not burden every family or club.                               |

The hidden operating-cost worksheet should include always-on compute/power, domain/TLS administration, off-device backups, attachment growth, media relay bandwidth, update/support labor, and any push relay or app-store maintenance. Give examples using the host's actual providers, not an invented universal monthly price. Native-store requirements and resource figures from competitors do not establish Gatherline's costs.

For capacity, retain the current architecture until measurement says otherwise. Gatherline's existing 20-socket/300-message test is useful evidence of that workload, not a many-user service guarantee ([validation](../../VALIDATION.md)). Define active users, concurrent sockets, message history, attachment size, media mix and failure recovery separately.

The next release should make one complete promise credible: **people can join, return from their phones, and keep their history when the host machine or app version changes.** Achieving that for several different pilot groups is stronger evidence of “for everyone” than implementing a long list of optional administrative features.
