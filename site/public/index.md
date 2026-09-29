# SQLite as a server, and a durable bus

`bql.sh` serves thousands of SQLite databases from one process. `bql.sh/bus` runs the work against them. Built on [Bun](https://bun.sh), zero runtime dependencies, by [linesofcode](https://x.com/linesofcode).

Currently `bql.sh` v0.2.0 · on npm, Bun 1.4+.

```sh
bun add bql.sh
```

## By the numbers

- **199** test files
- **0** runtime dependencies
- **49k** writes/s, 64 clients
- **54 µs** point read over HTTP

## Reached by what you already run

Drizzle, Kysely and `@libsql/client` on top. S3, R2 or MinIO underneath. ClickHouse and webhooks downstream.

## Principles

- **Zero runtime dependencies.** No `dependencies` field. The OTLP exporter and the schema validator are written, not installed.
- **The write path never waits.** A write checks a lease held in memory. Raft and S3 run beside the commit, never in front.
- **Refuse rather than guess.** Promotion answers `BEHIND`. An unknown schema keyword fails. Past 2^53 is never rounded.

## One engine, four ways in

A tagged template over HTTP, a synchronous call in your process, a raw `bun:ffi` driver — or a bus handler inside the transaction that acks it.

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

### Transactional ack

```ts
import { createBus } from "bql.sh/bus";

const bus = createBus({ path: "./data/bus.db", blobDirectory: "./data/blobs" });
bus.store.raw().run("CREATE TABLE IF NOT EXISTS processed (seq INTEGER PRIMARY KEY)");

bus.consumeTransactional({
  subscription: "work",
  // Synchronous, and that is load-bearing: an `await` in here would let another
  // statement interleave into the transaction this exists to provide.
  handle: (envelope, db) => {
    db.run("INSERT INTO processed (seq) VALUES (?)", [envelope.message.seq]);
  },
});
```

## Realtime from SQLite's hooks

`db.live` diffs a query; `/changes` streams every commit as SSE. Driven by `preupdate`, not triggers.

```ts
import { createClient } from "bql.sh/client"

const db = createClient({ url: "http://localhost:4321", token }).db("acme")

await db.sql`insert into todos(title) values (${"write it"})`.run()
const live = db.live`select * from todos where done = 0`.key("id")
live.on("diff", (e) => patch(e.added, e.removed, e.updated))
```

```sh
TOKEN=$(curl -sX POST localhost:4321/v1/tokens -H "authorization: Bearer $KEY" \
        -H 'content-type: application/json' \
        -d '{"dbs":["acme"],"scope":"ro","ttl":86400}' | jq -r .token)

curl -N "localhost:4321/v1/db/acme/changes?include=row&token=$TOKEN"
# retry: 1000
# : open
#
# id: 3
# event: change
# data: {"txid":3,"changes":[{"table":"todos","op":"insert","rowid":2,"pk":{"id":2},"row":{…}}]}
```

## Every write returns a txid

The client sends the highest it has seen as `BQL-Min-Txid`, so a read never goes backwards.

```sh
KEY=<the admin key it printed>
curl -sX POST localhost:4321/v1/db -H "authorization: Bearer $KEY" \
     -H 'content-type: application/json' -d '{"name":"acme"}'

curl -sX POST localhost:4321/v1/db/acme/query -H "authorization: Bearer $KEY" \
     -H 'content-type: application/json' \
     -d '{"sql":"create table todos(id integer primary key, title text)"}'
# {"columns":[],"types":[],"rows":[],"rowsAffected":0,"lastInsertRowid":null,"txid":1,...}

curl -sX POST localhost:4321/v1/db/acme/query -H "authorization: Bearer $KEY" \
     -H 'content-type: application/json' \
     -d '{"sql":"insert into todos(title) values (?)","args":["write it"]}'
# {"columns":[],"types":[],"rows":[],"rowsAffected":1,"lastInsertRowid":1,"txid":2,...}
```

## Vector, full-text, hybrid, geo

`bql.sh/search` builds it out of SQL, so it runs on a primary, a replica or in-process alike.

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

## Replicas that forward writes

Start a node with `--replica-of`. It reads locally and answers a forwarded write with the primary's txid.

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

```ts
import { createClient } from "@libsql/client"

// The trailing slash matters: the client resolves `v2/pipeline` relative to this URL.
const primary = createClient({ url: "http://127.0.0.1:4501/v1/db/acme/", authToken: KEY })
const replica = createClient({ url: "http://127.0.0.1:4502/v1/db/acme/", authToken: KEY })

await primary.execute("insert into notes (body) values ('written by @libsql/client')")
await replica.execute("select id, body from notes order by id")  // already applied
await replica.execute("insert into notes (body) values ('nope')") // LibsqlError: NOT_PRIMARY
```

## Promotion that refuses to guess

`bql promote` fences the old primary by epoch. `--force` overrides exactly three refusals.

```sh
bql promote acme --url http://127.0.0.1:4502        # addresses the candidate, not the cluster
# acme promoted on http://127.0.0.1:4502: epoch 4, txid 918
# n2 takes acme at epoch 4, fencing n1
```

## A database per pull request

`bql db branch` is an O(1) fork that remembers its parent. The `bql-branch` action opens and closes one per PR.

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

## Backed up to any bucket

Pass `--s3` and every log and snapshot ships continuously. A slow bucket reports `behind`; it never slows a commit.

```sh
export BQL_S3_ACCESS_KEY_ID=… BQL_S3_SECRET_ACCESS_KEY=…
bun run src/cli.ts serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…

bql backup status acme
# acme → s3://backups/prod  shipped txid 4812  0 pending  caught up  2 snapshot(s), 31 segment(s)

bql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
```

## Committed rows onto the bus

An `[outbox]` rule publishes every row change from the durable log. A crash never loses one, a restart never repeats one.

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

## ORMs reach it unmodified

It speaks libsql's Hrana. `bql.sh/kysely` and `bql.sh/drizzle` map transactions onto its own routes.

@libsql/client — Hrana over HTTP:

```ts
import { createClient } from "@libsql/client"

// The trailing slash matters: the client resolves `v2/pipeline` relative to this URL.
const primary = createClient({ url: "http://127.0.0.1:4501/v1/db/acme/", authToken: KEY })
const replica = createClient({ url: "http://127.0.0.1:4502/v1/db/acme/", authToken: KEY })

await primary.execute("insert into notes (body) values ('written by @libsql/client')")
await replica.execute("select id, body from notes order by id")  // already applied
await replica.execute("insert into notes (body) values ('nope')") // LibsqlError: NOT_PRIMARY
```

bql.sh/kysely — BqlDialect:

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

bql.sh/drizzle — drizzle():

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

## Subjects, fanned out on pull

`*` matches one token, `>` the rest. Publishing is O(1) in subscriptions, and `deliverFrom: "beginning"` reads last week.

```
orders.eu.created        a concrete subject
orders.*.created         matches orders.eu.created, not orders.eu.west.created
orders.>                 matches both
>                        everything
```

## Three tiers of exactly-once

At-least-once by default. `api.emit` commits with the ack; `api.effect` records an outside call beside it.

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

## Cron, as ordinary messages

`bql bus schedule add` fires on the leader, one deduplicated publish per slot, DST-correct in any IANA zone.

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

## Sinks to webhooks, S3, ClickHouse

`bql bus sink` acks a batch only once the destination took it. Paired with the outbox, that is rows to a warehouse with no code.

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

## Schemas with computed compatibility

Register with `--compat backward`, bind in `warn`, then `enforce`. A breaking version is a 409 naming the pointer.

```sh
bql bus schema register order ./order.json --compat backward
bql bus schema bind 'orders.>' order --mode warn      # then --mode enforce
bql bus schema check order ./order-v2.json            # dry-run the compat check
```

## Proven with real processes

`bun run test:e2e` SIGKILLs a consumer mid-message. No mocks.

```
ok   eight messages were handled with none left pending or dead — pending=0 dead=0
ok   a second subscription received the same messages independently — 8 envelopes
ok   killed worker-a while it held the slow message
ok   a surviving consumer recovered the expired lease — attempt 2, now on worker-b
ok   the poison message reached the dead-letter subject with its reason — unsupported payload
ok   a request was answered by a consumer in another process — "HELLO BUS"
ok   a long handler is running as a real child process — pid 86892
ok   cancelling the message cancelled its in-flight delivery — 1 delivery
ok   the consumer's child process actually stopped
ok   a repeated dedupe key does not publish twice
```

## Measured, including where it loses

`bun run bench` on an M5 Pro, as ratios against `bun:sqlite`. Writes in a transaction still lose slightly.

| op | bql vs `bun:sqlite` |
| --- | --- |
| point read by primary key | 1.02 – 1.14x |
| 100-row scan to objects | 1.17 – 1.39x |
| insert inside a transaction | 0.84 – 0.95x |
| the same insert with an update hook installed | not available in `bun:sqlite` |

| leg | p50 | p90 |
| --- | --- | --- |
| write on the primary over HTTP | 374 µs | 492 µs |
| commit → applied on the replica | 265 µs | 323 µs |
| write forwarded through the replica | 404 µs | 494 µs |
| write, `ack: "replica"` | 379 µs | 442 µs |
| write, `ack: "quorum"` | 359 µs | 417 µs |

## Boundaries

### What holds

- A restore reproduces the target txid checksum for checksum, or fails loudly.
- `ack: "replica"` makes failover lossless; the old primary is fenced by epoch.
- The bus survives SIGKILL mid-flight in `bun run soak`, nothing lost.

### What is a judgement

- Default `ack: "fsync"` costs ~2.7x on one write against `ack: "local"`.
- Bus replication is asynchronous: failover RPO is tens of messages.
- Ordering is off by default; it costs throughput.

### What is not here yet

- CI gates on Linux only; macOS and Windows legs stopped 2026-09-26.
- The bus still runs on `bun:sqlite`, not `bql.sh/sqlite`.
- Kysely's `.stream()` is not implemented.

## Two commands to start

```sh
bun add bql.sh
bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts
```

## Guides

- [Exactly-once, in three tiers](https://github.com/TimMikeladze/bql/blob/main/packages/bus/docs/exactly-once.md) — What each tier guarantees and where the last stops.
- [The cluster and its leases](https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/c2-promotion.md) — Two primaries are impossible by the guard margin.
- [WAL shipping, byte by byte](https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/m3-wal.md) — Committed pages out of the -wal, self-verifying.

Reference: https://bql.sh/reference · Repository: https://github.com/TimMikeladze/bql
