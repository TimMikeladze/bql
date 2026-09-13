// The wiring `src/dataapi/context.ts` says is the server's to write: a tenant's generated REST
// API, its OpenAPI document and its GraphQL schema, mounted on this node's listener.
// `docs/h6-mount.md` is the plan of record; `docs/plan-surfaces.md` H6 is where it comes from.
//
// Invariant: **nothing here runs a statement, and nothing here decides who may.** Every data
// statement leaves through the `exec` this module closes over `src/server/exec.ts` as the
// request's own principal, so the data API inherits the token's per-table ACLs, the deadline, the
// row cap, `vmSteps`, the quota, the txid, the ack level, `minTxid` and write forwarding rather
// than reimplementing any of them. The route gate before that is `requireScope(principal, db,
// "ro")` — the same first three steps every handler in `src/server/routes.ts` takes, in the same
// order and for the same reason. A write is refused by `exec.ts`'s own `requireScope(…, "rw")`,
// which is why `ro` is the right gate here and not a hole.
//
// Second invariant: **what is cached never knows who asked.** Introspection runs with the
// server's own rights and its result is shared by every caller of that database — that is
// `src/dataapi/cache.ts`'s stated rule — so the compiled dispatcher is shared too and only the
// `DataApiContext` is per request. A dispatcher closure holding a principal would hand caller A's
// rights to caller B, which is the argument `src/graphql/ambient.ts` makes about the token.
//
// Third: the generated paths carry **concrete table names**, which differ per database, so they
// cannot be static entries in a process-wide `Bun.serve` table — `/v1/db/:db/api/users` mounted
// from `acme` would answer for `beta`. The table therefore gets one wildcard route and the
// per-tenant dispatcher in `src/http/dispatch.ts` does the rest.

import type { Args } from "../client/protocol.ts"
import {
  DataApiCache,
  type DataApiContext,
  type DataApiEntry,
  type DataStatement,
  type Execute,
} from "../dataapi/index.ts"
import {
  type ChangeFeedHost,
  graphqlAvailable,
  type GraphQLHandler,
  graphqlHandler,
  GraphQLSocket,
  type GraphQLSocketHost,
  type GraphQLSocketLike,
  loadPeers,
  type PreparedOperation,
  prepareDocument,
  tenantDocument,
} from "../graphql/index.ts"
import { createDispatcher, type Dispatcher } from "../http/index.ts"
import { ADMIN, type Principal, requireScope } from "./auth.ts"
import { BunQLError } from "./errors.ts"
import {
  awaitTxid,
  executeStatementQueued,
  type ResolvedOptions,
  resolveOptions,
} from "./exec.ts"
import { dbName, type Handler, json, type RouteContext } from "./routes.ts"
import { mapTenantError, type ServerRuntime } from "./runtime.ts"

/** Published in the documents this module emits; `test/package/exports.test.ts` keeps it honest. */
export const VERSION = "0.0.0"

/** `api` + `/v1/db/:db` → `/v1/db/:db/api`, which is what `src/dataapi/` generates paths under. */
export function apiPrefixOf(prefix: string): string {
  return `/v1/db/:db/${prefix}`
}

/** A dispatcher is compiled per schema version, alongside the registry it was compiled from. */
interface Compiled {
  schemaVersion: number
  dispatch: Dispatcher
}

/** What a request in flight carries for the pieces that are handed only a `Request`. */
interface Call {
  ctx: RouteContext
  principal: Principal
}

/**
 * The three tenant surfaces and the caches they share. One `DataApiCache` serves REST, the
 * document and GraphQL between them, so a database is introspected once per schema version however
 * it is asked about.
 */
/** `connection_init`'s payload, as every GraphQL client spells the credential in it. */
function tokenFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const bag = payload as Record<string, unknown>
  for (const key of ["authorization", "Authorization", "token", "accessToken"]) {
    const value = bag[key]
    if (typeof value === "string" && value.length > 0) return value.replace(/^[Bb]earer\s+/, "")
  }
  return null
}

export class Surfaces {
  readonly #runtime: ServerRuntime
  readonly #cache: DataApiCache
  readonly #dispatchers = new Map<string, Compiled>()
  /** The `DataApiContext` of each request in flight. The dispatcher is shared; this is not. */
  readonly #contexts = new WeakMap<Request, DataApiContext>()
  /** The route context and principal of each GraphQL request in flight; see `graphql`. */
  readonly #calls = new WeakMap<Request, Call>()
  readonly #prefix: string
  /** Built at the first GraphQL request, then reused: it owns the per-tenant schema cache. */
  #graphql: GraphQLHandler | null = null
  readonly #release: () => void

  constructor(runtime: ServerRuntime) {
    this.#runtime = runtime
    const api = runtime.config.api
    this.#prefix = apiPrefixOf(api.prefix)
    this.#cache = new DataApiCache({
      prefix: this.#prefix,
      defaultLimit: api.defaultLimit,
      maxLimit: api.maxLimit,
    })
    // A deleted database is the one case `PRAGMA schema_version` cannot cover: a new database of
    // the same name starts at version 1 again, so a cached entry for the old one would be served
    // for it (`docs/h6-mount.md`).
    this.#release = runtime.onEvict((name) => this.invalidate(name))
  }

  /** Where the data API is mounted, in Bun.serve syntax: `/v1/db/:db/api`. */
  get prefix(): string {
    return this.#prefix
  }

  /** The segment GraphQL is mounted at, after `/v1/db/{db}`. */
  get graphqlPath(): string {
    return this.#runtime.config.graphql.path
  }

  /**
   * Whether a GraphQL route should be mounted at all, resolved once at startup. A missing peer is
   * an absent route and an ordinary 404, never a 500 explaining a package the operator did not ask
   * for (`docs/h6-mount.md` decision 4).
   */
  static async graphqlEnabled(runtime: ServerRuntime): Promise<boolean> {
    if (!runtime.config.graphql.enabled) return false
    return graphqlAvailable()
  }

  /** Drops every cached entry for `db`. Registered on `runtime.evict`. */
  invalidate(db: string): void {
    this.#cache.invalidate(db)
    this.#dispatchers.delete(db)
    this.#graphql?.schemas.invalidate(db)
  }

  close(): void {
    this.#release()
    this.#dispatchers.clear()
  }

  /** That database's generated registry, introspected once per `PRAGMA schema_version`. */
  entryFor(db: string): Promise<DataApiEntry> {
    return this.#cache.for(db, this.#introspectExec(db))
  }

  // ── the per-request pieces ───────────────────────────────────────────────────────────────────

  /**
   * An `Execute` with the **server's** rights, for introspection only. Its result is cached and
   * shared by every caller of that database, so it must never be the caller's
   * (`src/dataapi/cache.ts`).
   */
  #introspectExec(db: string): Execute {
    return this.#execFor(db, ADMIN, resolveOptions(undefined, null, this.#runtime.config), null)
  }

  /**
   * One statement, as `principal`, down the path `POST /v1/db/{db}/query` takes: forwarded to the
   * primary when this node will not take it, folded into group commit when it writes, and waited
   * on to the requested `ack`. `ctx` is where the resulting txid is recorded so `src/server/app.ts`
   * can stamp `BunQL-Txid`; introspection passes null for it.
   */
  #execFor(
    db: string,
    principal: Principal,
    options: ResolvedOptions,
    ctx: RouteContext | null,
  ): Execute {
    const runtime = this.#runtime
    return async (statement: DataStatement) => {
      const tenant = runtime.tenant(db)
      const request = { sql: statement.sql, args: statement.args as unknown as Args }
      try {
        if (runtime.forwarder.needsPrimary(tenant, principal, [statement.sql])) {
          const forwarded = await runtime.forwarder.query(tenant, principal, request, options)
          if (ctx) ctx.txid = forwarded.txid
          return {
            columns: forwarded.columns,
            rows: forwarded.rows as unknown[],
            rowsAffected: forwarded.rowsAffected,
            txid: forwarded.txid,
          }
        }
        const { result, kind } = await executeStatementQueued(
          runtime,
          tenant,
          principal,
          request,
          options,
        )
        if (ctx) ctx.txid = result.txid
        if (kind === "write") {
          await runtime.awaitDurable(tenant.name, BigInt(result.txid), options.ack)
        }
        return {
          columns: result.columns,
          rows: result.rows as unknown[],
          rowsAffected: result.rowsAffected,
          txid: result.txid,
        }
      } catch (err) {
        throw mapTenantError(err, runtime.primaryUrlFor(db))
      }
    }
  }

  /**
   * The compiled dispatcher for `db`, rebuilt only when its schema has moved. Compiling runs H4's
   * whole registry through `compileOperation`, so doing it per request would put that on the hot
   * path; the context is what varies per request and it arrives through the factory below.
   */
  #dispatcherFor(db: string, entry: DataApiEntry): Dispatcher {
    const version = entry.schema.schemaVersion
    const cached = this.#dispatchers.get(db)
    if (cached && cached.schemaVersion === version) return cached.dispatch
    const contexts = this.#contexts
    const dispatch = createDispatcher(
      entry.registry,
      (invocation) => {
        const context = contexts.get(invocation.request)
        // Only reachable if something dispatched a request this module did not prepare.
        if (!context) throw new BunQLError("INTERNAL", "no data API context for this request", 500)
        return context
      },
      {
        origin: "http://bunql.internal",
        maxBodyBytes: this.#runtime.config.limits.maxBodyBytes,
        onError: (err) => this.#runtime.report(err),
      },
    )
    this.#dispatchers.set(db, { schemaVersion: version, dispatch })
    return dispatch
  }

  // ── the handlers `src/server/registry.ts` mounts ─────────────────────────────────────────────

  /** `GET|POST|PATCH|DELETE /v1/db/:db/api/*` — the generated REST surface. */
  readonly dataApi: Handler = async (ctx) => {
    const runtime = ctx.runtime
    const principal = await runtime.auth.authenticate(ctx.request)
    const db = dbName(ctx)
    requireScope(principal, db, "ro")
    const tenant = runtime.tenant(db)
    ctx.txid = Number(tenant.txid)

    const options = resolveOptions(undefined, ctx.request.headers, runtime.config)
    await awaitTxid(tenant, options)

    const entry = await this.entryFor(db)
    const dispatch = this.#dispatcherFor(db, entry)
    this.#contexts.set(ctx.request, { db, exec: this.#execFor(db, principal, options, ctx) })
    try {
      return await dispatch(ctx.request)
    } finally {
      this.#contexts.delete(ctx.request)
    }
  }

  /** `GET /v1/db/:db/openapi.json` — that database's own document. Schema disclosure, so `ro`. */
  readonly tenantOpenapi: Handler = async (ctx) => {
    const runtime = ctx.runtime
    const principal = await runtime.auth.authenticate(ctx.request)
    const db = dbName(ctx)
    requireScope(principal, db, "ro")
    // Opened before it is introspected, so a database that does not exist is `DB_NOT_FOUND` and
    // not an empty document that looks like a database with no tables.
    runtime.tenant(db)
    const entry = await this.entryFor(db)
    return json(
      tenantDocument(db, entry.registry, {
        apiPrefix: this.#prefix,
        // The document's one server URL is where the caller actually reached this node, so a
        // client can hand it to a generator and have the result address the same server.
        origin: `${ctx.url.protocol}//${ctx.url.host}`,
        info: { title: `${db} — BunQL data API`, version: VERSION },
      }),
    )
  }

  /** `POST /v1/db/:db/graphql`, and `GET` for GraphiQL. Mounted only when the peers resolve. */
  readonly graphql: Handler = async (ctx) => {
    const runtime = ctx.runtime
    const principal = await runtime.auth.authenticate(ctx.request)
    const db = dbName(ctx)
    requireScope(principal, db, "ro")
    const tenant = runtime.tenant(db)
    ctx.txid = Number(tenant.txid)
    await awaitTxid(tenant, resolveOptions(undefined, ctx.request.headers, runtime.config))
    // The handler is given only the `Request`, so the principal and the route context travel
    // beside it: the txid a field's write produced still has to reach the wrapper that stamps
    // `BunQL-Txid`, and authenticating again inside the context callback would be a second token
    // check for one request.
    this.#calls.set(ctx.request, { ctx, principal })
    try {
      return await this.#graphqlHandler()(ctx.request)
    } finally {
      this.#calls.delete(ctx.request)
    }
  }

  /**
   * A GraphQL socket speaking `graphql-transport-ws` (H7, `docs/h7-subscriptions.md` §4).
   *
   * The principal is established **once**, from `connection_init`'s payload or from the upgrade's
   * own credential, and every operation on the socket runs as it — a browser cannot set
   * `Authorization` on a WebSocket, which is why the protocol has a payload at all.
   */
  graphqlSocket(
    socket: GraphQLSocketLike,
    db: string,
    initial: Principal | null,
  ): GraphQLSocket {
    const runtime = this.#runtime
    const config = runtime.config
    let principal: Principal | null = initial
    const host: GraphQLSocketHost = {
      authenticate: async (payload: unknown): Promise<void> => {
        const token = tokenFrom(payload)
        if (token) principal = await runtime.auth.authenticateToken(token)
        if (!principal) {
          throw new BunQLError("UNAUTHENTICATED", "this socket presented no credential", 401)
        }
        // The same gate the HTTP surface applies before it generates anything.
        requireScope(principal, db, "ro")
      },
      peers: () => loadPeers(),
      prepare: async (
        query: string,
        variables: Record<string, unknown> | undefined,
        operationName: string | undefined,
      ): Promise<PreparedOperation> => {
        const who = principal
        if (!who) throw new BunQLError("UNAUTHENTICATED", "connection_init has not run", 401)
        const peers = await loadPeers()
        const tenant = await this.#graphqlHandler().schemas.for(db)
        const prepared = prepareDocument(peers, tenant.schema, query, {
          variables: variables ?? null,
          operationName: operationName ?? null,
          maxDepth: config.graphql.maxDepth,
          maxComplexity: config.graphql.maxComplexity,
          defaultRows: config.api.defaultLimit,
        })
        if (prepared.problems) {
          const why = prepared.problems.map((problem) => problem.message).join("; ")
          throw new BunQLError("BAD_REQUEST", why, 400)
        }
        const options = resolveOptions(undefined, null, config)
        return {
          document: prepared.document,
          schema: tenant.schema,
          context: { db, host: this.#feedHost(who) },
          ...(variables ? { variables } : {}),
          ...(operationName ? { operationName } : {}),
          ambient: { db, context: { db, exec: this.#execFor(db, who, options, null) } },
        }
      },
      onError: (err: unknown) => runtime.report(err),
    }
    return new GraphQLSocket(socket, host)
  }

  /**
   * Opening a change feed, as one principal, under **exactly** the rule the `bunql.v1` socket and
   * the SSE feed apply: `ro` on the database.
   *
   * There is deliberately no per-table check here, because there is none on the other two surfaces
   * either — a token with `ro` on a database sees every table's changes on all three. Enforcing a
   * narrower rule on this surface alone would be a difference between surfaces rather than a
   * defence, and the place to fix it, if it is to be fixed, is the engine all three share.
   */
  #feedHost(principal: Principal): ChangeFeedHost {
    const runtime = this.#runtime
    return {
      open: (db, options, emit) => {
        requireScope(principal, db, "ro")
        const tenant = runtime.tenant(db)
        runtime.retain(db)
        let realtime: ReturnType<ServerRuntime["realtimeFor"]>
        try {
          realtime = runtime.realtimeFor(tenant)
        } catch (err) {
          runtime.releaseSubscription(db)
          throw err
        }
        let sub: string | null = null
        try {
          const opened = realtime.subscribeChanges(options, (event) => emit(event))
          sub = opened.sub
          // The backlog goes out before anything live, in order, with `reset` on the first event
          // when the ring could not serve `since` — the same signal the native feed sends.
          let first = true
          for (const event of opened.backlog) {
            emit(first && opened.reset ? ({ ...event, reset: true } as never) : event)
            first = false
          }
          if (opened.backlog.length === 0 && opened.reset) {
            emit({ txid: Number(tenant.txid), atMs: Date.now(), changes: [], reset: true } as never)
          }
        } catch (err) {
          runtime.releaseSubscription(db)
          throw err
        }
        return () => {
          if (sub) realtime.unsubscribe(sub)
          sub = null
          runtime.releaseSubscription(db)
        }
      },
    }
  }

  #graphqlHandler(): GraphQLHandler {
    if (this.#graphql) return this.#graphql
    const config = this.#runtime.config
    const calls = this.#calls
    this.#graphql = graphqlHandler({
      cache: this.#cache,
      apiPrefix: this.#prefix,
      introspect: (db: string) => this.#introspectExec(db),
      graphiql: config.graphql.graphiql,
      maxDepth: config.graphql.maxDepth,
      maxComplexity: config.graphql.maxComplexity,
      defaultRows: config.api.defaultLimit,
      onError: (err: unknown) => this.#runtime.report(err),
      context: (request: Request, db: string): DataApiContext => {
        const call = calls.get(request)
        if (!call) {
          throw new BunQLError("INTERNAL", "no route context for this GraphQL request", 500)
        }
        const options = resolveOptions(undefined, request.headers, config)
        return { db, exec: this.#execFor(db, call.principal, options, call.ctx) }
      },
    })
    return this.#graphql
  }
}
