# Resume here — state of BunQL and what to do next

Written 2026-09-12 at the end of the session that built phase 1. Read this, then `docs/design.md`
§0 and §11, then `docs/api.md`.

## Where things stand

Phases 0 and 1 are complete on `main`, pushed to **https://github.com/TimMikeladze/bunql**
(private; `origin/main` is current), working tree clean. `bun test` → 874 pass, 2 skip, 0 fail
across 65 files. `bun run typecheck` clean. `bun run bench` meets every design §10 budget but one
(WebSocket mixed throughput, below). Zero runtime dependencies.

| area | module | state |
|---|---|---|
| SQLite driver | `src/sqlite/` | own `bun:ffi` driver over a shared libsqlite3. 0.77 µs point reads. Hooks, authorizer, deadline cancellation, limits, sessions, `stmt.vmSteps()`, and the prepare-time program facts `lastInsertRowid` needs |
| WAL replication core | `src/wal/` | frame tailer, zstd `TxnRecord` with rolling db checksum, segment log with a sidecar index, replica applier (mechanism B), reflink snapshots, PITR restore |
| replication transport | `src/replication/` | one binary WebSocket per node pair: `HELLO`/`SUBSCRIBE`/`SNAPSHOT_*`/`TXN`/`ACK`/`FORWARD`/`RESULT`/`HEARTBEAT`, snapshot bootstrap, gapless resume, epoch fencing, divergence and retention re-snapshot, ack tracking |
| tenants | `src/tenant/` | LRU registry, single-writer write path (28 µs), replica-mode tenants, checkpoint policy, quotas, crash reconcile, fork, catalog `_system.db` |
| storage | `src/storage/` | `Bun.S3Client` shipper, specified bucket layout, manifest and generations, retention, verify, restore onto a node that has never seen the database |
| realtime | `src/realtime/` | preupdate-hook change capture, authorizer read-sets, live queries with keyed diffs, ring buffer, authorizer hub; on a replica, applier-driven |
| server | `src/server/` | HTTP + WebSocket + SSE per design §6/§7, EdDSA tokens with table ACLs, write forwarding, ack levels, a fair transaction queue, TOML/env config, metrics |
| libsql compatibility | `src/server/hrana/` | `/v2/pipeline`, `/v3/pipeline`, `/v3/cursor`, `hrana3`/`hrana2` sockets, batons, cursors, over the same `exec.ts` as the native routes |
| client / embedded / ORMs / CLI | `src/client/`, `src/embedded.ts`, `src/kysely.ts`, `src/drizzle.ts`, `src/cli.ts` | Bun.SQL-shaped SDK (no Bun/Node imports), in-process API with `.sync`, Kysely dialect and Drizzle driver as optional peers, `bunql` CLI |
| tests / benches / docs | `test/`, `bench/`, `docs/` | two e2e scenarios (single node, cluster), `bun run bench` against design §10 plus a phase-1 table, `docs/api.md` as-built reference, `docs/benchmarks.md` |

Per-milestone deviations live in `docs/m3-wal.md` … `docs/m8-e2e.md` (phase 0) and
`docs/r1-replication.md` … `docs/r5-orm.md` (phase 1). Empirical proofs that predate the code are
in `experiments/`.

Design page published for review (republish with `bun scripts/design-page.ts <out.html>` then the
Artifact tool against the same path): https://claude.ai/code/artifact/c08e3642-c1f9-4f73-87da-5cc028e541f7

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

## Phase 2 — the next milestones

Build in this order. The first is the gate for everything after it.

1. **Control plane (§5.3).** Pick the answer to §13 #11 and build it: cluster membership, a term
   or lease per database, and the fencing token the write path already carries as `epoch`. Nothing
   on the data path. `GET /v1/cluster` as the observable surface.
2. **Promotion and failover.** `POST /v1/db/{db}/promote` and `bunql promote`: a replica that has
   applied everything it can, bumped its epoch, and been accepted by the control plane becomes a
   primary — with the old primary fenced by the epoch it no longer holds. The record header
   already carries the epoch; `docs/r1-replication.md` explains what a stale epoch does today
   (`EPOCH_AHEAD`, socket closed). Then `moved` on the client, and `BunQL-Primary` following the
   new one.
3. **Placement and the `[cluster]` config section**, so a database has a home node and a client
   that lands on the wrong one is told where to go rather than answered slowly.
4. **`workers: N`.** One process owns every writer today. The design's answer is one worker per
   subset of databases with the router in front; the hard part is that the registry, the realtime
   bus and the replication socket are all per-process singletons.
5. **Replica apply mechanism A (§4.5).** Write pages into the DB file and rewrite the shm header
   under the WAL locks, LiteFS-style. Mechanism B works but rescans the WAL per apply, which is
   the 48 µs "replica read" leg in `bench/wal.ts`.
6. **Linux packaging and CI**, which phase 1 did not get to and which every deployment needs.

## Known gaps worth fixing along the way

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

What phase 1 added to the list:

- **A standalone node never takes a snapshot, so retention can make it unrestorable.** Found by R6
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

## Start here, before milestone 1

Both items that stood here have landed — `fix(server): refuse admin writes on a replica instead of
acting locally` and `fix(tenant): sweep the trash directory on the log's retention` — so milestone
1, the control plane, is the next thing to build.

What they changed, in case it matters to phase 2:

- `POST /v1/db`, `DELETE /v1/db/{db}`, `POST /v1/db/{db}/restore` and `POST /v1/db/{db}/import`
  answer `503 NOT_PRIMARY` with `BunQL-Primary` on a replica. The gate is `requirePrimary` in
  `src/server/routes.ts`, at the HTTP layer only: the replication client still creates and deletes
  tenants through the registry, which is how a bootstrap works at all. **Promotion (milestone 2)
  has to flip `runtime.role`, not just the catalog row**, or a promoted node will keep refusing its
  own lifecycle routes.
- `[durability] retention` now has consumers — it was a dead key before. `sweepTrash(dataDir,
  retentionMs, now?, onError?)` in `src/tenant/registry.ts` sweeps the trash, and R6 (`49db1c4`)
  grew it into the log and snapshot retention it was always documented to govern: `retain()` and
  `removeSnapshot()` had been written, tested and **never called**, so the log and the snapshot
  directory grew without bound. Both now run behind `logRetentionFloor()`, the minimum over the
  consumers that could still read the log — the oldest snapshot kept, the slowest connected
  replica, and the S3 shipper's position. One `[durability] sweepIntervalMs` (300000) replaced the
  short-lived `trashSweepIntervalMs` and runs both; `[durability] maxLogBytes` (0 = unlimited)
  bounds a log by size, still behind the same floor. See `docs/r6-retention.md`.

## House rules for this repo

Bun only, no runtime dependencies (`kysely` and `drizzle-orm` are optional peers, `@libsql/client`
is a devDependency used by tests and benches only). Never import `bun:sqlite` in `src/` (tests and
`bench/driver.ts` may, for parity checks). Keep `docs/design.md` as the design of record and
`docs/api.md` as the as-built reference — update both when an API changes, and
`bun run scripts/routes.ts --check` fails if the route table falls behind. Every module header
states its invariant. Tests go in `test/<area>/`, temp dirs under `os.tmpdir()`.

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
