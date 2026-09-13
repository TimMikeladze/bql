# Surfaces — one operation model, rendered as HTTP, OpenAPI and GraphQL

Written 2026-09-12. Tim asked for "a bun graphql and a bun http and a bun open api… share the same
code as much as possible, same core", then "build openapi first, gql second", then pointed at
[`openapi-x-graphql`](https://github.com/TimMikeladze/openapi-x-graphql). This is the plan of
record for that work. It lands in this repo as new `src/` modules, beside phase 2, not instead of
it.

## The idea in one paragraph

There is exactly **one** description of an operation — its path, its parameters, its request and
response shapes, its auth, its errors — and everything else is a rendering of it. The router
executes it. The OpenAPI document describes it. The GraphQL schema is generated *from the OpenAPI
document*, with resolvers that call the handler in this process rather than issuing an HTTP
request. Three surfaces, one truth, nothing to keep in sync. Hand-writing a REST layer, a GraphQL
schema and an OpenAPI document separately is how they drift apart within a week.

The thing that makes this cheap rather than a rewrite: BunQL already owns the parts that are hard.
`src/server/exec.ts` is the only path that runs a statement, and it is where the policy, the
deadline, the row cap, the txid, the ack level, the forwarding and the quota already live.
`src/server/auth.ts` already has EdDSA tokens with per-table ACLs. `src/realtime/` already has the
change feed. The surfaces are ways in; none of them is a second engine.

## Layering

```
src/core/      schema + operation model + registry     pure; no I/O, no Bun API, no SQLite
src/http/      router and dispatcher over operations   Bun.serve
src/openapi/   OpenAPI 3.1 emitter from a registry     pure
src/dataapi/   a tenant's SQLite schema -> operations  uses exec.ts, auth.ts, realtime
src/graphql/   GraphQL from the OpenAPI document       optional peers; in-process fetch
```

Dependency direction is strictly downward. `src/core/` imports nothing from the rest of BunQL —
it is the piece another project could take whole, which is what "a bun http" means.

Package exports: `@bunql/db/core`, `@bunql/db/http`, `@bunql/db/openapi`, `@bunql/db/graphql`.

## `src/core/` — the schema, and why it is a JSON Schema node

A zero-dependency type builder, because the house rule is zero runtime dependencies and because
the alternative (Zod, TypeBox, ArkType) is a dependency in every consumer's tree:

```ts
import { s, type Infer } from "@bunql/db/core"

const User = s.object({
  id: s.int(),
  name: s.string().describe("display name"),
  email: s.string().format("email").optional(),
  tags: s.array(s.string()).default([]),
}).id("User")

type User = Infer<typeof User>   // { id: number; name: string; email?: string; tags: string[] }
```

**A schema node *is* a JSON Schema object** (draft 2020-12, the dialect OpenAPI 3.1 uses) carrying
a phantom type for inference. `toJsonSchema()` is therefore close to the identity function, and
the validator is an interpreter over the very same tree. That is the whole trick: the validator
and the published document cannot disagree about what the API accepts, because they are reading
one object. Named schemas (`.id("User")`) become `components/schemas` entries and `$ref`s.

The validator does coercion as well as checking, because a path or query parameter arrives as a
string and has to become a number, a boolean, a date, or a `bigint` for BunQL's int64 values. It
returns either a typed value or a list of `{ path, message }` problems, which the HTTP layer turns
into the `400` shape `src/server/errors.ts` already defines. No exceptions on the hot path.

### The operation

```ts
export interface Operation<TIn = unknown, TOut = unknown> {
  id: string                       // operationId, and the GraphQL field name
  method: "get" | "post" | "put" | "patch" | "delete"
  path: string                     // "/v1/db/:db/api/:table/:id" — Bun.serve's own syntax
  summary?: string
  description?: string
  tags?: string[]
  params?: { path?: Schema; query?: Schema; headers?: Schema }
  body?: { schema: Schema; contentType?: string; required?: boolean }
  response: { status?: number; schema: Schema; contentType?: string; headers?: Schema }
  /** Error statuses this operation can produce, by BunQL error code. */
  errors?: ErrorCode[]
  security?: "bearer" | "admin" | "none"
  /** How this renders in GraphQL. `none` keeps it out of the schema entirely. */
  graphql?: { kind: "query" | "mutation" | "subscription" | "none"; field?: string }
  handler: (input: TIn, ctx: OperationContext) => Promise<TOut> | TOut
}
```

A `Registry` is an ordered set of operations with a title, a version and a base path. It is the
only thing `src/http/`, `src/openapi/` and `src/graphql/` ever consume.

## `src/http/` — the router

Compiles a registry into the `routes` table `Bun.serve` already takes, which is what `app.ts` uses
today; path matching stays Bun's, so nothing is added to the hot path. Around each handler:
coerce and validate params, parse and validate the body, call the handler, serialise the response.
`BunQLError` maps to status exactly as it does now — the surfaces reuse `src/server/errors.ts`,
they do not define a second error vocabulary.

Response validation runs only when `NODE_ENV !== "production"`: a published document that lies
about its own responses is a bug worth catching in tests and not worth paying for per request.

## `src/openapi/` — the document

Registry → OpenAPI 3.1 JSON. Named schemas become `components/schemas`; `security` becomes
`bearerAuth` (the EdDSA JWT) and `adminKey`; every `errors` entry becomes a documented response
using the code→status map in `src/server/errors.ts`, so the document tells the truth about `409
SQLITE_CONSTRAINT_UNIQUE` and `503 NOT_PRIMARY` instead of shrugging at `default`.

Served at `GET /v1/openapi.json` for the server's own API, and at
`GET /v1/db/{db}/openapi.json` for one database's generated data API — that second one is the
interesting document, because it is derived from that tenant's tables.

JSON only. Bun can parse YAML but does not serialise it, and pulling in a YAML writer for a
convenience would cost the zero-dependency rule.

## `src/dataapi/` — a database's tables as an API

Introspect a tenant (`PRAGMA table_list`, `table_info`, `foreign_key_list`, `index_list`), map
each table and view to a schema and a set of operations, register them. For a table `users`:

| method & path | purpose |
|---|---|
| `GET /v1/db/{db}/api/users` | list, with filter / order / limit / offset / cursor |
| `GET /v1/db/{db}/api/users/{pk}` | one row by primary key |
| `POST /v1/db/{db}/api/users` | insert one row or an array of them |
| `PATCH /v1/db/{db}/api/users/{pk}` | partial update |
| `DELETE /v1/db/{db}/api/users/{pk}` | delete |

Filtering is PostgREST's URL grammar, because it is the one people already know and it stays
cacheable and loggable: `?id=gt.10&name=like.ann*&order=name.asc&limit=20`. Operators: `eq`, `ne`,
`gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is`. `select=id,name` projects.

**Every identifier in the generated SQL comes from introspection and nothing else.** Column and
table names are looked up in the introspected set and quoted; values are always bound parameters.
A filter naming an unknown column is a `400`, not a query. This is the security boundary of the
whole data API and it is stated here so a reviewer knows where to look.

Views are read-only. A table with no primary key and no rowid gets the collection routes but no
`/{pk}` routes. Generated columns are readable and not writable.

Everything executes through `src/server/exec.ts`, so the data API inherits, without a line of new
code: the authorizer and the token's per-table ACLs, deadlines, row caps, `vmSteps` accounting,
quotas, txid and `BunQL-Txid`, `ack` levels, `minTxid` read-your-writes, write forwarding from a
replica, and the change feed firing on every write it does.

The introspection result is cached per tenant, keyed on `PRAGMA schema_version`, and invalidated
by the `schema` event the realtime layer already emits on DDL.

## `src/graphql/` — generated from the OpenAPI document

`openapi-x-graphql` does exactly this transformation already, it is Tim's, and it takes a custom
`fetch` (`ExecutorOptions.fetch` in its `src/http/execute.ts`). So:

```ts
const { schema } = await createGraphQLSchema(documentForTenant, {
  baseUrl: "/v1/db/acme/api",
  fetch: inProcessFetch,          // dispatches straight into this server's handler
})
```

`inProcessFetch` builds a `Request` and hands it to the registry's dispatcher **in this process** —
no socket, no port, no serialisation to a real HTTP connection — forwarding the caller's
`Authorization` header so the token's table ACLs apply to GraphQL exactly as they do to REST. A
GraphQL query against a tenant costs one dispatch per field, not one TCP connection per field.

### Proven before designing (`experiments/graphql-inproc.ts`)

This repo's habit is to prove the load-bearing mechanism on real bits before building on it (§2).
Two things were checked against `openapi-x-graphql` 1.0.0 and `graphql` 17.0.2 on Bun before this
plan was written:

| check | result |
|---|---|
| a generated resolver dispatches through `ExecutorOptions.fetch` with no socket opened | ok — `GET /v1/db/acme/api/users?limit=1` arrived at a plain function |
| the same for a mutation built from a `requestBody` | ok — `POST …/users`, argument named `input` |
| `$ref` component schemas become GraphQL object and input types | ok — `User`, `NewUserInput` |
| a **schema built once** still serves a **per-request token**, via `AsyncLocalStorage` around `graphql()` | ok — three calls on one cached schema carried three different tokens |

That last row is the one that matters and it is not obvious. The schema is cached per tenant on
`PRAGMA schema_version`, but the caller's token changes every request and is what the table ACLs
are enforced from — so it cannot be baked into the generator's static `headers` option. The token
travels in an `AsyncLocalStorage` store entered before `graphql()` is called and read inside
`inProcessFetch`, and it survives the resolver chain under Bun. **A schema cache keyed on anything
that includes the token would defeat the cache; a `fetch` closure that captures a token would leak
one caller's rights to the next.** Neither happens, because the token is ambient per request and
the closure reads it rather than holding it.

The generator also adds an `_info` field to `Query` describing the source document. Harmless, and
worth knowing about before someone reports it as a bug.

`graphql` and `openapi-x-graphql` are **optional peer dependencies**, the arrangement `kysely` and
`drizzle-orm` already have in `package.json`: BunQL keeps zero runtime dependencies, `@bunql/db/graphql`
throws a message naming the two packages if they are absent, and the GraphQL route is not mounted
unless they resolve.

Mounted at `POST /v1/db/{db}/graphql`, with GraphiQL on `GET` (the package renders it) unless
`[graphql] graphiql = false`. Schemas are cached per tenant on the same `schema_version` key as
the introspection.

Subscriptions are not something the generator can produce from a REST document, so they are added
on top: a `changes` subscription field resolved from the existing ring buffer and live-query
machinery in `src/realtime/`, over the `graphql-ws` protocol on the socket BunQL already runs.
That is the last milestone and the only one that is genuinely new code rather than wiring.

`createOpenApiDocument` — the other direction — earns its keep as a CI gate: `--round-trip` proves
the document and the schema still describe the same API.

## Milestone order

Tim's constraint: OpenAPI before GraphQL. Each is one Opus subagent with its own file set.

| # | milestone | owns | needs |
|---|---|---|---|
| H1 | core: schema builder, validator/coercer, JSON Schema emitter, operation model, registry | `src/core/*`, `test/core/*` | — |
| H2 | http: registry → `Bun.serve` routes, validation, error mapping, mounting | `src/http/*`, `test/http/*` | H1 |
| H3 | openapi: 3.1 emitter, `GET /v1/openapi.json`, security schemes, error responses | `src/openapi/*`, `test/openapi/*` | H1 |
| H4 | dataapi: introspection, resource operations, filter grammar, `GET /v1/db/{db}/openapi.json` | `src/dataapi/*`, `test/dataapi/*` | H2, H3 |
| H5 | graphql: schema from the document, in-process fetch, GraphiQL, optional peers | `src/graphql/*`, `test/graphql/*` | H4 |
| H6 | ~~port the existing `/v1` routes onto the operation model; `scripts/routes.ts --check` reads the registry instead of guessing~~ **Done**, `docs/h6-mount.md` | `src/server/registry.ts`, `src/server/surfaces.ts`, `scripts/routes.ts` | H5 |
| H7 | GraphQL subscriptions over the existing change feed ✅ **Built** (`docs/h7-subscriptions.md`) | `src/graphql/*`, `src/realtime/*` | H5 |

H3 and H4's *emitter* half are independent enough to run beside each other; H4 cannot finish
without H3.

**H6 as built split this plan in two, and H8 finished it.** H6 gave the registry the routing and
the description but not the request pipeline, because `src/server/app.ts`'s `wrap()` has to see the
*error code* a handler refused with to answer C2's same-origin `307`, and `compileOperation` turned
that error into a `Response` first (`docs/h6-mount.md` decision 1). H8 answered that by splitting
`src/http/handler.ts` at the error boundary — `executeOperation` throws, `compileOperation` is that
plus the mapping — so the `/v1` request schemas are now enforced with the `307` intact, and the
body is validated inside `readJson` to keep `routes.ts`'s principal-then-tenant-then-body ordering.
`docs/h8-validated-requests.md`.

H6 is the one that touches existing files, so it is scheduled after phase 2's C1–C3 have had their
turn in `src/server/routes.ts` — two agents editing that file is the one thing phase 1 proved not
to do.

## Config

```toml
[api]
enabled = true             # the generated data API under /v1/db/{db}/api
prefix = "api"
maxLimit = 1000
defaultLimit = 100

[graphql]
enabled = true             # ignored when the optional peers are absent
graphiql = true
path = "graphql"
maxDepth = 12
maxComplexity = 10000
```

## What this is not

Not a query language of its own. Not an ORM. Not a second execution engine — if a surface ever
needs to run a statement in a way `exec.ts` cannot, the fix is in `exec.ts`. And not a
general-purpose GraphQL server: BunQL generates a schema for a database, it does not host yours.
