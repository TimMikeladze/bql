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

Phase 0, milestone 2. The SQLite driver (`src/sqlite`) is implemented; the server, replication
and client layers are not yet.

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

## Tests

```sh
bun test
bun run typecheck
bun run bench
```
