# H6 — mount the surfaces, and let the server describe itself

Written 2026-09-12, as built. Plan of record: `docs/plan-surfaces.md` milestone H6. This was the
"Start here C" of `docs/next.md`: `src/core/`, `src/http/`, `src/openapi/`, `src/dataapi/` and
`src/graphql/` were built, tested and exported, and **no route served any of them**. Nothing here
is a new engine; all of it is wiring the server was always meant to own — `src/dataapi/context.ts` says so in its
header ("`src/server/routes.ts` builds a `DataApiContext` per request out of its own
`RouteContext`, and that wiring is the server's to write"), and this is that.

## What lands

| route | serves |
|---|---|
| `GET \| POST \| PATCH \| DELETE /v1/db/:db/api/*` | the generated data API for that database |
| `GET /v1/db/:db/openapi.json` | that database's OpenAPI 3.1 document |
| `POST /v1/db/:db/graphql`, `GET` for GraphiQL | that database's GraphQL schema |
| `GET /v1/openapi.json` | the **server's own** API, from the same operation model |

Plus `[api]` and `[graphql]` config sections, and `src/server/registry.ts` — one `Registry` that
builds the `Bun.serve` route table *and* the document, so the two cannot drift.

## Decision 1 — the server registry builds the route table, but not the request pipeline

`docs/plan-surfaces.md` H6 says "port the hand-written routes onto `Operation`/`Registry`". There
are two halves to that and they carry very different risk:

* **Routing and description.** One list of operations is the only place a `/v1` route exists, and
  the OpenAPI document is emitted from that same list. This removes the drift H6 exists to remove.
* **Request validation.** Replacing each handler's own body parsing with core's coercing validator.

This milestone does the first and **not** the second. `src/server/registry.ts` declares every
`/v1` operation — path, params, body, response, errors, security — and its `handler` is the
existing `Handler` from `src/server/routes.ts`, called with the `RouteContext` it already takes.
The handlers keep their bodies.

The reason is not timidity, it is a real obstruction. `src/server/app.ts`'s `wrap()` is the only
place the four `BunQL-*` headers, CORS, the metrics tick and C2's same-origin `307` are applied,
and the `307` needs to know **which error code** a handler refused with. `compileOperation` in
`src/http/handler.ts` catches the error and returns a `Response`, by design — so a registry mounted
through `mountRegistry` would hide `refused === "NOT_PRIMARY"` from `wrap`, and a promoted-away
database would stop redirecting. So `app.ts` mounts the registry with **its own** wrapper, which is
`wrap()` unchanged, and the operations supply the routing table and the document.

Consequence, stated so nobody discovers it by surprise: `/v1/openapi.json` publishes request
schemas that the server does not enforce through core's validator. Every one of them is written
from the handler it describes and pinned by `test/server/registry.test.ts`, and the handlers do
their own checking exactly as they did before this milestone — `assertStatement`, `readJson`,
`requireScope`, `resolveOptions`. The generated data API *is* validated by core, because it goes
through the real `src/http/` pipeline. Migrating the hand-written handlers onto that pipeline is
left as follow-up work and named in `docs/next.md`.

## Decision 2 — the data API is one wildcard route and a per-tenant dispatcher

A generated registry's paths carry **concrete table names** (`/v1/db/:db/api/users`), and they
differ per database. They therefore cannot be static entries in a process-wide `Bun.serve` table:
`/v1/db/:db/api/users` mounted from database `acme` would answer for database `beta`, which has no
such table.

So the table gets exactly one entry, `/v1/db/:db/api/*`, and inside it:

1. authenticate, `requireScope(principal, db, "ro")`, open the tenant — the same three steps every
   other route takes first, in the same order, for the same reason (`routes.ts`'s first invariant);
2. `DataApiCache.for(db, adminExec)` — introspection runs with the **server's** rights and its
   result is shared, which is that cache's stated invariant;
3. `createDispatcher(entry.registry, …)` over a per-request `DataApiContext` whose `exec` is closed
   over `src/server/exec.ts` as **the caller's** principal;
4. dispatch, and hand the `Response` back to `wrap()`.

The dispatcher is cached alongside the registry, keyed on the same `PRAGMA schema_version` the
introspection is: building it compiles every operation, and doing that per request would pay H4's
whole compile on the hot path. The *context* is per request; only the compiled pipeline is shared.
That is the same split `src/graphql/ambient.ts` argues for and for the same reason — a closure
holding a principal would hand caller A's rights to caller B.

## Decision 3 — the exec closure is `handlers.query`, minus the JSON

The data API inherits the ACLs, deadlines, row caps, quotas, txids, ack levels and write forwarding
only if its `exec` takes the same path a `POST /v1/db/{db}/query` takes. So it does, in order:

* `resolveOptions(undefined, request.headers, config)` — `BunQL-Ack` and `BunQL-Min-Txid` apply to
  a data-API call exactly as they apply to a query;
* `awaitTxid(tenant, options)` once per request, not once per statement;
* `forwarder.needsPrimary(...)` → `forwarder.query(...)` on a replica, so a `POST /…/api/users`
  against a replica is forwarded rather than refused;
* `executeStatementQueued(...)` otherwise, so a data-API write folds into group commit like any
  other;
* `awaitDurable(...)` on a write;
* `mapTenantError(err, primaryUrlFor(db))` on the way out, so `NOT_PRIMARY` still carries the
  primary and still gets C2's `307` from `wrap`.

`ctx.txid` is set from the result, so `BunQL-Txid` is on a data-API response as it is on a query's.

`rows: "array"` is kept (exec's default), and `rowObjects` in `src/dataapi/context.ts` reads it —
that is what that function is for.

## Decision 4 — GraphQL mounts only if its peers resolve

`graphql` and `openapi-x-graphql` are optional peers. `graphqlAvailable()` is checked **once at
startup**; when it is false the route is simply absent, and `GET /v1/db/x/graphql` is the ordinary
404 rather than a 500 explaining a missing package. `[graphql] enabled = false` does the same.
`src/graphql/peers.ts` already throws `MissingPeersError` with the install command for anyone who
calls it directly.

## Decision 5 — who may read a document

* `GET /v1/openapi.json` — **open**, no authentication. It describes this server's static API and
  is byte-identical on every BunQL node; it names no database and carries no tenant data. It sits
  with `/healthz` and `/readyz`.
* `GET /v1/db/:db/openapi.json` — needs `ro` on that database. It is derived from that tenant's
  tables, so it is schema disclosure.
* `POST /v1/db/:db/graphql` — needs `ro` to reach the schema; every field it resolves goes through
  `exec.ts`, so the token's per-table ACLs still decide what answers.

## Decision 6 — the data API grants no new authority

A principal that can reach `/v1/db/{db}/api/users` can already run `SELECT * FROM users` through
`POST /v1/db/{db}/query`, and both end in the same `exec.ts` with the same authorizer. So `[api]
enabled` defaults to **true**, as `docs/plan-surfaces.md` writes it. The data API is a convenience
over an authority the caller already had, never a widening of it.

## Config

```toml
[api]
enabled = true          # the generated data API under /v1/db/{db}/api
prefix = "api"          # the segment after /v1/db/{db}
maxLimit = 1000
defaultLimit = 100

[graphql]
enabled = true          # ignored when the optional peers are absent
graphiql = true
path = "graphql"
maxDepth = 12
maxComplexity = 10000
```

## Invalidation

`DataApiCache` and `SchemaCache` invalidate themselves on `PRAGMA schema_version`, which SQLite
increments on every DDL statement — one prepared pragma per request against re-introspecting five
pragmas per table. That is the correctness story and nothing else has to remember anything.

The one case the version counter cannot cover is a **deleted** database: a new database created
under the same name starts at version 1 again, and a cached entry for the old one would be served
for it. `runtime.evict(name)` is where a database leaves this node, so the surfaces drop their
entries there.

## Files

| file | what |
|---|---|
| `src/server/registry.ts` | new — every `/v1` operation, and the `Registry<RouteContext>` that holds them |
| `src/server/surfaces.ts` | new — the data API cache, the per-tenant dispatcher, the GraphQL handler, and the three tenant handlers |
| `src/server/config.ts` | `[api]` and `[graphql]` sections, each validated as one path segment |
| `src/server/errors.ts` | `CLUSTER_DISABLED: 503`, which was thrown but undocumented |
| `src/server/runtime.ts` | `onEvict`, so the surfaces drop a deleted database without the runtime importing them |
| `src/server/app.ts` | the route table is built from the registry; `createApp` is async |
| `scripts/routes.ts` | `--check` now also fails on a served route the registry does not declare |
| `docs/api.md`, `README.md` | the new routes, the two config sections, and the prose for all three surfaces |
| `test/server/registry.test.ts` | the registry and the table describe each other; the response schemas match real answers |
| `test/server/surfaces.test.ts` | the four routes end to end, the ACLs, DDL, delete-and-reuse, and a node with the surfaces off |
| `test/replication/dataapi.test.ts` | a replica reads locally and forwards a generated write |
| `test/package/exports.test.ts` | the version the documents publish is `package.json`'s |

`src/server/hrana/` stays outside the registry. Hrana is libsql's wire protocol, not BunQL's API —
`/v2/pipeline` is one endpoint carrying an RPC envelope, and describing it as OpenAPI would publish
a document nobody could generate a useful client from. `app.ts` keeps `Object.assign(routes,
hranaRoutes(runtime))` after the registry is mounted.

## Two things that changed while building it

- **`createApp` is now `async`.** Whether GraphQL is mounted depends on two optional peers
  resolving, which is an `import()`. It is resolved once at startup, never per request. Three call
  sites: `startServer`, `scripts/routes.ts`, `test/hrana/harness.ts`.
- **`CLUSTER_DISABLED` joined `ERROR_STATUS`.** `src/server/routes.ts` has thrown it since C1 with
  an explicit 503, but the code was absent from the documented vocabulary — so `statusForCode`
  returned `undefined` for it and the document build rejected the operation that declares it. That
  is `src/openapi/errors.ts` doing exactly what it says it does.

## What this is not

Not a rewrite of the `/v1` handlers (decision 1). Not GraphQL subscriptions — that is H7, over the
change feed, and a REST document cannot describe one. Not a second error vocabulary:
`src/server/errors.ts` stays the only one, and every `errors:` entry in the registry is a code from
it.
