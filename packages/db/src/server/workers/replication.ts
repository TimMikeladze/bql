// The router's half of `/v1/replication` when `[server] workers > 1` (`docs/c4b-replication-workers.md`).
//
// Decision, and it is the whole file: **the stream crosses the worker channel, not the tenant.**
// The router owns the *connection* — the socket, the HMAC handshake, the frame reader, the one send
// queue, the slow-replica cut-off, the heartbeat and the node's announcement — and the worker that
// owns a database owns that database's *stream*, with `tenant.onCommit`, `tenant.log.iterate`,
// `tenant.snapshot()` and `registry.pin` called on the thread that holds the writer, exactly as on
// a single-threaded node. Nothing that touches a tenant is on the channel; the only thing on the
// hot path is the finished frame, one `postMessage` per `TXN`, which is irreducible because the
// socket is on a thread the tenant is not.
//
// Invariant: a frame is routed by the *stream* it names, and a stream's worker is learned from the
// one frame that mints it (`SUBSCRIBE`, which names the database) and forgotten by the one that
// ends it (`UNSUBSCRIBE`). That is the same rule `router.ts` applies to a transaction baton and a
// subscription id, for the same reason.
//
// Second invariant: backpressure lives here and only here. A worker's virtual socket always
// accepts, so there is one queue, one `pausedSinceMs` and one cut-off for a slow replica — the
// single-threaded behaviour, unchanged, rather than a second buffer on every worker.

import {
  type AckBody,
  decodeAck,
  decodeJson,
  encodeJson,
  type ForwardBody,
  FRAME,
  FrameReader,
  frameName,
  generationId,
  type HeartbeatBody,
  type HelloBody,
  makeNonce,
  ProtocolError,
  PROTO_VERSION,
  type ReplicationErrorCode,
  type ReplicationSocket,
  type SubscribeBody,
  type UnsubscribeBody,
  verifyProof,
} from "../../replication/index.ts"
import type { ServerRuntime } from "../runtime.ts"
import type { WorkerPool } from "./pool.ts"

const encoder = new TextEncoder()

/** A control-frame body, for the one frame this module synthesises rather than forwards. */
function encodeBody(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

/** One replica socket, as the router holds it. */
class Conn {
  readonly ws: ReplicationSocket
  readonly reader = new FrameReader()
  readonly nonce = makeNonce()
  /** Minted here and used as the routing key on the channel; a socket cannot cross a thread. */
  readonly id: string
  /** Workers this connection has been adopted on, so `repl.adopt` is sent once each. */
  readonly adopted = new Set<number>()
  /** Worker that owns each open stream, learned from `SUBSCRIBE`. */
  readonly streams = new Map<number, number>()
  node = "?"
  authed = false
  paused = false
  pausedSinceMs = 0
  queue: Uint8Array[] = []
  closed = false

  constructor(ws: ReplicationSocket, id: string) {
    this.ws = ws
    this.id = id
  }
}

export interface ReplicationRouterOptions {
  runtime: ServerRuntime
  pool: WorkerPool
  node: string
  secret: string
  heartbeatMs?: number
  slowReplicaMs?: number
  onError?: (err: unknown) => void
}

export class ReplicationRouter {
  readonly node: string
  readonly secret: string
  readonly heartbeatMs: number
  readonly slowReplicaMs: number

  /** Bytes handed to `ws.send`, for `bql_replication_bytes_total`. The router writes every one. */
  bytesSent = 0

  #runtime: ServerRuntime
  #pool: WorkerPool
  #conns = new Set<Conn>()
  #byWs = new WeakMap<object, Conn>()
  #byId = new Map<string, Conn>()
  #timer: ReturnType<typeof setInterval> | null = null
  #onError: (err: unknown) => void
  #seq = 0
  #announcing = false
  #closed = false

  constructor(options: ReplicationRouterOptions) {
    this.#runtime = options.runtime
    this.#pool = options.pool
    this.node = options.node
    this.secret = options.secret
    this.heartbeatMs = options.heartbeatMs ?? 5000
    this.slowReplicaMs = options.slowReplicaMs ?? 30_000
    this.#onError =
      options.onError ?? ((err: unknown) => console.error("bql: replication", err))
  }

  /** Replica connections attached, for `bql_replication_connected`. The router owns them all. */
  get connections(): number {
    return this.#conns.size
  }

  // ── socket lifecycle, exactly as `ReplicationServer` has it ──────────────────────────────────

  open(ws: ReplicationSocket): void {
    if (this.#closed) {
      ws.close(1001, "shutting down")
      return
    }
    const conn = new Conn(ws, `r${++this.#seq}`)
    this.#conns.add(conn)
    this.#byWs.set(ws as object, conn)
    this.#byId.set(conn.id, conn)
    this.#send(
      conn,
      encodeJson(FRAME.HELLO, {
        proto: PROTO_VERSION,
        node: this.node,
        nonce: conn.nonce,
      } satisfies HelloBody),
    )
    this.#startTimer()
  }

  message(ws: ReplicationSocket, data: string | Uint8Array | ArrayBuffer): void {
    const conn = this.#byWs.get(ws as object)
    if (!conn) return
    let frames
    try {
      frames = conn.reader.push(data)
    } catch (err) {
      this.#fail(conn, "PROTO", err instanceof Error ? err.message : String(err))
      return
    }
    for (const frame of frames) {
      try {
        this.#route(conn, frame.type, frame.body)
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.#fail(conn, "PROTO", err.message)
          return
        }
        this.#onError(err)
        this.#error(conn, undefined, "INTERNAL", "the primary could not handle that frame")
      }
    }
  }

  drain(ws: ReplicationSocket): void {
    const conn = this.#byWs.get(ws as object)
    if (!conn) return
    conn.paused = false
    while (conn.queue.length > 0) {
      const frame = conn.queue[0] as Uint8Array
      const sent = conn.ws.send(frame)
      if (sent === 0) {
        conn.paused = true
        return
      }
      conn.queue.shift()
      this.bytesSent += frame.byteLength
      if (sent === -1) {
        conn.paused = true
        conn.pausedSinceMs = Date.now()
        return
      }
    }
  }

  close(ws: ReplicationSocket): void {
    const conn = this.#byWs.get(ws as object)
    if (!conn) return
    this.#teardown(conn)
  }

  stop(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    for (const conn of [...this.#conns]) {
      try {
        conn.ws.close(1001, "shutting down")
      } catch {
        // Already gone; the teardown below is what matters.
      }
      this.#teardown(conn)
    }
  }

  // ── what a worker sends back ─────────────────────────────────────────────────────────────────

  /** A finished frame from the worker that owns the stream. */
  out(connId: string, bytes: Uint8Array): void {
    const conn = this.#byId.get(connId)
    if (!conn) return
    this.#send(conn, bytes)
  }

  /** A worker closing a connection it refused — `#fail` on the far side of the channel. */
  shut(connId: string, code?: number, reason?: string): void {
    const conn = this.#byId.get(connId)
    if (!conn) return
    try {
      conn.ws.close(code, reason)
    } catch {
      // Already gone.
    }
    this.#teardown(conn)
  }

  /**
   * `plan-phase1.md` finding 1, across threads: a database created on a worker must reach a
   * `follow: ["*"]` replica now, not at the next heartbeat. The worker's registry fires its own
   * `onChange` and posts here, because an in-process callback cannot cross a thread.
   */
  announce(): void {
    if (this.#closed || this.#conns.size === 0) return
    // Coalesced: creating a hundred databases in a loop is a hundred `announce()` calls on a
    // single-threaded node, which is a hundred cheap synchronous sends. Here each one is a gather
    // across every worker, so they are folded into one beat per turn of the event loop.
    if (this.#announcing) return
    this.#announcing = true
    queueMicrotask(() => {
      this.#announcing = false
      void this.#beat()
    })
  }

  // ── routing ──────────────────────────────────────────────────────────────────────────────────

  #route(conn: Conn, type: number, body: Uint8Array): void {
    if (type === FRAME.HELLO) {
      this.#hello(conn, decodeJson<HelloBody>(type, body))
      return
    }
    if (!conn.authed) {
      this.#fail(conn, "AUTH_FAILED", `${frameName(type)} arrived before the handshake finished`)
      return
    }
    switch (type) {
      case FRAME.SUBSCRIBE: {
        // The one frame that names a database, and therefore the one that mints the routing key.
        const request = decodeJson<SubscribeBody>(type, body)
        const stream = request.stream >>> 0
        const index = this.#pool.shardOf(request.db)
        // A replica reusing a stream id for a database on a different shard would otherwise leave
        // the old worker holding a stream — and a pinned tenant — that nothing ever ends.
        const previous = conn.streams.get(stream)
        if (previous !== undefined && previous !== index) {
          this.#deliver(conn, previous, FRAME.UNSUBSCRIBE, encodeBody({ stream }), undefined)
        }
        conn.streams.set(stream, index)
        this.#deliver(conn, index, type, body, stream)
        return
      }
      case FRAME.UNSUBSCRIBE: {
        const { stream } = decodeJson<UnsubscribeBody>(type, body)
        const index = conn.streams.get(stream >>> 0)
        if (index === undefined) return
        conn.streams.delete(stream >>> 0)
        this.#deliver(conn, index, type, body, stream)
        return
      }
      case FRAME.ACK: {
        const ack: AckBody = decodeAck(body)
        const index = conn.streams.get(ack.stream)
        if (index === undefined) return
        this.#deliver(conn, index, type, body, ack.stream)
        return
      }
      case FRAME.FORWARD: {
        // R2. A forwarded write names its database rather than a stream, and runs on the thread
        // that owns the writer — which is the same rule the HTTP hop uses for the same write.
        const request = decodeJson<ForwardBody>(type, body)
        this.#deliver(conn, this.#pool.shardOf(request.db), type, body, undefined)
        return
      }
      case FRAME.HEARTBEAT:
        return
      case FRAME.ERROR:
        this.#onError(new Error(`replica ${conn.node}: ${new TextDecoder().decode(body)}`))
        return
      default:
        this.#fail(conn, "PROTO", `unexpected frame ${frameName(type)}`)
    }
  }

  /**
   * Posts one frame to a worker, adopting the connection there first. A worker that is gone is the
   * one failure this has to make loud: without the catch, a `SUBSCRIBE` into a dead shard leaves a
   * stream that never answers and a replica that waits for ever.
   */
  #deliver(conn: Conn, index: number, type: number, body: Uint8Array, stream: number | undefined): void {
    try {
      if (!conn.adopted.has(index)) {
        conn.adopted.add(index)
        this.#pool.replAdopt(index, conn.id, conn.node)
      }
      // Copied rather than forwarded: `FrameReader` hands back a view into the whole WebSocket
      // message, and structured clone would move that entire buffer rather than this frame.
      this.#pool.replFrame(index, conn.id, type, body.slice())
    } catch (err) {
      conn.adopted.delete(index)
      if (stream !== undefined) conn.streams.delete(stream)
      this.#onError(err)
      this.#error(conn, stream, "INTERNAL", `worker ${index} is not available`)
    }
  }

  #hello(conn: Conn, hello: HelloBody): void {
    if (conn.authed) return
    if (hello.proto !== PROTO_VERSION) {
      this.#fail(conn, "PROTO", `this node speaks replication protocol ${PROTO_VERSION}`)
      return
    }
    if (!verifyProof(this.secret, conn.nonce, hello.proof)) {
      this.#fail(conn, "AUTH_FAILED", "the cluster secret proof did not verify")
      return
    }
    conn.node = typeof hello.node === "string" && hello.node ? hello.node : "?"
    conn.authed = true
    const announcement = this.#announcement()
    this.#send(
      conn,
      encodeJson(FRAME.HELLO, {
        proto: PROTO_VERSION,
        node: this.node,
        ok: true,
        databases: [...announcement.keys()],
        generations: Object.fromEntries(announcement),
      } satisfies HelloBody),
    )
  }

  /**
   * Every live database with its generation id, from the catalog the router holds — which is the
   * whole node's, not one shard's, and is why this is assembled here rather than on a worker.
   *
   * The rule is `ReplicationServer.#announcement`'s, spelled out rather than delegated to
   * `runtime.generationOf`: that one scans `registry.list()` for the row, which is a linear search
   * per row and would make a node with ten thousand databases quadratic on every heartbeat. A copy
   * this node received as a replica keeps the id it was bootstrapped under; everything else derives
   * one from its own catalog row (R7).
   */
  #announcement(): Map<string, string> {
    const out = new Map<string, string>()
    try {
      const replica = this.#runtime.replica
      for (const row of this.#runtime.registry.list()) {
        out.set(row.name, replica?.generationOf(row.name) ?? generationId(row))
      }
    } catch {
      return out
    }
    return out
  }

  // ── the heartbeat ────────────────────────────────────────────────────────────────────────────

  #startTimer(): void {
    if (this.#timer !== null || this.#closed) return
    this.#timer = setInterval(() => void this.#tick(), this.heartbeatMs)
    this.#timer.unref?.()
  }

  #stopTimerIfIdle(): void {
    if (this.#conns.size > 0 || this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  async #tick(): Promise<void> {
    const now = Date.now()
    for (const conn of [...this.#conns]) {
      if (conn.paused && now - conn.pausedSinceMs > this.slowReplicaMs) {
        this.#fail(conn, "BUSY", `this socket has been backpressured for ${now - conn.pausedSinceMs}ms`)
      }
    }
    await this.#beat()
  }

  /**
   * One `HEARTBEAT` per connection, carrying every stream's txid. The positions come from the
   * workers in one gather — N messages every `heartbeatMs`, not one per stream per commit — and
   * the announcement that rides along is the router's own. The same gather drives R7's sweep,
   * which is why the two happen together here and in one place.
   */
  async #beat(): Promise<void> {
    if (this.#closed || this.#conns.size === 0) return
    const announcement = this.#announcement()
    let positions: { conn: string; stream: number; txid: string }[]
    try {
      positions = await this.#pool.replPositions([...announcement])
    } catch (err) {
      this.#onError(err)
      return
    }
    const byConn = new Map<string, { stream: number; txid: string }[]>()
    for (const one of positions) {
      const list = byConn.get(one.conn)
      if (list) list.push({ stream: one.stream, txid: one.txid })
      else byConn.set(one.conn, [{ stream: one.stream, txid: one.txid }])
    }
    const ts = Date.now()
    for (const conn of [...this.#conns]) {
      if (!conn.authed || conn.closed) continue
      this.#send(
        conn,
        encodeJson(FRAME.HEARTBEAT, {
          ts,
          streams: byConn.get(conn.id) ?? [],
          databases: [...announcement.keys()],
          generations: Object.fromEntries(announcement),
        } satisfies HeartbeatBody),
      )
    }
  }

  // ── sending, identical to the single-threaded server's ───────────────────────────────────────

  #send(conn: Conn, frame: Uint8Array): void {
    if (conn.closed) return
    if (conn.paused) {
      conn.queue.push(frame)
      return
    }
    const sent = conn.ws.send(frame)
    if (sent === 0) {
      conn.paused = true
      conn.pausedSinceMs = Date.now()
      conn.queue.push(frame)
      return
    }
    this.bytesSent += frame.byteLength
    if (sent === -1) {
      conn.paused = true
      conn.pausedSinceMs = Date.now()
    }
  }

  #error(conn: Conn, stream: number | undefined, code: ReplicationErrorCode, message: string): void {
    this.#send(
      conn,
      encodeJson(FRAME.ERROR, {
        ...(stream === undefined ? {} : { stream }),
        code,
        message,
      }),
    )
  }

  #fail(conn: Conn, code: ReplicationErrorCode, message: string): void {
    this.#error(conn, undefined, code, message)
    try {
      conn.ws.close(code === "AUTH_FAILED" ? 1008 : 1002, code)
    } catch {
      // Already gone.
    }
    this.#teardown(conn)
  }

  #teardown(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    // Every worker that holds a stream for this connection ends it, unpins its tenant and rolls
    // back the interactive transactions this replica had open there (R2's `onDisconnect`). A
    // worker that was never introduced holds nothing for it, which is why this walks `adopted`.
    for (const index of conn.adopted) {
      try {
        this.#pool.replGone(index, conn.id, conn.node)
      } catch (err) {
        this.#onError(err)
      }
    }
    conn.queue = []
    conn.adopted.clear()
    conn.streams.clear()
    this.#conns.delete(conn)
    this.#byId.delete(conn.id)
    this.#stopTimerIfIdle()
  }
}
