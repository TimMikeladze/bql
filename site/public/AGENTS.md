# Using bql.sh from an agent

bql.sh is one npm package with two halves: `bql.sh` (SQLite as a multi-tenant database server, CLI `bql`) and `bql.sh/bus` (a durable message bus, CLI `bql bus`). Bun 1.4 or newer. Currently v0.2.0.

## Install

```sh
bun add bql.sh
bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts
```

## Minimal database client

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

## Minimal bus consumer

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

## Options that matter

| option | where | effect |
| --- | --- | --- |
| `ack` | db write, per request or node | `fsync` (default), `local`, `replica`, `quorum` |
| `consistency` | db client | `ryw` (default) sends `BQL-Min-Txid` so reads never go backwards |
| `intMode` | db client | `bigint` or `string`; the default refuses to round past 2^53 |
| `--replica-of` | `bql serve` | follow a primary, forward writes |
| `--s3` | `bql serve` | ship log and snapshots to a bucket |
| `ackWaitMs`, `maxAttempts` | bus subscription | lease length, retries before dead-letter |
| `ordered` | bus subscription | per-key FIFO; off by default |
| `[[outbox.rules]]` | `bql.toml` | publish committed row changes to a bus subject; needs `[replication] logicalChanges` |
| `tz`, `catchUp` | bus schedule | IANA zone; `latest` (default) or `none` for missed slots |
| `handlerTimeoutMs` | `BusConsumer` | stop a wedged handler holding its lease forever |

## Three mistakes that break it

1. Skipping the engine build, or reaching for a system libsqlite3. Run the by-path build above once (`bun run sqlite:build` in your project finds no such script); Apple's `/usr/lib/libsqlite3.dylib` loads but changes `cache_size` and fails WAL tests.
2. `await` inside a `consumeTransactional` handler. It must be synchronous, or another statement interleaves into the ack transaction.
3. Dropping the trailing slash from a `@libsql/client` URL (`/v1/db/acme/`). The client resolves `v2/pipeline` relative to it.

Full reference: https://bql.sh/reference (Markdown: https://bql.sh/reference.md).
