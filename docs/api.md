# BunQL API reference

The API as implemented in phase 0. `docs/design.md` is the proposal; this file is the thing that
runs. Where the two differ, the difference is listed at the end under
[Differences from the design](#differences-from-the-design) rather than left for you to find.

The route table below is generated from the server's own routing table — `bun run
scripts/routes.ts` prints it, and `bun run scripts/routes.ts --check` fails if this document falls
behind it.

**Contents** — [Conventions](#conventions) · [HTTP](#http-api) · [WebSocket](#websocket-protocol) ·
[SSE](#sse-event-formats) · [Client SDK](#client-sdk) · [Embedded](#embedded-api) ·
[CLI](#cli) · [Configuration](#configuration) ·
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
| `BunQL-Role` | `primary` (always, on a standalone node) |
| `BunQL-Duration-Us` | microseconds spent in the handler |

`BunQL-Primary` appears on a `NOT_PRIMARY` error. While `[server] cors` is on (the default) all
five are listed in `Access-Control-Expose-Headers`, and `OPTIONS` on any route is a preflight.

### Request options

Accepted as body fields on every statement-bearing request, and two of them as headers:

| option | header | values | default |
|---|---|---|---|
| `rows` | — | `"array"`, `"object"` | `"array"` |
| `maxRows` | — | positive integer; a result above it fails the request | `[limits] maxRows`, 10000 |
| `timeoutMs` | — | positive integer, clamped to the configured limit | `[limits] queryTimeoutMs` |
| `ack` | `BunQL-Ack` | `"local"`, `"fsync"` | `[durability] defaultAck`, `local` |
| `minTxid` | `BunQL-Min-Txid` | integer; the request waits up to 2 s, then `425` | none |
| `consistency` | — | `"ryw"`, `"primary"`, `"any"` | `"ryw"` |

`ack: "replica"` and `"quorum"` are a `400` on a standalone node rather than a silent downgrade.
`consistency` is validated but changes nothing on a single node; `minTxid` does the work.

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

`failedIndex` is added for a batch, `primary` for `NOT_PRIMARY`.

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
| `TX_BUSY` | 409 | another transaction holds the writer; `Retry-After: 1` |
| `SQLITE_CONSTRAINT_*` | 409 | the constraint SQLite names |
| `PAYLOAD_TOO_LARGE` | 413 | body over `[limits] maxBodyBytes` or `maxImportBytes` |
| `TXID_NOT_AVAILABLE` | 425 | `minTxid` did not land within the wait |
| `BUSY` | 503 | `SQLITE_BUSY`/`SQLITE_LOCKED`, or a snapshot in progress |
| `NOT_PRIMARY` | 503 | reserved for replicas; carries `BunQL-Primary` |
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
| `GET /v1/db/:db/changes` | change feed, SSE or long poll | `ro` |
| `POST /v1/db/:db/checkpoint` | manual checkpoint | admin |
| `GET /v1/db/:db/dump` | stream the SQLite file out | admin |
| `POST /v1/db/:db/import` | stream a SQLite file in | admin |
| `GET /v1/db/:db/live` | live query, SSE | `ro` |
| `POST /v1/db/:db/query` | one statement | `ro`, `rw` when it writes |
| `GET /v1/db/:db/replication` | txid, epoch, checksum, snapshot | `ro` |
| `POST /v1/db/:db/restore` | point-in-time restore | admin |
| `POST /v1/db/:db/snapshot` | force a snapshot | admin |
| `POST /v1/db/:db/tx` | open a baton transaction | `rw` |
| `POST /v1/db/:db/tx/:tx` | one statement in it | `rw` |
| `POST /v1/db/:db/tx/:tx/commit` | commit | `rw` |
| `POST /v1/db/:db/tx/:tx/rollback` | roll back | `rw` |
| `POST /v1/tokens` | mint a scoped token | admin |
| `DELETE /v1/tokens/:jti` | revoke one | admin |
| `GET /v1/ws` | WebSocket upgrade, sub-protocol `bunql.v1` | any |

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
`lastInsertRowid` is read either side of the step, so an `UPDATE` on a pooled connection never
reports somebody else's earlier insert; an insert that reuses a rowid reports `null`.

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

An open transaction holds the tenant's single writer. One per database: a second `POST /v1/db/{db}/tx`
is `409 TX_BUSY` with `Retry-After: 1`, and a plain write to the same database is refused the same
way. The transaction is rolled back after `[limits] txIdleTimeoutMs` (5 s) without a statement, and
when the WebSocket that opened it closes. A failed statement leaves the transaction usable.

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

`DELETE` moves the directory to `trash/` and tombstones the catalog row; nothing sweeps the trash
in phase 0.

```http
POST /v1/db/acme/snapshot   {}
→ { "snapshotId": "00000000000000004812.db", "txid": 4812, "bytes": 81920,
    "checksum": "1734…", "createdAtMs": 1789… }

POST /v1/db/acme/restore    { "at": 4800, "into": "acme-recovered" }
→ 201 { "name": "acme-recovered", "txid": 4800, "from": "acme", "at": 4800 }

POST /v1/db/acme/checkpoint { "mode": "TRUNCATE" }
→ { "mode": "TRUNCATE", "busy": false, "log": 0, "checkpointed": 0, "walBytes": 0, "txid": 4812 }

GET  /v1/db/acme/replication
→ { "db": "acme", "txid": 4812, "epoch": 0, "checksum": "1734…",
    "lastSnapshot": { "txid": 4800, "bytes": 81920, "at": 1789… },
    "role": "primary", "replicas": [] }
```

`restore` always builds a **new** database — `into` names it, and without it the name is
`<db>-restore-<txid>`. Restoring in place would leave the log holding records past the restore
point that no longer describe the file.

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

Metrics are per-process counters only — nothing keyed by database, so cardinality is bounded.

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
already authenticated gets the greeting on open.

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
bunql db create <name> [--from <db>[@<txid|time>]] [--page-size N] [--quota-bytes N]
bunql db list
bunql db stat <name>
bunql db delete <name>
bunql db fork <name> --from <db>[@<txid|time>]
bunql snapshot <db>
bunql restore <db> --at <txid|time> [--into <name>]
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
| `[durability] defaultAck` | `"local"` | `BUNQL_DURABILITY_DEFAULT_ACK` | `BUNQL_DEFAULT_ACK` |
| `[durability] checkpointWalBytes` | `4000000` | `BUNQL_DURABILITY_CHECKPOINT_WAL_BYTES` | `BUNQL_CHECKPOINT_WAL_BYTES` |
| `[durability] retention` | `"7d"` | `BUNQL_DURABILITY_RETENTION` | `BUNQL_RETENTION` |
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
| `[limits] maxBodyBytes` | `8388608` | `BUNQL_LIMITS_MAX_BODY_BYTES` | `BUNQL_MAX_BODY_BYTES` |
| `[limits] maxImportBytes` | `1073741824` | `BUNQL_LIMITS_MAX_IMPORT_BYTES` | `BUNQL_MAX_IMPORT_BYTES` |
| `[auth] adminKey` | generated on first start | `BUNQL_AUTH_ADMIN_KEY` | `BUNQL_ADMIN_KEY` |
| `[auth] jwtKey` | generated on first start | `BUNQL_AUTH_JWT_KEY` | `BUNQL_JWT_ED25519` |
| `[auth] jwtPublicKeys` | `[]` | `BUNQL_AUTH_JWT_PUBLIC_KEYS` (comma-separated) | — |
| `[auth] keysFile` | `<dataDir>/keys.json` | `BUNQL_AUTH_KEYS_FILE` | `BUNQL_KEYS_FILE` |
| `[auth] clockToleranceSec` | `30` | `BUNQL_AUTH_CLOCK_TOLERANCE_SEC` | `BUNQL_CLOCK_TOLERANCE_SEC` |
| `[auth] defaultTokenTtlMs` | `2592000000` (30 d) | `BUNQL_AUTH_DEFAULT_TOKEN_TTL_MS` | `BUNQL_TOKEN_TTL_MS` |

One more, outside the config file: `BUNQL_SQLITE_LIB` names the `libsqlite3` the driver loads.
Without it the usual Homebrew and Linux paths are tried.

---

## Differences from the design

Everything below is a place where the implementation does not match `docs/design.md`. The design
document is not edited; this is the list.

### Not implemented in phase 0

| design | status |
|---|---|
| §6.7 Hrana compatibility (`/v2/pipeline`, `/v3/pipeline`, `hrana3`/`hrana2` sockets) | phase 1 (§11) |
| §6.5 `POST /v1/db/{db}/promote` | phase 1; nothing to promote to on a standalone node |
| §8 replication protocol (`/v1/replication` binary frames) | phase 1. `GET /v1/db/{db}/replication` is the JSON status route of §6.5, not this |
| §5.4 `ack: "replica"` and `"quorum"` | a `400`, not a silent downgrade — there are no replicas to be durable on |
| §9.2 `bunql/kysely`, `bunql/drizzle` | phase 1 |
| §9.2 `BunQL.open({ s3 })` | phase 1; the option would be a promise the node cannot keep |
| §9.3 `bunql promote`, `bunql cluster` | phase 1 and 2 |
| §9.3 `bunql serve --replica-of` | phase 1 |
| §9.4 `[s3]`, `[replication]`, `[cluster]` | phase 1 and 2 |

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
  but a larger value would not be honoured.
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
  and nothing sweeps it in phase 0.
