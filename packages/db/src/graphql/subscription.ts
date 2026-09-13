// The `Subscription` root, and the one place in `src/graphql/` that writes types instead of
// generating them. `docs/h7-subscriptions.md` §1 says why it has to: every other field here comes
// from `openapi-x-graphql` reading the tenant's data-API document, and **a REST document cannot
// describe a subscription** — SSE `GET /v1/db/{db}/changes` appears in it as a response body, not
// as an event type. So there is nothing to generate from.
//
// Invariant: this carries the **change feed**, not live queries. `LiveQueryRegistry.subscribe`
// takes `{sql, args, key}` and tracks the read-set of that statement; a GraphQL operation is a tree
// of resolvers over the data API, each running several statements, with no single read-set to
// intersect a commit's write-set against. A client that wants a live *result* re-queries when an
// event arrives, which is what a change feed is for. §2.
//
// Second invariant: the payload columns are a `JSON` scalar, not generated per-table types. The
// feed is per *database*, and a union of every table's row type would make the schema's shape
// change whenever a table is added — the churn `SchemaCache`'s version key exists to absorb rather
// than to broadcast.

import type { ChangeEvent } from "../client/protocol.ts"
import type { GraphQLScalarType, GraphQLSchema } from "graphql"
import type { Peers } from "./peers.ts"

/** What the resolver needs from the server to open a feed. Implemented in `src/server/`. */
export interface ChangeFeedHost {
  /**
   * Opens a feed and calls `emit` for every event. Returns a function that closes it.
   *
   * The host is what enforces scope: `ro` on the database to subscribe at all, and `ro` on a table
   * before its rows may be carried (§5). A subscription must not be a way around the check
   * `src/realtime/authorizer.ts` already applies to the `bunql.v1` socket.
   */
  open(
    db: string,
    options: { tables?: string[]; since?: number; include?: "none" | "pk" | "row" },
    emit: (event: ChangeEvent) => void,
  ): Promise<() => void> | (() => void)
}

/** The database and the caller, for one socket's operations. */
export interface SubscriptionContext {
  db: string
  host: ChangeFeedHost
}

/**
 * An async iterator over a push source, with a bounded queue.
 *
 * Backpressure is design §7's rule, the same one the native feed applies: a consumer that is
 * behind loses the **oldest** events rather than stopping the producer, and is told so, because a
 * change feed that queued without bound would be a memory leak driven by a slow client.
 */
export function pushIterator<T>(
  start: (emit: (value: T) => void) => Promise<() => void> | (() => void),
  options: { limit?: number; onDrop?: () => void } = {},
): AsyncIterableIterator<T> {
  const limit = options.limit ?? 1024
  const queue: T[] = []
  const waiting: ((result: IteratorResult<T>) => void)[] = []
  let close: (() => void) | null = null
  let starting: Promise<void> | null = null
  let done = false

  const emit = (value: T): void => {
    if (done) return
    const waiter = waiting.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    queue.push(value)
    while (queue.length > limit) {
      queue.shift()
      options.onDrop?.()
    }
  }

  const ensure = async (): Promise<void> => {
    starting ??= Promise.resolve(start(emit)).then((stop) => {
      // Closed between the call and its answer: stop what we just started.
      if (done) stop()
      else close = stop
    })
    await starting
  }

  const finish = (): IteratorResult<T> => {
    if (!done) {
      done = true
      close?.()
      close = null
      for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true })
    }
    return { value: undefined, done: true }
  }

  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next(): Promise<IteratorResult<T>> {
      if (done) return { value: undefined, done: true }
      await ensure()
      if (done) return { value: undefined, done: true }
      const next = queue.shift()
      if (next !== undefined) return { value: next, done: false }
      return new Promise<IteratorResult<T>>((resolve) => waiting.push(resolve))
    },
    async return(): Promise<IteratorResult<T>> {
      // Await the start before closing, so a subscription cancelled in the same tick it was opened
      // still has its `stop` called rather than leaking the engine's subscriber.
      if (starting) await starting.catch(() => {})
      return finish()
    },
    async throw(err: unknown): Promise<IteratorResult<T>> {
      if (starting) await starting.catch(() => {})
      finish()
      throw err
    },
  }
}

/**
 * The generated schema with a `Subscription` root added.
 *
 * `extendSchema` is not used: the types below are built directly, because the generated schema has
 * no `Subscription` to extend and an SDL string would be a second place the shape is written.
 */
export function withSubscription(schema: GraphQLSchema, peers: Peers): GraphQLSchema {
  const g = peers.graphql
  const {
    GraphQLBoolean,
    GraphQLEnumType,
    GraphQLFloat,
    GraphQLInt,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLScalarType,
    GraphQLSchema: Schema,
    GraphQLString,
  } = g

  // A row is whatever the table holds. `JSON` is honest about that; a generated per-table union
  // would not be, and would change shape whenever a table is added.
  //
  // The generated schema usually already has a `JSON` scalar — `openapi-x-graphql` mints one for a
  // free-form object — and a schema may not contain two types with one name, so it is reused when
  // it is there. Reusing it is also the better answer on its own terms: a client that has learned
  // what `JSON` means from a query field must not find a second meaning on a subscription.
  const existing = schema.getType("JSON")
  const JSONScalar =
    existing ??
    new GraphQLScalarType({
      name: "JSON",
      description: "Any JSON value, as the change feed carries it.",
      serialize: (value: unknown) => value,
      parseValue: (value: unknown) => value,
    })

  const ChangeOp = new GraphQLEnumType({
    name: "ChangeOp",
    values: { insert: {}, update: {}, delete: {} },
  })

  const ChangeInclude = new GraphQLEnumType({
    name: "ChangeInclude",
    description:
      "How much of a row travels: `none` reports only that something changed, `pk` adds the " +
      "primary key, `row` adds the whole row and needs `ro` on the table.",
    values: { none: {}, pk: {}, row: {} },
  })

  const RowChange = new GraphQLObjectType({
    name: "RowChange",
    fields: {
      op: { type: new GraphQLNonNull(ChangeOp) },
      table: { type: new GraphQLNonNull(GraphQLString) },
      pk: { type: new GraphQLList(new GraphQLNonNull(JSONScalar as GraphQLScalarType)) },
      row: { type: JSONScalar as GraphQLScalarType },
      old: { type: JSONScalar as GraphQLScalarType },
    },
  })

  const ChangeEventType = new GraphQLObjectType({
    name: "ChangeEvent",
    fields: {
      txid: { type: new GraphQLNonNull(GraphQLInt) },
      atMs: { type: new GraphQLNonNull(GraphQLFloat) },
      changes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RowChange))) },
      /**
       * True on the first event when `since` was older than the ring could serve. The client has a
       * gap and must re-query rather than trust the feed — the same signal the native feed sends.
       */
      reset: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
  })

  const Subscription = new GraphQLObjectType({
    name: "Subscription",
    fields: {
      changes: {
        type: new GraphQLNonNull(ChangeEventType),
        description: "Every committed transaction on this database, as it commits.",
        args: {
          tables: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
          since: { type: GraphQLInt },
          include: { type: ChangeInclude },
        },
        subscribe: (
          _root: unknown,
          args: { tables?: string[]; since?: number; include?: "none" | "pk" | "row" },
          context: SubscriptionContext,
        ): AsyncIterableIterator<ChangeEvent & { reset?: boolean }> =>
          pushIterator<ChangeEvent & { reset?: boolean }>((emit) =>
            context.host.open(
              context.db,
              {
                ...(args.tables ? { tables: args.tables } : {}),
                ...(args.since !== undefined ? { since: args.since } : {}),
                ...(args.include ? { include: args.include } : {}),
              },
              emit,
            ),
          ),
        // `subscribe` yields the event itself, so the field resolves to what it was handed.
        resolve: (source: unknown) => {
          const event = source as ChangeEvent & { reset?: boolean }
          return { ...event, reset: event.reset === true }
        },
      },
    },
  })

  const config = schema.toConfig()
  return new Schema({
    ...config,
    subscription: Subscription,
    types: existing ? config.types : [...config.types, JSONScalar],
  })
}
