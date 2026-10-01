# Current search-query index experiment — 2 October 2026

The temporary **`messages(user_id, id DESC)` index substantially improves the rare-author search** in this fixture. The unchanged query planner does **not use `messages(created_at, id DESC)`**, so that candidate has no measured performance benefit here and should not be added as a standalone fix for old-date search.

Application code is unchanged by this experiment. Reproducible harness: [root-query-benchmark.mts](root-query-benchmark.mts). Exact SQL plans, result IDs/hashes, all timing samples, sizes and hardware are saved in [root-query-evidence.json](root-query-evidence.json).

**Merge-time caveat:** newer main through `5b0001f` adds filename matching to free-text search and attachment-kind predicates, and changes the ordinary measurement fixture's attachment distribution. These results remain pinned to `a285ee6`; they do not measure that newer search implementation. Modifier-only author/date SQL is unchanged when file-kind filters are absent by source inspection, but candidate adoption still requires new measurements, including text/file combinations.

## Method

- Source revision `a285ee6c8a67e93db01ef2d9046493ea0572a34c`; current `openDb` and `Store.searchMessages`, schema 34 and SQLite 3.53.0.
- Windows 10.0.26300 x64, Node 24.16.0, Intel Core i5-12400F, 12 logical threads, approximately 15.84 GiB physical memory. Both fixture sizes completed in **20.54 seconds**, within the two-minute work budget.
- The `scripts/measure-search.mts` fixture distributions at the reviewed `a285ee6` revision and seed-7 PRNG sequence are preserved: 50 ordinary authors plus one rare author, two years of messages, public/member-private/hidden-private channels, broad and rare words, links and files. Later versions of that script use a different attachment fixture.
- Each query returns up to 21 hydrated messages through the real Store. An independently derived reference checks **exact IDs, newest-first order and private-channel exclusion for every warmup and sample**. The hidden-only term returns zero rows. There are five warmups and 25 warm samples per measured query/variant.
- Capture the actual prepared SQL and parameters, then explain those statements. Install each candidate separately; no `ANALYZE`, forced index or application query rewrite. A candidate with no planner use is recorded but not timed. Repeat the baseline after dropping candidates.

## Observed timings

Milliseconds, p50 / p95, including synchronous Store search and hydration; excludes HTTP, UI and independent correctness assertions.

| Messages / query              |        Baseline | Author-index candidate | Baseline after dropping indexes |
| ----------------------------- | --------------: | ---------------------: | ------------------------------: |
| 50,000 / `from:@rare`         |  9.897 / 11.340 |      **0.203 / 0.309** |                  9.347 / 10.271 |
| 50,000 / old `before:` date   | 10.043 / 11.337 |        10.199 / 11.419 |                 10.781 / 15.949 |
| 50,000 / `the`                |   5.303 / 6.059 |          5.696 / 6.980 |                   5.281 / 6.316 |
| 50,000 / hidden `classified`  |   0.418 / 0.632 |          0.433 / 0.513 |                   0.414 / 0.459 |
| 200,000 / `from:@rare`        | 10.218 / 11.685 |      **0.192 / 0.366** |                 13.147 / 14.631 |
| 200,000 / old `before:` date  | 50.659 / 59.142 |        55.341 / 71.220 |                 57.177 / 74.340 |
| 200,000 / `the`               |  9.069 / 11.635 |        15.087 / 31.534 |                 11.403 / 30.560 |
| 200,000 / hidden `classified` |   7.508 / 9.368 |          8.428 / 9.755 |                  9.641 / 12.555 |

`before:` is the UTC day 30 days after the fixture begins. Visible matching cardinalities are 25/98 for the rare author, 2,005/7,990 for the old date, 29,574/118,315 for `the`, and zero for the hidden term at 50,000/200,000 messages. Nonempty pages contain 21 messages in every variant.

## Planner and storage decisions

For the rare-author query, the baseline uses the handle index to locate the user, then **scans the message ID index**. The candidate changes that step to:

```text
SEARCH m USING INDEX idx_diag_messages_author_page (user_id=?)
```

The author index is used only by `from:@rare` among these four shapes. Its exact `dbstat` allocation is **423 pages / 1,732,608 bytes** at 50,000 messages and **1,719 pages / 7,041,024 bytes** at 200,000: approximately 1.65/6.71 MiB, or about 16% of the baseline live database allocation. Single-run creation costs were 26.08/127.99 ms. These are observed build costs, not migration latency guarantees.

For the old-date query, both the baseline and time-index candidate retain:

```text
SCAN m USING INDEX sqlite_autoindex_messages_1
```

The time index is unused by all four actual query plans at both sizes. It still allocates **461 pages / 1,888,256 bytes** and **1,864 pages / 7,634,944 bytes** (approximately 1.80/7.28 MiB). Its timed comparison is deliberately skipped. Improving this shape requires a query/planner experiment before selecting an index. Do not infer that a creation-time index inherently speeds the current ordered query.

Live pages return to their baseline count after dropping candidates. Physical files retain freed pages, so evidence records both active allocation and physical growth rather than equating file size with a still-live index.

**Decision:** retain the author index as a promising isolated diagnostic candidate for OPT-11. Before a production migration, test realistic multi-author/scoped/cursor queries, insert/edit/retention overhead, migration behavior and balanced before/after workloads. Reject the unused time index as a standalone change to the current query. No production index was added.

The 200,000-message control timings drift noticeably across the run, including after removing candidates. Broad-text p50 is higher with the candidate, but its after-drop tail also remains elevated; this run cannot attribute that difference confidently to the index. The rare-author effect is much larger than the observed control drift. No general throughput, write-cost, cold-cache, main-process responsiveness or capacity claim follows from these warm Store timings.

## Reproduce and cleanup

```powershell
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-deep/root-query-benchmark.mts
```

Optional smaller run: append `--messages=50000`; the default is `50000,200000`. The harness writes only its sibling JSON artifact and uniquely named OS temporary fixtures. Before recursive deletion it closes SQLite and verifies the resolved absolute directory, temporary-root containment, direct parent, owned-name prefix and real path. Only directories created by this process are removed. No live data or repository application files are changed.
