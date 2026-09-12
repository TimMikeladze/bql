# Performance — where the time goes, what to do about it, and how it scales

Written 2026-09-12. `docs/benchmarks.md` says what each path costs; this says **what the cost is
made of**, which is what an optimisation has to be argued against. Every number here came from
`bun run bench/profile.ts` or from a probe named beside it, on the machine in `docs/benchmarks.md`
(M5 Pro, macOS 26.6.2, vendored SQLite 3.53.4).

The short version: **SQLite is not the bottleneck anywhere.** A write spends 29% of its time in
SQLite and 71% in BunQL's own record pipeline. A read spends 0.79 µs in SQLite and arrives 28 µs
later on a socket. Both ceilings are ours to move.

## 1. Where a write goes

One row per transaction, because that is the shape of `/v1/db/:db/query` — every statement is its
own transaction, so a transaction's fixed cost is paid per row.

| stage | p50 µs | share |
|---|---|---|
| `BEGIN IMMEDIATE` + insert + `COMMIT` | 8.21 | 29% |
| `recorder.poll` — tail the WAL, checksum the pages | 8.04 | 28% |
| `encode` — frame the record, **zstd level 3** | 10.21 | 36% |
| `log.appendEncoded` — write the segment | 1.96 | 7% |
| **total** | **28.42** | |

That total reproduces the 28.2 µs `bench/tenant.ts` reports for the whole write path, so the four
stages are the whole write.

**Compression is the single largest line item in a write**, and it is unconditional —
`FLAG_ZSTD` is always set in `src/wal/record.ts`.

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

1. **One transaction per statement.** Every fixed cost above — commit, tail, checksum, encode,
   append — is paid per row. At 50 rows per transaction the per-row cost is 0.96 µs instead of
   29.04 µs, a **30x** difference. This is the ceiling behind the 25–30k writes/s figure and behind
   the one missed budget in `docs/benchmarks.md` (130k against a 150k WebSocket target, which that
   file already attributes to writes serialising).
2. **Token verification per HTTP request** — 28 µs, unbatched, uncached, on every request.
3. **Unconditional zstd** — 9.5 µs, 36% of a write, for a ratio nobody chose per deployment.
4. **One writer thread per process.** Spreading writes over 8 databases changes nothing (28.8k vs
   28.1k msg/s), so the bound is the process, not the database.
5. **HTTP framing** — 35 µs before any query runs. Nothing to fix in BunQL; it is a reason to
   prefer the socket, and a reason the Data API (§H4) should be reachable over the socket too.
6. **`recorder.poll` at 8 µs** — the WAL tail and the page checksums. Unavoidable in mechanism B,
   and the price of physical replication.

## 4. What to do about it, in order of measured win per unit of risk

**A. Cache token verification.** 28 µs → a map lookup, on every HTTP request. Key an LRU by the
token's hash; store the principal and the token's own `exp`; check the revocation set by `jti` per
request, since that is a set lookup and is the only part that can change between requests. Bounded
size, so a flood of distinct tokens cannot grow it. This is the cheapest large win in the list and
it touches one file (`src/server/auth.ts`).

**B. Group commit.** Coalesce writes that arrive while the writer is busy into one SQLite
transaction. Measured headroom, per row:

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

**C. Make compression a policy, not a constant.** 9.5 µs buys 4.3x. That is an excellent trade
when the record crosses a WAN to a replica or goes to S3, and a poor one for a single node writing
to a local NVMe. Options, cheapest first: a size threshold (skip zstd below one page, where the
ratio is lowest and the CPU share highest); a `[durability] compress` setting; or compress
**after** the ack for `ack: "local"`, since the record only has to be compressed before it ships,
not before the client is answered. The last one keeps the ratio and moves the cost off the hot
path entirely — it is the right answer and the most work.

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

**F. Replica apply mechanism A.** Already on the roadmap (phase 2, milestone 5). It removes the
48 µs "replica read sees the row" leg, which is a WAL rescan forced by mechanism B.

## 5. How this scales

**Reads scale horizontally today, and well.** A replica serves reads locally from its own copy, so
read capacity is per node. Measured per process: 219k–259k reads/s on a socket, ~50k/s over HTTP,
against an engine that can do ~1.3M/s in process — so reads are transport-bound, and adding nodes
adds close to linear capacity.

**Writes scale by sharding databases across processes, and that works — but nothing routes for you
yet.** Measured, same client, same 8 databases, same total load:

| | writes/s |
|---|---|
| 1 process, 8 databases | 17 214 |
| 4 processes, 2 databases each | 39 734 |

2.31x on 4 processes, with the single load client likely the next limit. This is exactly what
`workers: N` (phase 2, milestone 4) would do inside one process and what placement (milestone 3)
would route to. Until both land, the scale-out path is manual: run several nodes and put databases
on different ones.

**The ladder, in the order it pays off**

1. Batch on the client — 24x on bulk writes, available now.
2. Move clients to the socket — ~40% off every read, and no token verification per request.
3. Cache token verification — 28 µs off every HTTP request (A).
4. Group commit on the server — up to 30x on concurrent single-row writes (B).
5. `workers: N` + placement — 2.3x measured across processes, and the thing that makes a single
   node use its cores.
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

**Inherited from SQLite, never set:** `cache_size` (-2000), `mmap_size` (0), `temp_store` (0),
`foreign_keys` (**0**), `auto_vacuum` (0), `secure_delete` (0), `journal_size_limit` (-1),
`trusted_schema` (1), `cell_size_check` (0), `defensive` (off), `recursive_triggers` (0),
`threads` (0), `analysis_limit` (0). There is also no `ANALYZE` and no `PRAGMA optimize` anywhere
in `src/`, so no database ever collects planner statistics.

Which of those are worth changing, measured:

- **`foreign_keys` is off, so a declared foreign key is enforced on nothing.** Not a performance
  matter — a correctness one, already recorded in `docs/next.md`. It is per connection and would
  change the meaning of existing schemas, so it belongs behind a per-database setting.
- **`cache_size` and `mmap_size` are the two real levers**, and §4E has the numbers.
- **Hardening is off, and `POST /v1/db/{db}/import` accepts a SQLite file.** The import is
  admin-only, size-capped and header-checked, but the file it accepts is then opened by the same
  process that serves every other tenant. `defensive`, `trusted_schema = 0` and `cell_size_check`
  are SQLite's own recommendations for a file you did not write, and none is set. The driver has
  no `sqlite3_db_config` binding at all, so `defensive` is not currently reachable.
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
