// Invariant: this module is the only thing `app.ts` needs to know about Hrana, and it owns no
// state of its own — the service behind it is keyed by `ServerRuntime` (see `./service.ts`), so
// the route table and the socket upgrade compose into one surface without the app holding
// anything on their behalf.
//
// Wiring, in full. In `createApp`, after the native route table is built:
//
//     Object.assign(routes, hranaRoutes(runtime))
//
// in `fetch`, before the 404:
//
//     if (isHranaUpgrade(request, url)) return hranaUpgrade(runtime, request, server, url)
//
// and in each of the four `websocket` handlers, beside the existing replication branch:
//
//     if (isHranaSocket(ws.data)) { hranaWsOpen(ws as never); return }      // open
//     if (isHranaSocket(ws.data)) { hranaWsMessage(ws as never, message); return }  // message
//     if (isHranaSocket(ws.data)) { hranaWsClose(ws as never); return }     // close
//     if (isHranaSocket(ws.data)) return                                    // drain: nothing to do
//
// Second invariant: these routes carry their own common headers. `app.ts`'s `wrap` is private to
// it and takes a `RouteContext`, so the CORS and `BunQL-*` headers are applied here instead —
// which is also why a browser using `@libsql/client/web` works against this surface.

import { HEADERS } from "../../client/protocol.ts"
import type { ServerRuntime } from "../runtime.ts"
import { handleCursor, handlePipeline, handleVersion, namespaceOf } from "./http.ts"
import { hranaErrorResponse } from "./errors.ts"
import { WS_SUBPROTOCOLS, type WsSubprotocol } from "./proto.ts"
import { closeHranaService, hranaService } from "./service.ts"
import {
  hranaWsClose,
  hranaWsMessage,
  hranaWsOpen,
  isHranaSocket,
  newHranaSocketData,
  type HranaSocketData,
} from "./ws.ts"

type RouteRequest = Request & { params?: Record<string, string> }

interface UpgradeHost {
  upgrade(
    request: Request,
    options: { data: HranaSocketData; headers?: Record<string, string> },
  ): boolean
}

const CORS_EXPOSED = [HEADERS.node, HEADERS.role, HEADERS.txid, HEADERS.durationUs].join(", ")

function applyCommon(runtime: ServerRuntime, request: Request, response: Response): Response {
  const headers = response.headers
  headers.set(HEADERS.node, runtime.node)
  headers.set(HEADERS.role, runtime.role)
  if (runtime.config.server.cors) {
    const origin = request.headers.get("origin")
    headers.set("access-control-allow-origin", origin ?? "*")
    if (origin) {
      headers.set("vary", "Origin")
      headers.set("access-control-allow-credentials", "true")
    }
    headers.set("access-control-expose-headers", CORS_EXPOSED)
  }
  return response
}

function preflight(runtime: ServerRuntime, request: Request): Response {
  const response = new Response(null, { status: 204 })
  response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS")
  response.headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") ??
      "authorization, content-type, accept, x-namespace",
  )
  response.headers.set("access-control-max-age", "86400")
  return applyCommon(runtime, request, response)
}

type Answer = (request: RouteRequest) => Promise<Response> | Response

function on(runtime: ServerRuntime, answer: Answer) {
  return async (request: RouteRequest): Promise<Response> => {
    try {
      return applyCommon(runtime, request, await answer(request))
    } catch (err) {
      runtime.report(err)
      return applyCommon(runtime, request, hranaErrorResponse(err))
    }
  }
}

/**
 * The Hrana route table, to be merged into the app's. Mounted twice: at the root, where the
 * database comes from `x-namespace` or the first `Host` label, and under `/v1/db/:db/…`.
 *
 * `@libsql/client` resolves its pipeline path *relatively* (`new URL("v2/pipeline", base)`), so
 * the path mount needs a base URL that ends in a slash — `libsql://host/v1/db/acme/`. Root
 * addressing needs nothing.
 */
export function hranaRoutes(runtime: ServerRuntime): Record<string, unknown> {
  const options = (request: Request): Response => preflight(runtime, request)
  const pipeline = on(runtime, (request) =>
    handlePipeline(runtime, request, new URL(request.url), request.params ?? {}),
  )
  const cursor = on(runtime, (request) =>
    handleCursor(runtime, request, new URL(request.url), request.params ?? {}),
  )
  const v2 = on(runtime, () => handleVersion(2))
  const v3 = on(runtime, () => handleVersion(3))
  const upgrade = (request: RouteRequest, server: unknown): Response | undefined =>
    hranaUpgrade(runtime, request, server, new URL(request.url))

  return {
    "/v2": { GET: v2, OPTIONS: options },
    "/v2/pipeline": { POST: pipeline, OPTIONS: options },
    "/v3": { GET: v3, OPTIONS: options },
    "/v3/pipeline": { POST: pipeline, OPTIONS: options },
    "/v3/cursor": { POST: cursor, OPTIONS: options },
    "/v1/db/:db/v2": { GET: v2, OPTIONS: options },
    "/v1/db/:db/v2/pipeline": { POST: pipeline, OPTIONS: options },
    "/v1/db/:db/v3": { GET: v3, OPTIONS: options },
    "/v1/db/:db/v3/pipeline": { POST: pipeline, OPTIONS: options },
    "/v1/db/:db/v3/cursor": { POST: cursor, OPTIONS: options },
    // The per-database socket needs its own path: `/v1/db/:db` is already the stats route, and
    // Bun's route table matches before `fetch` ever sees the request.
    "/v1/db/:db/hrana": { GET: upgrade, OPTIONS: options },
  }
}

/** True for a WebSocket upgrade that offers a subprotocol we speak. */
export function isHranaUpgrade(request: Request, _url: URL): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return false
  return offeredSubprotocol(request) !== null
}

function offeredSubprotocol(request: Request): WsSubprotocol | null {
  const offered = request.headers.get("sec-websocket-protocol")
  if (!offered) return null
  const wanted = offered.split(",").map((p) => p.trim())
  // Our preference order, not the client's: `hrana3-protobuf` comes first in what the client
  // offers and is the one thing here that is not implemented.
  for (const candidate of WS_SUBPROTOCOLS) {
    if (wanted.includes(candidate)) return candidate
  }
  return null
}

/** `/v1/db/<name>/hrana` or `/v1/db/<name>`, for a socket that arrived on the path mount. */
function dbFromPath(pathname: string): string | null {
  const match = /^\/v1\/db\/([^/]+)(?:\/hrana)?\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1] as string) : null
}

/**
 * The `hrana3`/`hrana2` handshake. Returns `undefined` once the socket has been upgraded (Bun's
 * contract for `fetch`) and a `Response` when it could not be. A token on the upgrade request is
 * accepted so a non-browser client need not repeat it, but `hello` is what normally carries it.
 */
export function hranaUpgrade(
  runtime: ServerRuntime,
  request: Request,
  server: unknown,
  url: URL,
): Response | undefined {
  const subprotocol = offeredSubprotocol(request)
  if (!subprotocol) return new Response("expected a hrana WebSocket subprotocol", { status: 426 })
  const db =
    dbFromPath(url.pathname) ??
    namespaceOf(request, url, (request as RouteRequest).params ?? {})
  const data = newHranaSocketData({ runtime, subprotocol, db, principal: null })
  const ok = (server as UpgradeHost).upgrade(request, {
    data,
    headers: { "sec-websocket-protocol": subprotocol },
  })
  if (ok) return undefined
  return new Response("expected a WebSocket upgrade", { status: 426 })
}

export {
  closeHranaService,
  hranaService,
  hranaWsClose,
  hranaWsMessage,
  hranaWsOpen,
  isHranaSocket,
  namespaceOf,
}
export type { HranaSocketData }
export * from "./proto.ts"
