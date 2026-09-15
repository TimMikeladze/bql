# Limits — admission control for a node with a thousand tenants

Written 2026-09-14, after an architecture review of the tree at `e268498`. This is the plan of
record for the **L track**. `docs/design.md` §4.7 (the fd budget), §5.4 (ack levels) and §10 (the
budgets) are the design it implements; `docs/next.md` is the handoff that points here.
`docs/timeseries-assessment.md` raised two of these findings first and they are still open.

## The one sentence

Nearly every shared resource in BunQL is bounded **per tenant** and unbounded **per node** — at
one database that is invisible, at a thousand it is the entire failure surface.

Phases 0 through 2 built the parts that are hard: one writer per tenant, a physical log with three
consumers, share-nothing worker shards, Raft off the data path. None of that changes here. What
this track adds is the boring half nobody writes until a node falls over: a ceiling on each shared
resource, a refusal when it is reached, and a number that says how close it is.

## The rule, applied uniformly

Every shared resource gets three things:

1. **A ceiling that is a node-level number.** Per-tenant limits multiplied by open tenants is not
   a limit.
2. **A refusal that is a typed error with a retry hint** — never an OOM, never an unbounded wait.
3. **A metric**, so the ceiling is observable before it is reached rather than after.

A cap that is "a target, not a promise" is allowed in exactly one case: where the overshoot is
bounded by the duration of one statement. `TenantRegistry.#evict` skipping a `busy` tenant
qualifies. Skipping a `pinned` one does not, because a pin lasts as long as a client keeps a
subscription open (L4).

## What does not change

Zero runtime dependencies. No change to the WAL record, the replication transport, the Raft state
or the Hrana surface. The wire gains new error codes and one response header, nothing else. The
embedded and single-tenant paths pay nothing measurable: every ceiling is an integer compare
against a counter the code already maintains.

## Config

New keys, all with defaults chosen so an existing deployment behaves the same until it is the one
misbehaving.

| key | default | what it bounds |
| --- | --- | --- |
| `[limits] maxResultBytes` | `67108864` (64 MB) | bytes accumulated for one result, checked while stepping |
| `[limits] maxQueuedWrites` | `256` | `writeQueued` entries waiting on one tenant |
| `[limits] maxQueuedWriteBytes` | `8388608` (8 MB) | SQL + bound args waiting on one tenant |
| `[limits] queueWaitMs` | `5000` | how long a queued write waits before it is refused |
| `[limits] maxPinnedPerPrincipal` | `64` | databases one principal can hold open with subscriptions |
| `[data] maxOpen` | `1024`, **now node-wide** | open tenants across every worker, not per worker |
| `[durability] fsyncSweep` | `"shared"` | `"shared"` or `"per-db"` (the current behaviour, the back-out) |
| `[storage] maxConcurrentUploads` | `8` | in-flight S3 requests across every shipper on a thread |

`maxRows` keeps its meaning and its default (`10000`). What changes is *when* it is enforced (L1).

## New error codes

| code | status | when |
| --- | --- | --- |
| `RESULT_TOO_LARGE` | 413 | `maxResultBytes` reached mid-step |
| `WRITE_QUEUE_FULL` | 503 + `Retry-After` | `maxQueuedWrites` or `maxQueuedWriteBytes` reached |
| `WRITE_QUEUE_TIMEOUT` | 503 | queued past `queueWaitMs` without reaching the writer |
| `TOO_MANY_OPEN` | 503 | the LRU cannot make room because everything is pinned |
| `PIN_LIMIT` | 429 | this principal already holds `maxPinnedPerPrincipal` databases open |

`TOO_MANY_ROWS` is unchanged, and is now thrown from inside the step loop.

## Files

| file | change |
| --- | --- |
| `src/sqlite/statement.ts` | `values()` and `objects()` take a row and byte budget; throw at the boundary |
| `src/server/exec.ts` | pass the budget down instead of checking `rows.length` after the fact |
| `src/tenant/tenant.ts` | queue admission, queue wait deadline, cancellation |
| `src/tenant/registry.ts` | node-wide `maxOpen`, pin accounting by owner, refusal when the LRU is stuck |
| `src/server/workers/pool.ts` | divide the node budget across shards; one fd probe, not N |
| `src/server/runtime.ts` | pin with the principal as owner; release on socket close |
| `src/wal/log.ts` | append registers an fsync intent rather than owning a timer |
| `src/durability/sweep.ts` | **new** — the shared fsync sweep |
| `src/storage/pool.ts` | a shared upload budget every shipper borrows from |
| `src/server/metrics.ts` | the gauges below |
| `package.json` | `files` gains `scripts/` and `vendor/` |

## Metrics

`bunql_result_bytes_max`, `bunql_write_queue_depth`, `bunql_write_queue_rejected_total`,
`bunql_tenants_pinned`, `bunql_open_refused_total`, `bunql_fsync_total`,
`bunql_fsync_sweep_duration_us`, `bunql_upload_inflight`, `bunql_upload_waiting`.

Each merges across workers by the rule C4e established: disjoint shards, so counters sum, gauges
sum, positions max.

---

## Milestones

### L1 — a result is bounded while it is built

`src/server/exec.ts:157` materialises every row with `stmt.values()` and checks `maxRows` at
`:167`. The deadline is a progress handler firing every 1000 VM steps
(`src/sqlite/statement.ts:403`), so it bounds **time**, not allocation. A scan returning 20M rows
inside `queryTimeoutMs` allocates 20M JavaScript arrays before anything looks at the count, and
the OOM takes the process — every shard, not just the tenant's.

The loop to fix is already there (`statement.ts:253`):

```ts
let rc = s.sqlite3_step(h)
while (rc === SQLITE_ROW) {
  out.push(this.#values())
  rc = s.sqlite3_step(h)
}
```

Thread `{ maxRows, maxBytes }` into `values()`, `objects()` and the iterator; throw
`TOO_MANY_ROWS` or `RESULT_TOO_LARGE` at the boundary and `sqlite3_reset` on the way out. Count
bytes as they are decoded — `#values()` already knows each cell's size, so it is an add, not a
second pass.

Writes with `RETURNING` must keep rolling back: the throw crosses `tenant.write`, which already
rolls the transaction back, and a test asserts nothing persisted.

**Done when:** a table of 5M rows queried without a `LIMIT` refuses in bounded memory (assert peak
RSS, not just the error), `RETURNING` past the cap rolls back, and the driver benchmark moves less
than 2% on the 100-row scan.

### L2 — write admission is bounded

`Tenant.writeQueued` (`src/tenant/tenant.ts:659`) pushes onto `#queue` with no ceiling.
`maxGroupCommit` bounds a drain, not the backlog. A tenant whose disk stalls accumulates pending
promises until the heap ends, and a caller waits however long that takes.

Add: a queued count and a queued byte total, both checked before the push; a wait deadline armed
at push time; and cancellation, so an entry whose caller has gone is dropped rather than committed
for nobody. `AbortSignal` from the request is the natural carrier — the route layer already has
one.

The refusal must carry `Retry-After` derived from the current drain rate, not a constant.

**Done when:** a tenant fed faster than it commits refuses with `WRITE_QUEUE_FULL` at a steady
queue depth instead of growing, a client that disconnects mid-queue has its entry dropped before
the writer sees it, and the group-commit benchmark is unchanged.

### L3 — the fd budget is a node number

`TenantRegistry` warns when `maxOpen * 7` exceeds `ulimit -n` (`registry.ts:669`). Each worker
builds its own registry with the same `config.data.maxOpen` (`runtime.ts:270`), and Bun workers
are threads sharing one fd table — so `workers: 8, maxOpen: 1024` can hold 8192 tenants and about
57,000 fds while each thread independently warns about 7,168. The check under-reports by exactly
`workers`.

`data.maxOpen` becomes the node's number. The pool divides it — `floor(maxOpen / workers)`, at
least 8 per worker — and passes the share down. The fd probe runs **once on the router** and the
result is passed in the worker's config; today it is N subprocess spawns of `sh -c ulimit -n`, and
on Windows, a gating platform since E2, `sh` does not exist so it silently returns null and warns
nobody. Use `process.report.getReport().header` or a documented null on Windows.

**Done when:** a node started with `workers: 8, maxOpen: 1024` holds at most 1024 tenants across
every shard, `GET /v1/db` and `/metrics` agree on the total, and the fd warning fires once with
the node's real requirement.

### L4 — a pin is not a licence

`#evict` skips `busy` and `pinned` tenants and then admits the new one regardless
(`registry.ts:625-638`): *"the cap is a target, not a promise a correct write can break."* True for
`busy`, which lasts one statement. Not true for `pinned`, which is held by subscribers
(`runtime.ts:1052,1175`, released at `:1273` when the last subscriber leaves) for as long as a
client likes. A client opening one subscription against each of 2000 databases pins 2000 tenants
past `maxOpen`, and nothing refuses it.

Two changes. Pins are already keyed by owner — make the owner the **principal**, and cap distinct
pinned databases per principal at `maxPinnedPerPrincipal`, refusing with `PIN_LIMIT`. And when
`#evict` cannot reach the cap because everything left is pinned, the *open* is refused with
`TOO_MANY_OPEN` rather than admitted. A `busy` tenant still overshoots, still bounded, still
documented.

**Done when:** a principal subscribing past the pin limit is refused while other principals are
unaffected, a node whose LRU is fully pinned refuses a new open instead of exceeding `maxOpen`,
and a dropped socket releases its pins (kill the socket, assert the count returns).

### L5 — one fsync sweep per thread

The interesting one, and the only one here that needs a design rather than a bound.

Each tenant's log fsyncs on its own 100 ms interval (`wal/log.ts:199,493`). There is no
coordination, so 500 write-active tenants can ask the disk for 5,000 barriers a second, scheduled
by nothing. This is the ceiling a real deployment meets first and the one the microbenchmarks
cannot show, because they run one database.

**Be honest about the win.** Separate files cannot be fsynced by one syscall, so this does not
reduce the count to one. What it does is make the count *scheduled*: appends register an intent
with a per-thread `FsyncSweep`; the sweep runs on one timer, walks the logs with an intent
outstanding, fsyncs them with a concurrency of one, and resolves every `ack: "fsync"`, `"replica"`
and `"quorum"` waiter whose append the completed fsync covers. Depth is bounded, latency becomes
predictable, and the disk sees a serialised stream instead of a herd. A log that has been swept
within `fsyncIntervalMs` is skipped, which is where the reduction actually comes from.

Rejected alternative, written down so it is not re-proposed: **one node-wide log**. It would make
this a single fsync, and it would also make per-database shipping, retention, PITR and
divergence-repair a scan of a shared file. The log's per-database identity is load-bearing across
`src/storage/` and `src/replication/`; one syscall is not worth it.

`[durability] fsyncSweep = "per-db"` restores today's behaviour, and is the back-out if the sweep
loses to it on any workload.

**Measure first.** `bench/fsync.ts` is part of this milestone, not a follow-up: N active tenants
writing concurrently, reporting fsyncs/second, p50/p99 commit latency and queue depth, for N in
{1, 10, 100, 500}, under both settings. The number decides the default.

**Done when:** the benchmark exists and is recorded in `docs/performance.md`, `"shared"` beats
`"per-db"` at N ≥ 100 on both p99 and fsyncs/second without losing more than 5% at N = 1, and no
`ack: "fsync"` caller is ever answered before the fsync covering its append returned (a crash test
proves this, not a comment).

### L6 — a global upload budget

`ShipperPool.attach` creates one `Shipper` per open tenant, each with its own drain timer
(`shipper.ts:344`), and nothing caps how many are in flight together. 1024 shipping tenants are
1024 upload chains competing for one thread's sockets and the bucket's rate limits.

One semaphore per pool, `maxConcurrentUploads` permits, acquired around the upload rather than
around the drain, so a shipper that is only encoding does not hold one. Waiters are FIFO by oldest
pending record, so the furthest-behind database is not starved by a busy one. A shipper that
cannot acquire within its interval re-arms rather than queueing a second drain.

**Done when:** 200 tenants shipping concurrently show at most `maxConcurrentUploads` in flight,
`bunql_upload_waiting` is non-zero under that load, and the furthest-behind database's lag is
bounded rather than monotonic.

### L7 — ship a tarball that can build its own engine

`package.json` `files` is `["LICENSE","src","docs/design.md","docs/api.md","README.md"]`. It
excludes `scripts/` and `vendor/`, so `bun run sqlite:build` — advertised in `package.json` and in
the README — is not in the published package. A clone with a locally built library hides this
completely.

Add `scripts/` and the `vendor/` layout. Then the gate that catches it next time: a CI job that
runs `npm pack`, installs the tarball into a clean temp directory, and runs `sqlite:build` plus a
smoke test there. Not a clone, not a workspace link — the tarball.

**Done when:** that job is green on macOS and Linux and `docs/c6-packaging.md` records the install
path it proves.

### L8 — a change event per statement inside a fold *(stretch; unblocks two things)*

Group commit is on (`config.ts:470`) while `docs/next.md:323` still says it is off — that line is
stale and contradicts `:160`, which is right. Fix the doc as part of this.

The real item underneath: folded writes share a txid and the change feed emits one event per fold,
which is why the contract was contentious. Emit one change event per statement, keyed
`(txid, seq)`, and both the group-commit contract and the durable-feed problem loosen at once —
a downstream consumer can dedupe on a stable key across a replay, which an in-memory ring that
answers `reset` cannot support today (`docs/next.md`, realtime gaps).

This is the seam anything downstream needs — including feeding an analytical store — so it is
listed here rather than left implicit.

**Done when:** a fold of 50 writes emits 50 events sharing one txid with distinct `seq`, SSE and
WebSocket agree, and `docs/api.md` describes the key.

## Order, and why

L1 and L2 first: they are days of work and they remove the two ways a client ends the process. L3
and L4 next, because together they make `maxOpen` mean something, and one of them is a
denial-of-service reachable by an ordinary client. L5 is the one that changes what "a thousand
databases" costs and it needs its benchmark before its code. L6 and L7 are small. L8 is separable
and worth doing when the feed is next touched.

## Out of scope

Columnar storage, time-series features and any second execution engine — see
`docs/timeseries-assessment.md`, which concludes that belongs in a different product. Per-tenant
CPU or memory quotas, which threads cannot enforce; that is the process-per-shard conversation and
it is not open. Distributing one large tenant across cores or nodes.
