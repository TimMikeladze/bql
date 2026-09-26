# Performance — where the time goes, what to do about it, and how it scales

Written 2026-09-12. `docs/benchmarks.md` says what each path costs; this says **what the cost is
made of**, which is what an optimisation has to be argued against. Every number here came from
`bun run bench/profile.ts` or from a probe named beside it, on the machine in `docs/benchmarks.md`
(M5 Pro, macOS 26.6.2, vendored SQLite 3.53.4).

The short version: **SQLite is not the bottleneck anywhere.** A write spends 29% of its time in
SQLite and 71% in bql.sh's own record pipeline. A read spends 0.79 µs in SQLite and arrives 28 µs
later on a socket. Both ceilings are ours to move.


> **Re-measured against the 2026-09-13 defaults.** §1 and §5 now say what a *default* node does —
> `[durability] defaultAck = "fsync"`, `[limits] groupCommit` on, `[durability] deferAppend` on —
> and each says which figure is which. One table is not re-measured and says so: §5's worker
> ladder, because this machine could no longer hold a five-second throughput measurement steady
> (11 721 and 49 507 writes/s at the *same* rung, minutes apart).
>
> **Read §8 before trusting a microsecond in this file.** Two artefacts were found while
> re-measuring, and both had been quietly moving the published numbers: the HTTP benchmark was
> charging its own warm-up to the first leg it measured, and a pair of runaway processes on the
> benchmark machine made everything 1.6x slower for a day.

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

That total reproduces what `bench/tenant.ts` reports for the whole write path (23.7 µs,
`ack: local`), so the four stages are the whole write. Re-measured on 2026-09-13 against the new
defaults, the four stages are **unchanged** — 8.04, 2.86, 10.00, 1.86, total 22.75 over two runs —
because none of them is what the defaults moved.

**What the defaults added is a fifth line, and it is the biggest one.**

| the same write, by `ack` | p50 µs | what it buys |
|---|---|---|
| `ack: "local"` — the four stages above | 23.7 | the transaction is committed and in the log |
| **`ack: "fsync"` — the default since 2026-09-13** | **62–64** | …and on the platter |

So the default costs **2.7x on a single write**, and all of it is one `fdatasync`: ~38 µs of
waiting on a disk, not work. `ack: "local"` is the opt-out and means exactly what it meant before.

**Under concurrency the arithmetic reverses**, because `groupCommit` folds. `bench/workers.ts` at
one worker, 8 databases, 64 sockets, five seconds, old defaults against new, three interleaved
rounds on the same machine:

| | writes/s |
|---|---|
| `defaultAck: local`, `groupCommit` off — the old defaults | 27 742 · 29 049 · 30 444 |
| `defaultAck: fsync`, `groupCommit` on — the current ones | 46 026 · 47 935 · 53 610 |
| | **1.69x** |

**A durable default is 1.69x faster than the non-durable one it replaced**, once more than one
client is writing. The fsync a single write pays is the same fsync sixty-four of them now share.
That is the whole argument for the change, and it is why the two halves of it landed together.

The group-commit ladder itself, measured in process (`bun run bench/profile.ts`):

| rows per transaction | µs/row | implied rows/s |
|---|---|---|
| 1 | 24.17 | 41 379 |
| 2 | 12.67 | 78 948 |
| 5 | 5.28 | 189 272 |
| 10 | 2.75 | 363 636 |
| 50 | 0.83 | 1 197 605 |
| 200 | 0.57 | 1 765 350 |

`groupCommitMax` is 64, so a node under load lands between the 50- and 200-row rows of that table
without any client batching at all. **This is also the reason the change feed got coarser**: folded
writes share a txid, so a CDC consumer sees fewer, fatter events. `docs/api.md` says so beside the
flag that turns it off.

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
| over HTTP, end to end (`bench/http.ts`) | 53.7 |

So ~25 µs of a socket read and ~50 µs of an HTTP read is transport, not work. `healthz` — the same
transport with no SQLite in it at all — is 37.2 µs over HTTP, which confirms it: the HTTP request
is the cost, and the query is a rounding error on top.

### The cost no benchmark was paying, and it turned out to be small

`bench/http-client.ts` authenticated with the **admin key**, a constant-time compare, while every
deployed client sends a signed token. There is now a leg for it, so this is measured rather than
extrapolated from `verifyToken`:

| | p50 |
|---|---|
| point read over HTTP, admin key | 53.7 µs |
| **point read over HTTP, minted token** | **58.6 µs** |
| `verifyToken`, EdDSA, uncached | 30.9 µs |

**About 5 µs, not the 30 the EdDSA line suggests** — the verification cache (`c020766`) is doing
its job, and a token costs a key-ring lookup and a map hit on all but the first request. An earlier
edition of this section put the token read at 76.4 µs against 44.2, which was a 1.7x claim built
out of two legs measured in different positions in the run; see §8.

A socket pays even that once, at `hello`, which is a second reason sockets beat HTTP here.

## 3. The bottlenecks, ranked

1. ~~**One transaction per statement.**~~ **Addressed by `[limits] groupCommit` (§4B), on by
   default since 2026-09-13.**
   Every fixed cost above — commit, tail, checksum, encode, append — is paid per row. At 50 rows per transaction the per-row cost is 0.96 µs instead of
   29.04 µs, a **30x** difference. This is the ceiling behind the 25–30k writes/s figure and behind
   the one missed budget in `docs/benchmarks.md` (130k against a 150k WebSocket target, which that
   file already attributes to writes serialising).
2. ~~**Token verification per HTTP request**~~ — **addressed by the verification cache
   (`c020766`)**, and now measured rather than inferred: a token-bearing point read is 58.6 µs
   against 53.7 for the admin key (§2). The uncached EdDSA is still 30.9 µs, which is what the
   cache is worth on a first request per token.
3. ~~**Unconditional zstd**~~ — 9.5 µs, 36% of a write. Now `[durability] compress`; off is 28%
   faster and 4.4x larger (§4C).
4. ~~**One writer thread per process.**~~ **Addressed by `[server] workers` (C4).** Spreading writes
   over 8 databases inside one thread changed nothing (28.8k vs 28.1k msg/s) — the bound was the
   thread, not the database. Sharding those 8 databases over 6 worker threads takes the same load
   to 72 817 writes/s. §5.
5. **HTTP framing** — 35 µs before any query runs. Nothing to fix in bql.sh; it is a reason to
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
   bql.sh's. Apply mechanism A (C5, `docs/c5-apply-pages.md`) removed the WAL frame checksum from
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
Measured with the helper and again with `BQL_WAL_NATIVE=0`:

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
bql.sh reading it back. §3.1 of that document says why the replica cannot stand in for it.

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

> **The ladder above predates the 2026-09-13 defaults and was not re-measured.** Not for lack of
> trying: on a machine this ladder no longer has to itself, five-second throughput runs at the same
> rung returned 11 721 and 49 507 writes/s minutes apart, and a four-worker rung came back at 0.45x
> and then 1.21x of its own one-worker rung. A ladder is a comparison between rungs, so noise of
> that size does not average out — it inverts the result. It wants a machine with six free cores,
> and §8 says how to tell whether you have one.
>
> **The one rung that could be measured says the defaults raised the floor.** At one worker, the
> same 8 databases and 64 sockets, old defaults against new, three interleaved rounds:
> **27 742 · 29 049 · 30 444 writes/s** with `ack: local` and no group commit, against
> **46 026 · 47 935 · 53 610** with the current ones — **1.69x, while also becoming durable**
> (§1). The old-defaults column lands on the 28.8k–29.1k this section already records for that
> rung, which is the cross-check that says the harness is still measuring what it used to.
>
> Whether the multi-worker rungs gain the same 1.69x is the open question. They should gain *less*:
> group commit folds writes queued behind one writer, and sharding is the other way of relieving
> the same queue, so the two are partly buying the same thing.

What is *not* lifted: one database still has one writer, and `workers > 1` still refuses to start
alongside `[cluster] enabled`. Both halves of replication are supported: *serving* replicas as of
C4b — the router owns the replication connection and the worker that owns a database owns its
stream, which costs 15% of write throughput on a single-threaded node and 19% on a sharded one
(`docs/c4b-replication-workers.md` §9) — and *following* an upstream as of C4c, measured above.
Placement (milestone 3) is still what routes across *nodes*.

**The ladder, in the order it pays off**

1. Batch on the client — 24x on bulk writes, available now.
2. Move clients to the socket — ~45% off every read, and no token verification per request.
3. ✅ Cache token verification — done (`c020766`); a token-bearing HTTP read is now 58.6 µs
   against 53.7 for the admin key, rather than the 1.7x this list once predicted.
4. ✅ Group commit on the server — **on by default since 2026-09-13**, and worth 1.69x at one
   worker and 64 clients *while also making every write durable* (§1).
5. ✅ `workers: N` — **2.67x measured, one node, one port** (`docs/c4-workers.md`). Placement
   (milestone 3) is the remaining half, across nodes rather than threads.
6. Replicas for reads, which already work, and placement for writes, which does not yet.

**What does not scale, and cannot be made to.** One database has one writer — that is SQLite, and
it is the trade the whole design takes in exchange for a database per tenant costing nothing. A
single database will not exceed ~42k writes/s in process — that is the one-row rung of §1's group
commit table, 24.17 µs/row — or ~1.8M rows/s if the writes arrive in batches. Concurrency raises
the *first* of those and not the second: group commit turns sixty-four queued single-row writes
into one transaction, which is why a default node reaches ~49k writes/s at 64 clients while a
single serial writer cannot. Ten thousand databases, on the other hand, scale with cores and nodes;
the product is "many small databases", and the write ceiling is per database rather than per
system.

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

## 7. SQLite's own settings — what bql.sh sets, and what it inherits

Read off a live tenant through the registry's `onConnection` hook, so these are the connections
bql.sh actually serves from rather than a fresh one opened beside them.

**Set deliberately**

| setting | value | where | why |
|---|---|---|---|
| `journal_mode` | `wal` | `tenant.ts` (writer), and every other open path | the whole design: readers never block the writer, and the `-wal` is what the tailer ships |
| `synchronous` | `1` (NORMAL) | writer | a commit does not fsync; `ack: "fsync"` and above do it explicitly (`#syncDurable`) |
| `wal_autocheckpoint` | `0` | writer, and the replica applier | **bql.sh owns checkpoints.** SQLite checkpointing on its own could move frames out of the WAL before the tailer recorded them |
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
things bql.sh does not do (uncompressed records, group commit, cached verification), so they are
attribution for this document rather than budgets to hold.

### Two ways this file has been wrong, and how to not repeat them

Re-measuring for the 2026-09-13 defaults turned up two artefacts, and between them they account for
every unexplained movement this document has recorded. Neither was a change in the server.

**The first leg of `bench/http-client.ts` paid for warming the client.** `measure` runs 50
iterations before it starts timing, which warms the *server* — its prepared-statement cache, its
policy memo — and does nothing for this process: Bun's `fetch`, the JSON codec and the keep-alive
socket are cold on the first leg and warm for every leg after it. The proof is an identical leg run
twice in one process:

| the same point read | p50 |
|---|---|
| as the first measured leg | 94.8 µs |
| as the fourth | 56.6 µs |

**40 µs of warm-up, charged to HTTP.** That is the whole of the gap between the 48.2 µs this file
once published and the 87 µs a later run produced, and it is why the HTTP budget row kept crossing
its threshold in both directions. It also invalidated the old "a token nearly doubles an HTTP read"
claim in §2, which compared a first leg against a fourth. Both client paths now warm the transport
before the first leg. **A leg that is only ever measured first is a leg whose number you cannot
compare to anything.**

**Two runaway processes made the machine 1.6x slower for a day.** A shell that simulated CI load
with eight `while :; do :; done` subshells did not kill them; two survived at 100% CPU for 18 hours
and were still running when this re-measurement began. Every latency figure taken in that window is
inflated, and a `git bisect` over the HTTP point read blamed a commit that touches nothing but the
WAL applier — a bisect finds *a* boundary whether or not the thing being measured has one.

So, before taking a number from this file or adding one to it:

- **Check the machine is quiet.** `uptime`, and look at what is actually running. A load average
  above about 4 on this 18-core machine makes every microsecond figure here unreliable, and a
  throughput figure worse — `bench/workers.ts` returned 11 721 and 49 507 writes/s at the same rung
  minutes apart under load.
- **Run the comparison interleaved, A-B-A-B**, on the same machine in the same minutes. Every
  number in §1's defaults table was taken that way, which is why three rounds of it agree.
- **Prefer `bench/router.ts`**, which P6 built to a 4% resolution, for anything within 10%.
  Everything else in this file is a 20%-resolution instrument at best.

## 9. What a thousand databases cost the disk (L5)

New with the L track. `bench/fsync.ts` is the instrument and it exists because nothing else here
measures *many* databases writing at once — every other benchmark in this file runs one. It counts
real syscalls, not policy: `fsyncSync`, `fdatasyncSync` and the callback `fsync` are wrapped for
the life of the process.

### 9.1 The write path already costs exactly two barriers, and group commit is what amortises them

At `ack: "fsync"` — the node's default since 2026-09-13 — every transaction does an `fdatasync` of
the WAL and an `fsync` of the log, inline, before the caller is answered. Measured, `--depth` being
the number of writes each database has in flight at once:

| writes in flight per database | fsyncs per write | writes/s at 100 databases |
|---|---|---|
| 1 | 2.00 | 12 253 |
| 4 | 0.50 | 35 063 |
| 16 | 0.13 | 154 487 |

0.13 is 2/16 exactly: sixteen concurrent writes fold into one transaction, which pays one pair of
barriers between them. **The amortisation a shared fsync sweep would provide is already provided,
by group commit**, and the barrier rate is pinned at 18–24k/s in every row — that is this disk's
ceiling, not the node's.

### 9.2 This disk is fastest when barriers are issued one at a time

Sixty-four files, one barrier each, on an Apple NVMe:

| how | barriers/s |
|---|---|
| serial `fsyncSync` | 30 180 |
| serial `await fsync` (thread pool) | 22 646 |
| concurrent, width 4 | 21 302 |
| concurrent, width 16 | 14 627 |
| concurrent, width 64 | 10 506 |

Concurrency is *slower*, monotonically. So no scheduler can beat the inline behaviour by issuing
differently — only by issuing less, or by issuing off the event loop.

### 9.3 Where the herd actually is: `ack: "local"` at five hundred databases

The interval policy — at most one barrier per log per `fsyncIntervalMs`, issued inline from
whichever append happens to cross the boundary — is what `docs/plan-limits.md` L5 predicted would
hurt, and it does. `ack: "local"`, one write in flight per database, three interleaved rounds each,
medians:

| databases | `per-db` writes/s | `shared` writes/s | `per-db` fsyncs/s | `shared` fsyncs/s | `per-db` p99 | `shared` p99 |
|---|---|---|---|---|---|---|
| 1 | 18 231 | 19 643 | 0 | 0 | 156 µs | 125 µs |
| 10 | 32 372 | 31 624 | 0 | 0 | 0.94 ms | 1.29 ms |
| 100 | 31 715 | 31 998 | 1 008 | 1 067 | 4.09 ms | 4.52 ms |
| 500 | 23 867 | **29 407** | 4 387 | **874** | 40.6 ms | **16.9 ms** |

(At one and ten databases the run is over before a 100 ms interval elapses, so neither setting
issues a barrier at all; those two rows measure the cost of *having* a sweep, which is nothing.)

### 9.4 The decision: `[durability] fsyncSweep` stays `"per-db"`

L5's criterion was that `"shared"` must beat `"per-db"` **at N ≥ 100** on both p99 and barriers per
second. At 500 it wins enormously — 23% more throughput, a fifth of the barriers, and p99 cut from
40.6 ms to 16.9 ms. **At 100 it loses on both**: p99 4.52 ms against 4.09, and 1 067 barriers a
second against 1 008. The criterion is not met, so the default does not move.

Two further reasons, both measured rather than argued:

- **Under the node's default ack the sweep is inert.** `ack: "fsync"` flushes the log inline before
  answering, so the log is already clean when the sweep reaches it and no barrier is issued. A/B at
  `ack: "fsync"`, N = 1 and N = 100: identical within noise, 2.00 fsyncs per write either way. A
  default that changes nothing for the default configuration is not a default worth flipping.
- **Part of the win at 500 is a longer hygiene window, not just better scheduling.** A sweep pass
  over 500 databases takes longer than the 100 ms interval, so the effective interval stretches to
  roughly 570 ms there. For `ack: "local"`, which promises process-crash survival and explicitly
  not power-loss survival, that is a defensible trade — but it is a durability trade, and it should
  be opted into rather than defaulted into.

`[durability] fsyncSweep = "shared"` is therefore shipped and off. Turn it on for a node running
`ack: "local"` with hundreds of write-active databases on one thread;
`bql_fsync_sweep_duration_us` is what tells you the interval has stretched.

**Conditions these numbers were taken under.** §8's bar was met for §9.2 and the `--depth` ladder
(load average 1.8–1.9) and *not* for the ladder in §9.3, which ran at load 6–9. Every row there is
the median of three interleaved A-B rounds, and the 500-database result is the one that survives
that noise by a wide margin; the 100-database result is a 10% effect at a 20% resolution, which is
one more reason the default did not move on it.

## 10. What the statement cache is worth, and where 64 runs out (P7)

`bench/cache.ts`, five interleaved rounds of 20 000 `prepare()` calls a sample. The full finding is
`docs/p7-plan-cache.md`; these are the numbers.

**A `prepare()` hit is 48–80 ns and a `prepare()` past the ceiling is 4.0 µs.** Three runs at three
machine loads:

| leg | load 31 | load 15–17 | load 9 |
|---|---|---|---|
| `hit` | 0.053 µs | 0.080 µs | 0.048 µs |
| `working 64` | 0.034 µs | 0.049 µs | 0.028 µs |
| `working 65` | **6.318 µs** | **4.018 µs** | **4.075 µs** |
| ratio, 64 → 65 | **186x** | 82x | 146x |

It is a cliff rather than a slope because a working set cycled round-robin is the LRU's worst case:
past the ceiling, the text about to come round again is always the one just evicted, so every
`prepare()` compiles *and* finalizes a victim and the hit rate is zero rather than degraded. The
`working 8/32/64` legs read *faster* than `hit` in every run — all four are tens of nanoseconds and
the ordering between them changes run to run, which is this machine's noise floor rather than a
result.

**The generated data API crosses it at six tables.** Twelve texts per table — a get, a narrowed
get, four list shapes, an update, a delete and four bulk-insert widths — replayed warm against one
connection:

| tables | texts | `statementCache` | hit rate |
|---|---|---|---|
| 5 | 60 | 64 | **100.0%** |
| 6 | 72 | 64 | **0.0%** |
| 30 | 360 | 64 | 0.0% |
| 30 | 360 | 512 | **100.0%** |

`bql_statement_cache_evictions_total` rising while the node is serving is the symptom; raising
`[sqlite] statementCache` is the answer. It is per connection, so a tenant pays it once for the
writer and once per pooled reader.

**A token-authenticated write recompiles its statement whether or not the cache had it.**
`sqlite3_set_authorizer` expires every statement on a connection, and scoping a connection to a
token cycles it. A cached hit whose statement has been expired costs 5.119 µs against 0.843 µs, of
which the two FFI calls are 0.021 µs — the rest is the recompile inside `sqlite3_step`. Readers are
scoped once and stay scoped, so this is the write path only, and an admin principal pays none of
it. `docs/p7-plan-cache.md` §4.

**Conditions.** §8's bar was not met: these ran at load 9–31, deliberately, because the effect is
three orders of magnitude and resolves anyway. The one thing that could *not* be resolved here is
small: fifteen interleaved A-B rounds of the 100-row driver scan put the counter-carrying tree at
9.08 µs p50 against the parent's 9.24, inside a within-leg spread of 21%. A 2% gate cannot be
resolved by an instrument whose noise is twenty-one, and that is the reported answer.

## 11. What a recorded row change costs, in bytes (P9)

`bench/replication.ts`, the last section: the same transactions written on two standalone
primaries, one with `[replication] logicalChanges` set and one without, comparing the **total
encoded record bytes** — what goes on the wire, into the log and into the bucket. The full finding
is `docs/p9-logical-cdc.md`.

A count, not a timing, so it resolves on a machine a latency figure would not: these were taken at
load average 10.6–11.9 and two runs of the unchanged shapes agreed to the byte (157 478 → 174 251
both times). §8's bar does not apply to a number that is deterministic.

| shape | off | on | ratio |
|---|---|---|---|
| single-row insert, 200 txns | 157 478 B | 174 251 B | **1.11x** |
| wide row, 200 B of random text, 200 txns | 410 065 B | 425 285 B | **1.04x** |
| 1000 small rows in one txn, 10 txns | 92 931 B | 119 006 B | **1.28x** |
| 1000 updates at `row+old`, 10 txns | 80 061 B | 108 477 B | **1.35x** |

**The plan expected worse than this, and the reason it is not worse is zstd.** `docs/plan-phase3.md`
warned that "a row-heavy transaction can carry more logical bytes than page bytes", which would be
a ratio above 2x. It never approaches one. The record body is compressed as a whole, and the row
values are *already in the page images* the same body carries — so the logical section is largely a
second copy of bytes zstd has just seen, and it codes as a back-reference rather than as itself.

The wide-row row is where this is most visible and most counter-intuitive: 200 bytes of
incompressible text per row adds **76 bytes** to the record, not 250. The worst shape is the
opposite one — a thousand *small* rows in one transaction, where the pages are few and the row
count is what the logical section is paid per — and even that is 1.28x.

### The write path, which did not resolve

The flag also makes the primary capture rows for every database it opens, whether or not anything
local is subscribed, and raises the level it captures at from `pk` to `row`. Four interleaved A-B
rounds of 3 000 single-row writes straight at the writer, at load 11–13:

| | p50, mean of the rounds | spread across rounds |
|---|---|---|
| `logicalChanges` off | 81.2 µs | **25.2%** |
| `logicalChanges = "row"` | 83.5 µs | 6.3% |

**2.9% against a 25% instrument. That is not a number; it is noise, and it is reported as noise.**
Two interleaved rounds of the same script said 15.5% — the run-to-run movement is larger than the
effect, which is L5's outcome and the reason §8 exists.

### Preupdate capture is not ~50 ns a row

Design §4.6 and §4.7 both say "hook cost is ~50 ns per row", and **this does not reproduce.** Five
thousand inserts in one transaction, fifteen interleaved rounds on one connection, the level
changed between rounds and the delta taken *within* each round so a machine whose load moves
between rounds cannot carry it:

| capture level | median | paired cost over `off` — median (min, max) |
|---|---|---|
| `off` | 244.7 ns/row | — |
| `pk` | 498.9 ns/row | **252.0** (26.9, 565.2) ns/row |
| `row` | 619.1 ns/row | **349.4** (227.8, 478.1) ns/row |

**Where the 50 ns came from: the other hook.** Run again with `engine: "update"` — the fallback for
a libsqlite3 built without `SQLITE_ENABLE_PREUPDATE_HOOK` — the same script reports a paired cost
of **84.9 ns/row at `pk` and 75.9 ns/row at `row`**, with a paired *minimum* that goes negative,
which is what an effect too small for this instrument looks like. That is the ~50 ns figure.
Design §2.3's own table is where it came from: 0.18 µs for an insert against 0.23 µs "with JS
`update_hook` firing". The number is real and it is the update hook's; §4.6 attached it to the
preupdate bullet, and the preupdate hook is the engine bql.sh actually runs.

| engine | `pk` | `row` | reads values? | `WITHOUT ROWID`? |
|---|---|---|---|---|
| preupdate (default) | 252 ns/row | 349 ns/row | yes | yes |
| update (fallback) | 85 ns/row | 76 ns/row | no | no |

So the preupdate hook roughly **doubles** a bulk insert's per-row cost at `pk` and roughly triples
it at `row`, and the values are what it buys. The floor across fifteen rounds — 227.8 ns/row for
`row` — is 4.5x the documented figure, and the machine's load biases *upward*, so load cannot
explain a gap in this direction. §8's bar was not met (load 9–13) and the paired minimum is quoted
for that reason: the claim is "at least this much", which noise does not manufacture.

This is a correction to design §4.6, not a cost P9 introduced: it is the price of the change feed
as a whole, which any database with a subscriber has been paying since phase 0. What P9's flag adds
on top is the `pk` → `row` step, about 100 ns a row, and the same capture on databases that had no
subscriber at all.
