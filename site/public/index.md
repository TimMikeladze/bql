# A SQLite database server for Bun

`bql.sh` serves SQLite over HTTP, WebSockets and libsql's protocol. It streams every commit to replicas and S3, pushes live query diffs to clients, and ships `bql.sh/bus`, a message bus on the same engine. Built on [Bun](https://bun.sh) by [linesofcode](https://x.com/linesofcode).

Currently `bql.sh` v0.5.0 · MIT, Bun 1.4+.

```sh
bun add bql.sh
```

## SQLite, plus the server it never had

SQLite is fast and runs anywhere, but it's a library: no network access, no replicas, no backups and no way to subscribe to a query. bql.sh adds those and leaves every database a SQLite file.

### Network access

HTTP, WebSockets and libsql's Hrana protocol, so any process, browser or machine can query a database.

### Live queries

`db.live` sends the rows a commit added or removed. It runs off SQLite's `preupdate` hook, not triggers.

### Replicas

WAL frames stream to replicas over a WebSocket. A replica serves reads and forwards writes to the primary.

### Failover

`bql promote` fences the old primary by epoch. With `[cluster]` on, Raft promotes a replica on its own.

### Backups to S3

Every commit ships to S3, R2 or Tigris in the background. `bql restore` rebuilds any txid or timestamp.

### Branches

`bql db branch` forks a database as a reflink copy and records its parent, so a branch per pull request costs a directory.

### Search

`bql.sh/search` builds sqlite-vec, FTS5 and R*Tree queries, with hybrid ranking in one statement.

### Scoped tokens

Tokens scoped to databases, tables and `ro` or `rw`, safe to hand to a browser.

### Embedded or served

`Bql.open()` runs the engine in your process. `bq.serve()` adds HTTP later and your code stays the same.

## Watch a query change

`db.live` runs a query once, then sends the rows each commit added or removed. This is `client.ts` from the README and what it printed.

```ts
// client.ts
import { createClient } from "bql.sh/client"

const client = createClient({ url: "http://localhost:4321", token: process.env.BQL_ADMIN_KEY! })
await client.admin.create("acme")
const db = client.db("acme")
await db.sql`create table todos(id integer primary key, title text, done integer default 0)`.run()

const live = db.live`select id, title from todos where done = 0`.key("id")
live.on("diff", (e) => console.log("diff", JSON.stringify({ added: e.added, removed: e.removed })))
await new Promise((resolve) => live.on("rows", resolve))   // the first result; diffs follow

await db.sql`insert into todos(title) values (${"write it"})`.run()
await db.sql`update todos set done = 1 where id = ${1}`.run()
await Bun.sleep(100)
client.close()
```

```sh
BQL_ADMIN_KEY=<the admin key> bun client.ts
# diff {"added":[{"id":1,"title":"write it"}],"removed":[]}
# diff {"added":[],"removed":[{"id":1}]}
```

## Getting started in five steps

### Install

Add `bql.sh`, then build the libsqlite3 its driver loads. The driver needs the preupdate hook and the session extension, so the package compiles its own SQLite once, in about 15 seconds, with any C compiler.

```sh
bun add bql.sh
bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts
```

### Run it in your process

`Bql.open()` is the whole engine with no server in front. Every write returns the `txid` it committed in.

```ts
// app.ts
import { Bql } from "bql.sh"

const bq = await Bql.open({ dir: "./data" })
const db = await bq.create("acme")

await db.sql`create table todos(id integer primary key, title text, done integer default 0)`.run()
const written = await db.sql`insert into todos(title) values (${"write it"})`.run()
console.log("txid", written.txid)
console.log(await db.sql`select * from todos`)

await bq.close()
```

```sh
bun app.ts
# txid 2
# [
#   {
#     id: 1,
#     title: "write it",
#     done: 0,
#   }, count: 1, command: "SELECT", lastInsertRowid: null, affectedRows: 0, txid: 2,
#   columns: [ "id", "title", "done" ], types: [ "INTEGER", "TEXT", "INTEGER" ], durationUs: 97,
#   vmSteps: 11
# ]
```

### Start a server

`bql serve` prints an admin key the first time it starts and saves it to `keys.json`. The CLI and the client use it as `BQL_ADMIN_KEY`.

```sh
bunx bql serve --dir ./srv --port 4321
# bql: generated an admin key and wrote it to ./srv/keys.json
# bql: admin key: <43 url-safe base64 characters, printed this once and never again>
# bql http://localhost:4321  node=bql-77779295  data=./srv
# bql: 0 database(s), maxOpen 1024, ack fsync
```

### Give the browser a token

Never ship the admin key to a browser. `admin.mintToken` makes a token scoped to databases, tables and `ro` or `rw`, and anything outside it answers `NOT_AUTHORIZED`.

```ts
// token.ts
import { createClient } from "bql.sh/client"

const url = "http://localhost:4321"
const admin = createClient({ url, token: process.env.BQL_ADMIN_KEY! }).admin
const { token } = await admin.mintToken({ dbs: ["acme"], scope: "ro", ttlMs: 3_600_000 })

// Hand `token` to the browser. It can read acme and nothing else.
const db = createClient({ url, token }).db("acme")
console.log(JSON.stringify(await db.sql`select id, title, done from todos`))
await db.sql`delete from todos`.run().catch((err) => console.log(err.code, err.message))
```

```sh
BQL_ADMIN_KEY=<the admin key> bun token.ts
# [{"id":1,"title":"write it","done":1}]
# NOT_AUTHORIZED not authorized
```

### Deploy it

`bql deploy` provisions a server on Fly, Vercel or Cloudflare through the provider CLI you're already logged in to, then saves the connection so `bql db list` talks to it. Vercel and Cloudflare are experimental and keep data in Blob or R2.

```sh
mkdir bql-preview
cd bql-preview
bql deploy init --provider vercel --scope my-team
bql deploy plan
bql deploy apply
bql deploy status
```

| Provider | Compute | Durable data | Default region | Status |
| --- | --- | --- | --- | --- |
| Vercel | Bun container | Private Vercel Blob | `iad1` | Experimental object mode |
| Cloudflare | Worker + named Bun container | Private R2 bucket | `wnam` bucket location hint | Experimental object mode |
| Fly | Bun machine | Encrypted persistent volume at `/data` | `sjc` | Persistent-disk server |

## One db, every way in

`createClient()` over HTTP, `Bql.open()` in your process, `@libsql/client` over Hrana, an ORM, or the `bun:ffi` driver on its own.

### Client

```ts
import { createClient } from "bql.sh/client"

const client = createClient({ url: "http://localhost:4321", token })   // token, or the admin key
const db = client.db("acme")

await db.sql`create table todos(id integer primary key, title text, done integer default 0)`.run()
const written = await db.sql`insert into todos(title) values (${"write it"})`.run()
written.lastInsertRowid // 1          · also .affectedRows, .txid, .command, .count

const todos = await db.sql`select * from todos where done = ${0}`  // [{ id: 1, title: "write it", done: 0 }]
const one = await db.sql`select title from todos where id = ${1}`.first()
const rows = await db.sql`select id, title from todos`.values()    // [[1, "write it"]]

await db.batch([db.stmt`insert into todos(title) values ('a')`, db.stmt`update todos set done = 1`])
await db.transaction(async (tx) => {                               // over the socket, else a baton
  await tx.sql`insert into todos(title) values (${"in a transaction"})`
})

const live = db.live`select * from todos where done = 0`.key("id")
live.on("rows", (event) => render(event.rows))                     // full result, then diffs
live.on("diff", (event) => patch(event.added, event.removed, event.updated))

for await (const event of db.changes({ tables: ["todos"] })) {
  console.log(event.txid, event.changes)                           // reconnects and resumes on its own
}
```

### Embedded

```ts
import { Bql } from "bql.sh"

const bq = await Bql.open({ dir: "./data" })
const db = await bq.create("acme")                   // or bq.db("acme") for one that exists

await db.sql`create table todos(id integer primary key, title text)`.run()
db.sync.sql`insert into todos(title) values (${"fast path"})`.run()  // no promise at all
const rows = db.sync.sql`select * from todos`.all()

bq.on("commit", ({ db, txid }) => console.log(db, txid))
for await (const event of db.changes()) console.log(event)           // the bus, not HTTP

await bq.serve({ port: 4321 })                       // the same engine, now over HTTP/WS/SSE
```

### libsql

```ts
import { createClient } from "@libsql/client"

// The trailing slash matters: the client resolves `v2/pipeline` relative to this URL.
const primary = createClient({ url: "http://127.0.0.1:4501/v1/db/acme/", authToken: KEY })
const replica = createClient({ url: "http://127.0.0.1:4502/v1/db/acme/", authToken: KEY })

await primary.execute("insert into notes (body) values ('written by @libsql/client')")
await replica.execute("select id, body from notes order by id")  // already applied
await replica.execute("insert into notes (body) values ('nope')") // LibsqlError: NOT_PRIMARY
```

### Drizzle

```ts
import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { drizzle } from "bql.sh/drizzle"

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  done: integer("done").notNull().default(0),
})

const db = drizzle({ url: "http://localhost:4321", token, db: "acme" }, { schema: { todos } })

const [written] = await db.insert(todos).values({ title: "write it" }).returning()
await db.transaction(async (tx) => {
  await tx.update(todos).set({ done: 1 }).where(eq(todos.id, written.id))
})
```

### Kysely

```ts
import { Kysely, type Generated } from "kysely"
import { BqlDialect } from "bql.sh/kysely"

interface Database {
  todos: { id: Generated<number>; title: string; done: Generated<number> }
}

const db = new Kysely<Database>({
  dialect: new BqlDialect({ url: "http://localhost:4321", token, db: "acme" }),
})

const written = await db
  .insertInto("todos")
  .values({ title: "write it" })
  .returningAll()
  .executeTakeFirstOrThrow()

await db.transaction().execute(async (trx) => {        // one bql.sh transaction, not a loose begin
  await trx.updateTable("todos").set({ done: 1 }).where("id", "=", written.id).execute()
})
```

### Driver

```ts
import { Database } from "bql.sh/sqlite"

const db = Database.open("app.db")
db.exec("create table t(id integer primary key, v text)")
db.prepare("insert into t(v) values (?)").run("hello")
db.prepare("select * from t where id = ?").get(1)   // { id: 1, v: "hello" }
db.onUpdate((op, dbName, table, rowid) => console.log(op, table, rowid))
db.close()
```

## The database past SQL

### Replicas

Start a second server with `--replica-of`. It follows every database on the primary, serves reads locally and forwards writes, answering with the primary's txid.

```sh
curl -sD- -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d '{"sql":"insert into notes (body) values (@1)","args":["through the replica"]}' \
     http://127.0.0.1:4502/v1/db/acme/query
# BQL-Role: replica
# BQL-Primary: ws://127.0.0.1:4501/v1/replication
# BQL-Txid: 2

curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:4502/v1/db/acme/replication
# {"role":"replica","connected":true,"applied":2,"lagTxid":0,"bootstrapping":false,...}
```

### Failover

`bql promote acme` moves a database to a replica and fences the old primary by epoch. With `[cluster]` on, Raft does it when the primary's lease runs out. Write with `ack: "replica"` and a failover loses no acknowledged write.

```sh
bql promote acme --url http://127.0.0.1:4502        # addresses the candidate, not the cluster
# acme promoted on http://127.0.0.1:4502: epoch 4, txid 918
# n2 takes acme at epoch 4, fencing n1
```

### Backups to S3

Pass `--s3` and every commit ships to the bucket in the background; a slow bucket never slows a write. `bql restore` rebuilds a database at any txid or timestamp on a node that has never seen it.

```sh
export BQL_S3_ACCESS_KEY_ID=… BQL_S3_SECRET_ACCESS_KEY=…
bun run src/cli.ts serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…

bql backup status acme
# acme → s3://backups/prod  shipped txid 4812  0 pending  caught up  2 snapshot(s), 31 segment(s)

bql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
```

### A database per pull request

`bql db branch` forks a database and records its parent. The `bql-branch` GitHub Action creates one when a pull request opens and deletes it when it closes.

```sh
bql db branch pr-42 --from main             # --from main@4812 or @2026-09-11T10:00:00Z also work
bql db branches main                        # main's children; bare `branches` lists every branch
bql db diff main pr-42                      # schema and row counts; --json for the structure
bql db reset pr-42                          # back to main's head, same name
```

```yaml
# .github/workflows/db-branch.yml
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
jobs:
  branch:
    runs-on: ubuntu-latest
    steps:
      - id: db
        uses: TimMikeladze/bql/.github/actions/bql-branch@main
        with:
          url: ${{ secrets.BQL_URL }}
          token: ${{ secrets.BQL_ADMIN_KEY }}
          source: main
          action: ${{ github.event.action == 'closed' && 'delete' || 'create' }}
          on-exists: keep            # or `reset`: back to main's head on every push
      - run: echo "database ${{ steps.db.outputs.name }}"
```

### Vector, full-text and geo search

`bql.sh/search` builds sqlite-vec, FTS5 and R*Tree queries out of plain SQL. `hybridSearch` fuses bm25 and vector rank in one statement, and it all runs on a primary, a replica or in your process.

```ts
import { ftsIndex, ftsQuote, geoIndex, hybridSearch, vectorIndex } from "bql.sh/search"

// Full-text: an external-content FTS5 index kept in step with `posts` by three triggers.
const fts = ftsIndex(db, { table: "posts_fts", source: "posts", columns: ["title", "body"], tokenizer: "porter unicode61" })
await fts.create()                                 // fills from existing rows the first time
await fts.search(ftsQuote(userInput), { limit: 20, highlight: true, snippet: { column: "body" } })
// → [{ rowid, rank /* bm25, lower is better */, title, body, highlight, snippet }]

// Vectors: a sqlite-vec vec0 table; metadata columns filter inside the KNN.
const vec = vectorIndex(db, { table: "posts_vec", dimensions: 384, metric: "cosine", metadata: { lang: "text" } })
await vec.create()
await vec.upsert(post.id, embedding, { lang: "en" })
await vec.search(queryEmbedding, { k: 10, where: { lang: "en" } })   // → [{ id, distance, lang }]

// Hybrid: one statement, bm25 rank and KNN rank fused by reciprocal rank (k = 60).
await hybridSearch(db, { fts, vector: vec, query: ftsQuote(userInput), embedding: queryEmbedding, k: 10 })
// → [{ id, score, ftsRank, vectorRank, bm25, distance }]

// Geo: an R*Tree over `shops.lat`/`shops.lon`, exact great-circle distance on top.
const geo = geoIndex(db, { table: "shops_geo", source: "shops" })
await geo.create()
await geo.near(51.5033, -0.1196, 2_000, { limit: 20 })              // → [{ id, lat, lon, distance /* m */ }]
await geo.within({ minLat: 51.4, maxLat: 51.6, minLon: -0.3, maxLon: 0.1 })
```

### Your ORM already works

The server speaks libsql's Hrana protocol, so `@libsql/client` connects as is. `bql.sh/kysely` and `bql.sh/drizzle` run transactions and migrations on bql.sh's own routes.

@libsql/client over Hrana:

```ts
import { createClient } from "@libsql/client"

// The trailing slash matters: the client resolves `v2/pipeline` relative to this URL.
const primary = createClient({ url: "http://127.0.0.1:4501/v1/db/acme/", authToken: KEY })
const replica = createClient({ url: "http://127.0.0.1:4502/v1/db/acme/", authToken: KEY })

await primary.execute("insert into notes (body) values ('written by @libsql/client')")
await replica.execute("select id, body from notes order by id")  // already applied
await replica.execute("insert into notes (body) values ('nope')") // LibsqlError: NOT_PRIMARY
```

bql.sh/kysely, BqlDialect:

```ts
import { Kysely, type Generated } from "kysely"
import { BqlDialect } from "bql.sh/kysely"

interface Database {
  todos: { id: Generated<number>; title: string; done: Generated<number> }
}

const db = new Kysely<Database>({
  dialect: new BqlDialect({ url: "http://localhost:4321", token, db: "acme" }),
})

const written = await db
  .insertInto("todos")
  .values({ title: "write it" })
  .returningAll()
  .executeTakeFirstOrThrow()

await db.transaction().execute(async (trx) => {        // one bql.sh transaction, not a loose begin
  await trx.updateTable("todos").set({ done: 1 }).where("id", "=", written.id).execute()
})
```

bql.sh/drizzle, drizzle():

```ts
import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { drizzle } from "bql.sh/drizzle"

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  done: integer("done").notNull().default(0),
})

const db = drizzle({ url: "http://localhost:4321", token, db: "acme" }, { schema: { todos } })

const [written] = await db.insert(todos).values({ title: "write it" }).returning()
await db.transaction(async (tx) => {
  await tx.update(todos).set({ done: 1 }).where(eq(todos.id, written.id))
})
```

### REST, OpenAPI and GraphQL

Every database gets a REST API and an OpenAPI 3.1 document generated from its own tables, and GraphQL once the optional `graphql` peer is installed. Requests go through the same token checks, row cap and write forwarding as SQL.

```http
GET    /v1/db/acme/api/users?name=like.ann*&order=name.asc&limit=20
POST   /v1/db/acme/api/users          { "name": "ann" }
GET    /v1/db/acme/openapi.json       that database's OpenAPI 3.1 document
POST   /v1/db/acme/graphql            { "query": "{ listUsers { id name } }" }
GET    /v1/openapi.json               this server's own API
```

### Row changes onto the bus

An `[[outbox.rules]]` entry publishes every committed row change to a bus subject. It reads the durable log and moves its cursor only after the bus acknowledged, so a crash neither loses nor repeats a change.

```toml
[replication]
logicalChanges = "row"

[[outbox.rules]]
db = "app-*"                   # database-name glob
busUrl = "http://bus:4317"
tokenEnv = "BUS_TOKEN"         # or token = "${BUS_TOKEN}"
subject = "db.{db}.{table}"    # the default
include = "row"                # "pk" | "row" | "row+old", at most what logicalChanges records
```

```sh
bql bus subscribe cdc 'db.app-1.>'
# {"db":"app-1","table":"users","op":"insert","txid":42,"seq":0,"i":0,"rowid":7,
#  "pk":{"id":7},"row":{"id":7,"email":"a@b.c"},"committedAt":1790640000000}
bql bus sink webhook --subscription cdc --to https://example.com/hook --secret "$HOOK_SECRET"
```

## A message bus on the same engine

### Queue, pub/sub and request/reply

Publish to a subject, and each subscription reads it with its own cursor, leases, retries and a dead-letter subject. `bql bus consume --exec` turns any script into a consumer: the message arrives on stdin.

```sh
bql bus serve &
bql bus subscribe work 'work.>'
bql bus consume work --exec ./handle.sh &
bql bus publish work.resize '{"src":"a.png"}'
```

```ts
import { BusClient, BusConsumer, FatalError } from "bql.sh/bus/client";

const client = new BusClient({ url: "http://127.0.0.1:4317", token: process.env.BUS_TOKEN! });

await new BusConsumer({
  client,
  id: "resizer-1",
  subscription: "work",
  prefetch: 4,
  async handle({ message }, api) {
    if (!supported(message.body)) throw new FatalError("unsupported format");
    await api.extend();               // renew the lease from a long handler
    return { ok: true };              // a returned value answers a request
  },
}).start();
```

### Exactly-once, three ways

Delivery is at-least-once by default. `api.emit` publishes in the same commit as the ack, and `api.effect` records an outside call so a redelivery replays the result instead of repeating the call.

| Tier | Guarantee | Requires |
| --- | --- | --- |
| **Transactional ack** | Exactly-once *processing* — the handler's writes and the ack are one SQLite transaction | Embedded mode (`createBus`), a synchronous handler |
| **Atomic read-process-write** | Exactly-once *within the bus* — `ack(id, { publish: [...] })` commits both or neither | Nothing; it is an option on `ack` |
| **Fenced, ledgered effects** | Tight effectively-once against the outside world | A destination with a conditional write, or an idempotent one |

```ts
async handle({ message }, api) {
  // Committed with the ack, not before it: a crash cannot produce this message
  // without also finishing the one that caused it.
  api.emit({ subject: "thumbnails.ready", body: { id: message.body.id } });

  // At most once, with the result recorded alongside the ack. A redelivery
  // replays it instead of charging the card again.
  const charge = await api.effect(`charge:${message.body.orderId}`, () =>
    payments.charge(message.body),
  );

  // This attempt, for a conditional write at the destination.
  await store.put(key, bytes, { ifMatch: api.fence });
}
```

### Cron schedules

`bql bus schedule add` publishes an ordinary message on each fire, once per slot, in any IANA time zone. `catchUp` decides what happens to slots missed while the bus was down.

```sh
bql bus schedule add nightly '30 2 * * *' reports.nightly '{"kind":"daily"}' --tz America/New_York
bql bus schedule list            # --json for machines
bql bus schedule run nightly     # fire once now; does not move the next fire
bql bus schedule pause nightly · resume nightly · remove nightly
```

```ts
await bus.putSchedule({ name: "nightly", cron: "30 2 * * *", tz: "America/New_York",
  subject: "reports.nightly", body: { kind: "daily" }, catchUp: "latest" });
```

### Sinks to webhooks, S3 and ClickHouse

`bql bus sink` writes a subscription in batches and acks only once the destination took the batch. With the outbox in front, committed rows reach a warehouse with no code.

```sh
bql bus sink webhook    --subscription cdc --subject 'db.>' --to https://example.com/hook --secret "$SECRET"
bql bus sink s3         --subscription lake --bucket events --prefix cdc/ --endpoint-url https://…
bql bus sink clickhouse --subscription olap --to http://clickhouse:8123 --table analytics.users --shape row
```

```ts
import { BusClient, SinkRunner, webhookSink } from "bql.sh/bus";

await new SinkRunner({
  client: new BusClient({ url: "http://127.0.0.1:4317", token: process.env.BUS_TOKEN! }),
  id: "hook-1",
  subscription: "cdc",
  writer: webhookSink({ url: "https://example.com/hook", secret: process.env.HOOK_SECRET }),
}).start();
```

### Schemas on subjects

Register a JSON Schema with `--compat backward` and bind it to a subject pattern in `warn` mode, then `enforce`. A version that breaks the declared compatibility is refused with the failing pointer.

```sh
bql bus schema register order ./order.json --compat backward
bql bus schema bind 'orders.>' order --mode warn      # then --mode enforce
bql bus schema check order ./order-v2.json            # dry-run the compat check
```

## Speaks to what you already run

Drizzle, Kysely and `@libsql/client` connect over Hrana. Backups go to S3, R2 or Tigris. Sinks write to webhooks and ClickHouse, and `bql deploy` targets Fly, Vercel and Cloudflare.

Reference: https://bql.sh/reference · Repository: https://github.com/TimMikeladze/bql
