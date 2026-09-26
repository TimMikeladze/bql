# Resume here — state of bql.sh and what to do next

**Updated 2026-09-16: phase 3 is run, and it is the last named phase.** Design §11 listed four
"frontier extras" and **three of them were not what that row thought they were**: the query-plan
cache was already built (P7), the snapshot read was a real caller served by the wrong mechanism
(P8), and logical CDC needed a change to what the primary *records* rather than a decoder (P9).
Per-tenant encryption at rest is designed, costed, and deliberately **not built** (P10). **Design
§11's phase-3 row lost three of its four bullets and the fourth lost two words** — a phase-3 item
that turns out not to exist gets removed rather than left for the next reader to believe.
`docs/plan-phase3.md` is the plan; `docs/p7-plan-cache.md`, `docs/p8-read-sessions.md`,
`docs/p9-logical-cdc.md` and `docs/p10-encryption.md` are what actually happened. **Every milestone
of that plan is closed.** Two of them found a bug nobody was looking for — see "What phase 3 found
that nobody asked it to" below.

**Updated 2026-09-14: the L track is built, L1 through L8.** Admission control — a ceiling on every
shared resource, a typed refusal when it is reached, and a number that says how close it is. Three
of the seven changed shape once they were measured, and two of them changed the *answer*: L5's
shared fsync sweep is shipped **off**, because the benchmark says it loses at a hundred databases,
and L6's premise turned out to be half false the way R9's was. `docs/plan-limits.md` is the plan;
`docs/l1-result-budget.md` through `docs/l8-change-seq.md` are what actually happened. **Every
milestone of that plan is closed.**

Rewritten 2026-09-13, at the end of the session that went after the list the previous one left.
**Three of the things on that list turned out to be bugs rather than chores**, and each was
diagnosed wrongly before it was diagnosed rightly:

- Windows was not failing on a file copy. It was failing because bql.sh writes shared memory
  through a file descriptor (E2).
- P5's "flaky test" was not flaky. A checkpoint was folding away frames the log had never seen,
  and a `kill -9` in that window was unrecoverable.
- The retention test's "race" was the node refusing a client's write because it had decided, on
  its own timer, to snapshot itself.

Read this, then **`docs/plan-phase3.md`** and the four milestones it names — `docs/p7-plan-cache.md`,
`docs/p8-read-sessions.md`, `docs/p9-logical-cdc.md`, `docs/p10-encryption.md`. Read at least P8 §2
and P9 §2 whatever else you skip: they are the two places a design-§11 item was measured and found
to be the wrong instrument, and both arguments are short. Then `docs/e2-windows-gate.md`,
`docs/p5-deferred-compression.md` §6 and `docs/performance.md` §8 and §11, then
`docs/r8-per-db-ack.md`, `docs/r9-segment-index.md`, `docs/r10-read-transactions.md` (§4 of which
P8 overturns), `docs/p6-router-resolution.md`, `docs/e1-windows.md`, `docs/c5-apply-pages.md`,
`docs/p4-router-hop.md`, `docs/design.md` §0, §11 and §14, then `docs/api.md`. Plans of record:
`docs/plan-phase2.md` (the cluster), `docs/plan-surfaces.md` (HTTP, OpenAPI, GraphQL),
`docs/plan-limits.md` (the L track, **L1-L8**) and `docs/plan-phase3.md` (the P track, **P7-P10**).
**All four are closed.**

## Where things stand

**Every named phase is complete.** Phases 0, 1, 2, the surfaces track, the L track, **phase 3**, and
Windows is a supported platform. C1-C6, C3a/C3b, C4-C4e, H1-H8, P1-P6, R1-R10, E1-E2, L1-L8,
**P7-P10**. **CI green on macOS, Linux and Windows**, all three gating, plus a fourth job as of L7
that packs the real tarball and builds SQLite from it. On `main`, pushed to
**https://github.com/TimMikeladze/bql** (private). `bun test` → **1563 pass, 2 skip, 0 fail**
across 138 files, and green again with `BQL_WAL_NATIVE=0` (run it both ways; the second is what
proves the JavaScript fallback). `bun run typecheck`, `bun run bytes`, `bun run routes:check` and
`bun run pack:check` clean. Zero runtime dependencies.

### The P track (phase 3), newest first

**P10 — encryption at rest is designed, costed, and refused for this phase.** Nothing existed; the
primitive was never the problem (Bun ships WebCrypto) — **bql.sh does not own the writes.** A design
that covers the whole path *does* exist and keeps zero runtime dependencies: a page-encrypting VFS
shim in C compiled into the vendored artefact beside `walsum.c`, with the three components that
bypass the VFS — the WAL tailer, the page applier, and the log and bucket that carry page images —
sharing the key, and the rolling checksum folding **ciphertext** so a replica proves what it holds
without one. It is a track, not a milestone: a keyring, rotation-as-a-fork, a startup refusal on a
distro libsqlite3, a Windows gate. Until somebody pays for it the honest answer is full-disk
encryption plus bucket SSE, which covers everything except the threat model where the operator is
the adversary — the only one a per-tenant key improves on. `docs/p10-encryption.md`.

**P9 — a replica's change feed carries rows, and the decoder is refused rather than deferred.**
`[replication] logicalChanges` (a *level*: `false` | `"pk"` | `"row"` | `"row+old"`, default off),
record version 2 carrying a length-suffixed logical section after a byte-identical page region, and
`HELLO.maxRecordVersion` so a primary never streams a record its peer will reject. **A WAL page
decoder cannot satisfy the acceptance criterion** — a replica gets one folded transaction and no
statement boundaries, so it cannot produce the per-statement `(txid, seq)` L8 made the contract, and
a net page delta loses a row inserted-then-deleted entirely. With the flag off, a row subscription
on a replica is now `501 LOGICAL_UNAVAILABLE` rather than the empty `changes: []` that was
indistinguishable from "nothing changed". **Record size is 1.04-1.35x, not the >2x the plan
feared**, because zstd sees the row bytes twice. `docs/p9-logical-cdc.md`.

**P8 — a consistent read across requests, on R10 rather than on `sqlite3_snapshot`.** `POST
/v1/db/{db}/read`, no engine change, no new error code, R10's bounds unchanged. The mechanism
design §11 named was **measured and refused**: every checkpoint mode invalidates a snapshot handle,
PASSIVE included, and suppressing all checkpointing to keep one alive pins the WAL at *exactly* the
same 12 304 KiB that holding a read transaction does — while being absent from every distro
libsqlite3 and **wrong on a replica**, where the page applier leaves no old page version to name.
`experiments/snapshot.ts` reproduces both in four seconds. `docs/p8-read-sessions.md`.

**P7 — the query-plan cache existed; what was missing was a ceiling you could see.** The cache is
`Database.#cache`, `SQLITE_PREPARE_PERSISTENT` was already set, and sharing one across connections
is **impossible in SQLite** rather than unbuilt. What binds is the ceiling: **six tables** take the
generated data API from a 100% hit rate to **0%**, at 81x a hit per `prepare` (186x under load),
because a round-robin working set evicts each text just before it is wanted again. `[sqlite]
statementCache` and three `bql_statement_cache_*` counters are the answer — **alert on the
eviction rate.** `docs/p7-plan-cache.md`.

### What phase 3 found that nobody asked it to

Three findings outlived their milestones. Each is in the gap list below with its number.

1. **A write inside a read session landed** — as the session's *first* statement, `200
   rowsAffected: 1`, on a pooled reader, outside the writer, the WAL tailer, the log, the change
   feed and replication, **on a replica included**. A pooled reader is not opened
   `SQLITE_OPEN_READONLY` and no `query_only` is set; Hrana already guarded it and the new `/v1`
   route had to. `executeInReadTx` still does not, which is arguably where the guard belongs.
2. **A token-authenticated write expires its own statement cache twice per request.**
   `applyPolicy` installs a policy and `handle.release()` takes it off in a `finally`
   (`src/server/exec.ts:310`), and re-arming `sqlite3_set_authorizer` is exactly what expires
   compiled statements. bql.sh's cache still records a **hit** and SQLite recompiles behind it —
   measured 0.81 µs against 2.76 µs on a point read. The read path does not do it (`withReader`
   scopes once and never releases), and no benchmark ever showed it because benchmarks use the
   admin key, which installs no policy at all.
3. **Design §4.6's "≈ 50 ns/row" was the *update* hook's number.** The preupdate hook costs
   **252 ns/row at `pk` and 349 at `row`**, measured over fifteen interleaved rounds; the update
   hook reproduces the ~50 ns. §2.3's own table is where the confusion came from. Both design lines
   are corrected.

### The L track, newest first

**L8 — one change event per statement, keyed `(txid, seq)`.** Group commit folds concurrent writes
into one transaction, so the feed emitted one event per *fold*: fifty writers, one fat event, and
`txid` was not a key anything could dedupe on. It is now one event per statement, and the position
on the wire is `<txid>.<seq>` — the SSE `id:`, `Last-Event-ID`, `?since=` and the WebSocket
`subscribe` frame all take it, and **a bare txid still means "the whole of that transaction"**, so a
client written before L8 resumes unchanged. The ring's eviction watermark became a position too,
which is what lets it serve a client that had `(5, 0)` while `(5, 1)` is still retained.
`docs/l8-change-seq.md`.

**L7 — the tarball can build its own engine.** `package.json` `files` excluded `scripts/`, so
`sqlite:build` — advertised in `package.json` and in the README — was not in the published package,
and a clone with a built `vendor/` hid it completely. The gate is `bun run pack:check`: pack,
install the tarball into an empty directory as a dependency, build SQLite there, smoke it. It found
a second bug on its first run, which would have shipped in the first release: `bun run
sqlite:build` in a consumer's project resolves against *their* package.json. The command is the
path. `docs/l7-tarball.md`.

**L6 — a global upload budget, and the premise was half false.** `S3Store` has had bounded
concurrency since R3, so a thousand shipping databases were never a thousand concurrent requests.
What that gate does not do is what L6 built: order the queue by how far behind each database is
(so a database behind for an hour is not starved by one that committed a moment ago), bound the
wait so a shipper re-arms instead of growing a second queue, and report `bql_upload_inflight` and
`bql_upload_waiting`. `docs/l6-upload-budget.md`.

**L5 — the fsync sweep is built, measured, and left off.** The benchmark came first, as the plan
demanded, and it decided against the plan's own default. Three findings: the write path already
costs exactly 2.00 barriers per transaction and **group commit already amortises them** (0.13 per
write at sixteen in flight); this disk is *fastest* issuing barriers serially (30 180/s against
10 506 at a concurrency of sixty-four); and the herd is real but belongs to `ack: "local"` — 4 387
barriers a second and 40.6 ms p99 at five hundred databases. `"shared"` wins hugely there (29 407
writes/s against 23 867, p99 16.9 ms against 40.6) and **loses at a hundred**, so
`[durability] fsyncSweep` stays `"per-db"`. It is also inert under the node's default ack, proved
by a `kill -9`. `docs/l5-fsync-sweep.md`, `docs/performance.md` §9.

**L4 — a pin is not a licence.** `#evict` skipped pinned tenants and admitted the new one anyway,
on the grounds that "the cap is a target". True of `busy`, which lasts one statement; false of
`pinned`, which a subscriber holds as long as it likes — so one client could pin two thousand
databases past `maxOpen` and nothing refused it. Pins are now keyed by principal and capped at
`[limits] maxPinnedPerPrincipal` (`429 PIN_LIMIT`), and an open the LRU cannot make room for is
refused `503 TOO_MANY_OPEN`. `docs/l4-pin-limit.md`.

**L3 — the fd budget is a node number.** Bun workers are threads sharing one descriptor table, so
`workers: 8, maxOpen: 1024` held 8192 databases while each thread warned about its own eighth of
the requirement. The router divides the budget and probes once. The plan's "at least 8 per worker"
floor is **not** implemented — a per-worker floor is `8 * workers` wearing a disguise — and the
node warns it will thrash instead. `docs/l3-fd-budget.md`.

**L2 — write admission is bounded.** `writeQueued` pushed with no ceiling; `maxGroupCommit` bounds
a drain, never the backlog. Three bounds, a `Retry-After` derived from the measured drain rate, and
cancellation on the request's abort signal. The finding worth keeping: arming the deadline and the
abort listener at push cost **6%** of the group-commit path at sixty-four concurrent clients —
`addEventListener` is 137 ns and `Date.now()` 22 ns against a per-statement cost of 850 ns — so
only an entry that cannot be in the next batch pays for any of it. `docs/l2-write-admission.md`.

**L1 — a result is bounded while it is built.** `maxRows` was checked on `rows.length` after
`values()` had materialised everything, so a five-million-row scan grew RSS by **286 MB** before
answering with a correct 400. The ceiling is now armed on the statement and refused at the row that
would cross it: under 1 MB. `[limits] maxResultBytes` and `413 RESULT_TOO_LARGE` are the byte half.
`docs/l1-result-budget.md`.

### What this session changed, newest first

**The client SDK has the control plane too, and the CLI stopped carrying a second one.**
`client.admin` covers all nineteen admin routes of §6.5 — create, fork, stat, configure, delete,
snapshot, restore, checkpoint, dump, import, replication, promote, cluster, the three backup
routes, mint and revoke — over the same `HttpClient` a statement uses, so one error mapping and one
token. `src/cli.ts` now calls it: its own `api()` helper and its five hand-written copies of the
response types are gone, and the CLI's output, exit codes and flags are unchanged. The wire shapes
live in `src/client/protocol.ts`, beside every other description of the wire format. Embedded got
the three node-local operations for parity — `bq.snapshot`, `bq.restore`, `bq.checkpoint`. One
behaviour change, in the same direction: `--tables x:w` is now refused by the CLI rather than by
the server, because `TableScope` only ever had `r` and `rw`. `docs/m9-client-admin.md`.

**At txid 0 the catalog is the position, not the file.** A sharded cluster test failed about one CI
run in three with `ChecksumMismatch: pre-transaction checksum mismatch at txid 1: expected
80adc3c53d5dd66b, computed 0` — a replica refusing record 1 of a database that should have had no
history. Not a race: `openRecorder` let `computeFull` of the *file* decide the position at txid 0,
and a database SQLite has merely opened holds the header page it writes on entering WAL mode, which
belongs to no transaction. Created, closed and reopened without a write, a database stood at "1
page, checksum 9272282459731252843" rather than "0 pages, checksum 0", and record 1 carried that as
its `preChecksum`. Whether a worker opened the tenant before its first write is what made it look
random. The rule was already written down three times — `openApplier`, `snapshot()` and
`restoreFromBucket` each carry a copy — and `openRecorder` was the one place without it.

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
the mapping and fences with `xShmBarrier`; so does bql.sh now, on every platform rather than behind
a `win32` branch — a branch would leave the new path exercised only by the one job that cannot be
run locally.

**A record is stamped with the wall clock, not the monotonic one.**
`performance.timeOrigin + performance.now()` is the wall clock as it stood at process start plus
monotonic time since, so it drifts from `Date.now()` by every clock correction made while the
process runs — and every reader of the field compares it against a real `Date.now()`, including
`restoreFromBucket({ at: { timestamp } })`. A point-in-time restore on a long-lived node was off by
the accumulated drift; a macOS runner under NTP correction made the test for it fail with 25 ms of
guard on either side of the cut.

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
   event per fold and `BQL-Min-Txid` is coarser — never weaker, since a txid covering more than
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
| README rewritten from `src/`, surface subpaths exported | `ebf5555` | `bql.sh/core`, `/http`, `/openapi`, `/dataapi`, `/graphql` now resolve; `test/package/exports.test.ts` fails if a doc imports a subpath the package does not publish |
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
| P3: the WAL checksum in C | `scripts/native/walsum.c` compiled into the vendored artefact, `bql_wal_*` as optional symbols in `src/sqlite/lib.ts`, `src/wal/native.ts` (`checkFrameFast`, `BQL_WAL_NATIVE=0` to force the fallback), three call sites in `src/wal/tailer.ts`, `test/wal/native.test.ts`. **Write 28.9 → 24.0 µs, 29 136 → 33 854 writes/s.** `docs/p3-wal-checksum.md` |
| C5: replica apply mechanism A | `src/wal/shm.ts` (the wal-index header format), `src/wal/shmlock.ts` (the WAL lock set through `xShmLock`, the only FFI in `src/wal/`), the strategy split in `src/wal/applier.ts`, `ApplyBusy`, `[replication] apply` and `applyBusyMs`, `"apply"` on `GET /v1/db/{db}`, `bench/wal.ts` over both mechanisms, `test/wal/shm.test.ts` and `test/wal/apply-pages.test.ts`. **Replica read 47.2 µs → 6.4, apply 196 → 162, end to end 291 → 211.** `docs/c5-apply-pages.md` |

| landed three sessions ago | what it is |
|---|---|
| C4: `workers: N` | `src/server/workers/` (shard, protocol, pool, entry, router), `[server] workers`, `--workers`, `WORKERS_UNSUPPORTED` (since removed by C4d, which lifted the last combination it refused), `Metrics.state/absorb`, `bench/workers.ts`. The main thread is a router owning the listener, every socket, the catalog and the authenticator and no database; N workers each hold a whole `ServerRuntime` over a hash shard. `ws.ts`, `routes.ts`, `runtime.ts` and `tenant/` are untouched. `docs/c4-workers.md` |
| H8: the `/v1` request schemas enforced | `src/http/handler.ts` split at the error boundary (`executeOperation` throws, `compileOperation` maps), `deferBody` + `bodyReader`, `ctx.body` read through `readJson`, `problems` moved into `mapError`. `docs/h8-validated-requests.md` |
| H8: `NOT_FOUND: 404` | the data API's `/{pk}` routes answer 404 rather than 200-with-null; GraphQL still answers `null`, through `nullOnNotFound` |
| H8: `problems` published end to end | `errorBodySchema` declares it, `ErrorInfo` names it, `BqlClientError.problems` carries it |
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

1. ~~**Control plane (§5.3).**~~ **Done (C1).** `src/cluster/`, `GET /v1/cluster`, `bql cluster`.
2. ~~**Promotion and failover.**~~ **Done (C2).** `docs/c2-promotion.md`. Verified by hand on real
   nodes, including the case that matters most: an old primary restarted with **no `--replica-of`
   at all** still reads `BQL-Role: replica` and refuses a write with `NOT_PRIMARY`, because the
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
- **Group commit is on by default** (`[limits] groupCommit`, `config.ts:470`). This line said
  "off" until 2026-09-14, contradicting "The three defaults, settled" above, which is the correct
  one. What remains true is the contract it names: folded writes share a txid and the change feed
  emits one event per fold, and two e2e scenarios assert a txid per write. `docs/plan-limits.md`
  L8 is the fix — one event per statement, keyed `(txid, seq)`, which is also what a durable
  downstream feed needs.
- **A single client is 15% slower with group commit on**, because the drain costs an event-loop
  iteration and one socket's messages arrive one per iteration. `docs/p2-group-commit.md`.

Added by phase 3 (2026-09-16), and the first is the one to act on:

- **`executeInReadTx` does not refuse a write, and a pooled reader will happily perform one.**
  P8 found that a write as a read session's *first* statement returns `200 rowsAffected: 1` — on a
  pooled reader, outside the tenant's writer and therefore outside the WAL tailer, the log, the
  change feed and replication. On a replica it is a row the primary has never heard of and never
  will; the replica answered `200` to exactly that under `apply = "pages"`. A pooled reader is not
  opened `SQLITE_OPEN_READONLY` (`Tenant.acquireReader` passes `{ writer: false }`, which only
  means "not *the* writer") and `applyPragmas` sets no `query_only`. **Both callers now guard it
  themselves** — Hrana's `assertReadOnly` and P8's `assertReadOnlyStatement` — so nothing is
  exposed today. The gap is that the guard is in two places and not in the one function both go
  through, so the third caller will be the one that forgets. **The fix is duplication, not speed**:
  `step()` already computes `const writes = !stmt.readonly` (`src/server/exec.ts:197`) on the
  statement it is about to run, so a "refuse a write" flag on `executeInReadTx` would move the
  check to where both surfaces already pass and delete two of the four authorizer calls — worth
  17 ns and one class of future bug. `docs/p8-read-sessions.md` §4.
- **A token-authenticated statement expires its own connection's statement cache.** `applyPolicy`
  installs a policy and `handle.release()` takes it off in a `finally` (`src/server/exec.ts:310`),
  and re-arming `sqlite3_set_authorizer` is precisely what expires statements compiled under the
  old verdicts — so the cache reports a **hit** and SQLite recompiles inside `sqlite3_step`
  regardless. **0.777 µs on the admin path against 2.264 µs on the token path**, per point-read
  statement, with 87 999 hits and 1 miss recorded across the run that measured it.

  **Read the number before optimising it.** The recompile is *lazy* — it happens once, inside the
  next `step` — so a second cycle-pair on the same statement costs **0.017 µs**, not another
  1.5. P8's read-session guard performs exactly that second pair and is therefore ~17 ns, not the
  2 µs a first reading suggests. What costs the ~1.5 µs is that a token principal cycles the
  authorizer *at all*; removing one of two cycles buys nothing. The read path does not pay it —
  `withReader` (`src/server/runtime.ts:896`) scopes a connection once and never releases — and an
  **admin principal pays nothing anywhere**, because `AuthorizerHub.#sync` makes no FFI call when
  nothing is installed and nothing is wanted. That is why no benchmark has ever shown this: they
  all authenticate with the admin key.

  **Not fixed**, deliberately: leaving a connection scoped to the last request's token is a
  security decision rather than a tuning one, and it wants its own milestone.
  `docs/p7-plan-cache.md` §4, `docs/p8-read-sessions.md` §4.
- **`[sqlite] statementCache` = 64 is smaller than it sounds, and the cliff is vertical.** Six
  tables of six columns take the generated data API from a 100% hit rate to 0%, because the text
  varies per *shape* — a `?select=` list, a filter set, an order, a bulk-insert row count are each
  one — and `POST` of N rows is N distinct texts for one table. Past the ceiling every `prepare`
  costs 81x a hit. Nothing about this is wrong; it is a default that wants raising on any node
  serving the data API, and `bql_statement_cache_evictions_total` is how you know.
  `docs/p7-plan-cache.md`.
- ~~**`bench/http.ts` authenticates with the admin key**, which is a constant-time compare, so its
  numbers are still the best case rather than what a token-bearing client sees.~~ **Closed.**
  `bench/http.ts:162-172` mints a token and measures a leg with it, and the answer is that the gap
  is about 5 µs (45.3 µs against 44.2) rather than the 1.7x the old arithmetic implied — the
  verification cache is doing its job. Duplicated under "Closed since the last edition", which is
  the correct entry.

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
- ~~**`schema` events reach WebSocket subscribers only**, not the SSE change feed.~~ **Closed.**
  The SSE feed carries them too. Duplicated under "Closed since the last edition".
- **WS mixed-throughput budget missed** (130k vs 150k msg/s) because writes serialise on the
  single writer. Batch commits or pipeline the write path. Unchanged by phase 1.
- ~~**No CI.**~~ **Done (C6).** `.github/workflows/ci.yml` runs install, the vendored SQLite
  build, typecheck, the suite and the routes check on `macos-latest` (arm64) and `ubuntu-latest`
  (x64), green on real runners. Actions are SHA-pinned, `permissions: contents: read`, no secrets,
  and the storage tests run against the in-process `FakeS3` because the workflow never sets
  `BQL_TEST_S3_ENDPOINT`.
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

- ~~**A database deleted on the primary is never dropped by a replica, and the name can be reused
  underneath it.**~~ **Closed (R7, `docs/r7-unfollow.md`).** The bug was real and its severity was
  that both nodes stood at the same txid, so a `minTxid` read-your-writes check was *satisfied* by
  the stale replica and the consistency mechanism certified wrong data. Both causes are fixed:
  `ReplicaClient.#resolveFollow` drops a stream for a database that has left the announcement, and
  database identity on the wire is no longer the bare name — `generations` rides `HELLO` and
  `HEARTBEAT` and `generation` rides `SUBSCRIBE`/`SUBSCRIBED`
  (`src/replication/protocol.ts:96-136`), all optional, so the protocol version is still 1.
- ~~**A replica cannot be promoted.**~~ **Closed (C2, `docs/c2-promotion.md`)** — it was
  phase-2 milestone 2 and that milestone is done, as the "Phase 2 — what is left" table above
  says. Verified by hand on real nodes, including an old primary restarted with no `--replica-of`
  at all, which still reads `BQL-Role: replica` and refuses a write with `NOT_PRIMARY` because
  the demotion is persisted rather than held in memory.
- ~~**The Hrana surface does not forward writes.**~~ **Closed (R4b)**, and the read half with it:
  `BEGIN TRANSACTION READONLY` on a replica is served on a pooled reader rather than refused
  (R10, `docs/r10-read-transactions.md`). The native `/v1/db/{db}/tx` keeps its three writer modes
  and has no read mode, and needs none: `POST /v1/db/{db}/read` is the native consistent read, on
  the same mechanism and served locally on a replica (P8, `docs/p8-read-sessions.md`).
- ~~**A replica's change feed is txid-only** (`changes: []`).~~ **Closed (P9,
  `docs/p9-logical-cdc.md`)**, and not by the method design §11 named. `[replication]
  logicalChanges` makes the primary record the rows it already captures into the `TxnRecord`
  (version 2), and the replica publishes them under the same `(txid, seq)`. The WAL decoder is
  **refused, not deferred**: it cannot produce a per-statement key, because a replica receives one
  folded transaction with no statement boundaries in it. With the flag off a row subscription is
  now `501 LOGICAL_UNAVAILABLE` rather than an empty array that meant two different things.
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

**Phase 3 is done and it was the last named phase. `docs/design.md` §11 has no unbuilt row left.**
`docs/plan-phase3.md` is the plan of record and `docs/p7-plan-cache.md` … `docs/p10-encryption.md`
are the four milestones. `docs/prompt-phase3.md` is the prompt that commissioned it, kept because
its guess — "two of the four look like they should be refused" — was right about the count and
wrong about which two.

**So there is no next phase, and that is the real state of the project.** What is left is a list
rather than a plan, and the first two items are worth more than the rest of it put together:

1. **The durable change ring**, below. The last realtime gap and the only one that changes what a
   client can rely on.
2. **The npm release.** Published by hand from Tim's machine; `docs/releasing.md` is the
   checklist. Everything is built; it has not been published yet.

The first is newly *possible* rather than newly worth doing: **the change ring is still in
memory**, so a `Last-Event-ID` from before a restart is answered with `reset`. That was
unfixable-in-principle while a position was a bare txid — a durable feed needs a key that survives
a replay, and there was none. L8 made `(txid, seq)` that key, and P9 gave a replica's feed real
rows to be durable *about*, so a downstream consumer now has both a thing worth resuming and a
position to resume from. Spill the ring to disk, or serve old positions from the log.

Everything else below is genuinely optional, in the order it is worth doing.

### 1. Re-measure §5's worker ladder on a quiet machine

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

### 2. ✅ Windows is a gate

`docs/e2-windows-gate.md` is the fix and the reasoning. E1's 150 failures were one cause, and it
was not the one E1 named: mechanism A published its wal-index header by writing the `-shm` file
through a descriptor, and Windows refuses that while any connection has the file mapped. The
wal-index is now written through `xShmMap`'s own mapping, with `xShmBarrier` between the two header
copies, on every platform — so macOS and Linux prove the path on every push and Windows is the same
code rather than the exception.

Two POSIX assumptions in the tests went with it: a TOML fixture wrote a Windows path into a basic
string, where every separator is an escape sequence, and temp-dir teardown now retries and gives up
quietly rather than failing the test that happened to run last.

**The run after that fix: 1479 pass, 2 skip, 6 fail**, against E1's 1346 / 150. Five of the six were
tests asserting that the platform is POSIX — a `0o600` mode where there are no mode bits,
`SQLITE_FCNTL_HAS_MOVED` where the Win32 VFS answers `SQLITE_NOTFOUND`, `vendor/sqlite/libsqlite3.`
as a path needle where the separator is `\` and the file is `sqlite3.dll`, and `libc.so.6` as the
"not a libsqlite3" fixture. The sixth was speed: `evicts idle tenants` created 2000 tenants against
a `maxOpen` of 50 and took over two minutes there against five seconds on macOS; ten times
`maxOpen` is what the test is about, so it is 500 now. All six are fixed and
`docs/e2-windows-gate.md` §4 lists them.

One of the six *was* more than it looked, and only a Windows run could have found it.
`candidatePaths()` has said since E1 that there is **no system candidate on Windows**; the comment
was true about the intent and false about the code, which omitted the bare `"sqlite3.dll"` and then
pushed the Homebrew dylib, `libsqlite3.so.0` and `/usr/lib/libsqlite3.dylib` on every platform.
Nothing broke — none of them opens — but the "no library" remedy on Windows named `libc.so.6`, a
file the platform has never had. The test that caught it was one written to encode the comment's
claim.

**Windows runs `bun test --timeout 20000`.** Two tests crossed bun's 5 s default doing legitimate
work — 7 s where sibling tests in the same files take 3.6 s and 0.95 s on the same runner. That
scales the clock, not the assertions.

**The whole suite now passes on `windows-latest`, and the job is a gate**: `continue-on-error` is
gone from the job and its four steps, the name has lost "(exploratory)", and it has gained the
raw-byte scan and the route-table check the other two platforms run. `docs/e2-windows-gate.md` §5
and §6. **CI is green on macOS, Linux and Windows.**

### 3. The bounded ones

- **The rest of the router's header cost.** P6 flattened the pairs and recovered 19.2% of a hop
  where removing the header clone entirely is worth 37.5%, so about half of it survives — the
  string still crosses and both sides still build and parse it. A binary encoding, or caching the
  flattened form of the header sets a node actually sends, is where that goes.
  `docs/p6-router-resolution.md` §6. **Do this one on a quiet machine or not at all**: it is a 5-11%
  effect and this machine could not resolve 2x today.
- **The other 0.75 µs of a poll.** `WalTailer.poll()` is 1.98 µs once the checksum is native, of
  which an `fstat` and a separate 32-byte header read are 0.75. Looked at and **not done**, with
  a reason: the shape next.md proposed — "one `pread` taking the header and the first frame
  together" — only helps while `#offset` is still at the header, which it is for exactly one poll
  per WAL generation. What is left after that is dropping the `fstat` and letting a short read
  signal EOF, which is worth perhaps 0.3 µs of 1.98 on the most correctness-critical loop in the
  system, and could not be told from noise on this machine today. Do it when §8's conditions hold,
  or leave it. `docs/p3-wal-checksum.md` §2.
- ~~**A read mode for the native `/v1/db/{db}/tx`.**~~ **Closed (P8)** — as a *separate* surface,
  not a fourth writer mode. `docs/r10-read-transactions.md` §4 argued it away on the grounds that
  `BQL-Min-Txid` is the native consistent-read answer; it is not. That header is a **floor**, so
  two reads that both satisfy it can see different databases, and a consistent read is a **point**.
  `POST /v1/db/{db}/read` is the point, on R10's leased reader with no new primitive under it.
  `docs/p8-read-sessions.md` §1.
- **Change ring is in memory**, so `Last-Event-ID` returns `reset` across a restart. Spill it to
  disk or serve old positions from the log. This is the last of the realtime gaps — schema events
  now reach the SSE feed as well as the socket.
- **The npm release is manual.** `docs/releasing.md` runs the same gate `ci.yml` does, then
  `npm publish`. The package is **`bql.sh`**: unscoped `bql` is somebody else's. **The product is
  still bql.sh** — `BQL_*`, `bql.toml`, the `bql:` log prefix and the `bql` binary are untouched.
  MIT and the copyright line are a default, not a decision.
- **`@bql/sqlite-*` prebuilt libraries** are still unbuilt and still the right idea;
  `docs/c6-packaging.md` §6 says what it would take. The scope is held, so the names are there.

### Closed since the last edition, so stop looking for them

- ~~**`defensive` for the vendored build.**~~ It is `[sqlite] defensive`, it is implemented through
  `bql_db_config_int`, and a node told to be defensive on a build that cannot be refuses to
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
in JavaScript and every write is about 17% slower — `bql serve` says so at startup
(`docs/p3-wal-checksum.md`). That is what CI uses on both platforms. Without it the driver still finds Homebrew's build
on macOS and a distro one on Linux — contrary to what this file used to say, Debian and Ubuntu
*do* ship `ENABLE_PREUPDATE_HOOK` and `ENABLE_SESSION` — but no distro ships
`SQLITE_ENABLE_SNAPSHOT`, and the floor is SQLite 3.37.0 because `sqlite3_changes64` is in the
core symbol table, so an older library fails `dlopen` entirely and reads as *no* library. Apple's
system build lacks `load_extension`. `BQL_SQLITE_LIB` overrides the search, and a capability
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
