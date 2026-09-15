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

import type { Command, PromotionOutcome, PromotionRequest } from "../../cluster/index.ts"
import type { ServerConfig } from "../config.ts"
import { Metrics, type MetricsState, type StorageMetrics } from "../metrics.ts"
import {
  type ClusterViewPush,
  flattenHeaders,
  type FollowResult,
  type FromWorker,
  type ToWorker,
  unflattenHeaders,
} from "./protocol.ts"
import { maxOpenShare, maxOpenThrashes, warnFdBudget } from "../../tenant/index.ts"
import { resolveWorkers, shardOf } from "./shard.ts"

/** What the pool needs from the listener, once it exists. */
export interface RouterHost {
  /** Bun's own pub/sub, for a change event a worker published. */
  publish(topic: string, data: string): unknown
  /**
   * C4d: a worker flipped a database's role. The router reads the catalog for `BunQL-Role` and for
   * the `requirePrimary` gate on `POST /v1/db`, and a row rewritten on another thread reaches no
   * `onChange` here — so a node promoted on a worker would keep calling itself a replica.
   */
  roleChanged(db: string, role: "primary" | "replica"): void
}

/** What the pool needs from the `ReplicationRouter` (C4b), when this node serves replicas. */
export interface ReplicationHost {
  out(conn: string, bytes: Uint8Array): void
  shut(conn: string, code?: number, reason?: string): void
  announce(): void
}

/**
 * What the pool needs from the `ReplicaClient` in `"routed"` mode (C4c), when this node follows an
 * upstream. Everything a worker reports that is *not* a frame for the socket.
 */
export interface FollowHost {
  /** A finished frame for the upstream socket: `SUBSCRIBE`, `ACK`, `ERROR`. */
  out(bytes: Uint8Array): void
  installed(stream: number, db: string, txid: string): void
  again(stream: number, db: string, reason: string): void
  stopped(db: string, trash: string | null): void
  forwardFrom(shard: number, id: number, request: { db: string; op: string; body: unknown }): void
  detach(db: string): void
  attach(db: string): void
  /** C4b §6's gap: a database fenced on a worker wants this node pointed at its new primary. */
  followPrimary(url: string): void
}

/**
 * What the pool needs from the router's side of the control plane (C4d), when `[cluster] enabled`.
 * Every one of these is a decision the `ClusterNode` or `ClusterShards` owns; none is on the write
 * path, which on a worker costs no message at all.
 */
export interface ClusterHost {
  /** A probe came back: `t1` as it was sent, `t2` the worker's own stamp. */
  probed(shard: number, t1: number, t2: number): void
  /** One shard's primaries, to be unioned into the node's owned set — never to replace it. */
  owned(shard: number, dbs: string[]): void
  propose(shard: number, id: number, command: Command): Promise<void>
  promote(shard: number, id: number, request: PromotionRequest): Promise<void>
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


/**
 * Above this, a hopped request body is transferred instead of copied. One megabyte: small enough
 * that an import never pays the copy, large enough that nothing on a data path is ever detached.
 */
const TRANSFER_ABOVE_BYTES = 1 << 20

export class WorkerPool {
  readonly size: number

  #workers: Worker[] = []
  #pending = new Map<number, Pending>()
  #streams = new Map<number, Stream>()
  #metrics = new Map<number, (reply: WorkerMetrics) => void>()
  #positions = new Map<number, (streams: { conn: string; stream: number; txid: string }[]) => void>()
  #follows = new Map<
    number,
    (streams: { stream: number; db: string; applied: string; bootstrapping: boolean }[]) => void
  >()
  #dbs = new Map<number, (open: { name: string; txid: string }[]) => void>()
  #shutdowns = new Map<number, () => void>()
  #seq = 0
  #host: RouterHost | null = null
  #replication: ReplicationHost | null = null
  /** C3b: one `FollowHost` per upstream, because a node may follow several primaries at once. */
  #follow = new Map<number, FollowHost>()
  #cluster: ClusterHost | null = null
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
    // L3: `[data] maxOpen` is the **node's** ceiling, not each thread's. Bun workers are threads
    // sharing one descriptor table, so eight registries each honouring 1024 held 8192 databases
    // and about 57 000 descriptors while each one independently warned about 7 168 — the check
    // under-reported by exactly the worker count. The router divides the budget and probes once.
    const share = maxOpenShare(config.data.maxOpen, size)
    const shardConfig: ServerConfig = { ...config, data: { ...config.data, maxOpen: share } }
    warnFdBudget(config.data.maxOpen, (message) => console.warn(message))
    if (maxOpenThrashes(config.data.maxOpen, size)) {
      console.warn(
        `bunql: maxOpen ${config.data.maxOpen} across ${size} workers is ${share} databases per ` +
          `shard, which will evict and reopen on most requests. Raise maxOpen to at least ` +
          `${size * 8} or lower workers.`,
      )
    }
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
      worker.postMessage({ kind: "init", index, workers: size, config: shardConfig } satisfies ToWorker)
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
    const headers = flattenHeaders(request.headers)
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
    // A body big enough to be worth it is **transferred** rather than cloned: structured clone
    // copies, and `POST /v1/db/{db}/import` is a whole SQLite file. Transferring detaches the
    // router's `ArrayBuffer`, which is exactly right here — the buffer came from
    // `request.arrayBuffer()`, nothing else views it, and the router never reads it again.
    //
    // Small bodies stay cloned, and P6 **measured** that rather than assuming it: transferring
    // every body, in one direction or both, is worth nothing on a read and possibly a little less
    // than nothing. A query body is forty bytes, and taking ownership of a buffer is not cheaper
    // than copying forty bytes. `docs/p6-router-resolution.md` §5.
    const transfer =
      body !== null && body.byteLength >= TRANSFER_ABOVE_BYTES ? [body.buffer as ArrayBuffer] : undefined
    this.#post(
      index,
      { kind: "http", id, method: request.method, url: request.url, headers, body },
      transfer,
    )
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

  // ── the replication relay (C4b) ──────────────────────────────────────────────────────────────

  /** Adopts a replica connection the router has authenticated on one worker. */
  replAdopt(index: number, conn: string, node: string): void {
    this.#post(index, { kind: "repl.adopt", conn, node })
  }

  /** One decoded frame for the worker that owns the stream it names. */
  replFrame(index: number, conn: string, type: number, body: Uint8Array): void {
    this.#post(index, { kind: "repl.frame", conn, type, body })
  }

  replGone(index: number, conn: string, node: string): void {
    this.#post(index, { kind: "repl.gone", conn, node })
  }

  /**
   * The heartbeat gather: every worker's stream positions, and R7's announcement pushed the other
   * way in the same message. Once per `heartbeatMs` for the whole node, not once per stream.
   */
  async replPositions(
    generations: [string, string][],
  ): Promise<{ conn: string; stream: number; txid: string }[]> {
    const out: { conn: string; stream: number; txid: string }[] = []
    await Promise.all(
      this.#workers.map(
        (_, index) =>
          new Promise<void>((resolve) => {
            const id = this.#seq++
            const timer = setTimeout(() => {
              this.#positions.delete(id)
              resolve()
            }, 2000)
            timer.unref?.()
            this.#positions.set(id, (streams) => {
              clearTimeout(timer)
              out.push(...streams)
              resolve()
            })
            this.#post(index, { kind: "repl.positions", id, generations })
          }),
      ),
    )
    return out
  }

  /** Where the `ReplicationRouter` plugs in, so this module never imports it. */
  setReplicationHost(host: ReplicationHost | null): void {
    this.#replication = host
  }

  // ── following an upstream (C4c) ──────────────────────────────────────────────────────────────

  /** Follow `db` on the stream the router minted; the worker opens the copy and sends `SUBSCRIBE`. */
  followStart(
    index: number,
    up: number,
    stream: number,
    db: string,
    generation: string | null,
    reset: boolean,
  ): void {
    this.#post(index, { kind: "follow.start", up, stream, db, generation, reset })
  }

  /** One decoded frame — `SNAPSHOT_*` or `TXN` — for the worker that owns the stream it names. */
  followFrame(index: number, up: number, type: number, body: Uint8Array): void {
    this.#post(index, { kind: "follow.frame", up, type, body })
  }

  followStop(
    index: number,
    up: number,
    stream: number,
    db: string,
    drop: boolean,
    reason: string,
  ): void {
    this.#post(index, { kind: "follow.stop", up, stream, db, drop, reason })
  }

  /** The connection-level facts, to every worker: they change on connect, close and retarget. */
  followLink(
    up: number,
    state: { connected: boolean; primary: string; node: string | null; lastError: string | null },
  ): void {
    for (let index = 0; index < this.#workers.length; index++) {
      try {
        this.#post(index, { kind: "follow.link", up, ...state })
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  /** The generation ledger, to every worker, after every save. */
  followGenerations(up: number, entries: [string, string][]): void {
    for (let index = 0; index < this.#workers.length; index++) {
      try {
        this.#post(index, { kind: "follow.generations", up, entries })
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  followResult(index: number, message: Omit<FollowResult, "kind">): void {
    this.#post(index, { kind: "follow.result", ...message })
  }

  /**
   * The heartbeat gather: every worker's stream positions, with the upstream's own positions
   * pushed the other way in the same message. Once per `heartbeatMs` for the whole node.
   */
  async followStatus(
    up: number,
    primary: [number, string][],
  ): Promise<{ stream: number; db: string; applied: string; bootstrapping: boolean }[]> {
    const out: { stream: number; db: string; applied: string; bootstrapping: boolean }[] = []
    await Promise.all(
      this.#workers.map(
        (_, index) =>
          new Promise<void>((resolve) => {
            const id = this.#seq++
            const timer = setTimeout(() => {
              this.#follows.delete(id)
              resolve()
            }, 2000)
            timer.unref?.()
            this.#follows.set(id, (streams) => {
              clearTimeout(timer)
              out.push(...streams)
              resolve()
            })
            this.#post(index, { kind: "follow.status", up, id, primary })
          }),
      ),
    )
    return out
  }

  /** Where a `"routed"` `ReplicaClient` plugs in, so this module never imports it. */
  setFollowHost(up: number, host: FollowHost | null): void {
    if (host) this.#follow.set(up, host)
    else this.#follow.delete(up)
  }

  /** Every upstream's host, forgotten. Called when the pool closes. */
  clearFollowHosts(): void {
    this.#follow.clear()
  }

  // ── the control plane (C4d) ──────────────────────────────────────────────────────────────────

  /** One shard's slice of the replicated state. A few a second, never per write. */
  clusterView(index: number, push: ClusterViewPush): void {
    this.#post(index, push)
  }

  /** One leg of the clock probe. The router stamps before this and again when the reply lands. */
  clusterProbe(index: number, id: number, t1: number): void {
    this.#post(index, { kind: "cluster.probe", id, t1 })
  }

  /**
   * A lower bound on (the worker's clock − the router's), which is what lets a worker convert a
   * deadline this thread stamped. Its own envelope rather than a field on `cluster.view`, because
   * a probe answers on its own schedule and an offset must be able to arrive without one.
   */
  clusterOffset(index: number, lower: number): void {
    this.#post(index, { kind: "cluster.offset", lower })
  }

  clusterProposed(index: number, id: number, reply: { ok: boolean; reason?: string }): void {
    this.#post(index, { kind: "cluster.proposed", id, ...reply })
  }

  clusterPromoted(index: number, id: number, outcome: PromotionOutcome): void {
    this.#post(index, { kind: "cluster.promoted", id, outcome })
  }

  /** Where `ClusterShards` plugs in, so this module never imports the control plane. */
  setClusterHost(host: ClusterHost | null): void {
    this.#cluster = host
  }

  // ── metrics and shutdown ─────────────────────────────────────────────────────────────────────

  /**
   * Every worker's counters, added together, plus its share of the LRU and of replication.
   *
   * The replication rule (C4b): `records` sums, because a `TXN` is emitted by exactly one worker;
   * `lagTxid` takes the max, because it is already a max over streams. `connected` and `bytes` are
   * *not* here — the router owns every socket and writes every byte, so it counts both itself and
   * a worker's view of either would be a different quantity wearing the same name.
   */
  async gather(): Promise<{
    metrics: Metrics
    registry: RegistryShare
    replication: { lagTxid: number; records: number } | null
    storage: StorageMetrics | null
  }> {
    const merged = new Metrics()
    const registry: RegistryShare = {
      open: 0,
      tenants: 0,
      evictions: 0,
      writeQueueDepth: 0,
      pinned: 0,
      openRefused: 0,
      fsync: null,
    }
    let replication: { lagTxid: number; records: number } | null = null
    let storage: StorageMetrics | null = null
    await Promise.all(
      this.#workers.map(
        (_, index) =>
          new Promise<void>((resolve) => {
            const id = this.#seq++
            this.#metrics.set(id, (reply) => {
              merged.absorb(reply.metrics)
              registry.open += reply.registry.open
              registry.evictions += reply.registry.evictions
              registry.writeQueueDepth += reply.registry.writeQueueDepth
              registry.pinned += reply.registry.pinned
              registry.openRefused += reply.registry.openRefused
              // One sweep per thread, so the node's numbers are the sum of its threads' — except
              // the pass duration, which is a duration and takes the worst.
              if (reply.registry.fsync) {
                const seen = reply.registry.fsync
                const merged = (registry.fsync ??= {
                  total: 0,
                  lastDurationUs: 0,
                  pending: 0,
                  deferred: 0,
                })
                merged.total += seen.total
                merged.pending += seen.pending
                merged.deferred += seen.deferred
                merged.lastDurationUs = Math.max(merged.lastDurationUs, seen.lastDurationUs)
              }
              registry.tenants = Math.max(registry.tenants, reply.registry.tenants)
              if (reply.replication) {
                replication ??= { lagTxid: 0, records: 0 }
                replication.records += reply.replication.records
                replication.lagTxid = Math.max(replication.lagTxid, reply.replication.lagTxid)
              }
              // The shards hold disjoint databases, so this is the same merge a single-threaded
              // node already does over its own: the highest position, and the rest added up.
              if (reply.storage) {
                storage ??= { shippedTxid: 0, pendingRecords: 0, errors: 0, bytes: 0, behind: 0 }
                storage.shippedTxid = Math.max(storage.shippedTxid, reply.storage.shippedTxid)
                storage.pendingRecords += reply.storage.pendingRecords
                storage.errors += reply.storage.errors
                storage.bytes += reply.storage.bytes
                storage.behind += reply.storage.behind
              }
              resolve()
            })
            this.#post(index, { kind: "metrics", id })
          }),
      ),
    )
    return { metrics: merged, registry, replication, storage }
  }

  /**
   * Every database the workers hold open, with the txid each has actually reached. The router owns
   * no tenant, so this is the only way `GET /v1/db` can report either honestly (C4e).
   */
  async openDatabases(): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>()
    await Promise.all(
      this.#workers.map(
        (_, index) =>
          new Promise<void>((resolve) => {
            const id = this.#seq++
            const timer = setTimeout(() => {
              this.#dbs.delete(id)
              resolve()
            }, 2000)
            timer.unref?.()
            this.#dbs.set(id, (open) => {
              clearTimeout(timer)
              for (const one of open) out.set(one.name, BigInt(one.txid))
              resolve()
            })
            this.#post(index, { kind: "dbs", id })
          }),
      ),
    )
    return out
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

  #post(index: number, message: ToWorker, transfer?: ArrayBuffer[]): void {
    const worker = this.#workers[index]
    if (!worker) throw new Error(`no worker ${index}`)
    if (transfer && transfer.length > 0) worker.postMessage(message, transfer as unknown as never)
    else worker.postMessage(message)
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
            headers: unflattenHeaders(message.headers),
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
        pending.resolve(
          new Response(stream, { status: message.status, headers: unflattenHeaders(message.headers) }),
        )
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
      case "role":
        this.#host?.roleChanged(message.db, message.role)
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
      case "repl.out":
        this.#replication?.out(message.conn, message.bytes)
        return
      case "repl.shut":
        this.#replication?.shut(message.conn, message.code, message.reason)
        return
      case "repl.announce":
        this.#replication?.announce()
        return
      case "repl.positions.reply": {
        const waiting = this.#positions.get(message.id)
        this.#positions.delete(message.id)
        waiting?.(message.streams)
        return
      }
      case "follow.out":
        this.#follow.get(message.up)?.out(message.bytes)
        return
      case "follow.installed":
        this.#follow.get(message.up)?.installed(message.stream, message.db, message.txid)
        return
      case "follow.again":
        this.#follow.get(message.up)?.again(message.stream, message.db, message.reason)
        return
      case "follow.stopped":
        this.#follow.get(message.up)?.stopped(message.db, message.trash)
        return
      case "follow.forward":
        this.#follow.get(message.up)?.forwardFrom(index, message.id, {
          db: message.db,
          op: message.op,
          body: message.body,
        })
        return
      case "follow.detach":
        this.#follow.get(message.up)?.detach(message.db)
        return
      case "follow.attach":
        this.#follow.get(message.up)?.attach(message.db)
        return
      case "follow.primary":
        this.#follow.get(message.up)?.followPrimary(message.url)
        return
      case "cluster.probe.reply":
        this.#cluster?.probed(index, message.t1, message.t2)
        return
      case "cluster.owned":
        this.#cluster?.owned(index, message.dbs)
        return
      case "cluster.propose":
        void this.#cluster?.propose(index, message.id, message.command).catch(this.#onError)
        return
      case "cluster.promote":
        void this.#cluster?.promote(index, message.id, message.request).catch(this.#onError)
        return
      case "follow.status.reply": {
        const waiting = this.#follows.get(message.id)
        this.#follows.delete(message.id)
        waiting?.(message.streams)
        return
      }
      case "metrics.reply": {
        const waiting = this.#metrics.get(message.id)
        this.#metrics.delete(message.id)
        waiting?.({
          metrics: message.metrics,
          registry: message.registry,
          replication: message.replication ?? null,
          storage: message.storage ?? null,
        })
        return
      }
      case "dbs.reply": {
        const waiting = this.#dbs.get(message.id)
        this.#dbs.delete(message.id)
        waiting?.(message.open)
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
  /** Writes queued across this thread's tenants; disjoint shards, so it sums (L2). */
  writeQueueDepth: number
  /** Pinned tenants on this thread, and opens it refused because they all were (L4). */
  pinned: number
  openRefused: number
  /** This thread's fsync sweep, when it has one. Null on every thread means the node has none. */
  fsync: { total: number; lastDurationUs: number; pending: number; deferred: number } | null
}

/** One worker's answer to a `metrics` ask. */
interface WorkerMetrics {
  metrics: MetricsState
  registry: RegistryShare
  replication: { lagTxid: number; records: number } | null
  storage: StorageMetrics | null
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
