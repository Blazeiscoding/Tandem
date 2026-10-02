# Current performance observations and candidate decision

Source: **`f07ce84362257aedeab16c9ae4c2361193eb6442`**. Windows 10.0.26300 x64, i5-12400F (12 logical CPUs), 15.8 GiB, Node 24.16.0. Builds/package regression work completed before the search comparisons; no concurrent build or test suite ran during them. These are local warm observations, not low-spec or Electron-main certification.

## Search: keep a selective prototype, reject a global rewrite

The [harness](root-search.mts) starts from the current `scripts/measure-search.mts` fixture: 200,000 messages over two years, 50 ordinary authors plus a rare author, public and two private channels, common/rare/hidden words, 1% attached files across five kinds and 2% links. It seeds an owned disposable SQLite directory, verifies absolute ownership before cleanup, and changes no application source or schema.

Twenty production query shapes are recorded as baseline. Fifteen candidate comparisons additionally check exact ordered IDs against an independent JavaScript fixture reference and compare complete hydrated messages against the production Store. Cases cover positive/negative author filters, channel/date modifiers, a cursor, hidden-channel exclusion and selected filename/PDF combinations. The reference's token comparison applies to the simple ASCII words in this fixture; it is not a replacement tokenizer specification.

Each pair receives five warmup calls, then 15 samples in alternating order. Both measured calls construct SQL, prepare statements and hydrate results. Query plans/reference work stays outside timing. The candidate merges **message IDs** found through FTS and filename matches; no index migration is made.

| Query                    | Production p50 A / B (ms) | Candidate p50 A / B (ms) | Decision                       |
| ------------------------ | ------------------------: | -----------------------: | ------------------------------ |
| `budget`                 |               5.18 / 4.81 |              1.08 / 1.07 | Promising filename-heavy shape |
| `contract pdf`           |               4.88 / 5.01 |              1.14 / 1.18 | Promising filename-heavy shape |
| `contract type:pdf`      |               5.34 / 5.23 |              0.97 / 1.09 | Promising selected combination |
| `zebra`                  |               0.54 / 0.58 |              0.54 / 0.54 | No meaningful established gain |
| Hidden-only `classified` |               9.49 / 9.10 |            21.87 / 19.91 | Reject this path               |
| Common `the`             |             11.35 / 11.92 |          112.29 / 111.08 | Reject this path               |
| `the in:#small-3`        |             13.96 / 11.79 |          125.40 / 109.72 | Reject this path               |
| `the before:2025-01-01`  |             96.33 / 92.63 |          176.33 / 173.84 | Reject this path               |

Raw [run A](root-search.json) / [run B](root-search-repeat.json) contain all samples, production and candidate plans, equality assertions and machine metadata. Fifteen-sample p95 is effectively the **maximum observed sample**, so it is not used as a robust tail estimate.

**Decision:** do not replace the production search globally. Prototype a selected sparse/name-heavy branch, keeping the current common-word window and measured ACL-selective controls. The candidate omits the production match-count/window heuristic, which is intentional in this experiment and explains part of the common-word cost. Selector cost and a complete integrated branch must be measured before implementation is accepted.

The initial rowid-UNION shape was slower because its observed plan scanned the message table to resolve filename joins; [initial results](root-search-initial.json) retain that rejected diagnostic. The later message-ID shape avoids that particular join. SQLite can already combine indexed OR terms; a UNION rewrite needs plans and actual workload measurements, rather than an assumption that OR means a full scan. [SQLite query planner documentation](https://www.sqlite.org/queryplanner.html#or_connected_terms_in_the_where_clause).

The current production baseline still measures rare-author `from:@rare` at **11.7 / 12.5 ms** p50 and an old date-only query at **50.3 / 52.0 ms**. Those are carry-forward query/index candidates from the earlier plan, not newly established defects. This review adds no author/date index and claims no write/storage tradeoff result.

**Remaining acceptance:** DM/private ACLs, actual deleted/multi-file messages, punctuation/escaping/Unicode/phrase behavior, reordered rowids, realistic filename/text overlap and densities, cold/reference hardware, mixed concurrent traffic and branch selection overhead. Candidate helper refuses unsupported `has:` filters and supports only the tested PDF type. Do not promote it as a general implementation.

Reproduce sequentially from the repository root with other runtime work idle:

```powershell
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-post-implementation/root-search.mts
pnpm --filter @slackoss/server exec tsx ../../docs/research/2026-10-02-post-implementation/root-search.mts --out=root-search-repeat.json
```

## Mixed workload: useful observations, incomplete acceptance

The unmodified current `scripts/measure-mixed.mts` runs twice with seed 1, 12 people × two fixed devices, 20,000 seeded messages and three nominal eight-second rounds. Chat/search/reconnect/maintenance overlap. Extra roaming devices are separate from the 24 fixed receipt-checked devices.

| Measure                     | A p50 / p95 (ms) | B p50 / p95 (ms) |
| --------------------------- | ---------------: | ---------------: |
| Post                        |     7.34 / 20.66 |     7.65 / 24.68 |
| Receipt on 24 fixed devices |     6.96 / 19.23 |     7.25 / 23.24 |
| Search                      |    11.01 / 23.92 |    11.07 / 30.22 |
| Reconnect to `synced`       |     5.29 / 30.60 |     7.02 / 26.03 |

Both have zero recorded errors. Maximum Node event-loop delay is **51.18 ms** in A and **195.95 ms** in B. B's maximum post is **227.24 ms**; post round-p95 spread reaches **61.6%**, reconnect spread **169.7%**. Only three maintenance samples exist per run. Do not infer tight tails or stable capacity from these rounds.

Raw [A](root-mixed.json) / [B](root-mixed-repeat.json), with [method review](client-mixed-method-review.md). The fixture performs zero history/attachment deletions, does not verify exact reconnect replay, seeds artificial sequence relationships and retains benchmark-client maps/sockets. Consequently process RSS growth includes harness ownership; it cannot be labeled a server leak. The long pause's cause has not been assigned. The combined process also contains HTTP/socket clients and is not Electron main.

No build or full test suite ran during these mixed observations. Small diagnostics and documentation were also being completed during the overall collection, and exact isolation was not instrumented. These are two observations of current code, not a controlled candidate speedup comparison.

The script's generic `dirty:true` sees untracked research and the pre-existing private audit directory. Tracked application code was unchanged; fresh artifact manifests record source-input dirty false.

**Next:** fix workload/replay correctness and harness lifetimes (F12), then collect quiet repeated reference measurements and profile persistent stalls. Backend isolation, caching/index migrations or image-decoding architecture require that evidence first.

```powershell
$out = Join-Path (Get-Location).Path 'docs/research/2026-10-02-post-implementation/root-mixed.json'
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-mixed.mts "--out=$out"
```

No fresh headless browser automation benchmark was launched for this audit. Interactive browser work used T3's product-native preview; existing repository browser/desktop suites were run as regression checks. Physical/headed client, desktop-main/GPU and low-spec acceptance remains open.
