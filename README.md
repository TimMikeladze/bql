# BunQL

BunQL turns SQLite into a multi-tenant database server for Bun. It runs thousands of small
databases in one process, ships their WAL frames to replicas from userland, and drives realtime
subscriptions off SQLite's own `preupdate`/`update` hooks rather than triggers or SQL parsing.
The engine is a `bun:ffi` driver over a shared libsqlite3, which measures about twice as fast as
`bun:sqlite` on point reads and exposes the parts of the C API that `bun:sqlite` does not:
hooks, the authorizer, query cancellation, per-connection limits and session changesets.

The full design, including the replication and realtime protocols, is in
[docs/design.md](docs/design.md). The build order is in [docs/plan-phase0.md](docs/plan-phase0.md).

## Status

Phase 0, milestone 6. The SQLite driver (`src/sqlite`), WAL shipping (`src/wal`), tenancy
(`src/tenant`), realtime (`src/realtime`) and the HTTP/WebSocket/SSE server (`src/server`) are
implemented and usable end to end. The client SDK, the embedded API, the CLI and the Hrana
compatibility layer are not written yet.

## Quickstart

```sh
bun start                 # or: bun run src/server/main.ts
```

The first start generates an admin key and an Ed25519 signing key, writes both to
`<dataDir>/keys.json`, and prints the admin key once. Configuration is `bunql.toml` in the working
directory plus `BUNQL_*` overrides; every key is listed in [docs/design.md](docs/design.md) §9.4
and resolved by `src/server/config.ts`.

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

The route table, the WebSocket protocol and every deviation from the design are in
[docs/m5-server.md](docs/m5-server.md).

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

`bun run bench` on an M-series Mac, Homebrew SQLite 3.53.4, 100k-row table:

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
bun test
bun run typecheck
bun run bench         # driver against bun:sqlite
bun run bench:wal     # primary -> replica shipping latency
bun run bench:tenant  # the write path through the tenant owner
bun run bench:http    # point reads and writes over HTTP and WebSocket
```
