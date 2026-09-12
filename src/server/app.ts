// Invariant: every response leaves through one wrapper, so the four `BunQL-*` headers of design
// §6, the CORS headers, the error mapping of §6.6 and the metrics tick are applied in exactly one
// place. A handler that forgets them cannot exist.
//
// Routing is `Bun.serve`'s own `routes` table rather than a hand-written matcher: it matches
// before the `fetch` fallback runs, which is what keeps the query path free of URL parsing.

import { HEADERS, WS_PROTOCOL } from "../client/protocol.ts"
import { Catalog, type Tenant, TenantRegistry } from "../tenant/index.ts"
import { Authenticator, type RevocationList } from "./auth.ts"
import { loadConfig, resolveAuth, type ServerConfig, type ServerConfigInput } from "./config.ts"
import { errorResponse } from "./errors.ts"
import { failedIndexOf } from "./exec.ts"
import { Metrics } from "./metrics.ts"
import * as handlers from "./routes.ts"
import type { Handler, RouteContext } from "./routes.ts"
import { ServerRuntime } from "./runtime.ts"
import {
  busPublisher,
  closeSocket,
  drain,
  greet,
  handleMessage,
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
    try {
      response = await handler(ctx)
    } catch (err) {
      response = errorResponse(err, {
        ...(ctx.txid !== undefined ? { txid: ctx.txid } : {}),
        ...(failedIndexOf(err) !== undefined ? { failedIndex: failedIndexOf(err) } : {}),
      })
      // A 500 is a bug in this server, and the client is told nothing about it, so it has to be
      // reported here or it is lost.
      if (response.status >= 500) runtime.report(err)
    }
    const durationUs = Math.round((Bun.nanoseconds() - startedNs) / 1000)
    const headers = response.headers
    headers.set(HEADERS.node, runtime.node)
    headers.set(HEADERS.role, "primary")
    headers.set(HEADERS.durationUs, String(durationUs))
    if (!headers.has(HEADERS.txid) && ctx.txid !== undefined) {
      headers.set(HEADERS.txid, String(ctx.txid))
    }
    applyCors(runtime.config, request, headers)
    runtime.metrics.request(response.status, durationUs)
    return response
  }
}

export interface App {
  routes: Record<string, unknown>
  fetch: (
    request: Request,
    server: unknown,
  ) => Response | Promise<Response | undefined> | undefined
  websocket: Record<string, unknown>
}

/**
 * The route table of design §6. Methods are spelled out per path so an unsupported verb answers
 * 405 from Bun rather than falling through to the 404 handler.
 */
export function createApp(runtime: ServerRuntime): App {
  const on = (handler: Handler) => wrap(runtime, handler)
  const options = (request: Request) => preflight(runtime.config, request)

  const routes: Record<string, unknown> = {
    "/v1/db/:db/query": { POST: on(handlers.query), OPTIONS: options },
    "/v1/db/:db/batch": { POST: on(handlers.batch), OPTIONS: options },
    "/v1/db/:db/tx": { POST: on(handlers.txBegin), OPTIONS: options },
    "/v1/db/:db/tx/:tx": { POST: on(handlers.txQuery), OPTIONS: options },
    "/v1/db/:db/tx/:tx/commit": { POST: on(handlers.txCommit), OPTIONS: options },
    "/v1/db/:db/tx/:tx/rollback": { POST: on(handlers.txRollback), OPTIONS: options },
    "/v1/db/:db/changes": { GET: on(handlers.changes), OPTIONS: options },
    "/v1/db/:db/live": { GET: on(handlers.live), OPTIONS: options },
    "/v1/db/:db/snapshot": { POST: on(handlers.snapshotDb), OPTIONS: options },
    "/v1/db/:db/restore": { POST: on(handlers.restoreDb), OPTIONS: options },
    "/v1/db/:db/dump": { GET: on(handlers.dumpDb), OPTIONS: options },
    "/v1/db/:db/import": { POST: on(handlers.importDb), OPTIONS: options },
    "/v1/db/:db/checkpoint": { POST: on(handlers.checkpointDb), OPTIONS: options },
    "/v1/db/:db/replication": { GET: on(handlers.replication), OPTIONS: options },
    "/v1/db/:db": {
      GET: on(handlers.statDb),
      DELETE: on(handlers.deleteDb),
      OPTIONS: options,
    },
    "/v1/db": { GET: on(handlers.listDbs), POST: on(handlers.createDb), OPTIONS: options },
    "/v1/tokens": { POST: on(handlers.mintToken), OPTIONS: options },
    "/v1/tokens/:jti": { DELETE: on(handlers.revokeToken), OPTIONS: options },
    "/healthz": { GET: on(handlers.healthz), OPTIONS: options },
    "/readyz": { GET: on(handlers.readyz), OPTIONS: options },
    "/metrics": { GET: on(handlers.metrics), OPTIONS: options },
  }

  return {
    routes,
    fetch(request: Request, server: unknown) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/ws") return upgrade(runtime, request, server, url)
      if (request.method === "OPTIONS") return preflight(runtime.config, request)
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" })
      applyCors(runtime.config, request, headers)
      headers.set(HEADERS.node, runtime.node)
      headers.set(HEADERS.role, "primary")
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
        runtime.metrics.wsOpened()
        if (ws.data.principal) greet(ws, runtime.node)
      },
      message(ws: Socket, message: string | Buffer) {
        void handleMessage(ws, message)
      },
      drain(ws: Socket) {
        drain(ws)
      },
      close(ws: Socket) {
        closeSocket(ws)
      },
    } as unknown as Record<string, unknown>,
  }
}

interface UpgradeHost {
  upgrade(
    request: Request,
    options: { data: SocketData; headers?: Record<string, string> },
  ): boolean
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

  const app = createApp(runtime)
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
      await server.stop(true)
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
