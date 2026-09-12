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

## Tests

```sh
bun test
bun run typecheck
bun run bench
```
