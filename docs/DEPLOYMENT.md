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

## Current boundaries

Friends and accounts do not federate across servers. Account settings offers password
changes and signed-in device management. Administrators can reset member passwords
from People; the owner can transfer ownership there after confirming the target handle.
Share temporary passwords privately and ask recipients to change them after sign-in.
There is no SSO, email-based account
recovery, large-call SFU, automated update service, or signed public release
pipeline yet. Test with your environment before an office-wide rollout.
