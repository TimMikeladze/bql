// Invariant: every response leaves through one wrapper, so the four `BunQL-*` headers of design
// §6, the CORS headers, the error mapping of §6.6 and the metrics tick are applied in exactly one
// place. A handler that forgets them cannot exist.
//
// Routing is `Bun.serve`'s own `routes` table rather than a hand-written matcher: it matches
// before the `fetch` fallback runs, which is what keeps the query path free of URL parsing.

import { HEADERS, WS_PROTOCOL } from "../client/protocol.ts"
import { GRAPHQL_WS_PROTOCOL, GraphQLSocket } from "../graphql/index.ts"
import {
  type ClusterLink,
  RAFT_PATH,
  type RaftSocket,
  type RaftSocketData,
} from "../cluster/index.ts"
import type { ReplicationSocket } from "../replication/index.ts"
import {
  hranaRoutes,
  hranaUpgrade,
  hranaWsClose,
  hranaWsMessage,
  hranaWsOpen,
  isHranaSocket,
  isHranaUpgrade,
} from "./hrana/index.ts"
import { Catalog, type Tenant, TenantRegistry } from "../tenant/index.ts"
import { Authenticator, type RevocationList } from "./auth.ts"
import { loadConfig, resolveAuth, type ServerConfig, type ServerConfigInput } from "./config.ts"
import { BunQLError, errorResponse } from "./errors.ts"
import { failedIndexOf } from "./exec.ts"
import { Metrics } from "./metrics.ts"
import type { Operation } from "../core/index.ts"
import { bodyReader, executeOperation, type HttpOptions } from "../http/index.ts"
import { serverRegistry } from "./registry.ts"
import type { Handler, RouteContext } from "./routes.ts"
import { ServerRuntime } from "./runtime.ts"
import { Surfaces } from "./surfaces.ts"
import {
  createDbTarget,
  isRelay,
  isSharded,
  relayDrain,
  relayHranaUpgrade,
  relayMessage,
  relayUpgrade,
  routerMetrics,
  routingName,
  type RelaySocketData,
} from "./workers/router.ts"
import { ClusterShards, PROBES_AT_START } from "./workers/cluster.ts"
import { WorkerPool } from "./workers/pool.ts"
import { ReplicationRouter } from "./workers/replication.ts"
import { followHost, WorkerShards } from "./workers/replica.ts"
import { resolveWorkers } from "./workers/shard.ts"
import {
  busPublisher,
  closeSocket,
  drain,
  greet,
  handleMessage,
  movedPublisher,
  newSocketData,
  type Socket,
  type SocketData,
} from "./ws.ts"

/** Headers a browser has to be told it may read, since they are not on the CORS safelist. */
const EXPOSED = [
  HEADERS.txid,
  HEADERS.node,
  HEADERS.role,
  HEADERS.durationUs,
  HEADERS.primary,
  // `Location` is not on the CORS safelist, and a browser client that cannot read it cannot
  // follow C2's `307` to the node that took the database over.
  "Location",
].join(", ")

const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "last-event-id",
  HEADERS.minTxid,
  HEADERS.ack,
].join(", ")

function applyCors(config: ServerConfig, request: Request, headers: Headers): void {
  if (!config.server.cors) return
  const origin = request.headers.get("origin")
  headers.set("access-control-allow-origin", origin ?? "*")
  if (origin) {
    headers.set("vary", "Origin")
    headers.set("access-control-allow-credentials", "true")
  }
  headers.set("access-control-expose-headers", EXPOSED)
}

function preflight(config: ServerConfig, request: Request): Response {
  const headers = new Headers()
  applyCors(config, request, headers)
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS")
  headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") ?? ALLOWED_HEADERS,
  )
  headers.set("access-control-max-age", "86400")
  return new Response(null, { status: 204, headers })
}

/** A Bun route handler around one of ours, with the common headers and the error mapping. */
function wrap(runtime: ServerRuntime, handler: Handler) {
  return async (request: Request & { params?: Record<string, string> }, server: unknown) => {
    const startedNs = Bun.nanoseconds()
    const ctx: RouteContext = {
      runtime,
      request,
      server: server as RouteContext["server"],
      url: new URL(request.url),
      params: request.params ?? {},
    }
    let response: Response
    let refused: string | null = null
    try {
      response = await handler(ctx)
    } catch (err) {
      refused = err instanceof BunQLError ? err.code : null
      response = errorResponse(err, {
        ...(ctx.txid !== undefined ? { txid: ctx.txid } : {}),
        ...(failedIndexOf(err) !== undefined ? { failedIndex: failedIndexOf(err) } : {}),
      })
      // A 500 is a bug in this server, and the client is told nothing about it, so it has to be
      // reported here or it is lost. A `BunQLError` is never that: every code in `ERROR_STATUS`
      // is a refusal this server wrote on purpose, and several of them are 5xx — `NOT_PRIMARY`,
      // `NO_REPLICAS`, `ACK_TIMEOUT`, `BUSY`, `QUOTA_EXCEEDED`. Logging those with a stack trace
      // buries the real bugs in the noise of a replica answering the question it is supposed to.
      const deliberate = err instanceof BunQLError && err.code !== "INTERNAL"
      if (response.status >= 500 && !deliberate) runtime.report(err)
    }
    const durationUs = Math.round((Bun.nanoseconds() - startedNs) / 1000)
    const db = ctx.params.db
    // The role is the live role *for this database* — a node promoted at runtime is a primary for
    // what it was promoted for and a replica for everything else, and one header cannot be both.
    // A request that names no database gets the node's own role (C2).
    const role = db ? runtime.roleFor(db) : runtime.role
    let response2 = response
    const headers = response.headers
    headers.set(HEADERS.node, runtime.node)
    headers.set(HEADERS.role, role)
    // Every response from a replica says where the primary is, not just the refusals: a client
    // that wants `consistency: "primary"` should not have to provoke an error to find out.
    const primary = db ? runtime.primaryUrlFor(db) : runtime.primaryUrl
    if (primary && !headers.has(HEADERS.primary)) headers.set(HEADERS.primary, primary)
    // Design §5.3's redirect, with the one constraint the standard puts on it: a `307` is answered
    // only when the new primary is on the **same origin** as the request.
    //
    // Following a cross-origin redirect strips `Authorization` (Fetch standard, "HTTP-redirect
    // fetch"), so a `307` across nodes turns a refusal a client can retry into a `401` it cannot
    // explain. Same-origin — one load balancer in front of the cluster, which is how §5.3's
    // redirect is meant to be deployed — keeps the header and the client is genuinely helped.
    // Otherwise the answer stays `503 NOT_PRIMARY` with `BunQL-Primary`, and the SDK retries
    // against that node itself, carrying its own token. `docs/c2-promotion.md` argues it out.
    //
    // Either shape is only ever produced for a refusal taken *before* the statement ran — every
    // producer of `NOT_PRIMARY` refuses up front — so replaying it cannot double-apply a write.
    if (refused === "NOT_PRIMARY" && db) {
      const http = runtime.primaryHttpFor(db)
      if (http) {
        const location = `${http}${ctx.url.pathname}${ctx.url.search}`
        headers.set("location", location)
        if (sameOrigin(http, ctx.url)) response2 = new Response(response.body, { status: 307, headers })
      }
    }
    headers.set(HEADERS.durationUs, String(durationUs))
    if (!headers.has(HEADERS.txid) && ctx.txid !== undefined) {
      headers.set(HEADERS.txid, String(ctx.txid))
    }
    applyCors(runtime.config, request, headers)
    runtime.metrics.request(response2.status, durationUs)
    return response2
  }
}

/** Whether a redirect to `target` would keep the request's `Authorization` header. */
function sameOrigin(target: string, from: URL): boolean {
  try {
    return new URL(target).origin === from.origin
  } catch {
    return false
  }
}

/** A replication socket's `data`, told apart from a client socket's by the marker field. */
export interface ReplicationSocketData {
  replication: true
}

type AppSocketData =
  | SocketData
  | ReplicationSocketData
  | RaftSocketData
  | RelaySocketData
  | GraphQLSocketData

function isReplication(data: AppSocketData): data is ReplicationSocketData {
  return (data as ReplicationSocketData).replication === true
}

function isCluster(data: AppSocketData): data is RaftSocketData {
  return (data as RaftSocketData).cluster === true
}

export interface App {
  routes: Record<string, unknown>
  /** The generated surfaces this table serves, so a caller that owns the app can release them. */
  surfaces: Surfaces
  fetch: (
    request: Request,
    server: unknown,
  ) => Response | Promise<Response | undefined> | undefined
  websocket: Record<string, unknown>
  /**
   * C4b: the router's half of `/v1/replication` on a `workers > 1` node, or null everywhere else.
   * The workers hold the streams; this holds the sockets. `docs/c4b-replication-workers.md`.
   */
  replication: ReplicationRouter | null
}

/**
 * The route table of design §6, built from `src/server/registry.ts` — the one list of operations
 * that `GET /v1/openapi.json` is also emitted from, so the table and the document cannot drift
 * (`docs/h6-mount.md`).
 *
 * Each operation runs through core's validator and then through `wrap()`. `wrap` is the outer
 * layer because it has to see the error *code* a handler refused with, to answer C2's same-origin
 * `307`; so the inner layer is `executeOperation`, which throws, rather than `compileOperation`,
 * which would have turned the refusal into a `Response` first (`docs/h8-validated-requests.md`).
 * The body is deferred: `src/server/routes.ts` reads it through `readJson` after it has resolved
 * the principal and the tenant, which is that file's first invariant, and `ctx.body` is where core
 * validates it. The generated data API is compiled the ordinary way inside
 * `src/server/surfaces.ts` — it needs the coercion and it gets no `307`.
 *
 * Methods stay spelled out per path rather than one catch-all per path, so a verb no operation
 * declares reaches no handler at all. Bun answers it by falling through to the `fetch` below,
 * which is a 404 — verified by hand, not a 405.
 *
 * Async because whether GraphQL is mounted at all depends on two optional peer packages
 * resolving, which is an `import()`. It is resolved once here, never per request.
 */
export async function createApp(runtime: ServerRuntime, pool?: WorkerPool): Promise<App> {
  const options = (request: Request) => preflight(runtime.config, request)
  // C4b: with workers, `runtime.replication` is null on this thread (`replicationMode: "none"`)
  // and each worker holds a hosted `ReplicationServer` instead. This owns the sockets and routes
  // each frame to the shard that owns the stream it names.
  const replRouter =
    pool && runtime.config.replication.secret
      ? new ReplicationRouter({
          runtime,
          pool,
          node: runtime.node,
          secret: runtime.config.replication.secret,
          heartbeatMs: runtime.config.replication.heartbeatMs,
          slowReplicaMs: runtime.config.replication.slowReplicaMs,
          onError: (err) => runtime.report(err),
        })
      : null
  if (pool && replRouter) {
    pool.setReplicationHost({
      out: (conn, bytes) => replRouter.out(conn, bytes),
      shut: (conn, code, reason) => replRouter.shut(conn, code, reason),
      announce: () => {
        // A worker's database set moved — a bootstrap created a replica row, a delete removed one.
        // The router derives `BunQL-Role` and C3b's plan from its own read of that catalog, and a
        // row another thread wrote reaches no `onChange` here.
        runtime.promoter.refresh()
        replRouter.announce()
      },
    })
  }
  const surfaces = new Surfaces(runtime)
  const registry = serverRegistry(surfaces, {
    api: runtime.config.api.enabled,
    graphql: await Surfaces.graphqlEnabled(runtime),
  })

  // The same limits the hand-written path used, so a mounted route refuses exactly what it did.
  const http: HttpOptions = {
    maxBodyBytes: runtime.config.limits.maxBodyBytes,
    // `wrap()` already reports a 500 it did not recognise; a second report would double every one.
    onError: () => {},
  }
  const routes: Record<string, unknown> = {}
  for (const operation of registry.operations()) {
    // With workers, a route that names a database is not served here at all: it is forwarded to
    // the worker that owns it, whose own app has already applied `wrap()`. `docs/c4-workers.md`.
    // H7: `GET` on the GraphQL path with the `graphql-transport-ws` subprotocol is an upgrade, not
    // a request. It is handled here rather than in `fetch` below because Bun matches `routes`
    // first, so a registered path never reaches the fallback.
    const graphqlSocketRoute =
      operation.id === "databaseGraphiql"
        ? async (request: Request, server: unknown): Promise<Response | undefined> => {
            const url = new URL(request.url)
            if (isGraphQLUpgrade(runtime, request, url)) {
              return upgradeGraphQL(runtime, surfaces, request, server, url)
            }
            return wrap(runtime, asHandler(operation, http))(request as never, server)
          }
        : null
    const handler =
      graphqlSocketRoute ??
      (pool && isSharded(operation.path)
        ? forwardByPath(runtime, pool)
        : pool && operation.id === "createDatabase"
          ? forwardByBody(runtime, pool)
          : pool && operation.id === "metrics"
            ? () => routerMetrics(runtime, pool, replRouter)
            : wrap(runtime, asHandler(operation, http)))
    mountOperation(routes, operation, handler as never)
  }
  // One preflight per path the registry claims, exactly as the hand-written table wrote by hand.
  for (const entry of Object.values(routes)) {
    ;(entry as Record<string, unknown>).OPTIONS = options
  }

  Object.assign(routes, pool ? forwardHrana(runtime, pool, options) : hranaRoutes(runtime))

  return {
    routes,
    surfaces,
    replication: replRouter,
    fetch(request: Request, server: unknown) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/ws") {
        return pool
          ? relayUpgrade(runtime, pool, request, server, url)
          : upgrade(runtime, request, server, url)
      }
      // Node-to-node, on its own path and with its own handshake: the cluster secret is proved
      // in-band over the socket (design §8), so nothing here looks at `Authorization`.
      if (url.pathname === "/v1/replication") {
        return upgradeReplication(runtime, replRouter, request, server)
      }
      // The control plane's own socket, authenticated the same way with the same secret (C1).
      if (url.pathname === RAFT_PATH) return upgradeCluster(runtime, request, server)
      if (isHranaUpgrade(request, url)) {
        return pool
          ? relayHranaUpgrade(runtime, pool, request, server, url)
          : hranaUpgrade(runtime, request, server, url)
      }
      if (request.method === "OPTIONS") return preflight(runtime.config, request)
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
      applyCors(runtime.config, request, headers)
      headers.set(HEADERS.node, runtime.node)
      headers.set(HEADERS.role, runtime.role)
      runtime.metrics.request(404, 0)
      return new Response(
        JSON.stringify({
          error: { code: "BAD_REQUEST", message: `no route for ${url.pathname}`, status: 404 },
        }),
        { status: 404, headers },
      )
    },
    websocket: {
      idleTimeout: 120,
      sendPings: true,
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws: Socket) {
        if (isRelay(ws.data) && pool) {
          const data = ws.data
          pool.attach(data.id, {
            send: (text: string) => (ws as unknown as { send(t: string): number }).send(text),
            subscribe: (topic: string) => ws.subscribe(topic),
            unsubscribe: (topic: string) => ws.unsubscribe(topic),
            close: (code?: number, reason?: string) => ws.close(code, reason),
            pendingLive: data.pendingLive,
          })
          runtime.metrics.wsOpened()
          return
        }
        if (isCluster(ws.data as AppSocketData)) {
          runtime.cluster?.socket?.onOpen(ws as unknown as RaftSocket)
          return
        }
        if (isReplication(ws.data as AppSocketData)) {
          // C4b: with workers the router holds the connection and the shards hold the streams.
          if (replRouter) replRouter.open(ws as unknown as ReplicationSocket)
          else runtime.replication?.open(ws as unknown as ReplicationSocket)
          return
        }
        if (isHranaSocket(ws.data)) {
          hranaWsOpen(ws as never)
          return
        }
        if (isGraphQLSocket(ws.data)) {
          ws.data.bind(
            ws as unknown as { send(data: string): unknown; close(code?: number, reason?: string): void },
          )
          runtime.metrics.wsOpened()
          return
        }
        runtime.metrics.wsOpened()
        if (ws.data.principal) greet(ws, runtime.node)
      },
      message(ws: Socket, message: string | Buffer) {
        if (isRelay(ws.data) && pool) {
          runtime.metrics.wsMessage()
          void relayMessage(pool, ws.data, ws as unknown as { send(text: string): number }, message)
          return
        }
        if (isCluster(ws.data as AppSocketData)) {
          runtime.cluster?.socket?.onMessage(ws as unknown as RaftSocket, message as Uint8Array)
          return
        }
        if (isGraphQLSocket(ws.data)) {
          runtime.metrics.wsMessage()
          void ws.data.graphql
            .message(typeof message === "string" ? message : message.toString("utf8"))
            .catch((err: unknown) => runtime.report(err))
          return
        }
        if (isReplication(ws.data as AppSocketData)) {
          const bytes = message as Uint8Array
          if (replRouter) replRouter.message(ws as unknown as ReplicationSocket, bytes)
          else runtime.replication?.message(ws as unknown as ReplicationSocket, bytes)
          return
        }
        if (isHranaSocket(ws.data)) {
          hranaWsMessage(ws as never, message)
          return
        }
        void handleMessage(ws, message)
      },
      drain(ws: Socket) {
        if (isRelay(ws.data) && pool) {
          relayDrain(pool, ws.data, ws as unknown as { send(text: string): number })
          return
        }
        if (isCluster(ws.data as AppSocketData)) return
        if (isReplication(ws.data as AppSocketData)) {
          if (replRouter) replRouter.drain(ws as unknown as ReplicationSocket)
          else runtime.replication?.drain(ws as unknown as ReplicationSocket)
          return
        }
        if (isHranaSocket(ws.data)) return
        drain(ws)
      },
      close(ws: Socket) {
        if (isRelay(ws.data) && pool) {
          pool.closed(ws.data.routing, ws.data.id)
          pool.untrack(ws.data.id)
          runtime.metrics.wsClosed()
          return
        }
        if (isCluster(ws.data as AppSocketData)) {
          runtime.cluster?.socket?.onClose(ws as unknown as RaftSocket)
          return
        }
        if (isReplication(ws.data as AppSocketData)) {
          if (replRouter) replRouter.close(ws as unknown as ReplicationSocket)
          else runtime.replication?.close(ws as unknown as ReplicationSocket)
          return
        }
        if (isGraphQLSocket(ws.data)) {
          // Every subscription this socket opened, ended — the engine's subscriber count is where
          // a leak would show, and a client that vanished never sent `complete`.
          ws.data.graphql.close()
          ws.data.bind(null)
          runtime.metrics.wsClosed()
          return
        }
        if (isHranaSocket(ws.data)) {
          hranaWsClose(ws as never)
          return
        }
        closeSocket(ws)
      },
    } as unknown as Record<string, unknown>,
  }
}

/**
 * One operation as the `Handler` `wrap()` takes: core's validator around the route handler, with
 * the body left for `readJson` to ask for. `RouteContext` already carries everything `Invocation`
 * needs — the request, the matched params, the parsed URL — so it is passed as both.
 */
function asHandler(
  operation: Operation<unknown, unknown, RouteContext>,
  options: HttpOptions,
): Handler {
  const execute = executeOperation<RouteContext>(operation, { ...options, deferBody: true })
  const read = operation.body ? bodyReader(operation, options) : undefined
  return (ctx) => {
    if (read) {
      // Memoised: a handler that reads the body twice — `txQuery` does, on two branches — must
      // not find the stream already drained by the first read.
      let once: Promise<unknown> | undefined
      ctx.body = () => (once ??= read(ctx))
    }
    return execute(ctx, ctx)
  }
}

/**
 * A route that names a database, forwarded to the worker that owns it. The answer is the worker's
 * finished `Response` — it ran `wrap()` inside its own app — so this returns it untouched.
 */
function forwardByPath(runtime: ServerRuntime, pool: WorkerPool) {
  return async (request: Request): Promise<Response> => {
    // Bun's router has already matched `/v1/db/:db/…` and put the segment in `params`, so the
    // common case needs neither a `new URL` nor a split. It is ~10% of the router's per-request
    // cost on a read, which is the whole of what a sharded node's HTTP reads are capped by
    // (`docs/p4-router-hop.md`).
    const named = (request as Request & { params?: Record<string, string> }).params?.db
    const db = named ?? routingName(runtime.config, request, new URL(request.url))
    if (db === null || db === undefined) {
      return errorResponse(new BunQLError("BAD_REQUEST", "no database in the request", 400))
    }
    return pool.fetch(pool.shardOf(db), request)
  }
}

/** `POST /v1/db`, whose database is in the body: read it once here, route on it, pass the bytes. */
function forwardByBody(runtime: ServerRuntime, pool: WorkerPool) {
  return async (request: Request): Promise<Response> => {
    const { name, body } = await createDbTarget(request)
    return pool.fetch(pool.shardOf(name), request, body)
  }
}

/**
 * The libsql surface. Its database comes from the path, `x-namespace` or the `Host` label, which
 * is what `routingName` already applies — so one forwarder covers every Hrana route, and the ones
 * that name no database at all (`GET /v2`, `GET /v3`, the version probes) go to shard 0, where
 * they touch nothing.
 */
function forwardHrana(
  runtime: ServerRuntime,
  pool: WorkerPool,
  options: (request: Request) => Response,
): Record<string, unknown> {
  const forward = async (request: Request): Promise<Response> => {
    const named = (request as Request & { params?: Record<string, string> }).params?.db
    const db = named ?? routingName(runtime.config, request, new URL(request.url))
    return pool.fetch(db === null || db === undefined ? 0 : pool.shardOf(db), request)
  }
  const table: Record<string, unknown> = {}
  for (const [path, entry] of Object.entries(hranaRoutes(runtime))) {
    const methods: Record<string, unknown> = {}
    for (const method of Object.keys(entry as Record<string, unknown>)) {
      methods[method] = method === "OPTIONS" ? options : forward
    }
    table[path] = methods
  }
  // `/v1/db/:db/hrana` is a WebSocket upgrade, and an upgrade cannot be forwarded as a request:
  // `fetch` below answers it through `relayHranaUpgrade` instead, so the route is dropped here.
  delete table["/v1/db/:db/hrana"]
  return table
}

/** Merges one method into the table, refusing a collision rather than letting one silently win. */
function mountOperation(
  routes: Record<string, unknown>,
  operation: Operation<unknown, unknown, RouteContext>,
  handler: unknown,
): void {
  const method = operation.method.toUpperCase()
  const table = (routes[operation.path] ??= {}) as Record<string, unknown>
  if (table[method] !== undefined) {
    throw new Error(`operation "${operation.id}": ${method} ${operation.path} is already mounted`)
  }
  table[method] = handler
}

interface UpgradeHost {
  upgrade(
    request: Request,
    options: { data: AppSocketData; headers?: Record<string, string> },
  ): boolean
}

/**
 * The node-to-node handshake of design §8. A node with no cluster secret has no business being
 * replicated from, and says so plainly rather than opening a socket that will never authenticate.
 */
function upgradeReplication(
  runtime: ServerRuntime,
  replRouter: ReplicationRouter | null,
  request: Request,
  server: unknown,
): Response | undefined {
  if (!runtime.replication && !replRouter) {
    return errorResponse(
      new BunQLError(
        "REPLICATION_DISABLED",
        "this node has no cluster secret, so it does not replicate",
        403,
      ),
    )
  }
  const ok = (server as UpgradeHost).upgrade(request, { data: { replication: true } })
  if (ok) return undefined
  return new Response("expected a WebSocket upgrade", { status: 426 })
}

/**
 * H7: a socket speaking `graphql-transport-ws`, held while it is open.
 *
 * `bind` is a late binding: Bun does not hand back the `ServerWebSocket` until `open`, and the
 * protocol object has to exist before then so that a frame arriving in the same tick has somewhere
 * to go.
 */
interface GraphQLSocketData {
  graphql: GraphQLSocket
  bind(socket: { send(data: string): unknown; close(code?: number, reason?: string): void } | null): void
}

function isGraphQLSocket(data: unknown): data is GraphQLSocketData {
  return (data as GraphQLSocketData | null)?.graphql instanceof GraphQLSocket
}

/**
 * `GET /v1/db/{db}/{graphql path}` with the `graphql-transport-ws` subprotocol (H7,
 * `docs/h7-subscriptions.md` §4). Anything else on that path is the HTTP GraphQL route.
 *
 * The credential may come from the upgrade — a header, or `?token=`, which is what a browser has —
 * and `connection_init` may present one instead or as well. The principal is settled there, once,
 * and every operation on the socket runs as it.
 */
function isGraphQLUpgrade(runtime: ServerRuntime, request: Request, url: URL): boolean {
  if (request.method !== "GET") return false
  if (!request.headers.get("upgrade")?.toLowerCase().includes("websocket")) return false
  const wanted = request.headers.get("sec-websocket-protocol") ?? ""
  if (!wanted.split(",").some((one) => one.trim() === GRAPHQL_WS_PROTOCOL)) return false
  const parts = url.pathname.split("/").filter((one) => one.length > 0)
  return (
    parts[0] === "v1" &&
    parts[1] === "db" &&
    parts.length === 4 &&
    parts[3] === runtime.config.graphql.path
  )
}

async function upgradeGraphQL(
  runtime: ServerRuntime,
  surfaces: Surfaces,
  request: Request,
  server: unknown,
  url: URL,
): Promise<Response | undefined> {
  const parts = url.pathname.split("/").filter((one) => one.length > 0)
  let db = parts[2] as string
  try {
    db = decodeURIComponent(db)
  } catch {
    // A name that is not valid percent-encoding is passed through; the tenant lookup refuses it.
  }
  const token =
    request.headers.get("authorization")?.replace(/^[Bb]earer\s+/, "") ?? url.searchParams.get("token")
  let principal = null
  if (token) {
    try {
      principal = await runtime.auth.authenticateToken(token)
    } catch (err) {
      return errorResponse(err)
    }
  }
  // The socket object is not available until `upgrade` returns, so the sender is a late binding
  // over `ws`, which Bun hands back to `open`.
  let live: { send(data: string): unknown; close(code?: number, reason?: string): void } | null = null
  const graphql = surfaces.graphqlSocket(
    {
      send: (data: string) => live?.send(data),
      close: (code?: number, reason?: string) => live?.close(code, reason),
    },
    db,
    principal,
  )
  const data: GraphQLSocketData = {
    graphql,
    bind: (socket) => {
      live = socket
    },
  }
  const ok = (server as UpgradeHost).upgrade(request, {
    data,
    headers: { "sec-websocket-protocol": GRAPHQL_WS_PROTOCOL },
  })
  if (ok) return undefined
  return new Response("expected a WebSocket upgrade", { status: 426 })
}

/**
 * The raft socket of `docs/plan-phase2.md` C1, mounted here so the control plane shares this
 * node's listener rather than binding a second port. The secret is proved in-band, exactly as
 * `/v1/replication`'s is, so `Authorization` is not consulted here either.
 */
function upgradeCluster(
  runtime: ServerRuntime,
  request: Request,
  server: unknown,
): Response | undefined {
  const cluster = runtime.cluster
  if (!cluster) {
    return errorResponse(
      new BunQLError(
        "CLUSTER_DISABLED",
        "this node has no [cluster] section enabled, so it is not in a raft group",
        403,
      ),
    )
  }
  const handlers = cluster.socket
  if (!handlers) {
    // The transport is built by `start()`, and a worker never has one at all: the router owns the
    // listener, so an upgrade cannot reach a worker's runtime. Either way this says where the
    // control plane is instead of throwing a 500 at a peer (C4d §5).
    return errorResponse(
      new BunQLError(
        "CLUSTER_DISABLED",
        "this node's raft transport is not running, so it cannot accept a peer",
        503,
      ),
    )
  }
  const outcome = handlers.onUpgrade(request)
  if (outcome instanceof Response) return outcome
  const ok = (server as UpgradeHost).upgrade(request, { data: outcome.data })
  if (ok) return undefined
  return new Response("expected a WebSocket upgrade", { status: 426 })
}

/**
 * The WebSocket handshake. A browser cannot set headers on a socket, so the token may also come
 * in `?token=`; a socket that presents neither is accepted and must send `hello` before anything
 * else (design §7).
 */
async function upgrade(
  runtime: ServerRuntime,
  request: Request,
  server: unknown,
  url: URL,
): Promise<Response | undefined> {
  const token =
    request.headers.get("authorization")?.replace(/^[Bb]earer\s+/, "") ?? url.searchParams.get("token")
  let principal = null
  if (token) {
    try {
      principal = await runtime.auth.authenticateToken(token)
    } catch (err) {
      return errorResponse(err)
    }
  }
  const requested = request.headers.get("sec-websocket-protocol")
  const offered = requested
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p === WS_PROTOCOL)
  const ok = (server as UpgradeHost).upgrade(request, {
    data: newSocketData(runtime, principal),
    ...(offered ? { headers: { "sec-websocket-protocol": offered } } : {}),
  })
  if (ok) return undefined
  return new Response("expected a WebSocket upgrade", { status: 426 })
}

// ── starting ───────────────────────────────────────────────────────────────────────────────────

export interface StartOptions {
  /** Overrides applied on top of the file and before the environment. */
  overrides?: ServerConfigInput
  /** A registry to use instead of opening one; the tests share one across restarts. */
  registry?: TenantRegistry
  /**
   * A runtime to serve over instead of building one — this is how the embedded API mounts the
   * HTTP surface on the engine it already has. Two runtimes over one registry would each install
   * an `AuthorizerHub` on the same connection, which `runtime.ts` forbids. A runtime passed in is
   * the caller's to close; `handle.close()` leaves it open.
   */
  runtime?: ServerRuntime
  /** The admin key for a runtime passed in, so the handle can report it. */
  adminKey?: string | null
  onError?: (err: unknown) => void
  /** Where the first-start admin key notice goes. Defaults to `console.log`. */
  log?: (message: string) => void
  /** Called for every tenant the registry opens, when this call builds the runtime. */
  onTenantOpen?: (tenant: Tenant) => void
}

export interface RuntimeBundle {
  runtime: ServerRuntime
  adminKey: string | null
  /** True when this call had to generate the admin key, which is the only time it is printed. */
  adminKeyGenerated: boolean
  /** Where generated key material was written, or null when nothing was. */
  keysFile: string | null
}

/**
 * Resolves key material and builds the runtime — the registry, the authenticator and the metrics
 * — without listening on anything. `startServer` calls it; the embedded API calls it directly and
 * serves over the result later, or never.
 */
export async function createRuntime(
  config: ServerConfig,
  options: Pick<StartOptions, "registry" | "onError" | "onTenantOpen"> & {
    /** C4b: which half of `/v1/replication` this runtime holds. `ServerRuntime`'s own default. */
    replicationMode?: "own" | "none" | "hosted"
    /** C4d: which half of the control plane it holds. */
    clusterMode?: "own" | "routed" | "hosted"
    /** C4d: a worker's link to the router's control plane, for `clusterMode: "hosted"`. */
    clusterLink?: ClusterLink | null
    /** C4d: the shard this runtime is, when it is a worker. */
    shard?: { index: number; workers: number }
  } = {},
): Promise<RuntimeBundle> {
  const resolved = await resolveAuth(config)
  // The runtime opens the registry, and the catalog inside it is the revocation list, so the
  // authenticator reaches it through this indirection rather than through a second open.
  let catalog: Catalog | null = null
  const revocations: RevocationList = { isRevoked: (jti) => catalog?.isRevoked(jti) ?? false }
  const auth = new Authenticator({
    keys: resolved.keys,
    adminKey: resolved.adminKey,
    revocations,
    clockToleranceSec: config.auth.clockToleranceSec,
    verifyCacheSize: config.auth.verifyCacheSize,
  })
  const runtime = new ServerRuntime({
    config,
    auth,
    metrics: new Metrics(),
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onTenantOpen ? { onTenantOpen: options.onTenantOpen } : {}),
    ...(options.replicationMode ? { replicationMode: options.replicationMode } : {}),
    ...(options.clusterMode ? { clusterMode: options.clusterMode } : {}),
    ...(options.clusterLink ? { clusterLink: options.clusterLink } : {}),
    ...(options.shard ? { shard: options.shard } : {}),
  })
  catalog = runtime.registry.catalog
  return {
    runtime,
    adminKey: resolved.adminKey,
    adminKeyGenerated: resolved.adminKeyGenerated,
    keysFile: resolved.adminKeyGenerated || resolved.jwtKeyGenerated ? resolved.keysFile : null,
  }
}

export interface ServerHandle {
  server: Bun.Server<SocketData>
  runtime: ServerRuntime
  /** Worker threads serving this node's databases; 1 when it is the ordinary single-thread node. */
  workers: number
  registry: TenantRegistry
  config: ServerConfig
  url: string
  adminKey: string | null
  close(): Promise<void>
}

/** Opens the data directory, resolves key material and starts listening. */
export async function startServer(
  config: ServerConfig,
  options: StartOptions = {},
): Promise<ServerHandle> {
  const owned = options.runtime === undefined
  // `docs/c4-workers.md`: more than one worker turns this process into a router — it keeps the
  // listener, the sockets, the catalog and the authenticator, and owns no tenant. Resolved before
  // the runtime is built, because a router's runtime holds no `ReplicationServer` at all: with
  // C4b the streams live on the workers and `ReplicationRouter` holds the sockets instead.
  const workers = owned ? resolveWorkers(config.server.workers) : 1
  const resolved: RuntimeBundle = owned
    ? await createRuntime(config, {
        ...options,
        ...(workers > 1 ? ({ replicationMode: "none", clusterMode: "routed" } as const) : {}),
      })
    : {
        runtime: options.runtime as ServerRuntime,
        adminKey: options.adminKey ?? null,
        adminKeyGenerated: false,
        keysFile: null,
      }
  const runtime = resolved.runtime

  // The pool is started before the listener so a worker that cannot build its runtime fails
  // `startServer` rather than leaving a node that answers `DB_NOT_FOUND` for a shard.
  const onError = options.onError ?? ((err: unknown) => console.error("bunql:", err))
  const pool = workers > 1 ? await WorkerPool.start(config, onError) : null
  /** C4d's probe tick, or null on a node that is not both clustered and sharded. */
  let clusterProbe: ReturnType<typeof setInterval> | null = null
  // C4c: with workers, the one upstream connection is this thread's and every stream is a
  // worker's, so the client is built in `"routed"` mode over the pool. Set before
  // `startReplication` below, because which mode the client is in is decided at construction.
  if (pool && config.replication.secret) {
    // C3b: one host per upstream, because a node whose upstreams are chosen by placement holds a
    // client per upstream and each worker keeps a hosted client per upstream to match. The index
    // is what every `follow.*` envelope carries; a statically configured replica has one and it
    // is 0.
    const upstreams = new Map<string, number>()
    const indexOf = (url: string): number => {
      const known = upstreams.get(url)
      if (known !== undefined) return known
      const next = upstreams.size
      upstreams.set(url, next)
      return next
    }
    runtime.setShardHost((url: string) => new WorkerShards(pool, onError, indexOf(url)))
    // The workers report what is not a frame — an install, a divergence, a disposed copy, a
    // forwarded write, C2's detach — and each is a decision that upstream's `"routed"` client owns.
    runtime.setUpstreamHandler((url, client) => {
      pool.setFollowHost(indexOf(url), followHost(client, runtime, onError))
    })
  }
  // C4d: the control plane is this thread's, and every `Promoter` that talks to it is a worker's.
  // The link is the view pushed on every commit that changed it — plus the clock probe, because
  // each worker has its own `performance.timeOrigin` and a lease deadline is an instant on a
  // clock. `docs/c4d-cluster-workers.md` §3.1.
  const clusterShards = pool && runtime.cluster ? new ClusterShards(pool, runtime.cluster, onError) : null
  if (pool && clusterShards) {
    pool.setClusterHost(clusterShards)
    runtime.cluster?.onChange(() => clusterShards.push())
  }

  const app = pool ? await createApp(runtime, pool) : await createApp(runtime)
  // The route table and the socket handler are built dynamically, so they are handed to
  // `Bun.serve` opaquely and the socket data type is reasserted here.
  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.host,
    routes: app.routes as never,
    fetch: app.fetch as never,
    websocket: app.websocket as never,
    development: false,
  }) as unknown as Bun.Server<SocketData>
  if (pool) {
    // A worker has no subscribers; everything it publishes arrives here and goes out over Bun's
    // own pub/sub, which is the whole cross-worker change-feed story (`docs/c4-workers.md` §3).
    const publisher = busPublisher(server)
    pool.setHost({
      publish: (topic, data) => publisher.publish(topic, data),
      // C4d: the router's own view of which databases it authors is a read of the catalog, and a
      // worker's promotion rewrote a row in it without passing through this thread's `onChange`.
      roleChanged: () => runtime.promoter.refresh(),
    })
    // C4e: `GET /v1/db` is answered here, and the tenants are not here. One gather on an admin
    // listing route, never on a data path.
    runtime.setOpenStates(() => pool.openDatabases())
  }
  runtime.setPublisher(busPublisher(server))
  // Design §5.3's `moved`: a promotion or a fencing tells every socket that has named the database
  // where it went, instead of leaving it writing to a node that is no longer the primary for it.
  runtime.setMovedHandler(movedPublisher(server as unknown as { publish(topic: string, data: string): unknown }))
  // A replica starts following only once it is listening: its own `/v1/replication` may be the
  // upstream of a third node, and a chain that opens sockets before it can answer them is racy.
  if (owned) await runtime.startCluster()
  if (clusterShards) {
    // Probes before the first view, so an offset is measured rather than guessed; a deadline that
    // arrives first waits on the worker rather than being converted against nothing.
    for (let i = 0; i < PROBES_AT_START; i++) clusterShards.probe()
    clusterShards.push()
    // The offset does not drift — both origins are fixed at thread start and both clocks are the
    // same OS monotonic clock — but the bound tightens, and this tick already exists.
    clusterProbe = setInterval(() => clusterShards.probe(), config.cluster.leaseRenewMs)
    clusterProbe.unref?.()
  }
  if (owned) runtime.startReplication()
  // Shipping starts with the listener for the same reason replication does: a snapshot taken from
  // a drain can be served over `/v1/db/:db/dump`, and a node that ships before it can answer is
  // a node whose backup and whose API disagree about what exists.
  if (owned) runtime.startStorage()

  const log = options.log ?? ((message: string) => console.log(message))
  if (resolved.adminKeyGenerated) {
    log(
      `bunql: generated an admin key and wrote it to ${resolved.keysFile}\n` +
        `bunql: admin key: ${resolved.adminKey}`,
    )
  }

  const url = `http://${displayHost(config.server.host)}:${server.port}`
  return {
    server,
    runtime,
    workers: pool ? pool.size : 1,
    registry: runtime.registry,
    config,
    url,
    adminKey: resolved.adminKey,
    async close(): Promise<void> {
      runtime.setPublisher(null)
      runtime.setMovedHandler(null)
      runtime.setOpenStates(null)
      runtime.setUpstreamHandler(null)
      // Every replica socket is closed before the workers go, so a stream is ended by a `1001` the
      // replica reconnects from rather than by a channel that stops answering under it.
      app.replication?.stop()
      // C4c, for the same reason in the other direction: the upstream connection is ended here,
      // while the workers its streams live on are still there to be told.
      if (pool) runtime.replica?.stop()
      await server.stop(true)
      if (clusterProbe !== null) clearInterval(clusterProbe)
      if (pool) {
        pool.setHost(null)
        pool.setReplicationHost(null)
        pool.clearFollowHosts()
        pool.setClusterHost(null)
        await pool.close()
      }
      // Everything committed before the listener stopped belongs in the bucket, so the shippers
      // are drained before the runtime — and before the registry closes the logs they read from.
      app.surfaces.close()
      if (owned) await runtime.closeStorage()
      // A runtime that was passed in belongs to its owner — the embedded API keeps serving from it
      // after `serve()` is stopped, and closing it here would take the engine with the listener.
      if (owned) runtime.close()
    },
  }
}

function displayHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host
}

export { loadConfig }
