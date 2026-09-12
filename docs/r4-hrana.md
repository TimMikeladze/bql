# R4 — Hrana compatibility layer

What `src/server/hrana/` is, what it decides, and where it deviates from libsql-server. Companion
to `design.md` §6.7 and the milestone table in `plan-phase1.md`.

The goal is narrow and testable: `@libsql/client`, `drizzle-orm/libsql`, `kysely-libsql` and the
Turso CLI talk to BunQL with no changes. Everything here is a translation layer over
`src/server/exec.ts` — no statement path is reimplemented, so the authorizer, the deadline, the
row cap, the single writer and the txid are exactly the ones the native API gets.

## What the clients actually send (verified, not assumed)

Read from `@libsql/hrana-client@0.7.0` and `@libsql/client` sources rather than from the spec
prose, because the spec allows more than the clients use:

- **HTTP mode does not probe.** `HttpClient` is constructed with `protocolVersion = 2` by
  `@libsql/client`, so it never fetches `GET /v3` and goes straight to `POST v2/pipeline`. A server
  that only answers `POST /v2/pipeline` already works. `GET /v2` and `GET /v3` exist for the
  `protocolVersion: 3` path and for the Turso CLI.
- **The pipeline URL is resolved relatively**: `new URL("v2/pipeline", baseUrl)`. `encodeBaseUrl`
  in `@libsql/core` does **not** append a trailing slash, so `libsql://host/v1/db/acme` resolves to
  `/v1/db/v2/pipeline` — wrong. Path-mounted addressing therefore needs the trailing slash:
  `libsql://host/v1/db/acme/`. Root addressing (`libsql://acme.host` or `x-namespace`) is the
  path every Turso client already takes and needs nothing.
- **WebSocket subprotocols offered** are `hrana3-protobuf, hrana3, hrana2` (v3) or `hrana2` (v2).
  We answer `hrana3` or `hrana2` and never `hrana3-protobuf` — protobuf is not implemented.
- **Transactions are two different mechanisms.** `client.batch()` sends one `batch` request whose
  steps are conditioned on each other (`BEGIN`, each statement `condition: {type:"ok", step:i-1}`,
  `COMMIT`, then `ROLLBACK` conditioned on the commit *not* being ok). `client.transaction()`
  instead runs `BEGIN IMMEDIATE` as an ordinary `execute` on a stream and keeps the stream open.
  Both require the stream to own real transaction state, so it does.
- `transactionModeToBegin("read")` emits `BEGIN TRANSACTION READONLY`, which SQLite does not
  understand. We recognise it and open a deferred transaction.
- **Top-level errors are read from a non-2xx body whose `content-type` is exactly
  `application/json`** (string equality, not a prefix test), shaped `{message, code}` — not wrapped
  in `{"error": …}` the way §6.6 wraps ours.

## Surface

| route | purpose |
|---|---|
| `GET /v2`, `GET /v3` | version probe; 200 with the version number as text |
| `POST /v2/pipeline`, `POST /v3/pipeline` | the pipeline |
| `POST /v3/cursor` | the same batch, streamed as newline-delimited cursor entries |
| `GET /` (WebSocket upgrade) | `hrana3` / `hrana2` |
| `/v1/db/:db/v2`, `/v1/db/:db/v2/pipeline`, `/v1/db/:db/v3`, `/v1/db/:db/v3/pipeline`, `/v1/db/:db/v3/cursor` | the same, database in the path |
| `GET /v1/db/:db/hrana` (WebSocket upgrade) | per-database socket |

Request types handled: `execute`, `batch`, `sequence`, `describe`, `store_sql`, `close_sql`,
`get_autocommit`, `close` (HTTP) and additionally `open_stream`, `close_stream`, `open_cursor`,
`fetch_cursor`, `close_cursor` (WebSocket).

## Tenant selection

`x-namespace` header, else the first label of `Host` when the host looks like a domain with two or
more labels and is not an IP literal, else the database named `default`. That is libsql-server's
rule verbatim, and it is applied unconditionally on the Hrana surface — unlike the native routes,
which gate host addressing behind `server.tenantFromHost`. Hrana is opt-in compatibility and
`libsql://{db}.sql.example.com` is the whole point of it.

## Decisions taken here

1. **Batons are HMAC-SHA256 over `streamId:seq:expiry`**, keyed by 32 random bytes generated per
   process, appended to the payload as base64url. The Ed25519 signing key is not used: batons
   rotate on every response and an EdDSA signature is an async ~50 µs round trip, while
   `Bun.CryptoHasher("sha256", key)` is synchronous. A baton is unforgeable, single-use (the
   sequence advances on every response), and dies with the process — which is correct, because the
   stream it names is in memory anyway.
2. **A stream is a real transaction holder.** `BEGIN`/`COMMIT`/`ROLLBACK` arriving as ordinary
   statements are intercepted and turned into `runtime.beginTx` / `endTx`, because routing them
   through `executeStatement` would wrap each one in its own `BEGIN IMMEDIATE`. Everything else
   goes to `executeInTx` when the stream holds a transaction and `executeStatement` when it does
   not. The tenant's own idle timer is what reaps a transaction whose client vanished.
3. **Every request in a pipeline runs, even after one fails.** A failed request becomes
   `{"type":"error", …}` in `results` and the next one still executes — except after a `close`,
   which makes the rest of the pipeline fail with `STREAM_CLOSED`.
4. **`sequence` is split before it is run**, by a SQLite-aware splitter that understands string,
   identifier and comment quoting and `CREATE TRIGGER … BEGIN … END;` bodies (the `sqlite3_complete`
   rule). Each statement then takes the ordinary stream path, so a `BEGIN`/`COMMIT` inside a
   migration script works. The alternative — one `sqlite3_exec` — would bypass the recorder and
   produce no txid.
5. **`replication_index` is our txid** as a decimal string, on every `StmtResult`.
6. **Error codes are ours.** `LibsqlError.code` becomes `SQLITE_CONSTRAINT_UNIQUE`,
   `QUERY_TIMEOUT`, `NOT_AUTHORIZED`, `DB_NOT_FOUND` and friends — the same strings §6.6 uses.
7. **Cursor responses are built in full before they are sent.** `exec.ts` materialises a result
   set anyway (`stmt.values()`), so a streaming body would buy nothing but complexity. `maxRows`
   bounds it exactly as it bounds a pipeline response.

## Deviations from libsql-server, and why

- **INTEGER vs REAL is inferred, not read from SQLite.** `exec.ts` hands back JS values, and the
  driver collapses `SQLITE_INTEGER` and `SQLITE_FLOAT` into `number`. A cell is encoded as
  `float` when the column has REAL affinity (decltype containing `REAL`, `FLOA` or `DOUB`, which
  is SQLite's own rule) or when the value is not an integer; otherwise `integer`. So
  `SELECT 1.0` reports `{"type":"integer","value":"1"}` where libsql-server reports a float. A
  declared `REAL` column is always right, which is the case that occurs in schemas.
- **A float argument whose value is integral binds as INTEGER.** `@libsql/client` encodes every JS
  number as `{"type":"float"}`, and `bindOne` in `src/sqlite/values.ts` binds an integral number
  with `sqlite3_bind_int`. Column affinity fixes this for declared columns.
- **Non-finite REALs serialise as `{"type":"float","value":null}`**, because `JSON.stringify`
  writes `null` for `Infinity` and `NaN`. libsql-server does exactly the same (serde_json has the
  same hole) and `hrana-client` rejects both with a protocol error. Not worth diverging over.
- **`is_explain` is a prefix test on the SQL**, since `sqlite3_stmt_isexplain` is not in the
  driver's symbol table.
- **`rows_read` and `rows_written` are the returned row count and `rowsAffected`.** SQLite has no
  native `rows_read`; libsql patched one in. `vmSteps` is our honest equivalent and it is not part
  of the Hrana shape, so it is not reported here.
- **No protobuf.** `hrana3-protobuf` and `/v3-protobuf/*` are not implemented; clients negotiate
  down to JSON on their own.
- **No `describe` of a write statement under a read-only token**, because the authorizer refuses
  at prepare time. libsql-server behaves the same way.

## Limits

`limits.maxBodyBytes` bounds a pipeline or cursor body. `limits.maxRows`, `limits.queryTimeoutMs`
and `limits.writeTimeoutMs` are the ones `exec.ts` already enforces. Beyond those, a Hrana service
holds at most 4096 streams and expires one after 60 s idle; a stream stores at most 256 SQL texts;
a socket holds at most 64 open cursors. A stream's open transaction is leashed by
`limits.txIdleTimeoutMs` like any other.

## Wiring

`src/server/hrana/index.ts` exports everything the coordinator needs; the exact lines to add to
`src/server/app.ts` are in the R4 report and in the header of that module.

## Not covered

- Protobuf encodings (`hrana3-protobuf`, `/v3-protobuf/pipeline`).
- Hrana 1 (`POST /v1/execute`, `POST /v1/batch`) and the bare-`/` "hello" text response.
- `base_url` redirection: we always answer `null`, so a client never moves its stream.
- The real `@libsql/client` as a test dependency — it is not in `node_modules` and `package.json`
  is not R4's to edit. `test/hrana/client.test.ts` drives the exact request sequences the client
  emits instead.
