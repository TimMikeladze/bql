# BunQL

BunQL turns SQLite into a multi-tenant database server for Bun. It runs thousands of small
databases in one process, ships their WAL frames to replicas from userland, and drives realtime
subscriptions off SQLite's own `preupdate`/`update` hooks rather than triggers or SQL parsing.
The engine is a `bun:ffi` driver over a shared libsqlite3, which measures about twice as fast as
`bun:sqlite` on point reads and exposes the parts of the C API that `bun:sqlite` does not:
hooks, the authorizer, query cancellation, per-connection limits and session changesets.

[**docs/api.md**](docs/api.md) is the API as implemented: every route, the WebSocket protocol, the
SSE formats, the SDKs, the CLI, every config key, and every place the implementation differs from
the design. [docs/design.md](docs/design.md) is the design it was built from, including the
replication and cluster protocols that are not here yet; [docs/plan-phase0.md](docs/plan-phase0.md)
is the build order.

## What exists today

Phase 0 is complete and usable end to end on a single node.

- **Engine** — a `bun:ffi` driver over a shared libsqlite3 (`src/sqlite`), with hooks, the
  authorizer, query cancellation, per-connection limits and statement counters.
- **Tenancy** — thousands of databases in one process, LRU-managed, one writer each, per-tenant
  quotas and checkpoint policy (`src/tenant`).
- **WAL shipping** — committed transactions tailed out of the `-wal`, turned into self-verifying
  records, kept in a segment log, and applied to a replica directory (`src/wal`). Snapshots,
  point-in-time restore and O(1) forks are built on the same log.
- **Server** — HTTP, WebSocket and SSE over tenants, Ed25519 tokens with database globs and table
  ACLs, baton transactions, Prometheus metrics (`src/server`).
- **Realtime** — row-level change feeds and live queries driven by SQLite's own hooks, with a ring
  buffer behind `Last-Event-ID` (`src/realtime`).
- **Surfaces** — a `Bun.SQL`-shaped client SDK for browsers, Bun, Node and Workers
  (`src/client`), the same interface in-process plus a synchronous escape hatch
  (`src/embedded.ts`), and the `bunql` CLI (`src/cli.ts`).

## What is phase 1, and phase 2

Phase 1 turns the single node into a primary with replicas, on the log that already exists:

- replica streaming over the WebSocket, with bootstrap and write forwarding;
- `ack: "replica"` and `"quorum"` — semi-synchronous durability, which today is a `400`;
- the S3 shipper and restore-from-S3;
- the Hrana compatibility layer, which buys the whole libsql/Turso client ecosystem;
- Kysely and Drizzle adapters — built, see "Use it with your ORM" below;
- replica apply through mechanism A, removing the wal-index rebuild the current one forces.

Phase 2 is the cluster: a Raft control plane, placement, leases, failover and the `moved` event.
Nothing in either phase changes the API above; they add to it.

## Quickstart

### A server, and curl

```sh
bun start                                      # or: bun run src/cli.ts serve --dir ./data
```

The first start generates an admin key and an Ed25519 signing key, writes both to
`<dataDir>/keys.json`, and prints the admin key once.

```sh
KEY=<the admin key it printed>
curl -sX POST localhost:4321/v1/db -H "authorization: Bearer $KEY" \
     -H 'content-type: application/json' -d '{"name":"acme"}'

curl -sX POST localhost:4321/v1/db/acme/query -H "authorization: Bearer $KEY" \
     -H 'content-type: application/json' \
     -d '{"sql":"create table todos(id integer primary key, title text)"}'

curl -sX POST localhost:4321/v1/db/acme/query -H "authorization: Bearer $KEY" \
     -H 'content-type: application/json' \
     -d '{"sql":"insert into todos(title) values (?)","args":["write it"]}'
# {"columns":[],"types":[],"rows":[],"rowsAffected":1,"lastInsertRowid":1,"txid":2,...}

# A scoped token safe to hand to a browser, and the change feed it can subscribe to.
TOKEN=$(curl -sX POST localhost:4321/v1/tokens -H "authorization: Bearer $KEY" \
        -H 'content-type: application/json' \
        -d '{"dbs":["acme"],"scope":"ro","ttl":86400}' | jq -r .token)
curl -N "localhost:4321/v1/db/acme/changes?include=row&token=$TOKEN"
```

The route table, the WebSocket protocol, the SSE formats and every deviation from the design are in
[docs/api.md](docs/api.md).

### The client (browsers, Bun, Node, Workers)

Modelled on `Bun.SQL`: a tagged template that binds its values, a result array carrying the
statement's metadata, and subscriptions that are both emitters and async iterables.

```ts
import { createClient } from "bunql/client"

const client = createClient({ url: "http://localhost:4321", token })
const db = client.db("acme")

await db.sql`create table todos(id integer primary key, title text, done integer default 0)`.run()
const written = await db.sql`insert into todos(title) values (${"write it"})`.run()
written.lastInsertRowid // 1          · also .affectedRows, .txid, .command, .count

const todos = await db.sql`select * from todos where done = ${0}`   // [{ id: 1, title: "write it", done: 0 }]
const one = await db.sql`select title from todos where id = ${1}`.first()
const rows = await db.sql`select id, title from todos`.values()     // [[1, "write it"]]

await db.batch([db.stmt`insert into todos(title) values ('a')`, db.stmt`update todos set done = 1`])
await db.transaction(async (tx) => {                                // over the socket, else a baton
  await tx.sql`insert into todos(title) values (${"in a transaction"})`
})

const live = db.live`select * from todos where done = 0`.key("id")
live.on("rows", (event) => render(event.rows))                      // full result, then diffs
live.on("diff", (event) => patch(event.added, event.removed, event.updated))

for await (const event of db.changes({ tables: ["todos"] })) {
  console.log(event.txid, event.changes)                            // reconnects and resumes on its own
}
```

`consistency: "ryw"` (the default) remembers the highest txid it has seen per database and sends it
as `BunQL-Min-Txid`, so a read never goes backwards. `intMode: "bigint" | "string"` decides what an
integer beyond 2^53 becomes; the default refuses to round it.

### Embedded, in one process

```ts
import { BunQL } from "bunql"

const bq = await BunQL.open({ dir: "./data" })
const db = await bq.create("acme")                     // or bq.db("acme") for one that exists

await db.sql`create table todos(id integer primary key, title text)`.run()
db.sync.sql`insert into todos(title) values (${"fast path"})`.run()   // no promise at all
const rows = db.sync.sql`select * from todos`.all()

bq.on("commit", ({ db, txid }) => console.log(db, txid))
for await (const event of db.changes()) console.log(event)            // the bus, not HTTP

await bq.serve({ port: 4321 })                         // the same engine, now over HTTP/WS/SSE
```

`db` is the interface above, so code written against the client runs against the embedded engine
unchanged; `db.sync` is the escape hatch for hot loops.

### Use it with your ORM

`bunql/kysely` is a Kysely dialect and `bunql/drizzle` is a Drizzle driver. Both take a client
`Db`, an embedded `Db`, or `{url, token, db}` to build a client from; `kysely` and `drizzle-orm`
are optional peers, so neither is installed unless you use it.

```ts
import { Kysely, type Generated } from "kysely"
import { BunQLDialect } from "bunql/kysely"

interface Database {
  todos: { id: Generated<number>; title: string; done: Generated<number> }
}

const db = new Kysely<Database>({
  dialect: new BunQLDialect({ url: "http://localhost:4321", token, db: "acme" }),
})

const written = await db
  .insertInto("todos")
  .values({ title: "write it" })
  .returningAll()
  .executeTakeFirstOrThrow()

await db.transaction().execute(async (trx) => {          // one BunQL transaction, not a loose begin
  await trx.insertInto("todos").values({ title: "ship it" }).execute()
  await trx.updateTable("todos").set({ done: 1 }).where("id", "=", written.id).execute()
})

await db.selectFrom("todos").selectAll().where("done", "=", 0).orderBy("id").execute()
```

```ts
import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { drizzle } from "bunql/drizzle"

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  done: integer("done").notNull().default(0),
})

const db = drizzle({ url: "http://localhost:4321", token, db: "acme" }, { schema: { todos } })

const [written] = await db.insert(todos).values({ title: "write it" }).returning()
await db.transaction(async (tx) => {
  await tx.insert(todos).values({ title: "ship it" })
  await tx.update(todos).set({ done: 1 }).where(eq(todos.id, written.id))
})
const [open] = await db.batch([db.select().from(todos).where(eq(todos.done, 0))])
```

Transactions, savepoints, `db.batch()` and both migrators are real, on BunQL's own transaction and
batch routes rather than on `begin`/`commit` sent as loose statements. Streaming is not: BunQL
answers with whole result sets, so Kysely's `.stream()` says so. [docs/r5-orm.md](docs/r5-orm.md)
has both examples in full, the mapping, and every limitation.

### The CLI

```sh
bunql serve --dir ./data --port 4321          # or: bun run src/cli.ts serve
bunql db create acme
bunql db list
bunql db fork acme-copy --from acme@4812      # a txid, or @2026-09-11T10:00:00Z
bunql restore acme --at 2026-09-11T10:00:00Z --into acme-recovered
bunql token --db acme --scope ro --ttl 30d --tables 'todos:r'
bunql shell acme                              # a REPL over the WebSocket protocol
```

Every command but `serve` talks to a running server: `--url` (or `$BUNQL_URL`) and `--token` (or
`$BUNQL_TOKEN`, else `$BUNQL_ADMIN_KEY`). `--json` prints the server's own body instead of a
summary line.

### Configuration

`bunql.toml` in the working directory, then `BUNQL_*` in the environment. Every key has an override
named after its section and its key — `BUNQL_DATA_DIR`, `BUNQL_SERVER_PORT`,
`BUNQL_LIMITS_QUERY_TIMEOUT_MS`, `BUNQL_AUTH_ADMIN_KEY` — and the short forms `BUNQL_DIR`,
`BUNQL_PORT`, `BUNQL_ADMIN_KEY`, `BUNQL_NODE` and the rest still work. Every key, its default and
both spellings are in [docs/api.md](docs/api.md#configuration).

## The driver

```ts
import { Database } from "bunql/sqlite"

const db = Database.open("app.db")
db.exec("create table t(id integer primary key, v text)")
db.prepare("insert into t(v) values (?)").run("hello")
db.prepare("select * from t where id = ?").get(1)   // { id: 1, v: "hello" }
db.onUpdate((op, dbName, table, rowid) => console.log(op, table, rowid))
db.close()
```

`libsqlite3` is located from `BUNQL_SQLITE_LIB`, else from the usual Homebrew and Linux paths.
On macOS install a full build with `brew install sqlite`; Apple's system library is compiled
without the session and preupdate extensions.

## WAL shipping

`src/wal` reads committed transactions out of a primary's `-wal` file, turns each into a
self-verifying record, keeps them in a segment log, and applies them to a replica. No triggers,
no logical replication, no `_bunql` bookkeeping table: the pages SQLite wrote are the pages the
replica gets.

```ts
import { Database } from "bunql/sqlite"
import { computeFull, decode, TxnLog, TxnRecorder, WalApplier } from "bunql/wal"

const db = Database.open("primary/main.db")
db.exec("pragma wal_autocheckpoint = 0")            // we own checkpoints
db.exec("create table t(id integer primary key, v text)")
db.walCheckpoint("TRUNCATE")                        // the file alone is now the whole state

// A replica starts as a physical copy, so its page numbers match.
await Bun.write("replica/main.db", Bun.file("primary/main.db"))
const base = computeFull("replica/main.db", { includeWal: false })

const recorder = TxnRecorder.open({ dbPath: "primary/main.db" })
const log = TxnLog.open({ dir: "primary" })
const applier = new WalApplier({ dbPath: "replica/main.db", dir: "replica" })
applier.seed({
  txid: 0n,
  postChecksum: base.checksum,
  dbSizePages: base.pages,
  pageSize: base.pageSize,
})

db.exec("insert into t(v) values (\'hello\')")
for (const txn of recorder.poll()) {
  applier.apply(decode(log.append(txn)).record)     // the bytes are also the wire format
}
```

Point-in-time restore is the same applier pointed at a snapshot:

```ts
import { restore, snapshot } from "bunql/wal"

// The caller names the txid, because only the writer knows which one the checkpoint flushed.
await snapshot({ db, dbPath: "primary/main.db", dir: "primary" }, recorder.position.txid)
const recovered = await restore({ dir: "primary", at: 4200n, into: "recovered" })
```

Design notes and byte layouts are in [docs/m3-wal.md](docs/m3-wal.md).

## Measured

`bun run bench:driver` on an M-series Mac, Homebrew SQLite 3.53.4, 100k-row table:

| op | bunql | bun:sqlite |
|---|---|---|
| point read by primary key | 0.81 µs | 1.93 µs |
| 100-row scan to objects | 9.5 µs | 7.8 µs |
| insert inside a transaction | 0.29 µs | 0.23 µs |
| the same insert with an update hook installed | 0.36 µs | not available |

Point reads win because the per-statement overhead is much lower. Wide scans lose because every
column costs one extra FFI call for `sqlite3_column_type`, which bun:sqlite does in native code.

`bun run bench:wal`, 500 transactions of 5 rows each, primary and replica in one process on APFS:

| leg | p50 | p90 |
|---|---|---|
| primary commit | 11.0 µs | 17.3 µs |
| tail + checksum chain | 9.2 µs | 15.7 µs |
| encode (zstd level 3) | 11.2 µs | 14.9 µs |
| log append | 2.7 µs | 5.5 µs |
| decode | 5.2 µs | 7.7 µs |
| replica apply, including `fdatasync` | 191 µs | 235 µs |
| replica read sees the row | 47 µs | 74 µs |
| **end to end** | **285 µs** | **337 µs** |

Records compress about 4.8x. The apply leg is almost entirely `fdatasync`, and the replica read
pays for the wal-index rebuild that mechanism B forces on every apply — the cost design §4.5
names as the reason to move to mechanism A in phase 1.

## Tests

```sh
bun test              # 496 tests, including test/e2e/ — the whole product in one scenario
bun run typecheck
bun run bench         # all four, then one table against the design §10 budget
bun run bench --quick # the same, with fewer rounds

bun run bench:driver  # the driver against bun:sqlite
bun run bench:wal     # primary -> replica shipping latency, leg by leg
bun run bench:tenant  # the write path through the tenant owner
bun run bench:http    # HTTP and WebSocket, with the load client in its own process
```

The last recorded numbers, and the machine they came from, are in
[docs/benchmarks.md](docs/benchmarks.md).
