// A worker thread: a whole `ServerRuntime` over a shard of the node's databases, with no listener.
// `docs/c4-workers.md` §3.
//
// Invariant: a worker never opens a database this shard does not own. The router computes the
// shard and routes there, and this file asserts it again on arrival — a routing bug must surface
// as a refusal, not as a second writer on a file another thread already holds open. That is the
// one failure this whole design has to make impossible.
//
// Second invariant: nothing here re-implements a route. The worker builds the same `createApp`
// every single-threaded node builds, and this file only matches a path to a handler and turns the
// `Response` back into messages. `wrap()` has already run inside that app, so the `BunQL-*`
// headers, the CORS headers, the metrics tick and C2's `307` are the worker's and the router
// forwards them untouched.
//
// Third invariant: a socket that lives on the router is represented here by a *virtual* socket
// with the same interface `src/server/ws.ts` declares. `handleMessage`, `closeSocket` and `drain`
// run against it unchanged; `send`, `subscribe`, `unsubscribe` and `close` post back.

import { HEADERS } from "../../client/protocol.ts"
import { createApp, createRuntime, type App } from "../app.ts"
import type { ServerConfig } from "../config.ts"
import { BunQLError, errorResponse } from "../errors.ts"
import type { ServerRuntime } from "../runtime.ts"
import {
  closeSocket as closeWsSocket,
  drain as drainWs,
  handleMessage,
  newSocketData,
  type Socket,
  type SocketData,
} from "../ws.ts"
import {
  hranaWsClose,
  hranaWsMessage,
  hranaWsOpen,
  newHranaSocketData,
  type HranaSocketData,
} from "../hrana/index.ts"
import { bindingsOf, headerPairs, type FromWorker, type ToWorker } from "./protocol.ts"
import { shardOf } from "./shard.ts"

/** Above this, a response is streamed rather than copied whole into one message. */
const STREAM_ABOVE_BYTES = 1 << 20

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(value: unknown): void
}

function post(message: FromWorker): void {
  self.postMessage(message)
}

/** A Bun route handler, as `createApp` leaves them in the table. */
type BunHandler = (
  request: Request & { params?: Record<string, string> },
  server: unknown,
) => Response | Promise<Response>

/** One pattern from the route table, precompiled. */
interface Route {
  segments: string[]
  /** A trailing `*`, as the generated data API is mounted. */
  wildcard: boolean
  /** Static segments, so the most specific pattern wins when several match. */
  statics: number
  methods: Record<string, BunHandler>
}

interface WorkerState {
  index: number
  workers: number
  runtime: ServerRuntime
  app: App
  routes: Route[]
  /**
   * Virtual sockets, by the id the router minted. `ready` is the credential still being verified:
   * the router sends `ws.hello` and the first frame back to back, so a socket has to exist the
   * moment it is announced and its frames have to wait for the principal rather than be dropped.
   * Registering on one already-settled promise keeps them in arrival order.
   */
  sockets: Map<string, { socket: VirtualSocket; ready: Promise<void> }>
  /** In-flight hopped requests, so the router cancelling one aborts the handler's own signal. */
  inflight: Map<number, AbortController>
}

let state: WorkerState | null = null

// ── the route table ────────────────────────────────────────────────────────────────────────────

function compile(routes: Record<string, unknown>): Route[] {
  const out: Route[] = []
  for (const [pattern, table] of Object.entries(routes)) {
    const raw = pattern.split("/").filter((part) => part.length > 0)
    const wildcard = raw[raw.length - 1] === "*"
    const segments = wildcard ? raw.slice(0, -1) : raw
    out.push({
      segments,
      wildcard,
      statics: segments.filter((one) => !one.startsWith(":")).length,
      methods: table as Record<string, BunHandler>,
    })
  }
  // Most static segments first, so `/v1/db/:db/backup/verify` is preferred over a pattern that
  // would also match it, and a wildcard is only reached when nothing exact did.
  return out.sort((a, b) => b.statics - a.statics || Number(a.wildcard) - Number(b.wildcard))
}

interface Match {
  handler: BunHandler
  params: Record<string, string>
}

function match(routes: Route[], method: string, pathname: string): Match | null {
  const parts = pathname.split("/").filter((part) => part.length > 0)
  for (const route of routes) {
    if (route.wildcard ? parts.length < route.segments.length : parts.length !== route.segments.length) {
      continue
    }
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < route.segments.length; i++) {
      const pattern = route.segments[i] as string
      const part = parts[i] as string
      if (pattern.startsWith(":")) {
        params[pattern.slice(1)] = decode(part)
        continue
      }
      if (pattern !== part) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const handler = route.methods[method]
    if (!handler) continue
    return { handler, params }
  }
  return null
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// ── the virtual socket ─────────────────────────────────────────────────────────────────────────

/**
 * A socket the router holds, as `src/server/ws.ts` and `src/server/hrana/ws.ts` see it. `send`
 * returns 1 unconditionally: backpressure is the router's to observe, because the router is the
 * only thread that can see the real socket's buffer, and it applies design §7's "keep the latest,
 * drop the rest" rule for live results there instead.
 */
class VirtualSocket {
  readyState = 1
  data: SocketData | HranaSocketData

  constructor(
    readonly id: string,
    data: SocketData | HranaSocketData,
  ) {
    this.data = data
  }

  send(text: string): number {
    const bind = bindingsOf(text)
    post({ kind: "ws.send", socket: this.id, text, ...(bind ? { bind } : {}) })
    return 1
  }

  subscribe(topic: string): void {
    post({ kind: "ws.subscribe", socket: this.id, topic })
  }

  unsubscribe(topic: string): void {
    post({ kind: "ws.unsubscribe", socket: this.id, topic })
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    post({
      kind: "ws.shut",
      socket: this.id,
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })
  }
}

function isHranaData(data: SocketData | HranaSocketData): data is HranaSocketData {
  return (data as HranaSocketData).hrana === true
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────

async function start(index: number, workers: number, config: ServerConfig): Promise<void> {
  const { runtime } = await createRuntime(config)
  const app = await createApp(runtime)
  // A worker has no subscribers of its own: everything it publishes goes to the router, which owns
  // every socket and fans out over Bun's pub/sub. `docs/c4-workers.md` §3.
  runtime.setPublisher({
    publish(topic: string, data: string): unknown {
      post({ kind: "publish", topic, data })
      return 0
    },
  })
  runtime.setMovedHandler((db, primary) => post({ kind: "moved", db, primary }))
  // Shipping, retention and snapshots are per database and belong to the thread that owns it.
  // Replication and the cluster are refused by `loadConfig` when `workers > 1`, so they are not
  // started here at all rather than started into a no-op.
  runtime.startStorage()
  state = {
    index,
    workers,
    runtime,
    app,
    routes: compile(app.routes),
    sockets: new Map(),
    inflight: new Map(),
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────────

/** The stub `RouteContext.server`: only `timeout` is ever called, and only by an SSE stream. */
const NO_TIMEOUT = { timeout(): void {} }

async function serve(
  current: WorkerState,
  id: number,
  method: string,
  url: string,
  headers: [string, string][],
  body: Uint8Array | null,
): Promise<void> {
  const abort = new AbortController()
  current.inflight.set(id, abort)
  try {
    const parsed = new URL(url)
    assertOwned(current, parsed, headers)
    const request = new Request(url, {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: abort.signal,
    }) as Request & { params?: Record<string, string> }
    const found = match(current.routes, method.toUpperCase(), parsed.pathname)
    const response = found
      ? await runHandler(found, request)
      : notFound(current, parsed.pathname)
    await deliver(current, id, response)
  } catch (err) {
    await deliver(current, id, errorResponse(err))
  } finally {
    current.inflight.delete(id)
  }
}

/**
 * `app.routes` holds Bun route handlers — `(request, server)` — not our `Handler`, because
 * `createApp` has already wrapped each operation. So the params go on the request, exactly as Bun
 * puts them there, and the `server` argument is the stub below: the only thing a handler asks of
 * it is `timeout`, and the socket an SSE stream would be held open on lives on the router.
 */
async function runHandler(
  found: Match,
  request: Request & { params?: Record<string, string> },
): Promise<Response> {
  request.params = found.params
  return (await found.handler(request, NO_TIMEOUT)) as Response
}

function notFound(current: WorkerState, pathname: string): Response {
  return errorResponse(new BunQLError("BAD_REQUEST", `no route for ${pathname}`, 404), {}, {
    [HEADERS.node]: current.runtime.node,
  })
}

/**
 * The safety net. The router already chose this worker from the database name; if the name in the
 * path does not hash here, something has gone wrong on the other side and the request must be
 * refused rather than served by opening a file another thread owns.
 */
function assertOwned(current: WorkerState, url: URL, headers: [string, string][]): void {
  const db = databaseOf(url, headers)
  if (db === null) return
  const owner = shardOf(db, current.workers)
  if (owner === current.index) return
  throw new BunQLError(
    "INTERNAL",
    `database ${JSON.stringify(db)} belongs to worker ${owner}, not ${current.index}`,
    500,
  )
}

/**
 * The database a path names, by exactly the rule the router uses — `/v1/db/{db}/…`, and nothing
 * else. A request that names none (`GET /v1/db`, `/healthz`) is answered on the router and never
 * arrives here; one that arrives anyway is served without an ownership check, which is correct
 * because it touches no tenant.
 */
export function databaseOf(url: URL, headers: [string, string][]): string | null {
  const parts = url.pathname.split("/").filter((one) => one.length > 0)
  if (parts[0] === "v1" && parts[1] === "db" && parts.length >= 3) return decode(parts[2] as string)
  for (const [key, value] of headers) {
    if (key.toLowerCase() === "x-namespace" && value) return value
  }
  return null
}

/**
 * Sends a response back. Small ones cross whole; a Server-Sent Events stream and anything over a
 * megabyte cross as `open` + `chunk`* + `end`, so a database dump does not have to exist twice in
 * memory before it can be answered.
 */
async function deliver(current: WorkerState, id: number, response: Response): Promise<void> {
  const headers = headerPairs(response.headers)
  const type = response.headers.get("content-type") ?? ""
  const declared = Number(response.headers.get("content-length") ?? "-1")
  const streamed = type.startsWith("text/event-stream") || declared > STREAM_ABOVE_BYTES
  if (!streamed) {
    const body = response.body ? new Uint8Array(await response.arrayBuffer()) : null
    post({ kind: "http.reply", id, status: response.status, headers, body })
    return
  }
  post({ kind: "http.open", id, status: response.status, headers })
  const reader = response.body?.getReader()
  if (!reader) {
    post({ kind: "http.end", id })
    return
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) post({ kind: "http.chunk", id, bytes: value })
    }
    post({ kind: "http.end", id })
  } catch (err) {
    post({ kind: "http.end", id, error: String(err) })
  }
}

// ── WebSocket relay ────────────────────────────────────────────────────────────────────────────

function adopt(
  current: WorkerState,
  id: string,
  token: string | null,
  hrana: { db: string; version: number } | null,
): void {
  // A token the router accepted may still be refused here — it could have been revoked in the
  // moment between — and a socket with no principal is exactly what `ws.ts` answers 401 for.
  const verify = token
    ? current.runtime.auth.authenticateToken(token).catch(() => null)
    : Promise.resolve(null)
  const existing = current.sockets.get(id)
  if (existing) {
    existing.ready = verify.then((principal) => {
      existing.socket.data.principal = principal
    })
    return
  }
  const data = hrana
    ? newHranaSocketData({
        runtime: current.runtime,
        subprotocol: hrana.version === 2 ? "hrana2" : "hrana3",
        db: hrana.db,
        principal: null,
      })
    : newSocketData(current.runtime, null)
  const socket = new VirtualSocket(id, data)
  const ready = verify.then((principal) => {
    socket.data.principal = principal
  })
  current.sockets.set(id, { socket, ready })
  if (hrana) hranaWsOpen(socket as unknown as never)
}

function closeVirtual(current: WorkerState, id: string): void {
  const entry = current.sockets.get(id)
  if (!entry) return
  current.sockets.delete(id)
  entry.socket.readyState = 3
  if (isHranaData(entry.socket.data)) hranaWsClose(entry.socket as unknown as never)
  else closeWsSocket(entry.socket as unknown as Socket)
}

/** Only the three numbers `Metrics.render` reads; the full stats carry an array per tenant. */
function pick(stats: { open: number; tenants: number; evictions: number }): {
  open: number
  tenants: number
  evictions: number
} {
  return { open: stats.open, tenants: stats.tenants, evictions: stats.evictions }
}

// ── the message loop ───────────────────────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent): void => {
  const message = event.data as ToWorker & {
    hrana?: { db: string; version: number }
    token?: string | null
  }
  if (message.kind === "init") {
    void start(message.index, message.workers, message.config as ServerConfig).then(
      () => post({ kind: "ready" }),
      (err: unknown) => post({ kind: "ready", error: String(err) }),
    )
    return
  }
  const current = state
  if (!current) return
  switch (message.kind) {
    case "http":
      void serve(current, message.id, message.method, message.url, message.headers, message.body)
      return
    case "http.abort": {
      current.inflight.get(message.id)?.abort()
      return
    }
    case "ws.hello":
      adopt(current, message.socket, message.token ?? null, message.hrana ?? null)
      return
    case "ws.msg": {
      const entry = current.sockets.get(message.socket)
      if (!entry) return
      const text = message.text
      void entry.ready.then(() => {
        if (isHranaData(entry.socket.data)) hranaWsMessage(entry.socket as unknown as never, text)
        else void handleMessage(entry.socket as unknown as Socket, text)
      })
      return
    }
    case "ws.drain": {
      const entry = current.sockets.get(message.socket)
      if (entry && !isHranaData(entry.socket.data)) drainWs(entry.socket as unknown as Socket)
      return
    }
    case "ws.close":
      closeVirtual(current, message.socket)
      return
    case "metrics":
      post({
        kind: "metrics.reply",
        id: message.id,
        metrics: current.runtime.metrics.state(),
        registry: pick(current.runtime.registry.stats()),
      })
      return
    case "shutdown": {
      const id = message.id
      void (async () => {
        for (const socketId of [...current.sockets.keys()]) closeVirtual(current, socketId)
        current.app.surfaces.close()
        await current.runtime.closeStorage()
        current.runtime.close()
        post({ kind: "shutdown.reply", id })
      })()
      return
    }
    default:
      return
  }
}
