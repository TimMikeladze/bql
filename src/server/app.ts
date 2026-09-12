// Invariant: every response leaves through one wrapper, so the four `BunQL-*` headers of design
// §6, the CORS headers, the error mapping of §6.6 and the metrics tick are applied in exactly one
// place. A handler that forgets them cannot exist.
//
// Routing is `Bun.serve`'s own `routes` table rather than a hand-written matcher: it matches
// before the `fetch` fallback runs, which is what keeps the query path free of URL parsing.

import { HEADERS, WS_PROTOCOL } from "../client/protocol.ts"
import { RAFT_PATH, type RaftSocket, type RaftSocketData } from "../cluster/index.ts"
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
import { serverRegistry } from "./registry.ts"
import type { Handler, RouteContext } from "./routes.ts"
import { ServerRuntime } from "./runtime.ts"
import { Surfaces } from "./surfaces.ts"
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

type AppSocketData = SocketData | ReplicationSocketData | RaftSocketData

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
}

/**
 * The route table of design §6, built from `src/server/registry.ts` — the one list of operations
 * that `GET /v1/openapi.json` is also emitted from, so the table and the document cannot drift
 * (`docs/h6-mount.md`).
 *
 * Each operation is mounted behind `wrap()`, not behind `src/http/`'s compiled pipeline, and the
 * reason is in `registry.ts`'s header: `wrap` has to see the error code a handler refused with,
 * to answer C2's same-origin `307`, and the compiled pipeline turns that error into a `Response`
 * before anything else can look at it. The generated data API *is* compiled — it needs the
 * coercion and it gets no `307` — and that happens inside `src/server/surfaces.ts`.
 *
 * Methods stay spelled out per path so an unsupported verb answers 405 from Bun rather than
 * falling through to the 404 handler.
 *
 * Async because whether GraphQL is mounted at all depends on two optional peer packages
 * resolving, which is an `import()`. It is resolved once here, never per request.
 */
export async function createApp(runtime: ServerRuntime): Promise<App> {
  const options = (request: Request) => preflight(runtime.config, request)
  const surfaces = new Surfaces(runtime)
  const registry = serverRegistry(surfaces, {
    api: runtime.config.api.enabled,
    graphql: await Surfaces.graphqlEnabled(runtime),
  })

  const routes: Record<string, unknown> = {}
  for (const operation of registry.operations()) {
    mountOperation(routes, operation, wrap(runtime, asHandler(operation)))
  }
  // One preflight per path the registry claims, exactly as the hand-written table wrote by hand.
  for (const entry of Object.values(routes)) {
    ;(entry as Record<string, unknown>).OPTIONS = options
  }

  Object.assign(routes, hranaRoutes(runtime))

  return {
    routes,
    surfaces,
    fetch(request: Request, server: unknown) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/ws") return upgrade(runtime, request, server, url)
      // Node-to-node, on its own path and with its own handshake: the cluster secret is proved
      // in-band over the socket (design §8), so nothing here looks at `Authorization`.
      if (url.pathname === "/v1/replication") return upgradeReplication(runtime, request, server)
      // The control plane's own socket, authenticated the same way with the same secret (C1).
      if (url.pathname === RAFT_PATH) return upgradeCluster(runtime, request, server)
      if (isHranaUpgrade(request, url)) return hranaUpgrade(runtime, request, server, url)
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
        if (isCluster(ws.data as AppSocketData)) {
          runtime.cluster?.socket.onOpen(ws as unknown as RaftSocket)
          return
        }
        if (isReplication(ws.data as AppSocketData)) {
          runtime.replication?.open(ws as unknown as ReplicationSocket)
          return
        }
        if (isHranaSocket(ws.data)) {
          hranaWsOpen(ws as never)
          return
        }
        runtime.metrics.wsOpened()
        if (ws.data.principal) greet(ws, runtime.node)
      },
      message(ws: Socket, message: string | Buffer) {
        if (isCluster(ws.data as AppSocketData)) {
          runtime.cluster?.socket.onMessage(ws as unknown as RaftSocket, message as Uint8Array)
          return
        }
        if (isReplication(ws.data as AppSocketData)) {
          runtime.replication?.message(ws as unknown as ReplicationSocket, message as Uint8Array)
          return
        }
        if (isHranaSocket(ws.data)) {
          hranaWsMessage(ws as never, message)
          return
        }
        void handleMessage(ws, message)
      },
      drain(ws: Socket) {
        if (isCluster(ws.data as AppSocketData)) return
        if (isReplication(ws.data as AppSocketData)) {
          runtime.replication?.drain(ws as unknown as ReplicationSocket)
          return
        }
        if (isHranaSocket(ws.data)) return
        drain(ws)
      },
      close(ws: Socket) {
        if (isCluster(ws.data as AppSocketData)) {
          runtime.cluster?.socket.onClose(ws as unknown as RaftSocket)
          return
        }
        if (isReplication(ws.data as AppSocketData)) {
          runtime.replication?.close(ws as unknown as ReplicationSocket)
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

/** An operation's handler as the `Handler` `wrap()` takes. The input is unused: see `registry.ts`. */
function asHandler(operation: Operation<unknown, unknown, RouteContext>): Handler {
  return (ctx) => operation.handler(undefined, ctx) as Response | Promise<Response>
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
  request: Request,
  server: unknown,
): Response | undefined {
  if (!runtime.replication) {
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
  const outcome = cluster.socket.onUpgrade(request)
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
  options: Pick<StartOptions, "registry" | "onError" | "onTenantOpen"> = {},
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
  const resolved: RuntimeBundle = owned
    ? await createRuntime(config, options)
    : {
        runtime: options.runtime as ServerRuntime,
        adminKey: options.adminKey ?? null,
        adminKeyGenerated: false,
        keysFile: null,
      }
  const runtime = resolved.runtime

  const app = await createApp(runtime)
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
  runtime.setPublisher(busPublisher(server))
  // Design §5.3's `moved`: a promotion or a fencing tells every socket that has named the database
  // where it went, instead of leaving it writing to a node that is no longer the primary for it.
  runtime.setMovedHandler(movedPublisher(server as unknown as { publish(topic: string, data: string): unknown }))
  // A replica starts following only once it is listening: its own `/v1/replication` may be the
  // upstream of a third node, and a chain that opens sockets before it can answer them is racy.
  if (owned) await runtime.startCluster()
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
    registry: runtime.registry,
    config,
    url,
    adminKey: resolved.adminKey,
    async close(): Promise<void> {
      runtime.setPublisher(null)
      runtime.setMovedHandler(null)
      await server.stop(true)
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
