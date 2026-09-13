# Measured

The numbers `bun run bench` printed, on the machine named below. One run, all six benchmarks, so
every number here can be read against every other one. Reproduce with:

```sh
bun run bench             # all six, then the design §10 table and the phase-1 table
bun run bench --quick     # fewer rounds
bun run bench --only wal  # one of driver | wal | tenant | http | replication | storage
bun run bench --json      # every leg as JSON, which is where this file comes from
```

Each benchmark runs as its own process, and `bench/http.ts` spawns a second one for the load, so
the client never shares an event loop with the server. A missed budget is a WARN, never a build
failure — a benchmark measures the machine it ran on. The one hard gate is the driver's own
point-read target, which `bench/driver.ts` enforces itself.

## Machine

| | |
|---|---|
| CPU | Apple M5 Pro, 18 cores |
| memory | 52 GB |
| platform | darwin/arm64 (macOS 25.6) |
| filesystem | APFS |
| Bun | 1.4.0 |
| SQLite | 3.53.4 |
| library | `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` (Homebrew) |
| `ulimit -n` | 1 048 576 |
| recorded | 2026-09-12, end of phase 1 |

Apple's system SQLite is built without the session and preupdate extensions, so a Homebrew build is
what the realtime engine needs. `BUNQL_SQLITE_LIB` overrides the search.

## Design §10 performance budget

| path | measured | budget | verdict |
|---|---|---|---|
| point read, in process (plan M2) | 0.77 µs | ≤ 1.20 µs | **PASS** |
| point read over HTTP keep-alive | 48.2 µs | ≤ 60 µs | **PASS** |
| point read over WebSocket | 28.6 µs | ≤ 35 µs | **PASS** |
| single-row write, `ack: local`, incl. tail+log | 28.2 µs | ≤ 40 µs | **PASS** |
| single-row write, `ack: fsync` — **the default since 2026-09-13** | 65.0 µs | — | what an `fdatasync` costs; `local` is the 2.7x opt-out |
| write visible on a replica | 219.5 µs | ≤ 1 ms | **PASS** |
| write visible on a replica, no transport | 291.6 µs | ≤ 1 ms | **PASS** |
| live-query invalidation → event on socket | 17.3 µs | ≤ 200 µs | **PASS** |
| tenants open per process | 10 000 | ≥ 10 000 | **PASS** |
| throughput, mixed 90/10, HTTP | 53 752 req/s | ≥ 50 000 req/s | **PASS** |
| throughput, mixed 90/10, WebSocket | 130 315 msg/s | ≥ 150 000 msg/s | **WARN** |

Four of these need their provenance stated:

- **The write budget is the in-process path**, which is what design §10 says ("incl. tail+log").
  It is measured through the tenant owner, not over HTTP. The same write costs 79 µs over HTTP and
  61 µs over a WebSocket, which is the transport on top of these 28 µs.
- **"Write visible on a replica" is now measured over a real socket**: two nodes, each with its own
  data directory and listener, in one process, and the gap timed between the primary's commit
  listener and the replica's. 219.5 µs p50. The row beneath it is `bench/wal.ts`, the same path with
  the transport taken out (291.6 µs) — the transport one is *faster* because the WAL benchmark
  fsyncs the replica's position on every record and the server batches that work.
- **Live-query invalidation is derived**, not timed directly. What can be timed from outside the
  server is the whole round trip: a write leaves the load client, commits, and the event arrives on
  a second socket (78.6 µs p50). The invalidation leg is that minus a bare write of the same shape
  over the same socket (61.3 µs), which is the 17.3 µs above.
- **Tenants open per process** is a capability, not a latency: 10 000 created and held open in
  7.5 s, with nothing evicted.

**The one WARN, unchanged from phase 0.** WebSocket throughput is 130k messages a second against a
150k target, measured with 2 000 requests in flight on one socket, 90 % point reads and 10 %
single-row writes. The writes are the reason: they serialise on the tenant's single writer at
~28 µs each, so 200 of the 2 000 messages cost about 5.6 ms of the ~15 ms the run takes. A
read-only stream on the same socket clears the target; a mixed one on a single database does not,
and would not until the single writer stops being the only write path. Batching commits or
pipelining the write path is the fix, and it is still open.

## Phase 1: routing, durability, Hrana and the shipper

Design §10 budgets none of these, so they are printed with the number they should be read against
rather than a verdict. A forwarded write is not fast or slow on its own, only next to the local one.

| path | measured | read against | what the difference is |
|---|---|---|---|
| write, `ack: local`, on the primary (HTTP) | 303.4 µs | — | the reference: an HTTP write on the primary, with a replica attached and streaming |
| write forwarded through a replica | 352.8 µs | 303.4 µs | **+49 µs** for the whole round trip out to the primary and back over the replication socket |
| write, `ack: replica` | 407.0 µs | 303.4 µs | **+104 µs**: an `fdatasync` here, plus waiting for a replica to report the record fsynced |
| write, `ack: quorum` | 382.5 µs | 303.4 µs | **+79 µs**: one replica, so the majority is the same single ack, measured separately |
| point read, Hrana pipeline | 49.1 µs | 48.2 µs | **+0.9 µs** over the native route for the same statement |
| write, Hrana pipeline | 79.7 µs | 78.9 µs | **+0.8 µs** over the native route |
| records shipped to S3 per second | 28 790 rec/s | — | commit to bucket, end to end, against the in-process fake |
| pushed to S3 | 17.4 MiB/s | — | 633 bytes per single-row record |
| one commit to the bucket | 200.2 µs | — | steady state, one commit at a time, `flush()` included |

Three things worth knowing about these:

- **The primary's HTTP write is 303 µs here and 79 µs in the HTTP table.** Different benchmark,
  different shape: `bench/replication.ts` runs both nodes and the client on one event loop and
  waits for the replica to apply each write before starting the next, so its reference number
  carries the replica's work. Compare inside a table, not across them.
- **Hrana costs under a microsecond.** The compatibility layer decodes its own value encoding and
  opens and closes a stream per request; `@libsql/client` keeps a baton alive instead, which saves
  the close. Everything underneath is the same `exec.ts` the native route uses.
- **The S3 numbers are against `test/storage/fake-s3.ts`**, in this process. They measure BunQL's
  side — batching, the segment layout, the manifest write and `Bun.S3Client`'s request path — with
  the network taken out. A real bucket is slower and is a different question.

## Driver — `bench/driver.ts`

The `bun:ffi` driver against `bun:sqlite` on the same file, same schema, same pragmas, 100 000
rows. µs per operation.

| op | bunql | bun:sqlite | speedup |
|---|---|---|---|
| point read by primary key → object | 0.77 | 1.77 | 2.30x |
| point read, 3 columns | 0.82 | 1.78 | 2.19x |
| point read, 3 columns, `values()` | 0.83 | 1.83 | 2.22x |
| 100-row scan → objects | 8.98 | 6.86 | 0.76x |
| insert inside a transaction | 0.28 | 0.22 | 0.80x |
| insert inside a transaction, update hook on | 0.36 | not available | — |
| single-row autocommit insert (WAL, `synchronous=NORMAL`) | 5.09 | 5.26 | 1.03x |

Point reads win because the per-statement overhead is much lower. Wide scans lose because every
column costs one extra FFI call for `sqlite3_column_type`, which bun:sqlite does in native code.
The update hook, which bun:sqlite cannot install at all, costs 0.08 µs a row.

**The authorizer trampoline is always installed** since the `lastInsertRowid` fix, because that is
where a statement's program is read at compile time. None of the legs above moved: it costs
nothing per step and about 0.5 µs per *prepare* (8 authorizer callbacks for a three-column select,
measured separately), which the connection's statement cache pays once per SQL text.

## WAL shipping — `bench/wal.ts`

500 transactions of 5 rows, primary and replica in one process with no transport between them,
replica position fsynced on every transaction. µs.

Both of design §4.5's apply mechanisms, since C5 made `"pages"` (A) the default and kept `"wal"`
(B) behind `[replication] apply`. `bun run bench/wal.ts each pages` and `… each wal`. The tail leg
is the P3 figure — the frame checksum in C (`docs/p3-wal-checksum.md`); with
`BUNQL_WAL_NATIVE=0` it is 10.3 µs rather than 5.3.

| leg | A p50 | A p90 | A p99 | B p50 | B p90 | B p99 |
|---|---|---|---|---|---|---|
| primary commit | 11.8 | 17.3 | 45.8 | 12.0 | 18.4 | 49.5 |
| tail + checksum chain | 5.3 | 11.8 | 43.0 | 10.3 | 17.9 | 54.0 |
| encode, zstd level 3 | 11.7 | 16.7 | 35.8 | 11.8 | 16.2 | 41.8 |
| log append | 2.8 | 5.8 | 11.9 | 3.0 | 6.5 | 11.2 |
| decode | 5.3 | 8.8 | 16.2 | 5.5 | 8.1 | 15.1 |
| replica apply, incl. `fdatasync` | **161.8** | 205.2 | 266.5 | 196.1 | 251.3 | 319.8 |
| replica read sees the row | **6.4** | 8.8 | 12.5 | 47.2 | 74.3 | 82.5 |
| **end to end** | **210.8** | **270.5** | **413.8** | 290.8 | 364.6 | 489.0 |

Records compress 4.8x: 923 bytes on the wire for 4 440 bytes of pages. Everything BunQL controls
costs about 40 µs a transaction; the rest is the fsync, and — under mechanism B — the wal-index
rebuild it forces on the next replica reader. **Mechanism A takes that read leg from 47.2 µs to
6.4, a 7.4x cut**, and takes 34 µs off the apply because there are no WAL frames to checksum.
`docs/c5-apply-pages.md`.

## Replication over a socket — `bench/replication.ts`

A primary and a replica, each a whole server with its own data directory and listener, in one
process on loopback. 300 single-row transactions timed one at a time, then 2 000 records streamed.
µs.

| leg | p50 | p90 | p99 |
|---|---|---|---|
| primary write (HTTP) | 303.4 | 374.1 | 1049.1 |
| commit → replica applied | 219.5 | 255.5 | 342.5 |
| write forwarded via replica | 352.8 | 380.0 | 1171.1 |
| write, `ack: replica` | 407.0 | 446.0 | 1964.3 |
| write, `ack: quorum` | 382.5 | 409.7 | 476.9 |

Sustained: 2 000 records applied end to end in 0.514 s, **3 894 records/s**, 2 401 KiB on the wire.
Both nodes share one event loop, so that is the pair's combined ceiling rather than each node's.
The checksums matched at the end, which is the benchmark's own correctness gate.

## Shipping to S3 — `bench/storage.ts`

2 000 single-row records committed while the shipper runs on its 25 ms timer, then 200 more one at
a time with a `flush()` after each.

| leg | value |
|---|---|
| records committed/s | 29 143 |
| records shipped/s, commit to bucket | 28 790 |
| pushed to the bucket | 17.4 MiB/s |
| bytes pushed per record | 633 |
| bytes retained per record | 631 |
| one commit to the bucket, p50 | 200.2 µs |
| one commit to the bucket, p99 | 852.5 µs |

Shipping costs about 1 % of the commit rate here: 29 143 records a second committed, 28 790 of them
committed *and* in the bucket. Pushed and retained bytes are nearly equal because a segment is
re-uploaded only as it grows and these records are small; a workload with large transactions and a
long segment would push more than it retains.

## Tenant write path — `bench/tenant.ts`

2 000 rounds of one-row transactions through the tenant owner — the whole design §4.3 write path,
`BEGIN IMMEDIATE` → `COMMIT` → tail → record → log append → position save. µs.

| leg | p50 | p90 | p99 | with `BUNQL_WAL_NATIVE=0` |
|---|---|---|---|---|
| `write`, `ack: "local"` | **24.0** | 29.9 | 50.8 | 28.9 |
| `write`, `ack: "fsync"` | 63.5 | 78.2 | 109.3 | 66.1 |
| the `BEGIN IMMEDIATE`…`COMMIT` alone | 7.7 | 8.7 | 11.5 | 7.7 |
| `readSync`, point read by primary key | 0.9 | 1.1 | 3.7 | 0.9 |
| `read`, the same through a promise | 1.0 | 1.4 | 3.1 | 1.0 |

An awaited read costs the same as the synchronous one, so the server layer can use either.

The last column is the same benchmark with the WAL frame checksum back in JavaScript, which is what
a node on a system libsqlite3 gets. **17% of a write** is the difference, and it is all in the tail:
`docs/p3-wal-checksum.md`.

Cold open (an LRU miss) is **298 µs** p50 with 6 000 records in the log, and close is 118 µs. In
phase 0 that open was 2 517 µs, almost all of it `TxnLog.open` walking every record header; R3's
sidecar segment index is the difference.

**10 000 tenants created and held open in 7.5 s**, with the registry holding all of them (`maxOpen`
above the target, so nothing was evicted). At roughly 7 file descriptors per open tenant this needs
about 70 000 of the 1 048 576 this machine allows; a host with the common 1 024 soft limit reaches
about 140 tenants before `maxOpen` has to come down, and the registry warns about exactly that at
startup.

## HTTP, WebSocket and Hrana — `bench/http.ts`

2 000 rounds. The server is one process; the load client is another, spawned by the benchmark, so
the two do not share an event loop. µs unless stated.

| leg | p50 | p90 | p99 | budget |
|---|---|---|---|---|
| point read, HTTP keep-alive | 48.2 | 56.1 | 68.3 | ≤ 60 |
| single-row write, `ack: local`, HTTP | 78.9 | 90.2 | 132.3 | — |
| `healthz`, HTTP | 37.1 | 44.5 | 56.3 | — |
| point read, Hrana pipeline | 49.1 | 57.4 | 81.5 | — |
| single-row write, `ack: local`, Hrana pipeline | 79.7 | 91.0 | 162.8 | — |
| point read, WebSocket | 28.6 | 33.5 | 43.3 | ≤ 35 |
| single-row write, `ack: local`, WebSocket | 61.3 | 70.0 | 93.8 | — |
| write → live event on another socket | 78.6 | 87.8 | 172.2 | — |
| live-query invalidation → event on socket | 17.3 | 26.4 | — | ≤ 200 |
| throughput, mixed 90/10, HTTP | 53 752 req/s | — | — | ≥ 50 000 |
| throughput, mixed 90/10, WebSocket | 130 315 msg/s | — | — | ≥ 150 000 |

`healthz` — the same transport with no SQLite at all — costs 37.1 µs, which is the floor of every
number in this table. A point read adds 11 µs over HTTP and, on a socket, costs 8 µs less than the
empty HTTP route. The Hrana pipeline legs are the same two statements through `/v2/pipeline`, one
`execute` and one `close` per request.

`docs/m5-server.md` measured the same legs with the client on the server's own event loop and
reported 23k–47k req/s, noting that the harness itself was the limit. Moving the client to its own
process is what the 54k above is: the latency legs barely move, and only the throughput number
changes. `bun run bench:http --in-process` still reproduces the old shape for comparison.

On Linux the two processes are pinned to different CPUs with `taskset`. macOS has no equivalent, so
these numbers rely on the scheduler putting two busy processes on two of the eighteen cores.

## Realtime fan-out

Not part of `bun run bench` — it is asserted by `test/realtime/facade.test.ts`, which fails if it
regresses. With 1 000 live subscriptions across 10 tables, one commit touching one table costs
**0.018 ms median, 0.049 ms worst** inside `afterCommit`; flushing the 100 affected re-runs
afterwards takes 0.50 ms, and only the subscriptions whose result actually changed emit anything.
The plan's budget for this was 2 ms.
