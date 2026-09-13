# H7 — GraphQL subscriptions over the change feed

`docs/plan-surfaces.md` H7, the last of the surfaces track and the only one of them that is new
code rather than wiring. Written 2026-09-12 before the code.

The decision is **what a GraphQL subscription on BunQL can honestly be**, and the answer turns on a
constraint the plan names in one line: a REST document cannot describe a subscription, so nothing
generates one.

## 1. Why this is not wiring

Every other GraphQL field BunQL serves is generated. `SchemaCache` introspects a tenant, builds an
OpenAPI document for its data API, and hands it to `openapi-x-graphql`, which turns `GET` routes
into `Query` fields and the rest into `Mutation` fields. One introspection serves REST, OpenAPI and
GraphQL between them, and nothing in `src/graphql/` writes a type by hand.

**There is no REST route a subscription could be generated from.** SSE `GET /v1/db/{db}/changes` is
a stream, and an OpenAPI document describes it as a response body, not as an event type. So the
`Subscription` root has to be written, and this is the one place in `src/graphql/` that writes
types rather than generating them.

## 2. The decision: the change feed, not live queries

`src/realtime/` offers two things a subscription could ride:

- **The change ring** — every committed transaction, as `{txid, atMs, changes: [{op, table, pk,
  row, old}]}`, filterable by table, replayable from a txid.
- **The live-query engine** — re-runs a query when a commit's write-set touches its read-set, and
  emits only when the result actually changed.

The live engine is the more powerful of the two and it is **not available here**, for a structural
reason rather than a scheduling one:

> `LiveQueryRegistry.subscribe` takes `{sql, args, key}` and tracks the **read-set of that SQL
> statement**. A GraphQL operation is not a SQL statement. It is a tree of resolvers dispatched
> through the data API, each of which may run several statements, and there is no single read-set
> to intersect a commit's write-set against.

Making that work means capturing a read-set across a whole GraphQL execution and re-running the
document — a different and much larger piece of work, and one that would need its own answer for
what "the result changed" means across a tree. So:

**H7 is the change feed.** One root field, `changes`, carrying exactly what the SSE feed and the
`bunql.v1` socket already carry, with the same table filter and the same replay. A client that
wants a live *result* re-queries on the event, which is what a change feed is for.

## 3. The shape

```graphql
type Subscription {
  changes(tables: [String!], since: Int, include: ChangeInclude): ChangeEvent!
}

type ChangeEvent {
  txid: Int!
  atMs: Float!
  changes: [RowChange!]!
}

type RowChange {
  op: ChangeOp!
  table: String!
  pk: [JSON!]
  row: JSON
  old: JSON
}

enum ChangeOp { insert update delete }
enum ChangeInclude { none pk row }
```

`row`, `old` and the `pk` elements are `JSON` scalars rather than generated per-table types. A
change event's payload is whatever the row is, the feed is emphatically per *database* rather than
per table, and generating a union of every table's row type would make the schema change shape
whenever a table is added — which is exactly the churn `SchemaCache`'s version key exists to
absorb, not to broadcast.

**`include` is the existing per-subscription switch** (`none` / `pk` / `row`), and it is honoured
here for the same reason it exists on the SSE feed: a subscriber that only needs to know *that*
something changed should not pay for the rows, and a subscriber with `ro` scope on a table it may
not read must not receive them.

## 4. The transport: `graphql-transport-ws`, on the path GraphQL already has

The socket is `GET /v1/db/{db}/graphql` upgraded with the `graphql-transport-ws` subprotocol — the
protocol every GraphQL client speaks (`graphql-ws`, Apollo, urql, GraphiQL). It is a small protocol
and it is implemented here rather than taken as a dependency: `ConnectionInit`/`ConnectionAck`,
`Subscribe`, `Next`, `Error`, `Complete`, `Ping`/`Pong`.

**Authentication is `connection_init`'s payload, or the usual header.** A browser cannot set
`Authorization` on a WebSocket, which is why the protocol has a payload at all; BunQL already
accepts `?token=` on its own socket for the same reason, and both are accepted here. The principal
is established **once, at connection_init**, and every operation on that socket runs as it —
`src/graphql/ambient.ts`'s rule, with the store entered per emitted event rather than per request.

**A `query` or `mutation` sent over the socket is answered** and completed, because the protocol
allows it and a client that opens one socket for everything is the normal case. It runs through the
same handler the HTTP surface runs, so there is one execution path and one set of limits.

## 5. What crosses, and what does not

**Every rule the HTTP surface has applies unchanged**, because the same code enforces them: the
depth and complexity limits before anything dispatches, the ambient principal, `nullOnNotFound`,
and BunQL's error vocabulary in `extensions.code`.

**The gate is `ro` on the database, and that is the whole of it** — corrected from what this
section first claimed. It said `include: row` would additionally need `ro` on each table named.
Reading `src/server/ws.ts` while building it showed there is **no such check on any surface**: the
native socket passes `include` straight through with a default of `pk`, and the SSE feed does the
same, so a token with `ro` on a database already sees every table's changes on both. Enforcing a
narrower rule on this surface alone would be a difference between surfaces rather than a defence,
and the place to fix it — if it is to be fixed — is the engine all three share.

**Backpressure is the socket's**, exactly as design §7 has it for the native feed: a change event is
dropped for a subscriber that is behind rather than queued without bound, and the client is told
with a `reset` so it re-queries rather than trusting a gap.

## 6. Files

New:

| file | holds |
|---|---|
| `src/graphql/subscription.ts` | the `Subscription` root, the `ChangeEvent` types, and the resolver that turns `TenantRealtime.subscribeChanges` into an async iterator |
| `src/graphql/ws.ts` | `graphql-transport-ws`: the message union, the connection state machine, and one socket's operations |

Touched:

| file | change |
|---|---|
| `src/graphql/schema.ts` | extend the generated schema with the `Subscription` root |
| `src/graphql/index.ts` | export the socket handlers |
| `src/server/app.ts` | upgrade `GET /v1/db/:db/graphql` with the `graphql-transport-ws` subprotocol |
| `docs/api.md` · `docs/h5-graphql.md` · `docs/plan-surfaces.md` · `docs/next.md` | say what is now true |

## 7. Tests

`test/graphql/subscription.test.ts`:

- a `subscribe` over a real socket receives the events a write produces, in txid order;
- `tables` filters, and a change to another table produces nothing;
- `since` replays the backlog before the live events, and a `since` the ring cannot serve reports
  `reset`;
- `complete` from the client ends the subscription, and closing the socket unsubscribes — asserted
  on the engine's own subscriber count, so a leak fails the test rather than the process;
- a socket that has not sent `connection_init` cannot subscribe;
- a `query` over the same socket is answered and completed;
- the depth limit refuses a subscription document exactly as it refuses a query.

## 8. As built

Built 2026-09-12. `bun test` → **1450 pass, 2 skip, 0 fail** (1443 before). `bun run typecheck`,
`bun run bytes` and `bun run routes:check` clean.

**§2's decision held and is the milestone.** The change feed is what a GraphQL subscription can
carry; live queries are not reachable, because `LiveQueryRegistry` tracks the read-set of a *SQL
statement* and a GraphQL operation is a tree of dispatches with no single read-set. That is a
structural fact, not a scheduling one, and it is why `changes` is the root field.

**Three things came out differently from the plan:**

- **The `JSON` scalar is reused, not defined.** `openapi-x-graphql` already mints one, a schema may
  not hold two types of one name, and — the better reason — a client that has learned what `JSON`
  means from a query field must not meet a second meaning on a subscription.
- **§5's per-table rule was wrong and is withdrawn.** See above: no surface has it, and inventing
  it here would have made the surfaces disagree.
- **The upgrade is mounted on the route, not in `fetch`.** Bun matches `routes` before the `fetch`
  fallback, so a registered path never reaches it — which the Hrana upgrade does not run into
  because its paths are not registered. `GET` on the GraphQL path with the subprotocol is an
  upgrade; everything else on it is still GraphiQL.

**What was shared rather than duplicated.** `prepareDocument` — parse, validate, then the depth and
complexity limits, in that order — was factored out of `src/graphql/handler.ts` and both surfaces
call it. So a socket and a request refuse the same documents for the same reasons, and the depth
limit test asserts it through the socket.
