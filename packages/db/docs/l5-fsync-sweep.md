# L5 — one fsync sweep per thread

`docs/plan-limits.md` L5, the milestone that needed a design rather than a bound. The benchmark was
written first, as instructed, and it changed the design twice and the default once — to "leave it
alone".

## 1. The answer first

**`[durability] fsyncSweep` ships and stays `"per-db"`.** The plan's own criterion was that
`"shared"` must beat `"per-db"` at N ≥ 100 write-active databases on both p99 and barriers per
second. Measured, it wins overwhelmingly at 500 and **loses at 100**, so the criterion is not met
and the default does not move. `docs/performance.md` §9 has the tables.

| databases (`ack: "local"`) | `per-db` writes/s | `shared` writes/s | `per-db` fsyncs/s | `shared` fsyncs/s | `per-db` p99 | `shared` p99 |
|---|---|---|---|---|---|---|
| 1 | 18 231 | 19 643 | 0 | 0 | 156 µs | 125 µs |
| 10 | 32 372 | 31 624 | 0 | 0 | 0.94 ms | 1.29 ms |
| 100 | 31 715 | 31 998 | 1 008 | 1 067 | 4.09 ms | 4.52 ms |
| 500 | 23 867 | **29 407** | 4 387 | **874** | 40.6 ms | **16.9 ms** |

It is shipped rather than dropped because the 500-database row is the regime the milestone was
written for and the win there is large: 23% more throughput, a fifth of the barriers, and p99 cut
by 58%.

## 2. What the benchmark found before any code was written

Three things, in the order they mattered.

**The write path already costs exactly 2.00 barriers per transaction, and group commit already
amortises them.** At `ack: "fsync"` — the node's default — a transaction does an `fdatasync` of the
WAL and an `fsync` of the log before the caller is answered. With sixteen writes in flight per
database the ratio is 0.13 barriers per write, which is 2/16 exactly: the sixteen fold into one
transaction and pay one pair between them. So the amortisation a sweep would have provided is
already provided, by a mechanism that shipped in P2.

**This disk is fastest when barriers are issued one at a time.** 30 180 a second serial against
14 627 at a width of sixteen and 10 506 at sixty-four. No scheduler can beat inline issuing by
issuing *differently*; it can only issue less, or issue somewhere other than the event loop.

**The herd the plan predicted is real, and it is `ack: "local"`'s.** The interval policy — at most
one barrier per log per `fsyncIntervalMs`, issued inline from whichever append crosses the boundary
— produced 4 387 barriers a second at 500 databases and took p99 commit latency to 40.6 ms. The
plan said "500 write-active tenants can ask the disk for 5 000 barriers a second, scheduled by
nothing", and that is what the instrument shows.

So the sweep's target is the interval policy, and only that.

## 3. Three deviations, each forced by a measurement

**The sweep is asynchronous, and that is the load-bearing part.** The first working version swept
synchronously, which is what "walk the logs and fsync them" reads like. It was *worse* than the
inline behaviour it replaced — 14.1 ms p99 at a hundred databases against 2.9 ms — because it
concentrated the same blocking into a burst instead of spreading it across the writes that caused
it. A barrier costs what it costs; what a scheduler can change is who waits for it. The sweep now
issues through the callback `fs.fsync`, which goes to the thread pool: about 25% more per call, and
nothing at all on the event loop.

**It issues a few at a time, reversing the plan's "concurrency of one".** On an idle thread serial
is fastest and the plan was right. But this sweep is driven by an event loop that is also serving
writes, and what sets a pass's duration is not the disk — it is one loop round trip per `await`,
which under load is milliseconds rather than the barrier's 36 µs. Serial, a pass over 500 databases
took about ten seconds, so the "interval" silently became ten seconds and the barrier count fell to
29 a second. A width of sixteen puts those round trips in parallel while staying far below the rate
at which this disk starts losing to concurrency.

**There is no per-pass budget.** An earlier version stopped each pass at a wall-clock budget and
resumed on the next tick. It read well and was dishonest: under load a pass got through a handful
of targets per interval, so 500 databases saw 29 barriers a second where the inline behaviour
issued 4 400. That is a weaker durability promise wearing a performance number. A pass now covers
every log that had an intent when it began, and a tick that finds a pass still running does
nothing — so a disk that cannot keep up stretches the interval visibly (`lastDurationUs`,
`deferred`) rather than dropping work invisibly.

## 4. What the sweep does not do, on purpose

**It never serves `ack: "fsync"`, `"replica"` or `"quorum"`.** The plan asked for the sweep to
resolve those waiters. It does not, and the reason is §2: under `ack: "fsync"` there is nothing for
it to win. The ack path already fsyncs inline, group commit already folds, and this disk already
prefers the issuing pattern the inline path uses. Moving those waiters onto a timer would buy
nothing measurable and would put a durability promise behind a scheduler.

The consequence is that under the node's **default** ack the sweep is completely inert: the log is
already clean by the time a pass reaches it, and no barrier is issued. A/B at `ack: "fsync"`,
N = 1 and N = 100: identical within noise, 2.00 fsyncs per write either way.

Two tests hold that line. `test/durability/sweep.test.ts` asserts that twenty writes at
`ack: "fsync"` leave the sweep with nothing to do — and, because an assertion about durability that
never crashes anything is a comment with parentheses, a `kill -9` case: a child process writes at
`ack: "fsync"` with the sweep on, printing each txid **after** it was answered, and the test kills
it outright and asserts every printed txid is still there on reopen.

**The rejected alternative stays rejected.** One node-wide log would make this a single barrier and
would also make per-database shipping, retention, PITR and divergence repair a scan of a shared
file. Nothing measured here changes that trade.

## 5. Done when — against the plan's criteria

| criterion | result |
|---|---|
| the benchmark exists and is recorded in `docs/performance.md` | **yes.** `bench/fsync.ts`, §9, four tables |
| `"shared"` beats `"per-db"` at N ≥ 100 on both p99 and fsyncs/second | **no — at N = 100 it loses on both**, and wins decisively at N = 500. Reported rather than rounded: the default stays `"per-db"` |
| without losing more than 5% at N = 1 | **yes**, and it gains 7.7%; at that size neither setting issues a barrier at all |
| no `ack: "fsync"` caller is ever answered before the fsync covering its append returned, proved by a crash test | **yes.** `test/durability/sweep.test.ts`, the `kill -9` case, plus the direct assertion that the sweep issues no barrier under that ack |

## 6. What it touched

`bench/fsync.ts` (**new**), `src/durability/sweep.ts` and `src/durability/index.ts` (**new**),
`src/wal/log.ts` (`sweep` option, `sweepFlush`, `#writeSeq`, `#maybeFsync` registering an intent),
`src/tenant/tenant.ts` (`fsyncSweep` option, passed to both `TxnLog.open` sites),
`src/tenant/registry.ts` (owns the thread's sweep, `RegistryStats.fsync`),
`src/server/config.ts` (`[durability] fsyncSweep`), `src/server/runtime.ts`,
`src/server/metrics.ts` (`bql_fsync_total`, `bql_fsync_sweep_duration_us`,
`bql_fsync_pending`), `src/server/workers/{protocol,pool,entry}.ts` (one sweep per thread, so the
counters sum and the pass duration takes the worst), `test/durability/`, `docs/performance.md` §9,
`docs/api.md`, `docs/design.md` §5.4 and §9.4.
