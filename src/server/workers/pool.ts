// The router's half of `workers: N` (`docs/c4-workers.md` §3): spawn the workers, route by the
// shard of the database a request names, correlate replies, and apply what a worker did to a
// socket it cannot reach.
//
// Invariant: the pool is the only thing on the main thread that knows a worker exists. `app.ts`
// asks it for a `Response` or hands it a frame; nothing else imports `postMessage`.
//
// Second invariant: a frame the router forwards is never parsed twice. A client frame is parsed
// once, to find the database, the baton or the subscription it names; a frame coming back is
// scanned with `String.includes` before anything is parsed, and the two frames that mint a routing
// key say so in the envelope rather than being discovered by re-reading them.
//
// Third invariant: backpressure on a live result is observed here, because this is the only thread
// that can see the socket's buffer. Design §7's rule — keep the latest per subscription, drop what
// it superseded — is applied in `sendFrame` exactly as `ws.ts` applies it in a single-threaded
// node.

import type { ServerConfig } from "../config.ts"
import { Metrics, type MetricsState } from "../metrics.ts"
import type { FromWorker, ToWorker } from "./protocol.ts"
import { resolveWorkers, shardOf } from "./shard.ts"

/** What the pool needs from the listener, once it exists. */
export interface RouterHost {
  /** Bun's own pub/sub, for a change event a worker published. */
  publish(topic: string, data: string): unknown
}

export interface RouterSocket {
  send(data: string): number
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  close(code?: number, reason?: string): void
  /** Latest undelivered live result per subscription, while the socket is backpressured. */
  pendingLive: Map<string, string>
}

interface Pending {
  resolve(value: Response): void
  reject(err: unknown): void
}

interface Stream {
  controller: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
}

/** What one client socket has been told to a worker, so a later frame reaches the same one. */
export class SocketRouting {
  /** Workers this socket has been introduced to, so `ws.hello` is sent once each. */
  readonly adopted = new Set<number>()
  /** Worker that minted a baton, so `tx.commit` naming only the baton finds it. */
  readonly batons = new Map<string, number>()
  /** Worker that minted a subscription id, likewise for `unsubscribe`. */
  readonly subs = new Map<string, number>()
  /** Fixed for a libsql socket, whose database is decided at upgrade. */
  pinned: number | null = null
  /** The bearer token the socket presented, re-sent whenever a new worker adopts it. */
  token: string | null = null
  /** Set for a libsql socket; the worker needs it to build the same socket data. */
  hrana: { db: string; version: number } | null = null
}

export class WorkerPool {
  readonly size: number

  #workers: Worker[] = []
  #pending = new Map<number, Pending>()
  #streams = new Map<number, Stream>()
  #metrics = new Map<number, (reply: { metrics: MetricsState; registry: RegistryShare }) => void>()
  #shutdowns = new Map<number, () => void>()
  #seq = 0
  #host: RouterHost | null = null
  #onError: (err: unknown) => void
  #closed = false

  private constructor(size: number, onError: (err: unknown) => void) {
    this.size = size
    this.#onError = onError
  }

  /**
   * Spawns the workers and waits for every one of them to have built its runtime. A worker that
   * fails to start fails the whole `startServer`: a node serving three shards out of four is a
   * node that answers `DB_NOT_FOUND` for a quarter of its databases.
   */
  static async start(
    config: ServerConfig,
    onError: (err: unknown) => void,
  ): Promise<WorkerPool> {
    const size = resolveWorkers(config.server.workers)
    const pool = new WorkerPool(size, onError)
    const url = new URL("./entry.ts", import.meta.url).href
    const ready: Promise<void>[] = []
    for (let index = 0; index < size; index++) {
      const worker = new Worker(url)
      pool.#workers.push(worker)
      ready.push(
        new Promise<void>((resolve, reject) => {
          const first = (event: MessageEvent): void => {
            const message = event.data as FromWorker
            if (message.kind !== "ready") return
            worker.onmessage = (next: MessageEvent) => pool.#receive(index, next.data as FromWorker)
            if (message.error) reject(new Error(`worker ${index}: ${message.error}`))
            else resolve()
          }
          worker.onmessage = first
          worker.onerror = (event: ErrorEvent) => reject(event.error ?? new Error(String(event.message)))
        }),
      )
      worker.postMessage({ kind: "init", index, workers: size, config } satisfies ToWorker)
    }
    try {
      await Promise.all(ready)
    } catch (err) {
      await pool.close()
      throw err
    }
    for (let index = 0; index < size; index++) {
      const worker = pool.#workers[index] as Worker
      worker.onerror = (event: ErrorEvent) => onError(event.error ?? new Error(String(event.message)))
    }
    return pool
  }

  /** Attaches the listener, once `Bun.serve` has returned one. */
  setHost(host: RouterHost | null): void {
    this.#host = host
  }

  /** The real socket behind an id, for as long as it is open. */
  attach(id: string, socket: RouterSocket): void {
    this.#sockets.set(id, socket)
  }

  detach(id: string): void {
    this.#sockets.delete(id)
  }

  /** Which worker owns a database. */
  shardOf(db: string): number {
    return shardOf(db, this.size)
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Runs a request on the worker that owns `db` and returns its answer. The worker's app has
   * already applied `wrap()`, so what comes back is the finished response — headers, CORS, the
   * `BunQL-*` set and C2's `307` included — and the router adds nothing to it.
   */
  async fetch(index: number, request: Request, preread?: Uint8Array): Promise<Response> {
    const id = this.#seq++
    const body =
      preread ??
      (request.method === "GET" || request.method === "HEAD"
        ? null
        : new Uint8Array(await request.arrayBuffer()))
    const headers: [string, string][] = []
    request.headers.forEach((value, key) => headers.push([key, value]))
    const answer = new Promise<Response>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    // A client that goes away mid-stream — an `EventSource` closed in a browser — has to abort the
    // handler on the worker, or its SSE stream pings into a socket nobody holds for ever.
    request.signal.addEventListener(
      "abort",
      () => this.#post(index, { kind: "http.abort", id }),
      { once: true },
    )
    this.#post(index, {
      kind: "http",
      id,
      method: request.method,
      url: request.url,
      headers,
      body,
    })
    return answer
  }

  // ── WebSocket relay ──────────────────────────────────────────────────────────────────────────

  /** Tells a worker about a socket, at most once, and re-states its credential after a `hello`. */
  introduce(index: number, socketId: string, routing: SocketRouting): void {
    if (routing.adopted.has(index)) return
    routing.adopted.add(index)
    this.#post(index, {
      kind: "ws.hello",
      socket: socketId,
      token: routing.token,
      ...(routing.hrana ? { hrana: routing.hrana } : {}),
    })
  }

  /** Re-states a socket's credential on every worker that already knows it. */
  reintroduce(socketId: string, routing: SocketRouting): void {
    for (const index of routing.adopted) {
      this.#post(index, {
        kind: "ws.hello",
        socket: socketId,
        token: routing.token,
        ...(routing.hrana ? { hrana: routing.hrana } : {}),
      })
    }
  }

  send(index: number, socketId: string, text: string): void {
    this.#post(index, { kind: "ws.msg", socket: socketId, text })
  }

  drained(routing: SocketRouting, socketId: string): void {
    for (const index of routing.adopted) this.#post(index, { kind: "ws.drain", socket: socketId })
  }

  closed(routing: SocketRouting, socketId: string): void {
    for (const index of routing.adopted) this.#post(index, { kind: "ws.close", socket: socketId })
  }

  // ── metrics and shutdown ─────────────────────────────────────────────────────────────────────

  /** Every worker's counters, added together, plus its share of the LRU. */
  async gather(): Promise<{ metrics: Metrics; registry: RegistryShare }> {
    const merged = new Metrics()
    const registry: RegistryShare = { open: 0, tenants: 0, evictions: 0 }
    await Promise.all(
      this.#workers.map(
        (_, index) =>
          new Promise<void>((resolve) => {
            const id = this.#seq++
            this.#metrics.set(id, (reply) => {
              merged.absorb(reply.metrics)
              registry.open += reply.registry.open
              registry.evictions += reply.registry.evictions
              registry.tenants = Math.max(registry.tenants, reply.registry.tenants)
              resolve()
            })
            this.#post(index, { kind: "metrics", id })
          }),
      ),
    )
    return { metrics: merged, registry }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await Promise.all(
      this.#workers.map(
        (worker, index) =>
          new Promise<void>((resolve) => {
            const id = this.#seq++
            const timer = setTimeout(resolve, 5000)
            timer.unref?.()
            this.#shutdowns.set(id, () => {
              clearTimeout(timer)
              resolve()
            })
            try {
              this.#post(index, { kind: "shutdown", id })
            } catch {
              clearTimeout(timer)
              resolve()
            }
          }),
      ),
    )
    for (const worker of this.#workers) worker.terminate()
    this.#workers = []
    for (const { reject } of this.#pending.values()) {
      reject(new Error("the worker pool is shutting down"))
    }
    this.#pending.clear()
  }

  // ── the receiving end ────────────────────────────────────────────────────────────────────────

  #post(index: number, message: ToWorker): void {
    const worker = this.#workers[index]
    if (!worker) throw new Error(`no worker ${index}`)
    worker.postMessage(message)
  }

  #receive(index: number, message: FromWorker): void {
    switch (message.kind) {
      case "http.reply": {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        pending.resolve(
          new Response(message.body ?? null, {
            status: message.status,
            headers: message.headers,
          }),
        )
        return
      }
      case "http.open": {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        const id = message.id
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.#streams.set(id, { controller, closed: false })
          },
          cancel: () => {
            this.#streams.delete(id)
            this.#post(index, { kind: "http.abort", id })
          },
        })
        pending.resolve(new Response(stream, { status: message.status, headers: message.headers }))
        return
      }
      case "http.chunk": {
        const stream = this.#streams.get(message.id)
        if (!stream || stream.closed) return
        try {
          stream.controller.enqueue(message.bytes)
        } catch {
          stream.closed = true
        }
        return
      }
      case "http.end": {
        const stream = this.#streams.get(message.id)
        this.#streams.delete(message.id)
        if (!stream || stream.closed) return
        stream.closed = true
        try {
          if (message.error) stream.controller.error(new Error(message.error))
          else stream.controller.close()
        } catch {
          // The client had already gone; the stream is closed either way.
        }
        return
      }
      case "publish":
        this.#host?.publish(message.topic, message.data)
        return
      case "moved":
        this.#host?.publish(`moved:${message.db}`, JSON.stringify({ event: "moved", db: message.db, primary: message.primary }))
        return
      case "ws.send":
        this.#onSend(index, message.socket, message.text, message.bind)
        return
      case "ws.subscribe":
      case "ws.unsubscribe": {
        const socket = this.#sockets.get(message.socket)
        if (!socket) return
        if (message.kind === "ws.subscribe") socket.subscribe(message.topic)
        else socket.unsubscribe(message.topic)
        return
      }
      case "ws.shut":
        this.#sockets.get(message.socket)?.close(message.code, message.reason)
        return
      case "metrics.reply": {
        const waiting = this.#metrics.get(message.id)
        this.#metrics.delete(message.id)
        waiting?.({ metrics: message.metrics, registry: message.registry })
        return
      }
      case "shutdown.reply": {
        const waiting = this.#shutdowns.get(message.id)
        this.#shutdowns.delete(message.id)
        waiting?.()
        return
      }
      case "error":
        this.#onError(new Error(`worker ${index}: ${message.message}`))
        return
      default:
        return
    }
  }

  /**
   * One frame from a worker to a client socket. A live result is dropped when the socket is behind
   * and the latest is kept, which is design §7's rule and the reason this cannot be a plain
   * `socket.send`. The two frames that mint a routing key carry it in `bind`.
   */
  #onSend(index: number, socketId: string, text: string, bind?: { tx?: string; sub?: string }): void {
    const routing = this.#routing.get(socketId)
    if (bind && routing) {
      if (bind.tx) routing.batons.set(bind.tx, index)
      if (bind.sub) routing.subs.set(bind.sub, index)
    }
    const socket = this.#sockets.get(socketId)
    if (!socket) return
    const live = liveIdOf(text)
    if (live === null) {
      socket.send(text)
      return
    }
    if (socket.pendingLive.size > 0) {
      socket.pendingLive.set(live, text)
      return
    }
    if (socket.send(text) > 0) return
    socket.pendingLive.set(live, text)
  }

  // ── socket bookkeeping the router hands over ─────────────────────────────────────────────────

  #routing = new Map<string, SocketRouting>()
  #sockets = new Map<string, RouterSocket>()

  track(socketId: string): SocketRouting {
    const routing = new SocketRouting()
    this.#routing.set(socketId, routing)
    return routing
  }

  untrack(socketId: string): void {
    this.#routing.delete(socketId)
    this.#sockets.delete(socketId)
  }
}

export interface RegistryShare {
  open: number
  tenants: number
  evictions: number
}

/**
 * The subscription id of a live-query frame, or null for anything else. Live frames are the only
 * ones subject to design §7's drop rule, and they are told apart by their topic shape — every live
 * topic is `db:<name>:live:<id>` — without parsing the frame.
 */
function liveIdOf(text: string): string | null {
  if (!text.startsWith('{"sub":"')) return null
  const end = text.indexOf('"', 8)
  if (end < 0) return null
  const id = text.slice(8, end)
  return id.includes(":live:") ? id : null
}
