# Measured

The numbers `bun run bench` printed, on the machine named below. Reproduce with:

```sh
bun run bench            # all four, then the design §10 table
bun run bench --quick    # fewer rounds
bun run bench --only wal # one of driver | wal | tenant | http
bun run bench --json     # every leg as JSON, which is where this file comes from
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
| recorded | 2026-09-12 |

Apple's system SQLite is built without the session and preupdate extensions, so a Homebrew build is
what the realtime engine needs. `BUNQL_SQLITE_LIB` overrides the search.

## Design §10 performance budget

| path | measured | budget | verdict |
|---|---|---|---|
| point read, in process (plan M2) | 0.78 µs | ≤ 1.20 µs | **PASS** |
| point read over HTTP keep-alive | 47.8 µs | ≤ 60 µs | **PASS** |
| point read over WebSocket | 28.8 µs | ≤ 35 µs | **PASS** |
| single-row write, `ack: local`, incl. tail+log | 27.0 µs | ≤ 40 µs | **PASS** |
| write visible on a replica | 291.2 µs | ≤ 1 ms | **PASS** |
| live-query invalidation → event on socket | 19.1 µs | ≤ 200 µs | **PASS** |
| tenants open per process | 10 000 | ≥ 10 000 | **PASS** |
| throughput, mixed 90/10, HTTP | 51 978 req/s | ≥ 50 000 req/s | **PASS** |
| throughput, mixed 90/10, WebSocket | 128 766 msg/s | ≥ 150 000 msg/s | **WARN** |

Three of these need their provenance stated:

- **The write budget is the in-process path**, which is what design §10 says ("incl. tail+log").
  It is measured through the tenant owner, not over HTTP. The same write costs 79 µs over HTTP and
  61 µs over a WebSocket, which is the transport on top of these 27 µs.
- **"Write visible on a replica" is measured on one host**, primary and replica in one process over
  APFS, so it is the floor of the LAN number rather than the LAN number. Almost all of it is one
  `fdatasync` (197 µs) and the wal-index rebuild that mechanism B forces on the next replica reader
  (47 µs) — the two costs design §4.5 gives as the reason mechanism A replaces it in phase 1.
- **Live-query invalidation is derived**, not timed directly. What can be timed from outside the
  server is the whole round trip: a write leaves the load client, commits, and the event arrives on
  a second socket (79.7 µs p50). The invalidation leg is that minus a bare write of the same shape
  over the same socket (60.5 µs), which is the 19.1 µs above.

**The one WARN.** WebSocket throughput is 129k messages a second against a 150k target, measured
with 2 000 requests in flight on one socket, 90 % point reads and 10 % single-row writes. The
writes are the reason: they serialise on the tenant's single writer at ~27 µs each, so 200 of the
2 000 messages cost about 5.4 ms of the ~15.5 ms the run takes. A read-only stream on the same
socket clears the target; a mixed one on a single database does not, and would not until a write
path that is 27 µs stops being the tenant's only one. This is worth revisiting in phase 1, when
`ack` levels make the write path's cost explicit anyway.

## Driver — `bench/driver.ts`

The `bun:ffi` driver against `bun:sqlite` on the same file, same schema, same pragmas, 100 000
rows. µs per operation.

| op | bunql | bun:sqlite | speedup |
|---|---|---|---|
| point read by primary key → object | 0.78 | 1.80 | 2.32x |
| point read, 3 columns | 0.80 | 1.88 | 2.34x |
| point read, 3 columns, `values()` | 0.84 | 1.86 | 2.22x |
| 100-row scan → objects | 9.18 | 6.88 | 0.75x |
| insert inside a transaction | 0.27 | 0.22 | 0.80x |
| insert inside a transaction, update hook on | 0.35 | not available | — |
| single-row autocommit insert (WAL, `synchronous=NORMAL`) | 4.93 | 5.75 | 1.17x |

Point reads win because the per-statement overhead is much lower. Wide scans lose because every
column costs one extra FFI call for `sqlite3_column_type`, which bun:sqlite does in native code.
The update hook, which bun:sqlite cannot install at all, costs 0.08 µs a row.

## WAL shipping — `bench/wal.ts`

500 transactions of 5 rows, primary and replica in one process, replica position fsynced on every
transaction. µs.

| leg | p50 | p90 | p99 |
|---|---|---|---|
| primary commit | 11.5 | 17.3 | 47.7 |
| tail + checksum chain | 9.5 | 16.3 | 37.2 |
| encode, zstd level 3 | 11.3 | 15.9 | 38.0 |
| log append | 2.8 | 6.0 | 11.5 |
| decode | 5.4 | 8.0 | 17.1 |
| replica apply, incl. `fdatasync` | 197.0 | 226.5 | 280.6 |
| replica read sees the row | 46.7 | 74.9 | 84.5 |
| **end to end** | **291.2** | **338.4** | **477.5** |

Records compress 4.8x: 923 bytes on the wire for 4 440 bytes of pages. Everything BunQL controls
costs about 40 µs a transaction; the rest is the fsync and the wal-index rebuild.

## Tenant write path — `bench/tenant.ts`

2 000 rounds of one-row transactions through the tenant owner — the whole design §4.3 write path,
`BEGIN IMMEDIATE` → `COMMIT` → tail → record → log append → position save. µs.

| leg | p50 | p90 | p99 |
|---|---|---|---|
| `write`, `ack: "local"` | 27.0 | 33.2 | 58.6 |
| `write`, `ack: "fsync"` | 63.0 | 75.4 | 98.8 |
| the `BEGIN IMMEDIATE`…`COMMIT` alone | 6.3 | 7.3 | 10.7 |
| `readSync`, point read by primary key | 0.9 | 1.1 | 4.1 |
| `read`, the same through a promise | 1.0 | 1.3 | 4.3 |

An awaited read costs 0.1 µs more than the synchronous one, so the server layer can use either.

Cold open (an LRU miss) is 2 517 µs p50 with 6 000 records in the log, and close is 118 µs. Most of
a cold open is `TxnLog.open` walking every record header to rebuild its offset index, about 0.5 µs
a record; a persisted index belongs to `src/wal/log.ts` in phase 1.

**10 000 tenants created and held open in 6.8 s**, with the registry holding all of them (`maxOpen`
above the target, so nothing was evicted). At roughly 7 file descriptors per open tenant this needs
about 70 000 of the 1 048 576 this machine allows; a host with the common 1 024 soft limit reaches
about 140 tenants before `maxOpen` has to come down, and the registry warns about exactly that at
startup.

## HTTP and WebSocket — `bench/http.ts`

2 000 rounds. The server is one process; the load client is another, spawned by the benchmark, so
the two do not share an event loop. µs unless stated.

| leg | p50 | p90 | p99 | budget |
|---|---|---|---|---|
| point read, HTTP keep-alive | 47.8 | 55.5 | 68.0 | ≤ 60 |
| single-row write, `ack: local`, HTTP | 79.0 | 89.9 | 125.8 | — |
| `healthz`, HTTP | 36.8 | 43.3 | 53.5 | — |
| point read, WebSocket | 28.8 | 33.5 | 45.8 | ≤ 35 |
| single-row write, `ack: local`, WebSocket | 60.5 | 69.2 | 112.7 | — |
| write → live event on another socket | 79.7 | 93.1 | 249.0 | — |
| live-query invalidation → event on socket | 19.1 | 32.5 | — | ≤ 200 |
| throughput, mixed 90/10, HTTP | 51 978 req/s | — | — | ≥ 50 000 |
| throughput, mixed 90/10, WebSocket | 128 766 msg/s | — | — | ≥ 150 000 |

`healthz` — the same transport with no SQLite at all — costs 36.8 µs, which is the floor of every
number in this table. A point read adds 11 µs over HTTP and, on a socket, costs 8 µs less than the
empty HTTP route.

`docs/m5-server.md` measured the same legs with the client on the server's own event loop and
reported 23k–47k req/s, noting that the harness itself was the limit. Moving the client to its own
process is what the 52k above is: the latency legs barely move (48.5 → 47.8 µs for an HTTP point
read), and only the throughput number changes. `bun run bench:http --in-process` still reproduces
the old shape for comparison.

On Linux the two processes are pinned to different CPUs with `taskset`. macOS has no equivalent, so
these numbers rely on the scheduler putting two busy processes on two of the eighteen cores.

## Realtime fan-out

Not part of `bun run bench` — it is asserted by `test/realtime/facade.test.ts`, which fails if it
regresses. With 1 000 live subscriptions across 10 tables, one commit touching one table costs
**0.016 ms median, 0.032 ms worst** inside `afterCommit`; flushing the 100 affected re-runs
afterwards takes 0.53 ms, and only the subscriptions whose result actually changed emit anything.
The plan's budget for this was 2 ms.
