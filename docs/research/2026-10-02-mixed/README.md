# Mixed workload baseline (IMP-07)

What one server does when people post in several channels while others search,
devices drop and catch up, and a retention sweep runs, all at once. Measured by
[`scripts/measure-mixed.mts`](../../../scripts/measure-mixed.mts); compare two
builds by running it on each, on the same machine, with the same seed.

```
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-mixed.mts --out=run.json
```

Defaults: seed 1, 12 people with 2 devices each (24 sockets, plus 2 roaming),
20,000 seeded messages over 180 days in 4 channels everyone is in, 3 rounds of
8 seconds. In each round 4 people post every 40–120 ms, 2 search every
100–300 ms for a mix of common and rare words, 2 extra devices drop every
0.5–1.5 s and catch up from their last sequence, and a retention sweep with
attachment cleanup runs halfway through. A post counts as delivered when every
one of the 24 devices has it; fan-out is from the request to the last device.

Each artifact records the revision (and whether the tree had changes), seed and
parameters, machine and runtime, and per measure the samples, p50/p95/p99/max,
each round's p95 and their spread, and errors; then event-loop delay by round
(sampled every millisecond, so idle reads about 1 ms) and memory.

## This machine

Two runs of revision `54296c3a9eeb`, a 4-core Intel Xeon at 2.8 GHz with
15.7 GiB, Linux, Node 24.21.0, shared cloud hardware. Milliseconds, no errors
in either.

| Measure     | Run 1 p50 | Run 1 p95 | Run 2 p50 | Run 2 p95 | Samples |
| ----------- | --------: | --------: | --------: | --------: | ------: |
| Post        |      7.52 |     19.79 |      7.49 |     20.55 |  ~1,065 |
| Fan-out     |      7.02 |     19.03 |      7.04 |     19.29 |  ~1,065 |
| Search      |     11.47 |     27.45 |     11.84 |     24.18 |    ~225 |
| Reconnect   |      4.77 |     31.31 |      5.50 |     16.29 |     ~50 |
| Maintenance |      6.66 |      9.99 |      6.70 |     10.22 |       3 |

Event-loop delay p99 was 9.7–11.4 ms in every round, with a longest single
delay of 37–53 ms. RSS grew from about 326 MiB to 391 MiB over each run.

Posting, fan-out and search repeat within a few percent at p50 and about 10%
at p95. Reconnect p95 rests on about 50 samples a run and moves by half, so
compare it over more rounds (`--rounds=10`) before reading anything into it.
These numbers are a reference for this machine only; the reference for
decisions is a run on low-spec hardware (see the plan's local verification).
