# Security

This is early-stage software. Before exposing a workspace to the internet, create
its owner account over a trusted connection, require invites, and configure HTTPS.
The first registrant owns a fresh server; do not expose an unclaimed server publicly.

Report vulnerabilities through the repository's private security advisory feature
if enabled. Otherwise contact a repository maintainer privately to arrange a report.
Do not post credentials, private workspace data, or unpatched exploit details in a
public issue. There is currently no formal security audit or support SLA.

Accounts and friendships belong to a workspace. The host can read stored messages,
files, and account metadata. Chat storage is not end-to-end encrypted. WebRTC media
uses encrypted transport, but participants may record it. Use trusted STUN/TURN
services; their operators can observe connection metadata.

Keep Node, Electron, Docker base images, and dependencies updated. Preserve backups
before upgrades. See [deployment instructions](docs/DEPLOYMENT.md).
