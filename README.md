# BunQL

BunQL turns SQLite into a multi-tenant database server for Bun. It runs thousands of small
databases in one process, streams their WAL frames to replicas over a socket, backs them up
continuously to any S3-compatible bucket, and drives realtime subscriptions off SQLite's own
`preupdate`/`update` hooks rather than triggers or SQL parsing. It speaks its own API and libsql's
Hrana, so `@libsql/client`, Drizzle and Kysely reach it unmodified.

The engine is a `bun:ffi` driver over a shared libsqlite3, which measures about twice as fast as
`bun:sqlite` on point reads and exposes the parts of the C API that `bun:sqlite` does not:
hooks, the authorizer, query cancellation, per-connection limits and session changesets.

[**docs/api.md**](docs/api.md) is the API as implemented: every route, the Hrana surface, the
WebSocket protocol, the SSE formats, the SDKs, the CLI, every config key, and every place the
implementation differs from the design. [docs/design.md](docs/design.md) is the design it was built
from, including the cluster that is not here yet; [docs/next.md](docs/next.md) is where phase 2
picks up.

## What exists today

Phase 0 and phase 1 are complete: a primary with replicas, backed up to a bucket, with the libsql
ecosystem pointed at it.

- **Engine** — a `bun:ffi` driver over a shared libsqlite3 (`src/sqlite`), with hooks, the
  authorizer, query cancellation, per-connection limits and statement counters.
- **Tenancy** — thousands of databases in one process, LRU-managed, one writer each, per-tenant
  quotas and checkpoint policy (`src/tenant`).
- **WAL shipping** — committed transactions tailed out of the `-wal`, turned into self-verifying
  records, kept in a segment log, and applied to a replica (`src/wal`). Snapshots, point-in-time
  restore and O(1) forks are built on the same log.
- **Replication** — one binary WebSocket per node pair (`src/replication`): snapshot bootstrap,
  resume with no gap and no duplicate, epoch fencing, divergence and retention detection, and
  chained replicas. `bunql serve --replica-of ws://…` is the whole deployment.
- **Durability and routing** — `ack: "local" | "fsync" | "replica" | "quorum"`; a replica serves
  reads locally, forwards writes to the primary transparently, and honours `BunQL-Min-Txid`, so
  read-your-writes holds across nodes.
- **Backup** — continuous shipping of segments and snapshots to any S3-compatible bucket over
  `Bun.S3Client`, with retention and point-in-time restore onto a node that has never seen the
  database (`src/storage`).
- **Server** — HTTP, WebSocket and SSE over tenants, Ed25519 tokens with database globs and table
  ACLs, baton transactions with a fair queue, Prometheus metrics (`src/server`).
- **libsql compatibility** — Hrana `/v2/pipeline`, `/v3/pipeline`, `/v3/cursor` and the
  `hrana3`/`hrana2` sockets (`src/server/hrana`), over the same execution path as the native
  routes.
- **Realtime** — row-level change feeds and live queries driven by SQLite's own hooks, with a ring
  buffer behind `Last-Event-ID` (`src/realtime`). On a replica, live queries converge and the
  change feed carries txids.
- **Surfaces** — a `Bun.SQL`-shaped client SDK for browsers, Bun, Node and Workers
  (`src/client`), the same interface in-process plus a synchronous escape hatch
  (`src/embedded.ts`), Kysely and Drizzle adapters (`src/kysely.ts`, `src/drizzle.ts`), and the
  `bunql` CLI (`src/cli.ts`).

Zero runtime dependencies, in every one of those.

## What is left

| phase | scope | state |
|---|---|---|
| 0 | engine, tenancy, HTTP/WS/SSE, tokens, WAL log, snapshots, PITR, realtime, client, embedded, CLI | **built** |
| 1 | replica streaming and bootstrap, write forwarding, `ack` levels, read-your-writes across nodes, S3 shipper and restore, Hrana compatibility, Kysely and Drizzle | **built** |
| 2 | the cluster: a Raft control plane, placement, leases, failover, `promote`, `moved`, `workers: N`; replica apply mechanism A | next |
| 3 | WAL-decoded logical CDC (row-level events on a replica), snapshot reads across requests, per-tenant encryption at rest, a query-plan cache | later |

A replica cannot be promoted yet: recovery from a lost primary is a new node pointed at the
bucket, not an election. That, and the control plane it needs, is phase 2.

## Back it up to a bucket

Point a node at any S3-compatible bucket — AWS S3, Cloudflare R2, Tigris, MinIO — and every
database's log and snapshots are shipped to it continuously, over Bun's own `Bun.S3Client` and
with no dependency. Shipping never blocks a commit: a bucket that is slow or unreachable makes the
node report `behind` while writes are answered at their usual latency, and it catches up from the
local log when the bucket returns.

```sh
export BUNQL_S3_ACCESS_KEY_ID=… BUNQL_S3_SECRET_ACCESS_KEY=…
bun run src/cli.ts serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…

bunql backup status acme
# acme → s3://backups/prod  shipped txid 4812  0 pending  caught up  2 snapshot(s), 31 segment(s)

bunql backup verify acme --at 2026-09-11T10:00:00Z
bunql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
```

The restore runs on a node that has never seen the database: it reads the manifest, downloads the
newest snapshot at or before the target, and replays the segments after it through the same
verifier a replica uses, so it either reproduces the target txid checksum for checksum or fails
loudly. The bucket layout is a documented contract — `docs/r3-storage.md`.

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

### A primary and a replica

Two `serve` commands sharing a cluster secret. The replica follows every database the primary
announces, serves reads locally, and hands writes to the primary without the client knowing.

```sh
SECRET=$(openssl rand -hex 32)   # the two nodes prove this to each other; it is not a client token
# Both nodes are given the same admin key here, so one token reads and writes either of them.
bun run src/cli.ts serve --dir ./p --port 4501 --admin-key $KEY --cluster-secret $SECRET
bun run src/cli.ts serve --dir ./r --port 4502 --admin-key $KEY --cluster-secret $SECRET \
    --replica-of ws://127.0.0.1:4501/v1/replication

BUNQL_TOKEN=$KEY
BUNQL_URL=http://127.0.0.1:4501 bun run src/cli.ts db create acme
BUNQL_URL=http://127.0.0.1:4501 bun run src/cli.ts exec acme \
    --sql "create table notes (id integer primary key, body text)"
```

A write sent to the **replica** comes back with the primary's txid, and the replica has already
applied it by the time it answers:

```sh
curl -sD- -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d '{"sql":"insert into notes (body) values (@1)","args":["written through the replica"]}' \
     http://127.0.0.1:4502/v1/db/acme/query
# BunQL-Role: replica
# BunQL-Primary: ws://127.0.0.1:4501/v1/replication
# BunQL-Txid: 2
# {"rowsAffected":1,"lastInsertRowid":1,"txid":2,...}

BUNQL_URL=http://127.0.0.1:4502 bun run src/cli.ts exec acme --sql "select * from notes" --json
curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:4502/v1/db/acme/replication
# {"role":"replica","connected":true,"applied":2,"lagTxid":0,"bootstrapping":false,...}
```

Both nodes also answer libsql clients — the replica for reads, the primary for everything:

```ts
import { createClient } from "@libsql/client"

// The trailing slash matters: the client resolves `v2/pipeline` relative to this URL.
const primary = createClient({ url: "http://127.0.0.1:4501/v1/db/acme/", authToken: KEY })
const replica = createClient({ url: "http://127.0.0.1:4502/v1/db/acme/", authToken: KEY })

await primary.execute("insert into notes (body) values ('written by @libsql/client')")
await replica.execute("select id, body from notes order by id") // 2 rows, already applied
await replica.execute("insert into notes (body) values ('nope')") // LibsqlError: NOT_PRIMARY
```

`ack: "replica"` holds a write on the primary until a replica has the record on disk; `quorum`
waits for a majority. Both are per request, per node default, or a header —
[docs/api.md](docs/api.md#durability-levels) has the failure modes.

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
bunql serve --dir ./r --replica-of ws://primary:4321/v1/replication --cluster-secret $SECRET
bunql serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…
bunql db create acme
bunql db list
bunql db fork acme-copy --from acme@4812      # a txid, or @2026-09-11T10:00:00Z
bunql restore acme --at 2026-09-11T10:00:00Z --into acme-recovered
bunql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
bunql backup status acme
bunql backup verify acme --at 4812
bunql token --db acme --scope ro --ttl 30d --tables 'todos:r'
bunql exec acme --sql "select 1"              # one statement, --json for the server's own body
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

`bun run bench:driver` on an M5 Pro, Homebrew SQLite 3.53.4, 100k-row table:

| op | bunql | bun:sqlite |
|---|---|---|
| point read by primary key | 0.77 µs | 1.77 µs |
| 100-row scan to objects | 8.98 µs | 6.86 µs |
| insert inside a transaction | 0.28 µs | 0.22 µs |
| the same insert with an update hook installed | 0.36 µs | not available |

Point reads win because the per-statement overhead is much lower. Wide scans lose because every
column costs one extra FFI call for `sqlite3_column_type`, which bun:sqlite does in native code.

`bun run bench:replication`, a primary and a replica as two whole servers on loopback:

| leg | p50 | p90 |
|---|---|---|
| write on the primary over HTTP | 303 µs | 374 µs |
| commit → applied on the replica | 220 µs | 256 µs |
| write forwarded through the replica | 353 µs | 380 µs |
| write, `ack: "replica"` | 407 µs | 446 µs |
| write, `ack: "quorum"` | 383 µs | 410 µs |

Forwarding costs 49 µs over a write on the primary, and waiting for a replica to have the record
on disk costs 104 µs. Over HTTP on one node a point read is 48 µs, a write 79 µs, and the Hrana
pipeline is within a microsecond of both. The whole table, the design §10 budget it is read
against, and the machine it came from are in [docs/benchmarks.md](docs/benchmarks.md).

## Tests

```sh
bun test              # 861 tests, including test/e2e/ — the whole product in two scenarios
bun run typecheck
bun run bench         # every benchmark, then the design §10 table and the phase-1 table
bun run bench --quick # the same, with fewer rounds

bun run bench:driver  # the driver against bun:sqlite
bun run bench:wal     # primary -> replica shipping latency, leg by leg, no transport
bun run bench:tenant  # the write path through the tenant owner
bun run bench:http    # HTTP, WebSocket and Hrana, with the load client in its own process
bun run bench:replication  # two nodes over a real socket: latency, forwarding, ack levels
bun run bench:storage     # shipping to an in-process S3
```

`test/e2e/scenario.test.ts` is the single-node story end to end; `test/e2e/phase1.test.ts` is the
cluster one — a primary, two replicas, a bucket and a `@libsql/client`, all at once, over real
sockets.

The last recorded numbers, and the machine they came from, are in
[docs/benchmarks.md](docs/benchmarks.md).
