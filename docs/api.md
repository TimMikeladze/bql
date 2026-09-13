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
| `BunQL-Role` | `primary` or `replica` — **for the database this request names**, live |
| `BunQL-Duration-Us` | microseconds spent in the handler |

`BunQL-Role` is per database and it moves at runtime. A node promoted for `acme` answers
`primary` for `acme` and `replica` for everything it still follows, in the same process and
without a restart; a request that names no database (`POST /v1/db`, `/healthz`) gets the node's
own role instead. See [Promotion and failover](#promotion-and-failover).

`BunQL-Primary` is on **every** response from a replica, not only on a `NOT_PRIMARY` error: it
carries where that database's writes go — `[replication] primary` in a static topology, and the
node the control plane names in a cluster — so a client that wants the write path never has to
provoke an error to find it. While `[server] cors` is on (the default) all five are listed in
`Access-Control-Expose-Headers`, along with `Location`, and `OPTIONS` on any route is a
preflight.

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

**`ack: "local"` and failover lose the tail.** This is the default, and it is worth stating as
plainly as it deserves: a write answered `local` is durable on **one** node. Failover picks the
replica with the highest txid the control plane has been told about, which is the best any replica
has — but a primary that dies may have committed and *answered* transactions past that point which
no replica ever received. Those are gone, and nothing reports a gap: the new primary simply starts
at its own txid.

The loss is bounded by replica lag, typically under a millisecond on a LAN, and it is not zero.
`ack: "replica"` or `"quorum"` makes it impossible, at the cost of a round trip per write, because
promotion then cannot pick a node that is missing an acknowledged transaction.

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

`problems` is added when the request did not match the schema this route publishes. Every route's
body, query and path parameters are validated against the document `GET /v1/openapi.json` serves,
and a refusal lists **every** mistake it found rather than the first — a client fixing three of them
should be told about three:

```json
{ "error": { "code": "BAD_REQUEST", "status": 400,
             "message": "body.sql expected a string, got a number (and 1 more problem)",
             "problems": [{ "path": "body.sql", "message": "expected a string, got a number" },
                          { "path": "body.timeoutMs", "message": "expected an integer, got a string" }] } }
```

The body is judged **after** the token and the database, so a request that may not be here is still
`401` or `404` rather than a `400` describing what the route would have taken.

There is no startup-only error code any more. `[server] workers` above 1 shards databases across
threads and can be combined with everything a node can be configured for: *serving* replicas
(`docs/c4b-replication-workers.md`), *following* an upstream (`docs/c4c-replication-follow.md`) and
*joining a cluster* (`docs/c4d-cluster-workers.md`). `WORKERS_UNSUPPORTED` named the combinations
that were once refused and is gone with the last of them.

| code | status | when |
|---|---|---|
| `BAD_REQUEST` | 400 | malformed body, unknown option, bad SQL that SQLite reports as `SQLITE_ERROR` |
| `TOO_MANY_ROWS` | 400 | the result exceeded the request's `maxRows` |
| `UNAUTHENTICATED` | 401 | no token, a bad signature, an expired or revoked token |
| `NOT_AUTHORIZED` | 403 | the token's scope or table ACL refuses this |
| `DB_NOT_FOUND` | 404 | no such database |
| `NOT_FOUND` | 404 | no such row: the data API's `/{pk}` routes, when the key matches nothing |
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
| `CLUSTER_DISABLED` | 503 | `GET /v1/cluster` on a node with no `[cluster]` section enabled; 403 on the raft socket |
| `NO_COPY` | 404 | `promote` for a database this node holds no copy of |
| `GENERATION_MISMATCH`, `STREAM_LIVE`, `ALREADY_PRIMARY`, `BEHIND` | 409 | `promote` refused; see [Promotion and failover](#promotion-and-failover) |
| `LEASE_HELD`, `NO_LEADER`, `NOT_COMMITTED` | 503 | `promote` refused by the control plane |
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
| `PATCH /v1/db/:db` | change one database's settings | admin |
| `POST /v1/db/:db/batch` | many statements | `ro`, `rw` for the ones that write |
| `GET /v1/db/:db/backup` | S3 shipper position and manifest | admin |
| `GET /v1/db/:db/backup/generations` | every generation in the bucket | admin |
| `POST /v1/db/:db/backup/verify` | check the bucket can restore to a txid | admin |
| `GET /v1/db/:db/changes` | change feed, SSE or long poll | `ro` |
| `POST /v1/db/:db/checkpoint` | manual checkpoint | admin |
| `GET /v1/db/:db/dump` | stream the SQLite file out | admin |
| `POST /v1/db/:db/import` | stream a SQLite file in | admin |
| `GET /v1/db/:db/live` | live query, SSE | `ro` |
| `GET /v1/db/:db/api/*` | generated data API, read | `ro` |
| `POST /v1/db/:db/api/*` | generated data API, insert | `ro` on the route, `rw` on the statement |
| `PATCH /v1/db/:db/api/*` | generated data API, update | as above |
| `DELETE /v1/db/:db/api/*` | generated data API, delete | as above |
| `GET /v1/db/:db/openapi.json` | that database's OpenAPI 3.1 document | `ro` |
| `POST /v1/db/:db/graphql` | GraphQL over that database | `ro` on the route, per-table on each field |
| `GET /v1/db/:db/graphql` | GraphiQL, or a query in the URL | as above |
| `GET /v1/openapi.json` | this server's own OpenAPI 3.1 document | none |
| `GET /v1/replication` | node-to-node stream (WebSocket) | cluster secret, in-band |
| `POST /v1/db/:db/query` | one statement | `ro`, `rw` when it writes |
| `POST /v1/db/:db/promote` | make this node the primary for it | admin |
| `GET /v1/db/:db/replication` | txid, epoch, checksum, snapshot, replicas | `ro` |
| `POST /v1/db/:db/restore` | point-in-time restore | admin |
| `POST /v1/db/:db/snapshot` | force a snapshot | admin |
| `POST /v1/db/:db/tx` | open a baton transaction | `rw` |
| `POST /v1/db/:db/tx/:tx` | one statement in it | `rw` |
| `POST /v1/db/:db/tx/:tx/commit` | commit | `rw` |
| `POST /v1/db/:db/tx/:tx/rollback` | roll back | `rw` |
| `GET /v1/cluster` | control-plane membership, term and placement | admin |
| `GET /v1/cluster/raft` | node-to-node raft socket (WebSocket) | cluster secret, in-band |
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

An unknown path is a `404` in the error shape above, and so is an unsupported method on a known
path: only the methods an operation declares are mounted, and anything else falls through to the
same handler.

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
→ { "name": "acme", "role": "primary", "sizeBytes": 81920, "walBytes": 0, "logBytes": 12043,
    "txid": 4812, "epoch": 0, "checksum": "1734…", "openConns": 2,
    "liveQueries": 2, "subscribers": 5, "lastSnapshotTxid": 4800, "replicas": [] }

DELETE /v1/db/acme  → { "name": "acme", "deleted": true, "trash": "<dataDir>/trash/acme-1789…" }
```

On a **replica** the same body carries one more field, `"apply"`: which of design §4.5's two
apply mechanisms is actually running, `"pages"` or `"wal"`. It is normally `[replication] apply`,
and differs from it when this node's VFS cannot offer `xShmLock` and the applier fell back — which
is worth seeing, because a replica on mechanism B pays a wal-index rebuild on every read.
`docs/c5-apply-pages.md`. A primary has no applier and the field is absent.

`DELETE` moves the directory to `trash/` and tombstones the catalog row; the files themselves are
removed later, by the sweep, once they are older than `[durability] retention` (default `7d`).
`retention = "0"` keeps a deleted database for ever, which is what phase 0 and phase 1 did. Only a
directory the server itself named — `<name>-<ms>` — is ever removed, so anything an operator puts
in `trash/` by hand stays where it is.

**The same sweep retains the log and the snapshots** of every database this node has open, which is
what stops a busy node filling its disk (`docs/r6-retention.md`). It runs when the node starts and
then every `[durability] sweepIntervalMs` (default five minutes), and a database also gets one pass
when it is opened. A log segment is dropped only when every record in it is older than the
retention **and** below the floor: the txid of the oldest snapshot still kept, the lowest position
acked by a replica currently connected, and what the S3 shipper has put in the bucket, whichever is
lowest. A consumer that is absent imposes no floor. Snapshots older than the retention are removed
too, except the most recent one at or before the cutoff — the base a restore to exactly `retention`
ago replays from — and the newest snapshot, which is kept whatever its age. `[durability]
maxLogBytes` bounds a log by size as well, under the same floor.

A database that has **never been snapshotted** has no floor at all, so its log is bounded by age
alone and it stops being restorable to a point before its oldest surviving segment. Only the S3
shipper and a replica bootstrap take snapshots on their own; a node with neither should call
`POST /v1/db/{db}/snapshot` if it wants point-in-time restore.

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

### The generated data API, OpenAPI and GraphQL

Every database's own tables are also served as REST, described as an OpenAPI 3.1 document, and
queryable as GraphQL. All three are generated from one introspection of that database and all
three execute through the same path `POST /v1/db/{db}/query` does, so they inherit the token's
per-table ACLs, the deadlines, the row cap, `vmSteps`, the quota, the txid, the ack level,
`minTxid` and write forwarding rather than reimplementing any of them. `docs/h6-mount.md` is the
as-built note; `docs/plan-surfaces.md` is the design.

```http
GET    /v1/db/acme/api/users?name=like.ann*&order=name.asc&limit=20&select=id,name
GET    /v1/db/acme/api/users/1
POST   /v1/db/acme/api/users          { "name": "ann", "email": "ann@example.com" }
PATCH  /v1/db/acme/api/users/1        { "email": "ann@bunql.dev" }
DELETE /v1/db/acme/api/users/1
```

Filtering is PostgREST's URL grammar: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`,
`is`, with `select=` projecting and `order=col.asc|desc` sorting. A write answers with the row it
wrote, because every write statement carries `RETURNING`. A single-row read, update or delete whose
key matches nothing answers `404` with `{"error": {"code": "NOT_FOUND"}}` — one code from
`src/server/errors.ts`'s own vocabulary, not a second one. Through GraphQL the same row is `null`,
since a missing row is not an error there (`docs/h8-validated-requests.md`).

**Every identifier in the generated SQL comes from introspection and every value is a bound
parameter.** A filter, a `select=` or an `order=` naming a column the table does not have is a
`400` and never a query. Views are read-only; a table with neither a primary key nor a rowid gets
the collection routes and no `/{pk}` routes; generated columns are readable and not writable.

`GET /v1/db/{db}/openapi.json` is that database's document, and `GET /v1/openapi.json` is the
server's own — the one the route table itself is built from, so it cannot fall behind. The server
document is open, with no authentication: it names no database and carries no tenant data. The
per-database one needs `ro`, because it discloses that database's schema.

`POST /v1/db/{db}/graphql` serves a schema **generated from that same OpenAPI document**, so a
GraphQL field is a REST operation by construction. Fields are named from the tables:
`listUsers`/`getUser` on `Query`, `createUser`/`updateUser`/`deleteUser` on `Mutation`. Resolvers
dispatch in this process — no socket per field — and the caller's token is ambient per request
rather than captured, so one caller's rights never reach another's. `GET` with `Accept: text/html`
renders GraphiQL. Both `graphql` and `openapi-x-graphql` are optional peer dependencies: when they
do not resolve the route is simply absent, and the answer is an ordinary `404`.

Introspection, the compiled routes and the GraphQL schema are all cached per database on `PRAGMA
schema_version`, so a `CREATE TABLE`, an `ALTER TABLE` or a `DROP` rebuilds them by itself. A
database that is *deleted* drops its entries outright, since a new database of the same name
starts that counter over. Subscriptions are not generated — a REST document cannot describe one —
and are milestone H7.

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

#### How a replica applies (`[replication] apply`)

Design §4.5 has two mechanisms and `[replication] apply` chooses between them. The default is
**`"pages"`** (mechanism A, C5): the primary's pages are written into the replica's own database
file and the 136-byte wal-index header is rewritten under SQLite's own WAL lock set, so a
replica's `-wal` is **always zero bytes** and a reader takes `WAL_READ_LOCK(0)` and reads the
file. `"wal"` (mechanism B) is the phase-0 behaviour — append frames to the replica's WAL, zero
the header, let the next reader rebuild the index — and is the back-out.

- Both produce the same database, proved by the rolling checksum in every record; a replica that
  diverges raises `ChecksumMismatch`, sends `DIVERGED` and re-bootstraps from a snapshot. It never
  continues quietly.
- A page apply cannot run while a local reader holds a read transaction: `xShmLock` answers
  `SQLITE_BUSY`, the applier backs off for `[replication] applyBusyMs` (default 5000) and then
  defers the record and retries. Nothing is written under a reader, and nothing is lost.
- `GET /v1/db/{db}` on a replica reports `"apply"`, the mechanism actually running. It differs
  from the setting only when this VFS cannot offer `xShmLock`, in which case the applier falls
  back to `"wal"` and logs one line saying so.
- Switching a running replica from `"wal"` to `"pages"` folds its leftover WAL into the database
  file with one TRUNCATE checkpoint at the next apply. Switching back needs nothing.

Measured, `bench/wal.ts`: the "replica read sees the row" leg is **6.4 µs under `"pages"` against
47.2 under `"wal"`**. `docs/c5-apply-pages.md`.

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
| `POST /v1/db`, `DELETE /v1/db/:db`, `POST /v1/db/:db/restore`, `POST /v1/db/:db/import` | `503 NOT_PRIMARY` with `BunQL-Primary`, or `307` when the new primary is on the same origin. They are refused rather than forwarded: a create would have to come back over the replication stream to exist here anyway, and a delete on a copy the primary still owns removes the applier's own file. The gate is per database, so a promoted node serves them for what it was promoted for. Address the primary, or promote |
| `POST /v1/db/:db/checkpoint` with `TRUNCATE` | `503 NOT_PRIMARY`. Every other mode runs locally, and under `apply = "pages"` there is nothing in the WAL to checkpoint, so it reports zero |
| `POST /v1/db/:db/snapshot` | works: a replica has the file and a snapshot of it is a valid restore source |
| S3 shipping | off. A replica authors nothing, so it ships nothing; `restore` from a bucket still works |
| `ack: "replica"` / `"quorum"` on a forwarded write | honoured — the level travels with the forwarded body and the primary waits for it |
| promotion to primary | `POST /v1/db/:db/promote` and `bunql promote` (C2). A promoted node stops following that database, keeps the copy, and serves its own lifecycle routes for it |

A replica's `GET /readyz` is `503` while its stream is down, so a load balancer takes it out of
rotation rather than serving data that only gets staler.

## Promotion and failover

A replica becomes the primary for one database. `docs/c2-promotion.md` is the as-built note and
carries the safety argument; this is the surface.

### `POST /v1/db/{db}/promote`

Admin only. Body `{"force": false}`.

```json
{ "db": "acme", "promoted": true, "role": "primary", "epoch": 4, "txid": 918,
  "why": "n2 takes acme at epoch 4, fencing n1" }
```

It addresses **the node that should become the primary** — promotion is that node's own copy being
accepted — so `--url` names the candidate, not the cluster. A refusal changes nothing at all: the
decision is taken first, and in a cluster it is taken on the Raft leader against the leader's own
clock.

| refusal | status | meaning |
|---|---|---|
| `NO_COPY` | 404 | this node holds no copy of that database |
| `GENERATION_MISMATCH` | 409 | the copy is of a *different* database that wore this name. See `docs/r7-unfollow.md` |
| `STREAM_LIVE` | 409 | static topology only: this node is still streaming the database from its primary, which is therefore up |
| `ALREADY_PRIMARY` | 409 | this node already authors its transactions |
| `BEHIND` | 409 | another node has acknowledged a higher txid; promoting here would discard those transactions |
| `LEASE_HELD` | 503 | another node's lease is still live and it may still be writing |
| `NO_LEADER` | 503 | clustered, and no Raft leader could be reached |
| `NOT_COMMITTED` | 503 | the grant did not commit inside the control plane's propose timeout |

`"force": true` overrides exactly three of them — `STREAM_LIVE`, `LEASE_HELD` and `BEHIND` — and
nothing else. It is how an operator says "the old primary is gone, I have checked", and with
`ack: "local"` it is also how an operator accepts the lost tail above.

Promotion is per database. Promoting a whole node is a loop over `GET /v1/db`.

### What a promoted node does

It stops following that database (keeping the copy — this is not the R7 unfollow, which deletes
one), folds its WAL into the file, takes the new epoch, and reopens as a primary. From that
instant it serves its own lifecycle routes for it, `BunQL-Role` says `primary` for it, and every
`TxnRecord` it authors carries the new epoch.

Everything else it follows is untouched: a node is a primary for what it was promoted for and a
replica for the rest.

### What the old primary does

A node that learns another holds a newer epoch for a database it thought it owned **demotes
itself** for that database — at once, before any further write — rather than dying. Two things
teach it: a `SUBSCRIBE` arriving at epoch higher than its own (the existing `EPOCH_AHEAD` check in
`/v1/replication`), and, in a cluster, a committed lease naming somebody else.

A demoted node keeps serving reads from its copy and says where the database went. If it knows an
HTTP base for the new primary it follows it, and the existing divergence check does the rest: a
copy that diverged over the lost tail is handed a snapshot.

In a **static topology with no cluster** there is nothing to teach it automatically. A node brought
back with `--replica-of <new primary>` demotes through the ordinary replica path; one brought back
unchanged keeps serving its stale copy until an operator points it somewhere. That is the honest
limit of a topology with no control plane, and it is why promotion there is an explicit operator
action.

### What a client is told

| transport | answer |
|---|---|
| HTTP, new primary on the same origin | `307` with `Location` and `BunQL-Primary` |
| HTTP, new primary on another origin | `503 NOT_PRIMARY` with `BunQL-Primary` and `Location` |
| WebSocket | `{"event":"moved","db":"acme","primary":"http://…"}` to every socket that has named that database |

The split is not arbitrary. Following a cross-origin redirect strips `Authorization` (Fetch
standard, "HTTP-redirect fetch"), so a `307` across nodes would turn a retryable refusal into a
`401` the caller cannot explain; same-origin — one load balancer in front of the cluster, which is
how design §5.3's redirect is meant to be deployed — keeps the header and genuinely helps.

**The SDK replays the request once**, against the node the answer names, carrying its own token.
It does that for `307` and for `503 NOT_PRIMARY`, and for nothing else — in particular never for
`504 FORWARD_TIMEOUT` or a socket that dropped mid-forward, which mean *may or may not have
committed*, never for `ACK_TIMEOUT`, which means committed, and never inside an interactive
transaction, whose baton belongs to one node.

The reason the two are different: every producer of `NOT_PRIMARY` refuses **before** a statement
runs — the admin gate before the body is read, the lease check before the writer is taken, the
forwarder before a frame goes out — so replaying one cannot double-apply a write. `FORWARD_TIMEOUT`
is raised precisely because the node does not know what happened.

## The cluster control plane

`[cluster] enabled` puts this node in a small built-in Raft group that holds membership,
per-database placement and per-database leases. It is control plane only: **the write path never
waits on it**, and never awaits anything. A write consults the lease its own node already holds, in
memory, against a monotonic clock.

```http
GET /v1/cluster        → membership, term, leader, and where each database lives (admin)
GET /v1/cluster/raft   → the node-to-node raft socket; the cluster secret is proved in-band
```

```json
{ "id": "n2", "role": "leader", "term": 4, "leader": "n2",
  "commitIndex": 91, "appliedIndex": 91, "voters": ["n1","n2","n3"], "learners": [],
  "nowMs": 1789211888147,
  "nodes": [{ "id": "n1", "advertise": "ws://10.0.0.1:4321", "zone": "", "status": "voter",
              "reachable": true, "joinedTerm": 1 }],
  "dbs": [{ "db": "acme", "primary": "n1", "replicas": ["n2","n3"], "epoch": 2,
            "lease": { "node": "n1", "until": 1789211889347 }, "acked": { "n1": "918" },
            "generation": "cccd5653576f50ff", "leaseHeldHere": false }] }
```

`lease.until` is the **Raft leader's** wall clock and is meaningless against any other, which is
why `nowMs` travels beside it. `leaseHeldHere` is the only thing in the body derived from the
answering node's own monotonic clock, and it is what the write path actually asks.

A node with no `[cluster]` section answers `503 CLUSTER_DISABLED` rather than pretending.

### The lease, and why two primaries are impossible

The leader grants a database's primary a lease for `leaseTtlMs`. The holder renews it every
`leaseRenewMs` — **the holder, never the leader on its behalf**, because a leader renewing for a
node that has died would keep a dead primary's database for ever and nothing would ever fail over.

The holder treats the lease as valid until `leaseTtlMs - leaseGuardMs` from the moment it **asked**
for the grant, on its own monotonic clock. The leader stamps `until` after that moment, so the
holder's deadline is earlier than the leader's by at least the guard, whatever the offset between
the two wall clocks — no node ever reads another node's. The leader will not grant the lease
elsewhere before `until`. The window in which two nodes could both write is therefore negative by
`leaseGuardMs`, and that is the whole of it.

A node whose lease has lapsed refuses writes with `503 NOT_PRIMARY` and keeps serving reads, which
carry `BunQL-Role: replica`.

### Failover

When a lease lapses on the leader's own clock, the leader grants it to the reachable node in that
database's placement with the highest acknowledged txid, ties broken by node id. The database's
epoch moves, the old primary is fenced by it, and the winner promotes itself locally. With
`ack: "local"` this can lose the tail — see [Durability levels](#durability-levels).

### `[cluster]`

```toml
[cluster]
enabled = false        # BUNQL_CLUSTER_ENABLED; setting `peers` turns it on
id = ""                # this node's id; defaults to [server] node
advertise = ""         # ws://host:port other nodes reach this one at, and the HTTP base clients are sent to
zone = ""              # rack/AZ label; C3's placement reads it
peers = []             # ["n2=ws://b:4321", "ws://c:4321"] — an id is derived from host:port when absent
bootstrap = false      # form a new group from `peers` instead of waiting to join one
rf = 2                 # replica factor; recorded, not yet used
leaseTtlMs = 3000
leaseRenewMs = 1000
leaseGuardMs = 500     # the margin that makes two primaries impossible; do not tune down casually
electionTimeoutMs = 1500
heartbeatMs = 300
```

Every key takes a `BUNQL_CLUSTER_*` override, and `BUNQL_CLUSTER_PEERS` is comma-separated. The
cluster shares `[replication] secret` — the two sockets run between the same nodes and a second
secret would be a second thing to rotate — so `[cluster] enabled` with no secret is a configuration
error. So is a `leaseGuardMs` at or above `leaseTtlMs`, or a `leaseRenewMs` that leaves no room
inside `leaseTtlMs - leaseGuardMs`.

**What C2 does not do:** placement. A database enters the control plane when the node that holds it
claims it, not because a hash says it belongs somewhere, and a database the control plane has never
heard of is not lease-gated at all. Consistent hashing, `rf` and zones are C3.

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
            [--cluster-peers a=ws://a:4321,b=ws://b:4321] [--advertise ws://me:4321] [--zone z]
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
bunql promote <db> [--force]
bunql cluster
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

When the primary is gone, `bunql promote` is addressed at the replica that should take over —
promotion is that node's own copy being accepted, so `--url` names the candidate:

```sh
bunql --url http://127.0.0.1:4502 promote acme          # refused while the primary is up
bunql --url http://127.0.0.1:4502 promote acme --force  # "it is gone, I have checked"
```

`serve --cluster-peers` puts the node in a Raft control plane, which is what makes failover
automatic. Every node needs its own `--advertise`, and they all share `--cluster-secret`:

```sh
bunql serve --dir ./a --port 4501 --cluster-secret $SECRET \
            --advertise ws://127.0.0.1:4501 --cluster-peers b=ws://127.0.0.1:4502,c=ws://127.0.0.1:4503
bunql cluster   # membership, term, and where each database lives
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

## Workers

`[server] workers = N` (or `bunql serve --workers N`) runs the node's databases on **N worker
threads** and keeps the listener, every socket, the catalog and the authenticator on the main
thread, which owns no database of its own. A database belongs to the worker its name hashes to;
every `/v1/db/{db}/…` request, every WebSocket frame and every libsql socket is routed there. The
default, `1`, is exactly the single-threaded node this has always been: no thread is spawned and
nothing is routed. `0` means one per core, capped at 8.

It exists because write throughput was bound by the process rather than by the database. Measured
on eight databases over one port, single-row writes from 64 sockets: **28 809 writes/s at one
worker, 72 817 at six** — 2.67x (`bun run bench/workers.ts`, `docs/c4-workers.md` §9).

Two things change in what a sharded node reports, both in reporting rather than in data: `GET
/v1/db` says `"open": false` for every database, because "open" is a fact about one worker's LRU;
and `GET /metrics` sums every worker's counters but omits the **storage** gauges, which are per
worker with no summing rule that is not a lie. The replication gauges are reported: `connected` and
`bytes` from the router, which owns every socket, `records` summed and `lag_txid` maxed across the
workers, which own the streams.

**A sharded node serves replicas.** `[server] workers = N` and `[replication] secret` work together
as of C4b: the router owns the replication socket and the worker that owns a database owns that
database's stream, so one socket follows databases across every shard and a replica sees exactly
the bytes a single-threaded node would have sent it. `docs/c4b-replication-workers.md`.

**And it follows one.** `[server] workers = N` and `[replication] primary` work together as of C4c,
the same seam cut the other way: the router owns the one upstream connection — the socket, the
reconnect, the handshake, the generation ledger, R7's reconciliation and R2's forward queue — and
the worker that owns a database owns that database's stream, so `openReplica`, the snapshot file,
`installSnapshot`, `pin` and `applyRecord` all run on the thread that holds the writer. `readyz` on
such a node is still one fact and it is the router's; `GET /v1/db/{db}/replication` reports that
shard's stream beside the connection state pushed down to it.
`docs/c4c-replication-follow.md`.

**Sharding a replica helps its HTTP reads and not its socket reads**, and the difference is the
router. Point reads against a replica of eight databases: **34 600 reads/s at one worker and 55 300
at six over HTTP** (1.60x, flat past two workers), against **259 700 and 232 300 over one
WebSocket** — 0.90x, because every socket frame is relayed by the router and a point read is
cheaper than the hop. `bun run bench/workers.ts --follow [--transport http]`.

**`workers > 1` can now be combined with everything, `[cluster] enabled` included**
(`docs/c4d-cluster-workers.md`). The `ClusterNode` stays whole on the router — the Raft log, the
socket, the timers, renewal and failover are one per node — and only the lease *deadline* is pushed
down, converted into the worker's own monotonic clock, because each worker thread has its own
`performance.timeOrigin`. The write path is unchanged by it: a six-worker clustered node does
**86 573 writes/s against a plain one's 86 754**, because `assertWritable` on a worker is the same
`Map.get` and `performance.now()` it is on one thread and costs no message at all.
`bun run bench/workers.ts --cluster`.

### GraphQL subscriptions

`GET /v1/db/{db}/{graphql path}` upgraded with the **`graphql-transport-ws`** subprotocol is a
GraphQL socket — the protocol `graphql-ws`, Apollo and urql all speak. One root field:

```graphql
subscription {
  changes(tables: ["todos"], since: 41, include: row) {
    txid
    atMs
    reset
    changes { op table pk row old }
  }
}
```

It carries the **change feed**, the same events SSE `GET /v1/db/{db}/changes` and the `bunql.v1`
socket carry, with the same `tables` filter and the same `since` replay. `reset` is true on the
first event when `since` was older than the ring could serve: there is a gap, so re-query rather
than trust the feed. A client that wants a live *result* re-runs its query when an event arrives.

A `query` or a `mutation` sent over the same socket is answered and completed, through the same
executor and the same depth and complexity limits the HTTP surface uses.

**Authentication is `connection_init`'s payload** — `{"authorization": "Bearer …"}` or
`{"token": "…"}` — because a browser cannot set a header on a WebSocket. `Authorization` on the
upgrade and `?token=` both work too. The principal is settled once, at `connection_init`, and every
operation on the socket runs as it; `ro` on the database is what a subscription needs.

### Writes on a replica

A replica **forwards** a write to its primary and serves reads locally, on both surfaces: the
native `/v1/db/{db}/query` and `batch` (R2) and the libsql-compatible `/v2/pipeline` (R4b). A
transaction opened on a replica runs on the primary, and every statement in it — reads included —
goes there, so a read inside the transaction sees the transaction's own uncommitted writes.

`BEGIN TRANSACTION READONLY` on a replica is refused. A tenant transaction takes the database's
single writer whatever its mode, and a replica's writer belongs to the applier — a client holding it
would stall replication. Every statement on a replica is already a snapshot read, and
`BunQL-Min-Txid` pins which snapshot.

With `[replication] forwardWrites = false` a replica is read-only and a write is refused with
`503 NOT_PRIMARY` and `BunQL-Primary`.

### Per-database settings

`PATCH /v1/db/{db}` changes settings that belong to one database rather than to the node.

```json
{ "foreignKeys": true }
```

`foreignKeys` has **three** states: `true`, `false`, and `null` to clear the override so the
database follows `[sqlite] foreignKeys` again. "Nobody has said" is deliberately not the same fact
as "off" — collapsing them would mean a node that later turns the node-level switch on could not
reach a database created before it did. `GET /v1/db/{db}` reports the live value, `null` for the
databases that follow the node, which is almost all of them.

`PRAGMA foreign_keys` is per **connection**, so this closes and reopens the database: anything open
on it ends the way an eviction ends it. Turning it on can make writes that succeed today start
failing `SQLITE_CONSTRAINT_FOREIGNKEY`, which is the whole point of it being opt-in.

### Placement, in a cluster

With `[cluster] enabled`, a database has a **home node**, picked by rendezvous hashing over the
cluster's membership with `[cluster] zone` spreading its `[cluster] rf` copies across racks. Every
node computes the same home from the same replicated membership, so:

- `POST /v1/db` on a node that is **not** the home answers `503 NOT_PRIMARY` with `BunQL-Primary`
  naming the node that is. That is what stops two nodes creating the same database; the SDK retries
  against the named node, and a same-origin deployment gets a `307` instead.
- A request naming a database this node holds **no copy** of, which the cluster knows and places
  elsewhere, answers the same way rather than `404`. A name nothing has heard of is still `404`.
- A database that already exists on a node keeps working there whatever the function would say now.
  A placement never moves a live database: only a failover or `POST /v1/db/{db}/promote` does.

`[cluster] enabled = false` places nothing — every node creates whatever it is asked for, which is
the standalone product. `docs/c3-placement.md`.

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
| `[server] workers` | `1` | `BUNQL_SERVER_WORKERS` | — |
| `[data] dir` | `"./data"` | `BUNQL_DATA_DIR` | `BUNQL_DIR` |
| `[data] maxOpen` | `1024` | `BUNQL_DATA_MAX_OPEN` | `BUNQL_MAX_OPEN` |
| `[data] readers` | `2` | `BUNQL_DATA_READERS` | `BUNQL_READERS` |
| `[data] pageSize` | `4096` | `BUNQL_DATA_PAGE_SIZE` | `BUNQL_PAGE_SIZE` |
| `[data] quotaBytes` | `0` (unlimited) | `BUNQL_DATA_QUOTA_BYTES` | `BUNQL_QUOTA_BYTES` |
| `[sqlite] writerCacheBytes` | `8388608` | `BUNQL_SQLITE_WRITER_CACHE_BYTES` | — |
| `[sqlite] readerCacheBytes` | `2097152` | `BUNQL_SQLITE_READER_CACHE_BYTES` | — |
| `[sqlite] readerMmapBytes` | `0` (off) | `BUNQL_SQLITE_READER_MMAP_BYTES` | — |
| `[sqlite] foreignKeys` | `false` | `BUNQL_SQLITE_FOREIGN_KEYS` | — |
| `[sqlite] trustedSchema` | `true` | `BUNQL_SQLITE_TRUSTED_SCHEMA` | — |
| `[sqlite] cellSizeCheck` | `false` | `BUNQL_SQLITE_CELL_SIZE_CHECK` | — |
| `[durability] defaultAck` | `"local"` (also `fsync`, `replica`, `quorum`) | `BUNQL_DURABILITY_DEFAULT_ACK` | `BUNQL_DEFAULT_ACK` |
| `[durability] checkpointWalBytes` | `4000000` | `BUNQL_DURABILITY_CHECKPOINT_WAL_BYTES` | `BUNQL_CHECKPOINT_WAL_BYTES` |
| `[durability] retention` | `"7d"` (`"0"` keeps everything) | `BUNQL_DURABILITY_RETENTION` | `BUNQL_RETENTION` |
| `[durability] sweepIntervalMs` | `300000` (`0` sweeps only at start) | `BUNQL_DURABILITY_SWEEP_INTERVAL_MS` | — |
| `[durability] maxLogBytes` | `0` (unlimited) | `BUNQL_DURABILITY_MAX_LOG_BYTES` | — |
| `[durability] segmentBytes` | `16777216` | `BUNQL_DURABILITY_SEGMENT_BYTES` | — |
| `[durability] compress` | `true` (zstd) | `BUNQL_DURABILITY_COMPRESS` | — |
| `[durability] snapshotIntervalMs` | `3600000` (`0` off) | `BUNQL_DURABILITY_SNAPSHOT_INTERVAL_MS` | — |
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
| `[limits] groupCommit` | `false` | `BUNQL_LIMITS_GROUP_COMMIT` | — |
| `[limits] groupCommitMax` | `64` | `BUNQL_LIMITS_GROUP_COMMIT_MAX` | — |
| `[auth] verifyCacheSize` | `1024` (`0` disables) | `BUNQL_AUTH_VERIFY_CACHE_SIZE` | — |
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
| `[replication] apply` | `"pages"` (or `"wal"`) | `BUNQL_REPLICATION_APPLY` | — |
| `[replication] applyBusyMs` | `5000` | `BUNQL_REPLICATION_APPLY_BUSY_MS` | — |
| `[replication] ackTimeoutMs` | `2000` | `BUNQL_REPLICATION_ACK_TIMEOUT_MS` | — |
| `[replication] ackWithoutReplicas` | `"error"` (or `"allow"`) | `BUNQL_REPLICATION_ACK_WITHOUT_REPLICAS` | — |
| `[replication] heartbeatMs` | `5000` | `BUNQL_REPLICATION_HEARTBEAT_MS` | — |
| `[replication] slowReplicaMs` | `30000` | `BUNQL_REPLICATION_SLOW_REPLICA_MS` | — |
| `[replication] reconnectMs` | `250` | `BUNQL_REPLICATION_RECONNECT_MS` | — |
| `[replication] forwardWrites` | `true` | `BUNQL_REPLICATION_FORWARD_WRITES` | — |
| `[replication] forwardTimeoutMs` | `10000` | `BUNQL_REPLICATION_FORWARD_TIMEOUT_MS` | — |
| `[replication] maxForwards` | `256` | `BUNQL_REPLICATION_MAX_FORWARDS` | — |
| `[cluster] enabled` | `false`; `true` once `peers` is set | `BUNQL_CLUSTER_ENABLED` | — |
| `[cluster] id` | `""` → `[server] node` | `BUNQL_CLUSTER_ID` | — |
| `[cluster] advertise` | `""` | `BUNQL_CLUSTER_ADVERTISE` | — |
| `[cluster] zone` | `""` | `BUNQL_CLUSTER_ZONE` | — |
| `[cluster] peers` | `[]`; `id=ws://host:port` or a bare URL | `BUNQL_CLUSTER_PEERS` (comma-separated) | — |
| `[cluster] bootstrap` | `false` | `BUNQL_CLUSTER_BOOTSTRAP` | — |
| `[cluster] rf` | `2` (recorded; placement is C3) | `BUNQL_CLUSTER_RF` | — |
| `[cluster] leaseTtlMs` | `3000` | `BUNQL_CLUSTER_LEASE_TTL_MS` | — |
| `[cluster] leaseRenewMs` | `1000` | `BUNQL_CLUSTER_LEASE_RENEW_MS` | — |
| `[cluster] leaseGuardMs` | `500` | `BUNQL_CLUSTER_LEASE_GUARD_MS` | — |
| `[cluster] electionTimeoutMs` | `1500` | `BUNQL_CLUSTER_ELECTION_TIMEOUT_MS` | — |
| `[cluster] heartbeatMs` | `300` | `BUNQL_CLUSTER_HEARTBEAT_MS` | — |
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
| `[api] enabled` | `true` | `BUNQL_API_ENABLED` | — |
| `[api] prefix` | `"api"` (one path segment) | `BUNQL_API_PREFIX` | — |
| `[api] defaultLimit` | `100` | `BUNQL_API_DEFAULT_LIMIT` | — |
| `[api] maxLimit` | `1000` | `BUNQL_API_MAX_LIMIT` | — |
| `[graphql] enabled` | `true`, ignored without the optional peers | `BUNQL_GRAPHQL_ENABLED` | — |
| `[graphql] graphiql` | `true` | `BUNQL_GRAPHQL_GRAPHIQL` | — |
| `[graphql] path` | `"graphql"` (one path segment) | `BUNQL_GRAPHQL_PATH` | — |
| `[graphql] maxDepth` | `12` | `BUNQL_GRAPHQL_MAX_DEPTH` | — |
| `[graphql] maxComplexity` | `10000` | `BUNQL_GRAPHQL_MAX_COMPLEXITY` | — |

Setting `[replication] primary` makes the node a replica; `role` need not be set as well. A
replica with no `primary` is refused at start.

Setting `[s3] bucket` turns shipping on the same way. `enabled = false` keeps the bucket
configured without shipping to it, which is how a recovery node reads a backup it does not write.
A `[s3] retention` or a `[durability] retention` that is not a duration is refused at start rather
than silently ignored. `[durability] retention` is how long a deleted database stays in
`<dataDir>/trash/`, and how far back this node keeps its own log segments and snapshots; `[s3]
retention` is the separate bound on what the bucket holds.

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
| §4.4 local log and snapshot retention | R6. `TxnLog.retain` and `removeSnapshot` had no caller at all; `[durability] sweepIntervalMs` and `maxLogBytes` are new. See `docs/r6-retention.md` |
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

### Landed in phase 2

| design | status |
|---|---|
| §5.3 built-in Raft control plane (membership, placement, per-database leases) | C1/C2. Control plane only; the write path consults a cached lease against a monotonic clock and never awaits |
| §6.5 `POST /v1/db/{db}/promote` | C2, with the epoch fencing the old primary and `force` overriding exactly three refusals |
| §5.3 failover on a lapsed lease | C2. The holder renews its own lease; the leader grants a lapsed one to the reachable replica with the highest acked txid |
| §5.3 `307` + `BunQL-Primary`, WS `moved` | C2. `307` same-origin only, because a cross-origin redirect strips `Authorization`; the SDK replays once instead |
| §9.3 `bunql promote`, `bunql cluster` | C2 |
| §9.4 `[cluster]` | C2, without `rf` — placement is C3 |

`docs/c2-promotion.md` is the as-built note.

### Still not implemented

| design | status |
|---|---|
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
  and is removed by the sweep once it is older than `[durability] retention`.
- **Log retention is held to a floor, not to the age bound alone.** Design §4.4 says "`retention:
  "7d"` default; a replica or S3 shipper that falls behind the retention window re-bootstraps from
  snapshot + tail". This node keeps the log for a *connected* replica and for an unshipped bucket
  however far behind they are, and re-bootstraps only a replica that has actually gone — deleting
  records a live follower is about to read would be silent and unrecoverable. See
  `docs/r6-retention.md`.
- **Admin writes are refused on a replica, not forwarded.** `POST /v1/db`, `DELETE /v1/db/{db}`,
  `POST /v1/db/{db}/restore` and `POST /v1/db/{db}/import` answer `503 NOT_PRIMARY`. Design §5.2's
  "forward writes to the primary" is about statement writes; the lifecycle routes act on a node's
  own files, and a replica does not own its copy.
