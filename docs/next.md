# Resume here — state of BunQL and what to do next

Rewritten 2026-09-12 at the end of the session that built `workers: N` (C4). Read this,
then `docs/c4-workers.md`, then `docs/performance.md`, then `docs/design.md` §0, §11 and §14, then
`docs/api.md`. Plans of record: `docs/plan-phase2.md` (the cluster), `docs/plan-surfaces.md` (HTTP,
OpenAPI, GraphQL), `docs/c4-workers.md`, `docs/h6-mount.md`, `docs/h8-validated-requests.md`,
`docs/p1-pragmas.md` and `docs/p2-group-commit.md`.

## Where things stand

Phases 0 and 1 are complete; phase 2 has its control plane, its failover, its packaging and now its
multi-core story. On `main`, pushed to **https://github.com/TimMikeladze/bunql** (private;
`origin/main` current, tree clean). `bun test` → **1346 pass, 2 skip, 0 fail** across 107 files.
`bun run typecheck`, `bun run bytes` and `bun run routes:check` clean. **CI green on macOS and
Linux.** Zero runtime dependencies.

**A node uses its cores.** `[server] workers = N` (`bunql serve --workers N`) shards databases
across worker threads behind one port: **28 809 writes/s at one worker, 72 817 at six, 2.67x**, on
the same eight databases and the same load the ceiling was measured on. `docs/c4-workers.md`.

**The surfaces are no longer dark.** `GET|POST|PATCH|DELETE /v1/db/{db}/api/*`,
`GET /v1/db/{db}/openapi.json`, `POST /v1/db/{db}/graphql` (GraphiQL on `GET`) and
`GET /v1/openapi.json` all serve, and the `Bun.serve` route table is now *built from* the same
`Registry` the server document is emitted from (`src/server/registry.ts`) — so a route that no
document describes cannot exist, and `bun run routes:check` fails on one. `docs/h6-mount.md`.

**Both open §13 decisions are settled:** **#11 built-in Raft**, control plane only; **#9 default
`ack` stays `local`**.

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
| C4: `workers: N` | `src/server/workers/` (shard, protocol, pool, entry, router), `[server] workers`, `--workers`, `WORKERS_UNSUPPORTED`, `Metrics.state/absorb`, `bench/workers.ts`. The main thread is a router owning the listener, every socket, the catalog and the authenticator and no database; N workers each hold a whole `ServerRuntime` over a hash shard. `ws.ts`, `routes.ts`, `runtime.ts` and `tenant/` are untouched. `docs/c4-workers.md` |
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

- **#11, the cluster control plane** — built-in Raft, external (etcd/Postgres), or static topology
  only. This is the first thing phase 2 needs, and nothing else in phase 2 can be designed around
  it. The recommendation stands at built-in Raft, on the control plane only, never on the data
  path.
- **#9, the default `ack`** — still `local`. Replicas exist now, so `replica` as the default for a
  node that has them is a real option. It is one line in `config.ts` and a paragraph in
  `docs/api.md`; the reason to leave it is that `NO_REPLICAS` would then fire on a node whose
  replica is restarting.

## Phase 2 — what is left

C1, C2 and C6 are done (see the table above). What remains, in the order it makes sense to build:

1. ~~**Control plane (§5.3).**~~ **Done (C1).** `src/cluster/`, `GET /v1/cluster`, `bunql cluster`.
2. ~~**Promotion and failover.**~~ **Done (C2).** `docs/c2-promotion.md`. Verified by hand on real
   nodes, including the case that matters most: an old primary restarted with **no `--replica-of`
   at all** still reads `BunQL-Role: replica` and refuses a write with `NOT_PRIMARY`, because the
   demotion is persisted rather than held in memory. No split brain in the one scenario where a
   node has every reason to believe it is still in charge.
3. **Placement and the `[cluster]` config section**, so a database has a home node and a client
   that lands on the wrong one is told where to go rather than answered slowly.
4. ~~**`workers: N`.**~~ **Done (C4).** `docs/c4-workers.md`. The decision the milestone really made:
   a worker owns a **shard of databases**, not a shared listener via `reusePort` — which is dead on
   macOS (measured) and which would turn every per-process singleton into an N-way distributed
   object. The router keeps them singular instead. What is left is **C4b**: a `Tenant` proxy over
   the channel so `/v1/replication` can be served for a database a worker owns, which is what
   `workers > 1` refusing to start beside replication or the cluster is waiting on.
5. **Replica apply mechanism A (§4.5).** Write pages into the DB file and rewrite the shm header
   under the WAL locks, LiteFS-style. Mechanism B works but rescans the WAL per apply, which is
   the 48 µs "replica read" leg in `bench/wal.ts`.
6. ~~**Linux packaging and CI**~~ **Done (C6).** See `docs/c6-packaging.md`.

Then the surfaces: ~~**H6**~~ **Done** (`docs/h6-mount.md`) — the `/v1` routes are now declared in
one `Registry` that builds the route table *and* `GET /v1/openapi.json`, the generated data API,
the per-database document and GraphQL are mounted, and `scripts/routes.ts --check` fails on a
served route that is not in the registry. **H7** adds GraphQL subscriptions over the change feed
`src/realtime/` already has. `docs/plan-surfaces.md` has both.

## Known gaps worth fixing along the way

Added by C4 (2026-09-12), all in reporting rather than in data, and all only with `workers > 1`:

- **`GET /v1/db` reports `"open": false` for every database.** "Open" is a fact about one worker's
  LRU and the router holds none. The rest of the row comes from the catalog and is exact. Fixing it
  means asking every worker, which is a round trip on a route that is otherwise a single catalog
  read.
- **`GET /metrics` omits the replication and storage gauges.** Every worker's counters are summed
  (`Metrics.state`/`absorb`) and so are the router's own, but replication is refused with
  `workers > 1` anyway and the S3 shipper's gauges are per worker with no summing rule that is not
  a lie.
- **A hopped request body crosses as one `Uint8Array`**, so `POST /v1/db/{db}/import` of a large
  SQLite file is copied once more than on a single-threaded node. `[limits] maxImportBytes` bounds
  it. The response side already streams above 1 MiB.

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
- **Replica apply mechanism A** (design §4.5) — now phase-2 milestone 5 above.
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
- **The Hrana surface does not forward writes.** A write to `/v2/pipeline` on a replica is
  `NOT_PRIMARY`. Forwarding it means deciding what a baton opened on a replica means, which is why
  R4 left it.
- **A replica's change feed is txid-only** (`changes: []`). Row-level CDC on a replica needs
  logical decoding of the WAL, which design §11 puts in phase 3.
- **A forwarded write is not retried**, by design: `FORWARD_TIMEOUT` or a dropped socket means "may
  or may not have committed". A client that cares reads the txid back. If phase 2 adds idempotency
  keys, this is where they go.
- **`ackWithoutReplicas` is a per-node switch, not a per-database one.** A node with ten databases
  and a replica following one of them refuses `ack: "replica"` on the other nine, which is correct
  but blunt.
- **`maxOpenTx` is fixed at 1** by the tenant having one writer. `txWaitMs` is the knob that
  matters. Worth revisiting only with `workers: N`.
- **The S3 shipper re-uploads an open segment as it grows.** Cheap here (633 bytes a record on the
  bench), but a workload with large transactions pays for the same bytes more than once. Ship
  closed segments only, or upload ranges.

## Start here — A or B, since C is done

**A and B are untouched and are the two biggest levers left.** They do not overlap in files, so
they can run in parallel. Each is written so it can be started cold, with the evidence for why it
is worth doing. C was H6's, and H8 closed everything C left behind except H7 — see under it.

### A. ~~`workers: N`~~ **Done (C4).** What it left behind

`docs/c4-workers.md` is the decision, the measurements that forced it and the as-built §9.
**28 809 → 72 817 writes/s at six workers, one port.** The follow-on, **C4b**, is the one thing it
could not do: `src/replication/primary.ts` serves a replica from the `Tenant` itself —
`tenant.onCommit`, `tenant.log.iterate`, `tenant.snapshot()`, `tenant.epoch`, `registry.pin` — and
one replication socket follows databases across every shard while the socket is on the router,
which owns no tenant. So `loadConfig` refuses `workers > 1` beside `[replication] secret`,
`[replication] primary` or `[cluster] enabled`, with `WORKERS_UNSUPPORTED` naming which. Lifting it
is a `Tenant` proxy over the channel, and it is the most interesting remaining piece of C4.

Three smaller things C4 left, all in reporting rather than in data, listed under "Known gaps".

### B. Replica apply mechanism A (phase 2, C5) — and it pays twice

**Why.** Two measurements point at it. The replica read leg is 48 µs because mechanism B rescans
the WAL per apply (`bench/wal.ts`). And the primary's WAL tail is **7.25 µs of a 28.4 µs write**,
of which ~5 is SQLite's checksum over a page *just read back from the WAL* — memory-bound, proven
by an allocation-free rewrite that moved it 7.25 → 7.21 and was reverted. The write path touches
each page about four times; mechanism A is the change that stops re-reading it.

**What.** Design §4.5: write pages into the database file and rewrite the shm header under the WAL
locks, LiteFS-style, instead of appending frames and letting the next reader rebuild the wal-index.

**Watch for.** This is the most correctness-sensitive milestone left. The existing checksum chain
(`computeFull`, the rolling database checksum in every `TxnRecord`) is the oracle — a replica that
diverges must fail loudly, and `test/wal/replication.test.ts` plus the two e2e scenarios are what
must keep passing unchanged.

### C. ~~H6~~ and ~~H8~~ **Done.** What is left of them

The largest built-but-dark surface is lit (`docs/h6-mount.md`) and the two things it left behind
are closed (`docs/h8-validated-requests.md`). One item remains:

- **H7, GraphQL subscriptions over the change feed.** `src/realtime/` already has the ring, the
  live-query engine and the SSE/WS transports; `src/graphql/` already has the schema cache and the
  ambient per-request token. A REST document cannot describe a subscription, so this is the one
  part of the surfaces work that is genuinely new code rather than wiring —
  `docs/plan-surfaces.md` H7. `graphql-ws` over the socket BunQL already runs.
- ~~**Put the hand-written handlers on the validated pipeline.**~~ **Done (H8).**
- ~~**`NOT_FOUND: 404`.**~~ **Done (H8.)** Both are `docs/h8-validated-requests.md`.

### Smaller, if you want something bounded

- **Deferred compression** (`docs/performance.md` §4C). zstd is 9.5 µs of a 28.4 µs write and is
  *already* a setting; the better version compresses **after** the ack for `ack: "local"`, keeping
  the 4.3x ratio and moving the CPU off the answer path. It decouples the log append from the
  commit, which is why it was not done — the change feed, the replication stream and the position
  save all read the log synchronously today.
- **Per-database `foreignKeys`** — the node-level switch exists (`[sqlite] foreignKeys`); making it
  per database needs a catalog column and a lifecycle route. `docs/p1-pragmas.md`.
- **`defensive` for the vendored build.** `SQLITE_DBCONFIG_DEFENSIVE` has no pragma and
  `sqlite3_db_config` is variadic — binding it fixed-arity through bun:ffi ignores the value, never
  writes the out-parameter, and **killed the process with SIGKILL**. The remedy is a non-variadic
  shim compiled by `scripts/sqlite.ts` into `vendor/sqlite/`, declared optional exactly as
  `sqlite3_snapshot_*` is. `docs/p1-pragmas.md`.
- **Hrana write forwarding.** A write to `/v2/pipeline` on a replica is still `NOT_PRIMARY`;
  forwarding means deciding what a baton opened on a replica means (R4 left it).

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
amalgamation into `vendor/sqlite/`, which `src/sqlite/lib.ts` now prefers over anything on the
system. That is what CI uses on both platforms. Without it the driver still finds Homebrew's build
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
