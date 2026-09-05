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

## Backups, restore, updates

Stop the server before copying its complete data directory: database, WAL files
if present, and `files/`. For Docker, stop the Compose service and export the named
volume using your normal volume backup tooling, then start the service again.
Store encrypted backups away from the host and test restoring into an isolated
workspace. Never copy only a live SQLite main file and assume it is complete.

Before upgrading, take a backup. Rebuild and restart with Compose; SQLite migrations
run automatically. To roll back a schema change, restore the matching backup and
previous application version together. Deleting a container preserves the named
volume; `docker compose down -v` deletes it, so avoid that command for real data.

There are no separate Redis, Postgres, or message broker services to maintain.
Monitor disk usage for uploads and history, resource use, health, and backups.

## Current boundaries

Friends and accounts do not federate across servers. There is no SSO, account
recovery workflow, large-call SFU, automated update service, or signed public release
pipeline yet. Test with your environment before an office-wide rollout.
