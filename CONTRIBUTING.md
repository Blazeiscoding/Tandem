# Contributing

Develop each improvement on a branch and open a pull request against `master`.
Describe the user-visible change, validation performed, and any remaining limits.
Review the complete diff, resolve known issues within the PR's scope, and wait for
the applicable GitHub checks before merging. Keep unrelated follow-up work in
separate PRs rather than expanding a finished change indefinitely. After merging,
start the next branch from the updated `master`.

CI runs on pull requests and on updates to `master`; feature-branch pushes do not
create duplicate runs. A newer run for the same PR supersedes an older one. A
manual workflow dispatch is available when a branch needs checking before a PR.
If new tests are explicitly deferred for a development phase, record that limit
in the PR. Keep existing CI checks enabled and distinguish passing existing tests
from coverage of the new behavior.

Use Node 24+ and pnpm 10.23.0 (`corepack enable`). Install with
`pnpm install --frozen-lockfile`, then run `pnpm format`, `pnpm build`,
`pnpm typecheck`, and `pnpm test` before submitting a pull request. CI checks
formatting, so an unformatted file fails the build rather than starting an
argument in review.

Browser checks: `pnpm exec playwright install chromium`, then `pnpm test:e2e`
after building. Windows checks: `pnpm --filter @slackoss/desktop package --win`,
then `pnpm test:desktop`. These tests use temporary workspaces and fake media.

Docker checks: `docker build -f docker/Dockerfile -t slackoss:local .`, then
`node tests/docker-smoke.mjs`. The smoke test starts an isolated container,
tests restart persistence and 6,000 socket deliveries, and removes its test data.

Keep protocol changes compatible with existing clients where practical. Add a
new SQLite migration instead of modifying one already shipped. Test access
control with a member who should not see the affected resource. For performance
changes, include the workload, hardware, and measurement; do not claim universal
latency or memory guarantees from a local test.

This project uses the MIT license, matching the existing server package license.
Contributions are accepted under that license. SlackOSS is an independent project,
not affiliated with Slack or Salesforce.
