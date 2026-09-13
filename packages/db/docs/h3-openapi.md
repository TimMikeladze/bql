# H3 — `src/openapi/`, the document

Milestone H3 of `docs/plan-surfaces.md`. A core `Registry` in, one OpenAPI 3.1 JSON document out.
Pure: no I/O, no Bun API, no `node:` import, no route.

**This document is the input to a code generator, not prose for a human.** H5 does not read the
registry; it reads this document and hands it to
[`openapi-x-graphql`](https://github.com/TimMikeladze/openapi-x-graphql). So the parts that look
cosmetic — `operationId`, component names, `$ref`s, descriptions — are the parts that decide what
the generated GraphQL schema is *called*, and a shortcut here becomes a missing field there.

```ts
import { buildDocument } from "@bunql/db/openapi"

const document = buildDocument(registry, {
  servers: [{ url: "https://sql.example.com" }],
})
```

## What it guarantees

Everything below is enforced at build time by throwing, not left to a reviewer.

- **One `paths` entry per operation**, in registration order, keyed by the operation's path with
  Bun's `:param` rewritten to OpenAPI's `{param}`. `templatePath` does that one conversion and
  **nobody converts the other way** — `Operation.path` is Bun's syntax because `src/http/` hands it
  to `Bun.serve` unchanged.
- **`operationId` is `Operation.id`, verbatim.** Core already constrains an id to a GraphQL name
  (`/^[A-Za-z_][A-Za-z0-9_]*$/`), which is exactly why: it becomes the generated field name.
  `Registry.add` refuses a duplicate id, so the document cannot contain one.
- **Every `$ref` resolves.** A `ref("User")` naming a schema no operation defines is a build-time
  throw, not a dangling pointer in the published document.
- **Every path parameter is declared and `required: true`.** Core's `Registry.add` already refuses
  an operation whose `:param` set and `params.path` properties disagree, or whose path parameter is
  optional; the emitter relies on that and re-asserts `required: true` on the way out.
- **Two different schemas claiming one name is refused**, with the two operations named in the
  message. Two *identical* schemas built separately are fine — the check compares the emitted JSON,
  not object identity, because a shared `User` defined in two modules is not a mistake.

## The error rule

`Operation.errors` is a list of BunQL error codes. Each becomes a **documented response under its
real status**, never a `default` that shrugs.

`src/server/errors.ts` is the authority on the code→status mapping and **this module does not keep
a second copy of it**. `statusForCode` asks that module twice:

1. `ERROR_STATUS[code]` for a BunQL code (`NOT_PRIMARY` → 503, `QUOTA_EXCEEDED` → 507).
2. For a `SQLITE_*` name, `mapError(new SqliteError("", rc))` — the real function, on a real
   `SqliteError`, with `rc` recovered by inverting `RESULT_CODE_NAMES`. So the prefix rules in
   `fromSqlite` (`SQLITE_CONSTRAINT*` → 409, `SQLITE_BUSY*` → `BUSY` 503, `SQLITE_FULL` →
   `QUOTA_EXCEEDED` 507) are *executed*, not restated. If that function changes, the document
   follows on the next build.

A code that is neither is a throw naming the operation — it can only be a typo.

**Codes sharing a status collect into one response** whose description names all of them, because a
response object is keyed by status and a duplicate key is not a thing:

```json
"409": {
  "description": "Conflict. `error.code` is one of CONFLICT, RESET_REQUIRED, SQLITE_CONSTRAINT_UNIQUE.",
  "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } }
}
```

The body is the shape `src/server/errors.ts` writes (`ErrorInfo` in `src/client/protocol.ts`):
`{ error: { code, message, status, txid?, failedIndex?, primary?, acks?, needed? } }`, emitted once
as the `Error` component and `$ref`'d from every error response. `acks`/`needed` are there because
`mapError` really does attach them for `ACK_TIMEOUT`.

An error status equal to the success status is dropped rather than overwriting the success
response.

## `$ref` and component naming

- A schema carrying `.id(name)` becomes `components/schemas/<name>` and is replaced by
  `{"$ref": "#/components/schemas/<name>"}` **everywhere it appears**, at any depth, including
  inside another named schema.
- A `ref(name)` node — core's bare-name reference, which is how a schema refers to itself — is
  rewritten to the same pointer.
- The component name is the `.id()` string unchanged. It is what the generator names the GraphQL
  type, so it should read like a type name (`User`, not `user_row`).
- The `Error` component name is `options.errorSchemaName`, default `"Error"`. A registry that
  already names a schema `Error` gets a throw pointing at that option.

## Security

Two schemes, emitted only when an operation references one:

| scheme | `Operation.security` | what it is |
|---|---|---|
| `bearerAuth` | `"bearer"` | the Ed25519 (EdDSA) JWT of design §6, minted by `POST /v1/tokens` |
| `adminKey` | `"admin"` | the configured admin key, presented as a bearer token (`Authenticator.authenticateToken` compares it before trying the key ring) |

`security: "none"` emits `"security": []` — an explicit empty requirement, which tells a generated
client *this endpoint takes no credential*. An operation with no `security` at all emits no
`security` key, which means "unspecified"; the two are different and a generator treats them
differently.

## The BunQL value encoding survives

`s.int64()` publishes `anyOf: [{"type":"integer"}, {"$i": "<decimal>"}]` and `s.blob()` publishes
`{"$b": "<base64>"}`. The emitter copies them through untouched. Flattening an int64 to a plain
JSON number is the precision loss design §6.1 calls out in rqlite and D1, and it would reappear in
every generated client. The `CODEC` symbol core hangs off those nodes is invisible to
`Object.keys`, so it costs the document nothing and is simply dropped.

## Reading a keyword off a live core node — the trap, for H4 and H5 too

`src/core/schema.ts` keeps its builders on the node's prototype, so nine JSON Schema keywords are
**methods when absent and values when present**:

```
minLength  maxLength  pattern  format  minItems  maxItems  uniqueItems  multipleOf  deprecated
```

```js
s.string().minLength                     // function minLength(n) {…}   — NOT undefined
"minLength" in s.string()                // true                        — NOT false
Object.hasOwn(s.string(), "minLength")   // false                       — correct
Object.keys(s.string())                  // ["type"]                    — correct
```

So `node.minLength !== undefined` and `"minLength" in node` are **both always true**, for every
string schema, set or not. An emitter written that way puts a *function* under the keyword;
`JSON.stringify` drops it, so it vanishes from the published file and comes back as a missing
constraint or a stray `parameters` entry depending on how the object was built — and every
happy-path assertion still passes, because the happy path is the one where the keyword *is* set.

The worst instance in this module is `deprecated`: a bare probe in `decorate()` would have stamped
`deprecated: true` on **every** parameter in the document.

The rules this module follows, and the ones `src/dataapi/` and `src/graphql/` should follow when
they walk the same nodes:

- **Read one keyword with core's `keyword(node, name)`** (landed in `7c7c357`; core itself reads
  through it at ~20 call sites). Never `node.x`, never `"x" in node`.
- **Enumerate with `Object.keys` / spread**, which see own keywords and no prototype method. That
  is how `Components.#node` copies a schema and how `forEachChild` walks one — by enumeration,
  never by probing a name.
- **Or walk `toJsonSchema()`'s output**, which is now *guaranteed* to be fresh literals over
  `Object.prototype` at every depth, root and nested.

`test/openapi/document.test.ts` pins this with the assertion that catches the class — what a schema
*without* a keyword does **not** emit: an unconstrained `s.string()` emits exactly `{"type":
"string"}`, an unconstrained `s.array()` exactly `{"type": "array", "items": …}`, a parameter whose
schema never called `.deprecated()` has no `deprecated` key, and no value anywhere in the document
is a function. Reintroducing the trap in either `document.ts` or `schemas.ts` fails all four (and
three of the existing tests besides) — checked, not assumed.

## What the generator made of it

`openapi-x-graphql` 1.0.0 + `graphql` 17.0.2, on a document built from four realistic data-API
operations (`listUsers`, `getUser`, `createUser`, `deleteUser`) with `basePath: "/v1/db/{db}/api"`.
**`warnings: []`** — nothing was dropped, and all four operations became fields: two on `Query`,
two on `Mutation`.

```graphql
type Query {
  """
  List rows of users

  Filter with PostgREST's URL grammar: ?id=gt.10&order=name.asc&limit=20.

  `GET /users`
  """
  listUsers(db: String!, limit: Int, order: String): [User!]
  getUser(db: String!, id: String!): User
  _info: ApiInfo!
}

type Mutation {
  createUser(db: String!, input: NewUserInput!): User
  deleteUser(db: String!, id: String!): WriteResult
}

"""One row of the users table."""
type User {
  id: JSON!            # s.int64()
  name: String!
  email: String
  avatar: UserAvatar   # s.blob()
  profile: Profile!
}

type UserAvatar { b: String! }
input NewUserInput { name: String!, email: String, profile: ProfileInput }
```

Reading that back against the brief:

- **`operationId` is the field name**, the `summary` is the first line of the field description and
  the `description` the second — which is why those are not optional polish.
- **`.id()` is the type name.** `User`, `Profile`, `NewUserInput`, `WriteResult` are all component
  names; `Profile` became both an object type and a `ProfileInput`, from one component, because it
  appears in a response and in a body.
- **`required` decides nullability.** `db: String!` because a path parameter is always required;
  `limit: Int` because it has a default; `input: NewUserInput!` because a declared body defaults to
  required here.
- **`s.int64()` becomes `JSON!`, and that is the point.** The generator has no fixed shape for the
  `anyOf` of a plain integer and `{"$i": "<decimal>"}`, so it uses its catch-all scalar and the
  tagged form survives into the client. Flattening it to `Int` — which is what "simplify the
  `anyOf`" would have done — is the silent precision loss design §6.1 names in rqlite and D1.
- **`s.blob()` becomes `type UserAvatar { b: String! }`.** The `$` is not legal in a GraphQL name,
  so the generator strips it; the base64 string is reachable as `avatar { b }`. Honest but
  awkward, and the fix belongs in H5 as a custom scalar mapped from the component, not in a
  document that lies about the wire format.
- **Error responses are ignored by the generator**, as any REST-to-GraphQL generator ignores
  non-2xx. They are not wasted: they are what an OpenAPI client, and a human, read.
- **`_info` on `Query`** is the generator's own field, noted in `docs/plan-surfaces.md` so nobody
  reports it as a bug.

The generator's normalised operation carries a `deprecated: false` it read from the operation
object — see the findings below.

## What it deliberately does not emit

- **No route.** `GET /v1/openapi.json` needs `src/server/routes.ts`, which H6 owns.
- **No YAML.** Bun parses it and does not serialise it; a YAML writer would cost the
  zero-dependency rule for a convenience.
- **No `default` response.** Every error this API can produce has a status; a `default` would be an
  admission that the emitter did not know.
- **No `webhooks`, no `callbacks`, no `links`, no `$defs` hoisting beyond named nodes.** Nothing in
  BunQL's operation model produces them.
- **No operation-level `deprecated`** — see below.

## Findings

- **Core's `Operation` has no `deprecated` field.** The brief asked for operation-level
  `deprecated` to carry through; there is nothing to carry. Schema-level `.deprecated()` *is*
  carried, onto `parameters[].deprecated` and through property schemas. If an operation ever needs
  to be marked deprecated, `Operation` in `src/core/operation.ts` needs the field first, and this
  emitter is one line from honouring it.
- `Authorization`, `Content-Type` and `Accept` declared in `params.headers` are skipped as
  `parameters` entries — OpenAPI says such header parameters "SHALL be ignored", and
  `Authorization` is what the security schemes describe.
- `DocumentOptions.basePath` **strips** a shared prefix from the emitted path keys rather than
  prepending one, because `Operation.path` is already absolute. That is what a per-tenant document
  needs: `basePath: "/v1/db/acme/api"` turns `/v1/db/acme/api/users` into `/users`, to be paired
  with a server URL carrying the prefix — which is exactly `createGraphQLSchema`'s `baseUrl`.
