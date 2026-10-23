# Web track: persistence for a static HTML/JS app

A page with no server of its own adds one script tag and gets a private database per visitor, shared
tables with enforced modes, live queries, and server-side actions. Plan of record; as-built notes go
in `docs/w<n>-*.md` per piece, as with the other tracks.

```html
<script type="module">
  import { connect } from "https://cdn.jsdelivr.net/npm/bql.sh/packages/db/dist/web.js"

  const db = await connect("pk_live_…")
  await db.sql`create table if not exists todos(id integer primary key, title text, done integer default 0)`
  await db.sql`insert into todos(title) values (${"write it"})`   // the visitor's own database
  db.live`select * from todos where done = 0`.on("rows", render)

  const scores = db.shared.table("scores")        // the app's shared database, mode `a`
  scores.orderBy("score", "desc").limit(10).live(renderBoard)
  await db.action("submitScore", { score: 4200 })
</script>
```

| Piece | Built on | Lands in |
|---|---|---|
| Append table scope (`a`) | authorizer, `sqlite3_stmt_explain` | **built**: `server/auth.ts`, `sqlite/statement.ts` |
| Apps and `pk_` keys | catalog, token minting | **built**: catalog, `server/web.ts`, `client.admin`, `bql app` |
| `/v1/session` | `mintToken`, create | **built**: `server/web.ts` |
| Browser bundle | `bql.sh/client` | **built**: `packages/db/src/web/`, `packages/db/dist/web.js` |
| `table()` and `state()` | `sql`, `db.live` | **`table()` built**: `bql.sh/web`; `state()` not yet |
| Author column (`bql_sub()`) | new driver function binding | **built**: `Database.function`, `tenant/subject.ts`, `bql app table`, `db.shared.table()` |
| SQL actions | app config, one transaction | **built**: `server/web.ts` `runAction`, `db.action()` |
| Form endpoint | `a` tables | server routes |
| Action proxy | Ed25519 keys | server routes |

## Decisions

- **SQL is the headline API; `table()` is the shortcut.** Changed after `table()` was built: the
  first reaction to it was "this looks like an ORM", and SQL is what bql.sh is. `db.sql` and
  `db.live` (tagged templates, values bound) lead the README and `llms.txt`. `table()` stays for a
  page that wants no schema: a collection is a real SQLite table, so table modes, CHECK
  constraints, the form endpoint, the dashboard and raw SQL all see the same thing. `state()` is
  sugar over a `state` table, documented last.
- **Actions are SQL first.** Named, parameterized statements in app config, run by the server in one
  transaction. No code runtime, nothing to sandbox. The proxy to the user's own function is the
  escape hatch for secrets and `fetch`. QuickJS-wasm in-process comes only if SQL actions run out;
  hosted sandboxes (Workers for Platforms, Vercel Sandbox) are not planned.
- **An action runs against one database.** Spanning the visitor's and the shared database needs
  `ATTACH`, and a WAL commit is atomic per file, not across both. An action declares its database
  (`shared` by default); data an action must check lives in the database it writes.
- **A database per visitor, not row-level rules.** Private data never shares a table with another
  visitor's, so there is nothing to filter. Rules files and row-level policies are not planned.
- **Two tokens per session.** The table ACL (`t`) is per token, not per database. The visitor's
  database must have no ACL (so `table()` can create tables there), and the shared database must
  have one. `/v1/session` mints one of each, and the bundle routes by database.
- **`pk_` grants only what an anonymous visitor gets.** It is public, and `Origin` is checked but
  forgeable outside a browser. It can call `/v1/session` and nothing else.

## Apps and `pk_` keys

- Catalog table `apps(id, key, config, created_at, swept_at)`. `key` is
  `pk_<24 random bytes, base64url>`, stored as is: it is public, and the admin listing shows it.
- `config` is the app's `bql.json`, validated on write:

```json
{
  "origins": ["https://acme.vercel.app", "http://localhost:*"],
  "tables": {
    "scores": { "mode": "a" },
    "best": { "mode": "r" },
    "signups": { "mode": "a", "form": true, "read": false }
  },
  "actions": {
    "submitScore": {
      "input": { "score": { "type": "int", "min": 0, "max": 1000000 } },
      "run": [
        {
          "sql": "insert into scores(user, score) select :user, :score where exists (select 1 from games where user = :user and finished = 1)",
          "expect": 1,
          "error": "no finished game"
        }
      ]
    }
  },
  "session": { "ttlMs": 3600000 }
}
```

- `"read": false` keeps the table out of the visitor's token entirely; only the form endpoint and
  actions write it, and the owner reads it with the admin key.
- Admin routes: `POST /v1/apps`, `GET/PUT/DELETE /v1/apps/:id`, `POST /v1/apps/:id/rotate`.
  CLI: `bql app create|list|push <bql.json>|rotate`. The shared database (`app-<id>-shared`) is
  created with the app. The owner creates its tables with the admin key; config never runs DDL.

## `/v1/session`

`POST /v1/session { key, visitor }` returns
`{ private: { db, token }, shared: { db, token }, exp }`.

- `visitor` is 128 random bits the bundle keeps in `localStorage`. It works as a bearer secret for
  that visitor's data: anyone holding it gets that database. The database name is
  `app-<id>-u-<first 16 hex of sha256(visitor)>`, so the raw value is never stored.
- The private token is `rw` on that database with no table ACL. The shared token is `rw` on the
  shared database with `t` built from `config.tables` (tables with `"read": false` left out) and
  `sub` set to the visitor's database suffix.
- The visitor's database is created on the first session. A database still at txid 0 after 24 hours
  is deleted by a sweep, so drive-by sessions cost a directory for a day.
- `Origin` must match `config.origins` (`*` wildcard in host or port). A missing `Origin` is refused.
- Rate limit: new visitors per IP per minute, a token bucket in memory, refused with `429` and
  `Retry-After`. The server has no per-IP limiter today; this one is new.
- Later, not in this track: `{ key, jwt }` for Clerk/Supabase/Better-Auth, which needs RS256/ES256
  and JWKS fetching, since `auth.ts` verifies only its own Ed25519 keys.

## Browser bundle

- Source in `packages/db/src/web/`, built with `Bun.build({ target: "browser", format: "esm",
  minify: true })` into `packages/db/dist/web.js`, which goes into `files` the way
  `packages/bus/dist/dashboard` does. Export `bql.sh/web`.
- `connect(key, { url?, storage? })` calls `/v1/session`, refreshes both tokens before `exp`, and
  returns `{ table, state, sql, shared: { table, sql }, action, visitor }`.
- `pack:check` grows a case: the tarball contains `dist/web.js`, and the built file from the
  install connects to a server from the same install and sees a live list change.
  `build:web` refuses a bundle that imports `node:` or `bun:`.
- As built: a refresh builds new clients and moves the live queries onto them, because a client's
  token is fixed when it is built. `url` defaults to the page's origin. 33 KiB, 11 KiB gzipped.

## `table()` and `state()`

`table(name)` in the private database creates, on first use:

```sql
create table if not exists todos(
  id text primary key,
  data text not null check (json_valid(data)),
  created_at integer not null default (unixepoch('subsec') * 1000),
  updated_at integer not null default (unixepoch('subsec') * 1000)
) strict;
```

- `insert(doc)` (id is a client-side UUIDv7 unless the doc has one), `get(id)`, `update(id, patch)`
  (`json_patch`), `delete(id)`, `where({ field: value })` (`json_extract` equality), `orderBy`,
  `limit`, `list()`, `live(cb)` over `db.live` keyed on `id`. Rows come back as `{ id, ...data }`.
- In the shared database the table must already exist with this shape plus the author column; the
  bundle never runs DDL there, and the token could not.
- `state(defaults)` stores one row per top-level key in a `state` table. Proxy traps become atomic
  JSON operations on the server: assignment is `json_set`, `push` is `json_insert(…, '$[#]', ?)`,
  `delete` is `json_remove`. Writes are batched per microtask. `$ready`, `$saved` and
  `$on("change")` are on the root. Removing by array index is racy across devices; the docs say to
  remove by `id`.

## Author column

A visitor can insert into an `a` table, but nothing stops them from writing someone else's name in
the author column. The fix is a connection function the policy sets per request. As built the
column is `author`, not `user`, and the table carries triggers too (`sharedTableSql`):

```sql
create table scores(
  id text primary key,
  user text not null default (bql_sub()) check (user = bql_sub()),
  data text not null check (json_valid(data)),
  created_at integer not null default (unixepoch('subsec') * 1000)
) strict;
```

- `bql_sub()` returns the token's `sub`, and NULL for the admin. The CHECK has to allow the admin's
  NULL (`check (bql_sub() is null or user = bql_sub())`).
- The driver had no `sqlite3_create_function` binding; `Database.function` adds a zero-argument
  one. `bql_sub()` is registered deterministic (true within a statement, and required for a CHECK)
  and innocuous (so the schema may call it with `trusted_schema` off). `applyPolicy` sets it
  before its cached-policy shortcut, since two visitors with the same ACL share a policy key.
- Where the plan was wrong: a CHECK alone guards inserts only. BEFORE UPDATE/DELETE triggers make
  rows author-only, and REPLACE skips DELETE triggers, so with a table ACL the policy now refuses
  REPLACE on any table with a DELETE trigger (the driver tags the synthetic DELETE it asks about
  as `"replace"`). An upsert's update half shows up as a `Delete` opcode too; it carries
  `OPFLAG_ISUPDATE` and is skipped, so upserts still work. Building this found that the REPLACE
  scan turned `EXPLAIN INSERT …` into a real insert; it now leaves an EXPLAIN alone.

## SQL actions

`POST /v1/session/action { key, name, input }`. As built it takes the session's **private** token,
not the shared one: the private token is `rw` on exactly `app-<id>-u-<sub>`, which proves both the
app and the visitor, and an app with no shared tables has no shared token at all. `bql_sub()` is
set to the caller inside the action, so author columns hold there too.

- `input` is checked against the action's schema (`int`, `number`, `text` with `min`/`max`/`maxLength`,
  `bool`); unknown keys are refused. `:user` is bound from the token's `sub`, never from input.
- The statements run in one transaction on the action's database as the admin principal, so the
  action can write tables the visitor cannot. `expect: n` turns a different `changes()` into a `409`
  with the action's `error`, and rolls back.
- No DDL, `ATTACH` or `PRAGMA` in action SQL; checked when the config is written.

## Form endpoint

`POST /f/:app/:table`, `application/x-www-form-urlencoded` or multipart without files.

- The table must be `"form": true` and mode `a`. Form fields map to keys of `data`; `_next` and
  the honeypot field `_gotcha` are reserved.
- Responds `303` to `_next` or the `Referer`, with `?bql=ok` or `?bql=error&reason=<column>` parsed
  from the CHECK failure. `Accept: application/json` gets JSON instead.
- The same per-IP limiter as `/v1/session`.

## Action proxy

An action with `"url"` instead of `"run"` is POSTed to the user's function with a signed body
(EdDSA over the request, key id in the header, public keys at `/.well-known/jwks.json`) and a
short-lived token scoped to the shared database. The function needs no stored bql secret.

## Build order

1. Apps, `pk_` keys and `/v1/session`, including the per-IP limiter and the txid-0 sweep.
2. The browser bundle with `table()` over the private database, plus its `pack:check` case.
3. The author column, then `db.shared.table()`.
4. SQL actions.
5. The form endpoint.
6. `state()`, `llms.txt` and the MCP tools.
7. The action proxy.

## Not planned

Local-first WASM sync, hosted sandboxes, rules files, row-level policies, a localStorage drop-in
shim, declarative HTML attributes, static hosting.

## Verification

Each piece: unit tests on the policy or parser, one end-to-end test through a real server, docs in
the package README and `docs/api.md`. The bundle is checked in a browser with the browser agent.
Gates: `bun run db test` (also with `BUNQL_WAL_NATIVE=0`), `bun run bus test`, `bun run typecheck`,
`bun run bytes`, `bun run db routes:check`, `bun run pack:check`.
