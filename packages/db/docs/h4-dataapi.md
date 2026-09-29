# H4 — `src/dataapi/`, a database's own tables as an API

Milestone H4 of `docs/plan-surfaces.md`. A tenant's SQLite schema in, a core `Registry` out. That
registry is a plain one: `src/http/` mounts it, `src/openapi/` describes it and `src/graphql/`
(H5) is generated from that description, with no special case anywhere for the fact that these
operations were generated rather than written by hand. One introspection, three surfaces.

```ts
import { DataApiCache } from "bql.sh/dataapi"

const cache = new DataApiCache({ defaultLimit: 100, maxLimit: 1000 })
const { schema, registry } = await cache.for("acme", exec)   // exec closes over src/server/exec.ts
```

Two invariants hold the whole module up, and they are the two things to check in review:

1. **Every identifier in the generated SQL comes from introspection, and every value is a bound
   parameter.** There is no path by which a string from a request reaches the SQL text.
2. **Nothing here runs a statement.** Every statement goes through `src/server/exec.ts`, so the
   token's per-table ACLs, the deadline, the row cap, `vmSteps`, the quota, the txid, the ack
   level and write forwarding are *inherited*, not reimplemented.

## Introspection

`PRAGMA table_list` for the objects, `table_xinfo` for the columns, `foreign_key_list`,
`index_list` and `index_info` for the rest. Skipped: anything outside the `main` schema, anything
named `sqlite_%`, and `table_list`'s `shadow` and `virtual` rows — a virtual table's columns are
its module's interface, and an `INSERT` into an FTS5 table means something this API has no way to
describe.

Tables are **sorted by name**, so the generated operation ids and the collision-breaking below are
the same on every node and across restarts.

`table_xinfo` rather than `table_info` because `table_info` omits generated columns entirely, and
a generated column is readable. Its `hidden` column is the one that says so: `0` ordinary, `1` a
virtual table's hidden column (dropped), `2` VIRTUAL generated, `3` STORED.

### Affinity is what this keyed on

SQLite's declared types are advisory. `CREATE TABLE t(a VARCHAR(9), b UNSIGNED BIG INT)` makes a
TEXT-affinity column and an INTEGER-affinity one, and an introspector that matched type *names*
would call both of them strings. So `affinityOf` applies SQLite's own five rules, in its order, to
the declared text, and the core schema follows the affinity:

| affinity | rule (first match wins) | core schema |
|---|---|---|
| INTEGER | contains `INT` | `s.int64()` |
| TEXT | contains `CHAR`, `CLOB` or `TEXT` | `s.string()` |
| BLOB | contains `BLOB`, or the type is blank | `s.blob()` — but see below |
| REAL | contains `REAL`, `FLOA` or `DOUB` | `s.union([s.number(), {"$f"}])` |
| NUMERIC | anything else | `s.sqliteValue()` |

- **An INTEGER column is `s.int64()` and never `s.int()`.** A SQLite integer is 64 bits; narrowing
  it to a JSON number is exactly the silent precision loss design §6.1 names in rqlite and D1. The
  published schema carries both branches — a plain integer and `{"$i": "<decimal>"}` — so a
  generated client is told it has to handle the tagged form.
- **A column declared with no type at all** has BLOB affinity, which in SQLite means *no* affinity:
  nothing is converted on the way in, so the column may hold any of the five storage classes. It
  publishes as `s.sqliteValue()`. A column declared `BLOB` really is bytes and publishes as
  `s.blob()`.
- **REAL publishes the union of a JSON number and `{"$f": "inf"}`**, because that is what the wire
  carries for a non-finite double. A bare `number` would be a document that lies about its own
  responses for the one value JSON cannot write. The cost is that a REAL column reaches GraphQL as
  the catch-all scalar rather than as `Float` — the same trade `s.int64()` already makes.
- **NUMERIC is `s.sqliteValue()`** because a NUMERIC column stores an integer, a real or the
  original text, whichever the value fits, and saying which of those it is would be a guess.

### Nullability, keys and what may be left out of an insert

- `nullable` is `notnull = 0`, *minus* the two cases where SQLite knows better: an
  `INTEGER PRIMARY KEY` is the rowid and can never read back NULL even though `table_info` reports
  `notnull = 0`, and a PRIMARY KEY column of a `WITHOUT ROWID` table is implicitly NOT NULL.
- `optionalOnInsert` is nullable, or has a DEFAULT, or is the `INTEGER PRIMARY KEY` alias. Only a
  NOT NULL column with no default and no alias is `required` in the insert body.
- The **key** a `/{pk}` route addresses is the declared primary key in key order; failing that, a
  rowid table's own `rowid`, added to the schema as a synthetic, readable, never-writable column so
  that list → get → delete is a usable flow on a table with no primary key. The spelling is the
  first of `rowid`, `_rowid_`, `oid` the table has not shadowed.
- **A view, and a table that shadowed all three rowid spellings, get the collection routes and no
  `/{pk}` routes.** A view is read-only throughout.

### The cache

`DataApiCache` keys an entry on `PRAGMA schema_version`, SQLite's own counter, which every DDL
statement on the database increments. So a `CREATE TABLE`, an `ALTER TABLE` or a `DROP`
invalidates the cache by itself and nothing else in bql.sh has to remember to. The check is one
pragma per request against re-reading five pragmas per table. `invalidate(db)` is there for the
`schema` event `src/realtime/` already emits, but it is an optimisation — the version check is the
correctness story. Two concurrent cold requests introspect once between them, not once each.

**Introspection runs with the server's own rights, not the caller's.** The result is cached and
shared by every caller of that database, so a schema read under one token's table ACL would be
served to the next caller as if it were the whole database. Per-request authority stays where it
belongs, on the data statements, inside `exec.ts`. Two of the pragmas need it anyway: see the
findings.

## The operations

For a table `users`, with the default prefix `/v1/db/:db/api`:

| id | method & path | response |
|---|---|---|
| `listUsers` | `GET /v1/db/{db}/api/users` | `200` `[User]` |
| `getUser` | `GET /v1/db/{db}/api/users/{id}` | `200` `User` or `null` |
| `createUser` | `POST /v1/db/{db}/api/users` | `201` `[User]` |
| `updateUser` | `PATCH /v1/db/{db}/api/users/{id}` | `200` `User` or `null` |
| `deleteUser` | `DELETE /v1/db/{db}/api/users/{id}` | `200` `User` or `null` |

Components per table: `User` (the row), `NewUser` (the insert body), `UserPatch`.

- **Ids are GraphQL names, because they become GraphQL field names.** `order-items` becomes
  `listOrderItems` / `getOrderItem`; `2fa codes` becomes `list_2faCodes`, since a GraphQL name may
  not start with a digit and `_` is the one legal prefix. The singular rule is a deliberately small
  piece of English — five suffixes — because the alternative is an inflection library, which is a
  runtime dependency and still wrong about `people`. `DataApiOptions.names` overrides it per table.
- **Collisions are broken deterministically.** A database with both `user` and `users` would want
  `User` twice; the second table keeps its plural (`getUser` and `getUsers`), and if that is taken
  too a counter is appended. Tables are named in sorted order, so the same schema always breaks the
  tie the same way.
- **A write answers with the row it wrote**, because every write statement carries `RETURNING`.
  That makes a write one statement, one `exec.ts` call and one txid — never a write followed by a
  read another transaction could slip between — and it is how a caller learns the rowid SQLite
  assigned, the DEFAULT it applied and the generated column it computed.
- **An insert takes one row or an array of them.** Every row of an array has to name the same
  columns: SQLite's multi-row `VALUES` takes one column list, and a row silently filled with NULL
  where another row named a column would be a different write from the one that was asked for.
- **A single-row read, update or delete that matches nothing answers `404 NOT_FOUND`.** It
  answered `200` with `null` as this milestone shipped; the finding below was taken up in
  `docs/h8-validated-requests.md`, which added `NOT_FOUND: 404` to `ERROR_STATUS`.

## The filter grammar

PostgREST's, because it is the one people already know and it stays cacheable and loggable.

```
GET /v1/db/acme/api/users?id=gt.10&name=like.ann*&order=name.asc&limit=20&select=id,name
```

| | |
|---|---|
| operators | `eq` `ne` `gt` `gte` `lt` `lte` `like` `ilike` `in` `is` |
| `in` | `in.(1,2,3)` or `in.1,2,3`; a member may be `"quoted"` when it contains a comma, `""` for a quote inside it |
| `is` | `is.null`, `is.not_null`, `is.true`, `is.false` |
| `like` | `*` stands for `%`; a literal `%` or `_` is passed through |
| `order` | `name.asc`, `created_at.desc.nullslast`; `asc`/`desc`/`nullsfirst`/`nullslast` |
| `select` | a comma-separated column list; the response carries those columns and no others |
| `limit` | defaults to `defaultLimit` (100); above `maxLimit` (1000) is a `400`, and the document says the maximum |
| `offset` | a non-negative integer |

**Every column is a declared query parameter**, described in the OpenAPI document and therefore an
argument on the generated GraphQL field. That is also why a column may appear at most once in a
query: the parameter is declared as a string, so `?id=gt.1&id=lt.4` is core's `400` rather than a
range query. Declaring it as a union of a string and an array of strings would buy the range and
cost every filter its `String` argument in GraphQL.

**Values are coerced by the column's affinity, not by what they look like.** `?id=eq.10` on an
INTEGER column binds the integer 10, because SQLite would convert the text anyway — and a column
with *no* affinity would not, so the comparison would silently match nothing. A value that cannot
be what its column stores is a `400` (`column "id" holds integers; "abc" is not one`), never a
query that quietly returns no rows. An id past 2^53 binds as a `bigint`.

Two exceptions, both deliberate: a `like`/`ilike` pattern is bound as text whatever the column
stores, since on an INTEGER column `like.1*` has to be the string `1%`; and a column declared
`BLOB` can only be filtered with `is.null` / `is.not_null`, because a URL has no honest spelling
for bytes.

The grammar's own keys — `select`, `order`, `limit`, `offset` — are written last into the query
schema, so **a column that shares one of those names cannot be filtered**. PostgREST has the same
hole.

`like` and `ilike` both emit `LIKE`: SQLite's `LIKE` is already case-insensitive over ASCII, and
making `like` case-sensitive would mean either `GLOB` (different metacharacters) or
`PRAGMA case_sensitive_like`, which is not on `src/server/auth.ts`'s allow-list and should not be.

## The identifier choke point

`buildStatement` in `src/dataapi/sql.ts` is the one function that turns a request into
`{sql, args}`. It is the security boundary of the whole data API, and it is enforced by the shape
of its input rather than by care:

- It takes a `Command` holding **`TableInfo` and `ColumnInfo` records** — the very objects
  `PRAGMA table_list` and `PRAGMA table_xinfo` produced — and `DataValue`s. It takes no column
  name, no table name and no fragment of SQL.
- `src/dataapi/filter.ts` is what turns a request's `?select=`, `?order=` and filter keys into
  `ColumnInfo`s, and it answers `400` for a name the table does not have. **A name that is not in
  the catalog cannot be represented in `buildStatement`'s argument type**, let alone quoted into a
  statement.
- The only text `sql.ts` writes is its own: `SELECT`, `FROM`, a comparison chosen from a fixed
  table, an `IS` literal chosen from a fixed set, `ASC`/`DESC`, and `?`. Names go through `quote`,
  which doubles an embedded `"`. Statements are schema-qualified `"main"."t"`, because readers are
  pooled and a temp table of the same name would otherwise shadow the one that was introspected.
- The table a route addresses is not in the request at all: there is one operation per table, and
  the table name is baked into the operation's path when the registry is built.

The one place a name reaches SQL text outside `quote` is `introspect.ts`, where a `PRAGMA`
argument cannot be a bound parameter — and there the name came from `PRAGMA table_list`, which is
to say from SQLite itself, and it is quoted the same way.

`test/dataapi/security.test.ts` drives this against a database whose schema is hostile on purpose
— a column named `id; drop table users--`, a table named `tab"le` — and asserts, besides the
individual refusals:

- every `"…"`-quoted identifier in **every statement the whole test file produced**, unquoted, is
  either `main` or a name SQLite reported for that database;
- no statement contains a `'` at all, so no value was ever inlined;
- a `select` naming a column the table does not have executes **nothing** — the statement count
  does not move;
- an `in` filter with a thousand values binds a thousand parameters — plus the limit and the
  offset — and emits one `?` for each;
- the hostile table still holds its row afterwards.

## Everything runs through `exec.ts`

`DataApiContext` is `{ db, exec }` and is declared in `src/dataapi/context.ts`, naming only what a
generated operation needs. It is **not** imported from `src/server/`: the dependency direction of
`docs/plan-surfaces.md` is downward, and building a `DataApiContext` per request out of the
server's own `RouteContext` is the server's wiring to write.

What that buys, with no code here: the authorizer and the token's per-table ACLs, deadlines, row
caps, `vmSteps` accounting, quotas, txid and `BQL-Txid`, `ack` levels, `minTxid`
read-your-writes, write forwarding from a replica, and the change feed firing on every write the
data API does. `test/dataapi/operations.test.ts` proves the first of those did not get lost in the
wiring: a token scoped to `{users: "rw"}` reads `/api/users` and gets `403 NOT_AUTHORIZED` on
`/api/orders`, from SQLite's own authorizer, through the generated route.

`DataApiContext.exec` runs statements in `exec.ts`'s default `rows: "array"` mode; `rowObjects`
reads either mode, so an `"object"`-mode context works too.

## What it deliberately does not generate

- **No route and no mounting.** `GET /v1/db/{db}/api/...` and `GET /v1/db/{db}/openapi.json` are
  `src/server/routes.ts`, which H6 owns. This module builds the registry those serve.
- **No embedded resources.** PostgREST's `select=*,orders(*)` is a join planner; `foreign_key_list`
  is introspected and published in `TableInfo` so H5 can use it, and nothing here follows one.
- **No `or=`, `and=`, `not.`, no full-text operators.** The nine operators above, ANDed. An unknown
  operator is a `400` that names the ones it knows.
- **No cursor pagination.** `limit`/`offset` only. `plan-surfaces.md` mentions a cursor; it needs a
  stable sort key and belongs with the change feed, not with this.
- **No upsert, no bulk update, no bulk delete.** A write addresses one row by its key, or inserts.
- **No DDL.** The data API reads a schema; it does not change one.
- **Virtual and shadow tables**, as above.

## Findings

Things this milestone wanted that the repo could not give it. None of them was worked around
silently.

- ~~**There is no "no such row" error code, so a `/{pk}` that matches nothing answers `200` with
  `null`.**~~ **Fixed in `docs/h8-validated-requests.md`:** `NOT_FOUND: 404` is in `ERROR_STATUS`,
  the three `/{pk}` operations declare it, and their `200` schema is the row rather than
  `anyOf: [User, null]`. GraphQL still answers `null`, because a missing row is not an error there
  — `nullOnNotFound` in `src/graphql/errors.ts` unmakes that one status on the dispatch the
  resolvers run through. The original finding: `ERROR_STATUS` had `DB_NOT_FOUND` and `TX_NOT_FOUND`
  and nothing that means *row*; `statusForCode` in `src/openapi/errors.ts` **throws** for a code it
  has never heard of, so inventing `NOT_FOUND` here would have produced either an undocumented
  status or a document that refuses to build — the second error vocabulary `plan-surfaces.md`
  forbids.
- **`PRAGMA table_xinfo` and `PRAGMA index_info` were denied to a token** when this was written.
  `PRAGMA_SUBJECT` in `src/server/auth.ts` now allows them, and `index_xinfo`, because X2's
  `diffSchema` reads them through `client.db()` and failed with `NOT_AUTHORIZED` on any
  non-admin token (`docs/x2-branching.md`). The table-valued form is still checked against a
  table-scoped token's ACL like any other table, so `diffSchema` wants a database-wide token.
  Introspection here still runs with the server's own rights, for the shareable cache.
- **`.nullable()` on a node that carries a codec still refuses `null`.** `walk` in
  `src/core/validate.ts` reads the `CODEC` mark *before* it consults the type list, so
  `s.int64().nullable()` and `s.blob().nullable()` reject a null that their own published `type`
  list admits. A nullable INTEGER column would therefore have failed its own response schema on
  every NULL it read — a dev-mode `500` on a perfectly ordinary row. `schemaForColumn` works around
  it with `s.union([s.int64(), s.null()])`, which puts the null in a branch the codec node never
  has to answer for. **The fix belongs in `decodeInt64`/`decodeBlob`, which should pass a `null`
  through when the node's type list contains `"null"`.**
- **Nothing in bql.sh turns `PRAGMA foreign_keys` on**, so a generated insert can reference a row
  that does not exist. The operations still declare `SQLITE_CONSTRAINT_FOREIGNKEY` among their
  errors, because the document should say what happens on a database where the pragma *is* on;
  `test/dataapi/operations.test.ts` records the current behaviour rather than asserting a
  constraint that never fires.
- **A row component's properties are all optional**, because `?select=id,name` narrows the row and
  a document that declared them required would be lying about its own responses. Nullability *is*
  published faithfully, and `NewUser` keeps real `required`, which is where it matters most for a
  generated GraphQL input type.
- **Affinity is what a column converts to, not what it can hold.** SQLite will store a BLOB in a
  TEXT-affinity column if a caller binds one. Response validation is dev-only and is a *check*,
  never a transform, so such a row would be reported as a server bug in development and served
  unchanged in production. That is the right way round, and it is the price of publishing typed
  columns at all rather than making every column `s.sqliteValue()`.
- **`INTEGER PRIMARY KEY DESC` is not a rowid alias** and the pragmas cannot say so. It is read
  here as an alias, which means it is marked optional on insert; an insert that leaves it out
  writes NULL rather than a rowid. Vanishingly rare, and the only fix is parsing `sqlite_schema`'s
  DDL text, which is worse.
