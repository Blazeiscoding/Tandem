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

## The client

What someone opening the web client waits for, and what scrolling back
through a picture-heavy channel costs the page. Measured by
[`scripts/measure-client.mts`](../../../scripts/measure-client.mts) in headless
Chromium against a server in the same process; build the web client first.

```
pnpm --filter @slackoss/web build
pnpm --filter @slackoss/server exec tsx ../../scripts/measure-client.mts --out=client.json
```

Defaults: seed 1, 400 messages in #general, and #gallery with 60 pictures
(1024×768 PNGs with seeded grain, 111.5 MiB in all, 3 MiB each decoded), each
followed by a text message; 5 rounds, a 1280×800 window. The reader signs in
once through the client and every round starts a fresh profile from that
storage.

- **First usable conversation:** from navigation to #general's composer being
  ready with the newest message on screen; cold is a fresh profile (no HTTP
  cache), warm a reload of it. With the bytes over the wire and requests.
- **Picture scroll:** from #gallery's newest message, scrolling up 90% of a
  screen every 16 ms until its first picture is on screen; with the main
  thread's long tasks (over 50 ms), frames over 50 ms, the JavaScript heap
  before and after, and how many pictures the page still holds at the end (the
  client lets go of pictures far off screen).

### This machine

Two runs on revision `85aa1dbcc96e` plus the uncommitted script (hence
`dirty: true`), the same 4-core Xeon as above, Chromium 141.0.7390.37. No
errors in either.

| Measure                      | Run 1 p50 | Run 1 p95 | Run 2 p50 | Run 2 p95 |
| ---------------------------- | --------: | --------: | --------: | --------: |
| First usable, cold (ms)      |       398 |       435 |       376 |       395 |
| First usable, warm (ms)      |       280 |       326 |       212 |       247 |
| Transfer, cold (KiB)         |     151.2 |     151.2 |     151.2 |     151.2 |
| Transfer, warm (KiB)         |      21.7 |      21.7 |      21.7 |      21.7 |
| Scroll to first picture (ms) |     4,244 |     5,668 |     3,961 |     4,281 |
| Long tasks per scroll        |         1 |         2 |         1 |         2 |
| Longest task (ms)            |        55 |        59 |        54 |        59 |
| Heap before scroll (MiB)     |      12.2 |      12.5 |      12.4 |      12.8 |
| Heap after scroll (MiB)      |      19.9 |      31.2 |      25.9 |      35.1 |

A cold open takes 8 requests and 151 KiB (the compressed client, REV-13); a
warm one 22 KiB, the hashed assets coming from cache. No frame over 50 ms was
seen while scrolling, and at the top the page held 1–2 pictures. Headless
Chromium paints without a GPU, so frame timing here says little about a real
screen; the reference is a run on low-spec hardware with a display, and the
desktop app's main-process stalls and GPU memory need Electron (see the plan's
local verification).
