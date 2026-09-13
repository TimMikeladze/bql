# Performance — where the time goes, what to do about it, and how it scales

Written 2026-09-12. `docs/benchmarks.md` says what each path costs; this says **what the cost is
made of**, which is what an optimisation has to be argued against. Every number here came from
`bun run bench/profile.ts` or from a probe named beside it, on the machine in `docs/benchmarks.md`
(M5 Pro, macOS 26.6.2, vendored SQLite 3.53.4).

The short version: **SQLite is not the bottleneck anywhere.** A write spends 29% of its time in
SQLite and 71% in BunQL's own record pipeline. A read spends 0.79 µs in SQLite and arrives 28 µs
later on a socket. Both ceilings are ours to move.


> **The numbers in this file predate two default changes (2026-09-13).** Every throughput and
> latency figure here was taken with `[durability] defaultAck = "local"` and `[limits] groupCommit`
> off. Both moved, in opposite directions and by more than the noise: a single write now pays an
> `fdatasync` (24.0 µs → 65.0 µs at p50) and concurrent writes now fold (4.7x at 64 clients).
> Nothing below is wrong; it no longer describes a *default* node. `docs/next.md` carries the
> re-measurement as the follow-up.

## 1. Where a write goes

One row per transaction, because that is the shape of `/v1/db/:db/query` — every statement is its
own transaction, so a transaction's fixed cost is paid per row.

| stage | p50 µs | share | was, before P3 |
|---|---|---|---|
| `BEGIN IMMEDIATE` + insert + `COMMIT` | 7.88 | 34% | 8.21 |
| `recorder.poll` — tail the WAL, checksum the pages | **3.17** | 14% | 8.04 |
| `encode` — frame the record, **zstd level 3** | 10.00 | 44% | 10.21 |
| `log.appendEncoded` — write the segment | 1.83 | 8% | 1.96 |
| **total** | **22.88** | | **28.42** |

That total reproduces what `bench/tenant.ts` reports for the whole write path (24.0 µs,
`ack: local`), so the four stages are the whole write.

The tail halved in P3 (§4G): the WAL frame checksum now runs in C, from
`scripts/native/walsum.c` compiled into the vendored libsqlite3. A node on a system library keeps
the JavaScript, pays the 8.04 µs, and says so at startup. **Every number in this document is the
vendored build unless it says otherwise.**

**Compression is now comfortably the largest line item in a write** — 44% of it — and it is a
setting rather than a constant (§4C).

| body of a single-row transaction | time | size | ratio |
|---|---|---|---|
| plain | 0.04 µs | 4126 B | 1.0x |
| zstd level 1 | 8.54 µs | 961 B | 4.3x |
| **zstd level 3 (current)** | **9.50 µs** | **960 B** | **4.3x** |

Level 1 buys nothing: same ratio, 1 µs cheaper. The real question is whether 9.5 µs of CPU is
worth 3.2 KB, and the answer is a deployment property, not a constant — see §4.

## 2. Where a read goes

| layer | p50 µs |
|---|---|
| driver, prepared statement, straight at the file | 0.79 |
| + tenant, `exec.ts`, policy, result shaping | 2.42 |
| + `JSON.stringify` of the result | 2.46 |
| over a WebSocket, end to end (`bench/http.ts`) | 28.0 |
| over HTTP, end to end (`bench/http.ts`) | 47.8 |

So ~25 µs of a socket read and ~45 µs of an HTTP read is transport, not work. `healthz` — the same
transport with no SQLite in it at all — is 35.4 µs over HTTP, which confirms it: the HTTP request
is the cost, and the query is a rounding error on top.

### The cost no benchmark was paying

`bench/http-client.ts` authenticates with the **admin key**, which is a constant-time compare. Every
deployed client sends a signed token instead, and that is an EdDSA verification per request:

| | p50 |
|---|---|
| `verifyToken`, EdDSA | 28.33 µs |
| point read over HTTP, admin key | 44.2 µs |
| **point read over HTTP, minted token** | **76.4 µs** |

**A real token nearly doubles an HTTP read** and is not in any published figure. It is paid once per
connection on a WebSocket (at `hello`), which is a second reason sockets beat HTTP here.

## 3. The bottlenecks, ranked

1. ~~**One transaction per statement.**~~ **Addressed by `[limits] groupCommit` (§4B), on by
   default since 2026-09-13.**
   Every fixed cost above — commit, tail, checksum, encode, append — is paid per row. At 50 rows per transaction the per-row cost is 0.96 µs instead of
   29.04 µs, a **30x** difference. This is the ceiling behind the 25–30k writes/s figure and behind
   the one missed budget in `docs/benchmarks.md` (130k against a 150k WebSocket target, which that
   file already attributes to writes serialising).
2. **Token verification per HTTP request** — 28 µs, unbatched, uncached, on every request.
3. ~~**Unconditional zstd**~~ — 9.5 µs, 36% of a write. Now `[durability] compress`; off is 28%
   faster and 4.4x larger (§4C).
4. ~~**One writer thread per process.**~~ **Addressed by `[server] workers` (C4).** Spreading writes
   over 8 databases inside one thread changed nothing (28.8k vs 28.1k msg/s) — the bound was the
   thread, not the database. Sharding those 8 databases over 6 worker threads takes the same load
   to 72 817 writes/s. §5.
5. **HTTP framing** — 35 µs before any query runs. Nothing to fix in BunQL; it is a reason to
   prefer the socket, and a reason the Data API (§H4) should be reachable over the socket too.
6. ~~**`recorder.poll` at 8 µs**~~ **Addressed by `scripts/native/walsum.c` (P3), and the diagnosis
   this entry used to carry was wrong.** It said the 5.16 µs `checkFrame` was "cache misses on a
   page fresh from the page cache, not JavaScript", and pointed at capturing pages from SQLite
   directly. It is not cache misses: `Bun.hash.xxHash3` reads every one of the same 4096 bytes,
   immediately after the same `fs.readSync`, in **0.15 µs**. It is 1024 bounds-checked scalar loads
   in JavaScript against a few dozen vector loads in C.
   The evidence is an ablation rather than a microbenchmark — the real `poll()` with the checksum
   and without it, alternating: **6.77 µs against 1.98**. Four JavaScript rewrites were measured
   against the same harness (`Uint32Array` words, a literal endianness instead of a parameter, the
   prefix and the page split so neither call site sees two trip counts, and the earlier
   allocation-free version) and **none of them moved it at all**. The same checksum in C takes
   `poll()` to 2.29 µs. `docs/p3-wal-checksum.md` has the numbers and the warning about how easy
   this one is to mismeasure.
   The write path still touches each page about four times — read from the WAL, WAL checksum,
   xxHash3 for the database checksum, zstd — but three of those are now native and only the read is
   BunQL's. Apply mechanism A (C5, `docs/c5-apply-pages.md`) removed the WAL frame checksum from
   the *replica* by writing no frames at all; P3 made the *primary's* cost native. **Capturing
   pages from SQLite directly is no longer on this list**: it would save the remaining `readSync`,
   0.38 µs, for a VFS shim built out of `JSCallback`s on every write.

## 4. What to do about it, in order of measured win per unit of risk

**A. Cache token verification.** 28 µs → a map lookup, on every HTTP request. Key an LRU by the
token's hash; store the principal and the token's own `exp`; check the revocation set by `jti` per
request, since that is a set lookup and is the only part that can change between requests. Bounded
size, so a flood of distinct tokens cannot grow it. This is the cheapest large win in the list and
it touches one file (`src/server/auth.ts`).

**B. Group commit.** ✅ **Built, and on by default since 2026-09-13** — `[limits] groupCommit`.
Folded writes share a txid, which is a real contract change and is documented rather than
defaulted away (`docs/p2-group-commit.md`, `docs/api.md`). Measured over real sockets, writes/s:

| concurrent clients | off | on | mean fold |
|---|---|---|---|
| 1 | 26 941 | 22 827 | 1.0 |
| 4 | 26 827 | 60 192 | 3.8 |
| 16 | 29 159 | 96 046 | 15.2 |
| 64 | 30 130 | **141 507** | 40.0 |
| 256 | 29 971 | 129 674 | 47.4 |

Without it write throughput is flat at ~30k however many clients there are — the single writer.
With it the ceiling is 140k, at the cost of 15% for a client that has nobody to fold with. The
headroom that predicted this:

| rows/txn | µs/row | implied rows/s |
|---|---|---|
| 1 | 29.04 | 34 433 |
| 5 | 6.09 | 164 155 |
| 50 | 0.96 | 1 044 386 |
| 200 | 0.64 | 1 558 433 |

The client-side half of this **already works today** — `POST /v1/db/:db/batch` over HTTP goes from
19 046 rows/s to 463 620 rows/s at 200 statements a request, a 24x speedup with no code change. The
server-side half is the interesting one: a queue that folds independent statements from *different*
connections into one transaction. Two design constraints to settle first — every folded statement
gets the one transaction's txid, which coarsens read-your-writes; and one failing statement rolls
back its neighbours, so the fold has to fall back to running the batch one at a time on error.

**C. Make compression a policy, not a constant.** ✅ **Done** — `[durability] compress`, default
`true`. Measured through the tenant write path, 4000 single-row transactions:

| | write p50 | records | bytes/record |
|---|---|---|---|
| `compress = true` (default) | 27.42 µs | 36 474/s | 959 |
| `compress = false` | **19.71 µs** | **50 741/s** | 4232 |

**28% off a write and 39% more throughput, for 4.4x the bytes** on disk, on every replica's socket
and in the bucket. That is a deployment trade rather than a constant: a node with local storage, no
replicas and no bucket should turn it off; one shipping over a WAN should not. The flag has always
lived in each record's header and `decode` has always honoured it, so changing the setting leaves
everything already written readable and a replica reads either kind — `test/wal/compress.test.ts`
replays a log written both ways onto one replica and checks the checksums match.

Still open, and the better version: compress **after** the ack for `ack: "local"`, since a record
only has to be compressed before it ships, not before the client is answered. That keeps the ratio
*and* moves the cost off the hot path, at the price of decoupling the log append from the commit —
which is why it is not this change.

**Built: `[durability] deferAppend`, on by default since 2026-09-13** — and dormant, because it
applies to `ack: "local"` only and the default ack is now `"fsync"`
(`docs/p5-deferred-compression.md`). The
finding was that the win is not "compress later" but "answer before the log append", of which zstd
is 80% — the data is already durable when `#capture` starts, because SQLite committed on the line
above. It is safe because a log record is *derived from the WAL* rather than authored, so a crash
in the window is recovered by the reconcile that already runs after an unclean shutdown.

| | write p50 | bytes/record |
|---|---|---|
| compress, append now | 21.1–22.0 µs | 1032 |
| **compress, append deferred** | **8.7–9.5 µs** | **1032** |
| no compress, append now | 14.1–14.7 µs | 4231 |

**2.4x on a write with the 4.3x ratio kept** — and faster than `compress = false` at a quarter of
its bytes, which retires the trade above rather than tuning it. Verified by `kill -9` mid-write:
the rows, the tenant's txid and the log all agree on reopen.

**D. Prefer the socket everywhere.** 28 µs against 48 µs for the same read before auth, 58 against
78 for a write, and no per-request token verification. Nothing to build; it is a documentation and
default-client matter.

**E. Pin the page-cache pragmas.** `cache_size` is never set, so the engine inherits whatever the
loaded libsqlite3 defaults to — that is also what makes Apple's build fail six tests
(`docs/c6-packaging.md` §1.1). Measured: `cache_size = -8000` on the **writer** removes the
mid-transaction WAL spill and takes a 20k-row transaction from 41 ms to 23 ms, with no effect on
single-row writes; `mmap_size = 256 MiB` on **readers** takes a cold random point read from 5.47 µs
to 3.30 µs and a 100-row scan from 15.8 µs to 10.5 µs. Bigger caches buy nothing past 8 MiB. The
mmap caveat is that an I/O error becomes SIGBUS rather than `SQLITE_IOERR`, which is why it belongs
on readers and behind a key.

**F. Replica apply mechanism A.** ✅ **Built, and it is the default** — `[replication] apply`,
`"pages"` against `"wal"` (`docs/c5-apply-pages.md`). It removes the 48 µs "replica read sees the
row" leg, which was a wal-index rebuild forced by mechanism B. Same `bench/wal.ts`, both
mechanisms:

| leg | B (`"wal"`) | A (`"pages"`) |
|---|---|---|
| replica apply, incl. `fdatasync` | 196.1 µs | **161.8 µs** |
| replica read sees the row | 47.2 µs | **6.4 µs** |
| end to end | 290.8 µs | **210.8 µs** |

**7.4x off the read leg and 27% off the whole path.** A writes the primary's pages into the
database file and rewrites the 136-byte wal-index header under SQLite's own WAL lock set, so the
replica's `-wal` is always zero bytes and a reader takes `WAL_READ_LOCK(0)` and reads the file
directly. The lock choreography measures 0.54 µs and the header rewrite 1.13; the apply leg fell
anyway, because A computes no WAL frame checksums at all. What it costs is a wider crash window
than B — detected by the same checksum chain, and usually resumed rather than re-snapshotted.

**G. Checksum WAL frames in C.** ✅ **Built** — `scripts/native/walsum.c`, compiled into the
vendored libsqlite3 and resolved as an optional symbol exactly as `sqlite3_snapshot_*` is, so a
node on a system library keeps the JavaScript and says so at startup (`docs/p3-wal-checksum.md`).
Measured with the helper and again with `BUNQL_WAL_NATIVE=0`:

| | JavaScript | C |
|---|---|---|
| `recorder.poll` | 7.67 µs | **3.17 µs** |
| a single-row write, end to end | 27.21 µs | **22.88 µs** |
| `bench/tenant.ts`, write `ack: local` | 28.9 µs | **24.0 µs** |
| writes/s over sockets, one worker | 29 136 | **33 854** |
| writes/s over sockets, four workers | 78 393 | **86 006** |

**17% off a write and 16% more write throughput**, and the checksum is still computed — the
alternative of trusting the wal-index's `mxFrame` and skipping it was rejected, because it is the
only thing on the live path that would catch a bit that changed between SQLite writing a page and
BunQL reading it back. §3.1 of that document says why the replica cannot stand in for it.

## 5. How this scales

**Reads scale horizontally today, and well.** A replica serves reads locally from its own copy, so
read capacity is per node. Measured per process: 219k–259k reads/s on a socket, ~50k/s over HTTP,
against an engine that can do ~1.3M/s in process — so reads are transport-bound, and adding nodes
adds close to linear capacity.

**Reads do not scale the same way across *threads*, and C4c measured which way each leg goes.** A
replica may now be sharded (`[server] workers = N` beside `[replication] primary`), and the ladder
splits by surface — eight databases, point reads, replica and load client in separate processes,
two alternating rounds of each (`bun run bench/workers.ts --follow [--transport http]`):

| workers | HTTP reads/s | socket reads/s |
|---|---|---|
| 1 | 34 320 – 34 879 | 257 887 – 261 533 |
| 2 | 56 653 | — |
| 6 | 54 386 – 54 552 | 232 004 – 232 582 |
| | **1.56 – 1.60x** | **0.89 – 0.90x** |

An HTTP request is parsed, authenticated and answered on the worker, so moving it off the main
thread buys real work — until two workers, after which the *router's* accept-and-hop loop is the
ceiling rather than the thread running the query. A socket frame is relayed: the router parses it
far enough to route, posts it, and writes the answer back, and a point read is 0.79 µs against a hop
that costs more. So sharding a replica helps HTTP readers and mildly hurts socket readers, which is
the opposite of what "~220k/s per thread" suggested. `docs/c4c-replication-follow.md` §9.

**Writes scale by sharding databases across threads, and `[server] workers` now does the routing.**
The original measurement, same client, same 8 databases, same total load, across *processes*:

| | writes/s |
|---|---|
| 1 process, 8 databases | 17 214 |
| 4 processes, 2 databases each | 39 734 |

2.31x on 4 processes, with the single load client likely the next limit. **C4 did that inside one
process, on one port** (`docs/c4-workers.md`, `bun run bench/workers.ts` — 8 databases, 64 sockets,
server and load client in separate processes):

| workers | writes/s | speedup |
|---|---|---|
| 1 | 28 809 | 1.00x |
| 2 | 46 964 | 1.63x |
| 4 | 68 572 | 2.38x |
| 6 | **72 817** | **2.67x** |
| 8 | 66 502 | 2.44x |

The one-worker baseline is §3's own "8 databases in one process" figure — 28.8k — so this ladder is
measured against exactly the ceiling it was meant to lift.

**P3 (§4G) moved the whole ladder up**, since every write on every worker pays 4.5 µs less:
**33 854 writes/s at one worker and 86 006 at four**, against 29 136 and 78 393 with the checksum
back in JavaScript. The shape is unchanged; the floor is higher. It peaks at six on 18 cores: the router
is one thread, and eight databases over eight shards is a lumpy split.

What is *not* lifted: one database still has one writer, and `workers > 1` still refuses to start
alongside `[cluster] enabled`. Both halves of replication are supported: *serving* replicas as of
C4b — the router owns the replication connection and the worker that owns a database owns its
stream, which costs 15% of write throughput on a single-threaded node and 19% on a sharded one
(`docs/c4b-replication-workers.md` §9) — and *following* an upstream as of C4c, measured above.
Placement (milestone 3) is still what routes across *nodes*.

**The ladder, in the order it pays off**

1. Batch on the client — 24x on bulk writes, available now.
2. Move clients to the socket — ~40% off every read, and no token verification per request.
3. Cache token verification — 28 µs off every HTTP request (A).
4. Group commit on the server — up to 30x on concurrent single-row writes (B).
5. ✅ `workers: N` — **2.67x measured, one node, one port** (`docs/c4-workers.md`). Placement
   (milestone 3) is the remaining half, across nodes rather than threads.
6. Replicas for reads, which already work, and placement for writes, which does not yet.

**What does not scale, and cannot be made to.** One database has one writer — that is SQLite, and
it is the trade the whole design takes in exchange for a database per tenant costing nothing. A
single database will not exceed ~35k writes/s in process, or ~1M rows/s if the writes arrive in
batches. Ten thousand databases, on the other hand, scale with cores and nodes; the product is
"many small databases", and the write ceiling is per database rather than per system.

## 6. Tried and rejected

- **Letting SQLite build the JSON.** The server reads every column through FFI, builds JS objects
  and then serialises them; `json_group_array` would do it in one read. Measured on a 100-row,
  6-column result: 17.96 µs the current way, **20.75 µs** through `json_group_array`. Slower, and
  it would lose the typed values. Rejected.
- **Row arrays instead of row objects.** 18.58 µs against 17.96 µs for the same result. No win.
- **A bigger page cache for reads.** 2 MiB → 32 MiB moves a warm point read from 1.67 µs to
  1.36 µs, and the ceiling multiplies by every open connection (3 per tenant, 1024 tenants). Not
  worth it; `mmap_size` is the read lever instead (E).
- **zstd level 1 instead of 3.** Same 4.3x ratio, 1 µs cheaper. Not worth a format decision — if
  compression is to be changed, change *when* it runs, not how hard it tries (C).

## 7. SQLite's own settings — what BunQL sets, and what it inherits

Read off a live tenant through the registry's `onConnection` hook, so these are the connections
BunQL actually serves from rather than a fresh one opened beside them.

**Set deliberately**

| setting | value | where | why |
|---|---|---|---|
| `journal_mode` | `wal` | `tenant.ts` (writer), and every other open path | the whole design: readers never block the writer, and the `-wal` is what the tailer ships |
| `synchronous` | `1` (NORMAL) | writer | a commit does not fsync; `ack: "fsync"` and above do it explicitly (`#syncDurable`) |
| `wal_autocheckpoint` | `0` | writer, and the replica applier | **BunQL owns checkpoints.** SQLite checkpointing on its own could move frames out of the WAL before the tailer recorded them |
| `SQLITE_FCNTL_PERSIST_WAL` | on | writer | keeps the `-wal` across the last close, so a crash reconcile still has its frames |
| `page_size` | 4096, `[data] pageSize` | at creation only | a page is the unit of replication |
| `max_page_count` | from `quotaBytes` | writer | the per-tenant storage quota |
| `busy_timeout` | 5000 ms | every connection | `[data] busyTimeoutMs` |
| `query_only` | `1` on readers | `ServerRuntime.#adopt` | pinned once per connection so the request path never pays the pragma |
| `SQLITE_LIMIT_*` | 5 of them | every connection | SQL length, expression depth, compound selects, variables, `ATTACH` disabled |

The reader's `wal_autocheckpoint` is still SQLite's default 1000, and that is safe **only** because
`query_only` is pinned on it: a connection that cannot commit can never autocheckpoint. The "we own
checkpoints" invariant rests on that pin, not on the autocheckpoint value.

**Exposed since this audit** (`[sqlite]`, `docs/p1-pragmas.md`): `writerCacheBytes` — the one
changed default, 8 MiB — plus `readerCacheBytes`, `readerMmapBytes`, `foreignKeys`,
`trustedSchema` and `cellSizeCheck`. The list below is what remains inherited.

**Inherited from SQLite, never set:** `cache_size` (-2000), `mmap_size` (0), `temp_store` (0),
`foreign_keys` (**0**), `auto_vacuum` (0), `secure_delete` (0), `journal_size_limit` (-1),
`defensive` (off, and unreachable — see below), `recursive_triggers` (0), `threads` (0),
`analysis_limit` (0). There is also no `ANALYZE` and no `PRAGMA optimize` anywhere
in `src/`, so no database ever collects planner statistics.

Which of those are worth changing, measured:

- **`foreign_keys` is off, so a declared foreign key is enforced on nothing.** Not a performance
  matter — a correctness one, recorded in `docs/next.md`. Now a switch (`[sqlite] foreignKeys`),
  still off by default because turning it on changes the meaning of existing schemas. It belongs
  per database rather than per node, which needs a catalog column.
- **`cache_size` and `mmap_size` are the two real levers**, and §4E has the numbers. Both are
  settings now; the writer's cache is the one default that moved.
- **Hardening is off, and `POST /v1/db/{db}/import` accepts a SQLite file.** `trusted_schema = 0`
  and `cell_size_check` are now reachable as settings. **`defensive` is not reachable at all**:
  it has no pragma, and `sqlite3_db_config` is variadic. Binding it fixed-arity through bun:ffi was
  tested rather than assumed and fails three ways — the value passed is ignored (asking for
  `DEFENSIVE = 0` left it on), the out-parameter is never written, and the second call killed the
  process with SIGKILL. On arm64 a variadic argument goes on the stack where a fixed parameter goes
  in a register, so SQLite reads whatever was there. The remedy is a non-variadic shim compiled
  into the vendored library by `scripts/sqlite.ts`, declared optional exactly as `sqlite3_snapshot_*`
  is — `docs/p1-pragmas.md` has the sketch.
- **`temp_store = memory` is not a win here.** A 24 MB sort: 48.3 ms with the default file-backed
  temp store, **56.7 ms** in memory. The OS page cache already makes the file memory, and the
  allocation is not free. Left alone.
- **`ANALYZE` changed nothing on the shape tried** — a skewed 60k-row join, identical query plan
  before and after, and the query is too fast to separate. It costs 3 ms per database to collect.
  Not a priority, but it is the standard remedy if a tenant ever reports a bad plan, and
  `PRAGMA optimize` at checkpoint time is where it would go.

## 8. Reproducing

```sh
bun run bench/profile.ts [rounds]   # §1, §2's auth row, §4's group-commit table
bun run bench:tenant                # the write path as a whole
bun run bench:http                  # the transport legs and the mixed throughput
bun run bench --only wal            # the shipping legs
```

`bench/profile.ts` is deliberately not part of `bun run bench`: three of its four sections measure
things BunQL does not do (uncompressed records, group commit, cached verification), so they are
attribution for this document rather than budgets to hold.
