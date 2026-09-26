# H8 — the hand-written `/v1` handlers on core's validator, and `NOT_FOUND`

Plan of record for the two things `docs/h6-mount.md` deliberately left behind. Written before the
work; `docs/next.md` gets the result.

Both are described in `docs/next.md` under "C. ~~H6~~ Done this session. What replaces it".

## 1. The published request schemas are not enforced

`src/server/registry.ts` declares a `body`, and sometimes a `query`, for every `/v1` operation, and
`GET /v1/openapi.json` publishes them — but `src/server/app.ts` mounts each operation behind its own
`wrap()` rather than behind `compileOperation` from `src/http/handler.ts`, so nothing checks a
request against what the document promises. A body of `{"sql": 42}` reaches `handlers.query`, which
then produces its own diagnostic, or not.

### Why it was left

Two obstructions, both real:

1. **`wrap()` needs the error code a handler refused with.** C2's same-origin `307` is answered only
   for `NOT_PRIMARY`, and `compileOperation` turns the throw into a `Response` before anything
   outside it can look at the code.
2. **`src/server/routes.ts`'s first invariant is an ordering one:** *resolve the principal before
   touching a tenant, and the tenant before reading the body.* A request that may not see a database
   must not learn whether it exists, and a malformed body must not have opened a connection first.
   `compileOperation` validates the body **before** the handler, so an unauthenticated request with
   a bad body would answer `400` where it answers `401` today.

### The design

**Obstruction 1 — split the pipeline at the error boundary.** `compileOperation` today does two
things: run the operation, and map whatever it threw onto a `Response`. Separate them:

```ts
/** The validated pipeline with the error mapping left off: it throws. */
export type Execute<Ctx> = (invocation: Invocation, ctx: Ctx) => Promise<Response>
export function executeOperation<Ctx>(operation, options?): Execute<Ctx>
```

`compileOperation` becomes `executeOperation` plus the `try/catch` it already has, so every existing
caller is unchanged. `src/server/app.ts` calls `executeOperation` instead and lets the throw reach
`wrap()`, which already catches, already reads `err.code` and already answers the `307`. There is no
second error path: `wrap()`'s `errorResponse` is the one that runs.

For that to lose nothing, `RequestInvalid`'s `problems` have to survive `errorResponse`. They move
into `mapError` in `src/server/errors.ts`: any error carrying a `problems` array puts it in the body.
`invalidResponse` in `src/http/handler.ts` then stops being a special case and the two surfaces
produce byte-identical 400s.

**Obstruction 2 — validate the body where the handler asks for it.** Path, query and headers are
validated eagerly by the pipeline, as they are for the data API. They cost nothing and leak nothing:
every `/v1` path parameter is `s.string()` and so cannot fail, no operation declares headers, and the
three that declare a query (`changes`, `live`, `databaseGraphiql`) publish exactly the keys their
handlers read. The **body** is not read eagerly — `deferBody` in `HttpOptions` says so. Instead
`app.ts` installs a thunk built by `bodyReader`, and `readJson` in `src/server/routes.ts` — the
single choke point all twelve body-reading handlers already go through — calls it:

```ts
export interface RouteContext {
  /** Reads and validates the body against the operation's published schema, once. */
  body?: () => Promise<unknown>
}
```

Memoised, because `txQuery` reads the body on two branches and a drained stream cannot be read
twice.

So the order stays exactly as the invariant states it, and the schema is genuinely enforced: a
handler cannot see a body core rejected, because the only way to a body is through `readJson`.

`bodyOptional` in `registry.ts` stops being decoration and becomes the gate it reads like. The
handlers all default an empty body today, so the specs that say `bodyOptional: true` keep working
and the rest — `query`, `batch`, `txQuery`, `createDatabase`, `importDatabase`, `mintToken`,
`databaseGraphql` — start refusing an empty body with `400 body is required`, which is what the
document has said since `b503ada`.

### What this does not do

Handlers keep parsing the validated value themselves rather than taking a typed `input`. Nothing is
gained by threading thirty signatures: the value `readJson` returns is core's coerced output, so it
is already the validated one.

## 2. `NOT_FOUND: 404`

`ERROR_STATUS` has `DB_NOT_FOUND` and `TX_NOT_FOUND` and nothing meaning a row, so the data API's
three `/{pk}` operations answer `200` with `null` and publish `anyOf: [Row, null]`.

- `NOT_FOUND: 404` joins `ERROR_STATUS` and `BqlErrorCode`, with `BqlError.notFound`.
- The `get`, `update` and `delete` operations in `src/dataapi/operations.ts` declare it, their
  response schema becomes the row rather than the union, and the handlers throw instead of returning
  `null`.
- **GraphQL keeps answering `null`.** A missing row is not an error in GraphQL, and the resolvers
  reach the data API through one in-process `fetch` (`src/graphql/document.ts`), so that fetch turns
  a `404` whose code is `NOT_FOUND` into a `200` with a `null` body. One place, and the generated
  field stays nullable because the document still declares the operation may answer nothing.

### What this does not do — as built

Two bodies are described and not checked, and both are right to be:

- **`importDatabase`** carries a raw SQLite file. Its handler streams the request itself and never
  reaches `readJson`, so nothing tries to `JSON.parse` a database. It now declares
  `bodyType: "application/vnd.sqlite3"` so the document says what it really takes.
- **`databaseGraphql`** has to answer a malformed query in GraphQL's own `{errors: [...]}` envelope
  rather than bql.sh's `{error: {...}}` — `src/graphql/handler.ts`'s header argues that out — so its
  handler reads and refuses the body itself.

And an ordering consequence worth stating, because a test pins it: `POST /v1/db/{db}/query` with an
invalid body on a database this node no longer owns answers `400`, not the `307`. `query` cannot
know whether the statement is a write, and so whether this node may take it, until it has read the
SQL. A route that refuses up front — `DELETE /v1/db/{db}` — never reaches a body and redirects.

## Verification

`bun test` (1318 pass, 2 skip, 0 fail), `bun run typecheck`, `bun run bytes`, `bun run routes:check`,
all clean. Tests added in `test/server/registry.test.ts` and `test/server/promote.test.ts`:

- a `/v1` request whose body violates the published schema answers `400` listing **every** problem;
- an absent required body is `400 body is required`, and an absent optional one is a real request;
- an unauthenticated request with a bad body still answers `401`, not `400`;
- a body over `maxBodyBytes` is still `413`;
- a write on a same-origin promoted-away database answers `307` with `Location`;
- `GET /v1/db/{db}/api/users/999` answers `404 NOT_FOUND`, and the same row through GraphQL is
  `data.getUser: null` with no error.

Exercised by hand against a real node on top of that: the statement, transaction, token, change
feed, live query, dump/import and data API routes, the two generated documents, and the GraphQL
surface with both peers resolved.

One thing found along the way and fixed: `ResponseInvalid` also carries a `problems` list, and
moving `problems` into `mapError` briefly leaked it into the `500` a client is supposed to learn
nothing from. `problemsOf` is gated to `BqlError`, which a response bug is not.

Two code comments claimed an unsupported verb answers `405` from Bun's router. It answers `404`,
through `createApp`'s `fetch` fallback — verified by hand. The comments say so now; the behaviour
is unchanged and predates this work.
