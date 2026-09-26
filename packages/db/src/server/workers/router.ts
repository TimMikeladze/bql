// The router's route table and socket relay (`docs/c4-workers.md` §3, §4). This is what `app.ts`
// builds instead of the ordinary one when `[server] workers` is more than 1.
//
// Invariant: a request that names a database is answered by the worker that owns it and by nothing
// else. The router never opens a tenant — its `ServerRuntime` exists for the catalog, the
// authenticator and the node-level routes — so a routing mistake is a refusal from the worker
// (`entry.ts`'s `assertOwned`), never a second writer.
//
// Second invariant: a hopped response is forwarded byte for byte. The worker's app already ran
// `wrap()`, so the `BQL-*` headers, CORS, the metrics tick and C2's `307` are the worker's; the
// router adds nothing and rewrites nothing.

import { HEADERS, WS_PROTOCOL } from "../../client/protocol.ts"
import type { ServerConfig } from "../config.ts"
import { BqlError, errorResponse } from "../errors.ts"
import { hranaTarget } from "../hrana/index.ts"
import type { ServerRuntime } from "../runtime.ts"
import type { ReplicationMetrics } from "../metrics.ts"
import type { SocketRouting, WorkerPool } from "./pool.ts"
import type { ReplicationRouter } from "./replication.ts"

/** A socket the router holds on behalf of a worker. */
export interface RelaySocketData {
  relay: true
  id: string
  routing: SocketRouting
  runtime: ServerRuntime
  /** Latest undelivered live result per subscription, exactly as `ws.ts` keeps it. */
  pendingLive: Map<string, string>
}

export function isRelay(data: unknown): data is RelaySocketData {
  return (data as RelaySocketData | null)?.relay === true
}

/** True for an operation whose path names a database, and which therefore belongs to a shard. */
export function isSharded(path: string): boolean {
  return path.startsWith("/v1/db/:db")
}

/**
 * The database a request is routed by: the path first, then `x-namespace`, then the first `Host`
 * label when the node accepts host addressing. Exactly the rule `routes.ts`'s `dbName` and
 * `hrana/http.ts`'s `namespaceOf` apply, so the router and the handler cannot disagree about which
 * database a request is for.
 */
export function routingName(config: ServerConfig, request: Request, url: URL): string | null {
  const parts = url.pathname.split("/").filter((one) => one.length > 0)
  if (parts[0] === "v1" && parts[1] === "db" && parts.length >= 3) {
    try {
      return decodeURIComponent(parts[2] as string)
    } catch {
      return parts[2] as string
    }
  }
  const namespace = request.headers.get("x-namespace")
  if (namespace) return namespace
  const host = url.hostname
  const label = host.split(".")[0]
  if (config.server.tenantFromHost && label && label !== host) return label
  return null
}

/**
 * `POST /v1/db` names its database in the body rather than in the path, so the router reads the
 * body once, routes on the name, and hands the bytes it already has to the worker.
 */
export async function createDbTarget(request: Request): Promise<{ name: string; body: Uint8Array }> {
  const body = new Uint8Array(await request.arrayBuffer())
  let name = ""
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { name?: unknown }
    if (typeof parsed?.name === "string") name = parsed.name
  } catch {
    // A malformed body is the worker's to refuse, with the message it already writes; routing it
    // to shard 0 is as good as anywhere for a request that is going to be a 400.
  }
  return { name, body }
}

// ── the socket relay ───────────────────────────────────────────────────────────────────────────

/** A client frame, parsed only as far as routing needs. */
interface Framed {
  op?: string
  id?: number
  db?: string
  tx?: string
  sub?: string
  token?: string
}

/**
 * Routes one frame from a client socket. `hello` and `ping` are answered here — the router owns
 * the authenticator and the socket, and a `hello` that reached a worker would be answered N times.
 * Everything else goes to the worker that owns the database, the baton or the subscription the
 * frame names.
 */
export async function relayMessage(
  pool: WorkerPool,
  data: RelaySocketData,
  socket: { send(text: string): number },
  raw: string | Buffer,
): Promise<void> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  if (data.routing.pinned !== null) {
    // A libsql socket: one database, decided at the handshake, so there is nothing to look at.
    pool.introduce(data.routing.pinned, data.id, data.routing)
    pool.send(data.routing.pinned, data.id, text)
    return
  }
  let frame: Framed
  try {
    frame = JSON.parse(text) as Framed
  } catch {
    socket.send(
      JSON.stringify({ ok: false, error: { code: "BAD_REQUEST", message: "frame is not valid JSON", status: 400 } }),
    )
    return
  }
  if (frame?.op === "hello") {
    await relayHello(pool, data, socket, frame)
    return
  }
  if (frame?.op === "ping") {
    socket.send(JSON.stringify(frame.id === undefined ? { event: "pong" } : { id: frame.id, ok: true }))
    return
  }
  const index = shardFor(pool, data.routing, frame)
  if (index === null) {
    socket.send(
      JSON.stringify({
        ...(frame?.id === undefined ? {} : { id: frame.id }),
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: `${JSON.stringify(frame?.op ?? "")} needs a db, a tx or a sub this node knows`,
          status: 400,
        },
      }),
    )
    return
  }
  pool.introduce(index, data.id, data.routing)
  pool.send(index, data.id, text)
  // A frame that ends a transaction or a subscription releases the routing key it was answered by,
  // so a socket that opens millions of transactions does not accumulate one entry each.
  if (frame.tx && (frame.op === "tx.commit" || frame.op === "tx.rollback")) {
    data.routing.batons.delete(frame.tx)
  }
  if (frame.sub && frame.op === "unsubscribe") data.routing.subs.delete(frame.sub)
}

function shardFor(pool: WorkerPool, routing: SocketRouting, frame: Framed): number | null {
  if (frame?.db) return pool.shardOf(frame.db)
  if (frame?.tx) return routing.batons.get(frame.tx) ?? null
  if (frame?.sub) return routing.subs.get(frame.sub) ?? null
  return null
}

/**
 * `hello` on the router: the token is verified here, once, and then re-stated to every worker this
 * socket has already spoken to. The reply and the `hello` event are this node's, not a shard's.
 */
async function relayHello(
  pool: WorkerPool,
  data: RelaySocketData,
  socket: { send(text: string): number },
  frame: Framed,
): Promise<void> {
  try {
    if (frame.token) {
      await data.runtime.auth.authenticateToken(frame.token)
      data.routing.token = frame.token
    } else if (!data.routing.token) {
      throw BqlError.unauthenticated("hello needs a token on a socket that had none")
    }
  } catch (err) {
    const status = err instanceof BqlError ? err : BqlError.unauthenticated()
    socket.send(
      JSON.stringify({
        ...(frame.id === undefined ? {} : { id: frame.id }),
        ok: false,
        error: { code: status.code, message: status.message, status: status.status },
      }),
    )
    return
  }
  pool.reintroduce(data.id, data.routing)
  if (frame.id !== undefined) socket.send(JSON.stringify({ id: frame.id, ok: true }))
  socket.send(
    JSON.stringify({
      event: "hello",
      protocol: WS_PROTOCOL,
      node: data.runtime.node,
      role: data.runtime.role,
      ...(data.runtime.primaryUrl ? { primary: data.runtime.primaryUrl } : {}),
    }),
  )
}

/** Bun told us the socket has room; flush what was held back and let the workers know. */
export function relayDrain(pool: WorkerPool, data: RelaySocketData, socket: { send(text: string): number }): void {
  for (const [id, frame] of [...data.pendingLive]) {
    if (socket.send(frame) <= 0) return
    data.pendingLive.delete(id)
  }
  pool.drained(data.routing, data.id)
}

// ── upgrades ───────────────────────────────────────────────────────────────────────────────────

interface UpgradeHost {
  upgrade(request: Request, options: { data: unknown; headers?: Record<string, string> }): boolean
}

let sockets = 0

function newRelayData(runtime: ServerRuntime, pool: WorkerPool): RelaySocketData {
  const id = `s${++sockets}`
  return { relay: true, id, routing: pool.track(id), runtime, pendingLive: new Map() }
}

/** The native socket (`/v1/ws`). Its frames are routed one by one; it may name many databases. */
export async function relayUpgrade(
  runtime: ServerRuntime,
  pool: WorkerPool,
  request: Request,
  server: unknown,
  url: URL,
): Promise<Response | undefined> {
  const token =
    request.headers.get("authorization")?.replace(/^[Bb]earer\s+/, "") ?? url.searchParams.get("token")
  const data = newRelayData(runtime, pool)
  if (token) {
    try {
      await runtime.auth.authenticateToken(token)
      data.routing.token = token
    } catch (err) {
      pool.untrack(data.id)
      return errorResponse(err)
    }
  }
  const requested = request.headers.get("sec-websocket-protocol")
  const offered = requested
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p === WS_PROTOCOL)
  const ok = (server as UpgradeHost).upgrade(request, {
    data,
    ...(offered ? { headers: { "sec-websocket-protocol": offered } } : {}),
  })
  if (ok) return undefined
  pool.untrack(data.id)
  return new Response("expected a WebSocket upgrade", { status: 426 })
}

/** A libsql socket: one database for its whole life, so it is pinned to one worker at the door. */
export function relayHranaUpgrade(
  runtime: ServerRuntime,
  pool: WorkerPool,
  request: Request,
  server: unknown,
  url: URL,
): Response | undefined {
  const target = hranaTarget(request, url)
  if (!target) return new Response("expected a hrana WebSocket subprotocol", { status: 426 })
  const data = newRelayData(runtime, pool)
  data.routing.pinned = pool.shardOf(target.db)
  data.routing.hrana = { db: target.db, version: target.subprotocol === "hrana2" ? 2 : 3 }
  const bearer = request.headers.get("authorization")?.replace(/^[Bb]earer\s+/, "")
  if (bearer) data.routing.token = bearer
  const ok = (server as UpgradeHost).upgrade(request, {
    data,
    headers: { "sec-websocket-protocol": target.subprotocol },
  })
  if (ok) return undefined
  pool.untrack(data.id)
  return new Response("expected a WebSocket upgrade", { status: 426 })
}

/**
 * `GET /metrics` on a router: every worker's counters, added, rendered as this node's.
 *
 * The replication block is assembled from both halves by the rule in
 * `docs/c4b-replication-workers.md` §7 — `connected` and `bytes` from the router, which owns every
 * socket and writes every byte; `records` summed and `lagTxid` maxed across the workers, which own
 * the streams. The storage gauges are still omitted: that gap is C4's and is unchanged.
 */
export async function routerMetrics(
  runtime: ServerRuntime,
  pool: WorkerPool,
  replication: ReplicationRouter | null,
): Promise<Response> {
  const { metrics, registry, replication: shards, storage } = await pool.gather()
  // The router answers no database request, but it does answer the node-level ones, so its own
  // counters belong in the total.
  metrics.absorb(runtime.metrics.state())
  registry.tenants = runtime.registry.list().length
  // L3: the ceiling is the node's, and this thread is the one that holds it — the workers each
  // carry a share of it and would each under-report it.
  // L4: the router holds no tenants, so the pinned count and the refused-open count are the
  // workers' — summed, because the shards are disjoint.
  const nodeRegistry = { ...registry, maxOpen: runtime.registry.maxOpen }
  // The rule is `replicationMetrics`'s, applied across threads: a node that *follows* reports its
  // client, a node that *serves* reports its sockets, and the per-stream half of either is summed
  // from the workers. `connected` and `bytes` are always the router's — it owns every socket and
  // reads or writes every byte — while `records` sums and `lagTxid` takes the max, because a
  // record belongs to exactly one worker and a lag is already a max over streams.
  const client = runtime.replica
  const replicationMetrics: ReplicationMetrics | null = client
    ? {
        connected: client.connected ? 1 : 0,
        bytes: client.bytesReceived,
        lagTxid: shards?.lagTxid ?? 0,
        records: shards?.records ?? 0,
      }
    : replication
      ? {
          connected: replication.connections,
          bytes: replication.bytesSent,
          lagTxid: shards?.lagTxid ?? 0,
          records: shards?.records ?? 0,
        }
      : null
  // C4e: the `bql_s3_*` gauges, which C4 omitted because a shipper lives on a worker. The merge
  // is the one `ShipperPool.totals` already performs across a node's databases, applied across the
  // shards — which is exact rather than a convention, because a database belongs to one worker and
  // the shards are therefore disjoint.
  const body = metrics.render(nodeRegistry, runtime.node, replicationMetrics, storage)
  return new Response(body, {
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      [HEADERS.node]: runtime.node,
    },
  })
}
