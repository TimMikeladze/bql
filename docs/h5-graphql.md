# H5 — `src/graphql/`, a database's tables as a GraphQL schema

Milestone H5 of `docs/plan-surfaces.md`. A tenant's OpenAPI document in, an executable GraphQL
schema out, with resolvers that dispatch **in this process**.

```ts
import { graphqlHandler } from "bunql/graphql"

const handler = graphqlHandler({
  // The server's own rights. Introspection only, and its result is shared by every caller.
  introspect: (db) => execFor(ADMIN, db),
  // The caller's rights, built from *this* request — the token is authenticated here.
  context: (request, db) => ({ db, exec: execFor(principalOf(request), db) }),
  cache: dataApiCache,          // the one the REST surface already uses
  maxDepth: 12,
  maxComplexity: 10000,
})
```

Almost all of this is three existing pieces wired together — `dataApiRegistry` → `buildDocument` →
`createGraphQLSchema` — so this file is mostly about the three parts that are not wiring.

## Where the schema comes from

`src/dataapi/` introspects the tenant once and produces a core `Registry`. `src/openapi/` renders
that registry as an OpenAPI 3.1 document. `openapi-x-graphql` reads **that document** and generates
the schema. There is no second description of the same tables anywhere, so a GraphQL field is a
REST operation by construction rather than by review, and `operationId` — which H3 and H4 both call
load-bearing — is literally the field name.

The resolvers do not open a socket. They are handed `createDispatcher(registry, …)` from
`src/http/` as `ExecutorOptions.fetch`, which is the same compiled pipeline `Bun.serve` runs for
the REST route (`src/http/dispatch.ts` states that invariant). A GraphQL query costs one in-process
call per field, and a field cannot answer differently from the REST call it stands for.

Two edits are made to the document on the way, both in `src/graphql/document.ts`:

- `basePath: "/v1/db/{db}/api"` strips the tenant prefix from every path key, paired with a
  `servers` entry and a `baseUrl` that carry it. This is exactly what `DocumentOptions.basePath`
  exists for (`docs/h3-openapi.md`).
- That leaves each operation declaring a `{db}` **path** parameter its own path no longer has, and
  the generator would turn it into a required `db: String!` argument on **every** field. A path
  parameter the emitted path key does not mention is therefore dropped. Nothing else is touched.

The internal base URL is `http://bunql.internal/v1/db/<db>/api`. It never reaches a socket — the
dispatcher resolves it and calls a function — but `buildRequest` does `new URL(baseUrl + path)`, so
it has to be absolute.

## The cache, and its key

`SchemaCache` keys a tenant's schema on `PRAGMA schema_version` — **`src/dataapi/`'s key, not a
second one**. `DataApiCache.for(db, exec)` already reads that pragma and re-introspects when it
moved; this cache asks it for the entry and reuses the version it reports. So a `CREATE TABLE`, an
`ALTER TABLE` or a `DROP` rebuilds the GraphQL schema by itself, and nothing in BunQL holds a
second opinion about when a tenant's schema changed. Pass the server's own `DataApiCache` through
`options.cache` and one introspection serves REST, OpenAPI and GraphQL between them.

It is bounded: `maxSchemas` (64) tenants, least recently used dropped, `invalidate(db)` for a
database that was deleted or closed, `clear()` for all of them. A generated schema holds its
tenant's registry and dispatcher alive, so an unbounded map would be a leak the size of the
catalog. Two concurrent cold requests generate one schema between them, not one each.

## The per-request token — the part that is easy to get wrong

The schema, its resolvers and the dispatcher behind them are built **once per tenant**. The
caller's token is **per request**, and it is what the per-table ACLs in `src/server/exec.ts` are
enforced from. Three ways of joining those that do not work:

| | why not |
|---|---|
| bake the token into `ExecutorOptions.headers` | the header map is part of the schema, so every later caller would send the first caller's token |
| put the token in the cache key | correct, and it defeats the cache — a schema per token is an introspection per token |
| let the `fetch` closure capture a token | the closure lives as long as the schema, so caller B's fields resolve with caller A's rights |

The third is the dangerous one: a silent privilege escalation with no error anywhere. So the
caller's context travels in an `AsyncLocalStorage` store entered around `execute()`
(`src/graphql/ambient.ts`) and is **read** inside the dispatcher's context factory, once per
dispatch. `experiments/graphql-inproc.ts` proved the store survives the resolver chain under Bun
before any of this was designed.

It fails closed. A dispatch with no store in flight is a programming error, not an anonymous
request, and `currentCall()` throws rather than returning anything a resolver could run with —
so the cached dispatcher has **no rights of its own**. A dispatch whose store names a different
database than the schema it belongs to is refused for the same reason.

`test/graphql/ambient.test.ts` is the adversarial test: two requests, two tokens with disjoint
table ACLs, held open on a barrier so neither can finish until the other has begun. Each sees only
its own rights, on one shared schema. Checked against the mutation it exists to catch — capturing
the first call's context in `contextFor` fails it — and the second test in that file dispatches
through the cached `fetch` with no request in flight and asserts a `500 INTERNAL` rather than rows.

## The limits

A GraphQL endpoint with no depth limit is a denial-of-service surface: a recursive query costs the
server arbitrarily much and the caller a few hundred bytes of text. Both limits are measured
**before** the operation runs, so a refused query dispatches nothing at all — no statement, no row.

| option | default | what it counts |
|---|---|---|
| `maxDepth` | 12 (`[graphql] maxDepth`) | a root field is depth 1, a field selected on it is depth 2 |
| `maxComplexity` | 10000 (`[graphql] maxComplexity`) | every field costs one per row of its parent; a list field multiplies the rows its children are counted at |

A list field's row count is its own `limit` argument when the query names one — a literal or a
variable — the argument's default when it has one, and `defaultRows` (100, `[api] defaultLimit`)
otherwise. So `{ listUsers { id name } }` is 201 and `{ listUsers(limit: 1000) { id name } }` is
2001.

**What complexity is, so nobody reads more into it: a bound on the rows an operation can ask for,
read off the query and the schema.** It is not a cost model of SQLite. It does not know what a
statement will scan, and `listUsers(limit: 1)` over a million unindexed rows is cheap by this
measure and expensive in fact — which is what `exec.ts`'s deadline, row cap and `vmSteps`
accounting are for, and they still apply to every dispatch this admits. This measure refuses the
*shape* of a query that would fan out, before any of those is reached.

Both run after `validate` with the specified rules, and deliberately **not** as a validation rule:
a `limit: $rows` variable is only known once the request's variables are in hand, and a rule cannot
see them. `NoFragmentCyclesRule` has already run by then, which is what makes the fragment walk
safe.

## Errors

One vocabulary, all the way out. A generated resolver that gets a non-2xx back throws a
`GraphQLError` of its own — `"GET /users failed with 403 Forbidden"`, extensions
`{code: "OPENAPI_REQUEST_FAILED", status, body}` — with the real refusal parsed under `body.error`.
Left alone that reads to a client as one opaque failure whatever went wrong, so `liftBunQLError`
unwraps it: the BunQL message becomes the error's message, and `code`, `status` and everything else
`mapError` attached (`txid`, `primary`, `problems`, `failedIndex`, `acks`, `needed`) become
extensions.

```json
{"data":{"listOrders":null},
 "errors":[{"message":"access to orders.id is prohibited",
            "path":["listOrders"],
            "extensions":{"code":"NOT_AUTHORIZED","status":403,"operationId":"listOrders"}}]}
```

A protocol refusal — an unparseable query, a validation failure, a limit — is an HTTP `400` (or
`405`) whose body is still the GraphQL `{errors: [...]}` shape, with `extensions.code` set to
`BAD_REQUEST`, because a GraphQL client reads errors from the body and a bare `{error: {...}}`
body would be invisible to it. An operation that *ran* is a `200` whose errors are per field, which
is GraphQL's own rule.

## The optional peers

`graphql` and `openapi-x-graphql` are optional peers, declared in `package.json` exactly as
`kysely` and `drizzle-orm` are. **No module under `src/graphql/` names either in a static import**:
they load through `import()` in `src/graphql/peers.ts`, at the first request that needs a schema.
`src/kysely.ts` may import its peer statically because nothing under `src/` imports *it*;
`src/server/routes.ts` will import this, so that loosening is not available here.

Absent, they are a `MissingPeersError` naming both packages and the install command
(`bun add graphql openapi-x-graphql`). The handler **throws** it rather than answering with it, so
a server can decide not to mount the route at all — `graphqlAvailable()` is the check to mount
behind, which is what `docs/plan-surfaces.md` asks for. `options.peers` overrides how they resolve,
for an embedder that vendors them and for the test that proves the absent path without
uninstalling anything.

## What the generator made of a real tenant

Two tables, `users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)` and
`orders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, total REAL)`. **`warnings: []`** —
nothing was dropped.

```graphql
type Query {
  listOrders(id: String, userId: String, total: String,
             select: String, order: String, limit: Int, offset: Int): [Order!]
  getOrder(id: String!, select: String): Order
  listUsers(id: String, name: String, email: String,
            select: String, order: String, limit: Int, offset: Int): [User!]
  getUser(id: String!, select: String): User
  _info: ApiInfo!
}

type Mutation {
  createOrder(input: JSON!): [Order!]
  deleteOrder(id: String!): Order
  updateOrder(id: String!, input: OrderPatchInput!): Order
  createUser(input: JSON!): [User!]
  deleteUser(id: String!): User
  updateUser(id: String!, input: UserPatchInput!): User
}

type User { id: JSON, name: String, email: String }
input UserPatchInput { id: JSON, name: String, email: String }
```

Every field carries the operation's `summary` and `description` — the filter grammar, the primary
key's declared type, "answers with the row as it is now, or null when the key matched nothing" —
which is why H3 and H4 treat those as load-bearing rather than as polish.

- **No `db` argument**, per the edit above. The tenant is in the base URL.
- **`s.int64()` is `JSON`**, and that is the point: `{"$i": "9223372036854775807"}` survives in and
  out. `docs/h3-openapi.md` records why, and this milestone does not re-litigate it — it tests it.
  A bare JSON number that large is already rounded by `JSON.parse` before anything of ours sees it,
  so the tagged form is what a client sends.
- **`s.blob()` is a nested object**, `type FileBody { b: String! }`, because `$` is not legal in a
  GraphQL name. The generator's `openapiName` extension renames it **both ways**: a write through a
  typed input (`updateFile(input: {body: {b: "aGk="}})`) reaches SQLite as the `{"$b": …}` the wire
  format expects, and a read comes back as `body { b }`. Checked against real bytes.
- **A REAL column is `JSON` too**, because it publishes the union of a number and `{"$f": "inf"}`
  (`docs/h4-dataapi.md`). Same trade as `int64`.
- **An insert body is `input: JSON!`, not a `NewUserInput` type.** H3's worked example produced
  `NewUserInput` from a single-object body; H4's real insert takes *one row or an array of rows*,
  which is a union with no fixed shape, so the generator uses its catch-all scalar. Both tagged
  values and plain ones pass straight through it. A patch body is one row, so `UserPatchInput` is a
  real input type.
- **A row's fields are nullable** (`name: String`, not `String!`) because a row component's
  properties are all optional — `?select=id,name` narrows the row, and a document declaring them
  required would be lying (`docs/h4-dataapi.md`).
- **`_info: ApiInfo!`** is the generator's own field, describing the source document. Noted in
  `docs/plan-surfaces.md` so nobody reports it as a bug; `generator: {includeInfoField: false}`
  removes it. Its `baseUrl` is the internal origin above.

## The surface

```ts
graphqlHandler(options): (request: Request) => Promise<Response>   // plus `.schemas`, the cache
schemaFor(db, options): Promise<GraphQLSchema>                     // one schema, built now
class SchemaCache { for(db), invalidate(db), clear(), size }
graphqlAvailable(): Promise<boolean>                               // are the peers installed
```

`POST` takes `{query, variables, operationName}` as JSON (or `application/graphql` text); `GET`
takes the same as query parameters and allows `query` operations only; a browser's `GET` — `Accept:
text/html`, no `query` — gets GraphiQL, which the package renders, unless `graphiql: false`. CORS
is **not** written here: `src/server/app.ts` owns it for every route on this server and a second
set of headers would fight it.

`databaseFromPath` reads `{db}` out of a `/v1/db/{db}/graphql` path; `options.database` overrides
it. The route itself is `src/server/routes.ts`, which this milestone does not touch.

## What it deliberately does not do

- **No route, no mounting, no config reading.** `POST /v1/db/{db}/graphql`, `[graphql] enabled`,
  `[graphql] path` and the decision not to mount when the peers are absent are the server's.
- **No subscriptions.** Milestone H7, over the change feed in `src/realtime/`. A REST document
  cannot describe one, so there is nothing here for the generator to make of it.
- **No `createOpenApiDocument` round-trip gate.** `plan-surfaces.md` wants `--round-trip` as a CI
  check; it needs a script, and `scripts/` is not this milestone's.
- **No second execution engine.** Every dispatch ends in `src/server/exec.ts`, which is where the
  ACLs, deadlines, row caps, quotas, txids, ack levels and write forwarding already live.

## Findings

- **Bun's `typeof fetch` carries a `preconnect` method**, so a `Dispatcher` is not assignable to
  `ExecutorOptions.fetch` without a cast. The generator only ever calls the function
  (`executeOperation` does `doFetch(request, init)`), so the cast is at the one place that needs it
  and is commented there.
- **`printSchema` imported from a module outside this repo throws `Unexpected type: Query`.** Two
  copies of `graphql` are loaded and the `instanceof` checks in `printType` fail against the
  schema's types. It is not a bug in anything here — it is what happens when a script outside
  `node_modules` resolves its own copy — but it is worth knowing, and the fix is to reach for the
  peer through `loadPeers()` rather than importing `graphql` directly. Tests inside the repo
  resolve one copy and are fine.
- **`security: "bearer"` on the operations is inert in this path**, which is correct: the generator
  would apply `ExecutorOptions.auth` to satisfy it, and there is nothing to satisfy — the caller's
  rights are already in the ambient context, and re-authenticating a token the server just
  authenticated would be work for its own sake. It does mean the generated schema documents a
  requirement its own resolvers never send.
- **A filter argument is a `String`, so a column may appear at most once in a query.** That is
  H4's trade (`?id=gt.1&id=lt.4` is a 400), inherited unchanged: `listUsers(id: "gt.1")` is the
  grammar, and there is no range filter in GraphQL any more than in REST.
