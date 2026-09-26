<!-- README.md -->

# bql.sh

One package: SQLite as a multi-tenant database server for Bun, and the durable bus that runs work
against it.

```sh
bun add bql.sh
```

| Import | What it is |
| --- | --- |
| **[`bql.sh`](packages/db)** | The embedded database — `Bql.open()`, a whole server in your own process |
| `bql.sh/client` | The client: `sql`, `live`, transactions, `client.admin` |
| `bql.sh/context` | Bun/Node resolver for saved organizations, projects, and endpoints |
| `bql.sh/sqlite` | The `bun:ffi` driver over a pinned libsqlite3: hooks, the authorizer, killable statements, changesets |
| `bql.sh/server` | Serve it: WAL shipping, replicas, S3 backup, a Raft control plane |
| `bql.sh/kysely`, `bql.sh/drizzle` | A Kysely dialect and a Drizzle driver over any of the above |
| `bql.sh/tenant`, `/wal`, `/realtime`, `/core`, `/http`, `/openapi`, `/dataapi`, `/graphql`, `/protocol` | The layers underneath, each reachable on its own |
| **[`bql.sh/bus`](packages/bus)** | A durable message bus — subjects, consumer groups, leases, retries, a dead-letter path, three tiers of exactly-once |
| `bql.sh/bus/client` | Its client and consumer |

Two binaries: `bql` for the database, `bql bus` for the bus.

Run the CLI from this checkout, or link it globally so `bql` works from any directory:

```sh
bun run cli --help
bun run cli db list
bun run cli:link           # once; global bql follows this checkout's source
bql --help
```

Bun's global bin directory (normally `~/.bun/bin`) must be on your `PATH`.
Run `bun unlink` from this checkout to remove the global link.
Both entry points use `BQL_URL` for the server URL and `BQL_ADMIN_KEY` for its admin
key (or `BQL_TOKEN` for a scoped token; it takes precedence over `BQL_ADMIN_KEY`).

## Saved endpoints

Organize independently deployed servers into local organizations, projects, and named
endpoints. These are connection settings on your machine; database and bus tokens
still control access on each server.

```sh
bql org add personal
bql switch personal
bql project add myapp
bql project use myapp

# Enter the deployment's BQL_AUTH_ADMIN_KEY at the hidden prompt.
bql endpoint add preview --url https://your-preview.vercel.app --prompt-token
bql endpoint add production --url https://your-production.example --prompt-token
bql link --org personal --project myapp --endpoint preview

bql context                       # show target without revealing credentials
bql db list
bql db create myapp
bql exec myapp --sql 'SELECT 1'
bql db list --endpoint production # override for this command
bql endpoint use production       # change this checkout's endpoint
bql endpoint use preview --default # default for this project outside linked checkouts
```

`bql link` offers terminal selection when required context is missing. In scripts,
supply the organization, project, and endpoint explicitly. Links live in
`.bql/project.json`, work from subdirectories, and contain IDs rather than secrets.
Linking adds `.bql/` to `.gitignore`. `bql unlink` removes the nearest project link.
`bql switch` and `bql project use` change global defaults without changing existing links.

All three record types support `list`, `inspect`, `update`, and `remove`, with
`--json` output. Rename with `bql project update myapp --name new-name`; existing links
keep working. Removing a nonempty organization or project requires `--recursive` and
only removes local connection settings, never remote databases. Deleted selections
produce an error until you select or link another record.

For protected Vercel deployments, save that endpoint's **Protection Bypass for Automation**
secret separately from its BQL token:

```sh
bql endpoint update preview --prompt-vercel-bypass
bql db list --endpoint preview
```

The CLI sends `x-vercel-protection-bypass` on HTTP requests and socket handshakes.
Cloud runtimes still support `bql exec` rather than interactive `bql shell` sessions.
CLI requests reject HTTP redirects, and named database connections reject cross-origin
primary-movement retries; select the destination endpoint explicitly instead.

For CI, reference environment variables instead of saving secret values:

```sh
bql endpoint add ci --org personal --project myapp \
  --url https://your-preview.vercel.app \
  --token-env CI_BQL_TOKEN --vercel-bypass-env CI_VERCEL_BYPASS

# Set these secrets through your CI environment, then select the context:
BQL_ORG=personal BQL_PROJECT=myapp BQL_ENDPOINT=ci bql db list --json
```

The registry defaults to `$XDG_CONFIG_HOME/bql` or `~/.config/bql`. Override it with
`--config-dir` or `BQL_CONFIG_DIR` to provision isolated CI configuration. Saved secrets
live in an owner-only `credentials.json`, separately from the registry. Use
`--clear-token` or `--clear-vercel-bypass` to remove credentials. Changing a service URL
clears its old credential references unless you supply new ones in the same command.

Selection order is explicit `--url`; explicit `--org`/`--project`/`--endpoint`; matching
`BQL_ORG`/`BQL_PROJECT`/`BQL_ENDPOINT` variables; legacy `BQL_URL` (bus: `BUS_URL`);
checkout link; global selection; then localhost. `--url` cannot be combined with explicit
selection flags. Within named selection, flags override environment values, then linked
IDs, then global defaults; changing a parent discards incompatible child selections.
`--cwd` changes link lookup without changing the shell directory.

Named endpoints use their own credentials and ignore ambient `BQL_TOKEN`, `BQL_ADMIN_KEY`,
and `BUS_TOKEN`. Explicit `--token` and `--vercel-bypass` override credentials for one
command. Direct URL mode keeps the old environment-variable behavior and never inherits
saved credentials; its bypass variables are `BQL_VERCEL_BYPASS` and `BUS_VERCEL_BYPASS`.

Add an optional bus connection to the same endpoint with separate credentials:

```sh
bql endpoint update preview --bus-url https://your-bus.example --prompt-bus-token
# Add --prompt-bus-vercel-bypass if that service is also protected.
bql bus stats --endpoint preview
bql bus publish work.hello '{"hello":"world"}' --endpoint preview
bql bus follow --endpoint preview --data ./replica
```

Missing bus settings fail explicitly; database credentials are never reused for the bus.
Use `--clear-bus` to remove that connection. Local `serve`, key management, and storage
initialization do not require a saved remote context.

Bun/Node scripts can resolve the same connection; browser SDKs remain explicitly configured:

```ts
import { resolveContext } from "bql.sh/context"
import { createClient } from "bql.sh/client"

const connection = await resolveContext({ org: "personal", project: "myapp", endpoint: "preview" })
const client = createClient(connection)
try {
  console.log(await client.db("myapp").sql`SELECT 1`)
} finally {
  client.close()
}
```

`resolveContext` returns credentials for client construction: don't log its result.
Use the exported `redactContext` for diagnostics. SDK transport behavior remains the
SDK's own; the resolver does not install CLI redirect or WebSocket policies.

The database and the bus ship together because they were solving the same problems apart: storage,
replication, tenancy and a change feed. [docs/monorepo.md](docs/monorepo.md) is why, what moved, and
what comes next.

Bun 1.4 or newer. Zero runtime dependencies.

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

The repository keeps two source trees — `packages/db` and `packages/bus` — behind that one package,
so `bun run db <script>` and `bun run bus <script>` forward to the tree, and every script either half
already had still runs by its own name.

## The database

Thousands of small SQLite databases in one process, their WAL frames streamed to replicas over a
socket, backed up continuously to any S3-compatible bucket, with realtime subscriptions driven by
SQLite's own `preupdate`/`update` hooks rather than triggers or SQL parsing. It speaks its own API
and libsql's Hrana, so `@libsql/client`, Drizzle and Kysely reach it unmodified. The engine is a
`bun:ffi` driver over a pinned libsqlite3 that exposes what `bun:sqlite` does not: hooks, the
authorizer, query cancellation, per-connection limits, session changesets.

```sh
bun run db sqlite:build                      # once per machine; needs a C compiler
bun run db start                             # prints an admin key the first time, once
```

```ts
import { createClient } from "bql.sh/client"

const db = createClient({ url: "http://localhost:4321", token }).db("acme")

await db.sql`insert into todos(title) values (${"write it"})`.run()
const live = db.live`select * from todos where done = 0`.key("id")
live.on("diff", (e) => patch(e.added, e.removed, e.updated))
```

Phases 0, 1 and 2 are built, and so is the surfaces track: replica streaming and promotion, a Raft
control plane holding per-database leases off the write path, S3 shipping and point-in-time
restore, and one operation model rendered as REST, OpenAPI 3.1 and GraphQL. The control plane is on
the client too, under `client.admin`. [packages/db/README.md](packages/db/README.md) is the real
documentation; [packages/db/docs/api.md](packages/db/docs/api.md) is the API as built.

## The bus

Publish to a subject; durable subscriptions deliver to consumers with leases, retries, ordering and
a dead-letter path. One set of primitives covers a work queue, pub/sub and request/reply. Nothing
in the core knows what an agent is — agent patterns are conventions over subjects, which is what
keeps a plain background job queue a first-class use. It ships the library, the `bql bus` command
and a built dashboard.

```sh
bun run bus dev                              # bus, three consumers and the dashboard, on free ports

bql bus serve &
bql bus subscribe work 'work.>'
bql bus consume work --exec ./handle.sh &
bql bus publish work.resize '{"src":"a.png"}'
```

At-least-once by default, with three named tiers of exactly-once on top — a transactional ack in
embedded mode, atomic read-process-write inside the bus, and fenced ledgered effects against the
outside world. Fan-out happens on pull rather than on publish, so publishing is O(1) in the number
of subscriptions and a subscription created today can read last week. A JSON Schema registry with
computed compatibility checks, scoped tokens with affordable revocation, W3C `traceparent` end to
end, and epoch-fenced promotion over asynchronous log replication.
[packages/bus/README.md](packages/bus/README.md) is the real documentation.

## Together

Neither half imports the other yet. The coupling is the work after the move, in the order the
value lands: the bus swapping `bun:sqlite` for `bql.sh/sqlite`, then a commit hook publishing to
a subject as a transactional outbox with no dual-write window, then the bus's own replication and
backup giving way to WAL shipping. [docs/monorepo.md](docs/monorepo.md#the-work-after-this) has the
sequence and why each step is independently revertable.

## CI and releases

Every push and pull request to `main` runs both halves on Linux. macOS and Windows legs ran here
until 2026-09-26 and both were green — they were dropped for cost and wall-clock, not because they
stopped passing, and what they proved is written down in `packages/db/docs/e1-windows.md`,
`e2-windows-gate.md` and `c6-packaging.md` §1.

One package, one tag: `v0.1.0` publishes `bql.sh` with both halves in it, and the tag must match the
root `package.json` version or the release refuses. `bun run pack:check` is the gate the release runs
first — it packs, installs the tarball somewhere that knows nothing about this repository, builds
libsqlite3 from it, and then uses both halves and both binaries out of that install. Not on npm
yet.

---

<!-- packages/db/README.md -->

# bql.sh

SQLite as a multi-tenant database server for Bun. Thousands of small databases in one process,
their WAL frames streamed to replicas over a socket, backed up continuously to any S3-compatible
bucket, with realtime subscriptions driven by SQLite's own `preupdate`/`update` hooks rather than
triggers or SQL parsing. It speaks its own API and libsql's Hrana, so `@libsql/client`, Drizzle and
Kysely reach it unmodified.

The engine is a `bun:ffi` driver over a shared libsqlite3. It matches or beats `bun:sqlite` on
every operation the benchmark measures, and exposes what `bun:sqlite` does not: hooks, the
authorizer, query cancellation, per-connection limits, session changesets.

Zero runtime dependencies. It publishes as `bql.sh` — this tree is the database half of that one
package, and [`packages/bus`](../bus) is the bus half, under `bql.sh/bus`.

[**docs/api.md**](docs/api.md) is the API as built — every route, the Hrana surface, the WebSocket
protocol, the SSE formats, the SDKs, the CLI, every config key.
[docs/design.md](docs/design.md) is the design; [docs/next.md](docs/next.md) is the handoff.

## Status

| phase | scope | state |
|---|---|---|
| 0 | engine, tenancy, HTTP/WS/SSE, tokens, WAL log, snapshots, PITR, realtime, client, embedded, CLI | built |
| 1 | replica streaming and bootstrap, write forwarding, `ack` levels, read-your-writes across nodes, S3 shipper and restore, Hrana, Kysely and Drizzle | built |
| 2 | Raft control plane, per-database leases, promotion and failover, placement, replica apply mechanism A, `workers: N`, packaging and CI | built |
| — | one operation model rendered as REST + OpenAPI + GraphQL (`bql.sh/core`, `/http`, `/openapi`, `/dataapi`, `/graphql`) | built and mounted |
| 3 | WAL-decoded logical CDC on a replica, snapshot reads across requests, per-tenant encryption, plan cache | later |

1566 tests across 138 files, gating on Linux (x64). macOS and Windows legs ran green until
2026-09-26; `docs/e2-windows-gate.md` and `docs/c6-packaging.md` §1 are what they proved.

## Install

bql.sh needs **Bun 1.4 or newer** and a C compiler — the compiler once, to build the libsqlite3 the
driver loads (see [The driver](#the-driver) for why a system one will not do).

The package is `bql.sh`. It is **not on npm yet**; until the first release, use it from a clone:

```sh
git clone https://github.com/TimMikeladze/bql && cd bql
bun install
bun run db sqlite:build     # once per machine → packages/db/vendor/sqlite/libsqlite3.{dylib,so,dll}
bun run db test             # optional, and the fastest way to know the build is good
```

This tree is the database half of one package, `bql.sh` — [`packages/bus`](../bus) is the bus half,
under `bql.sh/bus`, and [docs/monorepo.md](../../docs/monorepo.md) is why they ship together. `bun run
db <script>` forwards from the root to this tree; from inside `packages/db`, every script still runs
by its own name.

Once published, `bun add bql.sh`, then build the engine **by path**:

```sh
bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts
```

`npm run` cannot reach a dependency's own scripts, so `bun run sqlite:build` in your project would
look for a script of yours by that name and find none — the path above is the contract. CI proves
it on the real tarball on every push (`bun run pack:check`, `docs/l7-tarball.md`).

## Getting started

Start a server. The first start generates an admin key and an Ed25519 signing key into
`<dataDir>/keys.json`, and prints the admin key once — copy it.

```sh
bun start                   # or: bun run src/cli.ts serve --dir ./data --port 4321
# bql: generated an admin key and wrote it to ./data/keys.json
# bql: admin key: <43 url-safe base64 characters, printed this once and never again>
# bql http://localhost:4321  node=bql-f22305a8  data=./data
# bql: 0 database(s), maxOpen 1024, ack fsync
```

Create a database and write to it. Every response carries the `txid` the write landed in.

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

Mint a scoped token — safe to hand to a browser, unlike the admin key — and watch the change feed.
Every commit arrives as one `change` event; DDL arrives as a `schema` event on the same stream.

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

`?wait=30000` turns the same route into a long poll for a client that cannot hold a stream open,
and `Last-Event-ID` resumes it without a gap. From here, [the client](#the-client) is the nicer way
to do all of the above, and [embedded](#embedded) skips the server entirely.

**A note on the default durability.** A write is answered once it is on this machine's disk
(`[durability] defaultAck = "fsync"`, the equivalent of Postgres's `synchronous_commit = on`). That
costs about 2.7x on a single write against `ack: "local"`, and concurrent writes more than earn it
back because group commit folds them — 64 clients writing at once go *faster* than they did before
the default changed. `ack: "local"` is the opt-out, per request or per node.

## The client

Modelled on `Bun.SQL`: a tagged template that binds its values, a result array carrying the
statement's metadata, subscriptions that are both emitters and async iterables. Browsers, Bun, Node
and Workers — no Bun or Node imports in it.

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

A subscription is an emitter *and* an async iterable, so either style works. `db.changes()` also
delivers a `schema` event when DDL runs — a `tables` filter does not hide it, because the shape you
decode rows into has moved whether or not it was your table that changed.

The control plane is on the same client, under `client.admin` — provisioning a database is not a
reason to leave the SDK and hand-write a `fetch`:

```ts
await client.admin.create("acme", { pageSize: 4096 })
await client.admin.fork("acme-copy", "acme", 4812)          // a txid, or an ISO-8601 instant
await client.admin.snapshot("acme")
await client.admin.restore("acme", { at: 4800, into: "acme-recovered" })   // a new database
const { token, jti } = await client.admin.mintToken({ dbs: ["acme"], scope: "ro" })
```

Nineteen methods, one for each route of the admin surface: lifecycle, dump and import, replication
and promotion, the backup bucket, tokens. It needs the admin key, and it is built on first use, so
a browser that only queries never constructs it.

`consistency: "ryw"` (the default) remembers the highest txid it has seen per database and sends it
as `BQL-Min-Txid`, so a read never goes backwards. `intMode: "bigint" | "string"` decides what an
integer beyond 2^53 becomes; the default refuses to round it. A write answered `307` or
`NOT_PRIMARY` is retried once against the node the answer names — and nothing else is retried, see
[docs/c2-promotion.md](docs/c2-promotion.md#retrying-a-write--the-sharp-edge).

## Embedded

The same engine in your own process — no server, no socket, no HTTP. `bq.serve()` puts the server
in front of it later without changing a line of the code above it.

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

`db` is the same interface the client exposes, so code written against one runs against the other.
`db.sync` is the escape hatch for hot loops. The embedded caller is the admin principal; tokens
start applying at `serve()`. The lifecycle calls are here too — `bq.create`, `bq.fork`, `bq.list`,
`bq.stat`, `bq.delete`, `bq.snapshot`, `bq.restore`, `bq.checkpoint` — with the same shapes
`client.admin` answers. Restoring from an S3 bucket stays on the server route, which is where the
store is built.

## ORMs

`bql.sh/kysely` is a Kysely dialect, `bql.sh/drizzle` a Drizzle driver. Both take a client `Db`, an
embedded `Db`, or `{url, token, db}`. `kysely` and `drizzle-orm` are optional peers.

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

Transactions, savepoints, `db.batch()` and both migrators run on bql.sh's own transaction and batch
routes rather than on `begin`/`commit` sent as loose statements. Streaming is not implemented —
bql.sh answers with whole result sets, so Kysely's `.stream()` says so.
[docs/r5-orm.md](docs/r5-orm.md) has the mapping and every limitation.

## A primary and a replica

Two `serve` commands sharing a cluster secret. The replica follows every database the primary
announces, serves reads locally, and forwards writes to the primary without the client knowing.

```sh
SECRET=$(openssl rand -hex 32)   # the two nodes prove this to each other; it is not a client token
bun run src/cli.ts serve --dir ./p --port 4501 --admin-key $KEY --cluster-secret $SECRET
bun run src/cli.ts serve --dir ./r --port 4502 --admin-key $KEY --cluster-secret $SECRET \
    --replica-of ws://127.0.0.1:4501/v1/replication

BQL_TOKEN=$KEY BQL_URL=http://127.0.0.1:4501 bun run src/cli.ts db create acme
```

A write sent to the **replica** comes back with the primary's txid, already applied locally:

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
`BQL-Role: replica` and refuses writes.

```sh
bql promote acme --url http://127.0.0.1:4502        # addresses the candidate, not the cluster
# acme promoted on http://127.0.0.1:4502: epoch 4, txid 918
# n2 takes acme at epoch 4, fencing n1
```

Promotion is refused rather than risked: `NO_COPY`, `GENERATION_MISMATCH`, `STREAM_LIVE`,
`ALREADY_PRIMARY`, `BEHIND`, `LEASE_HELD`. `--force` overrides exactly three of them —
`STREAM_LIVE`, `LEASE_HELD`, `BEHIND` — and nothing else. Clients see `307` + `Location` where the
node knows the new primary's HTTP base, `503 NOT_PRIMARY` + `BQL-Primary` where it knows only a
replication URL, and a `moved` frame on a WebSocket.

The default `ack` is `"fsync"`, so a write is on the primary's disk before it is answered. That
does not make failover lossless: with any node-local level a failover can lose transactions the
primary answered but no replica received, bounded by replica lag. `ack: "replica"` makes it
impossible.
[docs/c2-promotion.md](docs/c2-promotion.md) has the safety argument in full.

## The cluster

`[cluster]` puts a node in a small built-in Raft group holding membership, per-database placement
and per-database leases. Control plane only: **the write path never waits on it**. A write checks
the lease its own node already holds, in memory, against a monotonic clock — a `Map.get`, a
`performance.now()` and two comparisons. A single-row write at `ack: "local"` is still 24 µs with it on.

```sh
bun run src/cli.ts serve --dir ./n1 --port 4321 --cluster-secret $SECRET \
    --cluster-peers n1=ws://10.0.0.1:4321,n2=ws://10.0.0.2:4321,n3=ws://10.0.0.3:4321 \
    --advertise ws://10.0.0.1:4321 --zone us-east-1a

bql cluster --watch
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
export BQL_S3_ACCESS_KEY_ID=… BQL_S3_SECRET_ACCESS_KEY=…
bun run src/cli.ts serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…

bql backup status acme
# acme → s3://backups/prod  shipped txid 4812  0 pending  caught up  2 snapshot(s), 31 segment(s)

bql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
```

The restore runs on a node that has never seen the database: it reads the manifest, downloads the
newest snapshot at or before the target, and replays the segments after it through the same
verifier a replica uses — so it either reproduces the target txid checksum for checksum or fails
loudly. The bucket layout is a documented contract ([docs/r3-storage.md](docs/r3-storage.md)).

## The CLI

`bql` is the package's `bin`. From a clone, `bun run src/cli.ts <command>` is the same thing, or
`bun link` once to put `bql` on your `PATH`.

```sh
bql serve --dir ./data --port 4321
bql serve --dir ./r --replica-of ws://primary:4321/v1/replication --cluster-secret $SECRET
bql serve --dir ./data --s3 s3://backups/prod --s3-endpoint https://…
bql db create acme                          # also: list, stat, delete, fork
bql db fork acme-copy --from acme@4812      # a txid, or @2026-09-11T10:00:00Z
bql snapshot acme
bql restore acme --at 2026-09-11T10:00:00Z --into acme-recovered
bql backup status acme                      # also: verify, generations
bql checkpoint acme --mode TRUNCATE
bql promote acme [--force]
bql cluster [--watch]
bql token --db acme --scope ro --ttl 30d --tables 'todos:r'
bql exec acme --sql "select 1"
bql shell acme                              # a REPL over the WebSocket protocol
```

Every command but `serve` talks to a running server: `--url` (or `$BQL_URL`) and `--token` (or
`$BQL_TOKEN`, else `$BQL_ADMIN_KEY`). `--json` prints the server's own body.

Configuration is `bql.toml` in the working directory, then `BQL_*` in the environment. Every
key has an override named after its section and its key — `BQL_DATA_DIR`, `BQL_SERVER_PORT`,
`BQL_LIMITS_QUERY_TIMEOUT_MS` — plus the short forms `BQL_DIR`, `BQL_PORT`,
`BQL_ADMIN_KEY`. Every key and its default is in [docs/api.md](docs/api.md#configuration).

## Generated REST, OpenAPI and GraphQL

One description of an operation, rendered three ways. `src/core/` is a schema that *is* a JSON
Schema plus the `Operation`/`Registry` model; `src/http/` compiles a registry into the `routes`
table `Bun.serve` takes; `src/openapi/` emits OpenAPI 3.1 from the same registry; `src/dataapi/`
introspects a tenant's own tables into such a registry; `src/graphql/` generates an executable
schema from the OpenAPI document, resolving in-process through the same dispatcher.

```ts
import { DataApiCache } from "bql.sh/dataapi"

const cache = new DataApiCache({ defaultLimit: 100, maxLimit: 1000 })
const { schema, registry } = await cache.for("acme", exec)   // exec closes over src/server/exec.ts
```

Every identifier in the generated SQL comes from introspection and every value is a bound
parameter; nothing in `src/dataapi/` runs a statement itself, so the token's table ACLs, the
deadline, the row cap, the quota, the txid, the ack level and write forwarding are inherited from
`src/server/exec.ts` rather than reimplemented. `graphql` and `openapi-x-graphql` are optional
peers, loaded through `import()` at the first request that needs a schema.

The package publishes them as `bql.sh/core`, `bql.sh/http`, `bql.sh/openapi`, `bql.sh/dataapi` and
`bql.sh/graphql`, and the server mounts all three surfaces:

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
import { Database } from "bql.sh/sqlite"

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
library comes from `BQL_SQLITE_LIB`, else the usual Homebrew and Linux paths. Homebrew's build
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
replication, no `_bql` bookkeeping table: the pages SQLite wrote are the pages the replica gets.
Snapshots, point-in-time restore and O(1) forks are built on the same log.

```ts
import { Database } from "bql.sh/sqlite"
import { computeFull, decode, TxnLog, TxnRecorder, WalApplier } from "bql.sh/wal"

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

`bun run bench` on an M5 Pro, SQLite 3.53.4. The driver against `bun:sqlite`, 100k-row table.
**Ratios rather than microseconds**, because the ratio is what holds still — see
[docs/performance.md §8](docs/performance.md) for how much a busy machine moves an absolute number
here, and [docs/benchmarks.md](docs/benchmarks.md) for one coherent run's worth of them.

| op | bql vs `bun:sqlite` |
|---|---|
| point read by primary key | 1.02 – 1.14x |
| 100-row scan to objects | 1.17 – 1.39x |
| insert inside a transaction | 0.84 – 0.95x |
| the same insert with an update hook installed | not available in `bun:sqlite` |

Point reads win on per-statement overhead. **Scans used to lose and no longer do** — this README
carried "wide scans lose because every column costs one extra FFI call for `sqlite3_column_type`"
for months after it stopped being true. Writes inside a transaction are the one place `bun:sqlite`
is still slightly ahead.

A primary and a replica as two whole servers on loopback:

| leg | p50 | p90 |
|---|---|---|
| write on the primary over HTTP | 374 µs | 492 µs |
| commit → applied on the replica | 265 µs | 323 µs |
| write forwarded through the replica | 404 µs | 494 µs |
| write, `ack: "replica"` | 379 µs | 442 µs |
| write, `ack: "quorum"` | 359 µs | 417 µs |

Forwarding costs about 30 µs over a write on the primary. On one node over HTTP a point read is
54 µs and a write 137 µs at the default `ack: "fsync"` (96 µs at `ack: "local"`), and the Hrana
pipeline is within a few microseconds of both. Everything, read against the design §10 budget, is
in [docs/benchmarks.md](docs/benchmarks.md).

Throughput on one thread: ~220k reads/s on a socket, ~50k/s over HTTP, and **~49k writes/s at 64
concurrent clients** — up from ~29k before the durability defaults changed, because group commit
folds concurrent writes into one transaction and one `fdatasync`. A *serial* writer is still bound
by one transaction at a time, around 42k/s. `[server] workers = N` shards databases across worker
threads behind one port and lifts the thread bound as well: 8 databases, 64 sockets, single-row
writes went from 28 809 writes/s at one worker to 72 817 at six, 2.67x
(`bun run bench/workers.ts`, [docs/c4-workers.md](docs/c4-workers.md)) — **that ladder predates the
default change and has not been re-measured**, and `docs/performance.md` §5 says why.
[docs/performance.md](docs/performance.md) takes both hot paths apart stage by stage and says what
to do about each ceiling.

## Tests

```sh
bun run sqlite:build  # the libsqlite3 everything below runs on; once per machine
bun test              # 1496 across 125 files; BQL_WAL_NATIVE=0 proves the JavaScript fallback
bun run typecheck
bun run bytes         # no raw control bytes in source
bun run routes:check  # docs/api.md covers every route
bun run bench         # every benchmark, then the design §10 table (--quick for fewer rounds)
```

`test/e2e/scenario.test.ts` is the single-node story end to end; `test/e2e/phase1.test.ts` is the
cluster one — a primary, two replicas, a bucket and a `@libsql/client` over real sockets. CI runs
all of it on `macos-latest` (arm64), `ubuntu-latest` (x64) and `windows-latest` (x64) for every
push and pull request to `main`. All three gate; none is advisory.

---

<!-- packages/bus/README.md -->

# bql.sh/bus

A durable message bus for agents and ordinary work. Bun, SQLite, no runtime dependencies.

Publish to a subject; durable subscriptions deliver to consumers with leases, retries, ordering and a dead-letter path. Nothing in the core knows what an agent is — agent patterns are conventions over subjects, which is what keeps a plain background job queue a first-class use rather than an afterthought.

```sh
bql bus serve &
bql bus subscribe work 'work.>'
bql bus consume work --exec ./handle.sh &
bql bus publish work.resize '{"src":"a.png"}'
```

Three things at once, from one set of primitives:

| | |
| --- | --- |
| **Work queue** | Competing consumers on one subscription, at-least-once, leases and fencing |
| **Pub/sub** | Many subscriptions on one subject, each with its own cursor, so a message fans out |
| **Request/reply** | A durable response addressed by correlation — ask now, collect after a restart |

## Install

Bun 1.4 or newer.

The bus is a subpath of one package, `bql.sh`, and its binary is `bql bus`. Installing the package
installs both halves; nothing here requires the database.

```sh
bun add bql.sh
bunx bql bus serve &
bunx bql bus subscribe work 'work.>'
bunx bql bus publish work.resize '{"src":"a.png"}'
```

The package ships the library, the `bql bus` command and the built dashboard, so `serve` has a
UI with nothing else to install.

**Working on the bus itself** runs it from source instead. It lives in the bql.sh monorepo
alongside [`bql.sh`](../db) — see [docs/monorepo.md](../../docs/monorepo.md) for why:

```sh
git clone https://github.com/TimMikeladze/bql && cd bql
bun install                # the whole workspace, one lockfile

bun run bus build          # the library bundle and the dashboard
bun run bus dev
bun run bus test
```

`bun run bus <script>` forwards from the repository root to this package. From inside
`packages/bus`, every script still runs by its own name — `bun run build`, `bun run dev`.

`bun run dev` starts the bus, three consumer processes and the dashboard, choosing free ports rather than fighting for taken ones.

```sh
bun src/cli/index.ts publish work.slow '{"ms":2000}'
bun src/cli/index.ts request rpc.upper '"hello"'
bun src/cli/index.ts stats
```

![The dashboard](docs/images/dashboard.png)

**The dashboard is read-only until you hand it a token.** The one the bus injects is a `reader`
token — a page that can be opened is not a page that can dispatch work. Pausing, replaying,
purging and requeueing appear once you paste an admin token into **Operator actions**, which is
kept in `sessionStorage` and dies with the tab.

## Subjects

Dot-separated tokens. `*` matches exactly one token, `>` matches one or more trailing tokens — the NATS convention, because people already know it.

```
orders.eu.created        a concrete subject
orders.*.created         matches orders.eu.created, not orders.eu.west.created
orders.>                 matches both
>                        everything
```

## Fan-out happens on pull, not on publish

A subscription holds a cursor into the log. When a consumer asks for work, the bus reads forward from that cursor and creates deliveries for the messages that match.

Three consequences worth knowing:

- **Publishing is O(1)** in the number of subscriptions. Adding the fiftieth subscriber costs producers nothing.
- **A subscription created today can read last week**, with `deliverFrom: "beginning"` or any sequence number.
- **A wall of unrelated subjects cannot starve a subscription.** The cursor advances past messages it examined and did not match, so they are never looked at again. Matching *after* a `LIMIT` — the obvious implementation — is a liveness bug that only appears once you have more than a couple of subjects.

## Delivery

At-least-once by default, with **three named tiers of exactly-once** available on top —
[docs/exactly-once.md](docs/exactly-once.md) is the whole story, and the short version is below.

- A delivery is leased to one consumer for the subscription's `ackWaitMs`, with a monotonic `generation`. An ack or nack from a stale generation is rejected.
- An expired lease returns the delivery to the queue for another consumer, up to `maxAttempts`.
- Exhausting attempts **dead-letters onto an ordinary subject** (`dlq.<subscription>` by default) with the reason in the headers — so a DLQ is just another subscription, and a replay is just another publish. `bql bus dlq <subscription>` lists them and `dlq requeue <seq>` republishes one onto the subject it failed on, with the `dlq-*` headers stripped and `requeued-from` added. A requeued message is an ordinary new message with its own sequence number: if it fails again it dead-letters again, which is the honest outcome.
- `dedupeKey` is unique per workspace: publishing the same key twice returns the first message, and a deduplicated *request* is handed back the original correlation, so it waits on the answer that will actually arrive.
- Every envelope carries `idempotencyKey` (`<subscription>:<seq>`), stable across redeliveries, and `fence` (`<deliveryId>:<generation>`), which identifies *this attempt* — so a destination with a conditional write can reject a writer whose lease has moved on.
- **Retries are paced.** Per-subscription `backoff` with full jitter, applied on a nack *and* on a reclaimed lease. Full jitter rather than equal jitter, because the failure mode is a fleet retrying in lockstep.
- **Priority classes** (−2…2) and **delayed publish** (`delayMs` / `deliverAt`) — scheduled work and retry-later without a second system.
- **`maxInFlight`** caps what one subscription can have leased, so a misconfigured `prefetch` cannot take the whole backlog into a process that is about to die.
- **Poison quarantine**: a subscription whose dead rate crosses a threshold pauses itself and says so, instead of finishing the backlog into the DLQ at full speed.

**Exactly-once, in three tiers.** End-to-end exactly-once against an arbitrary external system is
not achievable and is not claimed. What is:

| Tier | Guarantee | Requires |
| --- | --- | --- |
| **Transactional ack** | Exactly-once *processing* — the handler's writes and the ack are one SQLite transaction | Embedded mode (`createBus`), a synchronous handler |
| **Atomic read-process-write** | Exactly-once *within the bus* — `ack(id, { publish: [...] })` commits both or neither | Nothing; it is an option on `ack` |
| **Fenced, ledgered effects** | Tight effectively-once against the outside world | A destination with a conditional write, or an idempotent one |

The first exists *because* of the single-writer design, not despite it. The third leaves one
window — a crash between "the external call succeeded" and "the result was recorded" — which is
[named and not hidden](docs/exactly-once.md#the-window-this-does-not-close).

An ack is also **idempotent for the consumer that made it**: a retry after a lost response
replays the original outcome instead of answering 409, which is how a lost response stops being a
duplicated side effect.

**Ordering.** `ordered: true` means only the *head* of a key may be leased — not merely "nothing
leased for this key", which let a message that was waiting out its retry backoff be overtaken by
the next one. Per-key FIFO, with unrelated keys still moving in parallel. Off by default, because
ordering costs throughput and most work does not need it.

When an ordered key's message dead-letters, `onFailure: 'block'` (the default) **stalls that key
and only that key** until an operator requeues or skips it. Letting the next message through is
exactly the reordering `ordered: true` was bought to prevent. `bql bus blocked <subscription>`
lists them; `unblock` or `dlq requeue` releases one.

**Cancellation.** `bql bus cancel <seq>` stops a message: every unfinished delivery of it moves to a fourth terminal status, `cancelled`, and no subscription will create a new one — including a subscription whose cursor has not reached it yet.

A consumer already running the work learns on its **next lease renewal**, which answers `{cancelled: true}` rather than failing. `BusConsumer` aborts the handler's `signal`, and `--exec` passes that signal to the child process, so the work actually stops rather than a row merely changing colour. Cancelled deliveries are neither acked nor nacked and are never retried.

Cancelling is the **publisher's** call, or an admin's — the bus records which token published each message. A consumer cannot cancel its own work, because a consumer that could make a message it disliked disappear is a very quiet way to lose work.

## Schemas

A registry of JSON Schema 2020-12 documents, bound to subject *patterns*, with an own validator —
no `ajv`, because the bus ships as one binary with no runtime dependencies.

```sh
bql bus schema register order ./order.json --compat backward
bql bus schema bind 'orders.>' order --mode warn      # then --mode enforce
bql bus schema check order ./order-v2.json            # dry-run the compat check
```

Two decisions carry the feature:

- **Registration rejects any keyword the validator does not implement.** A validator that quietly
  ignores `if`/`then` reports a document as valid when the rule the author wrote was never
  checked. A loud gap beats a quiet hole. `GET /api/schemas/keywords` lists what this build
  enforces.
- **Compatibility is computed, not documented.** `backward | forward | full | none`, checked
  structurally at registration against the previous version — a newly required property, a
  narrowed type, a shrunk enum, a tightened bound. Registering a version that breaks the declared
  mode is a 409 naming the pointer. Schemas without compat checking are paperwork.

`warn` publishes and stamps `schema-invalid` on the envelope, so a schema can be introduced
against live traffic. `enforce` answers 422 with the failing JSON Pointer. A message already in
the log cannot be un-published, so a delivery that fails an enforced schema **dead-letters** with
`dlq-reason: schema` — the only correct move once the write has happened.

Full details, including the keyword list: [docs/schemas.md](docs/schemas.md).

## Durability

- **Blob writes are atomic and fsynced** — temporary file, `fsync`, `rename`, `fsync` the
  directory — and the row records `body_sha256` and `body_bytes`, verified on read. A truncated
  blob is an error naming the handle, never a half-message handed to a handler.
- **A message whose blob is gone dead-letters** instead of failing every claim forever. The
  startup scan reports how many; the claim path handles the rest.
- **The WAL has a ceiling**: `wal_autocheckpoint`, plus a `wal_checkpoint(TRUNCATE)` on the sweep
  once it passes a threshold. `bql_bus_wal_bytes` and `bql_bus_db_bytes` are gauges.
- **A nearly full disk is a policy, not undefined behaviour.** Below the watermark `/api/publish`
  answers **507** with a machine-readable reason and `/ready` goes 503 — while claims and acks keep
  working, because a full disk is exactly when consumers need to drain.
- **A backup is not a backup until it has been restored.** `bql bus restore <dir> --data <dir>`
  restores and then *opens* the result; `bun run drill:restore` does the whole round trip and
  compares the log, the cursors and the blob bytes. `--until-seq` / `--until-time` stop the
  restore short of the end, for when the thing to undo is a batch somebody published rather than
  a disk that died.

## Observability

- **W3C `traceparent` end to end.** A publish that arrives without one starts a trace; every
  message carries it in its headers, and a reply or an `api.emit` continues it. A message crossing
  three consumers is one trace rather than three unrelated ones.
- **An OTLP/HTTP exporter in one ~200-line file**, behind `--otlp-endpoint`, written rather than
  depended on — the wire format is a public specification and `fetch` is built in. Fire-and-forget: a collector that is down costs dropped spans and a log line,
  never a 500.
- **Histograms that answer the real question**: publish and ack latency, **delivery age at claim**
  and **end-to-end age at ack**. Age is the number that says the bus is behind; a fast claim of an
  hour-old message is still an hour late.
- **Gauges**: per-subscription lag, DLQ depth, in-flight, oldest pending age; WAL, database and
  free-disk bytes; replication lag.
- **`/metrics` is no longer admin-only.** Admin scrapes the install; a workspace-pinned **reader**
  token gets only its own workspace's series and none of the install-wide disk numbers.

## Writing a consumer

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

Return normally and the message is acked. Throw and it is nacked, retried with the subscription's
backoff, and eventually dead-lettered. Throw `FatalError` to dead-letter immediately, because a
message this consumer can never handle should not be tried four more times.

The handler API also carries the exactly-once machinery:

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

**Shutdown hands work back.** `consumer.stop()` aborts in-flight handlers and nacks their
deliveries with *no* delay, so another consumer picks them up at once. Letting the leases expire
instead costs one `ackWaitMs` of dead time per in-flight message on every deploy, for nothing.

Set `handlerTimeoutMs` (or `--exec-timeout`) on anything that could hang. The loop renews the lease for as long as a handler is pending, so the mechanism that protects slow work protects stuck work just as well — without a timeout, a wedged handler holds its message indefinitely.

If the message carried a `reply-to`, whatever the handler returns becomes its response — an RPC consumer is an ordinary consumer that happens to return a value.

**Embedded mode** is the other direction: the bus in your own process, no socket, and the handler
writing to the same SQLite file — which is what makes the ack genuinely transactional.

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

**In any other language**, `--exec` is the whole integration: the message arrives on stdin, and stdout becomes the reply.

```sh
bql bus consume work --exec ./resize.sh --prefetch 4
```

## CLI

| | |
| --- | --- |
| `bql bus serve` | run the bus |
| `bql bus token --consumer id --publish 'a.>' --subscribe work` | mint a scoped token |
| `bql bus publish <subject> <json>` | publish |
| `bql bus request <subject> <json>` | publish and wait for a reply |
| `bql bus subscribe <name> <pattern>` | create a durable subscription |
| `bql bus consume <subscription> --exec CMD [--exec-timeout ms]` | run a consumer |
| `bql bus cancel <seq>` | stop a message; in-flight handlers abort |
| `bql bus dlq <subscription>` · `dlq requeue <seq…>` | inspect and requeue dead letters |
| `bql bus blocked <subscription>` · `unblock <sub> <key>` | ordered keys stalled behind a dead letter |
| `bql bus schema register <name> <file>` · `check` · `bind` · `list` | the registry |
| `bql bus keys rotate` · `keys retire <kid>` | signing keys, with an overlap window |
| `bql bus revoke <jti>` · `quota [set]` · `audit` | tenant safety |
| `bql bus follow <upstream>` · `promote --lease <path>` · `cluster` | continuity |
| `bql bus backup <dir>` · `restore <dir> --data <dir>` | a consistent copy, and the proof it restores |
| `bql bus tail` · `stats` | follow the log; subscriptions, consumers, lag |

## HTTP API

Every route is reachable as `/api/v1/...` as well as `/api/...`, and the version may arrive as an
`x-bus-api-version` header instead — so a broker and its clients can skew during a rolling deploy
rather than moving in lockstep. A client asking for a version this broker does not speak gets a
400 saying so, not a response it will misread.

| Method | Path | |
| --- | --- | --- |
| `POST` | `/api/publish` | `{subject, key?, headers?, body, dedupeKey?, replyTo?, ttlMs?}` |
| `POST` `GET` | `/api/subscriptions` | create; list |
| `POST` | `/api/subscriptions/:name/claim` | `{consumer, max, waitMs}` — long-polls |
| `POST` | `/api/subscriptions/:name/replay` `/purge` `/pause` | operator actions |
| `POST` | `/api/deliveries/:id/ack` `/nack` `/extend` | `/extend` answers `{cancelled}` too |
| `POST` | `/api/messages/:seq/cancel` · `/api/deliveries/:id/cancel` | stop work; publisher or admin |
| `POST` `GET` | `/api/requests[/:correlation]` | request/reply, both long-polling |
| `GET` | `/api/messages/:seq` · `/api/log[?subject=&newest=]` · `/api/stream` | the log; SSE refresh signal |
| `POST` | `/api/messages/:seq/requeue` | republish a dead letter onto its original subject |
| `POST` `GET` | `/api/consumers/register` · `/api/consumers` · `/api/stats` | fleet |
| `POST` | `/api/subscriptions/:name/unblock` · `GET /blocked` | ordered keys stalled behind a dead letter |
| `POST` `GET` | `/api/effects/claim` · `/api/effects/record` | the effect ledger (Tier 3) |
| `POST` `GET` | `/api/schemas` · `/check` · `/bindings` · `GET /keywords` | the registry |
| `POST` | `/api/tokens` · `/api/tokens/revoke` | mint; revoke by `jti` (admin) |
| `POST` `GET` | `/api/quota` · `GET /api/audit` | per-workspace ceilings; the audit trail |
| `GET` | `/metrics` | Prometheus text. Admin gets the install; a workspace-pinned **reader** gets only its own series |
| `GET` | `/health` · `/ready` | no token; `/ready` is 503 while draining |

## Operating it

[docs/operations.md](docs/operations.md) is the whole story: what to scrape, what to alert on,
how a backup is taken and restored, and what the fleet does afterwards. The short version:

```sh
bql bus serve --log-level info --log-format json
curl -H "Authorization: Bearer $ADMIN" localhost:4317/metrics
bql bus backup /backups/$(date +%F)
```

**SIGTERM drains.** The bus stops handing out work first — a claim answers empty rather than
holding the consumer for the rest of its long poll — then lets parked polls return, then finishes
requests in flight, and only then closes the database. `bun run soak --term-bus` is the check:
SIGTERM in the middle of five thousand messages, restart, nothing lost.

**Counters live in the store, gauges are read at scrape time.** A gauge only written when
something moves is stale exactly when it matters: an idle subscription with a thousand pending
deliveries would keep reporting whatever it last reported.

## Security

**Scoped tokens.** A token names its workspace, the subject patterns it may publish to, and the subscriptions it may claim from. Grants are patterns, so `orders.>` licenses everything beneath it. Verification is a signature check plus one **local index probe** — no network, no round trip — which is what makes revocation affordable without giving up what stateless tokens were worth.

**Revocation and rotation.** Every token carries a `jti`; `bql bus revoke <jti>` withdraws one, and the entry is dropped once the token would have expired anyway. Keys carry a `kid` and rotate with an overlap window — `bql bus keys rotate`, then `keys retire <kid>` once the old tokens have expired — so rotating does not invalidate the whole fleet at one instant.

**Rate limits and quotas.** Token-bucket limits on publish and claim (`--publish-rate`, `--claim-rate`) answer **429 with `Retry-After`**, and `--max-polls` caps how many long polls one token may park so a single consumer cannot occupy the server's poll budget. Per-workspace quotas (`bql bus quota set --messages --bytes --subscriptions`) exist because one tenant must not be able to fill the disk every other tenant's durability depends on. All off by default: a limit set without knowing the workload is how a healthy fleet gets throttled at 3am.

**Audit trail.** Append-only. Who published, cancelled, purged, replayed, paused, minted, revoked, bound a schema — with the token subject and a timestamp. `bql bus audit`. Operator actions without a trail are not operable, they are just powerful.

**Three scopes.** `admin` publishes anywhere, manages subscriptions and mints tokens. `consumer` publishes and claims within its grants. `reader` observes, and is what the dashboard is given — a page that can be opened is not a page that can dispatch work.

**Tenancy is enforced, not decorative.** `workspace` is a mandatory filter on every query, and a non-admin token is pinned to its own: it cannot name another one in a header.

**The signing key and admin token live in `.bql-bus/` at mode 0600**, not in argv where `ps` would show them.

**Transport is the operator's job.** A bearer token must not cross an untrusted network in plaintext: terminate TLS or use a tunnel. The bundled `Dockerfile` and `fly.toml` do exactly that — the platform terminates TLS, and the bus binds `0.0.0.0` only because a container must, never as a changed default. See [docs/operations.md](docs/operations.md#deploying).

## Verify

From `packages/bus`. Prefix any of them with `bun run bus` to run it from the repository root
instead.

```sh
bun run typecheck
bun test tests           # 137 across 13 files
bun run build
bun run test:e2e
bun run verify-pack
bun run build:binary      # one file per target, plus checksums
bun run test:compiled     # the same e2e, against the compiled binary
bun run drill:restore     # publish → backup → wipe → restore → compare
bun run drill:failover    # promote under load; the old leader is fenced out
```

`verify-pack` is the one that catches what the others cannot: it packs the tarball, installs it
into an empty directory, imports every advertised entry point and starts a bus from the installed
copy. A bundler can drop a module and still emit its name in the export list — that failure would
otherwise surface in someone else's install.

The end-to-end check is real processes and no mocks — competing consumers, fan-out, a consumer **SIGKILLed mid-message**, a poison message, and a request answered from another process:

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

And `bun run soak` is the contention check the unit tests cannot be: eight consumer processes racing on one subscription, 5000 messages, consumers SIGKILLed throughout, asserting every message was handled at least once and acked exactly once with nothing left pending. `--ordered` adds per-key FIFO under kills; `--kill-bus` kills the broker itself mid-flight.

```sh
bun run soak
bun run soak --ordered
bun run soak --kill-bus --repeat 10
bun run soak --poison 0.05              # backoff bounds the retry rate; nothing hot-loops
bun run soak --ordered --poison 0.05    # a dead key blocks, and nothing overtakes it
bun run soak --fault blob-write         # crash between the blob write and the row commit
bun run soak --fault mid-txn            # crash inside the publish transaction
bun run soak --fault post-ack           # crash after the ack commits, before the response
```

The `--fault` runs are deterministic crash points rather than a kill at a random moment, which is
the difference between proving the bus survives *a* crash and proving it survives *the* crash. The
`post-ack` run is the one that shows the idempotent ack earning its keep: the response is lost,
the consumer retries, and the message is **not** handled a second time.

`--ordered --poison` is what found a real ordering hole during this work: a message waiting out
its retry backoff is not leased, so "nothing leased for this key" let the next message overtake
it. The claim now moves only the *head* of a key.

## dagr

[dagr](https://github.com/TimMikeladze/dagr) is a workflow engine that runs one process against one SQLite journal, and says so plainly: multi-process execution is out of scope, because its single writer is load-bearing. `dagr-remote` closes that gap by putting this bus between the engine and its handlers — a step declares `runtime: remote`, the request goes onto a subject, and a consumer on another machine answers it.

```yaml
review:
  kind: task
  runtime: remote
  with:
    run: agent
    input: { prompt_file: ./prompts/review.md, model: claude-opus-5 }
```

That package lives in dagr's repository and depends on this one. **The bus has no dependency on dagr** — it is one client among many, and nothing about workflows leaks into the core.

## Boundaries

One process owns one SQLite file in WAL mode. Consumers never open it; they hold leases over HTTP, and every claim is a conditional `UPDATE` that only transitions *out of* `pending`, so two consumers racing for one delivery is safe rather than merely unlikely.

**Continuity, and what it is not.** `bql bus follow <upstream> --data ./replica` replicates the
**bus log** — not the SQLite WAL — so a follower rebuilds from `/api/log?after=N` plus the
subscription cursors. It survives a schema change, needs no frame parsing, and is one ~220-line
file rather than a project. Leases are deliberately *not* replicated: they are ephemeral, and a
promoted follower re-materializes deliveries from cursors through the same code path a cold start
already uses.

`bql bus promote --lease <path>` acquires a lease in storage both nodes can see and stamps an
incrementing **epoch**. The old leader, running with the same `--lease`, sees the epoch move and
**stops accepting writes**. Split brain is prevented by the fence, not by hoping the old node is
dead.

Replication is **asynchronous**, so a failover loses up to the current lag. That is a number, not
a hope: `bql-bus.replication.lag_seq` and `lag_ms` are gauges, `bun run drill:failover` prints
the RPO it measured, and on a laptop under continuous publish it lands in the **tens of
messages**. Alert on the gauges; the number you tolerate is the promise you are making.

Still one writer. This buys continuity and read scale-out, **not** write scale-out.

The honest ceiling: this is right for a fleet, and for infrastructure a dozen services depend on
it is a deliberate trade — one writer, asynchronous replication, an RPO you have to state. Raft,
multi-writer and synchronous replication are out of scope on purpose. The store sits behind a
seam so a different backend is a swap rather than a rewrite.

Also not implemented: consensus, active/active, or exactly-once against an arbitrary external
system — [Tier 3's window](docs/exactly-once.md#the-window-this-does-not-close) is the floor, not
a temporary state.

## Design

- [A message bus for agents and ordinary work](docs/superpowers/specs/2026-09-12-message-bus.md) — the current design and why it is shaped this way.
- [Finishing bql.sh/bus](docs/superpowers/specs/2026-09-13-finishing.md) — schema versioning, cancellation, operability, packaging and the decisions behind them.
- [Production bql.sh/bus](docs/superpowers/specs/2026-09-13-production.md) — schemas, exactly-once, durability and continuity: the plan, and what landed against it.
- [Exactly-once, in three tiers](docs/exactly-once.md) — what each tier guarantees, what it costs, and where the last one stops.
- [Schemas](docs/schemas.md) — the supported JSON Schema subset, and why an unsupported keyword is an error.
- [Running it](docs/operations.md) — metrics, logging, shutdown, backup and restore.
- [What was verified](docs/FINISHING-REPORT.md) — how each claim was checked, and what still is not.
