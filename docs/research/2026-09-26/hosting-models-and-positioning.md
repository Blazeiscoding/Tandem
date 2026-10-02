# Hosting models: a gathering and an everyday workspace are different promises

Research/access date: **September 26, 2026, Asia/Calcutta**. This extends the [operations study](../2026-09-25/operations-and-data.md) and [adoption study](../2026-09-25/adoption-and-switching.md). Source inspection uses checkout `d63a82c`; no competitor installation or browser-policy experiment was performed for this memo.

Tandem's original “host on your computer” proposition deserves its own trial. The need for an always-reachable service in an asynchronous group does not make a deliberately temporary gathering invalid. The product needs to distinguish these promises before choosing onboarding, infrastructure or marketing.

## 1. Preserve two coherent use cases

| Use case                                  | Participant expectation to test                                                           | Host responsibility                                                                           | Gate before claiming support                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A gathering on the same network           | Join while the host is running; exchange conversation/files during the session            | Keep the host awake and reachable, explain when it ends, preserve the workspace afterward     | A second actual device joins; a late participant understands availability; restart retains the intended history |
| A temporary gathering across the internet | An invitation works during a declared session; a temporary address may expire afterward   | Run a reachable connector and appropriate registration policy; close the session deliberately | Join from another network; explain an expired address; distinguish closing public access from deleting data     |
| An everyday asynchronous group            | People send and return at different times, including while the original organizer is away | A sustained host, stable origin, operational recovery and a successor                         | Locked-phone delivery, cold return, host restart, off-device restore and handover pass                          |
| A private intranet deployment             | Devices can reach the group on the stated network without public exposure                 | Local addressing, trust/certificates, network access and device provisioning                  | Test managed/unmanaged devices and required APIs without assuming an internet tunnel exists                     |

These are **proposed support modes**, not four completed products. Each uses the existing server-centered history model. Closing a session should not silently erase its conversation. A browser URL expiring, an invite code expiring, an account being revoked and data being deleted are different events.

Initial recommendation: make the existing local gathering journey excellent while explicitly testing one everyday-hosting recipe. Do not require every trial organizer to buy a domain or VPS. Conversely, do not recruit a phone-led asynchronous group on an expectation that somebody's intermittently running laptop behaves like a managed messenger.

## 2. Adjacent alternatives reveal different ownership contracts

These references compare published architecture and workflows, not overall quality or security rankings.

| Reference               | What the documentation establishes                                                                                                                                                                                              | Useful implication for Tandem                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Briar                   | Direct synchronization can use nearby Bluetooth/Wi-Fi when the internet is unavailable, with a separate Tor path online. [H01](https://briarproject.org/how-it-works/)                                                          | “Works without internet” can mean nearby peer synchronization, not merely an offline-readable cache. Tandem currently has a host, so its LAN promise should name that dependency. |
| Briar Mailbox           | A spare powered, connected Android device can hold encrypted messages while the main Briar device is offline; a source-build command-line option is also documented. [H02](https://briarproject.org/download-briar-mailbox/)    | Even a decentralized design must arrange availability for people online at different times. The operation can move to a helper device rather than disappear.                      |
| Jami LAN mode           | LAN use needs local discovery or reachable bootstrap configuration; name resolution and mobile push can have separate service dependencies. [H03](https://docs.jami.net/user/lan-only.html)                                     | Avoid an undifferentiated “serverless” or “independent” badge. Inventory discovery, identity, transport and notification dependencies separately.                                 |
| SimpleX self-hosting    | Its SMP relay guide exposes queue creation, persistence/restart and message-expiry configuration. That relay is not a durable workspace archive. [H04](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/SERVER.md) | Queue ownership, history ownership and account ownership are different things. A hosted relay alone would not make Tandem's authoritative server history local-first.             |
| SimpleX mobile settings | Notification modes and previews are explicit, and Android power-management requirements are documented. [H05](https://simplex.chat/docs/guide/app-settings.html)                                                                | A native application also has delivery and battery tradeoffs. Do not promise native delivery parity merely from packaging a client.                                               |
| Mumble                  | Audio configuration distinguishes input, output, voice activity, push-to-talk, cues and local/server loopback tests. [H06](https://www.mumble.info/documentation/user/audio-settings/)                                          | Device preflight and knowing whether others can hear you are substantial call features before larger meetings. Borrow a short diagnostic journey, not the entire settings panel.  |
| Nextcloud Talk guests   | A conversation link can admit a browser guest without a Nextcloud account; email guests have individual access tokens. [H07](https://docs.nextcloud.com/server/stable/user_manual/nl/talk/guest.html)                           | Occasional visitors need a bounded participation path. An invitation should explain whether it creates a durable account and what history it opens.                               |
| Nextcloud Talk capacity | The published mesh/SFU discussion describes repeated sender uplink and participant decoding work, then a separate backend option. [H08](https://nextcloud-talk.readthedocs.io/en/latest/scalability/)                           | A call's limit can be participant uplink or device work rather than chat-server CPU. Its published participant examples are not Tandem capacity measurements.                     |

These products already occupy several appealing positions. Tandem should not claim that self-hosting, guest links, peer communication or private notifications are unique. Its proposed distinction is a complete, approachable journey from hosting a group to returning and recovering its history. That remains a hypothesis until participants and a second operator complete the tasks.

A peer-to-peer rewrite would change key management, synchronization, membership, search and moderation. A relay service would introduce another operating dependency. Neither is warranted simply because the initial host can sleep. First test whether session-scoped use or a stable single host meets the selected group's actual need.

## 3. LAN browser participation has two separate platform boundaries

### Trustworthy origin

W3C Secure Contexts treats HTTPS and loopback specially; arbitrary private HTTP addresses do not receive the loopback exemption. Service workers require secure contexts, and privacy-sensitive APIs use this boundary. A successful development run at `http://localhost` on the host does not establish equivalent behavior at `http://192.168.x.x` on a participant's phone. [H09](https://www.w3.org/TR/secure-contexts/)

Tandem's [deployment guide](../../DEPLOYMENT.md) already describes browser media/HTTPS limitations. Its [platform abstraction](../../../packages/ui/src/platform.ts) also explicitly leaves hosting and LAN discovery out of the browser fallback. A browser invitation and desktop mDNS discovery are separate joining paths.

For a local-only browser pilot, identify the supported trust/address recipe before promising calls or installed offline behavior. An internet-based HTTPS tunnel is an option for an internet-connected session, not an offline solution. Test any local certificate/DNS provisioning path on participant devices; bypassing certificate validation or asking people to disable browser protections is not a supported setup recipe.

### Public webpage connecting to a local server

Chrome's original Local Network Access article introduced permission for public-page requests to private/loopback destinations and records the Chrome 142 launch. An older subsection still lists WebSockets as a future extension. That subsection must not be used as current evidence that sockets are exempt. [H10](https://developer.chrome.com/blog/local-network-access)

Chrome 147's release notes, dated April 7, 2026, explicitly extend LNA restrictions to WebSockets. They also distinguish top-level navigation from the subframe navigation restrictions described there. [H11](https://developer.chrome.com/release-notes/147)

Microsoft's March 9, 2026 Edge guidance describes its rollout from Edge 143 and discusses permission, mixed content and destination annotation. CORS permission and local-network permission are different controls; browser/version-specific behavior must be tested. [H12](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access)

**Tandem-specific inference:** the web client can choose another server address; REST and WebSocket requests then use that address. A public-hosted web client connecting to a LAN workspace is therefore a relevant test case. Opening the LAN workspace's own browser page is a different origin flow. No LNA failure was reproduced in this research, and these documents do not establish the same behavior for Electron or every browser.

## 4. Concrete experiments to distinguish the paths

| Experiment                               | Record                                                                                                                        | What changes the recommendation                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Local gathering with WAN disconnected    | Actual devices, discovery/direct-link path, message/file completion, host sleep/restart, browser capability limitations       | If the group cannot perform its agreed local tasks, narrow the support statement before expanding discovery                                  |
| Public invitation on cellular            | Owner-prepared link, account/guest interpretation, send, return and session ending                                            | If origin expiry prevents intended repeat use, move that group to the stable-host path                                                       |
| Public web client to LAN server          | Browser/build, origin and destination scheme, address space, CORS response, permission allow/deny, REST and socket separately | Select a supported same-origin join path or implement a tested cross-origin flow; do not label every denial a server outage                  |
| Guest joins one gathering                | Visible history, identity/recipient context, call permission, expiry and later access                                         | If account creation is the principal barrier, prioritize a scoped guest slice; if it is network availability, a guest mode will not solve it |
| Audio problem rehearsal                  | Wrong device, muted input, local monitoring, network path and counterpart receive state                                       | Prioritize diagnostic/device controls before room size if these dominate failures                                                            |
| Everyday group while organizer is absent | Host uptime, second-operator actions, notification return, independent retrieval of old attachments                           | If no one will own operation, test assisted hosting rather than concealing the responsibility in onboarding                                  |

Run within a controlled/permissioned pilot, not on an existing user's private history. Predeclare what support mode is being evaluated. A successful LAN text exchange cannot establish always-on phone access; a good hosted asynchronous pilot cannot establish offline LAN independence.

## 5. Positioning claims to test, without treating them as facts

| Candidate claim                                   | Task that must support it                                                          | Reason to reject or narrow it                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| “Start a place for your group from this computer” | A non-developer host and another participant complete the actual joining task      | Setup repeatedly needs network/admin help unavailable to the group            |
| “Know where your group's history lives”           | Host and participant can identify storage, export it and retrieve it independently | Required attachments still depend on unavailable external URLs                |
| “Keep the group going when organizers change”     | A successor operates and restores the supported deployment                         | Recovery needs the founder's personal account, secrets or unwritten steps     |
| “Stay caught up without following every message”  | Important asks are found with no increase in missed obligations                    | Quiet settings hide relevant communication or add another unwanted work queue |

None implies E2EE, immunity from outages, guaranteed savings or support for every participant device. Those would be distinct, currently unestablished claims. A useful outcome can be complementing an incumbent for a particular gathering rather than replacing every group conversation.

## Source register

All accessed **2026-09-26 local time**. Documentation is primary evidence of stated behavior and design, not independent proof of reliability. Moving documentation URLs should be rechecked for a release. No source's performance examples were adopted as Tandem measurements.

| ID  | Source / responsible party                                                                                             | Type                                                                  | Publication/update date established             |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| H01 | [How it works](https://briarproject.org/how-it-works/) — Briar Project                                                 | Official architecture description                                     | Not established                                 |
| H02 | [Briar Mailbox](https://briarproject.org/download-briar-mailbox/) — Briar Project                                      | Official product/setup documentation                                  | Not established                                 |
| H03 | [Use Jami on a LAN](https://docs.jami.net/user/lan-only.html) — Jami                                                   | Official technical documentation                                      | Not established                                 |
| H04 | [Hosting an SMP server](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/SERVER.md) — SimpleX maintainers | Maintainer technical documentation; moving stable branch              | Not established                                 |
| H05 | [App settings](https://simplex.chat/docs/guide/app-settings.html) — SimpleX                                            | Official user documentation                                           | Not established                                 |
| H06 | [Audio settings](https://www.mumble.info/documentation/user/audio-settings/) — Mumble                                  | Official user documentation                                           | Not established                                 |
| H07 | [Join as guest](https://docs.nextcloud.com/server/stable/user_manual/nl/talk/guest.html) — Nextcloud                   | Official user documentation; localized URL renders cited English text | Not established                                 |
| H08 | [Scalability](https://nextcloud-talk.readthedocs.io/en/latest/scalability/) — Nextcloud Talk                           | Official technical documentation                                      | Not established; numerical guidance not adopted |
| H09 | [Secure Contexts](https://www.w3.org/TR/secure-contexts/) — W3C Web Application Security Working Group                 | Technical specification                                               | Version date not relied upon                    |
| H10 | [Local Network Access announcement](https://developer.chrome.com/blog/local-network-access) — Chris Thompson / Chrome  | Browser-vendor announcement                                           | Published 2025-06-09; inline update 2025-09-29  |
| H11 | [Chrome 147 release notes](https://developer.chrome.com/release-notes/147) — Chrome                                    | Browser-vendor release documentation                                  | Stable release 2026-04-07                       |
| H12 | [Edge LNA adoption guide](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access) — Microsoft       | Browser-vendor technical guidance                                     | Updated 2026-03-09                              |
