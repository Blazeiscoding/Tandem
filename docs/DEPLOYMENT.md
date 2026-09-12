# Hosting SlackOSS

## Windows and LAN

Build an installer with `pnpm --filter @slackoss/desktop package --win`.
The output is `apps/desktop/release/SlackOSS Setup 0.1.0.exe`. Local builds are
unsigned unless you supply a signing certificate; Windows may show SmartScreen.

Install, choose **Host a workspace on this computer**, name it, and create the
owner account. Allow incoming TCP on the displayed port through the host firewall.
Other desktop users can discover the workspace on the same LAN or connect using
`192.168.1.42:8543`. Browsers can use the same address for chat.

The host computer must stay running and awake. Internet users need a reachable
public IP with port forwarding, a VPN such as Tailscale, or a VPS. An IP address
alone does not bypass NAT, CGNAT, or firewalls. LAN discovery does not cross routers.

Data is under the app's user-data folder in `hosted/<workspace-name>/`. Advanced
deployments can set `SLACKOSS_USER_DATA_DIR` to choose the desktop profile location.
Treat workspace names as identifiers when reopening existing local workspaces.

## Docker and VPS

Run `docker compose -f docker/docker-compose.yml up -d --build` from the repo.
Data lives in a named volume at `/data`; the server runs as a non-root user.
`GET /api/health` checks the process and database. Docker's health status reports
failures; the restart policy restarts exited processes, not merely unhealthy ones.

Create the owner account before allowing public traffic, using an SSH tunnel if
necessary. The supplied Compose configuration then requires invitations for new
accounts. Place an HTTPS reverse proxy in front and set `--public-url` in the
service's command, e.g. `https://chat.example.org`. WebSocket upgrades must be
forwarded. For an internet deployment, bind the published chat port to localhost
when the reverse proxy runs on the host.

Example Caddy configuration on that host:

```caddyfile
chat.example.org {
    reverse_proxy 127.0.0.1:8543
}
```

## Voice and huddles

By default no third-party ICE server is contacted. LAN peers connect directly.
For people on different networks, provide your own STUN/TURN configuration through
`SLACKOSS_ICE_SERVERS`. Compose reads it from the environment or `docker/.env`:

```dotenv
SLACKOSS_ICE_SERVERS=[{"urls":"stun:turn.example.org:3478"},{"urls":"turn:turn.example.org:3478","username":"workspace","credential":"replace-with-a-strong-secret"}]
```

The authenticated `/api/rtc-config` endpoint supplies it to members. Static TURN
credentials are visible to workspace members; use scoped credentials, quotas, and
rotation on your relay. This repository does not deploy a TURN service for you.
Allow the relay's listening and media ports according to its configuration.

Browser microphone/camera access requires HTTPS (localhost is an exception).
Use the Electron app for voice on plain HTTP LAN servers. Mesh huddles create one
connection per other participant. Start with small calls and measure on target
machines; larger meetings need an SFU. Cameras use a 360p/20fps target with a
720p/24fps ceiling; screen sharing targets 10fps, capped at 15fps. These defaults
reduce processing and bandwidth but do not guarantee a fixed RAM budget.

## Attachment storage

Attachments are unlimited unless you say otherwise, which on a small disk means
one enthusiastic upload can fill it. Cap the workspace with `--storage-limit-mb`,
or `SLACKOSS_STORAGE_LIMIT_MB` for Compose:

```sh
slackoss-server --data ./data --storage-limit-mb 20000
```

The cap covers every stored attachment plus uploads still arriving, so
simultaneous uploads cannot cross it between them. An upload that would not fit
is refused with `507` and leaves nothing behind; the author is told the workspace
is full and keeps their draft. Deleting a message frees its attachments back
once the cleanup worker runs.

Members can see usage under Account settings, including how much is left and the
per-file maximum. `0` means unlimited, which is the default.

An attachment chosen and then thought better of would otherwise hold its bytes
forever. Uploads never attached to a message are freed after 24 hours, tunable
with `--abandoned-upload-hours` or `SLACKOSS_ABANDONED_UPLOAD_HOURS`. Files a
scheduled message is still waiting to send are never swept, however old they
are. The window has to outlast the gap between choosing a file and sending it,
including a client that goes offline in between: an outbox entry that has been
waiting longer than the window loses its attachments and says so rather than
sending the words alone.

Blobs left behind by a process killed mid-upload — bytes on disk that no
database row accounts for — are found and freed at startup.

Size the cap below the free space on the volume rather than at it: the database,
its write-ahead log, and any backups written locally share that disk. Lowering a
cap below what is already stored is allowed — nothing is deleted, and uploads are
refused until the workspace is back under the line.

Files of 8 MiB or more use the browser or desktop download manager, which streams
them to disk without first buffering a complete JavaScript blob. Large images
show a download card; smaller files keep their existing preview/download path.
Upgrade both the server and client to use this feature.

The client requests a single-use link valid for 60 seconds and tied to its signed-in
session. Access is checked again before streaming. The server omits file requests
from its request logs; configure reverse-proxy access logs to omit query strings
on `/api/files/` too, since `download` contains the temporary credential. Tickets
are stored only as hashes and are invalidated by sign-out or file deletion.

Transfer progress, cancellation and completion appear in the browser or device.
A failed or cancelled download can be started again from the file card. Downloads
do not support range resume, and retrying creates a new link and starts from the
beginning. Revocation prevents new transfers; a transfer already streaming is not
interrupted.

## Backups, restore, updates

Use the built-in commands rather than copying files by hand:

```sh
slackoss-server backup  --data ./data --out ./backups/2026-09-06
slackoss-server verify-backup --from ./backups/2026-09-06
slackoss-server restore --from ./backups/2026-09-06 --data ./data
```

`backup` writes a consistent database snapshot (including anything still in the
write-ahead log), every attachment referenced by that snapshot, and a `manifest.json`
recording the schema version, checksums, and row counts from the copied database.
`--out` must be a new or empty directory outside the workspace data directory.
Stop the server first for a backup that is certain to be complete.
If an attachment disappears during capture, backup fails instead of reporting success.

`verify-backup` checks checksums, safe attachment paths, the actual database schema,
row counts, foreign keys and attachment inventory without changing a workspace.
An omitted attachment is rejected even if all listed checksums match.

`restore` verifies the backup, stages and re-verifies it beside the target, and only then swaps
it in; the previous data directory is renamed to `data.superseded-<timestamp>`
rather than deleted. Stop the server before restoring. A backup from a newer
server than the one restoring it is refused instead of half-applied.

Store backups away from the host, encrypted. For Docker, run the same commands
inside the container against the mounted volume.

Before upgrading, take a backup. Rebuild and restart with Compose; SQLite migrations
run automatically. To roll back a schema change, restore the matching backup and
previous application version together — the server refuses to open a database
newer than it understands, so an application rollback alone will not start.
Deleting a container preserves the named volume; `docker compose down -v` deletes
it, so avoid that command for real data.

There are no separate Redis, Postgres, or message broker services to maintain.
Monitor disk usage for uploads and history, resource use, health, and backups.

Schema v13 keeps a persistent queue for deleted attachments. Message and file
metadata are removed atomically; physical file removal follows the commit.
Temporary filesystem failures remain queued for retry every 15 seconds and on
restart. Cleanup handles at most 100 queued files per pass; shutdown awaits the
active pass before closing the database. A locked file can remain on disk until
cleanup succeeds, but the download API no longer serves it after deletion commits.

## Deletion and retention

### What deleting a message does

Deleting a message removes it from every channel, thread, search result, pinned
list and saved list immediately, and releases its attachments. Specifically:

- **The message itself** is kept as an empty tombstone rather than a row that is
  gone. The row holds no text, no attachment and nothing anyone wrote; what it
  still holds is an id, an author and a timestamp, which is what lets a reply
  posted under it keep resolving.
- **Replies** to a deleted thread root go with it, from everyone's point of
  view. The thread drops out of the followed list and asking for it returns
  `thread_not_found`, so deleting the message you opened a conversation with
  takes down everyone else's answers to it. Their rows, and their text, stay in
  the database — unreachable through the API, but there on disk and in a backup.
  This is worth knowing before deleting the top of a long thread: it is the one
  place where what a deletion appears to do and what it actually stores differ.
- **Attachments** are removed from the database with the message and their bytes
  are deleted from disk by a queue that retries until it succeeds. A file locked
  by the operating system can survive on disk for a few minutes; the download
  API stops serving it the moment the deletion commits.
- **Pins, saves and reactions** pointing at it are deleted outright.
- **The search index** loses the text as part of the same write. SQLite marks the
  freed index pages reusable rather than overwriting them, so the words can
  remain in unallocated space inside `workspace.db` until something else writes
  over them. `VACUUM` on a stopped server rewrites the file without them.
- **The event log** loses the text and the attachment names too. The events
  themselves stay — a missing sequence number would look to a catching-up client
  exactly like a log it had fallen off the end of, and send it back for a whole
  new snapshot — but what they replay is a message with nothing in it, followed
  immediately by the deletion.
- **Editing** a message does the same to every earlier version of it. Taking
  back a sentence by editing it away is the usual way people do it, and leaving
  the first draft in the log would make the correction cosmetic.
- **The request log** never held the text: the server logs methods, paths and
  status codes, not bodies.
- **Backups** taken before the deletion still contain the original text, in full.
  Nothing this server does reaches into a backup you have already made. If a
  deletion has to be permanent, the backups from before it have to go too.

There is no account deletion. An account can be deactivated, which ends its
sessions and stops it signing in, and what it wrote stays where it is.

### Keeping less history

```sh
slackoss-server --data ./data --retention-days 365
```

Off by default: a workspace that quietly started discarding history would be
worse than one that grows. Also settable with `SLACKOSS_RETENTION_DAYS`. The
server prints the window on every start, because a setting that deletes things
is one to be reminded of.

An hourly sweep removes conversation older than the window outright — rows,
attachments, pins, saves, reactions, and the text in the event log — rather than
hiding it. A thread ages out as one thing: a root is taken only once its newest
reply is past the window too, so nobody is left with replies hanging under
nothing. Up to 2,000 threads go per pass, so the first sweep after turning this
on does not hold the database for a minute; the rest follow on the next hour.

Nothing is announced to connected clients. These messages are old enough that no
screen is showing them, and announcing a year of deletions would put the events
into the very log this is meant to keep small. A client scrolled that far back
keeps what it already has until it next asks the server, which will not have it.

This is not reversible. Getting discarded conversation back means restoring a
backup taken before the sweep ran. Decide the window before turning it on, take
a backup, and remember that lowering it later discards everything the new window
excludes on the next hour.

The event log is pruned separately and always: only the most recent 20,000
events are kept, which is what a client resyncs against. Falling behind that is
not a loss of history — the client takes a fresh snapshot instead.

## Integration delivery

Outgoing event subscriptions use a durable queue in `workspace.db`. Each matching
delivery commits with its workspace event, then runs outside the user's request.
Failures retry eight times with increasing delays, in event order for each
subscription and in parallel across different subscriptions. Pending work resumes
when the server restarts. A successful receiver may see the same event again if the
server exits after its HTTP response but before recording completion, so receivers
must deduplicate by the stable `event_id`.

One endpoint may hold at most 500 waiting events. Delivery is ordered, so a receiver
that stops answering holds up everything behind it; without a ceiling its queue would
grow for as long as the workspace stays busy. Past the ceiling events are counted as
dropped rather than queued, and the count is shown beside the subscription. Once a
delivery has used up its attempts, the rest of that endpoint's queue is given up on
with it, so a dead receiver is not kept under load for days and an administrator
repairing it does not face a backlog that drains one event every few hours. Retrying
restores the whole queue in order. The dropped count clears once the endpoint is
delivering again, or when an administrator retries.

Apps and integrations shows pending and terminally failed deliveries. An admin can
retry failed work after repairing the endpoint. Terminal records are retained for
seven days; deleting the subscription or app deletes its queue immediately. A
deactivated bot receives no new events and its prior pending deliveries pause.
Removing a bot from a channel discards queued events for that channel, so restoring
membership does not disclose events from the revoked interval.

## Behind a reverse proxy

Set `--public-url` to the address people actually use. It is what an app is told
to send its replies to, and having it configured means nothing has to be inferred
from a request. Add `--trust-proxy` only when a proxy in front of this server
writes the `X-Forwarded-*` headers and nothing can reach the server directly:
anyone can send those headers, and without a proxy to vouch for them a forged one
would decide where an app's reply and its token went. With neither set, the server
uses the address the connection arrived on, which no header can change.

While a workspace has no owner yet, creating the first account from the machine
running the server does not need the claim code. That applies to a command line
request or to the page this server itself served, not to any page that merely has
your browser post to localhost — those carry an `Origin` naming somewhere else and
are asked for the code like anyone else.

## Request limits

One caller is held to a fair share of sign-in attempts, messages, uploads,
sockets and typing notices. Where there is an account to key on, the limit is
keyed on the account rather than the address: an office reaches this server from
a single NAT address, and everyone in it must not be sharing one person's
allowance. Only the two limits that have no account yet — sign-in attempts and
opening a socket — are keyed on the address, and both are deliberately loose.

Sign-in is rationed per handle as well, and tightly, because that is the limit an
attacker actually meets. Only wrong guesses count: a correct password clears what
the handle has spent, so someone who knows their own password never meets this
however often they sign in or change it. A refused request answers `429` with a
`Retry-After` telling the client when to come back, and nothing is charged for a
refusal, so a client that retries too eagerly does not push its own recovery out.

The allowances are held in memory, so a restart grants one fresh burst. Buckets
are dropped once they refill, which keeps the bookkeeping proportional to who is
active rather than to everyone who has ever connected.

`--no-rate-limits`, or `SLACKOSS_RATE_LIMITS=off`, turns all of this off. That is reasonable on a network where
everyone is already trusted and unreasonable anywhere reachable from outside it.
Bulk imports and seeding scripts are the usual reason to want it; prefer running
those against a server started with the flag rather than raising the limits for
everybody.

## Changing a workspace address and keeping local work

Updated clients store drafts, queued sends, scheduling recovery and recent
searches by workspace ID and account ID. Renaming the workspace or restoring its
backup preserves that ID. Before changing its address, open the old address once
with the updated client so it can associate that address with the workspace.
Legacy data can then migrate from any previously approved address, including
scheduling recovery for conversations you have not reopened. Existing stable
data takes precedence over an additional address's legacy copy.

When another address claims an identity this device already knows, the client
shows the previous and new addresses. Approve it only when you recognize the
move: continuing restores local work and may automatically send queued messages.
The ID itself is public and does not prove that a different server is trustworthy.

This works within the same desktop app profile or browser app origin. A browser
served from a new origin cannot read the old origin's localStorage. These local
items are not uploaded as drafts, included in server backups, or encrypted by
this feature. Older servers continue to use URL/account keys.

If local storage cannot be read or saved, keep the client open and use its Retry
action after resolving the problem. Unreadable browser values and malformed
desktop settings are preserved instead of being treated as empty. Repairing the
desktop settings file can be retried without restarting the app.

## Desktop saved sign-ins

Gatherline encrypts the desktop app's saved sign-ins using Electron's
[OS-backed safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
Windows uses the current OS account's protection; macOS uses Keychain and Linux
needs a supported secret store. Linux's `basic_text` fallback is refused. On
macOS, consistent application signing is needed for reliable Keychain behavior
across updates.

An old plaintext sign-in list is migrated on its next successful read or settings
write. The original remains intact if encryption or replacement fails; it is
still plaintext until migration succeeds. New credentials are never saved with
a plaintext fallback. A failed save leaves the current session usable and shows
Retry saving. Unlock the system key store and retry before closing if you want
the new sign-in remembered.

If saved sign-ins cannot be unlocked, the app offers Retry or a confirmed Forget
saved sign-ins action. Forgetting removes only the saved sign-ins, so you can
authenticate again while keeping drafts, queued messages and hosted workspaces.
Copying desktop settings to another OS account/machine may require signing in
again; the protected credentials depend on the original OS key store. Older
desktop builds do not understand this protected saved-sign-in format.

Drafts and other local settings remain unencrypted. This does not encrypt browser
localStorage, server data or older backups, and it does not protect credentials
from a compromised running app or another process with the same OS-account
access. Native runtime verification currently covers Windows; macOS/Linux
behavior still needs platform testing.

## Current boundaries

Friends and accounts do not federate across servers. Account settings offers password
changes and signed-in device management. Administrators can reset member passwords
from People; the owner can transfer ownership there after confirming the target handle.
Share temporary passwords privately and ask recipients to change them after sign-in.
There is no SSO, email-based account
recovery, large-call SFU, automated update service, or signed public release
pipeline yet. Test with your environment before an office-wide rollout.
