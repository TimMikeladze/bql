# M5b — HTTP, WebSocket and SSE server (`src/server/`)

Companion to `design.md` §6 and §7 and `plan-phase0.md` M5. The route table as implemented, the
decisions the design left open, and every deviation.

## Module map

| file | invariant |
|---|---|
| `config.ts` | every knob has a default, a TOML key and a `BUNQL_*` override, in that order; a generated secret is persisted once and printed once |
| `metrics.ts` | per-process counters only — nothing keyed by database, so cardinality is bounded |
| `runtime.ts` | one `AuthorizerHub` per connection and one `TenantRealtime` per open tenant, both created from the tenant's `onConnection` seam and torn down with it |
| `exec.ts` | no statement steps until a signed policy is on its connection, a deadline is armed, and a row cap is known |
| `sse.ts` | an SSE response never relies on Bun's idle timeout; it opts out and owns its own ping |
| `routes.ts` | the principal is resolved before the tenant, and the tenant before the body |
| `ws.ts` | requests naming one database are answered in order; different databases interleave |
| `app.ts` | every response leaves through one wrapper, so the four `BunQL-*` headers, CORS, error mapping and the metrics tick happen in exactly one place |
| `main.ts` | config → `startServer` → print the URL |

## Route table (as implemented)

| method & path | auth | notes |
|---|---|---|
| `POST /v1/db/:db/query` | `ro`; `rw` once the statement turns out to write | `{sql, args?, rows?, maxRows?, timeoutMs?, ack?, minTxid?, consistency?}` |
| `POST /v1/db/:db/batch` | same | `atomic` default true → one `tenant.write`; `failedIndex` names the failure |
| `POST /v1/db/:db/tx` | `rw` | `{mode}` → `{tx, expiresInMs}`; one open transaction per database, others get 409 `TX_BUSY` with `Retry-After: 1` |
| `POST /v1/db/:db/tx/:tx` | `rw` | one statement inside the baton transaction |
| `POST /v1/db/:db/tx/:tx/commit` · `/rollback` | `rw` | `{txid}` |
| `GET /v1/db/:db/changes` | `ro` | SSE unless `wait` is given, then the JSON long poll of §6.4 |
| `GET /v1/db/:db/live` | `ro` | SSE; `sql`, `args` (JSON), `key`, `rows`, `maxRows` |
| `POST /v1/db` | admin | `{name, from?: {db, at?}, pageSize?, quotaBytes?}` → 201 with the new database's stats |
| `GET /v1/db` | admin | every live database |
| `GET /v1/db/:db` | `ro` | stats: `sizeBytes`, `walBytes`, `logBytes`, `txid`, `epoch`, `checksum`, `openConns`, `liveQueries`, `subscribers`, `lastSnapshotTxid`, `replicas: []` |
| `DELETE /v1/db/:db` | admin | moves the directory to `trash/`, tombstones the catalog row |
| `POST /v1/db/:db/snapshot` | admin | `{snapshotId, txid, bytes, checksum, createdAtMs}` |
| `POST /v1/db/:db/restore` | admin | `{at, into?}` — always rebuilds into a **new** database (below) |
| `GET /v1/db/:db/dump` | admin | snapshots, then streams the file as `application/vnd.sqlite3` |
| `POST /v1/db/:db/import` | admin | raw SQLite file body → a new database named `:db` |
| `POST /v1/db/:db/checkpoint` | admin | `{mode}` → the `wal_checkpoint_v2` counters plus `walBytes` |
| `GET /v1/db/:db/replication` | `ro` | `{txid, epoch, checksum, lastSnapshot, role, replicas: []}` |
| `POST /v1/tokens` | admin | `{dbs \| db, scope, tables?, ttl \| ttlMs, sub?}` → `{token, jti, exp}` |
| `DELETE /v1/tokens/:jti` | admin | revokes through the catalog, which is the authenticator's revocation list |
| `GET /v1/ws` | any | WebSocket upgrade, sub-protocol `bunql.v1` |
| `GET /healthz` · `/readyz` | none | liveness · readiness |
| `GET /metrics` | admin when an admin key exists | Prometheus text 0.0.4 |

Every response carries `BunQL-Txid`, `BunQL-Node`, `BunQL-Role: primary` and `BunQL-Duration-Us`.
`OPTIONS` on any route is a CORS preflight while `server.cors` is on. An unknown path is a 404 in
the error shape of §6.6.

## Decisions

1. **Statement classification is `sqlite3_stmt_readonly`, not a regular expression.** Every
   statement is prepared on a pooled reader first. Read-only ones run there; anything else is
   re-prepared on the writer inside `tenant.write`. The second prepare is a cached
   `sqlite3_prepare_v3` on a path that already costs 27 µs, and it means a `WITH … INSERT`, a
   `RETURNING` clause and a pragma are all classified by SQLite rather than by a guess.

2. **Readers are pinned `query_only`, the writer is pinned off.** The `onConnection` seam sets the
   pragma once, when the connection is opened, and `applyPolicy` remembers it. The request path
   therefore costs one `sqlite3_set_authorizer` and no pragma at all — and a bug in classification
   still cannot write through a reader.

3. **The policy is memoised per connection.** Two consecutive requests with the same scope, ACL
   and database on the same pooled connection skip the authorizer cycle entirely, which also means
   they skip the prepared-statement expiry that cycle causes. `release()` clears the memo, so the
   writer (which does release, to leave checkpoints and capture unfiltered) always re-arms.

4. **A pooled reader keeps the last request's authorizer.** Nothing releases a reader's policy:
   the next borrower re-scopes it. That is what makes re-scoping free, and it is only safe while
   every borrow goes through `ServerRuntime.withReader`, which is stated as an invariant there.

5. **`maxRows` fails the request rather than truncating it.** A one-shot query that hits the cap
   is `400 TOO_MANY_ROWS`; a live query truncates and sets `truncated` (M6's rule). The cap is
   checked after `values()` materialises the result, so the deadline and the per-connection
   `sqlite3_limit` set are what bound the work before that point.

6. **`lastInsertRowid` is read either side of the step.** `sqlite3_last_insert_rowid` belongs to
   the connection, not the statement, so an `UPDATE` on a pooled connection would otherwise report
   the rowid of somebody else's earlier `INSERT`. Comparing before and after makes the field
   describe the statement that was asked for; an insert that reuses a rowid it just deleted
   reports null, which is a value the client supplied anyway.

7. **`ack: "replica"` and `"quorum"` are a 400, not a silent downgrade.** Phase 0 has no replicas,
   and answering "durable on a replica" when there is none would be a lie the client cannot detect.

8. **Interactive transactions are new `Tenant` methods**, not a `tenant.write` held open around a
   promise: `write()` is synchronous. `txBegin/txExec/txCommit/txRollback` take the writer with
   `BEGIN IMMEDIATE`, run statements across requests, and commit through the same post-commit path
   `write()` uses (tail → append → save → publish → checkpoint). A tenant with an open transaction
   reports `busy`, so the LRU will not evict it, and `write()` refuses with `TX_BUSY`.

9. **Batons are 128 random bits and one per database.** A second transaction is refused with 409
   and `Retry-After: 1` rather than queued: the writer is the scarce thing, and a queue lets one
   stalled client hold everybody else's latency. The idle timer lives on the `Tenant` next to the
   state it protects and calls back into the route layer to drop the baton.

10. **Every WebSocket subscription id is the topic it came from** — `db:acme:changes`,
   `db:acme:changes:users`, `db:acme:live:s1`. That is what lets change fan-out go through
   `ws.subscribe` / `server.publish`: the published frame
   `{"sub":"db:acme:changes:users","event":"change","data":{…}}` is the same bytes for every
   subscriber, so Bun fans it out without entering JavaScript per socket. Per-socket ids would
   have made every payload different and the pub/sub useless.

11. **The publisher builds the envelope by concatenation.** `RealtimeBus` hands the publisher the
    payload as JSON text; `busPublisher` wraps it in the envelope as a string rather than parsing
    it back into an object. Live topics are skipped there, because live results are
    per-subscription and go out with `ws.send`.

12. **Live results are dropped under backpressure; change events never are.** `ws.send` returning
    `≤ 0` puts the latest live frame in a per-socket map that `drain` flushes, so a client that is
    behind gets the newest result rather than a queue of stale ones. Change events go through
    Bun's pub/sub, where Bun owns the buffering.

13. **A tenant with a subscriber is pinned in the registry.** The capture hooks live on the
    writer connection, so an LRU eviction would end the feed silently. `TenantRegistry.pin/unpin`
    was added for this; the eviction sweep skips pinned names the same way it skips busy ones.

14. **The realtime engine outlives its last subscriber by `realtime.idleRetainMs` (15 s).** The
    ring is what serves a `Last-Event-ID` reconnect, and a client that drops and comes back a
    second later would otherwise always be told to re-query. While retained, capture stays at
    `pk`: a ring that stopped filling would answer a reconnect with "nothing happened" when the
    truth is "I stopped looking".

15. **A fresh ring is sealed at the tenant's current txid** (`ChangeRing.seal`, added in M6's
    module). A ring created for a database that already has a history must answer `reset` for
    positions before it existed, not an empty backlog — an empty backlog reads as "you are up to
    date" and would silently lose everything in between.

16. **An SSE stream opens with `retry: 1000` and a comment.** A subscriber that is up to date has
    no event to send yet, and a response whose body stays empty is one that intermediaries — and
    some HTTP clients, including the one `bun test` uses — hold on to instead of delivering the
    headers. The first bytes are what turn it into a live stream.

17. **The default `BunQL-Node` is a hash of the hostname**, not the hostname. That header travels
    on every response and into whatever a client logs. `[server] node` or `BUNQL_NODE` sets a
    readable one.

18. **`wait` is what switches `/changes` between SSE and the long poll**, not `Accept`. A plain
    `*/*` — what curl and most HTTP clients send — gets the stream, because the design calls the
    long poll "the same feed without SSE" and reaches it through the parameter. `Accept` only
    decides the case where a client asked for `application/json` and nothing else.

19. **A 500 is reported to the runtime's error sink.** Clients are told only "internal error"
    (§6.6), so the wrapper logs the real one or it is lost entirely.

## Deviations from design §6 and §7

- **`POST /v1/db/{db}/restore` always creates a new database.** `{into}` names it; without it the
  name is `<db>-restore-<txid>`. Restoring in place would leave the tenant's log holding records
  past the restore point that no longer apply to the file, and phase 0's `TxnLog` has no
  truncate-after. Design §6.5's own CLI example restores with `--into`.
- **`POST /v1/db/{db}/promote` is not implemented.** It is static-topology failover (design §5.2),
  which is phase 1; there is nothing to promote to on a standalone node.
- **The Hrana compatibility surface (§6.7) is not implemented.** Design §11 puts it in phase 1.
- **`include` on a change subscription is a floor, not a filter.** The capture level is per
  database and the engine runs at the highest level any subscriber asked for, so a subscriber that
  asked for `pk` may receive `row` when somebody else asked for `row`. Filtering per subscriber
  would mean re-encoding the payload per socket, which is exactly what the shared-topic fan-out
  exists to avoid.
- **A WebSocket `subscribe` with several `tables` returns `subs` alongside `sub`.** One
  subscription is made per table topic, `sub` is the first, and `unsubscribe` accepts any of them.
  The design's single-`sub` shape is preserved for the common cases (whole database, one table).
- **`ping` is an op in the JSON protocol**, answered with `{event:"pong"}` or `{id, ok:true}`.
  Design §7 specifies protocol-level ping/pong, which Bun handles natively (`sendPings`,
  `idleTimeout: 120`); this is the same question for clients that cannot see control frames.
- **`consistency` is accepted and validated but changes nothing** on a single node, which is
  always the primary. `minTxid` does all the work.
- **`maxOpenTx` is fixed at 1 per database** by the tenant having one writer, so the config key
  exists but a larger value would not be honoured.
- **The long poll's `wait` is capped at 60 s** so a client cannot pin a subscription open
  indefinitely.

## Driver and tenant changes this milestone made

- `Database.lastInsertRowid` (`src/sqlite/database.ts`): the write path steps with `values()`
  because of `RETURNING`, so it cannot take the rowid from `Statement.run`.
- `Tenant.txBegin/txExec/txCommit/txRollback` and `Tenant.txOpen` (`src/tenant/tenant.ts`), with
  `busy` and `write()` both aware of an open transaction, and `close`/`abandon` rolling one back.
- `TenantRegistry.pin/unpin` and `TenantRegistry.importDatabase`.
- `ChangeRing.seal` (`src/realtime/ring.ts`).
- `applyPolicy` now takes the `AuthorizerHub` as its policy slot rather than calling
  `db.authorizer()` — the driver does not reinstall the C authorizer when only the callback is
  swapped, so cached statements would keep their old authorisation. `pinQueryOnly` is the seam the
  runtime uses to set the pragma once per connection.

## Measured

`bun run bench/http.ts 2000`, client and server in one process (as design §2.4 measured), APFS,
M-series, Homebrew SQLite 3.53.4:

| leg | p50 µs | p90 µs | p99 µs | design §10 budget |
|---|---|---|---|---|
| point read, HTTP keep-alive | 48.5 | 56.2 | 67.6 | ≤ 60 |
| point read, WebSocket | 28.0 | 33.1 | 42.5 | ≤ 35 |
| single-row write, `ack: local`, WebSocket | 60.1 | 69.1 | 100.1 | — |
| single-row write, `ack: local`, HTTP | 80.3 | 92.0 | 140.5 | ≤ 40 (in-process) |
| `healthz`, HTTP | 37.2 | 43.0 | 56.0 | — |

2000 concurrent reads finish in 43–87 ms across runs. Both read budgets are met. The write numbers
are the transport plus M4's 27 µs write path (`docs/m4-tenant.md`): 27 + 28 µs over WebSocket,
27 + 49 µs over HTTP. Design §10's 40 µs write budget is the in-process path "incl. tail+log",
which M4 measures at 27 µs; there is no separate budget for a write over HTTP.

The 2000-concurrent figure is 23k–47k req/s, against §10's ≥ 50k req/s target, and it is the one
number here that the measurement itself limits: the client runs in the same process and on the
same event loop as the server, so the two compete for one core. The `healthz` leg — the same
transport with no SQLite at all — costs 37 µs, which caps this harness at roughly 27k req/s
sequentially regardless of what the database does. A number worth quoting needs a client on
another core, which belongs to the end-to-end pass in M8.

## Environment overrides (updated in M7)

Design §9.4 says every key has an environment override. The canonical name of one is its section
and its key, upper-cased and underscore-separated, under `BUNQL_`; the short names that predate
M7 are still accepted, and the canonical one wins when both are set. An empty value counts as
unset, so `BUNQL_ADMIN_KEY=` leaves the key to be generated rather than setting it to "".

| key | canonical | alias |
|---|---|---|
| `[server] port` | `BUNQL_SERVER_PORT` | `BUNQL_PORT` |
| `[server] host` | `BUNQL_SERVER_HOST` | `BUNQL_HOST` |
| `[server] node` | `BUNQL_SERVER_NODE` | `BUNQL_NODE` |
| `[server] tenantFromHost` | `BUNQL_SERVER_TENANT_FROM_HOST` | `BUNQL_TENANT_FROM_HOST` |
| `[server] cors` | `BUNQL_SERVER_CORS` | `BUNQL_CORS` |
| `[data] dir` | `BUNQL_DATA_DIR` | `BUNQL_DIR` |
| `[data] maxOpen` | `BUNQL_DATA_MAX_OPEN` | `BUNQL_MAX_OPEN` |
| `[data] readers` | `BUNQL_DATA_READERS` | `BUNQL_READERS` |
| `[data] pageSize` | `BUNQL_DATA_PAGE_SIZE` | `BUNQL_PAGE_SIZE` |
| `[data] quotaBytes` | `BUNQL_DATA_QUOTA_BYTES` | `BUNQL_QUOTA_BYTES` |
| `[durability] defaultAck` | `BUNQL_DURABILITY_DEFAULT_ACK` | `BUNQL_DEFAULT_ACK` |
| `[durability] checkpointWalBytes` | `BUNQL_DURABILITY_CHECKPOINT_WAL_BYTES` | `BUNQL_CHECKPOINT_WAL_BYTES` |
| `[durability] retention` | `BUNQL_DURABILITY_RETENTION` | `BUNQL_RETENTION` |
| `[realtime] ringBytes` | `BUNQL_REALTIME_RING_BYTES` | `BUNQL_RING_BYTES` |
| `[realtime] ringMaxAgeMs` | `BUNQL_REALTIME_RING_MAX_AGE_MS` | `BUNQL_RING_MAX_AGE_MS` |
| `[realtime] maxLiveQueries` | `BUNQL_REALTIME_MAX_LIVE_QUERIES` | `BUNQL_MAX_LIVE_QUERIES` |
| `[realtime] maxRowsPerLive` | `BUNQL_REALTIME_MAX_ROWS_PER_LIVE` | `BUNQL_MAX_ROWS_PER_LIVE` |
| `[realtime] idleRetainMs` | `BUNQL_REALTIME_IDLE_RETAIN_MS` | `BUNQL_IDLE_RETAIN_MS` |
| `[limits] queryTimeoutMs` | `BUNQL_LIMITS_QUERY_TIMEOUT_MS` | `BUNQL_QUERY_TIMEOUT_MS` |
| `[limits] writeTimeoutMs` | `BUNQL_LIMITS_WRITE_TIMEOUT_MS` | `BUNQL_WRITE_TIMEOUT_MS` |
| `[limits] txIdleTimeoutMs` | `BUNQL_LIMITS_TX_IDLE_TIMEOUT_MS` | `BUNQL_TX_IDLE_TIMEOUT_MS` |
| `[limits] maxRows` | `BUNQL_LIMITS_MAX_ROWS` | `BUNQL_MAX_ROWS` |
| `[limits] maxOpenTx` | `BUNQL_LIMITS_MAX_OPEN_TX` | `BUNQL_MAX_OPEN_TX` |
| `[limits] maxBodyBytes` | `BUNQL_LIMITS_MAX_BODY_BYTES` | `BUNQL_MAX_BODY_BYTES` |
| `[limits] maxImportBytes` | `BUNQL_LIMITS_MAX_IMPORT_BYTES` | `BUNQL_MAX_IMPORT_BYTES` |
| `[auth] adminKey` | `BUNQL_AUTH_ADMIN_KEY` | `BUNQL_ADMIN_KEY` |
| `[auth] jwtKey` | `BUNQL_AUTH_JWT_KEY` | `BUNQL_JWT_ED25519` |
| `[auth] jwtPublicKeys` | `BUNQL_AUTH_JWT_PUBLIC_KEYS` (comma-separated) | — |
| `[auth] keysFile` | `BUNQL_AUTH_KEYS_FILE` | `BUNQL_KEYS_FILE` |
| `[auth] clockToleranceSec` | `BUNQL_AUTH_CLOCK_TOLERANCE_SEC` | `BUNQL_CLOCK_TOLERANCE_SEC` |
| `[auth] defaultTokenTtlMs` | `BUNQL_AUTH_DEFAULT_TOKEN_TTL_MS` | `BUNQL_TOKEN_TTL_MS` |

`BUNQL_CONFIG` names the TOML file and makes it required. It is read by `main.ts` and by
`bunql serve`, not by `loadConfig` itself.

Before M7 the table held only the short names, so `BUNQL_DATA_DIR` — the name the section-plus-key
rule produces, and the one an operator writes first — was silently ignored while `BUNQL_PORT` and
`BUNQL_ADMIN_KEY` worked. Both spellings are generated from the defaults now, so a key added to
`ServerConfig` gets its override for free.

## What M7 changed here

- **`createRuntime(config, options)`** (`app.ts`) builds the registry, the authenticator and the
  metrics without listening, and `startServer` takes a `runtime` instead of building one. That is
  how `src/embedded.ts` serves over the engine it already has rather than opening a second
  `ServerRuntime` on the same registry — which would put two `AuthorizerHub`s on one connection.
  A runtime passed in is not closed by `handle.close()`.
- **`TenantRegistry.onOpen`** and `RuntimeOptions.onTenantOpen`: a callback for every tenant the
  registry opens, whatever route reached it. The embedded `bq.on("commit")` needs to see every
  database without holding them all open.
- **`at` may be a timestamp** on `POST /v1/db/{db}/restore` and in `from.at` on `POST /v1/db`.
  An ISO-8601 string, or a number at or above 1e12, is resolved to the newest txid committed at or
  before it by binary-searching the tenant's log, whose records each carry a microsecond timestamp.
  A number below 1e12 is still a txid, and a time older than the log is a 400 naming what the log
  still holds.

## Testing

`test/server/` — 116 new tests over a real listener on port 0 (218 in `test/server/` in total, with M5a's unit tests for the codec, the errors and the policy):

| file | covers |
|---|---|
| `routes.test.ts` | value round trips including tagged integers and blobs, named arguments, both row modes, headers, `maxRows`, the 408 deadline, `minTxid` both waiting and 425, `lastInsertRowid` on writes that insert nothing, a no-op write holding its txid, SQLite error mapping, atomic and non-atomic batches with `failedIndex` |
| `authmatrix.test.ts` | no token, bad token, admin key, `?token=`, `ro`/`rw`, globs, table ACLs, `ATTACH`, expiry, revocation, admin-only routes |
| `tx.test.ts` | commit, rollback, `TX_BUSY` with `Retry-After`, a plain write refused while a baton holds the writer, the idle rollback, an unknown baton, a failed statement leaving the transaction usable, independence across databases |
| `admin.test.ts` | create, name validation, fork, fork at a txid, restore, snapshot, dump, import (including a body that is not a database), checkpoint, replication, delete |
| `realtime.test.ts` | SSE change events with `include=row`, `Last-Event-ID` resume across a disconnect, `reset`, table filters, live `rows` then `diff`, invalidation scope, live-query validation, live under a table ACL, the long poll and its 409 |
| `ws.test.ts` | handshake with and without a token, `hello`, ping, ordering within a database, interleaving across databases, batches, error shapes, `ro` refusals, transactions including socket-close rollback and baton ownership, change and live subscriptions, `reset`, unsubscribe |
| `ops.test.ts` | `healthz`, `readyz`, the Prometheus exposition and its counters, metrics auth, CORS preflight and exposure, `cors: false`, 404 |
| `config.test.ts` | defaults, TOML, `${VAR}` expansion, environment precedence and coercion, missing files, key generation and persistence, a token surviving a restart, limits and `tenantFromHost` end to end |

`bun test` runs 486 tests in 12 s across the whole repository; `bun run typecheck` is clean.
