// The replica half of `/v1/replication`: one `ReplicaClient` per node, one WebSocket to the
// primary, one stream per database this node follows.
//
// Invariant: a record is acked only after it is applied *and* the position is persisted. The
// applier writes the frames, fdatasyncs them and rewrites `meta.json` before `applyRecord`
// returns, so an `ACK` this client sends is a promise the replica can keep across a crash — which
// is exactly what R2's `ack: "replica"` will be built on.
//
// Second invariant: the client never holds a position it cannot prove. A snapshot is written to a
// temp file, hashed, and only then moved into place; an apply that fails verification leaves the
// database untouched and the stream re-subscribes from zero, which gets it a fresh snapshot.
//
// Third invariant (R7): the client holds no copy the primary has stopped announcing, and no copy
// of a database that has since been re-created. A name is not an identity, so every copy is
// recorded against the primary's generation id for it; a database that leaves the announcement is
// dropped through the registry's delete path, and one whose id has changed is dropped and
// bootstrapped again from zero. See `docs/r7-unfollow.md`.

import fs from "node:fs"
import path from "node:path"
import type { Tenant, TenantRegistry } from "../tenant/index.ts"
import { decode, type TxnRecord } from "../wal/index.ts"
import {
  ACK_FSYNCED,
  decodeJson,
  type ForwardBody,
  decodeSnapshotChunk,
  encodeAck,
  encodeJson,
  FATAL_CODES,
  FRAME,
  FrameReader,
  frameName,
  type ErrorBody,
  generationId,
  type HeartbeatBody,
  type HelloBody,
  makeProof,
  ProtocolError,
  PROTO_VERSION,
  type ResultBody,
  type SnapshotBeginBody,
  type SnapshotEndBody,
  type SubscribeBody,
  type SubscribedBody,
  type UnsubscribeBody,
} from "./protocol.ts"

/**
 * Operational news from the replication client rather than a fault in this process, so the
 * handlers that print one of these leave the stack out — a stack trace on a primary that is simply
 * down is the same noise a deliberate `503` would be.
 *
 * `src/server/runtime.ts` still narrows on `ReplicaOffline` specifically; widening that check to
 * this base is the one-line follow-up noted at the end of `docs/r7-unfollow.md`.
 */
export class ReplicaNotice extends Error {
  constructor(message: string, name = "ReplicaNotice") {
    super(message)
    this.name = name
  }
}

/** "This replica is not connected, and here is why." */
export class ReplicaOffline extends ReplicaNotice {
  constructor(message: string) {
    super(message, "ReplicaOffline")
  }
}

/**
 * "This replica has let a database go, and here is why." The class of event that made the stale-
 * replica bug expensive to find was precisely one that logged nothing, so a drop says so out loud
 * — and lands in `status().unfollowed` besides.
 */
export class ReplicaUnfollowed extends ReplicaNotice {
  constructor(message: string) {
    super(message, "ReplicaUnfollowed")
  }
}

/** Who this module pins tenants as, so it never releases the realtime engine's pin. */
const PIN_OWNER = "replication"

/** Ceiling for the reconnect backoff, per `plan-phase1.md`. */
const MAX_RECONNECT_MS = 10_000

/** How many drops `status()` keeps. Enough to explain a surprise, small enough to be a status. */
const MAX_UNFOLLOWED = 16

/** Where the client remembers which generation each local copy is a copy of. */
const GENERATIONS_FILE = "generations.json"

/** The minimum this client accepts from a `WebSocket` implementation. */
export interface ClientSocket {
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  binaryType: string
  addEventListener(type: string, listener: (event: never) => void): void
}

export type SocketFactory = (url: string) => ClientSocket

export interface ReplicaClientOptions {
  registry: TenantRegistry
  /** `wss://primary/v1/replication`. */
  primary: string
  secret: string
  /** This node's id, sent in `HELLO`. */
  node: string
  /** Database names, or `["*"]` for every database the primary announces. */
  follow?: string[]
  /** First backoff step; doubles with jitter up to 10 s. Default 250 ms. */
  reconnectMs?: number
  heartbeatMs?: number
  /** Where snapshot temp files go. Defaults to `<dataDir>/bootstrap`. */
  bootstrapDir?: string
  onError?: (err: unknown) => void
  /** Injectable for the tests; defaults to the global `WebSocket`. */
  factory?: SocketFactory
  /** R2: how long a forwarded write waits for the primary's `RESULT`. Default 10 s. */
  forwardTimeoutMs?: number
  /** R2: forwarded writes in flight at once. Past this, `forward` throws `BUSY`. Default 256. */
  maxForwards?: number
}

/** A write this node could not take, on its way to the primary (R2). */
export interface ForwardRequest {
  db: string
  /** `query`, `batch`, `tx.begin`, `tx.exec`, `tx.commit` or `tx.rollback`. */
  op: string
  body: unknown
}

/** Extra fields a forwarded failure carries back, when the primary knew them. */
export interface ForwardErrorDetails {
  txid?: number
  failedIndex?: number
}

/** What the primary answered, re-raised by the caller as if it had happened locally. */
export class ForwardError extends Error {
  readonly code: string
  readonly status: number | undefined
  readonly details: ForwardErrorDetails | undefined

  constructor(code: string, message: string, status?: number, details?: ForwardErrorDetails) {
    super(message)
    this.name = "ForwardError"
    this.code = code
    this.status = status
    this.details = details
  }
}

export interface StreamStatus {
  db: string
  /** Last txid applied locally. */
  applied: number
  /** How far behind the primary's last heartbeat that leaves this node. */
  lagTxid: number
  /** True while a snapshot is being received. */
  bootstrapping: boolean
  /** The primary's generation id for this copy, or null against a peer that announces none. */
  generation: string | null
}

/** A database this node has let go of, and why. */
export interface UnfollowedDatabase {
  db: string
  atMs: number
  reason: string
  /** Where the local copy went, when the registry's delete path produced a trash directory. */
  trash: string | null
}

export interface ReplicaStatus {
  connected: boolean
  primary: string
  node: string | null
  streams: StreamStatus[]
  /** The last few drops, oldest first. A silent drop is what R7 exists to stop. */
  unfollowed: UnfollowedDatabase[]
  lastError: string | null
}

interface Bootstrap {
  begin: SnapshotBeginBody
  file: string
  fd: number
  bytes: number
  seq: number
}

/** One forwarded write waiting for its `RESULT`. */
interface Forward {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface Stream {
  id: number
  db: string
  tenant: Tenant | null
  /**
   * The generation id the primary named in `SUBSCRIBED` for this stream. Held here until the copy
   * it describes actually exists locally — at `SNAPSHOT_END` for a bootstrap, immediately for a
   * stream the primary accepted from our own position — and only then recorded against the copy.
   */
  generation: string | null
  /** The primary's txid as of its last heartbeat, for the lag figure. */
  primaryTxid: bigint
  bootstrap: Bootstrap | null
  /** Records that arrived while the tenant was busy; retried on the next tick. */
  deferred: { record: TxnRecord; bytes: Uint8Array }[]
  retrying: boolean
}

export class ReplicaClient {
  readonly registry: TenantRegistry
  readonly primary: string
  readonly secret: string
  readonly node: string
  readonly reconnectMs: number
  readonly heartbeatMs: number
  readonly bootstrapDir: string

  /** Bytes received, for `bunql_replication_bytes_total`. */
  bytesReceived = 0
  /** Records applied, for `bunql_replication_records_total`. */
  recordsApplied = 0

  #follow: string[]
  #factory: SocketFactory
  #onError: (err: unknown) => void

  #socket: ClientSocket | null = null
  #reader = new FrameReader()
  #streams = new Map<number, Stream>()
  #byDb = new Map<string, Stream>()
  /**
   * `db -> generation id` for every local copy this client holds, persisted beside the bootstrap
   * temp files. It is both the identity check and the record of *which* databases this node
   * follows, which is what lets a drop survive a restart: a replica that comes back up after the
   * primary deleted a database has no stream to notice is missing, but it still has this.
   *
   * This is the stand-in for the catalog column `docs/r7-unfollow.md` argues for. The three
   * methods below are its only readers and writers.
   */
  #generations = new Map<string, string>()
  #unfollowed: UnfollowedDatabase[] = []
  /** So an empty announcement is reported once, not at every heartbeat while it persists. */
  #emptyAnnouncementReported = false
  /** Has this connection carried a non-empty announcement yet? See `#resolveFollow`. */
  #sawDatabases = false
  #nextStream = 1
  #connected = false
  #handshook = false
  /** Has this client ever completed a handshake with this primary? Distinguishes a dropped link
   * from a primary that will never accept us — only the second is worth explaining over HTTP. */
  #everHandshook = false
  #primaryNode: string | null = null
  #lastError: string | null = null
  #attempt = 0
  #retry: ReturnType<typeof setTimeout> | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #stopped = false
  readonly forwardTimeoutMs: number
  readonly maxForwards: number
  #forwards = new Map<number, Forward>()
  #nextForward = 1

  constructor(options: ReplicaClientOptions) {
    this.registry = options.registry
    this.primary = options.primary
    this.secret = options.secret
    this.node = options.node
    this.reconnectMs = options.reconnectMs ?? 250
    this.heartbeatMs = options.heartbeatMs ?? 5000
    this.bootstrapDir = options.bootstrapDir ?? path.join(options.registry.dir, "bootstrap")
    this.#follow = options.follow?.length ? [...options.follow] : ["*"]
    this.#onError =
      options.onError ??
      ((err: unknown) =>
        err instanceof ReplicaOffline
          ? console.error(`bunql: ${err.message}`)
          : console.error("bunql: replica", err))
    this.#factory =
      options.factory ??
      ((url: string) => new WebSocket(url) as unknown as ClientSocket)
    this.forwardTimeoutMs = options.forwardTimeoutMs ?? 10_000
    this.maxForwards = options.maxForwards ?? 256
    this.#loadGenerations()
  }

  // ── generation ledger ────────────────────────────────────────────────────────────────────────

  #generationsPath(): string {
    return path.join(this.bootstrapDir, GENERATIONS_FILE)
  }

  /** Best effort: a ledger that cannot be read leaves this node protected by name alone. */
  #loadGenerations(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.#generationsPath(), "utf8")
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [db, generation] of Object.entries(parsed)) {
        if (typeof generation === "string" && generation.length > 0) {
          this.#generations.set(db, generation)
        }
      }
    } catch (err) {
      this.#onError(err)
    }
  }

  /** Temp file then rename, so a crash mid-write leaves the previous ledger rather than none. */
  #saveGenerations(): void {
    const file = this.#generationsPath()
    const temp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(this.bootstrapDir, { recursive: true })
      fs.writeFileSync(temp, `${JSON.stringify(Object.fromEntries(this.#generations), null, 2)}\n`)
      fs.renameSync(temp, file)
    } catch (err) {
      fs.rmSync(temp, { force: true })
      this.#onError(err)
    }
  }

  #recordGeneration(db: string, generation: string | null): void {
    if (!generation || this.#generations.get(db) === generation) return
    this.#generations.set(db, generation)
    this.#saveGenerations()
  }

  #forgetGeneration(db: string): void {
    if (!this.#generations.delete(db)) return
    this.#saveGenerations()
  }

  /** Forwarded writes waiting on the primary right now. */
  get inflightForwards(): number {
    return this.#forwards.size
  }

  /**
   * Hands a write to the primary over the socket this node already holds (R2, frames `FORWARD`
   * and `RESULT`) and resolves with the primary's own result.
   *
   * Rejects with `ForwardError`: `NOT_PRIMARY` when there is no socket to forward over — which is
   * the same answer the caller would have given without forwarding at all — `BUSY` past
   * `maxForwards` in flight, and `FORWARD_TIMEOUT` when the primary does not answer. Any failure
   * the *primary* raised comes back under its own code, never wrapped.
   */
  forward(request: ForwardRequest): Promise<unknown> {
    if (!this.connected) {
      return Promise.reject(
        new ForwardError(
          "NOT_PRIMARY",
          `this node is not connected to ${this.primary}, so it cannot forward the write`,
          503,
        ),
      )
    }
    if (this.#forwards.size >= this.maxForwards) {
      return Promise.reject(
        new ForwardError(
          "BUSY",
          `${this.maxForwards} writes are already in flight to the primary`,
          503,
        ),
      )
    }
    const id = this.#nextForward++
    return new Promise<unknown>((resolve, reject) => {
      const pending: Forward = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#forwards.delete(id)
          reject(
            new ForwardError(
              "FORWARD_TIMEOUT",
              `the primary did not answer the forwarded ${request.op} in ${this.forwardTimeoutMs}ms`,
              504,
            ),
          )
        }, this.forwardTimeoutMs),
      }
      pending.timer.unref?.()
      this.#forwards.set(id, pending)
      this.#send(
        encodeJson(FRAME.FORWARD, {
          id,
          db: request.db,
          op: request.op,
          body: request.body,
        } satisfies ForwardBody),
      )
    })
  }

  /** Fails every forward still waiting; the socket they were riding is gone. */
  #failForwards(message: string): void {
    if (this.#forwards.size === 0) return
    const pending = [...this.#forwards.values()]
    this.#forwards.clear()
    for (const one of pending) {
      clearTimeout(one.timer)
      one.reject(new ForwardError("NOT_PRIMARY", message, 503))
    }
  }

  get connected(): boolean {
    return this.#connected && this.#handshook
  }

  /** Databases this node has a stream for. */
  get followed(): string[] {
    return [...this.#byDb.keys()]
  }

  /** What `GET /v1/db/:db/replication` and `/metrics` report on a replica. */
  status(): ReplicaStatus {
    const streams: StreamStatus[] = []
    for (const stream of this.#byDb.values()) {
      const applied = stream.tenant && !stream.tenant.closed ? stream.tenant.txid : 0n
      const lag = stream.primaryTxid > applied ? stream.primaryTxid - applied : 0n
      streams.push({
        db: stream.db,
        applied: Number(applied),
        lagTxid: Number(lag),
        bootstrapping: stream.bootstrap !== null,
        generation: this.#generations.get(stream.db) ?? null,
      })
    }
    return {
      connected: this.connected,
      primary: this.primary,
      node: this.#primaryNode,
      streams,
      unfollowed: [...this.#unfollowed],
      lastError: this.#lastError,
    }
  }

  /** The worst lag across every stream, for the metrics gauge. */
  get maxLagTxid(): number {
    let worst = 0
    for (const stream of this.status().streams) {
      if (stream.lagTxid > worst) worst = stream.lagTxid
    }
    return worst
  }

  /** Opens the connection. Returns immediately; the first attempt runs on this tick. */
  start(): void {
    if (this.#stopped) return
    this.#connect()
  }

  /** Closes the socket and stops reconnecting. Tenants stay open; the registry owns them. */
  stop(): void {
    this.#stopped = true
    if (this.#retry !== null) {
      clearTimeout(this.#retry)
      this.#retry = null
    }
    this.#stopHeartbeat()
    this.#failForwards(`${this.node} stopped following ${this.primary}`)
    const socket = this.#socket
    this.#socket = null
    this.#connected = false
    this.#handshook = false
    for (const stream of this.#streams.values()) this.#abortBootstrap(stream)
    this.#streams.clear()
    this.#byDb.clear()
    if (socket) {
      try {
        socket.close(1000, "stopping")
      } catch {
        // Already closed.
      }
    }
  }

  /** Resolves once every followed database has applied at least `txid`. For tests and `readyz`. */
  async waitForTxid(db: string, txid: bigint, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const stream = this.#byDb.get(db)
      const tenant = stream?.tenant
      if (tenant && !tenant.closed && tenant.txid >= txid) return
      if (Date.now() > deadline) {
        throw new Error(
          `${db} did not reach txid ${txid} in ${timeoutMs}ms (at ${tenant?.txid ?? "no stream"})`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // ── connection ───────────────────────────────────────────────────────────────────────────────

  #connect(): void {
    if (this.#stopped || this.#socket) return
    this.#reader = new FrameReader()
    this.#handshook = false
    let socket: ClientSocket
    try {
      socket = this.#factory(this.primary)
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err)
      this.#scheduleRetry()
      return
    }
    this.#socket = socket
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", (() => {
      this.#connected = true
      this.#attempt = 0
    }) as (event: never) => void)
    socket.addEventListener("message", ((event: { data: unknown }) => {
      this.#onMessage(event.data)
    }) as unknown as (event: never) => void)
    socket.addEventListener("error", (() => {
      // `close` always follows, and it is where the retry is scheduled; recording the reason here
      // is the only thing this handler is for. A browser-style `error` event carries no detail.
      this.#lastError = `could not reach ${this.primary}`
    }) as (event: never) => void)
    socket.addEventListener("close", ((event: { code?: number; reason?: string }) => {
      // A close that carries a reason is the primary telling us why; keep it over the generic
      // message the `error` handler wrote, since it is the only detail we will ever get.
      if (event?.reason) this.#lastError = `${this.primary} closed the socket: ${event.reason}`
      this.#onClose()
    }) as unknown as (event: never) => void)
  }

  /**
   * Says out loud that this replica is not connected.
   *
   * A failed upgrade reaches a WebSocket client as a bare `close`, with the HTTP status that
   * caused it nowhere in sight — so a node pointed at a primary whose `[replication] secret` is
   * empty retries forever against a `403 REPLICATION_DISABLED` it cannot see, logs nothing, and
   * simply answers `GET /v1/db` with an empty list. That is a configuration mistake that looks
   * exactly like an empty cluster, and finding it by hand takes far longer than it should.
   *
   * So: report the first failure immediately, and afterwards only on attempts that are powers of
   * two, which gives an operator prompt notice and then a slow drumbeat instead of a log filled
   * at the reconnect interval. On the first failure, and only for a primary this client has never
   * once handshaken with, ask the same URL over plain HTTP what it would have said — one request,
   * never repeated, never allowed to throw, and never made for a link that merely dropped.
   */
  #reportDisconnected(): void {
    const attempt = this.#attempt
    if (attempt > 1 && (attempt & (attempt - 1)) !== 0) return
    const detail = this.#lastError ?? `could not reach ${this.primary}`
    this.#onError(
      new ReplicaOffline(
        `replica of ${this.primary} is not connected (attempt ${attempt}): ${detail}`,
      ),
    )
    if (attempt === 1 && !this.#everHandshook) void this.#explainOnce()
  }

  /** Asks the replication URL over HTTP why the upgrade failed, so the reason reaches the log. */
  async #explainOnce(): Promise<void> {
    try {
      const url = this.primary.replace(/^ws/, "http")
      const response = await fetch(url, { headers: { accept: "application/json" } })
      if (response.ok) return
      const body = (await response.text()).slice(0, 200)
      const reason = `${this.primary} answered ${response.status} to the upgrade: ${body}`
      this.#lastError = reason
      this.#onError(new ReplicaOffline(reason))
    } catch {
      // The primary is simply unreachable, which the message already said.
    }
  }

  #onClose(): void {
    this.#socket = null
    this.#connected = false
    this.#handshook = false
    // Per connection: a primary that comes back announcing nothing has to prove it holds
    // databases again before this client will act on an empty announcement from it.
    this.#sawDatabases = false
    this.#emptyAnnouncementReported = false
    this.#stopHeartbeat()
    this.#failForwards(`the connection to ${this.primary} closed before the write was answered`)
    for (const stream of this.#streams.values()) this.#abortBootstrap(stream)
    // The stream table is rebuilt on the next handshake; the *positions* live in the tenants, so
    // nothing is lost by forgetting it.
    this.#streams.clear()
    this.#byDb.clear()
    this.#scheduleRetry()
  }

  /** Exponential backoff with full jitter, from `reconnectMs` to 10 s. */
  #scheduleRetry(): void {
    if (this.#stopped || this.#retry !== null) return
    const base = Math.min(this.reconnectMs * 2 ** this.#attempt, MAX_RECONNECT_MS)
    this.#attempt += 1
    const delay = base / 2 + Math.random() * (base / 2)
    this.#reportDisconnected()
    this.#retry = setTimeout(() => {
      this.#retry = null
      this.#connect()
    }, delay)
    this.#retry.unref?.()
  }

  #onMessage(data: unknown): void {
    let frames
    try {
      frames = this.#reader.push(data as ArrayBuffer)
    } catch (err) {
      this.#fail(err)
      return
    }
    for (const frame of frames) {
      this.bytesReceived += frame.body.byteLength + 5
      try {
        this.#handle(frame.type, frame.body)
      } catch (err) {
        this.#onError(err)
        this.#lastError = err instanceof Error ? err.message : String(err)
        if (err instanceof ProtocolError) {
          this.#fail(err)
          return
        }
      }
    }
  }

  #fail(err: unknown): void {
    this.#lastError = err instanceof Error ? err.message : String(err)
    this.#onError(err)
    try {
      this.#socket?.close(1002, "protocol error")
    } catch {
      // The close handler schedules the retry either way.
    }
  }

  #send(frame: Uint8Array): void {
    const socket = this.#socket
    if (!socket) return
    try {
      socket.send(frame)
    } catch (err) {
      this.#onError(err)
    }
  }

  // ── frames ───────────────────────────────────────────────────────────────────────────────────

  #handle(type: number, body: Uint8Array): void {
    switch (type) {
      case FRAME.HELLO:
        this.#hello(decodeJson<HelloBody>(type, body))
        return
      case FRAME.SUBSCRIBED:
        this.#subscribed(decodeJson<SubscribedBody>(type, body))
        return
      case FRAME.SNAPSHOT_BEGIN:
        this.#snapshotBegin(decodeJson<SnapshotBeginBody>(type, body))
        return
      case FRAME.SNAPSHOT_CHUNK:
        this.#snapshotChunk(body)
        return
      case FRAME.SNAPSHOT_END:
        this.#snapshotEnd(decodeJson<SnapshotEndBody>(type, body))
        return
      case FRAME.TXN:
        this.#txn(body)
        return
      case FRAME.HEARTBEAT:
        this.#heartbeatIn(decodeJson<HeartbeatBody>(type, body))
        return
      case FRAME.ERROR:
        this.#errorIn(decodeJson<ErrorBody>(type, body))
        return
      case FRAME.RESULT:
        this.#result(decodeJson<ResultBody>(type, body))
        return
      default:
        throw new ProtocolError(`a primary sent ${frameName(type)}`)
    }
  }

  /** The primary's answer to one forwarded write. */
  #result(body: ResultBody): void {
    const pending = this.#forwards.get(Number(body.id))
    if (!pending) return
    this.#forwards.delete(Number(body.id))
    clearTimeout(pending.timer)
    if (body.ok) {
      pending.resolve(body.result)
      return
    }
    const error = body.error ?? { code: "INTERNAL", message: "the primary refused the write" }
    pending.reject(
      new ForwardError(error.code, error.message, error.status, {
        ...(error.txid !== undefined ? { txid: error.txid } : {}),
        ...(error.failedIndex !== undefined ? { failedIndex: error.failedIndex } : {}),
      }),
    )
  }

  #hello(hello: HelloBody): void {
    if (hello.nonce) {
      if (hello.proto !== PROTO_VERSION) {
        throw new ProtocolError(`the primary speaks replication protocol ${hello.proto}`)
      }
      this.#primaryNode = hello.node
      this.#send(
        encodeJson(FRAME.HELLO, {
          proto: PROTO_VERSION,
          node: this.node,
          proof: makeProof(this.secret, hello.nonce),
        } satisfies HelloBody),
      )
      return
    }
    if (hello.ok !== true) return
    // The handshake is done and the primary has named its databases, which is what `follow: ["*"]`
    // resolves against (docs/r1-replication.md deviation 1).
    this.#handshook = true
    this.#everHandshook = true
    this.#lastError = null
    this.#startHeartbeat()
    this.#resolveFollow(hello.databases ?? [], hello.generations)
  }

  /**
   * Reconciles what this node holds against what the primary announces: drop what has gone, re-
   * bootstrap what has been re-created under the name, subscribe to what is new.
   *
   * The set considered for a drop is every database with a stream *or* a recorded generation, not
   * just the streams. A replica restarted after the primary deleted a database has no stream to
   * find missing; the ledger is what remembers that it holds a copy at all.
   */
  #resolveFollow(announced: string[], generations?: Record<string, string>): void {
    const held = new Set([...this.#byDb.keys(), ...this.#generations.keys()])

    // An empty announcement is the one this client will not take at face value. A primary that is
    // the wrong node, or has restarted against an empty data directory, announces nothing from its
    // very first frame — so an empty announcement is acted on only when this connection has
    // already carried a non-empty one, and only when it would drop a single database. Losing the
    // last database one at a time is ordinary; losing several at once is indistinguishable from a
    // primary that has lost its catalog, and deleting local copies on the strength of that would
    // turn a configuration mistake into data loss.
    if (announced.length > 0) this.#sawDatabases = true
    else if (held.size > 0 && (!this.#sawDatabases || held.size > 1)) {
      if (!this.#emptyAnnouncementReported) {
        this.#emptyAnnouncementReported = true
        this.#onError(
          new ReplicaUnfollowed(
            `${this.primary} announced no databases while this node holds ${held.size} ` +
              `(${[...held].join(", ")}); nothing was dropped — check that it is the right primary`,
          ),
        )
      }
      return
    }
    this.#emptyAnnouncementReported = false

    const live = new Set(announced)

    // Gone from the announcement: the primary deleted it. A name this node follows explicitly but
    // has never been given is not in `held`, so it is never mistaken for a deletion.
    for (const db of held) {
      if (live.has(db)) continue
      this.#unfollow(db, `${db} is no longer announced by ${this.primary}`)
    }

    // Still announced, but a different database now wears the name. The local copy is not a stale
    // copy of this database, it is a copy of another one — drop it outright rather than snapshot
    // over it, so no read is served the old generation's rows in the gap.
    if (generations) {
      for (const db of [...held]) {
        const theirs = generations[db]
        const ours = this.#generations.get(db)
        if (!live.has(db) || !theirs || !ours || theirs === ours) continue
        this.#unfollow(db, `${db} was re-created on ${this.primary}: generation ${ours} -> ${theirs}`)
      }
    }

    const wildcard = this.#follow.includes("*")
    const wanted = wildcard ? announced : this.#follow.filter((db) => live.has(db))
    for (const db of wanted) {
      if (this.#byDb.has(db)) continue
      try {
        this.#subscribe(db)
      } catch (err) {
        this.#onError(err)
        this.#lastError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  /**
   * Lets go of a database: abort any bootstrap, close the stream, release the pin, forget the
   * generation, and dispose of the local copy through the registry's own delete path so the copy
   * is as recoverable as a primary-side delete leaves one — `<dataDir>/trash/<name>-<ms>`, never a
   * bare `rm`.
   *
   * The abort comes first on purpose: an announcement that lands mid-bootstrap must not leave a
   * half-written snapshot in `<dataDir>/bootstrap`.
   */
  #unfollow(db: string, reason: string): void {
    const stream = this.#byDb.get(db)
    if (stream) {
      this.#abortBootstrap(stream)
      this.#streams.delete(stream.id)
      this.#byDb.delete(db)
      this.#send(encodeJson(FRAME.UNSUBSCRIBE, { stream: stream.id } satisfies UnsubscribeBody))
    }
    this.registry.unpin(db, PIN_OWNER)
    this.#forgetGeneration(db)

    let trash: string | null = null
    try {
      // Only a copy this node received as a follower. A database authored here that happens to
      // share the name is somebody else's, whatever the primary announces.
      const row = this.registry.list().find((one) => one.name === db)
      if (row?.role === "replica") trash = this.registry.delete(db)
    } catch (err) {
      this.#onError(err)
    }

    this.#unfollowed.push({ db, atMs: Date.now(), reason, trash })
    if (this.#unfollowed.length > MAX_UNFOLLOWED) this.#unfollowed.shift()
    this.#onError(
      new ReplicaUnfollowed(
        `${reason}; the local copy was ${trash ? `moved to ${trash}` : "not found locally"}`,
      ),
    )
  }

  #subscribe(db: string): void {
    const tenant = this.registry.has(db)
      ? this.registry.openReplica(db)
      : this.registry.createReplica(db)
    const id = this.#nextStream++
    const held = this.#generations.get(db)
    const stream: Stream = {
      id,
      db,
      tenant,
      generation: held ?? null,
      primaryTxid: tenant.txid,
      bootstrap: null,
      deferred: [],
      retrying: false,
    }
    this.#streams.set(id, stream)
    this.#byDb.set(db, stream)
    // Nothing may evict a database with a stream attached: the applier and its position live on
    // the tenant, and reopening it mid-stream would leave a gap nobody would notice.
    this.registry.pin(db, PIN_OWNER)
    this.#send(
      encodeJson(FRAME.SUBSCRIBE, {
        stream: id,
        db,
        fromTxid: tenant.txid.toString(),
        epoch: tenant.epoch,
        checksum: tenant.checksum.toString(),
        // What this node believes its copy is. A primary holding a different id answers with a
        // snapshot however well the txid and checksum line up.
        ...(held ? { generation: held } : {}),
      } satisfies SubscribeBody),
    )
  }

  /** Drops a stream and asks for it again from zero, which always means a snapshot. */
  #resubscribe(stream: Stream): void {
    this.#abortBootstrap(stream)
    this.#streams.delete(stream.id)
    this.#byDb.delete(stream.db)
    this.#send(encodeJson(FRAME.UNSUBSCRIBE, { stream: stream.id }))
    const id = this.#nextStream++
    const next: Stream = {
      id,
      db: stream.db,
      tenant: stream.tenant,
      generation: null,
      primaryTxid: stream.primaryTxid,
      bootstrap: null,
      deferred: [],
      retrying: false,
    }
    this.#streams.set(id, next)
    this.#byDb.set(stream.db, next)
    this.#send(
      encodeJson(FRAME.SUBSCRIBE, {
        stream: id,
        db: stream.db,
        fromTxid: "0",
        epoch: 0,
        checksum: "0",
        // This database is here because an apply did not verify, so its file holds pages from a
        // history the primary does not share. Only a snapshot can settle that, even at txid 0.
        reset: true,
      } satisfies SubscribeBody),
    )
  }

  #subscribed(body: SubscribedBody): void {
    const stream = this.#streams.get(body.stream)
    if (!stream) return
    stream.primaryTxid = big(body.txid)
    const theirs = typeof body.generation === "string" && body.generation ? body.generation : null
    stream.generation = theirs
    if (!theirs) return
    if (body.mode === "snapshot") {
      // The copy this id names does not exist yet; it is recorded when the snapshot installs.
      return
    }
    const ours = this.#generations.get(stream.db)
    if (ours && ours !== theirs) {
      // A peer that does not check generations accepted our position for a database that is not
      // the one we hold. Take the existing re-snapshot path — the same one a RETENTION or a failed
      // apply takes — which asks from zero with `reset`, and can only be answered with a snapshot.
      this.#onError(
        new ReplicaUnfollowed(
          `${stream.db}: the primary streamed generation ${theirs} onto a copy of ${ours}; ` +
            `re-bootstrapping from zero`,
        ),
      )
      this.#forgetGeneration(stream.db)
      this.#resubscribe(stream)
      return
    }
    // The primary verified our txid and checksum against its own history, so this copy *is* that
    // database; record what it is.
    this.#recordGeneration(stream.db, theirs)
  }

  // ── snapshot bootstrap ───────────────────────────────────────────────────────────────────────

  #snapshotBegin(body: SnapshotBeginBody): void {
    const stream = this.#streams.get(body.stream)
    if (!stream) return
    this.#abortBootstrap(stream)
    fs.mkdirSync(this.bootstrapDir, { recursive: true })
    const file = path.join(
      this.bootstrapDir,
      `${stream.db}-${body.txid}-${process.pid}-${stream.id}.db`,
    )
    fs.rmSync(file, { force: true })
    stream.bootstrap = {
      begin: body,
      file,
      fd: fs.openSync(file, "w"),
      bytes: 0,
      seq: 0,
    }
  }

  #snapshotChunk(body: Uint8Array): void {
    const chunk = decodeSnapshotChunk(body)
    const stream = this.#streams.get(chunk.stream)
    const bootstrap = stream?.bootstrap
    if (!stream || !bootstrap) return
    if (chunk.seq !== bootstrap.seq) {
      throw new ProtocolError(
        `${stream.db}: snapshot chunk ${chunk.seq} arrived where ${bootstrap.seq} was expected`,
      )
    }
    const plain = new Uint8Array(Bun.zstdDecompressSync(chunk.compressed))
    fs.writeSync(bootstrap.fd, plain, 0, plain.byteLength, bootstrap.bytes)
    bootstrap.bytes += plain.byteLength
    bootstrap.seq += 1
  }

  #snapshotEnd(body: SnapshotEndBody): void {
    const stream = this.#streams.get(body.stream)
    const bootstrap = stream?.bootstrap
    if (!stream || !bootstrap) return
    fs.fsyncSync(bootstrap.fd)
    fs.closeSync(bootstrap.fd)
    stream.bootstrap = null

    const bytes = fs.readFileSync(bootstrap.file)
    const plain = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const hash = Bun.hash.xxHash3(plain).toString()
    if (hash !== body.hash || plain.byteLength !== bootstrap.begin.bytes) {
      fs.rmSync(bootstrap.file, { force: true })
      throw new ProtocolError(
        `${stream.db}: the snapshot arrived with hash ${hash} and ${plain.byteLength} bytes, ` +
          `the primary sent ${body.hash} and ${bootstrap.begin.bytes}`,
      )
    }

    const begin = bootstrap.begin
    // `installSnapshot` moves the file, closes the tenant and reopens it at the snapshot's
    // position; from here on the stream applies records on top of it.
    stream.tenant = this.registry.installSnapshot(stream.db, {
      file: bootstrap.file,
      txid: big(begin.txid),
      epoch: begin.epoch,
      checksum: big(begin.checksum),
      pages: begin.pages,
      pageSize: begin.pageSize,
    })
    this.registry.pin(stream.db, PIN_OWNER)
    this.#recordGeneration(stream.db, stream.generation)
    this.#ack(stream, big(begin.txid), true)
  }

  #abortBootstrap(stream: Stream): void {
    const bootstrap = stream.bootstrap
    if (!bootstrap) return
    stream.bootstrap = null
    try {
      fs.closeSync(bootstrap.fd)
    } catch {
      // Already closed.
    }
    fs.rmSync(bootstrap.file, { force: true })
  }

  // ── applying ─────────────────────────────────────────────────────────────────────────────────

  #txn(body: Uint8Array): void {
    if (body.byteLength < 4) throw new ProtocolError("TXN body is shorter than its stream id")
    const view = new DataView(body.buffer, body.byteOffset, 4)
    const id = view.getUint32(0, false)
    const stream = this.#streams.get(id)
    if (!stream) return
    // The record has to be copied out of the frame: the frame's backing buffer is the WebSocket
    // message, and the log append below outlives this call.
    const bytes = body.slice(4)
    let record: TxnRecord
    try {
      record = decode(bytes).record
    } catch (err) {
      throw new ProtocolError(
        `${stream.db}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    this.#apply(stream, record, bytes)
  }

  #apply(stream: Stream, record: TxnRecord, bytes: Uint8Array): void {
    const tenant = stream.tenant
    if (!tenant || tenant.closed) return
    try {
      tenant.applyRecord(record, bytes)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "BUSY") {
        // The tenant is snapshotting. Keep the record and retry rather than forcing a re-bootstrap.
        stream.deferred.push({ record, bytes })
        this.#scheduleRetry2(stream)
        return
      }
      // PositionMismatch, EpochRegression or ChecksumMismatch: the replica cannot continue from
      // where it stands, which is exactly what a re-subscribe from zero fixes.
      this.#lastError = err instanceof Error ? err.message : String(err)
      this.#onError(err)
      this.#send(
        encodeJson(FRAME.ERROR, {
          stream: stream.id,
          code: "DIVERGED",
          message: this.#lastError,
        }),
      )
      this.#resubscribe(stream)
      return
    }
    this.recordsApplied += 1
    if (stream.primaryTxid < record.txid) stream.primaryTxid = record.txid
    this.#ack(stream, record.txid, true)
  }

  /** Retries records deferred by a busy tenant, in order. */
  #scheduleRetry2(stream: Stream): void {
    if (stream.retrying) return
    stream.retrying = true
    const timer = setTimeout(() => {
      stream.retrying = false
      const pending = stream.deferred
      stream.deferred = []
      for (const item of pending) this.#apply(stream, item.record, item.bytes)
    }, 5)
    timer.unref?.()
  }

  /** The applier fdatasyncs its frames and its position before it returns, so `fsynced` is true. */
  #ack(stream: Stream, txid: bigint, fsynced: boolean): void {
    this.#send(encodeAck(stream.id, txid, fsynced ? ACK_FSYNCED : 0))
  }

  // ── heartbeats ───────────────────────────────────────────────────────────────────────────────

  #heartbeatIn(body: HeartbeatBody): void {
    for (const entry of body.streams ?? []) {
      const stream = this.#streams.get(entry.stream)
      if (stream) stream.primaryTxid = big(entry.txid)
    }
    // A database created on the primary since the handshake starts replicating here (deviation 2);
    // one deleted or re-created there is dropped here (R7).
    if (body.databases) this.#resolveFollow(body.databases, body.generations)
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat()
    this.#heartbeat = setInterval(() => {
      if (!this.#handshook) return
      this.#send(
        encodeJson(FRAME.HEARTBEAT, {
          ts: Date.now(),
          streams: [...this.#streams.values()].map((stream) => ({
            stream: stream.id,
            txid: (stream.tenant && !stream.tenant.closed ? stream.tenant.txid : 0n).toString(),
          })),
        }),
      )
    }, this.heartbeatMs)
    this.#heartbeat.unref?.()
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat === null) return
    clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }

  #errorIn(body: ErrorBody): void {
    this.#lastError = `${body.code}: ${body.message}`
    if (FATAL_CODES.has(body.code)) {
      this.#onError(new Error(this.#lastError))
      try {
        this.#socket?.close(1000, body.code)
      } catch {
        // The close handler reconnects either way.
      }
      return
    }
    // RETENTION and DIVERGED are advisory: the primary follows them with a snapshot on the same
    // stream (docs/r1-replication.md deviation 4), so there is nothing to do but note them.
    if (body.code !== "INTERNAL" || body.stream === undefined) return
    // The primary could not produce what this stream asked for — a snapshot it could not take,
    // say. The stream is gone on its side, so ask again in a moment rather than waiting for a
    // reconnect that nothing will trigger.
    const stream = this.#streams.get(body.stream)
    if (!stream) return
    this.#abortBootstrap(stream)
    this.#streams.delete(stream.id)
    this.#byDb.delete(stream.db)
    const db = stream.db
    const timer = setTimeout(() => {
      if (this.#stopped || !this.#handshook || this.#byDb.has(db)) return
      try {
        this.#subscribe(db)
      } catch (err) {
        this.#onError(err)
      }
    }, 100)
    timer.unref?.()
  }
}

function big(value: string | number | undefined): bigint {
  if (value === undefined || value === null || value === "") return 0n
  try {
    return BigInt(value)
  } catch {
    throw new ProtocolError(`${JSON.stringify(value)} is not a txid`)
  }
}
