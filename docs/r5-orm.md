# R5 — ORM adapters: `bunql/kysely` and `bunql/drizzle`

Companion to `plan-phase1.md` R5 and `design.md` §9.1. What the two adapters are, how to use them,
which route the Drizzle one takes and why, and everything they cannot do.

| file | what |
|---|---|
| `src/kysely.ts` | `BunQLDialect` / `bunqlDialect()` — Kysely's own `Sqlite*` adapter, compiler and introspector, with BunQL as the transport |
| `src/drizzle.ts` | `drizzle()` / `libsqlClient()` — a libsql-shaped `Client` over a BunQL `Db`, handed to Drizzle's own libsql session |

Both are peer-optional: `kysely` and `drizzle-orm` are devDependencies here and
`peerDependenciesMeta.optional`, so BunQL still installs with neither. Nothing else under `src/`
imports either package, and the runtime dependency count is still zero.

Every adapter takes the same three sources:

- a client `Db` — `createClient({url, token}).db("acme")`;
- an embedded `Db` — `(await BunQL.open({dir})).db("acme")`, no HTTP in the middle;
- `{url, token, db}`, which the adapter builds a client from and owns. That client is opened with
  `intMode: "bigint"` rather than the SDK's `"number"`, because an ORM that throws on an integer
  past 2^53 is worse than one that hands back a bigint. Pass `intMode` yourself to change it.

## Kysely

```ts
import { Kysely, type Generated } from "kysely"
import { BunQLDialect } from "bunql/kysely"

interface Database {
  todos: {
    id: Generated<number>
    title: string
    done: Generated<number>
  }
}

const db = new Kysely<Database>({
  dialect: new BunQLDialect({
    url: process.env.BUNQL_URL ?? "http://localhost:4321",
    token: process.env.BUNQL_TOKEN,
    db: "acme",
  }),
})

await db.schema
  .createTable("todos")
  .ifNotExists()
  .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
  .addColumn("title", "text", (c) => c.notNull())
  .addColumn("done", "integer", (c) => c.notNull().defaultTo(0))
  .execute()

const written = await db
  .insertInto("todos")
  .values({ title: "write it" })
  .returningAll()
  .executeTakeFirstOrThrow()

await db.transaction().execute(async (trx) => {
  await trx.insertInto("todos").values({ title: "ship it" }).execute()
  await trx.updateTable("todos").set({ done: 1 }).where("id", "=", written.id).execute()
})

const open = await db.selectFrom("todos").selectAll().where("done", "=", 0).orderBy("id").execute()
console.log(written.id, open)
// 1 [ { id: 2, title: "ship it", done: 0 } ]

await db.destroy() // closes the client the dialect opened for {url, db}
```

That example was run verbatim against a live server to check this page, after
`bunql db create acme`. A `Db` you pass in yourself is never closed by `destroy()` — only a client
the dialect opened is.

`bunqlDialect(options)` is the same thing as a function. Both accept a bare `Db`, `{db}`, or
`{db, statement, transaction}`, where `statement` is the per-statement options of design §6
(`timeoutMs`, `maxRows`, `ack`, `consistency`) and `transaction` is `{mode, via, ack}` — `via:
"http"` forces the baton of §6.3 instead of the socket.

### How it maps

| Kysely | BunQL |
|---|---|
| `executeQuery` | `db.execute(sql, params)` → `{rows, insertId: lastInsertRowid as bigint, numAffectedRows: BigInt(rowsAffected)}` |
| `beginTransaction` | `db.transaction()`, parked (below) |
| `commitTransaction` / `rollbackTransaction` | releases the park |
| `savepoint` / `rollbackToSavepoint` / `releaseSavepoint` | the plain SQL Kysely compiles, inside the open transaction |
| `createAdapter` / `createQueryCompiler` / `createIntrospector` | `SqliteAdapter`, `SqliteQueryCompiler`, `SqliteIntrospector`, unchanged |
| `streamQuery` | throws |

**A Kysely transaction is one BunQL transaction.** Kysely's driver contract is
`begin(connection)` … `commit(connection)`, and BunQL's is a callback: `db.transaction(async tx =>
…)`. The adapter bridges them by opening the callback and parking it on a promise that commit
resolves and rollback rejects; every statement on that connection then runs through the `Tx` the
callback was handed. The obvious alternative — sending `begin` and `commit` as one-shot statements
— commits nothing, because each statement on a tenant's writer is its own transaction.

**A connection per acquire.** Kysely binds an open transaction to the connection it began on, so a
single shared connection object would leak a transaction into every query running beside it. A
connection here is a wrapper over the one multiplexed `Db`, so they are free.

## Drizzle

```ts
import { eq, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { drizzle } from "bunql/drizzle"

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  done: integer("done").notNull().default(0),
})

const db = drizzle(
  {
    url: process.env.BUNQL_URL ?? "http://localhost:4321",
    token: process.env.BUNQL_TOKEN,
    db: "acme",
  },
  { schema: { todos } },
)

await db.run(
  sql`create table if not exists todos(id integer primary key autoincrement, title text not null, done integer not null default 0)`,
)

const [written] = await db.insert(todos).values({ title: "write it" }).returning()

await db.transaction(async (tx) => {
  await tx.insert(todos).values({ title: "ship it" })
  await tx.update(todos).set({ done: 1 }).where(eq(todos.id, written?.id ?? 0))
})

const [open] = await db.batch([db.select().from(todos).where(eq(todos.done, 0))])
console.log(written?.id, open)
// 1 [ { id: 2, title: "ship it", done: 0 } ]

db.$client.close() // closes the client this adapter opened for {url, db}
```

`db.$client` is the libsql-shaped shim, and `db.$client.bunql` is the BunQL `Db` under it.
`libsqlClient(db, options)` is exported on its own for anything else that wants a libsql client
over BunQL.

### Why the libsql route, not `sqlite-proxy`

Drizzle has two doors for a driver it does not ship: `sqlite-proxy`, which takes a
`(sql, params, method) => {rows}` callback, and the libsql driver, which takes a `Client` object.
This adapter takes the libsql door — `drizzle-orm/libsql/driver-core`'s `construct(client, config)`
with a client of ours — because of what each one does with a transaction:

- **`sqlite-proxy` has no transaction to hand us.** Its session emulates one by sending `begin`,
  the statements, and `commit` through the same stateless callback. Over BunQL every one of those
  is an independent request against a tenant whose writer wraps each statement in its own
  transaction, so `begin` would commit immediately and roll back nothing. Intercepting the three
  keywords inside the callback would work for one transaction at a time and silently interleave
  two.
- **The libsql session asks the client for a transaction object** (`client.transaction()` → a
  handle with `execute`, `commit`, `rollback`) and routes every statement inside the block through
  it. That is exactly the shape of BunQL's baton, so transactions are real, and nested ones are
  savepoints on the same open transaction.
- **`db.batch()` is real too.** The libsql session calls `client.batch(statements)`, which maps
  onto `POST /v1/db/{db}/batch` — one transaction, one txid, `failedIndex` on the statement that
  broke (design §6.2). `sqlite-proxy`'s batch callback would have to be built out of single
  statements.

The cost of that door is one cast: `driver-core` exports `construct` at runtime but leaves it out
of its `.d.ts`, so the adapter names its type itself and throws a clear error if a future
`drizzle-orm` stops exporting it. `drizzle-orm/libsql` itself is not importable here — it
statically imports `@libsql/client`, which BunQL does not depend on.

### What the shim answers with

`@libsql/client` is not a dependency; the adapter declares the slice of its surface Drizzle
touches and answers in exactly its shapes.

- **Rows are libsql rows**: an object with a non-enumerable `length` and non-enumerable indices,
  plus one enumerable property per column. Drizzle reads a row both as an array
  (`Array.prototype.slice.call(row)`) and as an object (`Object.keys(row)`), and only that shape
  answers both. A duplicate column name keeps the first, as libsql does.
- **Blobs arrive as `ArrayBuffer`**, which is what libsql sends and what Drizzle's own
  `normalizeFieldValue` turns into a `Buffer`. Answering with the `Uint8Array` BunQL's codec
  produces would quietly give a `blob({mode: "bigint"})` column the wrong value.
- `lastInsertRowid` is a `bigint` or `undefined`; `rowsAffected` is a number; `columnTypes` is
  BunQL's `types`.
- `client.protocol` is `"bunql"`, not libsql's `"http"`/`"ws"`.
- `client.migrate(statements)` is the same atomic batch as `client.batch(statements)`.

## Limitations

**Both adapters**

- **No streaming.** BunQL answers a statement with its whole result set (design §6.1) and has no
  cursor route in phase 1, so Kysely's `.stream()` throws with that message rather than pretending,
  and Drizzle has no streaming API over a remote driver anyway. Page with `limit`/`offset`, and cap
  a statement with `maxRows`.
- **One open transaction per database, everywhere.** A BunQL tenant has a single writer and an open
  transaction holds it; a second `begin` on the same database is `TX_BUSY` (409). Within one
  adapter instance that never surfaces (below), but two adapter instances, two processes, or an
  adapter beside a plain client will collide.
- **DDL is not transactional.** `SqliteAdapter.supportsTransactionalDdl` is false and BunQL agrees:
  SQLite's `create table` inside a transaction is real, but a failed migration does not unwind the
  statements that ran before it in a separate request.
- **Errors keep BunQL's `code`.** Everything the client throws is a `BunQLClientError` carrying the
  server's code — `SQLITE_CONSTRAINT_UNIQUE`, `DB_NOT_FOUND`, `TXID_NOT_AVAILABLE`. Kysely
  propagates it as-is; Drizzle wraps it in a `DrizzleQueryError`, so the BunQL error is the
  `cause`.
- **Read-your-writes is the client's, not the ORM's.** `consistency: "ryw"` (the default) sends the
  highest txid this client has seen as `BunQL-Min-Txid`, so a read after a write through the same
  client never goes backwards. Two clients are two bookkeepers.

**Kysely**

- **Everything from one `Kysely` instance serialises.** `SqliteAdapter.supportsMultipleConnections`
  is `false`, so Kysely wraps every connection acquisition in its own mutex: one statement in
  flight at a time, and concurrent transactions queue rather than colliding. That is what keeps
  `TX_BUSY` out of the way, and it is also a throughput cap on a remote database — use a second
  `Kysely`, or the BunQL client directly, for concurrent reads.
- `isolationLevel` in a transaction is refused; SQLite has none.
  `accessMode: "read only"` opens the transaction `deferred` instead of `immediate`.
- Savepoints work through `db.startTransaction()` and `trx.savepoint(name)`; they are the plain
  `savepoint` / `rollback to` / `release` SQL Kysely compiles, run inside the open transaction.
- The result array Kysely hands back is BunQL's own `Result`, so it carries `txid`, `vmSteps`,
  `durationUs` and the rest as non-enumerable properties. Nothing that iterates, spreads or
  serialises the rows can see them.
- The migrator works, and is covered by a test: `Migrator` from `kysely/migration` over this
  dialect runs its migrations and records them. `SqliteAdapter`'s migration lock is a no-op,
  because SQLite reserves the one connection for the whole migration. See "DDL is not
  transactional" above for what that lock does not buy.

**Drizzle**

- **Concurrent transactions queue in the adapter**, because two request handlers each opening one
  is ordinary and `TX_BUSY` is not a useful answer to it. The wait is capped at 10 s
  (`transactionWaitMs`, `0` waits forever) so that the one mistake this cannot serve — opening a
  transaction from inside another one *on the same handle*, rather than using the `tx` the callback
  gives you — fails with a message saying so instead of hanging. The queue is per `Db`, so two
  `drizzle()` instances over one `Db` share it; two clients over one database do not.
- `client.sync()` and `client.executeMultiple()` are not implemented: the first is for libsql's
  embedded replicas, the second would need multi-statement SQL, which BunQL refuses by design
  (one statement per request).
- `drizzle-orm/libsql/migrator` works, and is covered by a test: it reads a migrations folder,
  applies it through `client.migrate()` (our atomic batch), records the hashes, and is a no-op on
  the second run.
- Drizzle's typings say a `blob({mode: "buffer"})` column is a `Buffer`; through this adapter it is
  whatever `Buffer.from(arrayBuffer)` returns on the runtime, which is a `Buffer` under Bun and
  Node. An `integer` column holding a value past 2^53 arrives as a `bigint` where Drizzle's type
  says `number`, because the underlying client is opened with `intMode: "bigint"` — the same thing
  `@libsql/client` does under that mode.

## Tests

`test/orm/kysely.test.ts` and `test/orm/drizzle.test.ts`, 36 tests against a real server started
in-process by `test/server/harness.ts`, plus the embedded engine for Kysely. They cover DDL,
insert-with-returning, where/join/order/limit, update, delete, commit, rollback, savepoints and
nested transactions, the HTTP baton as well as the socket, batch, bigint and blob round-trips, a
unique violation, concurrent transactions, both ORMs' migrators, and the introspector listing
tables. The whole file pair runs in about 0.25 s.

## Wanted but not built

Nothing in `src/client/` was changed for this. One thing would have been useful there: a `Db`
method that runs a statement and hands back the raw wire `QueryResult` (columns, types, rows,
`rowsAffected`, `lastInsertRowid`) without decoding rows into objects or arrays first. Both
adapters re-shape rows immediately — Kysely wants objects, Drizzle wants libsql's array-like rows —
so each pays one pass over the result that a raw accessor would save. `Query.values()` plus the
metadata on the array is close enough that it was not worth widening the client's surface for.
