# Measured

The numbers `bun run bench --save` printed, on the machine named below: all eight benchmarks, three
rounds run round-robin, each leg the median of its three per-round values. The run is saved as
`bench/results/2026-10-22-bf52584-dirty.json` (the uncommitted diff was the round-robin runner
itself, nothing measured), so the next run has something to compare against:

```sh
bun run bench                       # all eight, three rounds, then the §10 and phase-1 tables
bun run bench --quick               # fewer iterations and one round
bun run bench --only wal            # driver | wal | tenant | http | replication | storage | fsync | bus
bun run bench --rounds 5 --save     # five rounds, saved to bench/results/<date>-<sha>.json
bun run bench --save --label ack-local    # a variant, saved under its own name
bun run bench --strict              # exit 2 if the load is above 4 or a runaway process is found
bun run bench:compare bench/results/old.json bench/results/new.json
```

Each benchmark runs as its own process, and `bench/http.ts` spawns a second one for the load, so
the client never shares an event loop with the server. A missed budget is a WARN, never a build
failure. The one hard gate is the driver's own point-read target, which `bench/driver.ts` enforces
itself.

**Spread** is `(max - min) / median` across the three rounds. Above 10% the runner flags a leg
`noisy`, and `bench:compare` calls any change inside the larger of two runs' spreads `~` rather than
a regression or a win. `docs/bench-repeatable.md` has the reasoning; `docs/performance.md` §8 has
the history of this file being wrong.

## Machine

| | |
|---|---|
| CPU | Apple M5 Pro, 18 cores |
| memory | 52 GB |
| platform | darwin/arm64 (macOS 27.0.1) |
| filesystem | APFS |
| Bun | 1.4.0 |
| SQLite | 3.53.4, vendored by `bun run sqlite:build` |
| `ulimit -n` | 1 048 576 |
| load | 1.85 before, 2.98 after; no runaway processes |
| recorded | 2026-10-22, at `bf52584` |

## Design §10 performance budget

| path | measured | spread | budget | verdict |
|---|---|---|---|---|
| point read, in process (plan M2) | 0.74 µs | 7.1% | ≤ 1.20 µs | **PASS** |
| point read over HTTP keep-alive | 54.3 µs | 57.9% | ≤ 60 µs | **PASS**, loosely |
| point read over WebSocket | 30.2 µs | 1.0% | ≤ 35 µs | **PASS** |
| single-row write, `ack: local`, incl. tail+log | 22.4 µs | 2.8% | ≤ 40 µs | **PASS** |
| write visible on a replica | 252.7 µs | 5.3% | ≤ 1 ms | **PASS** |
| write visible on a replica, no transport | 211.7 µs | 1.6% | ≤ 1 ms | **PASS** |
| live-query invalidation → event on socket | 22.9 µs | 33.7% | ≤ 200 µs | **PASS** |
| tenants open per process | 10 000 | 0% | ≥ 10 000 | **PASS** |
| throughput, mixed 90/10, HTTP | 33 331 req/s | 17.3% | ≥ 50 000 req/s | **WARN** |
| throughput, mixed 90/10, WebSocket | 61 282 msg/s | 2.9% | ≥ 150 000 msg/s | **WARN** |

What each row is:

- **The write budget is the in-process path**, which is what design §10 says ("incl. tail+log"):
  `bench/tenant.ts` through the tenant owner at `ack: "local"`. At the default `ack: "fsync"` the
  same write is 62.6 µs.
- **The HTTP point read's 58% spread is one round.** Rounds one and three measured 54.1 and 54.3
  µs, round two 85.6. The median is the number, and a single run would have reported either.
- **"Write visible on a replica" is two whole servers over a loopback socket**, and the row beneath
  it is `bench/wal.ts`, the same path with the transport taken out.
- **Live-query invalidation is derived**: the write-to-event round trip on a second socket minus a
  bare write over the same socket.

### The two WARNs, and why they are worse than the 2026-09-12 run

That run recorded 53 752 req/s over HTTP and 130 315 msg/s on a WebSocket. Two things changed.

**`bench/http.ts` measures at the server's default ack**, and the default has been `fsync` since
2026-09-13. Its legs are still labelled "ack local", which is what they measured when they were
named. Every write in the 90/10 mix now pays an `fdatasync`. `BQL_DEFAULT_ACK=local` puts the old
setting back (`bench/results/2026-10-22-bf52584-dirty-http-ack-local.json`):

| leg | default (`fsync`) | `BQL_DEFAULT_ACK=local` | 2026-09-12 |
|---|---|---|---|
| point read, HTTP keep-alive | 54.3 µs | 53.6 µs | 48.2 µs |
| single-row write, HTTP | 130.7 µs | 83.7 µs | 78.9 µs |
| single-row write, WebSocket | 92.7 µs | 59.8 µs | 61.3 µs |
| throughput, mixed 90/10, HTTP | 33 331 req/s | 32 442 req/s | 53 752 req/s |
| throughput, mixed 90/10, WebSocket | 61 282 msg/s | 83 752 msg/s | 130 315 msg/s |

**The latency legs at `ack: local` are back where they were; the throughput legs are not.** HTTP
throughput doesn't move with the ack level at all, so the ack is not what took it from 54k to 33k.
I don't know yet what did. It is the one number in this file that needs a bisect, with
`bun run bench --only http --rounds 5 --save` at each end and `bench:compare` between them.

## Phase 1: routing, durability, Hrana and the shipper

Design §10 budgets none of these, so they are printed with the number they should be read against.

| path | measured | read against | difference |
|---|---|---|---|
| write on the primary (HTTP) | 362.5 µs | — | the reference: a replica attached and streaming |
| write forwarded through a replica | 384.7 µs | 362.5 µs | +22 µs for the round trip to the primary and back |
| write, `ack: replica` | 366.3 µs | 362.5 µs | +4 µs |
| write, `ack: quorum` | 359.3 µs | 362.5 µs | inside the 5% spread of the reference |
| point read, Hrana pipeline | 50.2 µs | 54.3 µs | 4 µs faster than the native route, inside the native route's spread |
| write, Hrana pipeline | 114.5 µs | 130.7 µs | 16 µs faster; I suspect the native write route does work the pipeline skips, not checked |
| records shipped to S3 per second | 12 346 rec/s | — | commit to bucket, against the in-process fake |
| pushed to S3 | 7.40 MiB/s | — | |
| one commit to the bucket | 249.3 µs | — | steady state, `flush()` included |

`bench/replication.ts` runs both nodes and the client on one event loop and waits for the replica
to apply each write before the next, so its primary write carries the replica's work. Since the
default became `ack: "fsync"`, the primary pays an `fdatasync` on every write either way, which is
why `ack: replica` now costs almost nothing over it. Compare inside a table, not across them.

The S3 rate is down from 28 790 rec/s in the 2026-09-12 run. I suspect the same default change:
the shipper can only ship what has been committed, and `bench/storage.ts` writes through
`tenant.write` at whatever the server's default is. Not checked with `BQL_DEFAULT_ACK=local`, since
the benchmark passes `env: {}` to `loadConfig` and ignores it.

## Driver — `bench/driver.ts`

The `bun:ffi` driver on 100 000 rows. µs per operation, median of three rounds. The `bun:sqlite`
column comes from three separate runs of `bun run bench:driver` straight after, since the runner
records only bql's side.

| op | bql | spread | bun:sqlite | ratio |
|---|---|---|---|---|
| point read by primary key → object | 0.74 | 7.1% | 0.76 – 0.80 | 1.01 – 1.09x |
| point read, 3 columns | 0.76 | 3.7% | 0.79 – 0.84 | 1.03 – 1.11x |
| point read, 3 columns, `values()` | 0.78 | 3.6% | 0.83 – 0.86 | 1.08 – 1.11x |
| 100-row scan → objects | 8.33 | 3.9% | 10.75 – 11.84 | 1.30 – 1.41x |
| insert inside a transaction | 0.25 | 0.5% | 0.24 | 0.97x |
| insert inside a transaction, update hook on | 0.31 | 5.3% | not available | — |
| single-row autocommit insert (WAL, `synchronous=NORMAL`) | 5.26 | 5.5% | 5.20 – 5.42 | 0.97 – 1.03x |

The 2.30x point-read lead of the 2026-09-12 run is gone: `bun:sqlite` went from 1.77 µs to under
0.8 between Bun releases, while bql stayed at 0.74. The scan went the other way and is now bql's
largest lead. The README carries these as ratio ranges.

## WAL shipping — `bench/wal.ts`

500 transactions of 5 rows, primary and replica in one process with no transport, replica position
fsynced on every transaction, mechanism A (`"pages"`, the default since C5). µs.

| leg | p50 | spread |
|---|---|---|
| primary commit | 12.3 | 1.0% |
| tail + checksum chain | 4.75 | 9.6% |
| encode, zstd level 3 | 11.0 | 2.3% |
| log append | 3.42 | 4.9% |
| decode | 5.29 | 3.1% |
| replica apply, incl. `fdatasync` | 166.0 | 1.2% |
| replica read sees the row | 6.33 | 3.9% |
| **end to end** | **211.7** | 1.6% |

Everything bql.sh controls costs about 40 µs a transaction; the rest is the fsync.
`bun run bench/wal.ts each wal` measures mechanism B, which `docs/c5-apply-pages.md` compares.

## Replication over a socket — `bench/replication.ts`

A primary and a replica, each a whole server with its own data directory and listener, in one
process on loopback. 300 single-row transactions timed one at a time, then 2 000 records streamed.
µs.

| leg | p50 | spread |
|---|---|---|
| primary write (HTTP) | 362.5 | 5.1% |
| commit → replica applied | 252.7 | 5.3% |
| write forwarded via replica | 384.7 | 1.4% |
| write, `ack: replica` | 366.3 | 4.1% |
| write, `ack: quorum` | 359.3 | 3.1% |
| records applied per second, sustained | 3 802 | 3.6% |

Both nodes share one event loop, so 3 802 records/s is the pair's combined ceiling rather than each
node's. The benchmark fails if the two checksums differ at the end.

## Shipping to S3 — `bench/storage.ts`

2 000 single-row records committed while the shipper runs on its 25 ms timer, then 200 more one at
a time with a `flush()` after each, against `test/storage/fake-s3.ts` in this process. That
measures bql.sh's side (batching, the segment layout, the manifest write, `Bun.S3Client`'s request
path) with the network taken out.

| leg | value | spread |
|---|---|---|
| records shipped/s, commit to bucket | 12 346 | 4.3% |
| pushed to the bucket | 7.40 MiB/s | 4.1% |
| one commit to the bucket, p50 | 249.3 µs | 0.7% |

## Tenant write path — `bench/tenant.ts`

2 000 rounds of one-row transactions through the tenant owner: `BEGIN IMMEDIATE` → `COMMIT` → tail
→ record → log append → position save. µs.

| leg | p50 | spread |
|---|---|---|
| `write`, `ack: "local"` | **22.4** | 2.8% |
| `write`, `ack: "fsync"`, the default | 62.6 | 2.3% |
| the `BEGIN IMMEDIATE`…`COMMIT` alone | 7.21 | 1.2% |
| `readSync`, point read by primary key | 0.92 | 0.1% |
| `read`, the same through a promise | 0.92 | 4.5% |
| cold open (an LRU miss) | 318.1 | 2.1% |
| close | 118.7 | 1.5% |

**10 000 tenants created and held open**, with nothing evicted. At roughly 7 file descriptors per
open tenant that needs about 70 000 of the 1 048 576 this machine allows; a host with the common
1 024 soft limit reaches about 140 tenants before `maxOpen` has to come down, and the registry warns
about exactly that at startup.

## HTTP, WebSocket and Hrana — `bench/http.ts`

2 000 rounds, server and load client in separate processes, at the default `ack: "fsync"`. µs
unless stated. The "ack local" in the leg names is stale, see above.

| leg | p50 | spread | budget |
|---|---|---|---|
| point read, HTTP keep-alive | 54.3 | 57.9% | ≤ 60 |
| point read, HTTP keep-alive, minted token | 54.8 | 9.9% | — |
| single-row write, HTTP | 130.7 | 8.5% | — |
| `healthz`, HTTP | 40.4 | 2.3% | — |
| point read, Hrana pipeline | 50.2 | 2.2% | — |
| single-row write, Hrana pipeline | 114.5 | 0.5% | — |
| point read, WebSocket | 30.2 | 1.0% | ≤ 35 |
| single-row write, WebSocket | 92.7 | 4.2% | — |
| write → live event on another socket | 117.2 | 4.6% | — |
| live-query invalidation → event on socket | 22.9 | 33.7% | ≤ 200 |
| throughput, mixed 90/10, HTTP | 33 331 req/s | 17.3% | ≥ 50 000 |
| throughput, mixed 90/10, WebSocket | 61 282 msg/s | 2.9% | ≥ 150 000 |

`healthz`, the same transport with no SQLite, is the floor of every HTTP number here. A minted
token costs nothing measurable over the admin key. On Linux the two processes are pinned to
different CPUs with `taskset`; macOS has no equivalent.

## Many databases at once — `bench/fsync.ts`

L5's instrument, at the defaults (`fsyncSweep = "per-db"`, `ack: "fsync"`). `docs/l5-fsync-sweep.md`
reads these.

| tenants | writes/s | fsyncs/s | commit latency p50 | spread |
|---|---|---|---|---|
| 1 | 8 505 | 17 009 | 107.9 µs | 21.7% |
| 10 | 11 185 | 22 369 | 484.6 µs | 12.5% |
| 100 | 11 713 | 23 426 | 4 287 µs | 12.2% |
| 500 | 11 918 | 23 836 | 20 164 µs | 6.5% |

Two fsyncs per write at every rung, and the disk's barrier rate sets the ceiling: past ten tenants
throughput stays near 12k writes/s and latency grows with the queue. The low rungs are the noisiest
legs in the suite.

## Bus — `packages/bus/scripts/bench.ts`

Publish one at a time, claim 100 at a time, ack each one, on a bql.sh database. Two rounds of each
ack level per suite round, alternating which goes first. Operations per second.

| mode | ack | publish | claim | ack |
|---|---|---|---|---|
| in-process | `fsync` | 9 028 | 60 465 | 8 599 |
| in-process | `local` | 17 437 | 66 411 | 15 177 |
| HTTP | `fsync` | 5 954 | 51 864 | 6 115 |
| HTTP | `local` | 8 222 | 54 346 | 8 222 |

Every spread is under 10% except HTTP claim at `fsync` (14.3%). A claim is one transaction for 100
messages, which is why it is six times a publish.

## Realtime fan-out

Not part of `bun run bench`. It is asserted by `test/realtime/facade.test.ts`, which fails if it
regresses: with 1 000 live subscriptions across 10 tables, one commit touching one table costs
0.018 ms median inside `afterCommit`, against a 2 ms budget.
