# BunQL API reference

The API as implemented at the end of phase 1: one primary, any number of replicas, continuous
backup to S3, and a libsql-compatible surface beside the native one. `docs/design.md` is the
proposal; this file is the thing that runs. Where the two differ, the difference is listed at the
end under [Differences from the design](#differences-from-the-design) rather than left for you to
find.

The route table below is generated from the server's own routing table — `bun run
scripts/routes.ts` prints it, and `bun run scripts/routes.ts --check` fails if this document falls
behind it.

**Contents** — [Conventions](#conventions) · [HTTP](#http-api) ·
[Hrana / libsql](#hrana--the-libsql-compatible-surface) · [WebSocket](#websocket-protocol) ·
[SSE](#sse-event-formats) · [Client SDK](#client-sdk) · [ORM adapters](#orm-adapters) ·
[Embedded](#embedded-api) · [CLI](#cli) · [Configuration](#configuration) ·
[Differences from the design](#differences-from-the-design)

---

## Conventions

### Addressing

Base path `/v1`. A database is named in the path: `/v1/db/{db}/…`. With
`[server] tenantFromHost = true`, routes that take no `:db` also accept the database from the
`x-namespace` header or from the first label of the `Host` header, so `acme.sql.example.com`
resolves to `acme`.

Database names are validated before they reach the filesystem; an invalid name is a `400`.

### Authentication

`Authorization: Bearer <token>`. Two kinds of principal:

| principal | token | can |
|---|---|---|
| admin | the admin key from `[auth] adminKey`, or the one generated on first start | everything, including the lifecycle routes |
| scoped | an Ed25519 (EdDSA) JWT minted by `POST /v1/tokens` | the databases and tables its claims name |

The claim shape is libsql's, so the same token will work through a future Hrana layer:

```json
{ "p": { "ro": { "ns": ["acme"] }, "rw": { "ns": ["acme-*"] } },
  "t": { "todos": "r", "users": "rw" },
  "jti": "…", "exp": 1789000000, "iat": 1786408000 }
```

`ns` entries are globs. `t` is the per-table ACL: `r`, `w` or `rw`, and a table the map does not
name is invisible to that token. `jti` drives the revocation list (`DELETE /v1/tokens/{jti}`),
`kid` selects the verifying key. Read-only tokens are safe to hand to a browser.

`EventSource` and browser `WebSocket` cannot set headers, so `/v1/db/{db}/changes`,
`/v1/db/{db}/live` and `/v1/ws` also accept `?token=`. Prefer the header, and on a socket prefer
the `hello` frame — a token in a URL is in every proxy log on the way.

On first start with no `[auth] adminKey` the server generates an admin key and an Ed25519 signing
key, writes both to `<dataDir>/keys.json` and prints the admin key once.

### Response headers

Every response carries these four:

| header | meaning |
|---|---|
| `BunQL-Txid` | the database's last txid as this request saw it |
| `BunQL-Node` | node identity; a hash of the hostname unless `[server] node` sets one |
| `BunQL-Role` | `primary`, or `replica` when `[replication] role = "replica"` |
| `BunQL-Duration-Us` | microseconds spent in the handler |

`BunQL-Primary` is on **every** response from a replica, not only on a `NOT_PRIMARY` error: it
carries `[replication] primary`, so a client that wants the write path never has to provoke an
error to find it. While `[server] cors` is on (the default) all five are listed in
`Access-Control-Expose-Headers`, and `OPTIONS` on any route is a preflight.

### Request options

Accepted as body fields on every statement-bearing request, and two of them as headers:

| option | header | values | default |
|---|---|---|---|
| `rows` | — | `"array"`, `"object"` | `"array"` |
| `maxRows` | — | positive integer; a result above it fails the request | `[limits] maxRows`, 10000 |
| `timeoutMs` | — | positive integer, clamped to the configured limit | `[limits] queryTimeoutMs` |
| `ack` | `BunQL-Ack` | `"local"`, `"fsync"`, `"replica"`, `"quorum"` | `[durability] defaultAck`, `local` |
| `minTxid` | `BunQL-Min-Txid` | integer; the request waits up to 2 s, then `425` | none |
| `consistency` | — | `"ryw"`, `"primary"`, `"any"` | `"ryw"` |

`consistency` is validated but changes nothing on a single node; `minTxid` does the work.

#### Durability levels

| `ack` | the answer waits for |
|---|---|
| `local` | SQLite's commit under `synchronous = NORMAL`, plus the log record. Survives a process crash. |
| `fsync` | an explicit `fdatasync` of the WAL and the log. Survives power loss on this node. |
| `replica` | `fsync` here, **and** one replica node reporting the record fsynced. |
| `quorum` | `fsync` here, **and** a majority of (primary + replicas) holding it: `floor((replicas + 1) / 2)` replica acks. |

The level is read from the body, then the `BunQL-Ack` header, then `[durability] defaultAck`, and
applies to `query`, `batch` and the WebSocket equivalents. An interactive transaction takes the
node's default at commit.

Two failures belong to the replica levels, and **neither rolls anything back**:

- `503 NO_REPLICAS` — no replica is attached to that database. Raised *before* the statement runs
  where it can be, so the usual misconfiguration costs no write at all. `[replication]
  ackWithoutReplicas = "allow"` opts into answering locally instead.
- `503 ACK_TIMEOUT` — the transaction committed and is durable on this node, but the acks did not
  arrive within `[replication] ackTimeoutMs`. The body carries the `txid` that committed, plus
  `acks` and `needed`. Retrying the statement would write it twice; read the txid back instead.

### Value encoding

Ordinary rows are plain JSON. Only values JSON cannot carry faithfully are tagged:

| SQLite | JSON |
|---|---|
| NULL | `null` |
| INTEGER, \|v\| ≤ 2^53 | `12` |
| INTEGER, beyond that | `{"$i": "9007199254740993"}` |
| REAL | `1.5` |
| REAL, non-finite | `{"$f": "inf"}`, `"-inf"`, `"nan"` |
| TEXT | `"ann"` |
| BLOB | `{"$b": "3q2+7w=="}` (standard base64, padded) |

The same tagging applies to arguments. `args` is a positional array, or an object whose keys bind
`:name`, `@name`, `$name` or the bare name.

### Errors

```json
{ "error": { "code": "SQLITE_CONSTRAINT_UNIQUE",
             "message": "UNIQUE constraint failed: users.email",
             "status": 409, "txid": 4813 } }
```

`failedIndex` is added for a batch, `primary` for `NOT_PRIMARY` and for anything a replica
forwarded, `acks` and `needed` for `ACK_TIMEOUT`. An error raised by the primary for a forwarded
write arrives under the primary's own code and status — a constraint violation is still a
`SQLITE_CONSTRAINT_*` with its 409, never a transport failure.

| code | status | when |
|---|---|---|
| `BAD_REQUEST` | 400 | malformed body, unknown option, bad SQL that SQLite reports as `SQLITE_ERROR` |
| `TOO_MANY_ROWS` | 400 | the result exceeded the request's `maxRows` |
| `UNAUTHENTICATED` | 401 | no token, a bad signature, an expired or revoked token |
| `NOT_AUTHORIZED` | 403 | the token's scope or table ACL refuses this |
| `DB_NOT_FOUND` | 404 | no such database |
| `TX_NOT_FOUND` | 404 | unknown or expired baton |
| `QUERY_TIMEOUT` | 408 | the deadline interrupted the statement |
| `CONFLICT` | 409 | importing over a name that exists |
| `RESET_REQUIRED` | 409 | the change ring cannot serve that `since` |
| `TX_BUSY` | 409 | another transaction held the writer for the whole `[limits] txWaitMs`; `Retry-After: 1` |
| `SQLITE_CONSTRAINT_*` | 409 | the constraint SQLite names |
| `PAYLOAD_TOO_LARGE` | 413 | body over `[limits] maxBodyBytes` or `maxImportBytes` |
| `TXID_NOT_AVAILABLE` | 425 | `minTxid` did not land within the wait |
| `BUSY` | 503 | `SQLITE_BUSY`/`SQLITE_LOCKED`, a snapshot in progress, or too many forwards in flight |
| `NOT_PRIMARY` | 503 | a write reached a replica that cannot forward it, or an admin write reached one at all; carries `BunQL-Primary` |
| `NO_REPLICAS` | 503 | `ack: "replica"`/`"quorum"` on a node with no replica attached |
| `ACK_TIMEOUT` | 503 | committed and locally durable, but not enough replica acks in time |
| `FORWARD_TIMEOUT` | 504 | the primary never answered a write a replica forwarded to it |
| `REPLICATION_DISABLED` | 403 | `GET /v1/replication` on a node with no `[replication] secret` |
| `QUOTA_EXCEEDED` | 507 | `max_page_count` reached, or `SQLITE_FULL` |
| `INTERNAL` | 500 | a bug; the client is told nothing more, the server logs the rest |

Any other `SQLITE_*` extended result code travels under its own name.

---

## HTTP API

| method | path | auth |
|---|---|---|
| `GET /healthz` | liveness | none |
| `GET /metrics` | Prometheus exposition | admin, when an admin key exists |
| `GET /readyz` | readiness | none |
| `GET /v1/db` | list databases | admin |
| `POST /v1/db` | create or fork | admin |
| `DELETE /v1/db/:db` | delete | admin |
| `GET /v1/db/:db` | stats | `ro` |
| `POST /v1/db/:db/batch` | many statements | `ro`, `rw` for the ones that write |
| `GET /v1/db/:db/backup` | S3 shipper position and manifest | admin |
| `GET /v1/db/:db/backup/generations` | every generation in the bucket | admin |
| `POST /v1/db/:db/backup/verify` | check the bucket can restore to a txid | admin |
| `GET /v1/db/:db/changes` | change feed, SSE or long poll | `ro` |
| `POST /v1/db/:db/checkpoint` | manual checkpoint | admin |
| `GET /v1/db/:db/dump` | stream the SQLite file out | admin |
| `POST /v1/db/:db/import` | stream a SQLite file in | admin |
| `GET /v1/db/:db/live` | live query, SSE | `ro` |
| `GET /v1/replication` | node-to-node stream (WebSocket) | cluster secret, in-band |
| `POST /v1/db/:db/query` | one statement | `ro`, `rw` when it writes |
| `GET /v1/db/:db/replication` | txid, epoch, checksum, snapshot, replicas | `ro` |
| `POST /v1/db/:db/restore` | point-in-time restore | admin |
| `POST /v1/db/:db/snapshot` | force a snapshot | admin |
| `POST /v1/db/:db/tx` | open a baton transaction | `rw` |
| `POST /v1/db/:db/tx/:tx` | one statement in it | `rw` |
| `POST /v1/db/:db/tx/:tx/commit` | commit | `rw` |
| `POST /v1/db/:db/tx/:tx/rollback` | roll back | `rw` |
| `POST /v1/tokens` | mint a scoped token | admin |
| `DELETE /v1/tokens/:jti` | revoke one | admin |
| `GET /v1/ws` | WebSocket upgrade, sub-protocol `bunql.v1` | any |
| `GET /v2`, `GET /v3` | Hrana version probe | none |
| `POST /v2/pipeline`, `POST /v3/pipeline` | Hrana pipeline, database from `x-namespace`/`Host`/`default` | `ro`, `rw` when it writes |
| `POST /v3/cursor` | Hrana cursor, newline-delimited | as above |
| `GET /v1/db/:db/v2`, `GET /v1/db/:db/v3` | the same probe, database in the path | none |
| `POST /v1/db/:db/v2/pipeline`, `POST /v1/db/:db/v3/pipeline` | the same pipeline | `ro`, `rw` when it writes |
| `POST /v1/db/:db/v3/cursor` | the same cursor | as above |
| `GET /v1/db/:db/hrana` | Hrana WebSocket, sub-protocol `hrana3` or `hrana2` | in-band `hello` |

An unknown path is a `404` in the error shape above. An unsupported method on a known path is a
`405` from Bun's router.

### `POST /v1/db/:db/query`

One statement. Whether it needs `rw` is decided by `sqlite3_stmt_readonly` after preparing it, not
by looking at the SQL.

```http
POST /v1/db/acme/query
Authorization: Bearer <token>
Content-Type: application/json

{ "sql": "select id, name from users where id > ?", "args": [10], "rows": "array" }
```

```json
{ "columns": ["id", "name"],
  "types": ["INTEGER", "TEXT"],
  "rows": [[11, "ann"], [12, "bob"]],
  "rowsAffected": 0,
  "lastInsertRowid": null,
  "txid": 4812,
  "durationUs": 31,
  "vmSteps": 12 }
```

`types` are the declared column types upper-cased, falling back to the storage class of the first
non-null value. `vmSteps` is `sqlite3_stmt_status(SQLITE_STMTSTATUS_VM_STEP)` — the cost unit for
quotas and billing, since SQLite has no native `rows_read`.

Writes use the same route. `rowsAffected` and `lastInsertRowid` fill in and `txid` advances.

`lastInsertRowid` is **the rowid this statement inserted**, or `null`. It is not the connection's
counter read back: the prepared statement carries what SQLite's authorizer said about its program
at compile time, and for a statement that can insert, the counter is zeroed before the step, so a
non-zero value afterwards is proof SQLite set it *here*. What that buys, in cases where reading
the number either side of the step gets it wrong:

- an insert whose rowid repeats the previous one on the same pooled writer — row 1 of one table
  and then row 1 of another — reports the rowid rather than `null`;
- `INSERT OR REPLACE` onto the rowid it just wrote reports that rowid;
- an `UPDATE`, a `DELETE` and a DDL statement report `null`, whatever the connection inserted
  earlier;
- so do the statements SQLite deliberately sets no rowid for: an insert into a `WITHOUT ROWID`
  table, an upsert that took the `DO UPDATE` branch, and an insert performed inside a trigger
  (SQLite's counter reverts when the trigger program ends, so there is nothing to report).

A statement that calls `last_insert_rowid()` itself reads the counter as an input, so the counter
is left alone under it and the older "did the number move" test applies to that statement only.
Inside a batch or a transaction the value a previous statement set is still visible to the next
one, which is what makes `insert into child (parent) values (last_insert_rowid())` work.

A transaction that changes no pages does not advance the txid and is not an error.

### `POST /v1/db/:db/batch`

```http
POST /v1/db/acme/batch
{ "atomic": true,
  "statements": [ { "sql": "insert into users(name) values (?)", "args": ["ann"] },
                  { "sql": "select last_insert_rowid()" } ] }
```

```json
{ "results": [ { "columns": [], "rows": [], "rowsAffected": 1, "lastInsertRowid": 13, "…": "…" },
               { "columns": ["last_insert_rowid()"], "rows": [[13]], "…": "…" } ],
  "txid": 4813 }
```

`atomic` defaults to `true`: one write transaction, rolled back as a whole. A failure answers with
the error body plus `failedIndex` naming the statement that failed. With `atomic: false` each
statement is independent and the results array is as long as the statements that ran.

### Transactions over HTTP (baton)

```http
POST /v1/db/acme/tx                  { "mode": "immediate" }
→ 200 { "tx": "b7f3…", "expiresInMs": 5000 }

POST /v1/db/acme/tx/b7f3…            { "sql": "update users set name = ? where id = ?", "args": ["cy", 1] }
→ 200 { … a normal query result … }

POST /v1/db/acme/tx/b7f3…/commit     → { "txid": 4814 }
POST /v1/db/acme/tx/b7f3…/rollback   → { "txid": 4813 }
```

`mode` is `deferred`, `immediate` (default) or `exclusive`. The baton is 128 random bits and
identifies the database on its own, so the statement routes do not re-check the name.

An open transaction holds the tenant's single writer, so there is one per database. A second
`POST /v1/db/{db}/tx` **waits in line** for up to `[limits] txWaitMs` (5 s) and is answered
`409 TX_BUSY` with `Retry-After: 1` only if the writer is still busy when that expires — so two
concurrent request handlers on one database both get served instead of one of them failing on
arrival. Waiters are served in the order they arrived. A plain write (not a transaction) is still
refused `409` at once: it is a single statement and has nothing to hold a place in a queue for.

The transaction is rolled back after `[limits] txIdleTimeoutMs` (5 s) without a statement, when the
WebSocket that opened it closes, and — for one a replica forwarded — when that replica's
replication socket drops. A failed statement leaves the transaction usable.

### `GET /v1/db/:db/changes`

The row-level change feed. Server-sent events by default; adding `wait` turns it into the
long poll instead. `Accept` only decides the case where a client asked for `application/json` and
nothing else — a plain `*/*` gets the stream.

| parameter | meaning |
|---|---|
| `tables` | comma-separated; only these tables |
| `since` | replay from this txid; `Last-Event-ID` does the same |
| `include` | `none`, `pk` (default), `row`, `row+old` |
| `wait` | long-poll instead of streaming; milliseconds, capped at 60000 |
| `token` | the bearer token, for `EventSource` |

```
GET /v1/db/acme/changes?tables=users,orders&since=4800&include=row

retry: 1000
: bunql

id: 4813
event: change
data: {"txid":4813,"changes":[{"table":"users","op":"insert","rowid":13,"pk":{"id":13},"row":{"id":13,"name":"cy"}}]}

: ping
```

`include` is a floor, not a filter: the capture level is per database and the engine runs at the
highest level any subscriber asked for, so a subscriber that asked for `pk` may receive `row`.

The long poll returns a JSON array of the same `change` objects:

```http
GET /v1/db/acme/changes?since=4800&wait=30000
→ 200 [ {"txid":4801,"changes":[…]}, … ]
   BunQL-Txid: 4805
   Cache-Control: public, max-age=31536000, immutable     ← a `since` in the past is immutable
```

A `since` the ring no longer holds is `409 RESET_REQUIRED` on the long poll, and a `reset` event
on the stream.

### `GET /v1/db/:db/live`

A query that re-runs when a commit touches what it read, over SSE.

| parameter | meaning |
|---|---|
| `sql` | required |
| `args` | JSON array or object |
| `key` | column identifying a row; switches the feed from `rows` to `diff` |
| `rows` | `array` (default) or `object` |
| `maxRows` | truncates, rather than failing as it does on `/query` |
| `token` | the bearer token |

```
GET /v1/db/acme/live?sql=select%20*%20from%20todos%20where%20done=0&key=id

event: rows
data: {"txid":4813,"columns":["id","title","done"],"rows":[[1,"write it",0]]}

event: diff
data: {"txid":4820,"added":[[2,"and this",0]],"removed":[],"updated":[]}
```

The first event is always `rows` — a diff needs a previous result, and on subscribe there is none.
Later events are `diff` when `key` was given and `rows` when it was not.

### Lifecycle and admin

```http
POST /v1/db      { "name": "acme", "pageSize": 4096, "quotaBytes": 0 }              → 201 stats
POST /v1/db      { "name": "acme-copy", "from": { "db": "acme", "at": 4812 } }      → 201 stats
```

`from` forks, which is O(1) where the filesystem reflinks. `at` is a txid, or a timestamp: an
ISO-8601 string or an epoch-millisecond number at or above 1e12, resolved against the log, whose
records each carry a microsecond timestamp. A time older than the log is a `400` naming what the
log still holds.

```http
GET /v1/db     → { "databases": [ { "name": "acme", "txid": 4812, "epoch": 0, "pageSize": 4096,
                                    "quotaBytes": 0, "createdAtMs": 1789…, "open": true } ] }

GET /v1/db/acme
→ { "name": "acme", "sizeBytes": 81920, "walBytes": 0, "logBytes": 12043,
    "txid": 4812, "epoch": 0, "checksum": "1734…", "openConns": 2,
    "liveQueries": 2, "subscribers": 5, "lastSnapshotTxid": 4800, "replicas": [] }

DELETE /v1/db/acme  → { "name": "acme", "deleted": true, "trash": "<dataDir>/trash/acme-1789…" }
```

`DELETE` moves the directory to `trash/` and tombstones the catalog row; the files themselves are
removed later, by the sweep, once they are older than `[durability] retention` (default `7d`). The
sweep runs when the node starts and then every `[durability] trashSweepIntervalMs` (default one
hour); `retention = "0"` keeps a deleted database for ever, which is what phase 0 and phase 1 did.
Only a directory the server itself named — `<name>-<ms>` — is ever removed, so anything an
operator puts in `trash/` by hand stays where it is.

**On a replica, `POST /v1/db`, `DELETE /v1/db/:db`, `POST /v1/db/:db/restore` and
`POST /v1/db/:db/import` answer `503 NOT_PRIMARY` with `BunQL-Primary`**, the same shape a
statement write gets when it cannot be forwarded. A replica's files are the primary's, and acting
on them locally would create a database the cluster never hears about or delete the copy the
applier needs. Reads, `POST /v1/tokens`, and the node-local `snapshot` and `checkpoint` routes work
on a replica as normal.

```http
POST /v1/db/acme/snapshot   {}
→ { "snapshotId": "00000000000000004812.db", "txid": 4812, "bytes": 81920,
    "checksum": "1734…", "createdAtMs": 1789… }

POST /v1/db/acme/restore    { "at": 4800, "into": "acme-recovered" }
→ 201 { "name": "acme-recovered", "txid": 4800, "from": "acme", "at": 4800 }

POST /v1/db/acme/restore    { "from": "s3", "at": 4800, "into": "acme-recovered" }
→ 201 { "name": "acme-recovered", "from": "acme", "source": "s3", "bucket": "backups",
        "prefix": "bunql/", "generation": "fd4312b8c8655fc7", "txid": 4800,
        "fromTxid": 4750, "applied": 50, "objects": 2, "bytes": 98304 }

POST /v1/db/acme/checkpoint { "mode": "TRUNCATE" }
→ { "mode": "TRUNCATE", "busy": false, "log": 0, "checkpointed": 0, "walBytes": 0, "txid": 4812 }

GET  /v1/db/acme/replication                                          (on a primary)
→ { "db": "acme", "txid": 4812, "epoch": 0, "checksum": "1734…",
    "lastSnapshot": { "txid": 4800, "bytes": 81920, "at": 1789… },
    "s3": { "shippedTxid": 4812, "pendingRecords": 0, "behind": false, … },
    "role": "primary",
    "replicas": [ { "node": "repl-1", "stream": 1, "txid": 4812, "lag": 0,
                    "ackedAt": 1789…, "fsynced": true } ] }

GET  /v1/db/acme/replication                                          (on a replica)
→ { "db": "acme", "txid": 4812, "epoch": 0, "checksum": "1734…", "lastSnapshot": null,
    "role": "replica", "primary": "wss://…/v1/replication", "connected": true,
    "applied": 4812, "lagTxid": 0, "bootstrapping": false, "lastError": null }
```

`restore` always builds a **new** database — `into` names it, and without it the name is
`<db>-restore-<txid>` (`<db>-restore` for a bucket restore). Restoring in place would leave the
log holding records past the restore point that no longer describe the file.

`{"from": "s3"}` restores from the backup bucket instead of the local log, so the database being
restored need not exist on this node at all — which is what makes it a recovery path rather than a
rewind. `at` is a txid or a timestamp, as above; omitted, it means the newest point the bucket
holds. `bucket`, `prefix` and `generation` override the node's own `[s3]` settings so one node can
read another's backup; credentials are always the node's and never travel in the request.

The `s3` block on `GET /v1/db/{db}/replication` is the shipper's state, in full:
`{bucket, prefix, endpoint, generation, shippedTxid, pendingRecords, pendingBytes, behind,
lastError, lastShipMs, lastShipAtMs, bytesShipped, errors, snapshots, segments,
lastSnapshotTxid}`. It is `null` on a node with no bucket configured.

### S3 backup

Continuous backup of every database's log and snapshots to any S3-compatible bucket — AWS S3,
Cloudflare R2, Tigris, MinIO — over `Bun.S3Client`. Turned on by `[s3] bucket`. The bucket layout
is a **contract**, specified in full in `docs/r3-storage.md` §1; a restore depends on it and
nothing else.

```http
GET  /v1/db/acme/backup
→ { "db": "acme", "enabled": true, "bucket": "backups", "prefix": "bunql/",
    "endpoint": "https://…", "retention": "30d",
    "shipper": { "shippedTxid": 4812, "pendingRecords": 0, "pendingBytes": 0,
                 "behind": false, "lastError": null, "lastShipMs": 7,
                 "lastShipAtMs": 1789…, "bytesShipped": 4203913, "errors": 0,
                 "snapshots": 2, "segments": 31, "lastSnapshotTxid": 4800 },
    "manifest": { "generation": "fd43…", "shippedTxid": 4812, "snapshots": 2,
                  "segments": 31, "oldestTxid": 1, "generations": [ … ] },
    "error": null }

POST /v1/db/acme/backup/verify  { "at": 4800 }
→ 200 { "ok": true, "db": "acme", "generation": "fd43…", "at": 4800, "latest": 4812,
        "fromSnapshotTxid": 4750, "segments": 2, "records": 50, "bytes": 98304,
        "missing": [], "generations": [ … ] }
→ 409 when an object the manifest names is absent or the wrong size; `missing` says which

GET  /v1/db/acme/backup/generations
→ { "db": "acme", "bucket": "backups", "prefix": "bunql/", "generations": [ … ] }
```

All three need the admin key. `verify` downloads nothing and writes nothing: it checks the
manifest describes a contiguous timeline to `at` and that every object on the path exists at the
recorded size. A bucket with no manifest is `404 S3_NO_MANIFEST`; a target the inventory cannot
reach is `400 S3_INCOMPLETE` naming the shortfall; an object whose body does not match its
recorded hash is `400 S3_CORRUPT`; a node with no bucket is `503 S3_DISABLED`.

Shipping never blocks a commit. A bucket that is slow or unreachable makes `behind` true and
`bunql_s3_errors_total` climb while writes are answered at their usual latency, and the shipper
catches up from the local log when the bucket returns. Retention in the bucket (`[s3] retention`,
default 30 d) removes snapshots past the window and the segments wholly below the oldest snapshot
that survives — never one a surviving snapshot would need to replay from.

`GET /v1/db/{db}/dump` snapshots the database and streams the file as `application/vnd.sqlite3`
with a `Content-Disposition` naming `<db>-<txid>.db`. `POST /v1/db/{db}/import` takes a raw SQLite
file as the body and files it as a new database called `{db}`; a body that does not begin with the
SQLite header is a `400`, a name that exists is a `409`.

### Tokens

```http
POST /v1/tokens
{ "dbs": ["acme", "acme-*"], "scope": "rw", "tables": { "todos": "r", "users": "rw" }, "ttl": 2592000 }
→ 201 { "token": "eyJhbGciOiJFZERTQSIs…", "jti": "8f3c…", "exp": 1791592000 }

DELETE /v1/tokens/8f3c…   → { "jti": "8f3c…", "revoked": true }
```

`db` is accepted as a singular alias for `dbs`. `scope` is `ro` (default) or `rw`. `ttl` is
seconds, `ttlMs` milliseconds; without either, `[auth] defaultTokenTtlMs` (30 days). `sub` is
carried through to the claims. Revocation goes through the catalog, which survives a restart.

### Operations

```http
GET /healthz  → { "ok": true, "node": "…", "role": "primary", "uptimeMs": 91234 }
GET /readyz   → { "ready": true, "node": "…", "role": "primary" }          (503 when not)
GET /metrics  → Prometheus text 0.0.4; needs the admin key when one is configured
```

`readyz` on a replica also reports `connected` and `primary`, and is `503` while the stream is
down: a replica that cannot reach its primary is serving data that only gets staler.

Metrics are per-process counters only — nothing keyed by database, so cardinality is bounded. A
node that replicates adds four series: `bunql_replication_lag_txid` and
`bunql_replication_connected` (gauges) and `bunql_replication_bytes_total` and
`bunql_replication_records_total` (counters). On a primary they count what was streamed out and
how far the furthest-behind replica is; on a replica, what was received and applied.

Three more counters cover R2's paths: `bunql_forwarded_writes_total` (writes this replica handed
to its primary), `bunql_ack_timeouts_total` (writes that committed locally and then ran out of
patience waiting for replica acks) and `bunql_tx_queued_total` (interactive transactions that
waited for the writer instead of failing `TX_BUSY`).

A node with `[s3] bucket` set adds five: `bunql_s3_shipped_txid` (the highest txid any database
has in the bucket), `bunql_s3_pending_records` and `bunql_s3_behind` (gauges), and
`bunql_s3_errors_total` and `bunql_s3_bytes_total` (counters). Alert on `bunql_s3_behind` and on
`bunql_s3_shipped_txid` not advancing; a node with no bucket omits all five rather than exporting
zeroes.

### Node-to-node replication

`GET /v1/replication` upgrades to the binary node-to-node protocol of design §8, opened by a
replica. It is not a client API: the cluster secret is proved in-band with an HMAC over a nonce
the primary issues, and `Authorization` is not consulted. A node with `[replication] secret` unset
answers `403 REPLICATION_DISABLED`. The frame format, the bootstrap rules and the deviations from
`docs/plan-phase1.md` are in `docs/r1-replication.md`.

#### Write forwarding

A write that arrives on a replica is handed to the primary over the socket the replica already
holds (`FORWARD` out, `RESULT` back) and the replica answers with the primary's own result, plus
the `BunQL-Txid` the transaction committed under. Before answering it waits for its own applier to
reach that txid, so the caller's next read *on that node* sees its own write with no `minTxid`.

- Classification is `sqlite3_stmt_readonly`, the same call the local path makes: a read is served
  on the replica and never leaves it.
- `query`, `batch` and the whole interactive-transaction lifecycle forward. A baton opened through
  a replica is the primary's baton, handed straight through.
- The principal crosses the wire as its claims, not its token — two nodes share a cluster secret,
  not JWT key material — and the primary applies the same scope and table ACLs it would locally.
- `[replication] forwardWrites = false` restores the phase-0 answer: `503 NOT_PRIMARY` with
  `BunQL-Primary`. A replica that cannot reach its primary answers the same way.
- In flight forwards are capped by `[replication] maxForwards` (`503 BUSY` past it) and bounded by
  `[replication] forwardTimeoutMs` (`504 FORWARD_TIMEOUT`).
- **Only statement writes forward.** The lifecycle routes act on a node's own files rather than on
  a database's contents, so on a replica they are refused with `NOT_PRIMARY` instead — see
  "Replica limitations" below.

#### Realtime on a replica (phase-1 limitation)

A replica has no preupdate hooks: its transactions arrive as WAL pages, not as rows. Its realtime
is driven by the applier instead, and the two feeds differ:

- **Live queries work fully.** Every applied transaction re-runs every live query on that database
  and the result converges on the primary's state, which is what makes a replica useful for reads.
  The cost is that a replica cannot tell which tables moved, so it re-runs all of them.
- **The change feed carries txids and no rows.** A `change` event on a replica is
  `{"txid": 4814, "changes": []}`. Subscribe to it to know *that* something changed and at which
  txid; re-query, or subscribe on the primary, to know what. Design §4.6's row-level CDC on a
  replica needs logical decoding of the WAL, which is phase 3.

New databases reach a `follow: ["*"]` replica as soon as they are created — the primary announces
its database list on every create, import and delete rather than waiting for a heartbeat.

#### Replica limitations

Everything a replica cannot do in phase 1, in one place.

| what | on a replica |
|---|---|
| reads | served locally, at the applied txid. `BunQL-Min-Txid` waits on the applier |
| writes on the native routes | forwarded to the primary, transparently; `503 NOT_PRIMARY` with `BunQL-Primary` when `forwardWrites = false` or the socket is down |
| writes on the Hrana surface | **not forwarded** — `NOT_PRIMARY`. Point a libsql client at the primary to write |
| interactive transactions | forwarded whole; the baton is the primary's |
| the change feed | txid-only events, `changes: []` |
| live queries | full, re-run on every applied transaction |
| `POST /v1/db`, `DELETE /v1/db/:db`, `POST /v1/db/:db/restore`, `POST /v1/db/:db/import` | `503 NOT_PRIMARY` with `BunQL-Primary`. They are refused rather than forwarded: a create would have to come back over the replication stream to exist here anyway, and a delete has no safe forwarding story while promotion does not exist. Address the primary |
| `POST /v1/db/:db/checkpoint` with `TRUNCATE` | `503 NOT_PRIMARY`. Every other mode runs locally |
| `POST /v1/db/:db/snapshot` | works: a replica has the file and a snapshot of it is a valid restore source |
| S3 shipping | off. A replica authors nothing, so it ships nothing; `restore` from a bucket still works |
| `ack: "replica"` / `"quorum"` on a forwarded write | honoured — the level travels with the forwarded body and the primary waits for it |
| promotion to primary | not built. `POST /v1/db/:db/promote` and `bunql promote` are phase 2 |

A replica's `GET /readyz` is `503` while its stream is down, so a load balancer takes it out of
rotation rather than serving data that only gets staler.

---

## Hrana — the libsql-compatible surface

Everything under `/v2`, `/v3` and `/v1/db/:db/v2…` speaks libsql's Hrana protocol, so
`@libsql/client`, `drizzle-orm/libsql`, `kysely-libsql` and the Turso CLI reach BunQL unmodified.
It is a translation layer over the same `src/server/exec.ts` the native routes use: the same
authorizer, deadline, row cap, single writer and txid. `docs/r4-hrana.md` is the as-built note.

### Connection strings

Every row below is opened against a real server by `test/hrana/libsql-client.test.ts`.

| URL | database | notes |
|---|---|---|
| `http://host:port/v1/db/acme/` | `acme` | **the trailing slash is required** |
| `http://host:port/v1/db/acme` | — | `404`. The client resolves `v2/pipeline` *relatively*, so this asks for `/v1/db/v2/pipeline` |
| `http://host:port` | `default` | root addressing, no header needed |
| `http://host:port` + `x-namespace: acme` | `acme` | the header needs a custom `fetch`; `createClient` has no header option |
| `https://acme.sql.example.com` | `acme` | the first `Host` label, which is how a Turso deployment addresses a database |
| `libsql://host:port/v1/db/acme/?tls=0` | `acme` | `libsql:` means TLS unless `tls=0` says otherwise |
| `ws://host:port/v1/db/acme/hrana` | `acme` | **`/hrana` is required**: `/v1/db/:db` is already the stats route |
| `ws://host:port` | `default` | a browser `WebSocket` cannot send `x-namespace`, so the database comes from the path or the host label |

The trailing-slash rule is not ours: `encodeBaseUrl` in `@libsql/core` does not append one, and
`new URL("v2/pipeline", base)` then discards the last path segment. Without it the failure is a
bare `404`, reported as `SERVER_ERROR: Server returned HTTP status 404`.

```ts
import { createClient } from "@libsql/client"

const client = createClient({
  url: "http://127.0.0.1:4321/v1/db/acme/", // the trailing slash matters
  authToken: process.env.BUNQL_TOKEN,
  intMode: "bigint",
})
await client.execute({ sql: "insert into users (name) values (?)", args: ["ada"] })
const tx = await client.transaction("write")
await tx.execute("update users set name = 'ada2' where id = 1")
await tx.commit()
```

Authentication is the ordinary one: `authToken` becomes `Authorization: Bearer`, and over a socket
the token travels in the Hrana `hello`. A BunQL admin key or a minted token both work.

### What is implemented

| request | HTTP | WebSocket |
|---|---|---|
| `execute`, `batch`, `sequence`, `describe` | yes | yes |
| `store_sql`, `close_sql`, `get_autocommit`, `close` | yes | yes |
| `open_stream`, `close_stream`, `open_cursor`, `fetch_cursor`, `close_cursor` | — | yes |
| `POST /v3/cursor` | yes | — |

- **A stream is a real transaction holder.** `BEGIN`, `COMMIT` and `ROLLBACK` arriving as ordinary
  statements are intercepted and turned into BunQL transactions, so `client.transaction()` (an
  open stream) and `client.batch()` (conditioned steps in one request) are both one BunQL
  transaction with one txid.
- **`BEGIN TRANSACTION READONLY`**, which `transactionMode: "read"` emits, opens a deferred
  transaction that refuses writes with `SQLITE_READONLY`.
- **`replication_index` is our txid** as a decimal string, on every statement result.
- **Error codes are BunQL's**: `LibsqlError.code` carries `SQLITE_CONSTRAINT_UNIQUE`,
  `QUERY_TIMEOUT`, `NOT_AUTHORIZED`, `DB_NOT_FOUND` and the rest of the table above.
- **Batons** are HMAC-SHA256 over `streamId:seq:expiry` with a per-process key, single-use, and
  die with the process. A stream expires after 60 s idle; a service holds at most 4096 streams, a
  stream at most 256 stored SQL texts, a socket at most 64 open cursors.
- `limits.maxBodyBytes` bounds a pipeline or cursor body; `maxRows`, `queryTimeoutMs`,
  `writeTimeoutMs` and `txIdleTimeoutMs` apply exactly as they do natively.

### What is not

- **No protobuf.** `hrana3-protobuf` and the `/v3-protobuf/*` routes are absent; clients negotiate
  down to JSON on their own.
- **No Hrana 1** (`POST /v1/execute`, `POST /v1/batch`) and no "hello" text response on `GET /`.
- **`base_url` is always `null`**, so a client never moves its stream to another node.
- **An integral REAL comes back as an integer** unless the column is declared REAL: the driver
  collapses SQLite's INTEGER and FLOAT into a JS number, and the encoder re-derives the type from
  the column's affinity. `select 1.0` reports `{"type":"integer","value":"1"}`; a declared `REAL`
  column is always right.
- **`rows_read` and `rows_written`** are the returned row count and `rowsAffected`; SQLite has no
  native `rows_read` and `vmSteps` is not part of the Hrana shape.
- **`is_explain` is a prefix test** on the SQL.
- **On a replica the Hrana surface is read-only.** A write there answers `NOT_PRIMARY` rather than
  being forwarded — see [Replica limitations](#replica-limitations).

---

## WebSocket protocol

`GET /v1/ws`, sub-protocol `bunql.v1`. One socket, many databases, pipelined, JSON text frames.
Requests naming one database are answered in the order they arrived; different databases
interleave. Every client frame carries `id` and every reply echoes it; server-initiated frames
carry `sub`, or an `event` with no `id`.

Authenticate with the `Authorization` header, `?token=`, or a first `hello` frame. A socket that
presents none is accepted and must send `hello` before anything else.

```jsonc
→ {"id":1,"op":"hello","token":"eyJ…"}
← {"id":1,"ok":true}
← {"event":"hello","protocol":"bunql.v1","node":"…","role":"primary"}
```

`hello` is answered with the greeting whether or not it carried an `id`; a socket that arrived
already authenticated gets the greeting on open. On a replica the greeting says `"role":"replica"`
and adds `"primary"`, so a socket client can find the write path without provoking an error.
Writes over a socket on a replica are forwarded exactly as the HTTP ones are, transactions
included.

```jsonc
// query — `db`, or `tx` when it runs inside an open transaction
→ {"id":2,"op":"query","db":"acme","sql":"select * from users where id = ?","args":[1]}
← {"id":2,"ok":true,"result":{"columns":["id","name"],"types":["INTEGER","TEXT"],
                              "rows":[[1,"ann"]],"rowsAffected":0,"lastInsertRowid":null,
                              "txid":4813,"durationUs":28,"vmSteps":9}}

// batch
→ {"id":3,"op":"batch","db":"acme","atomic":true,"statements":[{"sql":"insert into users(name) values (?)","args":["bo"]}]}
← {"id":3,"ok":true,"result":{"results":[{…}],"txid":4814}}

// transactions
→ {"id":4,"op":"tx.begin","db":"acme","mode":"immediate"}
← {"id":4,"ok":true,"tx":"t1","expiresInMs":5000}
→ {"id":5,"op":"query","tx":"t1","sql":"update users set name = ? where id = ?","args":["cy",1]}
← {"id":5,"ok":true,"result":{…}}
→ {"id":6,"op":"tx.commit","tx":"t1"}         // or tx.rollback
← {"id":6,"ok":true,"txid":4815}

// change subscription — one table
→ {"id":7,"op":"subscribe","db":"acme","kind":"changes","tables":["users"],"since":4800,"include":"row"}
← {"id":7,"ok":true,"sub":"db:acme:changes:users","subs":["db:acme:changes:users"]}
← {"sub":"db:acme:changes:users","event":"change","data":{"txid":4816,"changes":[…]}}

// change subscription — the whole database, which also joins the schema topic
→ {"id":8,"op":"subscribe","db":"acme","kind":"changes","include":"row"}
← {"id":8,"ok":true,"sub":"db:acme:changes","subs":["db:acme:changes","db:acme:schema"]}
← {"sub":"db:acme:changes","event":"change","data":{"txid":4817,"changes":[…]}}
← {"sub":"db:acme:schema","event":"schema","data":{"txid":4818,"changes":[{"op":"create","object":"index","name":"users_name"}]}}

// live subscription
→ {"id":9,"op":"subscribe","db":"acme","kind":"live","sql":"select * from todos where done = 0","key":"id"}
← {"id":9,"ok":true,"sub":"db:acme:live:s1"}
← {"sub":"db:acme:live:s1","event":"rows","data":{"txid":4816,"columns":["id","title","done"],"types":["INTEGER","TEXT","INTEGER"],"rows":[[1,"write it",0]]}}
← {"sub":"db:acme:live:s1","event":"diff","data":{"txid":4820,"added":[[2,"and this",0]],"removed":[],"updated":[]}}

// unsubscribe, ping, errors
→ {"id":10,"op":"unsubscribe","sub":"db:acme:live:s1"}
← {"id":10,"ok":true}
→ {"id":11,"op":"ping"}                       ← {"id":11,"ok":true}
→ {"op":"ping"}                               ← {"event":"pong"}
← {"id":12,"ok":false,"error":{"code":"NOT_AUTHORIZED","message":"…","status":403}}
```

| op | fields | reply |
|---|---|---|
| `hello` | `token?` | `{id, ok}` then `{event:"hello"}` |
| `ping` | — | `{id, ok}`, or `{event:"pong"}` without an id |
| `query` | `db` or `tx`, `sql`, `args?`, plus the request options | `{id, ok, result}` |
| `batch` | `db` or `tx`, `statements`, `atomic?` | `{id, ok, result}` |
| `tx.begin` | `db`, `mode?`, `rows?` | `{id, ok, tx, expiresInMs}` |
| `tx.commit` · `tx.rollback` | `tx` | `{id, ok, txid}` |
| `subscribe` | `db`, `kind`, and the feed's parameters | `{id, ok, sub}`, plus `subs` for a multi-table change subscription |
| `unsubscribe` | `sub` | `{id, ok}` |

**Subscription ids are topics.** `db:acme:changes`, `db:acme:changes:users`, `db:acme:schema`,
`db:acme:live:s1`. That is what lets change fan-out go through Bun's own pub/sub: the published
frame is the same bytes for every subscriber. A change subscription naming several tables makes
one subscription per table, returns them all in `subs`, and `unsubscribe` accepts any of them.

**Backpressure.** Live-query results are per-subscription and are dropped when the socket is
behind — the newest result is kept and sent on `drain`. Change events go through Bun's pub/sub,
where Bun owns the buffering, and are never dropped.

**Liveness.** Bun sends protocol pings (`sendPings`, `idleTimeout: 120`); the `ping` op above is
the same question for clients that cannot see control frames.

**A closed socket** rolls back any transaction it opened and drops every subscription it held.

---

## SSE event formats

Both SSE routes answer with `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no` and
`BunQL-Txid`. The response is never compressed and never relies on Bun's idle timeout: it opts out
with `server.timeout(req, 0)` and owns its own `: ping` every 15 s. The first bytes are
`retry: 1000` and a comment, so a client that is up to date still gets its headers delivered.

| event | route | `data` |
|---|---|---|
| `change` | `/changes` | `{"txid": 4813, "changes": [RowChange, …]}` |
| `reset` | both | `{"txid": 4813, "reason": "the change ring no longer holds that position"}` |
| `rows` | `/live` | `{"txid", "columns", "types", "rows", "truncated"?}` |
| `diff` | `/live` | `{"txid", "added", "removed", "updated", "truncated"?}` |

DDL is reported as a `schema` event, which **only the WebSocket carries** — it goes to the
`db:{db}:schema` topic, which a socket joins along with `db:{db}:changes` when it subscribes to a
whole database. The SSE `/changes` route delivers row changes and nothing else.

A `RowChange` is `{table, op: "insert"|"update"|"delete", rowid, pk?, row?, old?}`. `rowid` is
`null` for a `WITHOUT ROWID` table, where `pk` is the identity and is always filled. `row` and
`old` appear at capture levels `row` and `row+old`.

`id:` on a `change` event is its txid, which is what `Last-Event-ID` resumes from. The ring lives
in memory: a position it cannot serve — too old, or from before a restart — answers `reset`, and
the client must re-query.

---

## Client SDK

`bunql/client`. Runs in browsers, Bun, Node and Workers: it imports nothing from Bun or Node, and
uses only `fetch`, `WebSocket`, `ReadableStream`, `TextDecoder`, `AbortController` and base64.
One-shot statements go over HTTP; the socket is opened lazily, for subscriptions and interactive
transactions.

```ts
import { createClient } from "bunql/client"

const client = createClient({
  url: "https://sql.example.com",   // ws(s):// is accepted and rewritten
  token,                            // a scoped token, or the admin key
  db: "acme",                       // what client.db() returns with no name
  consistency: "ryw",               // default; "primary" and "any" travel per request
  intMode: "number",                // what an integer beyond 2^53 becomes
  retryMs: 1000,                    // before a dropped subscription or socket is re-opened
  headers: {},                      // added to every HTTP request
  fetch, WebSocket,                 // for runtimes without them on the global object
  onError: (err) => {},             // where a failure with nowhere else to go is reported
})

const db = client.db("acme")
client.txid("acme")   // highest txid this client has seen; what "ryw" sends as BunQL-Min-Txid
client.close()
```

### Statements

```ts
const users = await db.sql<User>`select * from users where id > ${10}`   // objects
const rows  = await db.sql`select id from users`.values()                // arrays
const raw   = await db.sql`select id from users`.raw()                   // alias of .values()
const one   = await db.sql<User>`select * from users where id = ${id}`.first()
const meta  = await db.sql`insert into users(name) values (${"ann"})`.run()

await db.execute("insert into users(name) values (?)", ["ann"], { ack: "fsync" })
await db.unsafe("select * from users")                                   // SQL from a string
db.stmt`insert into users(name) values (${"bo"})`                        // → {sql, args}, for batch
```

A query object is lazy and runs once: nothing is sent until `then`, `values`, `first` or `run` is
called, which is what lets the same object choose its row mode from the method you called. The
promise is memoised, so awaiting twice does not run the statement twice.

A result is an array with metadata on it:

```ts
result.count            // rows
result.command          // "SELECT", "INSERT", … looking through a leading WITH
result.lastInsertRowid
result.affectedRows
result.txid
result.columns
result.types
result.durationUs
result.vmSteps
```

`intMode` decides what an out-of-range integer becomes: `"number"` (the default) throws rather than
round, `"bigint"` and `"string"` return that. Integers that fit a double are always `number`.

### Batches and transactions

```ts
await db.batch([db.stmt`insert into a values (1)`, { sql: "update b set n = 2" }], {
  atomic: true,          // default
  rows: "object",
})

await db.transaction(async (tx) => {
  await tx.sql`insert into users(name) values (${"ann"})`
  await tx.sql`update counters set n = n + 1`
}, { mode: "immediate", via: "ws" })   // "ws" if a socket is open, else the HTTP baton
```

A throw inside the callback rolls the transaction back. `via` is chosen automatically; a socket
that cannot be opened falls back to the baton rather than failing a transaction the server would
have accepted.

### Subscriptions

```ts
const feed = db.changes({ tables: ["todos"], since: 4800, include: "row", retryMs: 500 })
feed.on("change", (event) => …)     // also "reset" and "error"
for await (const event of feed) …   // the same events; buffering starts at the first iterator
feed.close()

const live = db.live<Todo>`select * from todos where done = ${0}`.key("id")
live.on("rows", (event) => render(event.rows))
live.on("diff", (event) => patch(event.added, event.removed, event.updated))
live.close()
```

The change feed is `fetch` plus a `ReadableStream`, never `EventSource`, so the token stays in a
header. It owns its reconnect and resumes from the highest txid it delivered, so an event is never
delivered twice; a position the ring cannot serve arrives as `reset`. A live query starts on the
microtask after it is created, so `key` and the first `on` are registered before the subscription
goes out; calling `key` after that is an error rather than a silent no-op.

Every failure a caller sees is a `BunQLClientError` carrying the server's `code`, `status` and
`txid`.

---

## ORM adapters

Two adapters ship in the package and neither adds a runtime dependency: `kysely` and `drizzle-orm`
are optional peers. `docs/r5-orm.md` is the as-built note, with the mapping tables and every
limitation.

```ts
import { BunQLDialect } from "bunql/kysely"
import { Kysely } from "kysely"

const db = new Kysely<Schema>({
  dialect: new BunQLDialect({ url: "http://127.0.0.1:4321", token, db: "acme" }),
})
```

```ts
import { drizzle } from "bunql/drizzle"

const db = drizzle({ url: "http://127.0.0.1:4321", token, db: "acme" }, { schema: { todos } })
db.$client.bunql // the BunQL `Db` underneath
```

Both take the same three sources: a client `Db` from `createClient(...).db(name)`, an embedded
`Db` from `BunQL.open({dir}).db(name)` with no HTTP in the middle, or `{url, token, db}`, which
the adapter builds a client from and closes with `destroy()` / `$client.close()`. A `Db` you pass
in yourself is never closed for you. A client the adapter opens uses `intMode: "bigint"`, because
an ORM that throws on an integer past 2^53 is worse than one that hands back a bigint.

- **Transactions are real.** Kysely's `begin`/`commit` connection contract is bridged onto BunQL's
  callback transaction; Drizzle goes through the libsql driver's `client.transaction()`, which maps
  onto the baton. Nested transactions are savepoints.
- **`db.batch()` in Drizzle is `POST /v1/db/{db}/batch`** — one transaction, one txid,
  `failedIndex` on the statement that broke.
- **No streaming.** Kysely's `.stream()` throws; page with `limit`/`offset` and cap with `maxRows`.
- **One open transaction per database.** Kysely serialises everything from one instance; the
  Drizzle adapter queues a second transaction for up to 10 s. Two instances over one database can
  still collide with `409 TX_BUSY`.
- **Errors keep BunQL's `code`.** Kysely propagates the `BunQLClientError`; Drizzle wraps it, so
  the BunQL error is the `cause`.

---

## Embedded API

`bunql`. The engine in this process, over the same `Db` interface, plus a synchronous escape hatch.

```ts
import { BunQL } from "bunql"

const bq = await BunQL.open({
  dir: "./data",        // shorthand for data: { dir }
  intMode: "number",
  config: null,         // a bunql.toml to read first; embedded callers configure in code
  env: {},              // BUNQL_* is not consulted unless you pass it
  onError: (err) => {},
  // …plus any ServerConfig section: server, data, durability, realtime, limits, auth
})

const db = await bq.create("acme", { pageSize: 4096, quotaBytes: 0 })
const forked = await bq.fork("acme-copy", "acme", 4812)
bq.db("acme")                       // a handle; the tenant opens on first use
bq.list()                           // [{ name, txid, epoch, pageSize, quotaBytes, createdAtMs, open }]
bq.stat("acme")                     // the stats body of GET /v1/db/{db}
bq.delete("acme")                   // → the trash path
bq.tenantOf("acme")                 // the Tenant itself, for code that wants the driver
bq.on("commit", ({ db, txid }) => …)   // every durable commit on every database this process opened

const handle = await bq.serve({ port: 4321, host: "0.0.0.0" })   // the same engine over HTTP/WS/SSE
await handle.close()
await bq.close()
```

`db` is the client's `Db` interface, so code written against the client runs here unchanged, and
results are decoded through the same codec — `bq.db(x).sql\`…\`` and `client.db(x).sql\`…\`` return
the identical value for every SQLite type.

```ts
db.sync.sql`select * from t`.all()          // Result<T>
db.sync.sql`select * from t where id = ${1}`.get()    // T | null
db.sync.sql`select id from t`.values()
db.sync.sql`insert into t(v) values (${"x"})`.run()
db.sync.execute("select 1")
db.sync.batch([db.stmt`…`])
db.sync.transaction((tx) => { tx.sql`…`.run() })
db.tenant()                                  // the Tenant behind this handle
```

Every read and write is synchronous underneath; the async surface wraps the same call in
`Promise.resolve`, so the two cannot drift. The embedded API runs as the admin principal — it is
in-process code with the data directory already open. Tokens start applying again at `serve()`.

---

## CLI

```
bunql serve [--dir ./data] [--port 4321] [--host 0.0.0.0] [--config bunql.toml] [--admin-key K]
            [--replica-of wss://primary/v1/replication] [--cluster-secret S] [--follow a,b]
            [--s3 s3://bucket/prefix] [--s3-endpoint URL] [--s3-region R]
bunql db create <name> [--from <db>[@<txid|time>]] [--page-size N] [--quota-bytes N]
bunql db list
bunql db stat <name>
bunql db delete <name>
bunql db fork <name> --from <db>[@<txid|time>]
bunql snapshot <db>
bunql restore <db> --at <txid|time> [--into <name>]
bunql restore <db> --from s3://bucket/prefix [--at <txid|time>] [--into <name>] [--generation G]
bunql backup status <db>
bunql backup verify <db> [--at <txid|time>] [--from s3://bucket/prefix]
bunql backup generations <db>
bunql checkpoint <db> [--mode PASSIVE|FULL|RESTART|TRUNCATE]
bunql token --db <name> [--scope ro|rw] [--ttl 30d] [--tables 'todos:r,users:rw']
bunql exec <db> --sql "select 1"
bunql shell <db>
```

`serve` opens the data directory in this process. Every other command is an HTTP client of a
server that already has it open, because a second process writing the catalog would be a second
writer for it.

| flag | default |
|---|---|
| `--url` | `$BUNQL_URL`, else `http://127.0.0.1:4321` |
| `--token` | `$BUNQL_TOKEN`, else `$BUNQL_ADMIN_KEY` |
| `--json` | print the server's own body instead of a summary line |

`--ttl` takes `ms`, `s`, `m`, `h`, `d`, `w` suffixes. `--tables` is `name:r,name:rw`. `--from` and
`--at` take a txid or an ISO-8601 timestamp, so `bunql db fork x --from y@2026-09-11T10:00:00Z`
works. `shell` is a REPL over the WebSocket protocol; `exec` is the one-shot a script wants.

`serve --replica-of <url>` makes the node a replica of that primary: it needs the same
`--cluster-secret`, and `--follow a,b` narrows what it tracks from the default of every database
the primary announces. A pair is two commands:

```sh
bunql serve --dir ./p --port 4501 --cluster-secret $SECRET
bunql serve --dir ./r --port 4502 --cluster-secret $SECRET \
            --replica-of ws://127.0.0.1:4501/v1/replication
```

`serve --s3 s3://bucket/prefix` turns on continuous backup. Credentials deliberately have **no
flag** — they belong in `bunql.toml` or the environment (`BUNQL_S3_ACCESS_KEY_ID`,
`BUNQL_S3_SECRET_ACCESS_KEY`, or Bun's own `AWS_*` / `S3_*`), not in a shell history or a process
listing. `bunql restore <db> --from s3://…` recovers a database onto a node that has never seen
it, which is the whole point of the bucket:

```sh
bunql serve --dir ./node --port 4321 --s3 s3://backups/prod --s3-endpoint https://…
bunql backup status acme
bunql backup verify acme --at 2026-09-11T10:00:00Z
bunql restore acme --from s3://backups/prod --at 2026-09-11T10:00:00Z --into acme-recovered
```

---

## Configuration

`bunql.toml` in the working directory, then `BUNQL_*` in the environment, which wins.
`${VAR}` inside a TOML value is expanded from the environment. `BUNQL_CONFIG` names the file and
makes it required. An empty environment value counts as unset.

Every key has a canonical override named after its section and its key, upper-cased and
underscore-separated under `BUNQL_`. The shorter names below are aliases kept for compatibility;
the canonical one wins when both are set.

| key | default | canonical override | alias |
|---|---|---|---|
| `[server] port` | `4321` | `BUNQL_SERVER_PORT` | `BUNQL_PORT` |
| `[server] host` | `"0.0.0.0"` | `BUNQL_SERVER_HOST` | `BUNQL_HOST` |
| `[server] node` | hash of the hostname | `BUNQL_SERVER_NODE` | `BUNQL_NODE` |
| `[server] tenantFromHost` | `false` | `BUNQL_SERVER_TENANT_FROM_HOST` | `BUNQL_TENANT_FROM_HOST` |
| `[server] cors` | `true` | `BUNQL_SERVER_CORS` | `BUNQL_CORS` |
| `[data] dir` | `"./data"` | `BUNQL_DATA_DIR` | `BUNQL_DIR` |
| `[data] maxOpen` | `1024` | `BUNQL_DATA_MAX_OPEN` | `BUNQL_MAX_OPEN` |
| `[data] readers` | `2` | `BUNQL_DATA_READERS` | `BUNQL_READERS` |
| `[data] pageSize` | `4096` | `BUNQL_DATA_PAGE_SIZE` | `BUNQL_PAGE_SIZE` |
| `[data] quotaBytes` | `0` (unlimited) | `BUNQL_DATA_QUOTA_BYTES` | `BUNQL_QUOTA_BYTES` |
| `[durability] defaultAck` | `"local"` (also `fsync`, `replica`, `quorum`) | `BUNQL_DURABILITY_DEFAULT_ACK` | `BUNQL_DEFAULT_ACK` |
| `[durability] checkpointWalBytes` | `4000000` | `BUNQL_DURABILITY_CHECKPOINT_WAL_BYTES` | `BUNQL_CHECKPOINT_WAL_BYTES` |
| `[durability] retention` | `"7d"` (`"0"` keeps everything) | `BUNQL_DURABILITY_RETENTION` | `BUNQL_RETENTION` |
| `[durability] trashSweepIntervalMs` | `3600000` (`0` sweeps only at start) | `BUNQL_DURABILITY_TRASH_SWEEP_INTERVAL_MS` | — |
| `[durability] segmentBytes` | `16777216` | `BUNQL_DURABILITY_SEGMENT_BYTES` | — |
| `[realtime] ringBytes` | `10000000` | `BUNQL_REALTIME_RING_BYTES` | `BUNQL_RING_BYTES` |
| `[realtime] ringMaxAgeMs` | `60000` | `BUNQL_REALTIME_RING_MAX_AGE_MS` | `BUNQL_RING_MAX_AGE_MS` |
| `[realtime] maxLiveQueries` | `1000` | `BUNQL_REALTIME_MAX_LIVE_QUERIES` | `BUNQL_MAX_LIVE_QUERIES` |
| `[realtime] maxRowsPerLive` | `1000` | `BUNQL_REALTIME_MAX_ROWS_PER_LIVE` | `BUNQL_MAX_ROWS_PER_LIVE` |
| `[realtime] idleRetainMs` | `15000` | `BUNQL_REALTIME_IDLE_RETAIN_MS` | `BUNQL_IDLE_RETAIN_MS` |
| `[limits] queryTimeoutMs` | `10000` | `BUNQL_LIMITS_QUERY_TIMEOUT_MS` | `BUNQL_QUERY_TIMEOUT_MS` |
| `[limits] writeTimeoutMs` | `30000` | `BUNQL_LIMITS_WRITE_TIMEOUT_MS` | `BUNQL_WRITE_TIMEOUT_MS` |
| `[limits] txIdleTimeoutMs` | `5000` | `BUNQL_LIMITS_TX_IDLE_TIMEOUT_MS` | `BUNQL_TX_IDLE_TIMEOUT_MS` |
| `[limits] maxRows` | `10000` | `BUNQL_LIMITS_MAX_ROWS` | `BUNQL_MAX_ROWS` |
| `[limits] maxOpenTx` | `1` | `BUNQL_LIMITS_MAX_OPEN_TX` | `BUNQL_MAX_OPEN_TX` |
| `[limits] txWaitMs` | `5000` | `BUNQL_LIMITS_TX_WAIT_MS` | `BUNQL_TX_WAIT_MS` |
| `[limits] maxBodyBytes` | `8388608` | `BUNQL_LIMITS_MAX_BODY_BYTES` | `BUNQL_MAX_BODY_BYTES` |
| `[limits] maxImportBytes` | `1073741824` | `BUNQL_LIMITS_MAX_IMPORT_BYTES` | `BUNQL_MAX_IMPORT_BYTES` |
| `[auth] adminKey` | generated on first start | `BUNQL_AUTH_ADMIN_KEY` | `BUNQL_ADMIN_KEY` |
| `[auth] jwtKey` | generated on first start | `BUNQL_AUTH_JWT_KEY` | `BUNQL_JWT_ED25519` |
| `[auth] jwtPublicKeys` | `[]` | `BUNQL_AUTH_JWT_PUBLIC_KEYS` (comma-separated) | — |
| `[auth] keysFile` | `<dataDir>/keys.json` | `BUNQL_AUTH_KEYS_FILE` | `BUNQL_KEYS_FILE` |
| `[auth] clockToleranceSec` | `30` | `BUNQL_AUTH_CLOCK_TOLERANCE_SEC` | `BUNQL_CLOCK_TOLERANCE_SEC` |
| `[auth] defaultTokenTtlMs` | `2592000000` (30 d) | `BUNQL_AUTH_DEFAULT_TOKEN_TTL_MS` | `BUNQL_TOKEN_TTL_MS` |
| `[replication] role` | `"primary"` | `BUNQL_REPLICATION_ROLE` | — |
| `[replication] primary` | `""` | `BUNQL_REPLICATION_PRIMARY` | `BUNQL_REPLICA_OF` |
| `[replication] secret` | `""` (replication off) | `BUNQL_REPLICATION_SECRET` | `BUNQL_CLUSTER_SECRET` |
| `[replication] follow` | `["*"]` | `BUNQL_REPLICATION_FOLLOW` (comma-separated) | `BUNQL_FOLLOW` |
| `[replication] ackTimeoutMs` | `2000` | `BUNQL_REPLICATION_ACK_TIMEOUT_MS` | — |
| `[replication] ackWithoutReplicas` | `"error"` (or `"allow"`) | `BUNQL_REPLICATION_ACK_WITHOUT_REPLICAS` | — |
| `[replication] heartbeatMs` | `5000` | `BUNQL_REPLICATION_HEARTBEAT_MS` | — |
| `[replication] slowReplicaMs` | `30000` | `BUNQL_REPLICATION_SLOW_REPLICA_MS` | — |
| `[replication] reconnectMs` | `250` | `BUNQL_REPLICATION_RECONNECT_MS` | — |
| `[replication] forwardWrites` | `true` | `BUNQL_REPLICATION_FORWARD_WRITES` | — |
| `[replication] forwardTimeoutMs` | `10000` | `BUNQL_REPLICATION_FORWARD_TIMEOUT_MS` | — |
| `[replication] maxForwards` | `256` | `BUNQL_REPLICATION_MAX_FORWARDS` | — |
| `[s3] enabled` | `false`; `true` once `bucket` is set | `BUNQL_S3_ENABLED` | — |
| `[s3] bucket` | `""` (no shipping); also accepts `s3://bucket/prefix` | `BUNQL_S3_BUCKET` | `BUNQL_S3_URL` |
| `[s3] region` | `""` (Bun's own resolution) | `BUNQL_S3_REGION` | — |
| `[s3] endpoint` | `""` (AWS); required for R2, Tigris, MinIO | `BUNQL_S3_ENDPOINT` | — |
| `[s3] prefix` | `"bunql/"` | `BUNQL_S3_PREFIX` | — |
| `[s3] accessKeyId` | `""` (Bun's `S3_*` / `AWS_*`) | `BUNQL_S3_ACCESS_KEY_ID` | — |
| `[s3] secretAccessKey` | `""` (Bun's `S3_*` / `AWS_*`) | `BUNQL_S3_SECRET_ACCESS_KEY` | — |
| `[s3] sessionToken` | `""` | `BUNQL_S3_SESSION_TOKEN` | — |
| `[s3] virtualHostedStyle` | `false` | `BUNQL_S3_VIRTUAL_HOSTED_STYLE` | — |
| `[s3] shipIntervalMs` | `1000` | `BUNQL_S3_SHIP_INTERVAL_MS` | — |
| `[s3] snapshotIntervalMs` | `3600000` (0 disables) | `BUNQL_S3_SNAPSHOT_INTERVAL_MS` | — |
| `[s3] snapshotEveryBytes` | `67108864` (0 disables) | `BUNQL_S3_SNAPSHOT_EVERY_BYTES` | — |
| `[s3] retention` | `"30d"` (`"0"` keeps everything) | `BUNQL_S3_RETENTION` | — |
| `[s3] concurrency` | `4` | `BUNQL_S3_CONCURRENCY` | — |
| `[s3] maxPendingBytes` | `67108864` | `BUNQL_S3_MAX_PENDING_BYTES` | — |
| `[s3] retries` | `4` | `BUNQL_S3_RETRIES` | — |

Setting `[replication] primary` makes the node a replica; `role` need not be set as well. A
replica with no `primary` is refused at start.

Setting `[s3] bucket` turns shipping on the same way. `enabled = false` keeps the bucket
configured without shipping to it, which is how a recovery node reads a backup it does not write.
A `[s3] retention` or a `[durability] retention` that is not a duration is refused at start rather
than silently ignored. `[durability] retention` is how long a deleted database stays in
`<dataDir>/trash/`; the local transaction log is not pruned by it.

One more, outside the config file: `BUNQL_SQLITE_LIB` names the `libsqlite3` the driver loads.
Without it the usual Homebrew and Linux paths are tried.

---

## Differences from the design

Everything below is a place where the implementation does not match `docs/design.md`. The design
document is not edited; this is the list.

### Landed in phase 1

| design | status |
|---|---|
| §8 replication protocol (`/v1/replication` binary frames) | R1. `GET /v1/db/{db}/replication` is the JSON status route of §6.5; the socket is the protocol |
| §9.3 `bunql serve --replica-of` | R1, with `--cluster-secret` and `--follow` |
| §9.4 `[replication]` | R1 |
| §5.2 replicas serve reads and forward writes | R2. `forwardWrites = false` keeps R1's `503 NOT_PRIMARY` |
| §5.4 `ack: "replica" \| "quorum"` | R2, with `NO_REPLICAS` and `ACK_TIMEOUT` as the two refusals |
| §5.4 read-your-writes across nodes | R2. `BunQL-Min-Txid` waits on the applier; every response carries `BunQL-Txid` and `BunQL-Role` |
| §5.2 a new database reaches a wildcard replica at once | R2. The primary announces its database list on create, import and delete |
| §5.2 replica realtime | R2, in part: live queries converge, the change feed is txid-only. See "Realtime on a replica" above |
| §4.4 S3 shipper (`Bun.S3Client`, snapshots + segments, retention) | R3. `[s3] bucket` turns it on; see "S3 backup" above |
| §4.4 restore from a bucket by txid or timestamp | R3. `POST /v1/db/{db}/restore {"from":"s3"}` and `bunql restore --from s3://…` |
| §6.5 "S3 position" on `GET /v1/db/{db}/replication` | R3, as the `s3` block |
| §9.4 `[s3]` | R3, with every key taking a `BUNQL_S3_*` override |
| `next.md`: `src/wal/log.ts` cold open walks every record header | R3. A sidecar segment index; 2.69 ms → 0.36 ms at 6k records |
| §6.7 Hrana compatibility (`/v2/pipeline`, `/v3/pipeline`, `/v3/cursor`, `hrana3`/`hrana2` sockets) | R4. No protobuf and no Hrana 1; see [Hrana](#hrana--the-libsql-compatible-surface) |
| §9.2 `bunql/kysely`, `bunql/drizzle` | R5, both optional peers; see [ORM adapters](#orm-adapters) |
| `docs/r4-hrana.md` §4: `lastInsertRowid` was null when a rowid repeated | fixed. The statement answers for itself, from SQLite's authorizer at prepare time |

The as-built notes are `docs/r1-replication.md` (transport), `docs/r2-durability.md`
(durability, forwarding, the transaction queue), `docs/r3-storage.md` (the bucket layout
contract, the shipper and restore), `docs/r4-hrana.md` (the libsql surface and what the clients
really send) and `docs/r5-orm.md` (the two adapters).

### Still not implemented

| design | status |
|---|---|
| §6.5 `POST /v1/db/{db}/promote` | phase 2. Promotion needs a control plane that can fence the old primary, not just a route |
| §9.3 `bunql promote`, `bunql cluster` | phase 2, with the control plane |
| §9.4 `[cluster]` | phase 2 |
| §4.5 replica apply mechanism A (pages into the file, shm header rewritten under the WAL locks) | mechanism B works and is what the numbers above are; A is the way to stop rescanning the WAL per apply |
| §4.6 row-level CDC on a replica | phase 3. A replica receives pages, so logical decoding of the WAL is what it would take |
| §9.2 `BunQL.open({ s3 })` | phase 2; the embedded engine has no shipper of its own |
| `workers: N` (design §2.3) | phase 2. One process owns the writers today |

### Behaviour that differs

- **`POST /v1/db/{db}/restore` always creates a new database.** `into` names it; without it the
  name is `<db>-restore-<txid>`. Restoring in place would leave the log holding records past the
  restore point that no longer apply to the file, and phase 0's log has no truncate-after. Design
  §6.5's own CLI example restores with `--into`.
- **`include` on a change subscription is a floor, not a filter.** The capture level is per
  database and the engine runs at the highest level any subscriber asked for. Filtering per
  subscriber would mean re-encoding the payload per socket, which is what the shared-topic fan-out
  exists to avoid.
- **A WebSocket `subscribe` naming several `tables` returns `subs` alongside `sub`.** One
  subscription per table topic; `sub` is the first and `unsubscribe` accepts any of them. The
  design's single-`sub` shape is what you get for a whole database or a single table.
- **`ping` is an op in the JSON protocol.** Design §7 specifies protocol-level ping/pong, which Bun
  handles natively; this is the same question for clients that cannot see control frames.
- **`consistency` is accepted and validated but changes nothing** on a single node, which is always
  the primary. `minTxid` does all the work.
- **`maxOpenTx` is fixed at 1 per database** by the tenant having one writer. The config key exists
  but a larger value would not be honoured; `[limits] txWaitMs` is the knob that matters, since it
  decides how long the second transaction waits for the first rather than how many may run.
- **The Hrana surface does not forward writes.** The native routes on a replica hand a write to
  the primary; `/v2/pipeline` and its relatives answer `NOT_PRIMARY` instead, because a libsql
  client has no way to be told which node ran its statement and the baton it would get back is the
  primary's, not this node's. Point a libsql client at the primary to write.
- **A forwarded write is not retried.** A replica sends it once. `FORWARD_TIMEOUT` and a socket
  that drops mid-flight both mean "this may or may not have committed on the primary" — read the
  txid back rather than sending it again.
- **The long poll's `wait` is capped at 60 s**, so a client cannot pin a subscription open.
- **`wait` is what switches `/changes` between SSE and the long poll**, not `Accept`.
- **`maxRows` fails a one-shot query and truncates a live one.** `400 TOO_MANY_ROWS` on `/query`;
  `truncated: true` on a live event.
- **The first live event is always `rows`, later ones `diff`.** A diff needs a previous result and
  the subscribe-time event has none.
- **The default `BunQL-Node` is a hash of the hostname**, not the hostname. It travels on every
  response and into whatever a client logs. `[server] node` sets a readable one.
- **The change ring is in memory.** A `Last-Event-ID` from before a restart is answered with
  `reset`, not an empty backlog — an empty backlog reads as "you are up to date".
- **`sql.raw()` is an alias of `.values()`.** In `Bun.SQL` `raw()` is the un-decorated array form,
  which is what `values()` returns here.
- **`sql.begin()` is spelled `db.transaction()`.** Design §9.1 names both; the plan's own example
  uses `transaction`.
- **The client authenticates a socket with `hello`, not `?token=`.** The query-string token is
  still accepted by the server; the SDK does not use it.
- **`bunql restore --at` and `from.at` accept a timestamp**, which design §9.3 asks for and the
  original route did not do.
- **`bunql exec <db> --sql …` is an addition** to the design §9.3 command list. `shell` needs a
  terminal; a one-shot statement is what a script wants.
- **Every `[section] key` has a `BUNQL_<SECTION>_<KEY>` override.** The short aliases predate it
  and still work.

### Record and layout details

- **`TxnRecord` carries `bodyLength` and `bodyPlainLength`**, which design §4.3's listing does not:
  a segment file is records back to back, so a record must state its own length. The two hashes sit
  at the end of the header rather than after the body, so `decodeHeader` is one fixed-size read.
- **The 128-bit body hash is two 64-bit XXH3 digests** with seeds `0` and `0x9E3779B1`, because
  `Bun.hash.xxHash3` exposes only the 64-bit digest. It is not canonical XXH3-128 and nothing but
  BunQL reads it.
- **A replica verifies `postChecksum` before writing, not after.** The prospective checksum is
  computed from the pre-images, and a mismatch throws with the replica's WAL untouched.
- **The tailer's position advances only at commit frames** and every poll re-verifies the chain
  from the last confirmed commit. `experiments/walproto.ts` advanced per frame, which is wrong.
- **`ack: "fsync"` is an explicit `fdatasync` of the WAL descriptor**, not `PRAGMA synchronous=FULL`
  for that commit.
- **The catalog position is saved at most every 200 ms**, plus on close, checkpoint and snapshot.
  It is a fast-start hint; the reconcile takes its position from the log.
- **Writes during a snapshot or a fork throw `BUSY`.** A commit inside that window would make the
  snapshot newer than the txid it is filed under.
- **`DELETE /v1/db/{db}` moves, never removes.** The directory goes to `<dataDir>/trash/<name>-<ms>`
  and is removed by the trash sweep once it is older than `[durability] retention`, which is that
  key's only consumer — the local log is kept whole.
- **Admin writes are refused on a replica, not forwarded.** `POST /v1/db`, `DELETE /v1/db/{db}`,
  `POST /v1/db/{db}/restore` and `POST /v1/db/{db}/import` answer `503 NOT_PRIMARY`. Design §5.2's
  "forward writes to the primary" is about statement writes; the lifecycle routes act on a node's
  own files, and a replica does not own its copy.
