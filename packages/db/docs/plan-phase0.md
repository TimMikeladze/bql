# Phase 0 implementation plan — standalone bql.sh

Companion to `design.md`. This is the build order, module boundaries, and acceptance tests for
the standalone product. Every milestone ends with `bun test` green, `bun run typecheck` green,
and a runnable demo.

## Decisions adopted for phase 0 (from design.md §12, recommended defaults)

| # | decision | choice |
|---|---|---|
| 1 | driver | own `bun:ffi` driver (`src/sqlite/`) over a shared libsqlite3; feature-detect `PRAGMA compile_options`; library path from `BQL_SQLITE_LIB`, else autodetect (`/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`, `/usr/local/opt/sqlite/lib/libsqlite3.dylib`, `libsqlite3.so.0`, `/usr/lib/*/libsqlite3.so.0`). Vendored prebuilt libs are a phase-1 packaging task. |
| 2 | tenant addressing | `/v1/db/{db}/…`; `server.tenantFromHost` optional |
| 3 | value encoding | plain JSON; only exotic values tagged: `{"$i":"…"}` for unsafe ints, `{"$b":"base64"}` for blobs, `{"$f":"inf"|"-inf"}` |
| 4 | rows default | arrays + `columns`; `rows: "object"` per request |
| 5 | HTTP baton tx | yes, `txIdleTimeoutMs` 5000 |
| 6 | Hrana compat | phase 1 |
| 7 | SDK | Bun.SQL-shaped tagged template |
| 8 | names | `txid`, `ack` |
| 9 | default ack | `local` |
| 10 | WS | one socket, many dbs |
| 11 | cluster | phase 2 |

## Repository layout

```
package.json            name "bql", type module, bin: bql, exports: ".", "./client", "./sqlite", "./kysely"
tsconfig.json           strict, moduleResolution bundler, types bun-types
src/
  sqlite/               FFI driver (no bun:sqlite import anywhere in src/)
    lib.ts              dlopen + symbol table + feature detection
    database.ts         Database: open/close/exec/prepare/transaction/hooks/authorizer/deadline/limit/fileControl
    statement.ts        Statement: bind/step/get/all/values/run/iterate/columns; per-connection prepared cache
    values.ts           JS<->SQLite value conversion (bigint safety, blobs, text decode fast path)
    errors.ts           SqliteError with extended result code names
  wal/
    codec.ts            WAL header/frame parse+encode, checksum chain, salts
    tailer.ts           reads -wal from last commit frame, emits TxnRecord
    record.ts           TxnRecord encode/decode (zstd), xxh3 checksums, rolling db checksum
    log.ts              segment files, index, retention, iterate(fromTxid)
    applier.ts          mechanism B (WAL append + shm invalidate); interface allows A later
    snapshot.ts         reflink/stream snapshot at txid; restore(at)
  tenant/
    registry.ts         LRU of open tenants, open/close, per-tenant connections, quotas
    tenant.ts           owner: write path (BEGIN IMMEDIATE…COMMIT → tail → log → publish), checkpoint policy
    catalog.ts          data/_system.db: tenants, tokens, positions
  realtime/
    capture.ts          preupdate/update hook → per-txn change buffer
    readset.ts          authorizer-derived read-set for a statement
    live.ts             live query registry, invalidation, coalesced re-run, diff by key
    ring.ts             bounded ring of change events for SSE resume
  server/
    app.ts              Bun.serve routes + websocket + fetch fallback
    json.ts             request parsing, value encoding, error mapping
    auth.ts             Ed25519 JWT mint/verify, admin key, scope → connection setup (query_only, authorizer ACL)
    routes/query.ts batch.ts tx.ts admin.ts changes.ts live.ts ws.ts health.ts
  client/
    index.ts            createClient, Db (sql tagged template, execute, batch, transaction, changes, live)
    protocol.ts         shared request/response types with server
  embedded.ts           Bql.open(), bq.db(name) implementing Db (async + .sync), bq.serve()
  cli.ts                bql serve|db|snapshot|restore|token|shell
test/                   bun test; fixtures create temp dirs under os.tmpdir()
experiments/            kept as benchmarks (already present)
docs/                   design.md, plan-phase0.md, api.md (generated from server routes when stable)
```

## Milestones

### M1 — scaffold (½ day)
`bun init`-equivalent by hand: package.json scripts `test`, `typecheck` (`tsc --noEmit`), `bench`,
`dev` (`bun run src/cli.ts serve --dir ./data`); `bun-types`; biome or none (keep none). CI-free
for now. README with the two-command quickstart.

### M2 — FFI driver `src/sqlite` (2 days)
- `lib.ts`: dlopen symbols listed in `experiments/ffibench.ts` plus hooks/authorizer/progress/
  limit/file_control/wal_checkpoint_v2/backup/session/snapshot (when present). Feature flags from
  `PRAGMA compile_options` and symbol presence.
- Value path: `column_type` switch; TEXT via `column_text`+`column_bytes` → `TextDecoder`
  (latin1 fast path when all bytes < 0x80); INTEGER via `column_int64` returning bigint only when
  outside safe range (`safeIntegers` option forces bigint); BLOB → `Uint8Array` copy.
- Bind: number/bigint/string/Uint8Array/null/boolean; named params by `bind_parameter_index`.
- Prepared statement cache per connection (LRU 64, `SQLITE_PREPARE_PERSISTENT`).
- Hooks: `onUpdate`, `onPreupdate` (with `preupdate_old/new` accessors), `onCommit`, `onRollback`,
  `onWal`; `authorizer(cb)`; `deadline(ms)` via `progress_handler` (n=1000 ops) checking
  `performance.now()`; `limit(name, n)`; `busyTimeout(ms)`.
- Errors: extended result codes → `SqliteError { code: "SQLITE_CONSTRAINT_UNIQUE", message }`.
- Tests: parity suite against bun:sqlite on the same file (results equal for a matrix of types),
  hooks fire, deadline interrupts, authorizer denies, bigint round-trip, `WITHOUT ROWID` preupdate.
- Bench: `bench/driver.ts` must show ≤ 1.2 µs point read.

### M3 — WAL shipping core `src/wal` (3 days)
- Port `experiments/walproto.ts` into `codec.ts`/`tailer.ts`/`applier.ts` with the commit-frame
  rule (position advances only at commit frames; re-verify chain from last commit each poll).
- `record.ts`: layout from design §4.3; zstd level 3; xxh3; rolling checksum with `pgno→hash`
  map of the live WAL + `pread` fallback.
- `log.ts`: `data/dbs/<hh>/<name>/log/<startTxid>.seg`, in-memory index `txid→(seg, offset)`,
  `append`, `iterate(fromTxid)`, `retention`.
- `snapshot.ts`: `TRUNCATE` checkpoint → reflink to `snapshots/<txid>.db` (new path) → falls back
  to streamed copy with checkpoints paused. `restore(at)`: pick snapshot ≤ at, apply records ≤ at
  via applier into a fresh dir.
- Tests: property test — random workloads on a primary, replay log into replica, compare
  `PRAGMA integrity_check` + full table dumps; WAL reset mid-stream; crash reconcile (truncate
  log / delete last record and reopen); PITR to a middle txid.

### M4 — tenants `src/tenant` (2 days)
- Registry with LRU, fd budget check, per-tenant open: pragmas, limits, `max_page_count` quota.
- Tenant write path exactly as design §4.3 steps 1–6 (without replicas: `ack: local|fsync`).
- Checkpoint policy as designed; catalog `_system.db` via the same driver.
- Tests: 2k tenants opened/evicted, quota exceeded → `QUOTA_EXCEEDED`, txid monotonic across
  reopen, checkpoint never loses unlogged frames.

### M5 — HTTP/WS/SSE server `src/server` (3 days)
- Routes and payloads exactly as design §6 and §7. JSON codec with exotic tagging. Errors §6.6.
- Auth: admin key; Ed25519 JWT via WebCrypto (`crypto.subtle` Ed25519 in Bun); `scope: ro` →
  `query_only` + authorizer; `tables` ACL → authorizer table/column rules.
- SSE with `server.timeout(req, 0)` and pings; WS with pipelining, subscriptions, `tx.*`.
- Tests: route-level tests with `fetch` against `Bun.serve({port: 0})`; WS protocol tests;
  auth matrix; timeouts; 425 on `minTxid` ahead (single node: waits then 425).

### M6 — realtime `src/realtime` (2 days)
- Capture via preupdate hook (fallback update hook), read-set via authorizer, live registry,
  invalidation by table ∩ (columns when known), coalesced re-run per tick, xxh3 result hash,
  diff by `key`. Ring buffer for `since`/`Last-Event-ID`; `reset` event.
- Tests: change feed ordering and txid stamping; live query fires only for affected tables;
  `DELETE FROM t` reports every row (authorizer `SQLITE_IGNORE` trick); 1k subscriptions cost
  per commit < 2 ms.

### M7 — client, embedded, CLI (2 days)
- `src/client` per design §9.1 (fetch + lazy WS; `consistency: "ryw"` txid tracking).
- `src/embedded.ts` per §9.2; `bq.serve()` mounts the same app.
- `src/cli.ts`: `serve`, `db create|list|stat|delete|fork`, `snapshot`, `restore`, `token`, `shell`.
- Tests: client against a live server (all verbs, subscriptions), embedded sync/async parity.

### M8 — end-to-end + docs (1 day)
- `test/e2e/`: start server, create 3 dbs, writes + live queries + SSE + PITR restore, run the
  `experiments/` benches as smoke tests with thresholds.
- `README.md`: quickstart, API summary linking `docs/design.md`.

## Conventions for the implementing agents

- Bun only. No Node polyfills. `bun test`. No external deps except `@types` if needed; JWT,
  zstd, hashing, S3 all via Bun builtins. Kysely/Drizzle adapters are phase 1.
- Every module has a short header comment stating its invariant (e.g. tailer: "position moves only
  at commit frames").
- Never import `bun:sqlite` in `src/`; it is allowed in tests for parity checks.
- Keep `docs/design.md` in sync when an API detail changes; update `docs/api.md` (M8).
- Performance gates live in `bench/` and are run in M8.
