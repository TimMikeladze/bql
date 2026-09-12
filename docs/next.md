# Resume here — state of BunQL and what to do next

Written 2026-09-12 at the end of the session that designed and built phase 0. Read this, then
`docs/design.md` §0 and §11, then `docs/api.md`.

## Where things stand

Phase 0 is complete on `main` (13 commits, working tree clean). `bun test` → 494 pass, 2 skip,
0 fail across 36 files. `bun run typecheck` clean. ~17.6k lines in `src/`.

| area | module | state |
|---|---|---|
| SQLite driver | `src/sqlite/` | own `bun:ffi` driver over a shared libsqlite3. 0.78 µs point reads. Hooks, authorizer, deadline cancellation, limits, sessions, `stmt.vmSteps()` |
| WAL replication core | `src/wal/` | frame tailer, zstd `TxnRecord` with rolling db checksum, segment log, replica applier (mechanism B), reflink snapshots, PITR restore |
| tenants | `src/tenant/` | LRU registry, single-writer write path (27 µs), checkpoint policy, quotas, crash reconcile, fork, catalog `_system.db` |
| realtime | `src/realtime/` | preupdate-hook change capture, authorizer read-sets, live queries with keyed diffs, ring buffer, authorizer hub |
| server | `src/server/` | HTTP + WebSocket + SSE per design §6/§7, EdDSA tokens with table ACLs, TOML/env config, metrics |
| client / embedded / CLI | `src/client/`, `src/embedded.ts`, `src/cli.ts` | Bun.SQL-shaped SDK (no Bun/Node imports), in-process API with `.sync`, `bunql` CLI |
| tests / benches / docs | `test/`, `bench/`, `docs/` | e2e scenario suite, `bun run bench` against design §10, `docs/api.md` as-built reference, `docs/benchmarks.md` |

Per-milestone deviations live in `docs/m3-wal.md` … `docs/m8-e2e.md`. Empirical proofs that
predate the code are in `experiments/`.

Design page published for review (republish with `bun scripts/design-page.ts <out.html>` then the
Artifact tool against the same path): https://claude.ai/code/artifact/c08e3642-c1f9-4f73-87da-5cc028e541f7

## How the work was run (keep doing this)

Design and coordination on Fable; every implementation milestone delegated to an Opus subagent
with a long, precise brief naming the files to create, the API surface, the tests, and the commit
message. One milestone per agent, verified by the coordinator with `bun test`, `bun run typecheck`
and a hand exercise of the changed surface before the next agent starts. Parallel agents only when
their file sets do not overlap; tell each one which paths it does not own.

## Decisions still open (design §13)

Tim has not overridden any of the eleven; phase 0 shipped the recommended default for each. The
ones that still change future work: Hrana compat (§6.7, planned for phase 1), cluster control
plane (built-in Raft vs external vs static topology only, phase 2), and default `ack` once
replicas exist (`local` today).

## Phase 1 — the next milestones

Build in this order; the first three are one coherent piece.

1. **Replication transport (§8).** `src/replication/`: binary WS frames `HELLO`, `SUBSCRIBE`,
   `SNAPSHOT_BEGIN/CHUNK/END`, `TXN`, `ACK`, `FORWARD`/`RESULT`, `HEARTBEAT`. Primary endpoint
   `/v1/replication` authenticated by cluster secret or mTLS. Replica process: `bunql serve
   --replica-of wss://…`, applies with the existing `src/wal/applier.ts`, ACKs `(db, txid)`,
   re-bootstraps from a snapshot when its position falls outside the log's retention.
2. **Durability levels.** `ack: "replica" | "quorum"` in `Tenant.write` and the query routes: hold
   the response until enough replica ACKs arrive or `ackTimeoutMs` elapses (then 503 with the txid
   that is durable locally). Epoch fencing already exists in the record header.
3. **Read-your-writes across nodes.** Replicas serve reads, forward writes to the primary
   transparently, honour `BunQL-Min-Txid` by waiting on the applier, and return `503 NOT_PRIMARY`
   with a `BunQL-Primary` header when forwarding is disabled.
4. **S3 shipper and restore.** `Bun.S3Client`: ship segments and snapshots, restore by
   `--at <txid|timestamp>` from the bucket, retention/compaction levels. Reuse the local log
   iterator so a bucket is just another sink.
5. **Hrana compat (§6.7).** `GET /v2` + `POST /v2/pipeline` first — `@libsql/client`, Drizzle's
   libsql driver and kysely-libsql all work against that alone. Then `/v3/pipeline`, `/v3/cursor`,
   and the `hrana2`/`hrana3` WebSocket subprotocols. `replication_index` maps to our `txid`.
   Mount under `/v1/db/{db}/…` and at the root with tenant from `x-namespace` or the first `Host`
   label.
6. **ORM adapters.** `bunql/kysely` (copy the ~140-line kysely-libsql dialect shape) and
   `bunql/drizzle` (our client object is libsql-shaped enough to pass straight in).

## Known gaps worth fixing along the way

- **Linux packaging.** The driver needs an external libsqlite3; `Database.setCustomSQLite` is a
  no-op on Linux and Bun exports no sqlite symbols. Ship prebuilt `@bunql/sqlite-{linux-x64,
  linux-arm64,darwin-arm64}` libraries, or fall back to the loadable-extension shim in
  `experiments/bunql_native.c`. The `engine: "builtin"` path over `node:sqlite` in design §4.1 is
  not built.
- **Replica apply mechanism A** (design §4.5): write pages into the DB file and rewrite the shm
  header under the WAL locks, LiteFS-style. Mechanism B works but rescans the WAL per apply.
- ~~**`src/wal/log.ts` cold open** walks every record header (~0.5 µs each; 3.1 ms of a 3.6 ms open
  at 6k records). Persist a segment index.~~ Fixed in R3: a sidecar `<startTxid>.idx` takes the
  cold open of a 6k-record log from 2.69 ms to 0.36 ms, and is a cache the scan falls back to
  (`docs/r3-storage.md` §5).
- **Change ring is in memory**, so `Last-Event-ID` returns `reset` across a server restart. Spill
  it to disk or serve old positions from the log.
- **`schema` events reach WebSocket subscribers only**, not the SSE change feed.
- **WS mixed-throughput budget missed** (129k vs 150k msg/s) because writes serialise on the
  single writer. Batch commits or pipeline the write path.
- **No CI.** Add a workflow running `bun install`, `bun test`, `bun run typecheck` on macOS and
  Linux — the Linux leg needs the packaging fix above.
- Nothing is published to npm; `package.json` has `exports`, `bin`, `engines` but no release flow.

## House rules for this repo

Bun only, no runtime dependencies. Never import `bun:sqlite` in `src/` (tests may, for parity
checks). Keep `docs/design.md` as the design of record and `docs/api.md` as the as-built
reference — update both when an API changes. Every module header states its invariant. Tests go
in `test/<area>/`, temp dirs under `os.tmpdir()`. On macOS the driver wants Homebrew SQLite
(`/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`, 3.53.4 with SESSION and PREUPDATE); Apple's
system build lacks `load_extension`. `BUNQL_SQLITE_LIB` overrides the search.

Commands: `bun test`, `bun run typecheck`, `bun run bench` (`--quick`, `--only <driver|wal|tenant|http>`,
`--json`), `bun run start`, `bun run src/cli.ts serve --dir ./data --port 4321`.
