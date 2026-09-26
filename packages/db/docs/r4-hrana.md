# R4 — Hrana compatibility layer

What `src/server/hrana/` is, what it decides, and where it deviates from libsql-server. Companion
to `design.md` §6.7 and the milestone table in `plan-phase1.md`.

The goal is narrow and testable: `@libsql/client`, `drizzle-orm/libsql`, `kysely-libsql` and the
Turso CLI talk to bql.sh with no changes. Everything here is a translation layer over
`src/server/exec.ts` — no statement path is reimplemented, so the authorizer, the deadline, the
row cap, the single writer and the txid are exactly the ones the native API gets.

## What the clients actually send (verified, not assumed)

Read from the `@libsql/client` and `@libsql/hrana-client` sources rather than from the spec prose,
because the spec allows more than the clients use. Every claim below is now also exercised against
the real packages — `@libsql/client@0.18.0`, `@libsql/hrana-client@0.10.0`, and
`kysely-libsql@0.7.1`'s pinned `@libsql/client@0.15.15` — in `test/hrana/libsql-client.test.ts`
and `test/hrana/orm-libsql.test.ts`:

- **HTTP mode does not probe.** `HttpClient` is constructed with `protocolVersion = 2` by
  `@libsql/client`, so it never fetches `GET /v3` and goes straight to `POST v2/pipeline`. A server
  that only answers `POST /v2/pipeline` already works. `GET /v2` and `GET /v3` exist for the
  `protocolVersion: 3` path and for the Turso CLI. In `hrana-client@0.10.0` the v3 JSON entry of
  `checkEndpoints` is *commented out* in the source, so even a `protocolVersion: 3` client probes
  only `v3-protobuf` and then falls back to v2 — `POST /v3/pipeline` and `POST /v3/cursor` are
  reachable from a hand-written client and from the Turso CLI, and from no release of
  `@libsql/client` at all.
- **The pipeline URL is resolved relatively**: `new URL("v2/pipeline", baseUrl)`. `encodeBaseUrl`
  in `@libsql/core` does **not** append a trailing slash, so `libsql://host/v1/db/acme` resolves to
  `/v1/db/v2/pipeline` — wrong. Path-mounted addressing therefore needs the trailing slash:
  `libsql://host/v1/db/acme/`. Root addressing (`libsql://acme.host` or `x-namespace`) is the
  path every Turso client already takes and needs nothing.
- **WebSocket subprotocols offered** are `hrana3-protobuf, hrana3, hrana2` (v3) or `hrana2` (v2).
  `@libsql/client` calls `openWs(url, jwt)` without a version, so it offers `hrana2` alone and every
  socket it opens negotiates `hrana2`. We answer `hrana3` or `hrana2` and never `hrana3-protobuf` —
  protobuf is not implemented.
- **Transactions are two different mechanisms.** `client.batch()` sends one `batch` request whose
  steps are conditioned on each other (`BEGIN`, each statement `condition: {type:"ok", step:i-1}`,
  `COMMIT`, then `ROLLBACK` conditioned on the commit *not* being ok). `client.transaction()`
  instead runs `BEGIN IMMEDIATE` as an ordinary `execute` on a stream and keeps the stream open.
  Both require the stream to own real transaction state, so it does.
- `transactionModeToBegin("read")` emits `BEGIN TRANSACTION READONLY`, which SQLite does not
  understand. We recognise it and open a deferred transaction that refuses writes: a statement
  inside it is classified with `sqlite3_stmt_readonly` and answered `SQLITE_READONLY` if it writes,
  which is what makes `transaction("read")` and `batch(…, "read")` mean anything.
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
   statements are intercepted and turned into `runtime.beginTxQueued` / `endTx`, because routing
   them through `executeStatement` would wrap each one in its own `BEGIN IMMEDIATE`. Everything
   else goes to `executeInTx` when the stream holds a transaction and `executeStatement` when it
   does not. The tenant's own idle timer is what reaps a transaction whose client vanished, and a
   client that reaches it sees `TX_NOT_FOUND` on its next statement. A stream on a *socket* uses
   the non-waiting `beginTx` instead — see gap 3 below.
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

## Connection strings that work

`@libsql/client` is a devDependency and `test/hrana/libsql-client.test.ts` opens every one of
these against a server started in-process. There is no runtime dependency: `package.json` still
has no `dependencies` block.

| URL | database | notes |
|---|---|---|
| `http://host:port/v1/db/acme/` | `acme` | **the trailing slash is required** |
| `http://host:port/v1/db/acme` | — | 404. The client resolves `v2/pipeline` *relatively*, so this asks for `/v1/db/v2/pipeline` |
| `http://host:port` | `default` | root addressing, no header needed |
| `http://host:port` + `x-namespace: acme` | `acme` | the header needs a custom `fetch` (see below) |
| `https://acme.sql.example.com` | `acme` | first `Host` label, which is how every Turso deployment addresses a database |
| `libsql://host:port/v1/db/acme/?tls=0` | `acme` | `libsql:` means TLS unless `tls=0` says otherwise; the node entrypoint then prefers HTTP |
| `ws://host:port/v1/db/acme/hrana` | `acme` | **`/hrana` is required**: `/v1/db/:db` is already the stats route, and Bun's route table matches before the upgrade is considered |
| `ws://host:port` | `default` | a browser `WebSocket` cannot send `x-namespace`, so over a socket the database comes from the path or the host label |

The trailing-slash rule is the one thing that trips people up, and it is not ours: `encodeBaseUrl`
in `@libsql/core` does not append a slash, and `new URL("v2/pipeline", base)` then discards the
last path segment. Failure without it is a bare 404, which `@libsql/client` reports as
`SERVER_ERROR: Server returned HTTP status 404`.

## `@libsql/client`, as run

```ts
import { createClient } from "@libsql/client"

const client = createClient({
  url: "http://127.0.0.1:4321/v1/db/acme/", // the trailing slash matters
  authToken: process.env.BQL_TOKEN,
  intMode: "bigint",
})

await client.execute({
  sql: "insert into users (name, email) values (?, ?)",
  args: ["ada", "ada@example.com"],
})
const rs = await client.execute("select id, name from users where name = :name", { name: "ada" })
rs.columns // ["id", "name"]
rs.columnTypes // ["INTEGER", "TEXT"]
rs.rows[0].name // "ada"  — a row is an object and an array at once
rs.rows[0][0] // 1n

// One transaction, committed together.
await client.batch(
  ["insert into users (name, email) values ('grace', 'grace@example.com')", ["update users set name = ? where id = ?", ["ada2", 1]]],
  "write",
)

// An interactive transaction; `close()` on an abandoned one rolls it back and frees the writer.
const tx = await client.transaction("write")
await tx.execute("insert into users (name, email) values ('alan', 'alan@example.com')")
await tx.commit()

await client.executeMultiple("create table t (a integer); insert into t values (1);")
await client.migrate(["create table m (a integer)"]) // the same, with foreign keys off
```

Root addressing with an explicit namespace needs a `fetch` wrapper, because `createClient` has no
header option:

```ts
const client = createClient({
  url: "http://127.0.0.1:4321",
  authToken: process.env.BQL_TOKEN,
  fetch: (input: Request) =>
    fetch(new Request(input, { headers: { ...Object.fromEntries(input.headers), "x-namespace": "acme" } })),
})
```

## `drizzle-orm/libsql`, as run

No adapter of ours in the path — this is Drizzle's own libsql driver, pointed at bql.sh.
`kysely-libsql@0.7.1` works the same way and is covered beside it in
`test/hrana/orm-libsql.test.ts`.

```ts
import { drizzle } from "drizzle-orm/libsql"
import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

const people = sqliteTable("people", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  age: integer("age"),
})

const db = drizzle({
  connection: { url: "http://127.0.0.1:4321/v1/db/acme/", authToken: process.env.BQL_TOKEN },
})

await db.transaction(async (tx) => {
  await tx.insert(people).values([{ name: "ada", age: 36 }, { name: "grace", age: 45 }])
  await tx.update(people).set({ age: 37 }).where(eq(people.name, "ada"))
  await tx.delete(people).where(eq(people.name, "grace"))
})
const rows = await db.select().from(people)
```

```ts
import { Kysely } from "kysely"
import { LibsqlDialect } from "kysely-libsql"

const db = new Kysely<Schema>({
  dialect: new LibsqlDialect({ url: "http://127.0.0.1:4321/v1/db/acme/", authToken: token }),
})
```

A Drizzle failure arrives as a `DrizzleQueryError` whose message is the SQL; the `LibsqlError` our
layer produced is its `cause`, and that is where `code` lives
(`err.cause.code === "SQLITE_CONSTRAINT_NOTNULL"`).

## intMode

`intMode` decides how an `{"type":"integer"}` cell becomes a JS value, and the default is the one
that throws.

| `intMode` | a small integer | past 2^53 |
|---|---|---|
| `"number"` (default) | `number` | **throws** `RangeError: Received integer which is too large…` — not a `LibsqlError`, so `err.code` is `undefined` |
| `"bigint"` | `bigint` | `bigint`, exact |
| `"string"` | `string` | `string`, exact |

Use `"bigint"`. Our own adapters already default to it (`test/orm/harness.ts`), a bql.sh rowid is
an INTEGER and `lastInsertRowid` is a `bigint` whatever `intMode` says, so `"number"` only buys a
throw the first time a real 64-bit id appears. Note that under `"bigint"` a *column* declared REAL
still reads as a JS `number`, and an integral value in an expression column reads as a `bigint` —
see the encoding deviation above.

## What the real clients caught that the hand-rolled tests did not

Two of these were fixed, in `src/server/hrana/`; two are gaps.

1. **Concurrent transactions failed instantly (fixed).** `@libsql/client` runs 20 requests at once
   by default and every ORM over it has parallel request handlers, so two `client.transaction()`
   calls overlap routinely. `executeStmt` called `runtime.beginTx`, which refuses `TX_BUSY` the
   moment the tenant's writer is taken: four overlapping transactions gave one success and three
   `TX_BUSY`. It now calls `runtime.beginTxQueued`, which is the waiting form R5 added to the
   runtime for exactly this reason on the native path.
2. **`transaction("read")` and `batch(…, "read")` accepted writes (fixed).** Both send
   `BEGIN TRANSACTION READONLY`, which `./sql.ts` translated to a plain deferred transaction, so
   `mode: "read"` meant nothing at all. `txVerb` now reports `readonly`, `HranaStream` carries it,
   and a statement in such a transaction is classified with `sqlite3_stmt_readonly` — under the
   principal's own policy, as `../exec.ts` does it — and refused with `SQLITE_READONLY` if it
   writes. Opening a read transaction now needs only the `ro` scope, not `rw`.
3. **Concurrent transactions on one socket are still refused (gap, by choice).** `./ws.ts` answers
   a socket's requests in arrival order across all of its streams, so a `BEGIN` that *waited* for
   the writer would hold up the `COMMIT` that would release it — a deadlock down to
   `limits.txWaitMs` rather than a queue. A socket stream therefore keeps the non-waiting
   `beginTx` (`HranaStream.waitsForWriter` is what says which), and the second of two overlapping
   `client.transaction()` calls on one socket fails `TX_BUSY` at once. A client that wants
   concurrent transactions should use the HTTP transport. Fixing it properly means chaining per
   stream instead of per socket, which is a change to that module's ordering invariant.
4. **`last_insert_rowid` was null when the new rowid repeated the connection's last one (fixed
   after R4b).** `src/server/exec.ts` used to tell an INSERT that inserted from an UPDATE that did
   not by reading `sqlite3_last_insert_rowid` either side of the step, so an insert whose new rowid
   equalled the previous one on the same pooled connection reported nothing. It affected the native
   API identically. Two tables, one row each:

   ```http
   POST /v1/db/app/v2/pipeline
   {"requests":[{"type":"execute","stmt":{"sql":"insert into b (v) values ('w')"}},{"type":"close"}]}
   ```
   ```json
   {"baton":null,"base_url":null,"results":[{"type":"ok","response":{"type":"execute","result":{
     "cols":[],"rows":[],"affected_row_count":1,"last_insert_rowid":null,
     "rows_read":0,"rows_written":1,"query_duration_ms":0.113,"replication_index":"5"}}},
     {"type":"ok","response":{"type":"close"}}]}
   ```

   That body now reads `"last_insert_rowid":"1"`. `exec.ts` asks the prepared statement whether its
   program inserts (`Statement.inserts`, captured from SQLite's authorizer at prepare time) and
   zeroes the connection's counter under a statement that does, so a non-zero value afterwards is
   proof this statement set it. `test/hrana/wire.test.ts` and `test/hrana/libsql-client.test.ts`
   pin the fixed behaviour; `test/server/rowid.test.ts` pins the rest of the shapes.

Everything else the hand-rolled client predicted held: the relative pipeline URL, the
`execute` + `close` pipelining, the batch shape with its conditioned `ROLLBACK`, `BEGIN IMMEDIATE`
as an ordinary statement on a kept stream, `executeMultiple` as `sequence`, `{"type":"float"}` for
every JS number, and the exact `application/json` content type an error body needs.

## Not covered

- Protobuf encodings (`hrana3-protobuf`, `/v3-protobuf/pipeline`).
- Hrana 1 (`POST /v1/execute`, `POST /v1/batch`) and the bare-`/` "hello" text response.
- `base_url` redirection: we always answer `null`, so a client never moves its stream.
- The Turso CLI, which is the one client that would take the `/v3/cursor` path.
