# Resume here — state of BunQL and what to do next

Written 2026-09-12 at the end of the session that built phase 1. Read this, then `docs/design.md`
§0 and §11, then `docs/api.md`.

## Where things stand

Phases 0 and 1 are complete on `main`, pushed to **https://github.com/TimMikeladze/bunql**
(private; `origin/main` is current), working tree clean. `bun test` → 861 pass, 2 skip, 0 fail
across 62 files. `bun run typecheck` clean. `bun run bench` meets every design §10 budget but one
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

- **Linux packaging.** The driver needs an external libsqlite3; `Database.setCustomSQLite` is a
  no-op on Linux and Bun exports no sqlite symbols. Ship prebuilt `@bunql/sqlite-{linux-x64,
  linux-arm64,darwin-arm64}` libraries, or fall back to the loadable-extension shim in
  `experiments/bunql_native.c`. The `engine: "builtin"` path over `node:sqlite` in design §4.1 is
  not built.
- **Replica apply mechanism A** (design §4.5) — now phase-2 milestone 5 above.
- **Change ring is in memory**, so `Last-Event-ID` returns `reset` across a server restart. Spill
  it to disk or serve old positions from the log.
- **`schema` events reach WebSocket subscribers only**, not the SSE change feed.
- **WS mixed-throughput budget missed** (130k vs 150k msg/s) because writes serialise on the
  single writer. Batch commits or pipeline the write path. Unchanged by phase 1.
- **No CI.** Add a workflow running `bun install`, `bun test`, `bun run typecheck` on macOS and
  Linux — the Linux leg needs the packaging fix above.
- Nothing is published to npm; `package.json` has `exports`, `bin`, `engines` but no release flow.

What phase 1 added to the list:

- **A replica cannot be promoted.** Recovery from a lost primary today is a new node pointed at
  the bucket. This is the headline gap and it is phase-2 milestone 2.
- **Admin routes on a replica act locally instead of forwarding.** `POST /v1/db` on a replica
  creates a local primary-role database the cluster never hears about, and `DELETE /v1/db/{db}`
  removes the replica's copy while the primary keeps it. The replica then stops following that
  database for good: it does not re-bootstrap, and later commits on the primary never reach it
  (verified by hand — the database is simply gone from `GET /v1/db` on the replica). Statement writes forward; admin writes should either forward too or be refused with
  `NOT_PRIMARY`. Refusing is the smaller change and probably the right one.
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
- **Deleted databases are moved to `<dataDir>/trash/` and nothing sweeps it.** A long-lived node
  that churns databases grows a trash directory forever.
- **The S3 shipper re-uploads an open segment as it grows.** Cheap here (633 bytes a record on the
  bench), but a workload with large transactions pays for the same bytes more than once. Ship
  closed segments only, or upload ranges.

## Start here, before milestone 1

Two things are cheap and should land before the control plane, because they are bugs rather than
features:

1. **Admin routes on a replica act locally** (see the gap list above). `POST /v1/db` on a replica
   creates a database the cluster never hears about, and `DELETE /v1/db/{db}` silently stops that
   replica following it forever. Refuse both with `NOT_PRIMARY` and a `BunQL-Primary` header, the
   way statement writes already behave when forwarding is off.
2. **Nothing sweeps `<dataDir>/trash/`.** Give it the retention the log already has.

## House rules for this repo

Bun only, no runtime dependencies (`kysely` and `drizzle-orm` are optional peers, `@libsql/client`
is a devDependency used by tests and benches only). Never import `bun:sqlite` in `src/` (tests and
`bench/driver.ts` may, for parity checks). Keep `docs/design.md` as the design of record and
`docs/api.md` as the as-built reference — update both when an API changes, and
`bun run scripts/routes.ts --check` fails if the route table falls behind. Every module header
states its invariant. Tests go in `test/<area>/`, temp dirs under `os.tmpdir()`. On macOS the
driver wants Homebrew SQLite (`/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`, 3.53.4 with SESSION
and PREUPDATE); Apple's system build lacks `load_extension`. `BUNQL_SQLITE_LIB` overrides the
search.

Commands: `bun test`, `bun run typecheck`, `bun run bench` (`--quick`,
`--only <driver|wal|tenant|http|replication|storage>`, `--json`), `bun run start`,
`bun run src/cli.ts serve --dir ./data --port 4321`.
