# SQLite as a database server, and a bus

One open source package. `bql.sh` serves thousands of SQLite databases from one process, and `bql.sh/bus` is a durable message bus with leases, retries and a dead-letter path. Built on [Bun](https://bun.sh) and [SQLite](https://sqlite.org) with zero runtime dependencies, by [linesofcode](https://x.com/linesofcode).

Currently `bql.sh` v0.1.1 · Not on npm yet.

```sh
git clone https://github.com/TimMikeladze/bql && cd bql
```

## By the numbers

- **151** test files across both halves
- **0** runtime dependencies
- **49k** writes/s at 64 concurrent clients
- **54 µs** point read over HTTP, one node

## Reached by what you already run

Bun and SQLite underneath; Drizzle, Kysely and @libsql/client on top; REST, OpenAPI and GraphQL generated; backups to S3, R2 or MinIO; metrics for Prometheus and traces for OpenTelemetry; a Dockerfile and a fly.toml.

## Principles

- **Zero runtime dependencies.** Neither `package.json` has a `dependencies` field. The OTLP exporter and the JSON Schema validator are written, not installed.
- **The write path never waits.** A write checks a lease its own node holds, in memory. Raft and S3 shipping run beside the commit, never in front of it.
- **Refuse rather than guess.** Promotion answers `BEHIND` or `LEASE_HELD`. An unimplemented schema keyword fails registration. An integer past 2^53 is never rounded.

## One engine, four ways in

The same database answers a tagged template over HTTP, a synchronous call in your own process, and a raw `bun:ffi` driver. The bus runs its handler inside the SQLite transaction that acks it.

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

## Realtime from SQLite's own hooks

Read `/changes` as SSE, or subscribe with `db.live` and `.key("id")` for diffs. Every commit arrives as one `change` event, driven by the `preupdate`/`update` hooks rather than triggers.

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

## Every write answers with a txid

Each response names the transaction it landed in. The client's default `consistency: "ryw"` sends the highest one it has seen as `BQL-Min-Txid`, so a read never goes backwards.

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

## Replicas that forward writes

Start a second node with `--replica-of` and a shared `--cluster-secret`. It serves reads locally and forwards writes to the primary, answering with the primary's txid already applied.

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

## Promotion that refuses to guess

`bql promote` moves one database to a new primary and fences the old one by epoch. `--force` overrides exactly `STREAM_LIVE`, `LEASE_HELD` and `BEHIND`, and nothing else.

```sh
bql promote acme --url http://127.0.0.1:4502        # addresses the candidate, not the cluster
# acme promoted on http://127.0.0.1:4502: epoch 4, txid 918
# n2 takes acme at epoch 4, fencing n1
```

## Backed up to any bucket

Pass `--s3` and every database's log and snapshots ship continuously to S3, R2, Tigris or MinIO. A slow bucket makes the node report `behind`; it never slows a commit.

```sh
export BQL_S3_ACCESS_KEY_ID=… BQL_S3_SECRET_ACCESS_KEY=…
bun run src/cli.ts serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…

bql backup status acme
# acme → s3://backups/prod  shipped txid 4812  0 pending  caught up  2 snapshot(s), 31 segment(s)

bql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
```

## ORMs reach it unmodified

It speaks libsql's Hrana, so `@libsql/client` connects as is. `bql.sh/kysely` and `bql.sh/drizzle` map transactions and batches onto bql.sh's own routes.

@libsql/client, Hrana over HTTP:

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

## Subjects, fanned out on pull

`*` matches one token and `>` the rest, the NATS convention. Fan-out happens when a consumer pulls, so publishing is O(1) in subscriptions and `deliverFrom: "beginning"` reads last week.

```
orders.eu.created        a concrete subject
orders.*.created         matches orders.eu.created, not orders.eu.west.created
orders.>                 matches both
>                        everything
```

## Three tiers of exactly-once

At-least-once by default. `ack(id, { publish: [...] })` commits the ack and its outputs together, and `api.effect` records an external call alongside the ack. The last tier's window is named, not hidden.

| Tier | Guarantee | Requires |
| --- | --- | --- |
| **Transactional ack** | Exactly-once *processing* — the handler's writes and the ack are one SQLite transaction | Embedded mode (`createBus`), a synchronous handler |
| **Atomic read-process-write** | Exactly-once *within the bus* — `ack(id, { publish: [...] })` commits both or neither | Nothing; it is an option on `ack` |
| **Fenced, ledgered effects** | Tight effectively-once against the outside world | A destination with a conditional write, or an idempotent one |

## Schemas with computed compatibility

Register JSON Schema 2020-12 with `--compat backward`, bind it to a subject pattern in `warn` mode, then `enforce`. A version that breaks the declared mode is a 409 naming the pointer.

```sh
bql bus schema register order ./order.json --compat backward
bql bus schema bind 'orders.>' order --mode warn      # then --mode enforce
bql bus schema check order ./order-v2.json            # dry-run the compat check
```

## Proven with real processes

`bun run test:e2e` runs competing consumers, a SIGKILL mid-message, a poison message and a cross-process request. No mocks; `bun run soak --fault post-ack` crashes at chosen points.

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

`bun run bench` on an M5 Pro, as ratios against `bun:sqlite` because the ratio holds still. Writes inside a transaction are still slightly slower than `bun:sqlite`; the table says so.

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

- A restore replays through the replica's verifier: it reproduces the target txid checksum for checksum, or fails loudly.
- `ack: "replica"` makes a failover lossless; the old primary is fenced by epoch.
- The bus survives SIGTERM and SIGKILL mid-flight in `bun run soak`, with nothing lost.

### What is a judgement

- The default `ack: "fsync"` costs about 2.7x on a single write against `ack: "local"`.
- Bus replication is asynchronous; its failover RPO is measured in tens of messages.
- Ordering is off by default, because it costs throughput most work does not need.

### What is not here yet

- Not on npm yet; the release is blocked on one secret. Use a clone.
- The packages do not depend on each other yet; the transactional outbox is next.
- `bql.sh/bus` is not on the Windows CI gate, and Kysely's `.stream()` is not implemented.

## Start from a clone

```sh
git clone https://github.com/TimMikeladze/bql && cd bql
bun install
bun run db sqlite:build     # once per machine → packages/db/vendor/sqlite/libsqlite3.{dylib,so,dll}
bun run db test             # optional, and the fastest way to know the build is good
```

```sh
bun install

bun run typecheck          # the repository's scripts, then both halves
bun run test               # both halves
bun run bytes              # no raw control bytes in any tracked file

bun run db sqlite:build    # build the pinned libsqlite3 bql.sh needs
bun run db test
bun run bus test
bun run bus dev
```

## Guides

- [Exactly-once, in three tiers](https://github.com/TimMikeladze/bql/blob/main/packages/bus/docs/exactly-once.md) — What each tier guarantees, what it costs, and where the last one stops.
- [The cluster and its leases](https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/c2-promotion.md) — Why two primaries are impossible by the guard margin, not by hope.
- [WAL shipping, byte by byte](https://github.com/TimMikeladze/bql/blob/main/packages/db/docs/m3-wal.md) — Committed pages out of the -wal, as self-verifying records.

Reference: https://bql.sh/reference · Repository: https://github.com/TimMikeladze/bql
