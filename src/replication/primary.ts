// The primary half of `/v1/replication`: one `ReplicationServer` per node, one `Conn` per replica
// socket, one `Stream` per database that socket follows.
//
// Invariant: send order per stream is strictly ascending txid with no holes. That is why
// `#startStream` attaches the tenant's commit listener *before* it reads the log — a record that
// commits during the catch-up read lands in a buffer instead of being missed, and the buffer is
// flushed with everything at or below the last sent txid skipped. A replica that sees txid n+1
// after txid n never has to ask what happened in between, because nothing did.
//
// Second invariant: a slow replica costs the primary memory, not correctness. `ws.send` returning
// -1 pauses the sender; frames queue; a socket that stays paused for `slowReplicaMs` is closed
// with BUSY and resumes from its own position when it reconnects.
//
// Third invariant (R7): a stream outlives its database by at most one announcement. Every
// announcement sweeps streams whose database has left the catalog, been closed underneath them or
// been re-created under a new generation id — so a replica is never left attached to a tenant that
// no longer means what it meant when it subscribed. See `docs/r7-unfollow.md`.

import fs from "node:fs"
import type { Tenant, TenantRegistry } from "../tenant/index.ts"
import {
  encode,
  listSnapshots,
  type SnapshotRef,
  type TxnRecordInput,
} from "../wal/index.ts"
import {
  decodeAck,
  decodeJson,
  type ForwardBody,
  encodeJson,
  generationId,
  encodeSnapshotChunk,
  encodeTxn,
  FRAME,
  FrameReader,
  frameName,
  type HeartbeatBody,
  type HelloBody,
  makeNonce,
  ProtocolError,
  PROTO_VERSION,
  type ReplicationErrorCode,
  type ResultBody,
  type SubscribeBody,
  type SubscribedBody,
  type UnsubscribeBody,
  verifyProof,
} from "./protocol.ts"

/** Who this module pins tenants as, so it never releases the realtime engine's pin. */
const PIN_OWNER = "replication"

/** 1 MiB of the plain file per `SNAPSHOT_CHUNK`, per `plan-phase1.md`. */
const CHUNK_BYTES = 1024 * 1024

/** What this module needs from a Bun `ServerWebSocket`. */
export interface ReplicationSocket {
  send(data: Uint8Array | string): number
  close(code?: number, reason?: string): void
  readonly readyState: number
  data: unknown
}

/** One replica's view of one database, as `GET /v1/db/:db/replication` reports it. */
export interface ReplicaView {
  node: string
  stream: number
  /** Last txid the replica has acked. */
  txid: number
  /** How far behind the primary that leaves it. */
  lag: number
  ackedAtMs: number
  /** Whether the replica reported the record fsynced — the input to R2's `ack: "replica"`. */
  fsynced: boolean
}

/** Fired for every `ACK` frame. R2's durability levels are a waiter over this. */
export interface AckEvent {
  db: string
  node: string
  stream: number
  txid: bigint
  fsynced: boolean
}

export interface ReplicationServerOptions {
  registry: TenantRegistry
  /** This node's id, sent in `HELLO`. */
  node: string
  /** The cluster secret. An empty one means the endpoint is disabled; the caller checks that. */
  secret: string
  heartbeatMs?: number
  /** Close a socket that has been backpressured for this long. */
  slowReplicaMs?: number
  /**
   * C4b: this server's connections are *adopted* from a router that owns the real socket. It does
   * no handshake, mints no nonce, runs no heartbeat timer and builds no announcement — the router
   * does all four, once for the node — and this server only holds streams for the databases its
   * thread owns. Everything below the connection is identical in both modes, which is why this is
   * a flag rather than a second class. `docs/c4b-replication-workers.md` §4.
   */
  hosted?: boolean
  /**
   * R2's write forwarding. A replica hands a write it cannot take to the primary as a `FORWARD`
   * frame; this runs it and its answer goes back as `RESULT`. Left unset, a `FORWARD` is refused
   * with `PROTO`, which is what a node that predates R2 does.
   */
  onForward?: (request: ForwardBody, node: string) => Promise<unknown>
  /**
   * A replica socket that had completed the handshake has gone. R2 uses it to roll back the
   * interactive transactions that replica had open here, rather than leaving this node's only
   * writer held until the idle timer notices.
   */
  onDisconnect?: (node: string) => void
  /**
   * C2: a replica subscribed claiming an epoch **higher** than this node holds for the database.
   * That is proof the control plane granted the database to somebody else after it granted it
   * here, so this node has been fenced and must stop being its primary. The caller demotes;
   * this module only reports, because a tenant's role is the server's to change.
   */
  onEpochAhead?: (event: { db: string; node: string; epoch: number; held: number }) => void
  /**
   * The generation id to announce for a database whose identity this node did not mint: a copy it
   * received as a replica, including one it has since been promoted for. `generationId` derives an
   * id from the catalog row's `created_at`, and a replica's row was created *here*, so deriving
   * one for such a copy would announce a new identity for the same database and make every
   * downstream replica trash its copy. Returning null falls back to the derived id, which is right
   * for a database this node authored.
   */
  generationOf?: (db: string) => string | null
  onError?: (err: unknown) => void
}

interface Pending {
  txid: bigint
  bytes: Uint8Array
}

interface Stream {
  id: number
  db: string
  tenant: Tenant
  /** The database's generation id when this stream was opened; a different one means a different
   * database has taken the name, and the stream is ended so the replica re-bootstraps. */
  generation: string
  /** Last txid written to the socket. */
  sentTxid: bigint
  ackedTxid: bigint
  ackedAtMs: number
  fsynced: boolean
  unhook: (() => void) | null
  /** Records that committed while the catch-up read was still running. */
  buffer: Pending[]
  catchingUp: boolean
  closed: boolean
}

class Conn {
  readonly ws: ReplicationSocket
  readonly reader = new FrameReader()
  readonly nonce = makeNonce()
  readonly streams = new Map<number, Stream>()
  node = "?"
  authed = false
  paused = false
  pausedSinceMs = 0
  /** Frames the socket refused outright (`send` returned 0), replayed on `drain`. */
  queue: Uint8Array[] = []
  closed = false

  constructor(ws: ReplicationSocket) {
    this.ws = ws
  }
}

export class ReplicationServer {
  readonly registry: TenantRegistry
  readonly node: string
  readonly secret: string
  readonly heartbeatMs: number
  readonly slowReplicaMs: number
  /** True when a router owns the sockets and this server only holds streams (C4b). */
  readonly hosted: boolean

  /** Bytes handed to `ws.send`, for `bunql_replication_bytes_total`. */
  bytesSent = 0
  /** `TXN` frames sent, for `bunql_replication_records_total`. */
  recordsSent = 0

  #conns = new Set<Conn>()
  #byWs = new WeakMap<object, Conn>()
  /** One in-flight snapshot per database, so a fan-out of replicas produces one file, not N. */
  #snapshots = new Map<string, Promise<SnapshotRef>>()
  #timer: ReturnType<typeof setInterval> | null = null
  #ackListeners = new Set<(event: AckEvent) => void>()
  #onForward: ((request: ForwardBody, node: string) => Promise<unknown>) | null
  #onDisconnect: ((node: string) => void) | null
  #onEpochAhead: (event: { db: string; node: string; epoch: number; held: number }) => void
  #generationOf: (db: string) => string | null
  #onError: (err: unknown) => void
  /** Hosted: where `announce()` goes, since the router assembles the node's announcement. */
  #onAnnounce: (() => void) | null = null
  #closed = false

  constructor(options: ReplicationServerOptions) {
    this.registry = options.registry
    this.node = options.node
    this.secret = options.secret
    this.heartbeatMs = options.heartbeatMs ?? 5000
    this.slowReplicaMs = options.slowReplicaMs ?? 30_000
    this.hosted = options.hosted === true
    this.#onForward = options.onForward ?? null
    this.#onDisconnect = options.onDisconnect ?? null
    this.#onEpochAhead = options.onEpochAhead ?? (() => {})
    this.#generationOf = options.generationOf ?? (() => null)
    this.#onError =
      options.onError ?? ((err: unknown) => console.error("bunql: replication", err))
  }

  /** Replica connections currently attached, for `bunql_replication_connected`. */
  get connections(): number {
    return this.#conns.size
  }

  /** Streams open across every connection. */
  get streamCount(): number {
    let total = 0
    for (const conn of this.#conns) total += conn.streams.size
    return total
  }

  /** Every replica following `db`, for `GET /v1/db/:db/replication`. */
  replicasOf(db: string): ReplicaView[] {
    const out: ReplicaView[] = []
    for (const conn of this.#conns) {
      for (const stream of conn.streams.values()) {
        if (stream.db !== db) continue
        out.push({
          node: conn.node,
          stream: stream.id,
          txid: Number(stream.ackedTxid),
          lag: Number(stream.tenant.txid - stream.ackedTxid),
          ackedAtMs: stream.ackedAtMs,
          fsynced: stream.fsynced,
        })
      }
    }
    return out
  }

  /** The largest lag across every stream, for the metrics gauge. */
  get maxLagTxid(): number {
    let worst = 0
    for (const conn of this.#conns) {
      for (const stream of conn.streams.values()) {
        const lag = Number(stream.tenant.txid - stream.ackedTxid)
        if (lag > worst) worst = lag
      }
    }
    return worst
  }

  /** R2's seam: every `ACK` frame, with the node and database it came from. */
  onAck(listener: (event: AckEvent) => void): () => void {
    this.#ackListeners.add(listener)
    return () => {
      this.#ackListeners.delete(listener)
    }
  }

  // ── socket lifecycle ─────────────────────────────────────────────────────────────────────────

  /** A replica has connected: challenge it with a fresh nonce. */
  open(ws: ReplicationSocket): void {
    if (this.#closed) {
      ws.close(1001, "shutting down")
      return
    }
    const conn = new Conn(ws)
    this.#conns.add(conn)
    this.#byWs.set(ws as object, conn)
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

  // ── hosted mode (C4b) ────────────────────────────────────────────────────────────────────────
  //
  // A router on another thread owns the real socket. It did the handshake, so the connection
  // arrives already authenticated and already named; it owns the frame reader, so a frame arrives
  // already decoded; and it owns the heartbeat and the announcement, so this server neither ticks
  // nor announces. `docs/c4b-replication-workers.md` §4.

  /** Where the worker relay plugs the router's announcement in (hosted only). */
  setAnnounceHandler(handler: (() => void) | null): void {
    this.#onAnnounce = handler
  }

  /** A replica connection the router has authenticated, adopted on this thread. */
  adopt(ws: ReplicationSocket, node: string): void {
    if (this.#closed) return
    if (this.#byWs.has(ws as object)) return
    const conn = new Conn(ws)
    conn.node = node || "?"
    // The router verified the proof against its own nonce. Trusting it here is the same trust C4's
    // socket relay places in the router for a client socket's principal, and the alternative — a
    // second handshake per worker over one socket — is the thing §2 rejects.
    conn.authed = true
    this.#conns.add(conn)
    this.#byWs.set(ws as object, conn)
  }

  /** One frame the router decoded, handled exactly as `message` would have handled it. */
  deliver(ws: ReplicationSocket, type: number, body: Uint8Array): void {
    const conn = this.#byWs.get(ws as object)
    if (!conn) return
    try {
      this.#handle(conn, type, body)
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.#fail(conn, "PROTO", err.message)
        return
      }
      this.#onError(err)
      this.#error(conn, undefined, "INTERNAL", "the primary could not handle that frame")
    }
  }

  /** Every stream's position, for the `HEARTBEAT` the router assembles across every worker. */
  positions(): { ws: ReplicationSocket; stream: number; txid: bigint }[] {
    const out: { ws: ReplicationSocket; stream: number; txid: bigint }[] = []
    for (const conn of this.#conns) {
      for (const stream of conn.streams.values()) {
        out.push({ ws: conn.ws, stream: stream.id, txid: stream.tenant.txid })
      }
    }
    return out
  }

  /**
   * R7's stream sweep, driven by the router's announcement rather than by this server's own tick.
   * The announcement is one node-wide fact and the router is the one thread that assembles it.
   */
  sweep(announcement: Map<string, string>): void {
    this.#sweepStreams(announcement)
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
        this.#handle(conn, frame.type, frame.body)
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

  /** Bun calls this when the socket's buffer has room again. */
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

  /** Closes every replica socket and stops the heartbeat. */
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
        // The socket may already be gone; the teardown below is what matters.
      }
      this.#teardown(conn)
    }
  }

  // ── frames ───────────────────────────────────────────────────────────────────────────────────

  #handle(conn: Conn, type: number, body: Uint8Array): void {
    if (type === FRAME.HELLO) {
      this.#hello(conn, decodeJson<HelloBody>(type, body))
      return
    }
    if (!conn.authed) {
      this.#fail(conn, "AUTH_FAILED", `${frameName(type)} arrived before the handshake finished`)
      return
    }
    switch (type) {
      case FRAME.SUBSCRIBE:
        void this.#subscribe(conn, decodeJson<SubscribeBody>(type, body))
        return
      case FRAME.UNSUBSCRIBE: {
        const { stream } = decodeJson<UnsubscribeBody>(type, body)
        const found = conn.streams.get(stream)
        if (found) this.#endStream(conn, found)
        return
      }
      case FRAME.ACK: {
        const ack = decodeAck(body)
        const stream = conn.streams.get(ack.stream)
        if (!stream) return
        if (ack.txid > stream.ackedTxid) stream.ackedTxid = ack.txid
        stream.ackedAtMs = Date.now()
        stream.fsynced = ack.fsynced
        const event: AckEvent = {
          db: stream.db,
          node: conn.node,
          stream: stream.id,
          txid: ack.txid,
          fsynced: ack.fsynced,
        }
        for (const listener of this.#ackListeners) {
          try {
            listener(event)
          } catch (err) {
            this.#onError(err)
          }
        }
        return
      }
      case FRAME.HEARTBEAT:
        return
      case FRAME.ERROR:
        // A replica telling the primary about a stream it could not apply. It re-subscribes from
        // zero itself; nothing here has to act, but it is worth a line in the log.
        this.#onError(new Error(`replica ${conn.node}: ${new TextDecoder().decode(body)}`))
        return
      case FRAME.FORWARD:
        void this.#forward(conn, decodeJson<ForwardBody>(type, body))
        return
      default:
        this.#fail(conn, "PROTO", `unexpected frame ${frameName(type)}`)
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
   * Pushes the current database list to every authenticated replica, now. `plan-phase1.md`
   * finding 1: a `follow: ["*"]` replica must reach a database created on the primary in the same
   * millisecond range as a record, not at the next heartbeat tick up to `heartbeatMs` later. The
   * frame is a `HEARTBEAT`, which already carries `databases` (r1 deviation 2), so a replica
   * needs no new code to act on it.
   */
  announce(): void {
    // Hosted: the router owns the announcement, because it is one fact about the whole node and a
    // worker knows only its own shard's databases as *open*. Every caller — the registry's
    // `onChange` and C2's promotion — reaches the router through this one hook rather than each
    // growing its own.
    if (this.hosted) {
      if (!this.#closed) this.#onAnnounce?.()
      return
    }
    if (this.#closed || this.#conns.size === 0) return
    const announcement = this.#announcement()
    this.#sweepStreams(announcement)
    for (const conn of [...this.#conns]) {
      if (!conn.authed || conn.closed) continue
      this.#send(conn, this.#heartbeatFor(conn, Date.now(), announcement))
    }
  }

  /** One `HEARTBEAT` for one connection: its stream positions plus the current announcement. */
  #heartbeatFor(conn: Conn, now: number, announcement: Map<string, string>): Uint8Array {
    return encodeJson(FRAME.HEARTBEAT, {
      ts: now,
      streams: [...conn.streams.values()].map((stream) => ({
        stream: stream.id,
        txid: stream.tenant.txid.toString(),
      })),
      databases: [...announcement.keys()],
      generations: Object.fromEntries(announcement),
    } satisfies HeartbeatBody)
  }

  /**
   * Ends every stream whose database is no longer the one it subscribed to — deleted, closed
   * underneath it, or re-created under a new generation id. Without this a deleted database leaves
   * a stream pointing at a closed tenant: no records flow, no error is raised, `replicasOf` keeps
   * reporting a replica of something that no longer exists, and `#tick` reads `txid` off a tenant
   * that has been torn down. The replica learns from the announcement this runs just before.
   */
  #isOpen(db: string): boolean {
    try {
      return this.registry.openNames.includes(db)
    } catch {
      return false
    }
  }

  #sweepStreams(announcement: Map<string, string>): void {
    for (const conn of [...this.#conns]) {
      for (const stream of [...conn.streams.values()]) {
        const current = announcement.get(stream.db)
        const replaced = current !== stream.generation
        if (!replaced && !stream.tenant.closed) continue
        // A tenant that was closed and *reopened* under the same name was swapped on purpose —
        // C2's promotion and demotion both close a tenant and open it in the other role — so the
        // stream is ended (the replica re-subscribes and picks up the new one) without being
        // reported. Only a tenant that is closed and gone is news.
        const swapped = !replaced && this.#isOpen(stream.db)
        // A delete or a re-create is somebody's deliberate act and is not this node's news to
        // report — the replica logs what it lets go of, which is where the surprise lives. A
        // tenant closed under a stream whose database is otherwise unchanged is not deliberate.
        if (!replaced && !swapped) {
          this.#onError(
            new Error(
              `${stream.db} was closed under stream ${stream.id} to replica ${conn.node}; ` +
                `ending it so the replica re-subscribes`,
            ),
          )
        }
        this.#endStream(conn, stream)
      }
    }
  }

  /**
   * R2's other half of write forwarding. The work is the caller's — `src/server/forward.ts` runs
   * it through the same request path an HTTP write takes — and everything here does is keep the
   * `id` and turn a throw into a `RESULT` the replica can re-raise verbatim.
   */
  async #forward(conn: Conn, request: ForwardBody): Promise<void> {
    const id = Number(request?.id)
    if (!Number.isFinite(id)) {
      this.#fail(conn, "PROTO", "a FORWARD frame needs a numeric id")
      return
    }
    if (!this.#onForward) {
      this.#result(conn, {
        id,
        ok: false,
        error: { code: "NOT_PRIMARY", message: "this node does not run forwarded writes" },
      })
      return
    }
    try {
      const result = await this.#onForward(request, conn.node)
      this.#result(conn, { id, ok: true, result })
    } catch (err) {
      this.#result(conn, { id, ok: false, error: errorOf(err) })
    }
  }

  #result(conn: Conn, body: ResultBody): void {
    if (conn.closed) return
    this.#send(conn, encodeJson(FRAME.RESULT, body))
  }

  /**
   * Every live database, in catalog order, with the generation id that identifies *this* one of
   * them (`docs/r7-unfollow.md`). A `Map` because both halves of the announcement — the names and
   * the ids — come off the same rows and must never disagree about which names are live.
   */
  #announcement(): Map<string, string> {
    try {
      return new Map(
        // A copy this node received as a replica keeps the id it was bootstrapped under; only a
        // database this node minted gets one derived from its own row. See `generationOf`.
        this.registry.list().map((row) => [row.name, this.#generationOf(row.name) ?? generationId(row)]),
      )
    } catch {
      return new Map()
    }
  }

  /** This node's generation id for one database, or `null` when it holds no such database. */
  #generationFor(db: string): string | null {
    const held = this.#generationOf(db)
    if (held) return held
    try {
      const row = this.registry.list().find((one) => one.name === db)
      return row ? generationId(row) : null
    } catch {
      return null
    }
  }

  // ── subscribe and bootstrap ──────────────────────────────────────────────────────────────────

  async #subscribe(conn: Conn, request: SubscribeBody): Promise<void> {
    const id = request.stream >>> 0
    if (conn.streams.has(id)) this.#endStream(conn, conn.streams.get(id) as Stream)
    let tenant: Tenant
    try {
      tenant = this.registry.open(request.db)
    } catch {
      this.#error(conn, id, "UNKNOWN_DB", `no such database: ${request.db}`)
      return
    }
    // A tenant that is itself a replica may serve a downstream one (chained replication): it
    // streams what it has applied, from its own log, and is never more current than its stream.
    const fromTxid = parseBig(request.fromTxid)
    const epoch = Number(request.epoch) || 0
    if (epoch > tenant.epoch) {
      this.#error(
        conn,
        id,
        "EPOCH_AHEAD",
        `${request.db}: the replica claims epoch ${epoch}, this node holds ${tenant.epoch}`,
      )
      // The fencing signal. Reporting it is the whole point: without this the stream simply went
      // quiet and a fenced primary kept accepting writes (C2, `docs/c2-promotion.md`).
      try {
        this.#onEpochAhead({ db: request.db, node: conn.node, epoch, held: tenant.epoch })
      } catch (err) {
        this.#onError(err)
      }
      return
    }

    // A replica that names a generation this node does not hold is holding a *different*
    // database under this name, however well its txid and checksum line up with ours. Treat it
    // exactly as `reset` — a snapshot, whatever `#decide` would otherwise have said.
    const generation = this.#generationFor(request.db) ?? ""
    const stale =
      typeof request.generation === "string" &&
      request.generation.length > 0 &&
      generation.length > 0 &&
      request.generation !== generation

    const stream: Stream = {
      id,
      db: request.db,
      tenant,
      generation,
      sentTxid: 0n,
      ackedTxid: fromTxid,
      ackedAtMs: Date.now(),
      fsynced: false,
      unhook: null,
      buffer: [],
      catchingUp: true,
      closed: false,
    }
    conn.streams.set(id, stream)
    // A tenant with a replica attached must not be evicted underneath it: closing it would drop
    // the commit listener and the stream would silently stop.
    this.registry.pin(request.db, PIN_OWNER)

    const decision = stale
      ? ({ kind: "snapshot", reason: null } as const)
      : this.#decide(tenant, fromTxid, parseBig(request.checksum), request.reset === true)
    if (stale) {
      this.#error(
        conn,
        id,
        "DIVERGED",
        `${request.db}: the replica holds generation ${request.generation}, this node holds ` +
          `${generation} — a different database has worn this name`,
      )
    }
    if (decision.kind === "stream") {
      this.#send(
        conn,
        encodeJson(FRAME.SUBSCRIBED, {
          stream: id,
          db: request.db,
          mode: "stream",
          txid: fromTxid.toString(),
          epoch: tenant.epoch,
          pageSize: tenant.pageSize,
          generation,
        } satisfies SubscribedBody),
      )
      stream.sentTxid = fromTxid
      this.#catchUp(conn, stream, fromTxid)
      return
    }

    if (decision.reason) {
      this.#error(conn, id, decision.reason.code, decision.reason.message)
    }
    try {
      await this.#bootstrap(conn, stream)
    } catch (err) {
      this.#onError(err)
      if (!stream.closed) {
        this.#error(conn, id, "INTERNAL", "the primary could not produce a snapshot")
        this.#endStream(conn, stream)
      }
    }
  }

  /**
   * `plan-phase1.md`'s four-step rule, in order: a replica at zero, a replica outside the log, a
   * replica whose next record follows it exactly, and everything else.
   */
  #decide(
    tenant: Tenant,
    fromTxid: bigint,
    checksum: bigint,
    reset: boolean,
  ): { kind: "stream" } | { kind: "snapshot"; reason: { code: ReplicationErrorCode; message: string } | null } {
    if (fromTxid === 0n) {
      // Two pristine databases need no file between them. A primary that has never committed has
      // nothing to copy, and the replica's own empty database is exactly what a snapshot of this
      // one would leave it with — so the stream starts at record 1 and the writer is never taken.
      // That matters beyond the saved copy: a snapshot holds the tenant exclusively, and a
      // database announced the moment it is created (finding 1) is one a client is usually
      // writing to in the same breath.
      if (!reset && tenant.txid === 0n && checksum === 0n) return { kind: "stream" }
      return { kind: "snapshot", reason: null }
    }

    // Fully caught up: nothing to compare but the database's own state.
    if (fromTxid === tenant.txid) {
      if (checksum === tenant.checksum) return { kind: "stream" }
      return {
        kind: "snapshot",
        reason: {
          code: "DIVERGED",
          message: `${tenant.name}: at txid ${fromTxid} the replica holds checksum ${checksum}, this node holds ${tenant.checksum}`,
        },
      }
    }

    if (fromTxid > tenant.txid) {
      return {
        kind: "snapshot",
        reason: {
          code: "DIVERGED",
          message: `${tenant.name}: the replica is at txid ${fromTxid}, ahead of this node's ${tenant.txid}`,
        },
      }
    }

    const next = tenant.log.read(fromTxid + 1n)
    if (!next) {
      return {
        kind: "snapshot",
        reason: {
          code: "RETENTION",
          message: `${tenant.name}: txid ${fromTxid + 1n} has aged out of the log`,
        },
      }
    }
    if (next.prevTxid !== fromTxid || next.preChecksum !== checksum) {
      return {
        kind: "snapshot",
        reason: {
          code: "DIVERGED",
          message: `${tenant.name}: record ${next.txid} expects checksum ${next.preChecksum}, the replica reports ${checksum}`,
        },
      }
    }
    return { kind: "stream" }
  }

  /**
   * Bootstrap by snapshot. The newest snapshot the log can still stream from is reused; when
   * there is none, one is taken. The commit listener is attached *before* the file is read, for
   * the same reason the catch-up attaches it first: a transaction that commits while the snapshot
   * is on the wire must not be lost.
   */
  async #bootstrap(conn: Conn, stream: Stream): Promise<void> {
    const tenant = stream.tenant
    const ref = await this.#snapshotFor(tenant)
    if (stream.closed) return
    const txid = BigInt(ref.txid)
    const pageSize = ref.pageSize || tenant.pageSize

    this.#send(
      conn,
      encodeJson(FRAME.SUBSCRIBED, {
        stream: stream.id,
        db: stream.db,
        mode: "snapshot",
        txid: txid.toString(),
        epoch: tenant.epoch,
        pageSize,
        generation: stream.generation,
      } satisfies SubscribedBody),
    )

    const file = fs.readFileSync(ref.path)
    const plain = new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
    // What the replica is seeded with has to be the *tenant's* position at `txid`, which is not
    // always the file's own page count and XOR. A database nothing has ever written to is the one
    // that differs: SQLite creates its header page when the file is opened in WAL mode, outside
    // any transaction, so the tenant stands at "0 pages, checksum 0" while the file holds one
    // page. Seeding a replica from the file there would make it XOR that page out of its first
    // apply and diverge on record 1. A snapshot older than the tenant's current txid has no such
    // shortcut, and for one there is no pristine case to worry about: record 1 rewrites page 1.
    const current = txid === tenant.txid
    const position = tenant.position
    this.#send(
      conn,
      encodeJson(FRAME.SNAPSHOT_BEGIN, {
        stream: stream.id,
        txid: txid.toString(),
        epoch: current ? tenant.epoch : ref.epoch,
        checksum: current ? position.checksum.toString() : ref.checksum,
        bytes: plain.byteLength,
        pageSize,
        pages: current ? position.dbSizePages : ref.pages,
      }),
    )
    for (let at = 0, seq = 0; at < plain.byteLength; at += CHUNK_BYTES, seq++) {
      const chunk = plain.subarray(at, Math.min(at + CHUNK_BYTES, plain.byteLength))
      const compressed = new Uint8Array(Bun.zstdCompressSync(chunk, { level: 3 }))
      this.#send(conn, encodeSnapshotChunk(stream.id, seq, compressed))
      if (stream.closed) return
    }
    this.#send(
      conn,
      encodeJson(FRAME.SNAPSHOT_END, {
        stream: stream.id,
        txid: txid.toString(),
        hash: Bun.hash.xxHash3(plain).toString(),
      }),
    )

    stream.sentTxid = txid
    stream.ackedTxid = txid
    this.#catchUp(conn, stream, txid)
  }

  async #snapshotFor(tenant: Tenant): Promise<SnapshotRef> {
    const usable = this.#usableSnapshot(tenant)
    if (usable) return usable
    // Two replicas bootstrapping at once must not race for the writer: the first one's snapshot is
    // the answer for both, and `Tenant.snapshot` refuses a second concurrent call with BUSY.
    const inflight = this.#snapshots.get(tenant.name)
    if (inflight) return await inflight
    const taken = this.#take(tenant)
    this.#snapshots.set(tenant.name, taken)
    try {
      return await taken
    } finally {
      if (this.#snapshots.get(tenant.name) === taken) this.#snapshots.delete(tenant.name)
    }
  }

  /**
   * Takes a snapshot, waiting out a writer that holds the tenant. A client write in flight is a
   * matter of microseconds and is not a reason to refuse a replica its bootstrap.
   */
  async #take(tenant: Tenant): Promise<SnapshotRef> {
    let last: unknown = null
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        return await tenant.snapshot()
      } catch (err) {
        last = err
        if ((err as { code?: string }).code !== "BUSY") throw err
        const usable = this.#usableSnapshot(tenant)
        if (usable) return usable
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    throw last
  }

  /**
   * A snapshot the replica can be streamed forward from: its txid has to be the tenant's current
   * one, or the log has to still hold the record right after it.
   */
  #usableSnapshot(tenant: Tenant): SnapshotRef | null {
    const first = tenant.log.firstTxid
    const usable = listSnapshots(tenant.dir).filter((ref) => {
      const at = BigInt(ref.txid)
      if (at > tenant.txid) return false
      if (at === tenant.txid) return true
      return first !== null && first <= at + 1n
    })
    return usable.at(-1) ?? null
  }

  // ── catch-up and live streaming ──────────────────────────────────────────────────────────────

  /**
   * `plan-phase1.md`, "Catch-up without a gap": attach the listener first and buffer, read the log
   * up to the txid the tenant was at when the listener attached, then flush the buffer skipping
   * anything already sent.
   */
  #catchUp(conn: Conn, stream: Stream, fromTxid: bigint): void {
    const tenant = stream.tenant
    stream.catchingUp = true
    stream.unhook = tenant.onCommit((event) => {
      if (stream.closed) return
      if (stream.catchingUp) {
        stream.buffer.push({ txid: event.txid, bytes: event.bytes })
        return
      }
      this.#emit(conn, stream, event.txid, event.bytes)
    })

    const attachTxid = tenant.txid
    try {
      if (attachTxid > fromTxid) {
        for (const record of tenant.log.iterate(fromTxid + 1n)) {
          if (stream.closed) return
          if (record.txid > attachTxid) break
          this.#emit(conn, stream, record.txid, encode(record as unknown as TxnRecordInput))
        }
      }
    } catch (err) {
      // The log aged out underneath the read. Say so and let the replica come back from zero.
      this.#onError(err)
      this.#error(conn, stream.id, "RETENTION", `${stream.db}: the log moved while catching up`)
      this.#endStream(conn, stream)
      return
    }

    stream.catchingUp = false
    const buffered = stream.buffer
    stream.buffer = []
    for (const pending of buffered) {
      if (pending.txid <= stream.sentTxid) continue
      this.#emit(conn, stream, pending.txid, pending.bytes)
    }
  }

  /** Sends one record, or queues it when the socket is backpressured. */
  #emit(conn: Conn, stream: Stream, txid: bigint, bytes: Uint8Array): void {
    if (stream.closed || conn.closed) return
    if (txid <= stream.sentTxid) return
    stream.sentTxid = txid
    this.recordsSent += 1
    this.#send(conn, encodeTxn(stream.id, bytes))
  }

  // ── sending ──────────────────────────────────────────────────────────────────────────────────

  #send(conn: Conn, frame: Uint8Array): void {
    if (conn.closed) return
    if (conn.paused) {
      conn.queue.push(frame)
      return
    }
    const sent = conn.ws.send(frame)
    if (sent === 0) {
      // Refused outright: keep it and replay on `drain`.
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

  #error(
    conn: Conn,
    stream: number | undefined,
    code: ReplicationErrorCode,
    message: string,
  ): void {
    this.#send(
      conn,
      encodeJson(FRAME.ERROR, {
        ...(stream === undefined ? {} : { stream }),
        code,
        message,
      }),
    )
  }

  /** A fatal error: say what happened, then close. */
  #fail(conn: Conn, code: ReplicationErrorCode, message: string): void {
    this.#error(conn, undefined, code, message)
    try {
      conn.ws.close(code === "AUTH_FAILED" ? 1008 : 1002, code)
    } catch {
      // Already gone.
    }
    this.#teardown(conn)
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────────────────────────

  #endStream(conn: Conn, stream: Stream): void {
    if (stream.closed) return
    stream.closed = true
    stream.unhook?.()
    stream.unhook = null
    stream.buffer = []
    conn.streams.delete(stream.id)
    this.#unpin(stream.db)
  }

  /** The tenant stays pinned while any stream anywhere still follows it. */
  #unpin(db: string): void {
    for (const conn of this.#conns) {
      for (const stream of conn.streams.values()) {
        if (stream.db === db) return
      }
    }
    this.registry.unpin(db, PIN_OWNER)
  }

  #teardown(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    if (conn.authed && this.#onDisconnect) {
      try {
        this.#onDisconnect(conn.node)
      } catch (err) {
        this.#onError(err)
      }
    }
    for (const stream of [...conn.streams.values()]) this.#endStream(conn, stream)
    conn.queue = []
    this.#conns.delete(conn)
    this.#stopTimerIfIdle()
  }

  #startTimer(): void {
    // Hosted: the router heartbeats once for the node, gathering this server's `positions()`.
    // N workers ticking down one socket would send N announcements per interval.
    if (this.hosted) return
    if (this.#timer !== null || this.#closed) return
    this.#timer = setInterval(() => this.#tick(), this.heartbeatMs)
    this.#timer.unref?.()
  }

  #stopTimerIfIdle(): void {
    if (this.#conns.size > 0 || this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  /** Heartbeats, and the slow-replica cut-off. */
  #tick(): void {
    const now = Date.now()
    const announcement = this.#announcement()
    this.#sweepStreams(announcement)
    for (const conn of [...this.#conns]) {
      if (conn.paused && now - conn.pausedSinceMs > this.slowReplicaMs) {
        this.#fail(
          conn,
          "BUSY",
          `this socket has been backpressured for ${now - conn.pausedSinceMs}ms`,
        )
        continue
      }
      if (!conn.authed) continue
      this.#send(conn, this.#heartbeatFor(conn, now, announcement))
    }
  }
}

/**
 * A thrown value as the `{code, message, status}` a replica re-raises. The shape is deliberately
 * the server's error body rather than a replication code: the client on the far side must see the
 * primary's own failure, not a transport wrapper around it.
 */
function errorOf(err: unknown): NonNullable<ResultBody["error"]> {
  const any = err as {
    code?: unknown
    message?: unknown
    status?: unknown
    details?: { txid?: number; failedIndex?: number }
  }
  const code = typeof any?.code === "string" ? any.code : "INTERNAL"
  const message = typeof any?.message === "string" ? any.message : "internal error"
  const status = typeof any?.status === "number" ? any.status : undefined
  const txid = any?.details?.txid
  const failedIndex = any?.details?.failedIndex
  return {
    code,
    message,
    ...(status === undefined ? {} : { status }),
    ...(txid === undefined ? {} : { txid }),
    ...(failedIndex === undefined ? {} : { failedIndex }),
  }
}

function parseBig(value: string | number | undefined): bigint {
  if (value === undefined || value === null || value === "") return 0n
  try {
    return BigInt(value)
  } catch {
    throw new ProtocolError(`${JSON.stringify(value)} is not a txid`)
  }
}
