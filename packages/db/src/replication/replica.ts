// The replica half of `/v1/replication`: one `ReplicaClient` per node, one WebSocket to the
// primary, one stream per database this node follows.
//
// Invariant: a record is acked only after it is applied *and* the position is persisted. The
// applier makes the transaction durable — pages into the database file under the WAL locks, or
// frames into the replica's own `-wal` — and rewrites `meta.json` before `applyRecord` returns, so
// an `ACK` this client sends is a promise the replica can keep across a crash, which is exactly
// what R2's `ack: "replica"` is built on.
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
//
// Fourth invariant (C2): `detach` is not `#unfollow`. A database this node has been promoted for
// stops being streamed and keeps its copy and its generation — that copy is the thing being
// promoted. Only an announcement that says the database is gone, or is a different database, may
// delete anything. `docs/c2-promotion.md`.
//
// Fifth invariant (C4c, `docs/c4c-replication-follow.md`): this class has **three modes and one
// copy of every decision**. `"own"` is a single-threaded node. On a node with `[server] workers`,
// the *stream* crosses the worker channel and the tenant never does — so `"routed"` runs on the
// router and owns the connection, the ledger and the follow/unfollow decision while touching no
// registry, and `"hosted"` runs on a worker and owns `openReplica`, the snapshot file,
// `installSnapshot`, `pin` and `applyRecord` while owning no socket. It is not split into three
// classes because `#resolveFollow`, the backoff and the ledger are the same logic in every mode,
// and duplicating them is how the halves drift.

import fs from "node:fs"
import path from "node:path"
import type { Tenant, TenantRegistry } from "../tenant/index.ts"
import { ApplyBusy, decode, MAX_RECORD_VERSION, type TxnRecord } from "../wal/index.ts"
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

/** First retry delay for a record a busy tenant deferred, and the ceiling it doubles to. */
const RETRY_START_MS = 5
const RETRY_MAX_MS = 250

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
  /**
   * C4c. `"own"` (default) is a single-threaded node. `"routed"` is the router thread of a
   * `workers > 1` node: it owns the socket, the ledger and every decision, and hands each stream's
   * per-database work to `host`. `"hosted"` is a worker thread: it owns the registry work for the
   * streams of the databases this shard holds, and is driven by `adopt`, `follow` and `deliver`.
   */
  mode?: ReplicaMode
  /** Required in `"routed"` mode: where a stream's per-database work actually happens. */
  host?: ShardHost
}

export type ReplicaMode = "own" | "routed" | "hosted"

/** One stream's local position, as the thread that holds its tenant sees it. */
export interface StreamPosition {
  stream: number
  db: string
  /** Last txid applied locally, decimal. */
  applied: string
  bootstrapping: boolean
}

/** The connection-level facts the router owns, pushed to every shard (C4c §3.4). */
export interface LinkState {
  connected: boolean
  primary: string
  /** The upstream's node id, from its `HELLO`. */
  node: string | null
  lastError: string | null
}

/**
 * C4c: what a `"routed"` client does instead of touching a registry it does not own. Every method
 * is a post onto the worker channel; nothing here returns tenant state except `positions`, which
 * is gathered once per heartbeat rather than once per record.
 */
export interface ShardHost {
  /** Follow `db` on `stream`: the shard opens the copy, pins it and sends `SUBSCRIBE`. */
  start(stream: number, db: string, generation: string | null, reset: boolean): void
  /** One decoded frame — `SNAPSHOT_*` or `TXN` — for the shard that holds `stream`. */
  frame(stream: number, db: string, type: number, body: Uint8Array): void
  /** End `stream`. `drop` disposes of the local copy through the registry's delete path (R7). */
  stop(stream: number, db: string, drop: boolean, reason: string): void
  /** The connection-level facts, pushed so a read route on a shard needs no round trip. */
  link(state: LinkState): void
  /** The generation ledger, after every save, for a chained replica's own announcement. */
  generations(entries: [string, string][]): void
  /** Every shard's stream positions, with the primary's own positions pushed down in the same tick. */
  positions(primary: [number, string][]): Promise<StreamPosition[]>
  /** R2: the upstream's answer to one forwarded write, back to the shard that asked for it. */
  result(shard: number, id: number, body: ResultBody): void
}

/**
 * C4c: what a `"hosted"` client reports to the router, which is everything that is *not* a frame.
 * One seam rather than five setters, because they are only ever installed together.
 */
export interface ReplicaHost {
  /**
   * A snapshot is installed and the copy now exists. Posted **before** the `ACK`, so the router
   * writes the ledger before the ack reaches the wire — see `docs/c4c-replication-follow.md` §3.2.
   */
  installed(stream: number, db: string, txid: string): void
  /** A diverged apply wants a fresh stream from zero, and only the router may mint one. */
  again(stream: number, db: string, reason: string): void
  /** The local copy was disposed of; the trash path belongs in `ReplicaStatus.unfollowed`. */
  stopped(db: string, trash: string | null): void
  /** R2: a write this shard could not take, on its way to the one upstream socket. */
  forward(id: number, request: ForwardRequest): void
  /** C2 on a worker: a promotion detached a database, or a demotion re-attached one. */
  detach(db: string): void
  attach(db: string): void
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
  /** Null in `"hosted"` mode: the router owns the one node-level timeout and the one cap. */
  timer: ReturnType<typeof setTimeout> | null
}

interface Stream {
  id: number
  db: string
  /** Null in `"routed"` mode, where the tenant is on another thread and never crosses. */
  tenant: Tenant | null
  /** `"routed"`: the last position the shard reported, since there is no tenant to ask. */
  applied: bigint
  /** `"routed"`: whether the shard said it is receiving a snapshot. */
  bootstrapping: boolean
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
  /** Current retry delay for deferred records, in ms. 0 is "not backing off". */
  retryMs: number
}

export class ReplicaClient {
  readonly registry: TenantRegistry
  readonly secret: string
  readonly node: string
  readonly reconnectMs: number
  readonly heartbeatMs: number
  readonly bootstrapDir: string
  /** C4c: which third of this class is live on this thread. */
  readonly mode: ReplicaMode

  /** Bytes received, for `bql_replication_bytes_total`. */
  bytesReceived = 0
  /** Records applied, for `bql_replication_records_total`. */
  recordsApplied = 0

  #follow: string[]
  #factory: SocketFactory
  #onError: (err: unknown) => void

  #socket: ClientSocket | null = null
  #reader = new FrameReader()
  #streams = new Map<number, Stream>()
  /** P9: databases whose primary announced that its records carry row changes. */
  #logical = new Set<string>()
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
  /**
   * Databases this node has been promoted for. They are skipped by `#resolveFollow`, so a primary
   * that is still up and still announcing them cannot pull this node back into following a
   * database it now owns — which would be the two-writers case arriving through the back door.
   */
  #detached = new Set<string>()
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

  /** Where this node follows from. C2's `retarget` moves it when a failover names a new primary. */
  #primary: string

  /** C4c: the shards, in `"routed"` mode. */
  #shards: ShardHost | null = null
  /** C4c: the router, in `"hosted"` mode. */
  #host: ReplicaHost | null = null
  /** C4c: what the router last said about the connection, in `"hosted"` mode. */
  #link: LinkState | null = null
  /** C4c: `"routed"` mode only — which shard asked for a forwarded write, by its own id. */
  #forwardShards = new Map<number, { shard: number; id: number }>()

  get primary(): string {
    return this.mode === "hosted" ? (this.#link?.primary ?? this.#primary) : this.#primary
  }

  constructor(options: ReplicaClientOptions) {
    this.registry = options.registry
    this.#primary = options.primary
    this.secret = options.secret
    this.node = options.node
    this.reconnectMs = options.reconnectMs ?? 250
    this.heartbeatMs = options.heartbeatMs ?? 5000
    this.bootstrapDir = options.bootstrapDir ?? path.join(options.registry.dir, "bootstrap")
    this.#follow = options.follow?.length ? [...options.follow] : ["*"]
    this.#onError =
      options.onError ??
      ((err: unknown) =>
        err instanceof ReplicaNotice
          ? console.error(`bql: ${err.message}`)
          : console.error("bql: replica", err))
    this.#factory =
      options.factory ??
      ((url: string) => new WebSocket(url) as unknown as ClientSocket)
    this.forwardTimeoutMs = options.forwardTimeoutMs ?? 10_000
    this.maxForwards = options.maxForwards ?? 256
    this.mode = options.mode ?? "own"
    this.#shards = options.host ?? null
    // A hosted client keeps no ledger of its own: the router holds the one file with the one
    // writer and pushes its contents down (§3.2), so reading it here would be a second reader of a
    // file this thread must never write.
    if (this.mode !== "hosted") this.#loadGenerations()
  }

  // ── C4c: the two seams ───────────────────────────────────────────────────────────────────────

  /**
   * `"hosted"`: the router hands this worker its end of the one upstream connection. The socket is
   * virtual — its `send` posts the finished frame back — so `#send`, `#subscribe`, `#ack` and the
   * snapshot path are the same code a single-threaded node runs.
   */
  adopt(socket: ClientSocket, host: ReplicaHost): void {
    this.#socket = socket
    this.#host = host
    // Disconnected until the router says otherwise: a worker is built before the node's upstream
    // connection exists, and `Forwarder` asks this client whether there is a socket to forward
    // over. Saying yes before the handshake would turn a `NOT_PRIMARY` into a write that vanishes.
    this.#connected = false
    this.#handshook = false
  }

  /** `"hosted"`: follow `db` on the stream the router minted. */
  follow(stream: number, db: string, generation: string | null, reset: boolean): void {
    if (this.#byDb.has(db)) return
    this.#subscribeAs(stream, db, generation, reset)
  }

  /** `"hosted"`: one frame the router decoded — `SNAPSHOT_*` or `TXN` — for `#handle`. */
  deliver(type: number, body: Uint8Array): void {
    this.#handle(type, body)
  }

  /**
   * `"hosted"`: end one stream. `drop` takes the local copy through the registry's delete path
   * (R7); false is C2's detach, which keeps the copy because that copy is what is being promoted.
   */
  unfollow(stream: number, db: string, drop: boolean, _reason: string): void {
    const held = this.#streams.get(stream)
    if (held && held.db !== db) return
    const trash = this.#dropLocal(db, drop)
    if (drop) this.#host?.stopped(db, trash)
  }

  /** Every local stream's position, with the upstream's own positions pushed down in the same tick. */
  positions(primary: [number, string][] = []): StreamPosition[] {
    for (const [stream, txid] of primary) {
      const held = this.#streams.get(stream)
      if (held) held.primaryTxid = big(txid)
    }
    return [...this.#byDb.values()].map((stream) => ({
      stream: stream.id,
      db: stream.db,
      applied: this.#appliedOf(stream).toString(),
      bootstrapping: stream.bootstrap !== null,
    }))
  }

  /** `"hosted"`: the connection-level facts the router owns (§3.4). */
  link(state: LinkState): void {
    const was = this.#link?.connected ?? false
    this.#link = state
    this.#connected = state.connected
    this.#handshook = state.connected
    this.#primaryNode = state.node
    this.#lastError = state.lastError
    if (was && !state.connected) {
      this.#failForwards(`the connection to ${state.primary} closed before the write was answered`)
    }
  }

  /** `"hosted"`: the generation ledger, so a chained replica announces the ids it was given. */
  generations(entries: [string, string][]): void {
    this.#generations = new Map(entries)
  }

  /** `"routed"`: a shard asking for one forwarded write over the one upstream socket (R2). */
  forwardFrom(shard: number, id: number, request: ForwardRequest): void {
    this.forward(request).then(
      (result) => this.#shards?.result(shard, id, { id, ok: true, result }),
      (err: unknown) => {
        const mapped =
          err instanceof ForwardError
            ? {
                code: err.code,
                message: err.message,
                ...(err.status !== undefined ? { status: err.status } : {}),
                ...(err.details?.txid !== undefined ? { txid: err.details.txid } : {}),
                ...(err.details?.failedIndex !== undefined
                  ? { failedIndex: err.details.failedIndex }
                  : {}),
              }
            : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) }
        this.#shards?.result(shard, id, { id, ok: false, error: mapped })
      },
    )
  }

  /** `"routed"`: one finished frame a shard built — `SUBSCRIBE`, `ACK`, `ERROR` — for the socket. */
  sendFrame(bytes: Uint8Array): void {
    this.#send(bytes)
  }

  /** `"hosted"`: the upstream's answer to one forwarded write, routed back by the router (R2). */
  result(body: ResultBody): void {
    this.#result(body)
  }

  /** `"routed"`: a shard installed a snapshot, so the identity the upstream promised is recorded. */
  installed(stream: number, db: string, _txid: string): void {
    const held = this.#streams.get(stream)
    this.#recordGeneration(db, held?.generation ?? null)
  }

  /** `"routed"`: a shard's apply diverged; give it a fresh stream from zero, which means a snapshot. */
  again(stream: number, db: string, _reason: string): void {
    const held = this.#streams.get(stream)
    if (!held || held.db !== db) return
    this.#resubscribe(held, false)
  }

  /** `"routed"`: a shard disposed of a local copy; the trash path belongs in `status()`. */
  stopped(db: string, trash: string | null): void {
    const last = [...this.#unfollowed].reverse().find((one) => one.db === db && one.trash === null)
    if (last) last.trash = trash
  }

  /** The position this thread can see: the tenant's, or the last a shard reported. */
  #appliedOf(stream: Stream): bigint {
    if (stream.tenant && !stream.tenant.closed) return stream.tenant.txid
    return stream.tenant ? 0n : stream.applied
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
    // C4c: a hosted client holds a read-only copy pushed down from the router, which owns the one
    // file and the one writer. Writing here would be a second writer of a node-level file.
    if (this.mode === "hosted") return
    // Every shard gets the new ledger, so a *chained* sharded replica announces to its own
    // downstream replicas the ids it was given rather than minting fresh ones from its catalog.
    this.#shards?.generations([...this.#generations])
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

  /**
   * The generation id this node's copy of `db` was bootstrapped under, or null.
   *
   * This is the database's *identity*, and it survives promotion: a promoted node still holds the
   * same database, so it must keep announcing the same id. Deriving one from its own catalog row
   * would mint a new identity out of nothing — `generationId` hashes `created_at`, and a replica's
   * row was created here rather than on the primary — and every downstream replica would then
   * trash its copy and bootstrap again for no reason at all.
   */
  generationOf(db: string): string | null {
    return this.#generations.get(db) ?? null
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
    // The cap is node-level, so in `"hosted"` mode it is the router's — one queue and one ceiling
    // over the one socket, rather than N ceilings that add up to N times the cap.
    if (this.mode !== "hosted" && this.#forwards.size >= this.maxForwards) {
      return Promise.reject(
        new ForwardError(
          "BUSY",
          `${this.maxForwards} writes are already in flight to the primary`,
          503,
        ),
      )
    }
    const id = this.#nextForward++
    if (this.mode === "hosted") {
      // The router owns the timeout for the same reason it owns the cap, so this end is only the
      // promise: it is settled by the `RESULT` the router routes back through `#result`.
      return new Promise<unknown>((resolve, reject) => {
        this.#forwards.set(id, { resolve, reject, timer: null })
        this.#host?.forward(id, request)
      })
    }
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
      pending.timer?.unref?.()
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
      if (one.timer) clearTimeout(one.timer)
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

  /**
   * P9: whether this database's primary announced that its transaction records carry row changes.
   * The local change feed asks before it refuses a subscription `LOGICAL_UNAVAILABLE`, so a replica
   * that has just bootstrapped an idle database does not answer "unavailable" for a feed that is
   * merely quiet.
   */
  recordsLogical(db: string): boolean {
    return this.#logical.has(db)
  }

  /** What `GET /v1/db/:db/replication` and `/metrics` report on a replica. */
  status(): ReplicaStatus {
    const streams: StreamStatus[] = []
    for (const stream of this.#byDb.values()) {
      const applied = this.#appliedOf(stream)
      const lag = stream.primaryTxid > applied ? stream.primaryTxid - applied : 0n
      streams.push({
        db: stream.db,
        applied: Number(applied),
        lagTxid: Number(lag),
        bootstrapping: stream.tenant ? stream.bootstrap !== null : stream.bootstrapping,
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
    if (this.#stopped || this.mode === "hosted") return
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
    this.#endRoutedStreams("this node stopped following")
    this.#streams.clear()
    this.#byDb.clear()
    // A hosted client's socket is the router's; closing it here would end the node's connection
    // from one shard's shutdown.
    if (socket && this.mode !== "hosted") {
      try {
        socket.close(1000, "stopping")
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * C2: stops following one database without touching its files. This is the promotion path —
   * `UNSUBSCRIBE`, drop the stream, release the pin, and **keep** the copy and its recorded
   * generation, because that copy is what is about to become the primary's.
   *
   * The name is remembered, so a primary that is still up and still announcing the database does
   * not re-subscribe this node to a database it now owns.
   */
  detach(db: string): void {
    // C4c: `#detached` is node-level — a primary that is still announcing the database must not
    // pull *any* shard back into following it — so on a worker this reports and the router decides.
    if (this.mode === "hosted") {
      this.#host?.detach(db)
      return
    }
    this.#detached.add(db)
    const stream = this.#byDb.get(db)
    if (!stream) return
    this.#send(encodeJson(FRAME.UNSUBSCRIBE, { stream: stream.id } satisfies UnsubscribeBody))
    if (this.mode === "routed") {
      this.#streams.delete(stream.id)
      this.#byDb.delete(db)
      this.#shards?.stop(stream.id, db, false, "promoted here")
      return
    }
    this.#abortBootstrap(stream)
    this.#streams.delete(stream.id)
    this.#byDb.delete(db)
    this.registry.unpin(db, PIN_OWNER)
  }

  /** The mirror of `detach`: this node has been demoted, so follow the database again. */
  attach(db: string): void {
    if (this.mode === "hosted") {
      this.#host?.attach(db)
      return
    }
    if (!this.#detached.delete(db)) return
    if (!this.#handshook || this.#byDb.has(db)) return
    try {
      this.#subscribe(db)
    } catch (err) {
      this.#onError(err)
    }
  }

  /** Databases this node has been promoted for and no longer follows. */
  get detached(): string[] {
    return [...this.#detached]
  }

  /**
   * Points this client at a different primary and reconnects. C2's failover uses it so a demoted
   * node converges on the new primary without an operator; a URL it is already following is a
   * no-op, because reconnecting would only cost a re-handshake.
   */
  /**
   * Replaces the database list this client follows (C3b). Placement moves a database between
   * upstreams without the connection changing, so the list has to be settable — and the next
   * `#resolveFollow`, which every heartbeat runs, opens and closes streams to match it.
   */
  setFollow(follow: string[]): void {
    const wanted = follow.length > 0 ? [...follow] : ["*"]
    if (wanted.length === this.#follow.length && wanted.every((db, at) => this.#follow[at] === db)) {
      return
    }
    this.#follow = wanted
    // The next `HEARTBEAT` carries the upstream's announcement and runs `#resolveFollow` over it,
    // which is what opens and closes streams to match. Applying it here would need a second copy
    // of the announcement kept for the purpose, and a heartbeat is `heartbeatMs` away.
  }

  retarget(url: string): void {
    if (this.mode === "hosted") return
    if (!url || url === this.#primary) return
    this.#primary = url
    const socket = this.#socket
    this.#socket = null
    this.#connected = false
    this.#handshook = false
    this.#attempt = 0
    if (this.#retry !== null) {
      clearTimeout(this.#retry)
      this.#retry = null
    }
    for (const stream of this.#streams.values()) this.#abortBootstrap(stream)
    this.#endRoutedStreams("following a new primary")
    this.#streams.clear()
    this.#byDb.clear()
    this.#sawDatabases = false
    this.#emptyAnnouncementReported = false
    this.#pushLink()
    if (socket) {
      try {
        socket.close(1000, "following a new primary")
      } catch {
        // Already closed; `#connect` below is what matters.
      }
    }
    if (!this.#stopped) this.#connect()
  }

  /**
   * Resolves once every followed database has applied at least `txid`. For tests and `readyz`.
   *
   * In `"routed"` mode the position is only as fresh as the last heartbeat gather, because the
   * tenant is on another thread; a caller that needs it exactly asks the shard over HTTP instead.
   */
  async waitForTxid(db: string, txid: bigint, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const stream = this.#byDb.get(db)
      const applied = stream ? this.#appliedOf(stream) : null
      if (applied !== null && applied >= txid) return
      if (Date.now() > deadline) {
        throw new Error(
          `${db} did not reach txid ${txid} in ${timeoutMs}ms (at ${applied ?? "no stream"})`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // ── connection ───────────────────────────────────────────────────────────────────────────────

  /** C4c: the connection-level facts every shard needs but cannot see (§3.4). */
  #pushLink(): void {
    this.#shards?.link({
      connected: this.connected,
      primary: this.#primary,
      node: this.#primaryNode,
      lastError: this.#lastError,
    })
  }

  /** C4c: tell every shard its streams are over, when the connection they rode is. */
  #endRoutedStreams(reason: string): void {
    if (this.mode !== "routed") return
    for (const stream of this.#streams.values()) {
      this.#shards?.stop(stream.id, stream.db, false, reason)
    }
  }

  #connect(): void {
    if (this.#stopped || this.#socket || this.mode === "hosted") return
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
    this.#endRoutedStreams("the connection to the primary closed")
    // The stream table is rebuilt on the next handshake; the *positions* live in the tenants, so
    // nothing is lost by forgetting it.
    this.#streams.clear()
    this.#byDb.clear()
    this.#pushLink()
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
    // C4c: the four frames that touch a tenant go to the shard that holds it, and nothing else
    // does. `HELLO`, `SUBSCRIBED`, `HEARTBEAT`, `ERROR` and `RESULT` each touch the connection, the
    // ledger or the forward queue, and none of them touches a tenant — so they stay here.
    if (this.mode === "routed" && SHARDED.has(type)) {
      const id = type === FRAME.TXN ? streamOfTxn(body) : streamOfJson(type, body)
      const stream = this.#streams.get(id)
      if (!stream) return
      this.#shards?.frame(id, stream.db, type, body)
      return
    }
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
    if (pending.timer) clearTimeout(pending.timer)
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
          // P9: the primary strips the logical section from anything newer than this, so a build
          // that cannot read version 2 keeps replicating rather than failing on a record it never
          // asked for.
          maxRecordVersion: MAX_RECORD_VERSION,
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
    this.#pushLink()
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
    // A database this node has been promoted for is not held *as a follower* any more. It must be
    // neither dropped (the copy is now this node's own primary copy) nor re-subscribed (that is
    // the two-writers case arriving through an announcement).
    for (const db of this.#detached) held.delete(db)

    // C3b: the generation ledger is **node-level** — it records every copy this node has
    // bootstrapped, from any upstream — while an announcement is one upstream's. On a node that
    // follows several primaries that mismatch is R7 pointed at the wrong thing: upstream A does
    // not announce a database upstream B is feeding, and the copy gets trashed underneath a live
    // stream. Measured, not imagined: a three-node cluster with `rf = 2` did exactly that.
    //
    // So a client may only unfollow a database it is **responsible for**, which is its own follow
    // list when that list is explicit. `["*"]` means "everything this upstream announces" and
    // keeps today's behaviour exactly, which is every statically configured replica; C3b's planner
    // always hands out explicit lists, so the two never overlap.
    if (!this.#follow.includes("*")) {
      const mine = new Set(this.#follow)
      for (const db of [...held]) if (!mine.has(db)) held.delete(db)
    }

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
      if (this.#byDb.has(db) || this.#detached.has(db)) continue
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
      this.#send(encodeJson(FRAME.UNSUBSCRIBE, { stream: stream.id } satisfies UnsubscribeBody))
    }
    this.#forgetGeneration(db)

    // C4c: in `"routed"` mode the copy is on another thread, so the shard disposes of it and
    // reports the trash path back through `stopped()` — the entry is pushed here first so the
    // drop is in `status()` and in the log at the moment it is decided, not one hop later.
    let trash: string | null = null
    if (this.mode === "routed") {
      if (stream) {
        this.#streams.delete(stream.id)
        this.#byDb.delete(db)
      }
      this.#shards?.stop(stream?.id ?? 0, db, true, reason)
    } else {
      trash = this.#dropLocal(db, true)
    }

    this.#unfollowed.push({ db, atMs: Date.now(), reason, trash })
    if (this.#unfollowed.length > MAX_UNFOLLOWED) this.#unfollowed.shift()
    this.#onError(
      new ReplicaUnfollowed(
        `${reason}; the local copy was ${
          this.mode === "routed"
            ? "handed to the worker that owns it"
            : trash
              ? `moved to ${trash}`
              : "not found locally"
        }`,
      ),
    )
  }

  /**
   * The local half of letting a database go: end the stream, release the pin, and — when `drop` —
   * dispose of the copy through the registry's own delete path, so it is as recoverable as a
   * primary-side delete leaves one (`<dataDir>/trash/<name>-<ms>`, never a bare `rm`).
   *
   * The abort comes first on purpose: an announcement that lands mid-bootstrap must not leave a
   * half-written snapshot in `<dataDir>/bootstrap`.
   */
  #dropLocal(db: string, drop: boolean): string | null {
    const stream = this.#byDb.get(db)
    if (stream) {
      this.#abortBootstrap(stream)
      this.#streams.delete(stream.id)
      this.#byDb.delete(db)
    }
    this.registry.unpin(db, PIN_OWNER)
    if (!drop) return null
    try {
      // Only a copy this node received as a follower. A database authored here that happens to
      // share the name is somebody else's, whatever the primary announces.
      const row = this.registry.list().find((one) => one.name === db)
      if (row?.role === "replica") return this.registry.delete(db)
    } catch (err) {
      this.#onError(err)
    }
    return null
  }

  #subscribe(db: string): void {
    this.#subscribeAs(this.#nextStream++, db, this.#generations.get(db) ?? null, false)
  }

  /**
   * Opens (or creates) the local copy, pins it and sends `SUBSCRIBE`.
   *
   * C4c §3.3: the body needs `tenant.txid`, `epoch` and `checksum`, which are the owning thread's,
   * and `generation`, which is the router's — so the router sends the one field it owns *with the
   * instruction* and the frame is encoded where the other three live. No round trip, and no
   * message per record.
   */
  #subscribeAs(id: number, db: string, held: string | null, reset: boolean): void {
    if (this.mode === "routed") {
      const stream: Stream = {
        id,
        db,
        tenant: null,
        applied: 0n,
        bootstrapping: false,
        generation: reset ? null : held,
        primaryTxid: 0n,
        bootstrap: null,
        deferred: [],
        retrying: false,
        retryMs: 0,
      }
      this.#streams.set(id, stream)
      this.#byDb.set(db, stream)
      this.#shards?.start(id, db, stream.generation, reset)
      return
    }
    const tenant = this.registry.has(db)
      ? this.registry.openReplica(db)
      : this.registry.createReplica(db)
    const stream: Stream = {
      id,
      db,
      tenant,
      applied: tenant.txid,
      bootstrapping: false,
      generation: reset ? null : held,
      primaryTxid: tenant.txid,
      bootstrap: null,
      deferred: [],
      retrying: false,
      retryMs: 0,
    }
    this.#streams.set(id, stream)
    this.#byDb.set(db, stream)
    // Nothing may evict a database with a stream attached: the applier and its position live on
    // the tenant, and reopening it mid-stream would leave a gap nobody would notice.
    this.registry.pin(db, PIN_OWNER)
    this.#send(
      encodeJson(
        FRAME.SUBSCRIBE,
        reset
          ? ({
              stream: id,
              db,
              fromTxid: "0",
              epoch: 0,
              checksum: "0",
              // This database is here because an apply did not verify, so its file holds pages
              // from a history the primary does not share. Only a snapshot can settle that, even
              // at txid 0.
              reset: true,
            } satisfies SubscribeBody)
          : ({
              stream: id,
              db,
              fromTxid: tenant.txid.toString(),
              epoch: tenant.epoch,
              checksum: tenant.checksum.toString(),
              // What this node believes its copy is. A primary holding a different id answers with
              // a snapshot however well the txid and checksum line up.
              ...(held ? { generation: held } : {}),
            } satisfies SubscribeBody),
      ),
    )
  }

  /**
   * Drops a stream and asks for it again from zero, which always means a snapshot.
   *
   * `tellShard` is false on the one path where the shard has already let the stream go: a diverged
   * apply, which is decided on the shard and reaches the router as `again()`.
   */
  #resubscribe(stream: Stream, tellShard = true): void {
    // C4c: only the router may mint a stream id, so a hosted client says what happened and the
    // router sends the `UNSUBSCRIBE` and comes back with a fresh `follow.start`. The pin is kept
    // across the round trip, exactly as a single-threaded node keeps it across `#resubscribe`.
    if (this.mode === "hosted") {
      this.#abortBootstrap(stream)
      this.#streams.delete(stream.id)
      this.#byDb.delete(stream.db)
      this.#host?.again(stream.id, stream.db, this.#lastError ?? "an apply did not verify")
      return
    }
    this.#abortBootstrap(stream)
    this.#streams.delete(stream.id)
    this.#byDb.delete(stream.db)
    if (this.mode === "routed" && tellShard) {
      this.#shards?.stop(stream.id, stream.db, false, "re-bootstrapping")
    }
    this.#send(encodeJson(FRAME.UNSUBSCRIBE, { stream: stream.id }))
    this.#subscribeAs(this.#nextStream++, stream.db, null, true)
  }

  #subscribed(body: SubscribedBody): void {
    const stream = this.#streams.get(body.stream)
    if (!stream) return
    stream.primaryTxid = big(body.txid)
    // P9: what the primary says it records for this database, which is what the local change feed
    // can promise before the first record has arrived.
    if (body.logical === true) this.#logical.add(stream.db)
    else this.#logical.delete(stream.db)
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
    // No re-pin here. `installSnapshot` closes the tenant and reopens it, and since L4 it puts
    // every holder's pins back exactly as it found them — so pinning again would leave this stream
    // holding *two*, and the single `unpin` when it closes would leave the database pinned open
    // for the life of the process. Before L4 pins were set membership, which made the second one a
    // no-op under this owner and merely leaked a `"default"` pin nothing ever released.
    // C4c §3.2: the ledger is the router's, so the install is *reported* rather than recorded —
    // and reported **before** the `ACK`, because `postMessage` to one port is FIFO and that is what
    // makes the router write the ledger before the ack reaches the wire. A copy on disk with no
    // recorded identity is the one thing R7 cannot recover from.
    if (this.mode === "hosted") this.#host?.installed(stream.id, stream.db, begin.txid)
    else this.#recordGeneration(stream.db, stream.generation)
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
      if (code === "BUSY" || err instanceof ApplyBusy) {
        // The tenant is snapshotting, or a local reader held a read transaction against a page
        // apply for longer than `applyBusyMs`. Both mean the same thing — nothing was written and
        // the position has not moved — so keep the record and retry rather than re-bootstrapping.
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
    stream.retryMs = 0
    if (stream.primaryTxid < record.txid) stream.primaryTxid = record.txid
    this.#ack(stream, record.txid, true)
  }

  /**
   * Retries records deferred by a busy tenant, in order, backing off as the tenant stays busy.
   *
   * The backoff is what keeps a long-lived local reader — a client's read transaction, since R10 —
   * from costing this thread a spin every 5 ms for as long as it is held. It resets on the first
   * record that applies, so a momentary read costs one 5 ms wait and nothing more.
   */
  #scheduleRetry2(stream: Stream): void {
    if (stream.retrying) return
    stream.retrying = true
    const delay = stream.retryMs || RETRY_START_MS
    stream.retryMs = Math.min(delay * 2, RETRY_MAX_MS)
    const timer = setTimeout(() => {
      stream.retrying = false
      const pending = stream.deferred
      stream.deferred = []
      for (const item of pending) this.#apply(stream, item.record, item.bytes)
    }, delay)
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
    if (this.mode === "hosted") return
    this.#heartbeat = setInterval(() => void this.#beat(), this.heartbeatMs)
    this.#heartbeat.unref?.()
  }

  /**
   * One `HEARTBEAT` up, carrying every stream's applied txid.
   *
   * In `"routed"` mode the positions come from the shards in **one gather per tick**, and the
   * upstream's own per-stream positions ride down in the same message — the same fold C4b settled
   * on for the primary's tick, for the same reason: the two halves each need the other's thread.
   */
  async #beat(): Promise<void> {
    if (!this.#handshook) return
    let positions: StreamPosition[]
    if (this.mode === "routed" && this.#shards) {
      const primary: [number, string][] = [...this.#streams.values()].map((stream) => [
        stream.id,
        stream.primaryTxid.toString(),
      ])
      try {
        positions = await this.#shards.positions(primary)
      } catch (err) {
        this.#onError(err)
        return
      }
      for (const one of positions) {
        const stream = this.#streams.get(one.stream)
        if (!stream) continue
        stream.applied = big(one.applied)
        stream.bootstrapping = one.bootstrapping
      }
    } else {
      positions = this.positions()
    }
    if (!this.#handshook) return
    this.#send(
      encodeJson(FRAME.HEARTBEAT, {
        ts: Date.now(),
        streams: positions.map((one) => ({ stream: one.stream, txid: one.applied })),
      }),
    )
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat === null) return
    clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }

  #errorIn(body: ErrorBody): void {
    this.#lastError = `${body.code}: ${body.message}`
    // This node holds a *higher* epoch than the node it is following, which means the peer is a
    // stale primary: it was fenced and has not noticed. Retrying would loop for ever, so the
    // stream is dropped and said out loud. The peer fences itself when it sees this same
    // subscribe (`ReplicationServer.onEpochAhead`), so both halves converge.
    if (body.code === "EPOCH_AHEAD" && body.stream !== undefined) {
      const stream = this.#streams.get(body.stream)
      if (stream) {
        this.detach(stream.db)
        this.#onError(
          new ReplicaUnfollowed(
            `${stream.db}: ${this.#primary} is behind this node's epoch and was fenced; ` +
              "this node stopped following it for that database",
          ),
        )
      }
      return
    }
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
    if (this.mode === "routed") {
      this.#shards?.stop(stream.id, stream.db, false, `the primary refused the stream: ${body.code}`)
    }
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

/**
 * C4c: the four frames that touch a tenant, and are therefore the only ones a `"routed"` client
 * hands to a shard. Everything else touches the connection, the ledger or the forward queue.
 */
const SHARDED = new Set<number>([
  FRAME.SNAPSHOT_BEGIN,
  FRAME.SNAPSHOT_CHUNK,
  FRAME.SNAPSHOT_END,
  FRAME.TXN,
])

/** A `TXN`'s stream id: the first four bytes of the body, big-endian, as `#txn` reads them. */
function streamOfTxn(body: Uint8Array): number {
  if (body.byteLength < 4) throw new ProtocolError("TXN body is shorter than its stream id")
  return new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false)
}

/** A snapshot frame's stream id, without decoding more of it than routing needs. */
function streamOfJson(type: number, body: Uint8Array): number {
  if (type === FRAME.SNAPSHOT_CHUNK) return decodeSnapshotChunk(body).stream
  return decodeJson<{ stream: number }>(type, body).stream
}

function big(value: string | number | undefined): bigint {
  if (value === undefined || value === null || value === "") return 0n
  try {
    return BigInt(value)
  } catch {
    throw new ProtocolError(`${JSON.stringify(value)} is not a txid`)
  }
}
