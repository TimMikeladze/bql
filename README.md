# BunQL

SQLite as a multi-tenant database server for Bun. Thousands of small databases in one process,
their WAL frames streamed to replicas over a socket, backed up continuously to any S3-compatible
bucket, with realtime subscriptions driven by SQLite's own `preupdate`/`update` hooks rather than
triggers or SQL parsing. It speaks its own API and libsql's Hrana, so `@libsql/client`, Drizzle and
Kysely reach it unmodified.

The engine is a `bun:ffi` driver over a shared libsqlite3. It measures about twice as fast as
`bun:sqlite` on point reads and exposes what `bun:sqlite` does not: hooks, the authorizer, query
cancellation, per-connection limits, session changesets.

Zero runtime dependencies.

[**docs/api.md**](docs/api.md) is the API as built — every route, the Hrana surface, the WebSocket
protocol, the SSE formats, the SDKs, the CLI, every config key.
[docs/design.md](docs/design.md) is the design; [docs/next.md](docs/next.md) is the handoff.

## Status

| phase | scope | state |
|---|---|---|
| 0 | engine, tenancy, HTTP/WS/SSE, tokens, WAL log, snapshots, PITR, realtime, client, embedded, CLI | built |
| 1 | replica streaming and bootstrap, write forwarding, `ack` levels, read-your-writes across nodes, S3 shipper and restore, Hrana, Kysely and Drizzle | built |
| 2 | Raft control plane, per-database leases, promotion and failover, Linux packaging and CI | built |
| 2 | placement, `workers: N`, replica apply mechanism A | open |
| — | one operation model rendered as REST + OpenAPI + GraphQL (`bunql/core`, `/http`, `/openapi`, `/dataapi`, `/graphql`) | built and mounted |
| 3 | WAL-decoded logical CDC on a replica, snapshot reads across requests, per-tenant encryption, plan cache | later |

1312 tests across 105 files, green on macOS (arm64) and Linux (x64).

## Quickstart

```sh
bun run sqlite:build    # once per machine: builds the libsqlite3 the driver wants
bun start               # or: bun run src/cli.ts serve --dir ./data --port 4321
```

The first start generates an admin key and an Ed25519 signing key into `<dataDir>/keys.json`, and
prints the admin key once.

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

## The client

Modelled on `Bun.SQL`: a tagged template that binds its values, a result array carrying the
statement's metadata, subscriptions that are both emitters and async iterables. Browsers, Bun, Node
and Workers — no Bun or Node imports in it.

```ts
import { createClient } from "bunql/client"

const client = createClient({ url: "http://localhost:4321", token })
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

`consistency: "ryw"` (the default) remembers the highest txid it has seen per database and sends it
as `BunQL-Min-Txid`, so a read never goes backwards. `intMode: "bigint" | "string"` decides what an
integer beyond 2^53 becomes; the default refuses to round it. A write answered `307` or
`NOT_PRIMARY` is retried once against the node the answer names — and nothing else is retried, see
[docs/c2-promotion.md](docs/c2-promotion.md#retrying-a-write--the-sharp-edge).

## Embedded

```ts
import { BunQL } from "bunql"

const bq = await BunQL.open({ dir: "./data" })
const db = await bq.create("acme")                   // or bq.db("acme") for one that exists

await db.sql`create table todos(id integer primary key, title text)`.run()
db.sync.sql`insert into todos(title) values (${"fast path"})`.run()  // no promise at all
const rows = db.sync.sql`select * from todos`.all()

bq.on("commit", ({ db, txid }) => console.log(db, txid))
for await (const event of db.changes()) console.log(event)           // the bus, not HTTP

await bq.serve({ port: 4321 })                       // the same engine, now over HTTP/WS/SSE
```

`db` is the same interface the client exposes, so code written against one runs against the other.
`db.sync` is the escape hatch for hot loops. The embedded caller is the admin principal; tokens
start applying at `serve()`.

## ORMs

`bunql/kysely` is a Kysely dialect, `bunql/drizzle` a Drizzle driver. Both take a client `Db`, an
embedded `Db`, or `{url, token, db}`. `kysely` and `drizzle-orm` are optional peers.

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

await db.transaction().execute(async (trx) => {        // one BunQL transaction, not a loose begin
  await trx.updateTable("todos").set({ done: 1 }).where("id", "=", written.id).execute()
})
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
  await tx.update(todos).set({ done: 1 }).where(eq(todos.id, written.id))
})
```

Transactions, savepoints, `db.batch()` and both migrators run on BunQL's own transaction and batch
routes rather than on `begin`/`commit` sent as loose statements. Streaming is not implemented —
BunQL answers with whole result sets, so Kysely's `.stream()` says so.
[docs/r5-orm.md](docs/r5-orm.md) has the mapping and every limitation.

## A primary and a replica

Two `serve` commands sharing a cluster secret. The replica follows every database the primary
announces, serves reads locally, and forwards writes to the primary without the client knowing.

```sh
SECRET=$(openssl rand -hex 32)   # the two nodes prove this to each other; it is not a client token
bun run src/cli.ts serve --dir ./p --port 4501 --admin-key $KEY --cluster-secret $SECRET
bun run src/cli.ts serve --dir ./r --port 4502 --admin-key $KEY --cluster-secret $SECRET \
    --replica-of ws://127.0.0.1:4501/v1/replication

BUNQL_TOKEN=$KEY BUNQL_URL=http://127.0.0.1:4501 bun run src/cli.ts db create acme
```

A write sent to the **replica** comes back with the primary's txid, already applied locally:

```sh
curl -sD- -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d '{"sql":"insert into notes (body) values (@1)","args":["through the replica"]}' \
     http://127.0.0.1:4502/v1/db/acme/query
# BunQL-Role: replica
# BunQL-Primary: ws://127.0.0.1:4501/v1/replication
# BunQL-Txid: 2

curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:4502/v1/db/acme/replication
# {"role":"replica","connected":true,"applied":2,"lagTxid":0,"bootstrapping":false,...}
```

Both nodes answer libsql clients — the replica for reads, the primary for everything:

```ts
import { createClient } from "@libsql/client"

// The trailing slash matters: the client resolves `v2/pipeline` relative to this URL.
const primary = createClient({ url: "http://127.0.0.1:4501/v1/db/acme/", authToken: KEY })
const replica = createClient({ url: "http://127.0.0.1:4502/v1/db/acme/", authToken: KEY })

await primary.execute("insert into notes (body) values ('written by @libsql/client')")
await replica.execute("select id, body from notes order by id")  // already applied
await replica.execute("insert into notes (body) values ('nope')") // LibsqlError: NOT_PRIMARY
```

`ack: "replica"` holds a write on the primary until a replica has the record on disk; `quorum`
waits for a majority. Per request, per node default, or a header.

## Promotion and failover

A replica becomes the primary for one database. The old primary is fenced by an epoch it no longer
holds, and the demotion is persisted — a node restarted with no `--replica-of` at all still reads
`BunQL-Role: replica` and refuses writes.

```sh
bunql promote acme --url http://127.0.0.1:4502        # addresses the candidate, not the cluster
# acme promoted on http://127.0.0.1:4502: epoch 4, txid 918
# n2 takes acme at epoch 4, fencing n1
```

Promotion is refused rather than risked: `NO_COPY`, `GENERATION_MISMATCH`, `STREAM_LIVE`,
`ALREADY_PRIMARY`, `BEHIND`, `LEASE_HELD`. `--force` overrides exactly three of them —
`STREAM_LIVE`, `LEASE_HELD`, `BEHIND` — and nothing else. Clients see `307` + `Location` where the
node knows the new primary's HTTP base, `503 NOT_PRIMARY` + `BunQL-Primary` where it knows only a
replication URL, and a `moved` frame on a WebSocket.

With the default `ack: "local"` a failover can lose transactions the primary answered but no
replica received, bounded by replica lag. `ack: "replica"` makes it impossible.
[docs/c2-promotion.md](docs/c2-promotion.md) has the safety argument in full.

## The cluster

`[cluster]` puts a node in a small built-in Raft group holding membership, per-database placement
and per-database leases. Control plane only: **the write path never waits on it**. A write checks
the lease its own node already holds, in memory, against a monotonic clock — a `Map.get`, a
`performance.now()` and two comparisons. A single-row write is still 28.2 µs with it on.

```sh
bun run src/cli.ts serve --dir ./n1 --port 4321 --cluster-secret $SECRET \
    --cluster-peers n1=ws://10.0.0.1:4321,n2=ws://10.0.0.2:4321,n3=ws://10.0.0.3:4321 \
    --advertise ws://10.0.0.1:4321 --zone us-east-1a

bunql cluster --watch
```

```toml
[cluster]
enabled = false        # peers alone turn it on
peers = []             # ["n1=ws://a:4321", "ws://b:4321"]
advertise = ""         # also the HTTP base clients are redirected to
zone = ""
leaseTtlMs = 3000
leaseRenewMs = 1000
leaseGuardMs = 500     # the margin that makes two primaries impossible
electionTimeoutMs = 1500
heartbeatMs = 300
```

The leader grants a database's primary a lease; the holder renews it, and a holder that dies stops
renewing. The holder's deadline is `leaseTtlMs - leaseGuardMs` from the moment it **asked**, on its
own monotonic clock, and the leader will not grant elsewhere before its own `until` — so the window
in which two nodes could both write is negative by the guard. No node ever reads another node's
clock. `GET /v1/cluster` shows membership, term, leader and where each database lives.

`raft.ts` is a pure `step(input, now) -> Action[]` with no timers and no sockets; a seeded
simulator asserts all five Raft safety properties after every step. Standalone is unchanged:
`enabled = false` means no Raft in the process at all, and `--replica-of` keeps working as it does
today, manual promotion included.

## Back it up to a bucket

Point a node at any S3-compatible bucket — S3, R2, Tigris, MinIO — and every database's log and
snapshots ship to it continuously over `Bun.S3Client`. Shipping never blocks a commit: a slow or
unreachable bucket makes the node report `behind` while writes are answered at their usual latency,
and it catches up from the local log.

```sh
export BUNQL_S3_ACCESS_KEY_ID=… BUNQL_S3_SECRET_ACCESS_KEY=…
bun run src/cli.ts serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…

bunql backup status acme
# acme → s3://backups/prod  shipped txid 4812  0 pending  caught up  2 snapshot(s), 31 segment(s)

bunql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
```

The restore runs on a node that has never seen the database: it reads the manifest, downloads the
newest snapshot at or before the target, and replays the segments after it through the same
verifier a replica uses — so it either reproduces the target txid checksum for checksum or fails
loudly. The bucket layout is a documented contract ([docs/r3-storage.md](docs/r3-storage.md)).

## The CLI

```sh
bunql serve --dir ./data --port 4321
bunql serve --dir ./r --replica-of ws://primary:4321/v1/replication --cluster-secret $SECRET
bunql serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…
bunql db create acme                          # also: list, stat, delete, fork
bunql db fork acme-copy --from acme@4812      # a txid, or @2026-09-11T10:00:00Z
bunql snapshot acme
bunql restore acme --at 2026-09-11T10:00:00Z --into acme-recovered
bunql backup status acme                      # also: verify, generations
bunql checkpoint acme --mode TRUNCATE
bunql promote acme [--force]
bunql cluster [--watch]
bunql token --db acme --scope ro --ttl 30d --tables 'todos:r'
bunql exec acme --sql "select 1"
bunql shell acme                              # a REPL over the WebSocket protocol
```

Every command but `serve` talks to a running server: `--url` (or `$BUNQL_URL`) and `--token` (or
`$BUNQL_TOKEN`, else `$BUNQL_ADMIN_KEY`). `--json` prints the server's own body.

Configuration is `bunql.toml` in the working directory, then `BUNQL_*` in the environment. Every
key has an override named after its section and its key — `BUNQL_DATA_DIR`, `BUNQL_SERVER_PORT`,
`BUNQL_LIMITS_QUERY_TIMEOUT_MS` — plus the short forms `BUNQL_DIR`, `BUNQL_PORT`,
`BUNQL_ADMIN_KEY`. Every key and its default is in [docs/api.md](docs/api.md#configuration).

## Generated REST, OpenAPI and GraphQL

One description of an operation, rendered three ways. `src/core/` is a schema that *is* a JSON
Schema plus the `Operation`/`Registry` model; `src/http/` compiles a registry into the `routes`
table `Bun.serve` takes; `src/openapi/` emits OpenAPI 3.1 from the same registry; `src/dataapi/`
introspects a tenant's own tables into such a registry; `src/graphql/` generates an executable
schema from the OpenAPI document, resolving in-process through the same dispatcher.

```ts
import { DataApiCache } from "bunql/dataapi"

const cache = new DataApiCache({ defaultLimit: 100, maxLimit: 1000 })
const { schema, registry } = await cache.for("acme", exec)   // exec closes over src/server/exec.ts
```

Every identifier in the generated SQL comes from introspection and every value is a bound
parameter; nothing in `src/dataapi/` runs a statement itself, so the token's table ACLs, the
deadline, the row cap, the quota, the txid, the ack level and write forwarding are inherited from
`src/server/exec.ts` rather than reimplemented. `graphql` and `openapi-x-graphql` are optional
peers, loaded through `import()` at the first request that needs a schema.

The package publishes them as `bunql/core`, `bunql/http`, `bunql/openapi`, `bunql/dataapi` and
`bunql/graphql`, and the server mounts all three surfaces:

```http
GET    /v1/db/acme/api/users?name=like.ann*&order=name.asc&limit=20
POST   /v1/db/acme/api/users          { "name": "ann" }
GET    /v1/db/acme/openapi.json       that database's OpenAPI 3.1 document
POST   /v1/db/acme/graphql            { "query": "{ listUsers { id name } }" }
GET    /v1/openapi.json               this server's own API
```

`/v1/openapi.json` is emitted from the very list of operations the `Bun.serve` route table is
built from (`src/server/registry.ts`), so the document and the router cannot drift — `bun run
routes:check` fails if a route is added outside it. Those schemas are **enforced**, not only
published: every request is validated against the document, and a refusal is a `400` listing every
problem it found rather than the first. `[api]` and `[graphql]` configure the generated surfaces; a
surface that is off has no route at all rather than one that refuses. `docs/h6-mount.md` and
`docs/h8-validated-requests.md` are the as-built notes. GraphQL subscriptions over the existing
change feed are H7 in [docs/plan-surfaces.md](docs/plan-surfaces.md).

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

It needs a libsqlite3 built with `SQLITE_ENABLE_PREUPDATE_HOOK` and `SQLITE_ENABLE_SESSION`,
version 3.37.0 or newer — below that `sqlite3_changes64` is missing and the whole `dlopen` fails.

```sh
bun run sqlite:build          # needs a C compiler; writes vendor/sqlite/libsqlite3.{dylib,so}
```

That fetches a hash-pinned SQLite 3.53.4 amalgamation, compiles it with the flags the driver
resolves symbols against, verifies the result, and is then found automatically. Failing that, the
library comes from `BUNQL_SQLITE_LIB`, else the usual Homebrew and Linux paths. Homebrew's build
qualifies and Debian's and Ubuntu's do; no distro build carries `sqlite3_snapshot_*`.

Apple's `/usr/lib/libsqlite3.dylib` is the one to avoid, and not for the reason it looks like:
on macOS 26 it is 3.51.0 *with* `ENABLE_PREUPDATE_HOOK`, `ENABLE_SESSION` and `ENABLE_SNAPSHOT`,
so the driver loads it and every capability reports present. What it changes is a default —
`cache_size` is 2000 **pages** rather than upstream's -2000 KiB, four times the page cache — so
dirty pages reach the `-wal` at different moments and six WAL and snapshot tests fail on it.
`bun run scripts/sqlite.ts --explain` prints every flag and why.

## WAL shipping

`src/wal` reads committed transactions out of a primary's `-wal`, turns each into a self-verifying
record, keeps them in a segment log, and applies them to a replica. No triggers, no logical
replication, no `_bunql` bookkeeping table: the pages SQLite wrote are the pages the replica gets.
Snapshots, point-in-time restore and O(1) forks are built on the same log.

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

db.exec("insert into t(v) values ('hello')")
for (const txn of recorder.poll()) {
  applier.apply(decode(log.append(txn)).record)     // the bytes are also the wire format
}
```

Byte layouts are in [docs/m3-wal.md](docs/m3-wal.md).

## Measured

`bun run bench` on an M5 Pro, SQLite 3.53.4. The driver against `bun:sqlite`, 100k-row table, µs
per operation:

| op | bunql | bun:sqlite |
|---|---|---|
| point read by primary key | 0.77 | 1.77 |
| 100-row scan to objects | 8.98 | 6.86 |
| insert inside a transaction | 0.28 | 0.22 |
| the same insert with an update hook installed | 0.36 | not available |

Point reads win because the per-statement overhead is much lower. Wide scans lose because every
column costs one extra FFI call for `sqlite3_column_type`, which bun:sqlite does in native code.

A primary and a replica as two whole servers on loopback:

| leg | p50 | p90 |
|---|---|---|
| write on the primary over HTTP | 303 µs | 374 µs |
| commit → applied on the replica | 220 µs | 256 µs |
| write forwarded through the replica | 353 µs | 380 µs |
| write, `ack: "replica"` | 407 µs | 446 µs |
| write, `ack: "quorum"` | 383 µs | 410 µs |

Forwarding costs 49 µs over a write on the primary; waiting for a replica to have the record on
disk costs 104 µs. On one node over HTTP a point read is 48 µs and a write 79 µs, and the Hrana
pipeline is within a microsecond of both. Everything, read against the design §10 budget, is in
[docs/benchmarks.md](docs/benchmarks.md) — including the one missed target, 130k msg/s against a
150k WebSocket budget, which is writes serialising on the single writer.

Throughput, per process: ~220k reads/s on a socket, ~50k/s over HTTP, and 25–30k writes/s no
matter how many databases they are spread over. [docs/performance.md](docs/performance.md) takes
both hot paths apart stage by stage — SQLite is 29% of a write and 0.79 µs of a read — and says
what to do about each ceiling and how the thing scales.

## Tests

```sh
bun run sqlite:build  # the libsqlite3 everything below runs on; once per machine
bun test              # 1249 tests across 97 files
bun run typecheck
bun run bytes         # no raw control bytes in source
bun run routes:check  # docs/api.md covers every route
bun run bench         # every benchmark, then the design §10 table (--quick for fewer rounds)
```

`test/e2e/scenario.test.ts` is the single-node story end to end; `test/e2e/phase1.test.ts` is the
cluster one — a primary, two replicas, a bucket and a `@libsql/client` over real sockets. CI runs
all of it on `macos-latest` (arm64) and `ubuntu-latest` (x64) for every push and pull request to
`main`.
