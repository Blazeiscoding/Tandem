# Follow-up plan measurements

The evidence for the measurements the 2026-10-02 follow-up plan left open after its code was merged. Everything was measured on one Linux host (4-core Intel Xeon at 2.80 GHz, 16 GiB, Node 24.21), so these are comparisons between revisions on that host, not reference-hardware figures.

## F10 and F11: publication

[`scripts/measure-publication.mts`](../../../scripts/measure-publication.mts) runs a real server on a disk database. "Before" is `0fc401a`, the commit before F10/F11. "After" is the branch, whose server code is that of `main` at `b787878`. Each side ran twice.

- [`publication-before-*.json`](publication-before-1.json) and [`publication-after-*.json`](publication-after-1.json): 25 rounds per case after three warm-ups.
  - F10 case: deleting a thread root with 20 replies, which makes 21 deletion events, in private channels of 50, 500 and 2,000 members. Timed with nobody connected and with two members connected.
  - F11 case: posting to a channel whose one app has 1, 10 and 100 subscriptions.
- [`posting-300-*.json`](posting-300-before-1.json): the posting case again, with 300 rounds, because 25 rounds left it within noise.

| Case                                 | Before (median ms) | After (median ms) |
| ------------------------------------ | -----------------: | ----------------: |
| 2,000 members, nobody online, DELETE |        41.9 / 42.2 |         7.9 / 7.5 |
| 2,000 members, two online, frames    |        52.2 / 45.0 |       14.9 / 14.8 |
| 500 members, nobody online, DELETE   |        17.7 / 16.1 |         7.7 / 7.6 |
| 50 members, nobody online, DELETE    |         9.7 / 10.8 |         7.6 / 8.7 |
| 100 subscriptions, POST (300 rounds) |        14.6 / 15.3 |       13.2 / 13.3 |
| 1 and 10 subscriptions, POST         |    no clear change |                   |

## F13: search

[`scripts/measure-search.mts`](../../../scripts/measure-search.mts) seeds 200,000 messages and 22,000 files. Each query is timed 25 times after five warm-ups. The script prints a hash of each page, so runs on two revisions show whether they found the same messages.

- [`search-before-*.txt`](search-before-1.txt): `main`.
- [`search-after-*.txt`](search-after-1.txt): with F13.

All 26 queries return identical pages on both revisions. The F13 row of the [plan's status table](../../IMPROVEMENT-PLAN-2026-10-02-FOLLOWUP.md#implementation-status--2026-10-02) summarizes the timings.

## F15: desktop start and memory

[`scripts/measure-desktop-start.mts`](../../../scripts/measure-desktop-start.mts) launches two packaged builds in turn, each on a fresh profile, under Xvfb.

The builds are the same `main` tree packaged for Linux twice: with the F15 filter (a 7.41 MB archive) and without it (11.19 MB). [`desktop-start-1.json`](desktop-start-1.json) and [`desktop-start-2.json`](desktop-start-2.json) hold 15 rounds each.

There is no difference beyond noise in launch time, time to start hosting, or memory.

## Reproducing

From the repository root, with nothing else running:

```sh
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-publication.mts --rounds=25
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-publication.mts --rounds=300 --only=posting
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-search.mts
xvfb-run -a node --experimental-strip-types scripts/measure-desktop-start.mts \
  --a=<package with the filter>/@slackossdesktop --b=<package without it>/@slackossdesktop --rounds=15
```

To compare with an earlier revision, run the same script from a checkout of that revision.
