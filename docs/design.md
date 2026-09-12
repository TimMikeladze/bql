# BunQL — design proposal (v0, for review)

Multi-tenant SQLite on Bun: one process, thousands of databases, sub-millisecond queries over
HTTP/WebSocket/SSE, physical WAL-shipping replication, realtime change feeds and live queries,
point-in-time restore, and an optional HA cluster. Runs standalone by default.

This document is the thing to argue with. Sections 6–9 (API surfaces) are where I want your
eyes most. Section 2 is what was actually proven on real bits before writing anything else.

---

## 0. Status — phase 0 is built (2026-09-12)

Everything in §11 phase 0 exists, is tested, and runs: `bun test` → 494 pass, 0 fail across 36
files; `bun run typecheck` clean; ~17.6k lines in `src/`. The as-built API reference is
`docs/api.md` (every route, WS op, SSE event, SDK/embedded/CLI surface, config keys, and a
"differences from the design" list); measured numbers are in `docs/benchmarks.md`; each
milestone's deviations are in `docs/m3-wal.md` … `docs/m8-e2e.md`.

| path | budget (§10) | measured | verdict |
|---|---|---|---|
| point read, in process | ≤ 1.2 µs | 0.78 µs | pass |
| point read over HTTP keep-alive | ≤ 60 µs | 47.8 µs | pass |
| point read over WebSocket | ≤ 35 µs | 28.8 µs | pass |
| single-row write, `ack: local`, incl. tail + log | ≤ 40 µs | 27.0 µs | pass |
| write visible on a replica (applier fed from the log) | ≤ 1 ms | 291 µs | pass |
| live-query invalidation → socket | ≤ 200 µs | 19.1 µs | pass |
| tenants open per process | 10k | 10k | pass |
| mixed 90/10 throughput, HTTP, one core | ≥ 50k req/s | 52k | pass |
| mixed 90/10 throughput, WebSocket | ≥ 150k msg/s | 129k | warn (writes serialise on the single writer) |

Not built yet (phase 1): replica streaming over the WS replication protocol (§8), `ack:
replica|quorum`, S3 shipper, Hrana compat (§6.7), Kysely/Drizzle adapters, `promote`. Phase 2:
cluster (§5.3). Notable as-built differences: replica apply ships mechanism B (§4.5); the change
ring is in memory, so `Last-Event-ID` resumes gaplessly across a dropped connection but returns
`reset` across a server restart; `schema` events reach WebSocket subscribers only; SQLite's
`sqlite3_wal_checkpoint_v2` counters are not a reliable no-op tell, so checkpoints verify by WAL
size; `lastInsertRowid` is null unless the statement moved it.

## 1. Goals / non-goals

**Goals**

- Fastest possible request path on Bun: single-digit µs per query in-process, ~50 µs over HTTP
  keep-alive, ~25 µs over WebSocket (measured, §2.4).
- DB-per-tenant multi-tenancy. Tenant = one SQLite file. Thousands per node, LRU-managed.
- Replication that is *exact* (physical WAL frames), not statement replay. Works for any SQL
  (DDL, triggers, `random()`, FTS, R*Tree, JSON...) with zero rewriting.
- Realtime: row-level change feed and live queries over SSE and WS, driven by SQLite hooks,
  not triggers, not SQL parsing.
- Standalone first. Replicas, semi-sync durability, S3 backup/PITR, and cluster failover are
  layers on the same log — not a different product.
- Bun-native everywhere: `Bun.serve` routes + WS pub/sub, `bun:ffi`, `Bun.S3Client`,
  `Bun.zstd*`, `Bun.hash.xxHash3`, `Bun.write` reflink copies, `Bun.TOML`.

**Non-goals (v1)**

- Multi-master / CRDT. Single writer per database, always.
- Cross-database transactions.
- Being a general Postgres replacement. This is "SQLite, many of them, replicated, fast".

## 2. What was proven before designing (all runnable in `experiments/`)

Bun 1.4.0 on macOS 25.6, Apple SQLite 3.51.0 / Homebrew 3.53.4; Linux checks in
`oven/bun:1.4` (Bun 1.4.2, bundled SQLite 3.53.2).

### 2.1 Physical WAL shipping works from userland (`experiments/walproto.ts`)

Primary writes through a normal connection with `wal_autocheckpoint=0`. A tailer reads the
`-wal` file bytes, validates salts + cumulative checksums, groups frames into committed
transactions. The applier appends those frames to the *replica's* own `-wal` (re-salted,
checksums recomputed), fsyncs, then zeroes the first 136 bytes of the replica `-shm` so the
next reader rebuilds the wal-index (same trick LiteFS uses). Results:

| check | result |
|---|---|
| 200 txns × 5 rows, replica count matches every round | ok |
| primary `wal_checkpoint(RESTART)` mid-stream (salt change) | tailer follows, no gap |
| replica-side `wal_checkpoint(TRUNCATE)` then continue streaming | ok |
| `integrity_check` primary + replica | ok / ok |
| external `sqlite3` CLI reading the replica concurrently | consistent |
| read-only replica connection performs wal-index recovery itself | yes |
| shm invalidation while another process holds an open read txn | read succeeded |
| write + tail + apply + fsync + read, same process | p50 184 µs, p90 243 µs |

Linux (Docker, virtiofs): identical correctness, p50 ~1 ms because of fsync on virtiofs.

### 2.2 Full SQLite C API is reachable from Bun (`experiments/hook.ts`)

`sqlite3_auto_extension` called over `bun:ffi` captures the raw `sqlite3*` of every connection
bun:sqlite opens afterwards. On that handle, all of these fired correctly on a bun:sqlite
connection: `wal_hook`, `update_hook`, `commit_hook`, `set_authorizer` (reports every table and
column a statement touches at prepare time), `progress_handler` (cancelled a runaway query with
`"interrupted"`), `sqlite3_limit`. Session extension changesets generate and apply
(`experiments/session.ts`).

Caveat that shaped the driver decision (§4.1): this only works when bun:sqlite and bun:ffi
share one libsqlite3 instance. True on macOS with `Database.setCustomSQLite(homebrew)`; on
Linux `setCustomSQLite` is a silent no-op, Bun's SQLite is statically linked and not exported.
A 30-line loadable-extension shim (`experiments/bunql_native.c`) recovers *most* hooks on Linux
from Bun's bundled SQLite — verified in Docker: `update_hook` and progress-handler cancellation
work through the `sqlite3_api_routines` table (wal/update/commit hooks, authorizer, progress,
limit), but that table has no session/preupdate entries.

### 2.3 A pure `bun:ffi` driver is faster than bun:sqlite (`experiments/ffibench.ts`)

| op | bun:ffi driver | bun:sqlite |
|---|---|---|
| point read by PK → `{v: string}` | 0.81–0.94 µs | 1.75–2.12 µs |
| insert inside txn | 0.18 µs | — |
| insert inside txn with JS `update_hook` firing | 0.23 µs | — |
| single-row autocommit insert (WAL, sync=NORMAL) | 6.2 µs | 11.1 µs |

Hook cost is ~50 ns per row. This is what makes "realtime driven by hooks" free.

### 2.4 Transport and OS numbers (`experiments/bench.ts`, `experiments/misc.ts`)

| op | measured |
|---|---|
| Bun.serve HTTP keep-alive round trip, JSON body, same host | 47.9 µs |
| Bun WebSocket round trip | 26.7 µs |
| 2000 concurrent HTTP fetches | 50 ms total |
| open+close a file DB connection | 17 µs |
| single-row insert, `synchronous=FULL` | 35 µs |
| copy 512 MB DB file via `Bun.write` / `COPYFILE_FICLONE` (APFS clonefile) | 4.8 ms / 0.2 ms |

Instant reflink copies are what make snapshots and forks O(1) (APFS, XFS, btrfs).

## 3. Architecture in one picture

```
                      ┌──────────────────────── node (one Bun process) ────────────────────────┐
 clients ──HTTP/WS/SSE─▶  Bun.serve routes ─▶ Router ─▶ Tenant registry (LRU of open DBs)      │
                      │                                    │                                    │
                      │            ┌───────────────────────┴──────────────────────┐             │
                      │            ▼ per database                                  ▼             │
                      │   ┌─ Engine (bun:ffi sqlite driver) ─┐        ┌─ Realtime ───────────┐  │
                      │   │ writer conn (owner)               │ hooks  │ change feed (rows)    │  │
                      │   │ reader conns (pool)               │──────▶│ live queries (deps)   │──┼─▶ ws.publish / SSE
                      │   │ authorizer / progress / limits    │        └───────────────────────┘  │
                      │   └───────────┬───────────────────────┘                                   │
                      │               │ after each commit                                         │
                      │   ┌─ WAL tailer ─▶ TxnRecord ─▶ Log (segments, zstd) ─▶ ┬─ replica streams (WS binary)
                      │   │                                                     ├─ S3 shipper (Bun.S3Client)
                      │   └─ checkpoint policy (we own checkpoints)              └─ snapshots (reflink)
                      │                                                                           │
 peers ──WS binary────▶  Replication endpoint: SUBSCRIBE / TXN / ACK / SNAPSHOT / FORWARD / LEASE │
                      └───────────────────────────────────────────────────────────────────────────┘
```

Single-threaded by design (like Redis). Everything on the request path is synchronous and
allocation-light; SQLite itself is the slow part at ~1 µs. Multi-core is by process/tenant
placement (§5.5), not by threads on the hot path.

## 4. Core components

### 4.1 Engine: our own `bun:ffi` SQLite driver over a vendored libsqlite3

Decision: **do not build on `bun:sqlite`.** Ship `@bunql/sqlite-{darwin-arm64,linux-x64,linux-arm64}`
(prebuilt libsqlite3 with `ENABLE_SESSION`, `PREUPDATE_HOOK`, `SNAPSHOT`, `DBSTAT_VTAB`, `FTS5`,
`RTREE`, `JSON`, `MATH`, `STAT4`, `UNLOCK_NOTIFY`, `USE_URI`, `DEFAULT_WAL_SYNCHRONOUS=1`), and a thin TypeScript driver
using `dlopen` + `CFunction`. Why:

- Measured 2× faster point reads than bun:sqlite (§2.3).
- Full C API on every platform: hooks, authorizer, progress/cancellation, per-connection
  limits, session changesets, snapshots, `file_control`, `wal_checkpoint_v2` return values.
- One SQLite instance per process → no cross-instance POSIX-lock footguns.
- We choose compile flags and can add a VFS shim later without waiting on Bun.

Driver shape (internal, but `bunql/sqlite` is exported for people who just want a faster
bun:sqlite):

```ts
const db = Sqlite.open(path, { readonly, wal: true, busyTimeoutMs })
const stmt = db.prepare("select * from t where id = ?")      // cached per connection by SQL text
stmt.get(1) / stmt.all(1) / stmt.values(1) / stmt.run(1)     // same verbs as bun:sqlite
db.exec(sql); db.transaction(fn, "immediate")
db.hooks.onUpdate(cb) / onCommit(cb) / onWal(cb); db.authorizer(cb); db.deadline(ms)
db.limit("SQLITE_LIMIT_LENGTH", n); db.session(...)
```

Fallback mode (`engine: "builtin"`) uses Bun's built-in SQLite through `node:sqlite`
(feature-complete in Bun 1.4: `setAuthorizer`, `createSession`/`applyChangeset`,
`enableDefensive`) plus WAL tailing, for environments where a native library can't be shipped.
Table-level ACL and row-level change capture (via session changesets, parsed after commit)
survive there; per-row hooks, query cancellation and per-connection limits do not. Replication
is identical in both modes.

Two Bun facts the driver has to respect: Bun installs the autocheckpoint `wal_hook` *after*
auto-extensions run, so hooks are installed post-open (installing our own `wal_hook` is what
disables autocheckpointing, which we want); and a `Bun.write` file copy is a reflink only when
the destination does not exist yet (existing destination → real copy), so snapshots always
write to a fresh path.

### 4.2 Tenant registry

- Tenant = database name `[a-z0-9][a-z0-9-_]{0,63}`. Path `data/dbs/<2-char hash>/<name>/main.db`.
- LRU of open tenants (`maxOpen`, default 1024; ~17 µs to open, so cold hits are cheap).
  Each open tenant: 1 writer connection (owns commits and the WAL tailer), N readers (default 2).
- Per-tenant knobs applied on open: `page_size`, `journal_mode=wal`, `synchronous=NORMAL`,
  `wal_autocheckpoint=0` (we checkpoint), `max_page_count` (storage quota, enforced by SQLite),
  `busy_timeout`, `sqlite3_limit` set (SQL length, compound select, variable count, expr depth).
- A local catalog `data/_system.db` (itself a BunQL database, replicated like any other in
  cluster mode) holds tenants, tokens, positions, placement.

### 4.3 Write path and WAL tailer

1. Request → owner (single writer) → `BEGIN IMMEDIATE` → statements → `COMMIT`.
2. Immediately after commit (`wal_hook`, which fires after the write lock is released), tail
   the `-wal` from the last *commit* frame: parse frames, validate salts and the cumulative
   checksum chain (frame checksum = chain(prev, first 8 header bytes, page)), keep the last
   version of each page, cut at the commit frame → one **TxnRecord**. The confirmed position
   only ever advances at commit frames, because SQLite rewrites frames in place inside an
   uncommitted transaction and recomputes their checksums at commit. A salt change means the
   WAL was reset (salt-1 increments, salt-2 is random): restart at frame 1.
3. Assign `txid = last + 1` (per-database monotonic u64), stamp `epoch` (leadership term).
4. Append TxnRecord to the tenant log segment (zstd level 3 by default; pages compress 3×).
5. Fan out: replica streams, S3 shipper, realtime (realtime actually fires from hooks during
   step 1 and is published after step 4 so subscribers never see a txid that isn't durable).
6. Respond to the client with `txid`. If the request asked `ack: "replica"`, respond after ≥1
   replica ACKs that txid; `ack: "quorum"` after ⌈rf/2⌉.

Crash recovery on the primary is the replica applier pointed at itself: each TxnRecord stores
its WAL position (salts, frame index) and an xxh3 of every page it wrote. On open, compare the
last record's pages with the database; if they differ, the record is applied (log ahead of DB);
if the WAL holds valid frames beyond the last record, they are tailed into new records (DB ahead
of log). One code path, no `_bunql` bookkeeping table inside user databases.

Checkpoint policy (we own it, no autocheckpoint): `PASSIVE` when WAL > 4 MB *and* the log
has shipped past `mxFrame`; `TRUNCATE` when idle > 1 s and no reader holds a snapshot;
`RESTART` never forced (salt change is handled anyway). Because only we checkpoint, the tailer
can never lose frames — no Litestream-style "hold a read lock forever" hack needed.

TxnRecord (`.seg` files, also the on-wire format):

```
magic "BQL1" | version u8 | flags u8 (zstd, snapshot-boundary) | pageSize u16
txid u64 | prevTxid u64 | epoch u32 | timestampUs u64 | commitSizePages u32 | frameCount u32
walSalt1 u32 | walSalt2 u32 | walEndFrame u32          (primary WAL position, for crash reconcile)
preChecksum u64 | postChecksum u64                     (rolling database checksum, LiteFS-style)
[ pgno u32 | page bytes ]*   (zstd-compressed as one block)
xxh3-128 over the uncompressed body | xxh3-64 of header
```

The rolling database checksum is `XOR over all pages of xxh3_64(pgno ‖ page)`. It is updated
incrementally per record: for each written page, `chk ^= H(old) ^ H(new)`. The primary knows
the old page because the tailer keeps a `pgno → hash` map of the live WAL (the same map the
wal-index holds), falling back to a `pread` of the database file. A replica verifies
`postChecksum` after every apply; a mismatch is divergence (split brain, bit rot) and triggers a
re-snapshot instead of silently serving wrong data. `(txid, postChecksum)` is the position, as
in LiteFS.

```
(record layout above)
```

### 4.4 Snapshots, log retention, PITR, S3

- **Snapshot** = physical copy of `main.db` taken right after a `TRUNCATE` checkpoint (so the
  file equals state at a known txid). `Bun.write(dst, file)` is a reflink on APFS/XFS/btrfs: 0.2–5 ms
  for 512 MB. Falls back to a streamed copy with checkpoints paused (we own checkpoints).
- Log segments rotate at 16 MB or on snapshot. `retention: "7d"` default; a replica or S3
  shipper that falls behind the retention window re-bootstraps from snapshot + tail.
- **S3 shipper** (Litestream role, built in): snapshots + segments to any S3-compatible
  bucket via `Bun.S3Client` (R2, Tigris, MinIO). Restore = latest snapshot ≤ target + replay
  segments to txid/timestamp. `bunql restore acme --at 2026-09-11T10:00Z --into acme-recovered`.
- **Fork/branch** = snapshot reflink + new tenant + fresh log. O(1). `POST /v1/db {from:{db,at}}`.

### 4.5 Replica apply

Two mechanisms, both keeping SQLite's own readers correct:

**A. Page apply (target, what LiteFS does).** Replica keeps `main.db` with an empty `-wal`.
Per TxnRecord: verify `prevTxid == local txid` and `epoch ≥ local epoch` (fencing); take the
WAL lock set (WRITE, CKPT, RECOVER, READ0..4) through SQLite's own VFS —
`file_control(SQLITE_FCNTL_FILE_POINTER)` gives the `sqlite3_file*`, and its `xShmLock` is the
same routine SQLite uses, so in-process and cross-process readers are both respected; `pwrite`
each page into the file, `ftruncate` to `commitSize`, verify `postChecksum`, rewrite the 136-byte
`-shm` header (`iChange+1`, `mxFrame=0`, `nPage=commit`, both copies, native-endian checksum,
read marks reset), release locks, ACK. A reader's next transaction sees a changed header, drops
its page cache and reads the file directly. No recovery scans, no WAL growth on replicas, apply
holds the locks for ~100 µs; readers mid-transaction make it wait (bounded by `streamTimeoutMs`),
readers arriving during apply get `SQLITE_BUSY` and retry through the busy handler.

**B. WAL append + wal-index invalidation (proven in `experiments/walproto.ts`).** Append the
frames to the replica's own `-wal` with local salts and recomputed checksums, fsync, zero the
`-shm` header; the next reader runs SQLite's recovery and rebuilds the index. Simpler, no lock
choreography, but every apply costs a WAL rescan and resets `nBackfill`, so it needs
replica-side checkpoints. Phase 0 ships B (it is validated), phase 1 switches to A behind the
same interface and keeps B as the fallback for filesystems where `xShmLock` misbehaves.

Either way replica readers never see a torn state: SQLite's own WAL protocol guarantees they
see either the old or the new header.

Bootstrap: `SUBSCRIBE {fromTxid}`; primary answers with frames if `fromTxid` is still in the
log, else `SNAPSHOT` (streamed file, zstd) + frames from the snapshot's txid.

Reader coordination: both mechanisms need the exclusive WAL locks for a moment, so the applier
never runs while a local reader has an open read transaction (streamed results are chunked per
event-loop tick and bounded by `streamTimeoutMs`); it queues and applies at the next quiet
point. Phase 3 candidate: maintain the wal-index hash tables ourselves (format is documented in
`walformat.html`), which removes the exclusive lock from mechanism B entirely.

### 4.6 Realtime engine (hooks, not triggers, not SQL parsing)

- **Change feed**: `preupdate_hook` is the source (it also covers `WITHOUT ROWID` tables, which
  `update_hook` silently skips) and gives old and new values when the tenant has
  `changes.includeRows` on; `update_hook` is the fallback engine mode. DDL is observed through
  the authorizer (`CREATE/ALTER/DROP`) and emitted as `schema` events. A registered preupdate
  hook by itself disables SQLite's truncate optimisation, so `DELETE FROM t` reports every row
  (verified in `test/sqlite/hooks.test.ts`); in the update-hook fallback mode the authorizer
  answers `SQLITE_IGNORE` to `SQLITE_DELETE` to get the same effect. Buffered per transaction,
  published once with the txid after the record is durable. Cost ≈ 50 ns/row.
- **Live queries**: on subscribe, prepare the statement with the authorizer capturing every
  `SQLITE_READ (table, column)` → exact read-set, column-precise, no parsing. Each commit's
  write-set (tables, and changed columns when preupdate is on) is intersected with read-sets;
  affected queries re-run (coalesced per event-loop tick), result hashed with xxHash3; emit
  only if changed. Optional `key` column → server sends `{added, removed, updated}` diffs.
- A bounded per-tenant ring of recent change events (default 10 MB or 60 s) serves SSE
  `Last-Event-ID` reconnects; older than that → `event: reset`, client re-queries.
- Fan-out is `ws.subscribe(topic)` / `server.publish(topic)` — Bun's native pub/sub, zero JS
  per-subscriber work. Topic = `db:<name>:changes:<table>` and `db:<name>:live:<subId>`.

### 4.7 Isolation, cancellation and quotas per tenant (all native SQLite, nothing bolted on)

| concern | mechanism |
|---|---|
| runaway query | `progress_handler` with a deadline per request (`timeoutMs`), returns `interrupted` |
| storage quota | `PRAGMA max_page_count` per tenant |
| read-only tokens | `PRAGMA query_only` on the connection + authorizer denying writes |
| table/column ACL for browser tokens | authorizer: `SQLITE_DENY` or `SQLITE_IGNORE` (column reads become NULL) |
| SQL bombs | `sqlite3_limit` (length, expr depth, compound, variables), `maxRows` per response |
| noisy neighbour | per-tenant token bucket on writes; per-tenant `maxLiveQueries`, `maxSubscribers` |
| memory | `cache_size` per connection, `soft_heap_limit64` process-wide |
| cross-tenant access | authorizer denies `ATTACH`/`DETACH`; `PRAGMA` allow-list (`SQLITE_PRAGMA` action); `load_extension` off; `SQLITE_DBCONFIG_DEFENSIVE` on for non-admin tokens |

File descriptors: writer + 2 readers ≈ 7 fds per open tenant (shm fd is shared per inode), so
`maxOpen = 10000` needs `ulimit -n ≥ 80k`; the server checks and warns at start.

## 5. Topologies and consistency

### 5.1 Standalone (default)
One node, no peers. Still has: txid per database, local log, snapshots, PITR, S3 shipping.

### 5.2 Primary + replicas (static topology)
`bunql serve --replica-of wss://primary/v1/replication`. Replicas serve reads, forward writes to
the primary (transparent to clients), and stream every tenant or a configured subset.
Promotion is manual (`bunql promote`) or scripted; epoch increments and the old primary is
fenced on reconnect.

### 5.3 Cluster (rf ≥ 2, automatic failover) — phase 3
- Membership + placement + leases live in a small built-in Raft group (control plane only;
  a few KB of state, elections in TS over Bun WS — the data plane never waits on it).
- Each database has a lease holder (primary) and `rf-1` replicas chosen by consistent hashing
  with rack/zone awareness. Lease TTL 3 s, renewed every 1 s; a primary refuses writes without
  a valid lease; every TxnRecord carries the epoch; replicas reject stale epochs.
- Failover: lease expires → Raft leader picks the replica with the highest acked txid →
  new epoch → clients are redirected (`307` with `BunQL-Primary` header, or WS `moved` frame).
- Alternative adapters (`coordination: "etcd" | "postgres"`) are possible but not planned.

### 5.4 Consistency guarantees, stated plainly
- Per database: serializable on the primary (one writer, SQLite).
- Replicas: snapshot-consistent at some txid; never torn; lag is typically < 1 ms on LAN.
- **Read-your-writes**: every response carries `BunQL-Txid`. Send `BunQL-Min-Txid` (or SDK does
  it automatically) and a replica waits up to `waitMs` (default 2000) or forwards to primary.
- **Durability**: `ack: "local"` (default; `synchronous=NORMAL`: survives process crash, may
  lose the last txns on power loss until checkpoint) · `"fsync"` (`FULL` for that commit) ·
  `"replica"` (≥1 replica has fsynced the record) · `"quorum"`.
- Failover with `ack: "local"` can lose un-replicated txns (bounded by lag); with `"replica"`
  or `"quorum"` it cannot, because promotion picks the highest acked txid.

### 5.5 Multi-core
v1 is one thread. Scale-out is more processes/nodes with tenant placement. Planned option:
`workers: N` runs N `Bun.serve` instances (`reusePort`, verified to bind and load-balance on
Linux; macOS routes everything to one listener, so it is Linux-only) in Workers; any worker
serves reads for any tenant (WAL snapshot isolation); writes hop to the owning worker via
`postMessage` (~20 µs). Realtime fan-out crosses workers via `BroadcastChannel`.

## 6. HTTP API (JSON)

Base path `/v1`. Tenant addressing: path `/v1/db/{db}/...`. Optional host-based addressing
(`{db}.sql.example.com`) maps to the same routes for Turso/libsql-style clients.

Auth: `Authorization: Bearer <token>`. Tokens are Ed25519 (EdDSA) JWTs minted by the server
(`POST /v1/tokens`) using libsql's claim shape so the same token works through the Hrana
compat layer: `{ "p": { "ro": { "ns": ["acme"] }, "rw": { "ns": ["acme-*"] } }, "exp", "jti",
"kid" }`, extended with `"t": { "todos": "r", "users": "rw" }` for table ACLs. `jti` enables a
revocation list and `kid` key rotation (both missing in Turso). Admin API key from config for
lifecycle routes. Read-only tokens are safe to hand to browsers.

Common response headers: `BunQL-Txid` (last txid of the db as served), `BunQL-Node`,
`BunQL-Role: primary|replica`, `BunQL-Duration-Us`.

Common request options (body fields or headers): `ack`, `minTxid` (`BunQL-Min-Txid`),
`consistency: "primary"|"any"`, `timeoutMs`, `rows: "array"|"object"`, `maxRows`.

### 6.1 Query / execute

```http
POST /v1/db/acme/query
{ "sql": "select id, name from users where id > ?", "args": [10] }
```
```json
{
  "columns": ["id", "name"], "types": ["INTEGER", "TEXT"],
  "rows": [[11, "ann"], [12, "bob"]],
  "rowsAffected": 0, "lastInsertRowid": null,
  "txid": 4812, "durationUs": 31, "vmSteps": 12
}
```

`vmSteps` (from `sqlite3_stmt_status`) is the cost unit for quotas and billing; SQLite has no
native `rows_read` (libsql patched one in), and VM steps are the honest equivalent. Response
header `BunQL-Role` tells clients whether a replica served the read.

`args` positional array or named object (`{"id": 10}` binds `:id`/`@id`/`$id`).
Writes use the same endpoint; `rowsAffected`/`lastInsertRowid` populate and `txid` advances.

Value encoding (the only place JSON needs help): text → string, REAL → number, INTEGER → number
when |v| ≤ 2^53, otherwise `{"$i": "9007199254740993"}`; BLOB → `{"$b": "<base64>"}`;
NULL → null. Only exotic values are tagged, so ordinary rows are plain JSON.

### 6.2 Batch

```http
POST /v1/db/acme/batch
{ "atomic": true, "statements": [ { "sql": "insert into users(name) values (?)", "args": ["ann"] },
                                   { "sql": "select last_insert_rowid()" } ] }
```
→ `{ "results": [ {...}, {...} ], "txid": 4813 }`. `atomic: true` (default) is one write
transaction; any failure rolls back and returns `{ "error": {...}, "failedIndex": 1 }`.

### 6.3 Transactions over HTTP (baton) — allowed but leashed

```http
POST /v1/db/acme/tx            { "mode": "immediate" }        → { "tx": "b7f3…", "expiresInMs": 5000 }
POST /v1/db/acme/tx/b7f3…      { "sql": "...", "args": [] }   → normal query result
POST /v1/db/acme/tx/b7f3…/commit | /rollback
```
An open write tx holds the tenant's single writer, so the server enforces `txIdleTimeoutMs`
(default 5 s) and `maxOpenTx` per tenant. Prefer `batch` or WS transactions.

### 6.4 Realtime over SSE

```http
GET /v1/db/acme/changes?tables=users,orders&since=4800&include=row
```
```
id: 4813
event: change
data: {"txid":4813,"changes":[{"table":"users","op":"insert","rowid":13,"row":{"id":13,"name":"cy"}},
                              {"table":"orders","op":"delete","rowid":7,"pk":{"id":7}}]}

: ping                       ← every 15 s
event: reset                 ← ring buffer can't serve `since`; client must re-query
```
`Last-Event-ID` works as `since`. Headers: `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`; never compressed. `EventSource`
cannot set headers, so SSE routes also accept `?token=` (scoped read tokens only). Bun's
`idleTimeout` is capped at 255 s, so every SSE response calls `server.timeout(req, 0)` and keeps
its own 15 s `: ping`. Bun.serve is HTTP/1.1 (no h2 server); SSE and WS are unaffected.

Same feed without SSE, ElectricSQL-style long-poll for HTTP-only clients and CDNs:
`GET /v1/db/acme/changes?since=4800&wait=30000` returns a JSON array of the same `change` objects
plus `BunQL-Txid`; responses for a `since` in the past are immutable and cacheable, only the
live tail waits. `since` older than the ring returns `409 RESET_REQUIRED`.

```http
GET /v1/db/acme/live?sql=select+*+from+todos+where+done=0&args=[]&key=id
```
```
event: rows      data: {"txid":4813,"columns":[...],"rows":[...]}          ← initial and on change
event: diff      data: {"txid":4820,"added":[...],"removed":[[7]],"updated":[...]}   ← when key= given
```

### 6.5 Database lifecycle and admin

| method & path | purpose |
|---|---|
| `POST /v1/db` `{name, from?: {db, at?: txid\|timestamp}, pageSize?, quotaBytes?}` | create, or fork (O(1) reflink) |
| `GET /v1/db` · `GET /v1/db/{db}` | list · stats: sizeBytes, txid, walBytes, replicas + lag, openConns, liveQueries |
| `DELETE /v1/db/{db}` | delete (log + snapshots retained per `retention`) |
| `POST /v1/db/{db}/snapshot` | force snapshot; returns `{snapshotId, txid}` |
| `POST /v1/db/{db}/restore` `{at, into?}` | PITR from local log or S3 |
| `GET /v1/db/{db}/dump` · `POST /v1/db/{db}/import` | stream the SQLite file out / in |
| `POST /v1/db/{db}/checkpoint` `{mode}` | manual checkpoint |
| `POST /v1/tokens` `{dbs, scope, tables?, ttl}` | mint scoped JWT |
| `GET /v1/db/{db}/replication` | txid, epoch, per-replica acked txid, S3 position |
| `POST /v1/db/{db}/promote` | static-topology failover |
| `GET /healthz` · `/readyz` · `/metrics` | liveness · replication caught-up · Prometheus |

### 6.6 Errors

```json
{ "error": { "code": "SQLITE_CONSTRAINT_UNIQUE", "message": "UNIQUE constraint failed: users.email",
             "status": 409, "txid": 4813 } }
```
HTTP status maps: 400 SQL/parse errors, 401/403 auth, 404 unknown db, 409 constraint,
408 timeout (`QUERY_TIMEOUT`), 425 `TXID_NOT_AVAILABLE` (replica couldn't reach `minTxid`),
503 `NOT_PRIMARY` with `BunQL-Primary` header, 507 `QUOTA_EXCEEDED`.

### 6.7 Compatibility surface: Hrana (libsql wire protocol)

`@libsql/client` POSTs `v2/pipeline` relative to its base URL without probing, and Drizzle and
Kysely only ever call `execute`, `batch` (conditional steps), `transaction`, `executeMultiple`.
So the compat layer is: `GET /v2`, `POST /v2/pipeline`, `GET /v3`, `POST /v3/pipeline` with
`execute`, `batch` (+ `condition`), `sequence`, `describe`, `store_sql`/`close_sql`, `close`, and
signed batons; plus the WebSocket sub-protocols `hrana3`, `hrana2` (JSON frames) with
`hello`/`open_stream`/`execute`/`batch`/`close_stream`. Mounted twice: under
`/v1/db/{db}/…` and at the root, where the tenant comes from the `x-namespace` header or the
first `Host` label (exactly libsql-server's rule), so `libsql://{db}.sql.example.com` works.
Hrana's string-encoded `replication_index` is our `txid`; `last_insert_rowid` is a string;
integers are `{"type":"integer","value":"42"}`. Cheap, buys the whole libsql/Turso client
ecosystem on day one.

## 7. WebSocket protocol (`/v1/ws`, sub-protocol `bunql.v1`)

One socket, many databases, pipelined, JSON text frames (binary is reserved for replication).
Auth via `Authorization` header, `?token=`, or a first `{"op":"hello","token":"…"}` message
(browsers cannot set WS headers). Every client message carries `id`; every reply echoes it;
server-initiated messages carry `sub`. Requests for one `db` are processed in order; different
dbs may interleave.

```jsonc
→ {"id":1,"op":"query","db":"acme","sql":"select * from users where id=?","args":[1]}
← {"id":1,"ok":true,"result":{"columns":[...],"rows":[...],"txid":4813}}

→ {"id":2,"op":"batch","db":"acme","atomic":true,"statements":[...]}
→ {"id":3,"op":"tx.begin","db":"acme","mode":"immediate"}         ← {"id":3,"ok":true,"tx":"t1"}
→ {"id":4,"op":"query","tx":"t1","sql":"..."}                     ← ...
→ {"id":5,"op":"tx.commit","tx":"t1"}                             ← {"id":5,"ok":true,"txid":4814}

→ {"id":6,"op":"subscribe","db":"acme","kind":"changes","tables":["users"],"since":4800}
← {"id":6,"ok":true,"sub":"s1"}
← {"sub":"s1","event":"change","data":{"txid":4813,"changes":[...]}}
→ {"id":7,"op":"subscribe","db":"acme","kind":"live","sql":"select ...","args":[],"key":"id"}
← {"sub":"s2","event":"rows","data":{...}}   ← {"sub":"s2","event":"diff","data":{...}}
→ {"id":8,"op":"unsubscribe","sub":"s2"}

← {"id":9,"ok":false,"error":{"code":"...","message":"..."}}
← {"event":"moved","db":"acme","primary":"wss://node-b/v1/ws"}     ← after failover
```
Ping/pong: protocol-level every 20 s; server closes after 2 missed. Backpressure: the server
drops live-query intermediate results (keeps latest) when `ws.send` reports backpressure; change
feeds never drop — they pause and resume from the ring buffer, or send `reset`.

## 8. Replication protocol (`/v1/replication`, binary frames)

Node-to-node only. Auth: cluster secret (HMAC handshake) or mTLS. Frame = `type u8 | len u32 |
body`. Bodies are TxnRecords or small CBOR-free fixed structs.

| frame | direction | body |
|---|---|---|
| `HELLO` | both | nodeId, protoVersion, capabilities |
| `SUBSCRIBE` | replica→primary | db, fromTxid, epoch |
| `SNAPSHOT_BEGIN/CHUNK/END` | primary→replica | db, txid, sizeBytes, zstd chunks, xxh3 |
| `TXN` | primary→replica | TxnRecord (§4.3) |
| `ACK` | replica→primary | db, txid, fsynced=true |
| `FORWARD` / `RESULT` | replica→primary | forwarded write (JSON body from §6) and its result |
| `LEASE` | control | db, epoch, holder, expiresAt (cluster mode) |
| `HEARTBEAT` | both | node's max txid per subscribed db (drives lag metrics) |

## 9. Library surfaces (TypeScript)

### 9.1 Client (`bunql/client`) — runs in browsers, Bun, Node, Workers

Modelled on `Bun.SQL` (which has had a SQLite adapter since Bun 1.3) so the tagged-template
shape, `.values()`, `.raw()`, `sql.unsafe()`, `sql.begin()` and the result array's `.count`,
`.command`, `.lastInsertRowid`, `.affectedRows` are already familiar; we add `.txid`.

```ts
import { createClient } from "bunql/client"

const client = createClient({ url: "https://sql.example.com", token, consistency: "ryw" })
const db = client.db("acme")

const users = await db.sql<User>`select * from users where id > ${10}`        // objects
const rows  = await db.sql`select id from users`.values()                       // arrays
const one   = await db.sql<User>`select * from users where id = ${id}`.first()
const res   = await db.execute("insert into users(name) values (?)", ["ann"], { ack: "replica" })
             // res.txid, res.lastInsertRowid, res.rowsAffected
const many  = await db.batch([db.stmt`insert ...`, db.stmt`update ...`])
await db.transaction(async tx => { await tx.sql`...`; await tx.sql`...` })     // WS if open, else baton

const feed = db.changes({ tables: ["todos"] })              // AsyncIterable + .on("change")
for await (const ev of feed) render(ev)
const live = db.live<Todo>`select * from todos where done = 0`.key("id")
live.on("rows", rows => ...); live.on("diff", d => ...); live.close()

client.txid("acme")   // last observed txid; sent as BunQL-Min-Txid automatically
```

`consistency: "ryw"` (default) tracks txid per db in the client; `"primary"` forces primary;
`"any"` accepts any replica state. The client uses HTTP for one-shots and lazily opens the WS
for subscriptions and transactions.

### 9.2 Embedded (`bunql`) — in-process on Bun, same interface plus a sync escape hatch

```ts
import { BunQL } from "bunql"

const bq = await BunQL.open({ dir: "./data", s3: { bucket: "backups" } })
const db = bq.db("acme")                            // implements the same Db interface as the client
await db.sql`select 1`                              // resolves synchronously under the hood
db.sync.sql`select 1`.all()                         // zero-overhead path for hot loops
db.sync.transaction(() => { ... })
bq.on("commit", ({ db, txid }) => ...)

bq.serve({ port: 4321, hrana: true })               // expose the same engine over HTTP/WS/SSE
```

Adapters shipped: `bunql/kysely` (Dialect), `bunql/drizzle` (via Hrana or native). Both work
against the client and the embedded `Db`.

### 9.3 CLI

```
bunql serve [--dir ./data] [--port 4321] [--replica-of wss://…] [--config bunql.toml]
bunql db create|list|stat|delete|fork <name> [--from <db>[@txid|@time]]
bunql snapshot <db> · bunql restore <db> --at <txid|time> [--into <name>]
bunql token --db acme --scope ro --ttl 30d [--tables 'todos:r,users:rw']
bunql shell <db>          (REPL over WS)
bunql promote <db>        (static topology)
bunql cluster status|join|leave
```

### 9.4 Config (`bunql.toml`, parsed with `Bun.TOML`; every key has an env override)

```toml
[server]  port = 4321  host = "0.0.0.0"  hrana = true  tenantFromHost = false
[data]    dir = "./data"  maxOpen = 1024  readers = 2  pageSize = 4096
[durability] defaultAck = "local"  checkpointWalBytes = 4_000_000  retention = "7d"
[realtime] ringBytes = 10_000_000  maxLiveQueries = 1000  maxRowsPerLive = 1000
[limits]  queryTimeoutMs = 10_000  writeTimeoutMs = 30_000  txIdleTimeoutMs = 5_000  maxRows = 10_000
[s3]      bucket = "backups"  endpoint = "https://…"  prefix = "bunql/"  shipIntervalMs = 1000
[replication] role = "primary"        # or "replica"; primary = "wss://…"
[cluster] enabled = false  rf = 2  peers = ["…"]  leaseTtlMs = 3000
[auth]    adminKey = "${BUNQL_ADMIN_KEY}"  jwtKey = "${BUNQL_JWT_ED25519}"
```

## 10. Performance budget (targets, single node, M-series / modern x86)

| path | target |
|---|---|
| point read over HTTP keep-alive | ≤ 60 µs p50 |
| point read over WS | ≤ 35 µs p50 |
| single-row write, `ack: local`, incl. tail+log | ≤ 40 µs p50 |
| write visible on LAN replica | ≤ 1 ms p50 |
| live-query invalidation → event on socket | ≤ 200 µs p50 |
| tenants open per process | 10k (fd-bound; 3 fds each) |
| throughput, mixed 90/10, one core | ≥ 50k req/s HTTP, ≥ 150k msg/s WS |

## 11. Phases

| phase | scope | proves |
|---|---|---|
| 0 (2 wks) | FFI driver + engine, registry, HTTP/WS/SSE, JSON codec, tokens, WAL tailer + log + snapshots + PITR (local), changes + live queries, CLI `serve/db/token`, embedded API | standalone product usable end to end |
| 1 (2 wks) | replica streaming, bootstrap, forwarding, `ack` levels, RYW, S3 shipper/restore, Hrana compat, client SDK + Kysely/Drizzle, fork | primary/replica in production shape |
| 2 (2 wks) | cluster: Raft control plane, placement, leases, failover, `moved`; `workers: N` | HA |
| 3 | WAL-decoded logical CDC (row events on replicas without hooks), snapshot reads across requests (`sqlite3_snapshot`), per-tenant encryption at rest, query-plan cache | frontier extras |

Tests: WAL codec property tests against SQLite's own files; a deterministic replication
simulator (fault injection: dropped frames, restarts, stale epochs); Jepsen-style linearizability
check on `ack: quorum`; `experiments/` kept as benchmarks.

## 12. Prior art and what BunQL borrows

| system | mechanism | what we take | what we leave |
|---|---|---|---|
| LiteFS (fly.io) | FUSE intercepts WAL writes; replicas get pages written into the DB file + shm header rewrite under all WAL locks; TXID + post-apply checksum position; `__txid` cookie for read-your-writes; HALT lock for write forwarding | replica page apply (§4.5 A), rolling checksum + `(txid, checksum)` position, RYW via txid | FUSE (Bun owns the write path, no interception needed), Consul leases |
| Litestream v0.5 | tails the `-wal` file, LTX records, S3 shipping, hourly/daily compaction levels, VFS read replicas, long-lived read txn to block WAL resets | WAL tailing rules (commit-frame boundary, salt change = reset), snapshot + segment retention to S3 | the read-lock hack (we own checkpoints), directory-mode sidecar deployment |
| Cloudflare D1 / SQLite-backed Durable Objects | VFS hooks stream WAL to a relay; commit confirmed by 3 of 5 followers; 30-day PITR via bookmarks; sessions API with opaque bookmarks; output gates hold responses until durable | `ack: quorum` semantics, "publish realtime only after durable", bookmark-style RYW, PITR by replaying log onto snapshot | opaque bookmarks (ours is a plain integer) |
| libsql / Turso | Hrana pipeline + WS protocol, namespaces for multi-tenancy (`x-namespace` / Host label), EdDSA JWT claims, embedded replicas pulling WAL frames, `replication_index` on results, `/beta/listen` per-table change counts | the whole Hrana compat layer, tenant routing rule, JWT claim shape | Rust server, forked SQLite engine, sync engine |
| rqlite | Raft with statement replication; transparent write forwarding; `?level=` read consistency; `X-RQLITE-SERVED-BY` | forwarding to primary as the default, served-by headers | statement-based replication (non-determinism, DDL edge cases), Raft on the data path |
| dqlite | Raft replication of WAL frames via a custom VFS | confirms frame-level replication is the right unit | C library, one DB per Raft group |
| Marmot / cr-sqlite / Corrosion | trigger-CDC over NATS; CRDT columns; gossip | nothing in v1 (single writer is a feature) | multi-master |
| ElectricSQL | HTTP shape log with `offset`/`handle`/`live`, `up-to-date` and `must-refetch` controls, CDN-cacheable history | long-poll changes endpoint (§6.4), `reset` control | Postgres-specific value encoding |
| Convex / Zero | versioned query sets, requery on invalidation, pokes | live queries as requery-on-invalidation with result hashing | custom query language |
| PowerSync | bucket oplog with checksums | bucket checksums as a future integrity check for client-side sync | its client-side sync engine |
| Graft (Rust VFS), ayb, sqliteproxy | page-level lazy replication; multi-tenant HTTP servers in Rust | evidence that no Bun-native replicated multi-tenant SQLite server exists yet | — |

Sources verified by the research pass: sqlite.org `fileformat2`, `walformat`, `wal`, `pragma`,
`c3ref`, `rsync`, `sessionintro`; `wal.c`/`pager.c`/`os_unix.c` on GitHub; LiteFS `db.go`,
`store.go`, ARCHITECTURE.md and the `ltx` README; Litestream `db.go`, `wal_reader.go`, `vfs.go`
and the v0.5 posts; Cloudflare "SQLite in Durable Objects" and D1 read-replication docs; libsql
`HRANA_3_SPEC.md`, `libsql-server` route and auth sources, `@libsql/client` `api.ts`; rqlite
API docs and `http/service.go`; Turso platform API docs; Electric `electric-api.yaml`; Bun docs
and `bun-types` for 1.4.0. The broader replication survey agent was cut off by the account
usage limit before delivering; the table above is compiled from the other three reports plus
first-hand checks.

## 13. Decisions I want from you (API-shaped, in priority order)

1. **Driver**: own `bun:ffi` driver over vendored libsqlite3 (recommended, §4.1) vs bun:sqlite + shim.
2. **Tenant addressing**: `/v1/db/{db}/…` only, or also host-based `{db}.host`?
3. **Value encoding**: "tag only exotic values" (`{"$i"}`, `{"$b"}`) vs Hrana-style typed values everywhere. (Every surveyed API that uses bare JSON numbers — rqlite, D1 — silently loses int64 precision; Hrana tags everything and is verbose. Exotic-only tagging keeps 99% of rows plain and loses nothing.)
4. **Rows default**: arrays + `columns` (compact; recommended) vs objects.
5. **HTTP baton transactions**: keep with 5 s leash, or WS-only?
6. **Hrana compat in phase 1**: yes (recommended) / later.
7. **Client SDK style**: `Bun.SQL`-like tagged template as the primary surface (recommended) vs `execute(sql, args)` first.
8. **Naming**: `txid` (recommended) vs `version` vs `bookmark`; `ack` vs `durability`.
9. **Default `ack`**: `local` (fast) vs `replica` when replicas exist.
10. **Multi-db WebSocket** (one socket, many dbs): yes (recommended) / one socket per db.
11. **Cluster control plane**: built-in Raft (recommended, phase 2) vs external (etcd/Postgres) vs static topology only.
