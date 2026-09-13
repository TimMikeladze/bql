# Resume here — state of BunQL and what to do next

Rewritten 2026-09-13, at the end of the session that went after the list the previous one left.
**Three of the things on that list turned out to be bugs rather than chores**, and each was
diagnosed wrongly before it was diagnosed rightly:

- Windows was not failing on a file copy. It was failing because BunQL writes shared memory
  through a file descriptor (E2).
- P5's "flaky test" was not flaky. A checkpoint was folding away frames the log had never seen,
  and a `kill -9` in that window was unrecoverable.
- The retention test's "race" was the node refusing a client's write because it had decided, on
  its own timer, to snapshot itself.

Read this, then `docs/e2-windows-gate.md`, `docs/p5-deferred-compression.md` §6 and
`docs/performance.md` §8 — the three above — then `docs/r8-per-db-ack.md`,
`docs/r9-segment-index.md`, `docs/r10-read-transactions.md`, `docs/p6-router-resolution.md`,
`docs/e1-windows.md`, `docs/c5-apply-pages.md`, `docs/p4-router-hop.md`, `docs/design.md` §0, §11
and §14, then `docs/api.md`. Plans of record: `docs/plan-phase2.md` (the cluster) and
`docs/plan-surfaces.md` (HTTP, OpenAPI, GraphQL).

## Where things stand

**Phases 0, 1 and 2 are complete, and so is the surfaces track.** C1-C6, C3a/C3b, C4-C4e, H1-H8,
P1-P6, R1-R10, E1-E2. On `main`, pushed to **https://github.com/TimMikeladze/bunql** (private).
`bun test` → **1485 pass, 2 skip, 0 fail** across 124 files, and green again with
`BUNQL_WAL_NATIVE=0` (run it both ways; the second is what proves the JavaScript fallback).
`bun run typecheck`, `bun run bytes` and `bun run routes:check` clean. Zero runtime dependencies.

### What this session changed, newest first

**A snapshot parks a write; it does not refuse one.** `test/server/retention.test.ts` failed about
half the time with "expected 9, received 8": nine writes issued, eight landed, and the ninth came
back `503 BUSY: acme is taking a snapshot` to a test that never checked a status. The snapshot was
the node's own — `ServerRuntime.maybeSnapshot` takes one from the retention sweep — so a client
doing nothing unusual was refused because the node had decided to snapshot itself. `#drain` was
already written to wait a snapshot out; only the guard at the top of `writeQueued` disagreed, and
neither `snapshot()` nor `fork()` scheduled the drain that would have released the wait. A baton
transaction stays a refusal (it can hold the writer for `txIdleTimeoutMs`); a snapshot is a
TRUNCATE checkpoint and a reflink. Bisected to the 2026-09-13 defaults, which widened the window
rather than creating the race.

**Nothing leaves the WAL before it has been recorded (P5 §6).** The "one run in six" crash test was
not flaky. `#maybeCheckpoint` carried a comment saying the write path had already appended — true
until P5 made `#capture` defer — so a write crossing `checkpointWalBytes` checkpointed frames the
log had never seen. A `kill -9` there left a database ahead of its log with no WAL left to
re-derive from: the one state the reconcile cannot repair, and it says so as `LOG_DIVERGED`. The
fix is the rule `snapshot()` and `drain()` already follow. `close()` had the same hole one size
smaller.

**Windows: the wal-index is published through its mapping (E2).** E1 blamed `tenant.snapshot()`
copying an open file. Grouping the job's `EBUSY` stacks by *frame* rather than by message puts 750
of them at one site and none in `snapshot()`: mechanism A writes the `-shm` file through a
descriptor while its own connection has that file mapped, which POSIX keeps coherent and Windows
refuses outright (`ERROR_USER_MAPPED_FILE`, reported as `EBUSY`). `walIndexWriteHdr` stores into
the mapping and fences with `xShmBarrier`; so does BunQL now, on every platform rather than behind
a `win32` branch — a branch would leave the new path exercised only by the one job that cannot be
run locally.

**DDL reaches the SSE change feed**, not only the WebSocket, and a `tables` filter does not narrow
it. **The HTTP benchmark stopped measuring its own warm-up** — 40 µs charged to the first leg it
measured, which is the whole of the distance between the 48.2 µs and the 87 µs this repo has
published for the same point read (`docs/performance.md` §8). **There is a release workflow**, and
what it still needs is in its own header. **`docs/performance.md` §1 and §5 now describe a default
node**, including the finding that the durable default is *1.69x faster* than the non-durable one
it replaced once sixty-four clients are writing.

**Windows has run, and it is not what C5 predicted (E1).** The prediction was that `xShmLock` might
be unreachable and a replica would fall back to mechanism B with a warning. Instead the vendored
build compiles on `windows-latest`, loads, and reports **every** capability — `snapshot` and
`walsum` included — and mechanism A runs. **1346 of 1498 tests pass.** The 150 that fail are almost
all one cause: `EBUSY`. **The cause E1 named for it was wrong** — see E2 above and
`docs/e2-windows-gate.md` §1; it is a descriptor write to a mapped `-shm`, not a copy of an open
database file — but "one cause, 150 symptoms" was right, and it is what made the fix a day's work
rather than a month's. Getting there also fixed two portability bugs — `URL.pathname` is `/D:/…` on Windows
and no file API takes it, and a bare `"sqlite3.dll"` candidate is a request to the loader to search
`PATH`, which found something and segfaulted.

**The router's headers cross flat, and it is worth about 8% (P6).** P4 left two suspects and no
instrument fine enough to choose. The instrument came first: `bench/router.ts` resolves **4%** and
reports its own resolution before anything else — control against control, 40 interleaved rounds,
median ratio 1.002. It also says where it cannot be trusted: the same *node* against itself is
0.978 at four workers and **0.674 at one**, so a node A/B is run twice with the trees swapped and a
single-worker comparison is not reportable at all. The finding: **it is the headers, not the body.**
Removing the body clone is worth 6.6% of a hop; removing the header clone is worth 37.5%; and
flattening the pairs to one `"key\nvalue"` string recovers 19.2%, split included. On a real
four-worker node against its own parent tree, position cancelled: **1.076x, honest band 5-11%**,
roughly 54 000 → 60 000 reads/s. Transferring the body instead of cloning it was tried and
**reverted** — nothing, then slightly worse than nothing.

**A read transaction lives on a pooled reader (R10).** `BEGIN TRANSACTION READONLY` — what
`@libsql/client` emits for `transaction("read")` — was refused on a replica because `Tenant.txBegin`
takes the *writer* whatever the mode. It now takes a leased reader, on **both** roles, so it works
on a replica and no longer blocks writes on a primary. Bounded by `[limits] maxReadTx` (16),
the existing idle timeout and `[limits] readTxTimeoutMs` (30 s). Building it found a five-second
event-loop stall: `WalApplier.#acquire` spun with `Bun.sleepSync` for up to `applyBusyMs` = 5000,
buying patience the replica's asynchronous retry already had. **`applyBusyMs` is now 25 ms** and the
retry backs off 5 ms → 250 ms.

**The S3 manifest stopped being rewritten whole (R9).** The item this file carried since R3 — "the
shipper re-uploads the open segment as it grows" — **was false**, and measuring it said so: no
segment key is ever uploaded twice. What the measurement found instead was worse. The manifest is
rewritten on every drain and carried an entry per segment ever shipped, so a database's backup cost
O(n²) in its drains: at the defaults, a database committing once a second reaches a 650 MB manifest
and re-uploads it every second. On 400 drains: **28.2 MB of manifest for 296 KB of records**. The
inventory now lives in immutable chunks under `index/`, found by listing rather than named, and the
manifest keeps only the tail — **2.26 MB for the same 400 drains, and bounded rather than growing.**

**`ackWithoutReplicas` is per database (R8).** A node with ten databases and a replica on one of
them no longer refuses `ack: "replica"` on the other nine. Same shape as per-database `foreignKeys`
— a nullable catalog column and `PATCH /v1/db/{db}` — but read at ack time rather than held on a
connection, so setting it closes nothing.

### The three defaults, settled: production ones

Asked at the start of the session and answered at the end of it — *"take recommendations"*. All
three are flipped, and each is a client-visible change rather than a tuning knob, so each is written
down in `docs/api.md` as well as here.

1. **`[durability] defaultAck` is `"fsync"`**, was `local`. A write is on this machine's disk before
   it is answered, which is what `synchronous_commit = on` means in Postgres and
   `innodb_flush_log_at_trx_commit = 1` in MySQL. **Benched before flipping, as promised: a
   single-row write goes 24.0 µs → 65.0 µs at p50** on an Apple SSD — a 2.7x tax, not the 5x cliff
   that would have changed the answer. `ack: "local"` is the opt-out. Deliberately **not**
   `"replica"`: that couples every write's success to a peer being attached, so one restarting
   replica takes writes down.
2. **`[durability] deferAppend` is on.** With `defaultAck` now `fsync` it is dormant — it only
   applies to `ack: "local"` — and that is the point: a deployment that chooses `local` for speed
   gets the safe fast version without having to know the flag exists.
3. **`[limits] groupCommit` is on.** 4.7x at 64 concurrent clients, 2.2x at four, and **15% slower
   for a single client** with nobody to fold with. It changes what a client sees and the change is
   documented rather than defaulted away: folded writes share one txid, so the change feed emits one
   event per fold and `BunQL-Min-Txid` is coarser — never weaker, since a txid covering more than
   your write still satisfies read-your-writes.

**The two e2e tests that asserted one txid per write were rewritten, not deleted**, because they are
where that contract lives: they now assert that every write is answered, that there are no more
transactions than writes, and that the fold is visible in the change feed. `test/e2e/scenario.test.ts`
and `test/e2e/phase1.test.ts`.

### What the performance session established, and it still shapes where to look

`docs/performance.md` takes both hot paths apart. The headline: **SQLite is not the bottleneck
anywhere.** A single-row write is 28.4 µs, of which SQLite is 8.2 (29%), the WAL tail and page
checksums 8.0, zstd 10.2 (36%) and the segment append 2.0. A point read is 0.79 µs in the driver
and 2.5 µs serialised, against 28 µs over a socket and 48 over HTTP — so the transport is the cost
and the query is a rounding error on top.

Throughput, per *thread*: **~220k reads/s on a socket, ~50k/s over HTTP, 25–30k writes/s** no
matter how many databases they are spread over. That was the case for `workers: N`, measured rather
than assumed, and C4 acted on it: the same eight databases across six worker threads now do 72 817
writes/s behind one port (`docs/c4-workers.md` §9).

**C4c corrected one of those three numbers as a case for sharding.** Writes and HTTP reads do scale
across workers; **socket reads do not, and lose about 10%**, because the router relays every frame
and a point read is cheaper than the relay. So "per thread" was the right unit for two of the three
legs and the wrong one for the busiest. `docs/c4c-replication-follow.md` §9.

| landed in the performance session | commit | what it is |
|---|---|---|
| README rewritten from `src/`, surface subpaths exported | `ebf5555` | `bunql/core`, `/http`, `/openapi`, `/dataapi`, `/graphql` now resolve; `test/package/exports.test.ts` fails if a doc imports a subpath the package does not publish |
| Apple libsqlite3 correction | `724eb97` | it *has* preupdate/session/snapshot on macOS 26; what differs is its page-cache default, and six tests fail on it. `docs/c6-packaging.md` §1.1 |
| performance audit | `12f94a1` `cbe1cd8` | `bench/profile.ts`, `docs/performance.md`, and the SQLite settings audit read off live connections |
| `[sqlite]` + token cache | `c020766` | pragmas stated rather than inherited; EdDSA verification cached, so an HTTP read with a real token went 76.4 µs → 45.3 |
| `[durability] compress` | `ea1f73f` | zstd is 36% of a write; off is 28% faster and 4.4x larger. Per record, so a mixed log still replays |
| group commit | `80ac667` | `[limits] groupCommit`, **opt-in**: 4.7x at 64 concurrent clients, 15% slower at one |
| snapshot floor + WAL-tail negative result | `179f3a9` | every node now takes a local snapshot, so retention cannot make it unrestorable; and the WAL tail is memory-bound, proven by an allocation-free rewrite that changed nothing |

| landed in this session | what it is |
|---|---|
| C4d: the Raft lease from a worker | `ClusterLink` in `src/cluster/node.ts` (the whole of what the `Promoter` needs from the control plane), `src/server/workers/cluster.ts` (`HostedCluster` — the pushed table, the measured clock offset, two round trips; and `ClusterShards` — the per-shard owned map, the view push, the relays), `clusterMode: "own" \| "routed" \| "hosted"` and `owns(db)` on `ServerRuntime`, five envelopes down and four up in `workers/protocol.ts` plus `role` for the router's own catalog read, `bench/workers.ts --cluster`, `test/server/workers-cluster.test.ts`. **`[cluster] enabled` beside `workers > 1` no longer refuses — it was the last one, and `WORKERS_UNSUPPORTED` is gone from the vocabulary with it.** The write path costs no message: 86 573 writes/s at six workers clustered against 86 754 plain. `docs/c4d-cluster-workers.md` |
| C4c: *following* an upstream on a sharded node | `mode: "own" \| "routed" \| "hosted"` on `ReplicaClient` with `ShardHost`/`ReplicaHost` as its two seams, `src/server/workers/replica.ts` (`WorkerShards` + `followHost`, 151 lines of adapter), seven envelopes each way in `workers/protocol.ts`, `VirtualUpstreamSocket` in `workers/entry.ts`, `setShardHost`/`setFollowPrimaryHandler` on `ServerRuntime`, `bench/workers.ts --follow [--transport http]`, `test/server/workers-follow.test.ts` and `test/replication/hosted-follow.test.ts`. **`[replication] primary` beside `workers > 1` no longer refuses**, and C4b §6's `followPrimary` gap is closed. `docs/c4c-replication-follow.md` |

| landed in the session before this one | what it is |
|---|---|
| C4b: `/v1/replication` on a sharded node | `src/server/workers/replication.ts` (`ReplicationRouter`: the connection, the handshake, the frame reader, the queue and the cut-off, the heartbeat and the announcement), `hosted` + `adopt`/`deliver`/`positions`/`sweep`/`setAnnounceHandler` on `ReplicationServer`, four envelopes each way in `workers/protocol.ts`, `VirtualReplicationSocket` in `workers/entry.ts`, `replicationMode` on `ServerRuntime`, `bench/workers.ts --replication`, `test/server/workers-replication.test.ts` and `test/replication/hosted.test.ts`. **`[replication] secret` beside `workers > 1` no longer refuses.** `docs/c4b-replication-workers.md` |

| landed two sessions ago | what it is |
|---|---|
| P3: the WAL checksum in C | `scripts/native/walsum.c` compiled into the vendored artefact, `bunql_wal_*` as optional symbols in `src/sqlite/lib.ts`, `src/wal/native.ts` (`checkFrameFast`, `BUNQL_WAL_NATIVE=0` to force the fallback), three call sites in `src/wal/tailer.ts`, `test/wal/native.test.ts`. **Write 28.9 → 24.0 µs, 29 136 → 33 854 writes/s.** `docs/p3-wal-checksum.md` |
| C5: replica apply mechanism A | `src/wal/shm.ts` (the wal-index header format), `src/wal/shmlock.ts` (the WAL lock set through `xShmLock`, the only FFI in `src/wal/`), the strategy split in `src/wal/applier.ts`, `ApplyBusy`, `[replication] apply` and `applyBusyMs`, `"apply"` on `GET /v1/db/{db}`, `bench/wal.ts` over both mechanisms, `test/wal/shm.test.ts` and `test/wal/apply-pages.test.ts`. **Replica read 47.2 µs → 6.4, apply 196 → 162, end to end 291 → 211.** `docs/c5-apply-pages.md` |

| landed three sessions ago | what it is |
|---|---|
| C4: `workers: N` | `src/server/workers/` (shard, protocol, pool, entry, router), `[server] workers`, `--workers`, `WORKERS_UNSUPPORTED` (since removed by C4d, which lifted the last combination it refused), `Metrics.state/absorb`, `bench/workers.ts`. The main thread is a router owning the listener, every socket, the catalog and the authenticator and no database; N workers each hold a whole `ServerRuntime` over a hash shard. `ws.ts`, `routes.ts`, `runtime.ts` and `tenant/` are untouched. `docs/c4-workers.md` |
| H8: the `/v1` request schemas enforced | `src/http/handler.ts` split at the error boundary (`executeOperation` throws, `compileOperation` maps), `deferBody` + `bodyReader`, `ctx.body` read through `readJson`, `problems` moved into `mapError`. `docs/h8-validated-requests.md` |
| H8: `NOT_FOUND: 404` | the data API's `/{pk}` routes answer 404 rather than 200-with-null; GraphQL still answers `null`, through `nullOnNotFound` |
| H8: `problems` published end to end | `errorBodySchema` declares it, `ErrorInfo` names it, `BunQLClientError.problems` carries it |
| H6: the surfaces mounted | `src/server/registry.ts` (every `/v1` route as an `Operation`), `src/server/surfaces.ts` (the data API cache, the per-tenant dispatcher, the GraphQL handler), `[api]` and `[graphql]` config, `docs/h6-mount.md` |
| `routes:check` reads the registry | it already read the live table; it now also fails when a served route is **not** in the registry, so a hand-added route in `createApp` cannot go undescribed |
| `CLUSTER_DISABLED` joined `ERROR_STATUS` | `routes.ts` has thrown it since C1 with an explicit 503, but it was absent from the documented vocabulary, so the document build rejected it |
| `createApp` is async | it resolves the optional GraphQL peers once, at startup, instead of per request. Three call sites |

## How the work is run (keep doing this)

Design and coordination on Fable; every implementation milestone delegated to an Opus subagent
with a long, precise brief naming the files to create, the API surface, the tests, and the commit
message. One milestone per agent, verified by the coordinator with `bun test`, `bun run typecheck`
and a hand exercise of the changed surface before the next agent starts. Parallel agents only when
their file sets do not overlap; tell each one which paths it does not own. Phase 1 ran R1→R2
sequentially (R2 needs the transport) with R3, R4 and R5 beside them, and that worked: the only
cross-milestone friction was R4 finding a bug in `exec.ts`, which it wrote up rather than fixing
in someone else's file.

## Decisions still open (design §13)

Tim has not overridden any of the eleven; phases 0 and 1 shipped the recommended default for each.
Two now matter:

- ~~**#11, the cluster control plane**~~ **Settled and built: built-in Raft**, on the control plane
  only, never on the data path (C1, C2, C4d).
- **#9, the default `ack`** — still `local`, and asked again this session without an answer.
  `replica` as the default for a node that has replicas is a real option; it is one line in
  `config.ts` and a paragraph in `docs/api.md`, and the reason to leave it is that `NO_REPLICAS`
  would then fire on a node whose only replica is restarting. R8 answered the *blunt* half of the
  objection — it is per database now.

## Phase 2 — what is left

C1, C2 and C6 are done (see the table above). What remains, in the order it makes sense to build:

1. ~~**Control plane (§5.3).**~~ **Done (C1).** `src/cluster/`, `GET /v1/cluster`, `bunql cluster`.
2. ~~**Promotion and failover.**~~ **Done (C2).** `docs/c2-promotion.md`. Verified by hand on real
   nodes, including the case that matters most: an old primary restarted with **no `--replica-of`
   at all** still reads `BunQL-Role: replica` and refuses a write with `NOT_PRIMARY`, because the
   demotion is persisted rather than held in memory. No split brain in the one scenario where a
   node has every reason to believe it is still in charge.
3. ~~**Placement and the `[cluster]` config section**~~ **Done (C3, C3a, C3b).** A database has a
   home node by rendezvous hashing over the replicated membership, a client that lands on the wrong
   one is told where to go, and placement decides which node subscribes to which.
   `docs/c3-placement.md`.
4. ~~**`workers: N`.**~~ **Done (C4).** `docs/c4-workers.md`. The decision the milestone really made:
   a worker owns a **shard of databases**, not a shared listener via `reusePort` — which is dead on
   macOS (measured) and which would turn every per-process singleton into an N-way distributed
   object. The router keeps them singular instead.
4b. ~~**`/v1/replication` from a sharded node.**~~ **Done (C4b).**
   `docs/c4b-replication-workers.md`. The router owns the replication *connection*, the worker that
   owns a database owns its *stream*, and no `Tenant` is on the channel. `[replication] secret`
   beside `workers > 1` starts.
4c. ~~**Following an upstream from a sharded node.**~~ **Done (C4c).**
   `docs/c4c-replication-follow.md`. The same seam the other way, and as one class in three modes
   rather than two classes. `[replication] primary` beside `workers > 1` starts. Still refused:
   `[cluster] enabled` alone — the Raft lease is on a worker's write path.
5. ~~**Replica apply mechanism A (§4.5).**~~ **Done (C5).** `docs/c5-apply-pages.md`. Pages go into
   the database file and the wal-index header is rewritten under SQLite's own WAL lock set, so a
   replica's `-wal` is always zero bytes. **The read leg went 47.2 µs → 6.4.** `[replication] apply
   = "wal"` is the back-out and the automatic fallback where `xShmLock` cannot be reached.
6. ~~**Linux packaging and CI**~~ **Done (C6).** See `docs/c6-packaging.md`.

Then the surfaces: ~~**H6**~~ and ~~**H7**~~ **both done.** `docs/h6-mount.md` — the `/v1` routes
are declared in one `Registry` that builds the route table *and* `GET /v1/openapi.json`, and
`scripts/routes.ts --check` fails on a served route the registry does not declare. **H7** added
GraphQL subscriptions over the change feed `src/realtime/` already had. `docs/plan-surfaces.md` has
both. **Phase 2 and the surfaces track are complete.**

## Known gaps worth fixing along the way

~~Added by C4 (2026-09-12), all in reporting rather than in data, and all only with
`workers > 1`.~~ **All three closed by C4e**; kept here because each says what the shape of the
problem was.

- ~~**`GET /v1/db` reports `"open": false` for every database.**~~ **Closed.** "Open" is a fact
  about one worker's LRU and the router holds none, so it is now one gather of the workers' open
  sets and live positions. A round trip on an admin listing route, and `openStates()` is null on
  every thread that holds its own tenants, so a single-threaded node pays nothing.
- ~~**`GET /metrics` omits the replication and storage gauges.**~~ **Half closed (C4b).** Every
  worker's counters are summed (`Metrics.state`/`absorb`) and so are the router's own, and the
  replication gauges are now assembled from both halves by a rule per gauge: `connected` and
  `bytes` from the router, which owns every socket and writes every byte, `records` summed and
  `lag_txid` maxed across the workers, which own the streams
  (`docs/c4b-replication-workers.md` §7). ~~The S3 shipper's gauges are still omitted.~~ **Closed
  (C4e)**, and the rule turned out to be exact rather than a convention: the shards hold **disjoint**
  databases, so it is the same merge `ShipperPool.totals` already applies across one node's —
  `shipped_txid` maxes, `pending_records`, `errors` and `bytes` sum, `behind` counts. Max-of-max is
  a max.
- ~~**A hopped request body crosses as one `Uint8Array`**, so `POST /v1/db/{db}/import` of a large
  SQLite file is copied once more than on a single-threaded node.~~ **Closed (C4e).** A body of a
  megabyte or more is **transferred** rather than cloned, which detaches the router's `ArrayBuffer`
  — right here, because it came from `request.arrayBuffer()`, nothing else views it and the router
  never reads it again. `[limits] maxImportBytes` still bounds it.

Added by the performance session (2026-09-12):

- ~~**The generated REST/OpenAPI/GraphQL surfaces are built and exported but not mounted.**~~
  **Done (H6, `docs/h6-mount.md`).** What it left behind was closed by H8
  (`docs/h8-validated-requests.md`): **the `/v1` request schemas are enforced.** `src/http/handler.ts`
  is split at the error boundary — `executeOperation` runs an operation and throws,
  `compileOperation` is that plus the mapping — so `app.ts` mounts the throwing form inside its own
  `wrap()` and still sees the error *code* C2's `307` needs. The body is deferred (`deferBody`) and
  validated inside `readJson`, which keeps `routes.ts`'s ordering invariant: principal, then tenant,
  then body. Two bodies stay described and unchecked on purpose — `importDatabase` streams a raw
  SQLite file, `databaseGraphql` must refuse in GraphQL's own envelope.
- **Group commit is off by default** (`[limits] groupCommit`) because folded writes share a txid
  and the change feed emits one event per fold. Two e2e scenarios assert a txid per write and fail
  with it on — which is the honest signal that it is a contract change, not an optimisation. If
  that contract is ever renegotiated, those two tests are where it is written down.
- **A single client is 15% slower with group commit on**, because the drain costs an event-loop
  iteration and one socket's messages arrive one per iteration. `docs/p2-group-commit.md`.
- **`bench/http.ts` authenticates with the admin key**, which is a constant-time compare, so its
  numbers are still the best case rather than what a token-bearing client sees. The token path is
  now cached (45.3 µs against 44.2), so the gap is small — but the benchmark still does not measure
  what deployments do.

Carried forward from phase 0, still true:

- ~~**Linux packaging.**~~ **Done (C6, `868d548`), and the gap was not what this list said it
  was.** It claimed Linux needed prebuilt libraries because a distro libsqlite3 would not do.
  Measured, that is false: Debian 13 (3.46.1), Ubuntu 24.04 (3.45.1) and Ubuntu 22.04 (3.37.2) all
  ship `ENABLE_PREUPDATE_HOOK`, `ENABLE_SESSION` and a working `load_extension`, and the whole
  suite already passed on Linux against the stock library — same counts as macOS. **Linux was
  never blocked; it was unwatched.** `apt-get install libsqlite3-dev` changes no capability at all.
  What *is* absent from every distro build is `SQLITE_ENABLE_SNAPSHOT`, which `src/sqlite/lib.ts`
  declares a symbol table for and design §11 phase 3 wants; and base `ubuntu:24.04`, `ubuntu:22.04`
  and `debian:12` carry no libsqlite3 whatsoever, so "the distro ships it" is not dependable even
  where it is true. The real floor is **SQLite 3.37.0** — `sqlite3_changes64` is in the core symbol
  table, so below that the whole `dlopen` fails and an old library reads as *no* library.
  `scripts/sqlite.ts` now builds 3.53.4 from a hash-pinned amalgamation, `src/sqlite/lib.ts`
  prefers it, and CI runs the suite on macOS and Linux. The `engine: "builtin"` path over
  `node:sqlite` in design §4.1 is still not built. Evidence: `docs/c6-packaging.md` §1.
- ~~**Replica apply mechanism A**~~ **Done (C5, `docs/c5-apply-pages.md`)**, and the primary-side
  cost it left behind is **done too (P3, `docs/p3-wal-checksum.md`)** — not by capturing pages from
  SQLite, which turned out not to be the lever, but by computing the frame checksum in C.
- **Change ring is in memory**, so `Last-Event-ID` returns `reset` across a server restart. Spill
  it to disk or serve old positions from the log.
- **`schema` events reach WebSocket subscribers only**, not the SSE change feed.
- **WS mixed-throughput budget missed** (130k vs 150k msg/s) because writes serialise on the
  single writer. Batch commits or pipeline the write path. Unchanged by phase 1.
- ~~**No CI.**~~ **Done (C6).** `.github/workflows/ci.yml` runs install, the vendored SQLite
  build, typecheck, the suite and the routes check on `macos-latest` (arm64) and `ubuntu-latest`
  (x64), green on real runners. Actions are SHA-pinned, `permissions: contents: read`, no secrets,
  and the storage tests run against the in-process `FakeS3` because the workflow never sets
  `BUNQL_TEST_S3_ENDPOINT`.
- Nothing is published to npm; `package.json` has `exports`, `bin`, `engines` but no release flow.

What the surfaces work (H1-H5) added to the list:

- ~~**`PRAGMA foreign_keys` is never turned on**~~ **Now a setting (`[sqlite] foreignKeys`,
  `docs/p1-pragmas.md`), still off by default.** A foreign key declared in a schema is enforced on
  no connection until a node turns it on, because turning it on changes the meaning of existing
  schemas. It belongs per database rather than per node, which needs a catalog column and a
  lifecycle route; that is the remaining work. The original finding: A generated insert can reference a row that does not
  exist, and so can a hand-written one through `/v1/db/{db}/query`. Found by H4 while generating
  the data API, which declares `SQLITE_CONSTRAINT_FOREIGNKEY` on its write operations and records
  the current behaviour in a test rather than asserting the constraint fires. SQLite defaults the
  pragma off for backwards compatibility and it is per-connection, so it belongs wherever the
  reader and writer connections are configured, probably behind a per-database setting since
  turning it on changes the meaning of existing schemas.
- ~~**There is no error code for "no such row".**~~ **Fixed (H8, `docs/h8-validated-requests.md`).**
  `NOT_FOUND: 404` is in `ERROR_STATUS`, the data API's three `/{pk}` operations declare it, and
  their `200` schema is the row rather than `anyOf: [Row, null]`. GraphQL still answers `null`:
  `nullOnNotFound` in `src/graphql/errors.ts` unmakes that one status on the in-process dispatch
  the generated resolvers run through, so a missing row is a `404` in REST and a `null` in GraphQL
  from one handler.
- **`PRAGMA table_xinfo` and `PRAGMA index_info` are not on the token pragma allow-list**
  (`PRAGMA_SUBJECT`, `src/server/auth.ts`). Harmless today because introspection runs with server
  rights and its result is cached and shared — but it is the reason introspection must **not** be
  wired to the request's principal, and `table_xinfo` is not optional: `table_info` omits
  generated columns entirely.

What phase 1 added to the list:

- ~~**A standalone node never takes a snapshot, so retention can make it unrestorable.**~~
  **Fixed: `[durability] snapshotIntervalMs`, one hour by default.** The sweep takes a local
  snapshot before retention runs when the newest is older than the interval and the database has
  moved on since — so every node has a floor, not only one with a bucket or a replica. A node that
  snapshots for another reason rarely reaches the interval and pays nothing;
  `test/server/snapshot-interval.test.ts`. The original finding: Found by R6
  while wiring log retention (`docs/r6-retention.md`). The retention floor never drops a segment
  that point-in-time restore still needs — but the floor is derived from the *oldest snapshot kept*,
  and only the S3 shipper and a replica bootstrap take snapshots on their own. A plain single node
  with no bucket and no replica takes **none, ever**, so it has no floor at all, its log is bounded
  by age alone, and once the oldest segment ages out the database stops being restorable to any
  point before it. Nothing reports this; PITR simply stops reaching back. The fix is a snapshot
  interval that does not require a bucket — `[durability] snapshotIntervalMs` as a sibling of the
  `[s3]` one, taken locally with the reflink copy `src/wal/snapshot.ts` already does, which makes
  it nearly free. Until then, a node that wants PITR needs `[s3]` configured or a replica attached.

- **A database deleted on the primary is never dropped by a replica, and the name can be reused
  underneath it.** Verified by hand: create `beta` on the primary, let a `follow: ["*"]` replica
  bootstrap it, `DELETE /v1/db/beta` on the primary, then re-create `beta` and write to it. The
  primary serves `NEW-GENERATION`; the replica serves `OLD-GENERATION` — *at the same txid*, with
  no error and nothing in either log. Because the txids match, a `minTxid` read-your-writes check
  is satisfied by the stale replica, so the consistency mechanism vouches for wrong data. Two
  causes: `ReplicaClient.#resolveFollow` (`src/replication/replica.ts:616`) only ever adds streams
  and never drops one for a database that has left the announcement — and `#subscribe` pins the
  tenant, so it cannot even be evicted — and database identity on the wire is the bare name: the
  catalog `tenants` table has no generation id, and `HELLO`/`HEARTBEAT` announce
  `databases?: string[]`. The S3 layout already mints generation ids; the catalog and the protocol
  do not. This has to land before phase-2 milestone 2, since promoting a replica holding a stale
  generation would promote wrong data.
- **A replica cannot be promoted.** Recovery from a lost primary today is a new node pointed at
  the bucket. This is the headline gap and it is phase-2 milestone 2.
- ~~**The Hrana surface does not forward writes.**~~ **Closed (R4b)**, and the read half with it:
  `BEGIN TRANSACTION READONLY` on a replica is served on a pooled reader rather than refused
  (R10, `docs/r10-read-transactions.md`). The native `/v1/db/{db}/tx` keeps its three writer modes
  and has no read mode; `BunQL-Min-Txid` is its answer, and that is the one part of R10 not built.
- **A replica's change feed is txid-only** (`changes: []`). Row-level CDC on a replica needs
  logical decoding of the WAL, which design §11 puts in phase 3.
- **A forwarded write is not retried**, by design: `FORWARD_TIMEOUT` or a dropped socket means "may
  or may not have committed". A client that cares reads the txid back. If phase 2 adds idempotency
  keys, this is where they go.
- ~~**`ackWithoutReplicas` is a per-node switch, not a per-database one.**~~ **Closed (R8,
  `docs/r8-per-db-ack.md`).** A nullable catalog column and `PATCH /v1/db/{db}`, read at ack time
  rather than held on a connection, so setting it closes nothing and the next write sees it.
- **`maxOpenTx` is fixed at 1** by the tenant having one writer. `txWaitMs` is the knob that
  matters. Worth revisiting only with `workers: N`.
- ~~**The S3 shipper re-uploads an open segment as it grows.**~~ **False, and measuring it is what
  said so (R9, `docs/r9-segment-index.md`): no segment key is ever uploaded twice.** What the
  measurement found instead was the *manifest*, rewritten whole on every drain with an entry per
  segment ever shipped — O(n²) in a database's drains, 28.2 MB of manifest for 296 KB of records
  over 400 drains. **Closed**: the inventory moved into immutable chunks under `index/` and the
  manifest keeps only the tail.

## Start here

**Nothing milestone-sized is open**, and the three things the last edition of this file called
chores turned out to be bugs and are fixed. What is left is genuinely optional, and it is listed in
the order it is worth doing.

### 1. Re-measure on a quiet machine

The one thing this session could not finish. `docs/performance.md` §5's worker ladder — the 2.67x
table — still describes the old defaults, and it could not be re-taken: five-second runs at the
*same* rung returned **11 721 and 49 507 writes/s** minutes apart, and a four-worker rung came back
at 0.45x and then 1.21x of its own one-worker rung. A ladder is a comparison between rungs, so noise
of that size does not average out, it inverts the answer.

`docs/performance.md` §8 is new and says how to tell whether a machine is quiet enough, and what
two artefacts wasted a day of this session — a benchmark charging its own warm-up to the first leg
it measured, and two runaway processes that had been eating two cores for eighteen hours. Read it
before taking any number.

What *was* re-measured and can be trusted: §1's stage table (unchanged), the ack ladder
(23.7 µs `local` against 62 µs `fsync`), the group-commit ladder, and the defaults A/B at one
worker — **27.7-30.4k writes/s on the old defaults against 46.0-53.6k on the new**, three
interleaved rounds. `docs/benchmarks.md` is deliberately *not* restitched from parts; its contract
is one coherent run and it says at the top which of its rows have moved under it.

### 2. Windows: whether it is a gate now depends on one CI run

`docs/e2-windows-gate.md` is the fix and the reasoning. E1's 150 failures were one cause, and it
was not the one E1 named: mechanism A published its wal-index header by writing the `-shm` file
through a descriptor, and Windows refuses that while any connection has the file mapped. The
wal-index is now written through `xShmMap`'s own mapping, with `xShmBarrier` between the two header
copies, on every platform — so macOS and Linux prove the path on every push and Windows is the same
code rather than the exception.

Two POSIX assumptions in the tests went with it: a TOML fixture wrote a Windows path into a basic
string, where every separator is an escape sequence, and temp-dir teardown now retries and gives up
quietly rather than failing the test that happened to run last.

**If the `windows-latest` job passes, delete its `continue-on-error` lines** — the job level and
the four step levels — and Windows is a gate. If it does not, the job output is still the
instrument, and the next cause will be one cause again.

### 3. The bounded ones

- **The rest of the router's header cost.** P6 flattened the pairs and recovered 19.2% of a hop
  where removing the header clone entirely is worth 37.5%, so about half of it survives — the
  string still crosses and both sides still build and parse it. A binary encoding, or caching the
  flattened form of the header sets a node actually sends, is where that goes.
  `docs/p6-router-resolution.md` §6. **Do this one on a quiet machine or not at all**: it is a 5-11%
  effect and this machine could not resolve 2x today.
- **The other 0.75 µs of a poll.** `WalTailer.poll()` is 1.98 µs once the checksum is native, of
  which an `fstat` and a separate 32-byte header read are 0.75. One `pread` taking the header and
  the first frame together would collapse them. `docs/p3-wal-checksum.md` §2.
- **A read mode for the native `/v1/db/{db}/tx`.** R10 built the machinery and wired only Hrana to
  it; the native surface would need a fourth mode and a baton dispatch across two session kinds.
  `docs/r10-read-transactions.md` §4.
- **Change ring is in memory**, so `Last-Event-ID` returns `reset` across a restart. Spill it to
  disk or serve old positions from the log. This is the last of the realtime gaps — schema events
  now reach the SSE feed as well as the socket.
- **The npm release flow exists and cannot be used yet.** `.github/workflows/release.yml` runs the
  full gate on a `v*` tag and publishes with provenance. Two things block a first tag and neither
  is a code change: **`bunql` on npm is somebody else's package**, so a name has to be chosen — and
  a scope is not a one-line change, because every example in `README.md` and `docs/` imports
  `from "bunql/client"` and `test/package/exports.test.ts` checks each of those — and
  `private: true` is still in `package.json` on purpose, as the last thing between that workflow
  and a package going out under a name nobody picked. MIT and the copyright line are a default,
  not a decision.
- **`@bunql/sqlite-*` prebuilt libraries** are still unbuilt and still the right idea;
  `docs/c6-packaging.md` §6 says what it would take.

### Closed since the last edition, so stop looking for them

- ~~**`defensive` for the vendored build.**~~ It is `[sqlite] defensive`, it is implemented through
  `bunql_db_config_int`, and a node told to be defensive on a build that cannot be refuses to
  start. `docs/p1-pragmas.md`.
- ~~**`schema` events reach WebSocket subscribers only.**~~ The SSE feed carries them too.
- ~~**`bench/http.ts` authenticates with the admin key**, so its numbers are the best case.~~
  There is a minted-token leg now, and the answer is that the gap is about 5 µs rather than the
  1.7x the old arithmetic implied — the verification cache is doing its job.
- ~~**One flaky test.**~~ It was not flaky; see P5 §6.

## House rules for this repo

Bun only, no runtime dependencies (`kysely` and `drizzle-orm` are optional peers, `@libsql/client`
is a devDependency used by tests and benches only). Never import `bun:sqlite` in `src/` (tests and
`bench/driver.ts` may, for parity checks). Keep `docs/design.md` as the design of record and
`docs/api.md` as the as-built reference — update both when an API changes, and
`bun run scripts/routes.ts --check` fails if the route table falls behind — and, since H6, if a
route is served that `src/server/registry.ts` does not declare. **A new `/v1` route is an entry in
that registry, never a hand-written line in `createApp`**: the route table and
`GET /v1/openapi.json` are both built from it, which is the only reason they cannot drift. Every
module header states its invariant. Tests go in `test/<area>/`, temp dirs under `os.tmpdir()`.

**The SQLite library.** Run `bun run sqlite:build` once: it compiles 3.53.4 from a hash-pinned
amalgamation **plus `scripts/native/walsum.c`** into `vendor/sqlite/`, which `src/sqlite/lib.ts`
prefers over anything on the system. Without it a node still works, but WAL frames are checksummed
in JavaScript and every write is about 17% slower — `bunql serve` says so at startup
(`docs/p3-wal-checksum.md`). That is what CI uses on both platforms. Without it the driver still finds Homebrew's build
on macOS and a distro one on Linux — contrary to what this file used to say, Debian and Ubuntu
*do* ship `ENABLE_PREUPDATE_HOOK` and `ENABLE_SESSION` — but no distro ships
`SQLITE_ENABLE_SNAPSHOT`, and the floor is SQLite 3.37.0 because `sqlite3_changes64` is in the
core symbol table, so an older library fails `dlopen` entirely and reads as *no* library. Apple's
system build lacks `load_extension`. `BUNQL_SQLITE_LIB` overrides the search, and a capability
that is missing now names the remedy in its error. See `docs/c6-packaging.md`.

**No raw control bytes in source.** A separator or a magic value must be written as an escape —
`"\0"`, `"\x01"` — never as the byte itself. `bun run bytes` (`scripts/bytes.ts`) enforces it and
runs in CI, because git only sniffs for a NUL in a blob's **first 8000 bytes**: past that window a
file with one still gets a normal line diff, `file(1)` still calls it text, and nothing warns
anyone. Three files carried one; one had been in `src/realtime/live.ts` since phase 0.

The trap that produces them, worth knowing before it catches you: writing `"\u0000"` in a
**JSON-encoded tool argument** — an `Edit` or `Write` `new_string` — decodes to the byte before it
ever reaches disk. The escape you type is not the escape that lands. Write `"\\0"` in that
argument to get the two-character escape in the file, and the same applies to `\n`, `\t` and
`\r`. After any edit that places a control character, run `bun run bytes`.

Commands: `bun test`, `bun run typecheck`, `bun run bytes`, `bun run bench` (`--quick`,
`--only <driver|wal|tenant|http|replication|storage>`, `--json`), `bun run start`,
`bun run src/cli.ts serve --dir ./data --port 4321`.
