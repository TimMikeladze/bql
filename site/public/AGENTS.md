# Using bql.sh from an agent

bql.sh is one npm package. `bql.sh` is a SQLite database server for Bun with one database per tenant; its CLI is `bql`. `bql.sh/bus` is a message bus on the same engine; its CLI is `bql bus`. Bun 1.4 or newer. Currently v0.5.0.

## Install

Install the package, then build the libsqlite3 the driver loads. The build needs a C compiler and runs once per machine.

```sh
bun add bql.sh
```

```sh
bun add bql.sh
bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts
```

## Embedded

`Bql.open()` runs the engine in-process. No server, no key.

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

## Server and client

`bql serve` prints the admin key once on first start and saves it to `<dir>/keys.json`. Pass it as `BQL_ADMIN_KEY`.

```sh
bunx bql serve --dir ./srv --port 4321
# bql: generated an admin key and wrote it to ./srv/keys.json
# bql: admin key: <43 url-safe base64 characters, printed this once and never again>
# bql http://localhost:4321  node=bql-77779295  data=./srv
# bql: 0 database(s), maxOpen 1024, ack fsync
```

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

## Scoped tokens

Give browsers and untrusted callers a minted token, never the admin key.

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

## A static page with no server

An app gives a static HTML/JS page a public `pk_` key. The page trades it for a database of its own per visitor, kept in `localStorage` by visitor id, with no backend and no auth to write. `bql mcp` exposes the same setup as MCP tools.

```sh
echo '{ "origins": ["http://localhost:*"] }' > bql.json
bunx bql app create demo --config bql.json
# demo  pk_IH99cNv0gXDTkOOhkhweB3VWhA0kCUo0  shared=app-demo-shared
```

Every `${}` in `db.sql` and `db.live` is a bound parameter. `db.live` calls `rows` with the whole result now and after every commit that changes it.

```html
<script type="module">
  import { connect } from "https://cdn.jsdelivr.net/npm/bql.sh/packages/db/dist/web.js"

  const db = await connect("pk_IH99cNv0gXDTkOOhkhweB3VWhA0kCUo0", { url: "http://localhost:4321" })

  // The visitor's own database: the page runs its own DDL there.
  await db.sql`create table if not exists todos(
    id integer primary key,
    title text not null check (length(title) between 1 and 200),
    done integer not null default 0
  ) strict`

  await db.sql`insert into todos(title) values (${"write it"})`
  db.live`select id, title, done from todos order by id`.on("rows", render)
</script>
```

Or keep one object in sync: `push` is an atomic `json_insert` on the server, so two tabs pushing at once both land.

```js
const app = await db.state({ todos: [], theme: "dark" })
app.todos.push({ title: "write it", done: false })   // one json_insert on the server
app.$on("change", render)                              // after this tab's changes and other tabs'
```

Shared tables hold what visitors see of each other. Rows carry an author the server fills in and checks; only the author can update or delete a row.

```js
const posts = db.shared.table("posts")
await posts.insert({ text: "hello" })                 // author is filled in by the server
posts.orderBy("createdAt", "desc").limit(50).live(render)
// row.author === db.author for your own rows; only the author can update or delete a row
```

A write a visitor must not make directly goes through an action: SQL in the app config the server runs with its own rights, given checked input.

```js
await db.action("submitScore", { score: 4200, name: "ann" })
// rejects with code CONFLICT and the action's error when its `expect` does not hold
```

A waitlist needs no JavaScript: a form table takes plain HTML posts.

```html
<form method="post" action="http://localhost:4321/v1/forms/demo/signups">
  <input name="email" type="email" required>
  <input name="_gotcha" tabindex="-1" autocomplete="off" style="display:none">
  <button>Join</button>
</form>
<!-- the server sends the visitor back to this page with ?bql=ok or ?bql=error&reason=email -->
```

## Bus consumer

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

## Options

| option | where | effect |
| --- | --- | --- |
| `ack` | db write, per request or node | `fsync` (default), `local`, `replica`, `quorum` |
| `consistency` | db client | `ryw` (default) sends `BQL-Min-Txid` so reads never go backwards |
| `intMode` | db client | `bigint` or `string`; the default refuses to round past 2^53 |
| `--replica-of` | `bql serve` | follow a primary and forward writes to it |
| `--s3` | `bql serve` | ship the log and snapshots to a bucket |
| `ackWaitMs`, `maxAttempts` | bus subscription | lease length, retries before dead-letter |
| `ordered` | bus subscription | per-key FIFO; off by default |
| `[[outbox.rules]]` | `bql.toml` | publish committed row changes to a bus subject; needs `[replication] logicalChanges` |
| `handlerTimeoutMs` | `BusConsumer` | stop a handler that hangs while holding its lease |

## Mistakes that break it

- Skipping the engine build, or pointing at a system libsqlite3. `bun run sqlite:build` in your own project finds no such script; use the by-path command above. Apple's `/usr/lib/libsqlite3.dylib` loads but changes `cache_size`, and WAL tests fail on it.
- `await` inside a `consumeTransactional` handler. It must be synchronous, or another statement interleaves into the ack transaction.
- Dropping the trailing slash from a `@libsql/client` URL (`/v1/db/acme/`). The client resolves `v2/pipeline` relative to it.

Full reference: https://bql.sh/reference (Markdown: https://bql.sh/reference.md).
