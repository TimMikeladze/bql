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
| `table()` and `state()` | `sql`, `db.live` | **built**: `bql.sh/web` (`web/table.ts`, `web/state.ts`) |
| Author column (`bql_sub()`) | new driver function binding | **built**: `Database.function`, `tenant/subject.ts`, `bql app table`, `db.shared.table()` |
| SQL actions | app config, one transaction | **built**: `server/web.ts` `runAction`, `db.action()` |
| Form endpoint | `a` tables | **built**: `server/web.ts` `submitForm`, `bql app table --form` |
| Action proxy | Ed25519 keys | **built**: `server/web.ts` `proxyAction`, `/.well-known/jwks.json`, `bql.sh/actions` |
| Accounts (bring-your-own JWT) | WebCrypto, `/v1/session` | **built**: `server/jwt.ts`, `server/web.ts`, `connect(key, { jwt })`, `db.anonymous.adopt()` |

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
- `{ key, jwt }` for a signed-in user: see Accounts below.

## Accounts (bring-your-own JWT)

A visitor id lives in one browser's `localStorage`, so clearing it or switching device means a new,
empty database. An app that already signs people in (Clerk, Supabase, Better-Auth, Auth0) can hand
`/v1/session` the provider's JWT instead, and the same account gets the same database everywhere.

```json
"auth": {
  "issuer": "https://clerk.acme.app",
  "jwks": "https://clerk.acme.app/.well-known/jwks.json",
  "audience": "acme",
  "userClaim": "sub",
  "required": false
}
```

- `issuer` and `jwks` are required, `https://` (or `http://localhost`/`127.0.0.1` in development,
  as for a url action). `audience` is optional because Clerk's session tokens carry none; when set,
  `aud` must equal it or, as an array, contain it. `userClaim` defaults to `sub`. One provider per app.
- `POST /v1/session { key, jwt, visitor? }`. The verifier (`server/jwt.ts`, WebCrypto only, no
  dependency) takes RS256/384/512, ES256/384 and EdDSA (Better-Auth's JWT plugin signs EdDSA by
  default); `none` and HS* are refused, since an HMAC secret would have to be shared with us.
  `exp` is required; `exp`, `nbf` and `iat` get 30 s of skew; `iss` must equal `issuer`.
- JWKS: fetched on first use per URL and kept 10 minutes, per node. A `kid` the cached set lacks
  refetches once, at most once per 30 s per URL, so tokens with made-up `kid`s cannot make the
  server hammer the provider. A token without `kid` is tried against every key of the right type.
  Fetch: 5 s timeout, 256 KiB cap. Unreachable keys are `503 IDP_UNAVAILABLE`; a bad token is
  `401 UNAUTHENTICATED` naming the check that failed.
- Database: `app-<id>-u-<first 16 hex of sha256("bql-account" NUL app NUL iss NUL user)>`, and
  `sub` is that same hex. A hash, not the provider's id, because `sub` is shown to other visitors
  as `author`; the app id is in it so one person's `author` differs between apps. Visitor ids
  cannot contain NUL, so a visitor hash and an account hash never collide by construction.
  Everything downstream (`bql_sub()`, `:user`, `call.user`, `db.author`) keys off `sub` and is
  unchanged. The provider's id is not stored anywhere.
- The session lasts `session.ttlMs`, not the JWT's own `exp` (Clerk's live 60 s). Signing out at
  the provider stops new sessions; an open one runs to its end. An app that cares lowers `ttlMs`.
- `auth.required: true` refuses `{ key, visitor }` with `401 UNAUTHENTICATED`. Default false: a
  page can be used signed out and keep working after sign-in.
- The new-database limit (`session.newVisitorsPerMinute`, per app and IP) applies to accounts too.
  Supabase anonymous sign-in and unverified email signup make accounts free, so a JWT is not proof
  of cost. A returning account, like a returning visitor, is never limited.
- `{ key, jwt }` to an app with no `auth` is `400`.

Linking: a visitor used the page signed out, then signs in. The anonymous database is left alone
by the server; the page decides. When the session request carries the stored `visitor` too and
that database exists with a write in it, the answer adds `anonymous: { db, token }`, a token on it
(`sub` = the visitor hash, so it is that visitor's own). The bundle exposes it as `db.anonymous`
with `sql` and `adopt()`: copy each table into the account's database (`create table if not
exists` from the stored DDL, then `insert or ignore` over the columns both sides have, so the
account's rows win on a key clash and a second `adopt()` is harmless), drop the copied tables from
the anonymous database, and forget the visitor id so the next signed-out visit starts empty. A
page that never calls `adopt()` gets "left as it was", and signing out shows the old data again.
Not done server side: copying arbitrary schemas is a page decision (which rows win, whether to
merge at all), and doing it in the bundle needs no new route or admin rights.

Bundle: `connect(key, { jwt })`, where `jwt` is a string or a function returning one (sync or
async). A function is called for every session request, the first, the timed renewal and the
renewal after a `401`, so it should return the provider's current token (`clerk.session.getToken()`,
`supabase.auth.getSession()`). Identity is fixed for a connection: on sign-in or sign-out the
page calls `close()` and `connect()` again. `db.visitor` is null for an account session;
`db.signedIn` is true.

As built, where the plan was wrong or silent:

- "Offered when the anonymous database has a write in it" was wrong: `adopt()` drops the tables
  but the txid stays above 0, so the same database was offered again on the next sign-in. The
  server now offers it when it has at least one table.
- The forced JWKS read for an unknown `kid` is also skipped when the cached set was read less than
  the cooldown ago, so the first token with a new `kid` does not read the set twice in a row.
- A failed refetch falls back to the cached set: a provider outage does not lock out users whose
  keys this node already holds.
- `adopt()` skips virtual tables and their shadow tables (`pragma_table_list` types them), and
  copies only the columns both sides have. A connection still holding a live query on a table
  `adopt()` drops gets `no such table`; the page is expected to have closed its signed-out
  connection before signing in.
- Not built: passing the provider's user id to a url action's function. The function sees
  `call.user`, the hash; a page that needs the provider id there sends the JWT as an input.
- Browser check: one page served on `localhost:<port>` and `127.0.0.1:<port>` (two origins, so two
  `localStorage`s and two visitor ids), each signed out first, then signed in as one user from a
  stand-in IdP. Both landed in one database, each `adopt()` moved its own signed-out row in, a row
  inserted in one tab reached the other's live list, and both origins' `localStorage` ended empty.

Tests: the verifier with keys generated in the test and a local JWKS server (good RS256, ES256 and
EdDSA, bad signature, wrong issuer, wrong audience, expired, not yet valid, `alg: none`, unknown
`kid` then rotated, the refetch cooldown); the server (two "devices" with different visitor ids
and one account land in one database, author and actions see the account `sub`, `required`
refuses visitors, the limiter, `anonymous` offered only with the visitor id); the bundle (`jwt`
getter on refresh and 401, `adopt()` moving rows).

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
- As built, `db.state(defaults)` (a method, not a standalone `state(key, defaults)`) uses a table
  named `bql_state`, not `state`, so it cannot collide with a page's own table. A key with no row
  yet is created from its default before any nested write or push; creating it from the local
  value double-counted the batch's pushes. A key with a write in flight ignores live echoes and is
  re-read once the write lands, so another tab's concurrent change is not lost.
- Planned: `state(defaults)` stores one row per top-level key in a `state` table. Proxy traps become atomic
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

As built: `POST /v1/forms/:app/:table`, not `/f/…`, so it stays in the route registry, the OpenAPI
document and `routes:check`. The redirect target must be on an allowed origin (no open redirect),
a form table defaults to `read: false`, the per-IP limit is `form.perMinute` per table, and
`fields` reuses the action input schema plus an `email` type. Form tables are the plain `table()`
shape: a post has no visitor, so there is no author column.

The original plan: `POST /f/:app/:table`, `application/x-www-form-urlencoded` or multipart without files.

- The table must be `"form": true` and mode `a`. Form fields map to keys of `data`; `_next` and
  the honeypot field `_gotcha` are reserved.
- Responds `303` to `_next` or the `Referer`, with `?bql=ok` or `?bql=error&reason=<column>` parsed
  from the CHECK failure. `Accept: application/json` gets JSON instead.
- The same per-IP limiter as `/v1/session`.

## Action proxy

As built: the signature is over `bql-action:` + the body (domain-separated from JWT signing
inputs, since it reuses the token signing key), the body carries the URL it was signed for and a
60 s `exp`, and the token is `rw` on both the shared and the caller's private database with
`sub` = the caller, so author columns hold for the function's writes too. Building it found that
the catalog stores the parsed config and parsing it again refused a url action's own `run: []`;
`parseAppConfig` is now tested to take its own output unchanged.

The plan:

An action with `"url"` instead of `"run"` is POSTed to the user's function with a signed body
(EdDSA over the request, key id in the header, public keys at `/.well-known/jwks.json`) and a
short-lived token scoped to the shared database. The function needs no stored bql secret.

## Build order

1. Apps, `pk_` keys and `/v1/session`, including the per-IP limiter and the txid-0 sweep.
2. The browser bundle with `table()` over the private database, plus its `pack:check` case.
3. The author column, then `db.shared.table()`.
4. SQL actions.
5. The form endpoint.
6. `state()`, `llms.txt` and the MCP tools. Built: `llms.txt` and `AGENTS.md` gain a section
   generated from the README's static-page blocks; `bql mcp` is a stdio MCP server with
   `list_apps`, `create_app`, `create_shared_table`, `update_app_config`, `run_sql` and `get_snippet`.
7. The action proxy.

## Not planned

Local-first WASM sync, hosted sandboxes, rules files, row-level policies, a localStorage drop-in
shim, declarative HTML attributes, static hosting.

## Verification

Each piece: unit tests on the policy or parser, one end-to-end test through a real server, docs in
the package README and `docs/api.md`. The bundle is checked in a browser with the browser agent.
Gates: `bun run db test` (also with `BUNQL_WAL_NATIVE=0`), `bun run bus test`, `bun run typecheck`,
`bun run bytes`, `bun run db routes:check`, `bun run pack:check`.
