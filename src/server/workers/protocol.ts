// The envelopes that cross the `postMessage` channel between the router (the main thread, which
// owns the listener) and a worker (which owns a shard of databases). `docs/c4-workers.md` §4.
//
// Invariant: every message carries a `kind` and, when it expects an answer, an `id` minted by the
// router. Ids are per pool, not per worker, so a reply can be correlated without knowing which
// worker sent it.
//
// Second invariant: nothing here is a class and nothing here holds a function. Structured clone
// is what moves these, so a field that cannot survive it — a `Response`, a socket, an object
// identity used as a key — is represented by a string id instead. That is why a transaction's
// owner and a socket are strings here and objects in `src/server/ws.ts`.
//
// A body crosses as `Uint8Array`, which structured clone copies; the alternative, a transferable
// `ArrayBuffer`, would detach the router's copy and is not worth the sharp edge for bodies that
// are almost always a few hundred bytes.

import type { MetricsState, ReplicationMetrics } from "../metrics.ts"

/** One HTTP request, on its way to the worker that owns the database its path names. */
export interface HttpHop {
  kind: "http"
  id: number
  method: string
  url: string
  headers: [string, string][]
  body: Uint8Array | null
}

/** A whole response, for a handler that returned a buffered body. */
export interface HttpReply {
  kind: "http.reply"
  id: number
  status: number
  headers: [string, string][]
  body: Uint8Array | null
}

/** The head of a streamed response — the SSE change feed, `GET /v1/db/{db}/dump`. */
export interface HttpOpen {
  kind: "http.open"
  id: number
  status: number
  headers: [string, string][]
}

export interface HttpChunk {
  kind: "http.chunk"
  id: number
  bytes: Uint8Array
}

/** The router's client went away, so the worker's own request signal must abort. */
export interface HttpAbort {
  kind: "http.abort"
  id: number
}

export interface HttpEnd {
  kind: "http.end"
  id: number
  /** Set when the worker's stream failed part way; the router aborts its own stream with it. */
  error?: string
}

// ── WebSocket relay ────────────────────────────────────────────────────────────────────────────
//
// A socket cannot cross a thread, so the worker holds a *virtual* socket per (client socket,
// worker) pair with the `SocketData` `src/server/ws.ts` expects, and everything that module does
// to a socket — `send`, `subscribe`, `unsubscribe`, `close` — comes back here as a message the
// router applies to the real one. `handleMessage` itself is unchanged.

/**
 * The router adopting a client socket on this worker, or re-stating its identity after a `hello`
 * gave the socket a new token. The credential crosses as the bearer token itself rather than as a
 * `Principal`, because a `Principal` carries `scopeFor` — a function, which structured clone
 * cannot move — and because re-authenticating on the worker is the same code path, revocation
 * check included, instead of a second one that has to be kept in step with it.
 */
export interface WsHello {
  kind: "ws.hello"
  socket: string
  token: string | null
  /**
   * Set for a libsql/Hrana socket, whose database is fixed at upgrade (`hranaUpgrade` resolves it
   * from the path, `x-namespace` or the `Host` label) — so the whole socket belongs to one shard
   * and no frame of it ever has to be routed.
   */
  hrana?: { db: string; version: number }
}

/** One client frame, verbatim, for `handleMessage` to run against the virtual socket. */
export interface WsMessage {
  kind: "ws.msg"
  socket: string
  text: string
}

/** The client socket closed; the worker runs `closeSocket` on its virtual one. */
export interface WsClose {
  kind: "ws.close"
  socket: string
}

/** Bun told the router the socket has room again. */
export interface WsDrain {
  kind: "ws.drain"
  socket: string
}

/** A frame the virtual socket produced, for the router to write to the real one. */
export interface WsSend {
  kind: "ws.send"
  socket: string
  text: string
  /**
   * Routing keys learned from this frame, so the router can send a later frame that names only a
   * baton or a subscription id to the worker that minted it. Present only on the rare frames that
   * mint one — a `tx.begin` reply and a `subscribe` reply.
   */
  bind?: { tx?: string; sub?: string }
}

export interface WsTopic {
  kind: "ws.subscribe" | "ws.unsubscribe"
  socket: string
  topic: string
}

export interface WsShut {
  kind: "ws.shut"
  socket: string
  code?: number
  reason?: string
}

// ── the replication relay (C4b) ────────────────────────────────────────────────────────────────
//
// A replica socket cannot be a virtual socket like the one above: it carries connection-level state
// that is not per database — an HMAC challenge over a nonce, a frame reader over a *binary* stream,
// one send queue, and a heartbeat that announces every database on the node. So the router owns the
// connection whole and the **stream** is what crosses, routed by the stream id a `SUBSCRIBE` mints.
// Nothing that touches a tenant is here; the only thing on the hot path is `repl.out`, one finished
// frame per `TXN`. `docs/c4b-replication-workers.md` §3.

/** A replica connection the router has authenticated, adopted on this worker. */
export interface ReplAdopt {
  kind: "repl.adopt"
  conn: string
  /** The replica's node id, from its `HELLO`. R2's `onDisconnect` rolls back by it. */
  node: string
}

/** One frame the router has already decoded, for this worker's streams. */
export interface ReplFrame {
  kind: "repl.frame"
  conn: string
  type: number
  /** The frame *body*, not the framing: the router decoded it and would only re-encode it. */
  body: Uint8Array
}

/** The socket is gone: end its streams here, unpin, roll back what it had open. */
export interface ReplGone {
  kind: "repl.gone"
  conn: string
  node: string
}

/**
 * The heartbeat tick, which is also R7's sweep: the router's announcement goes down, every
 * stream's position comes back, once per `heartbeatMs` rather than once per commit.
 */
export interface ReplPositions {
  kind: "repl.positions"
  id: number
  generations: [string, string][]
}

export interface ReplPositionsReply {
  kind: "repl.positions.reply"
  id: number
  streams: { conn: string; stream: number; txid: string }[]
}

/** A finished frame for the real socket. */
export interface ReplOut {
  kind: "repl.out"
  conn: string
  bytes: Uint8Array
}

/** The worker refused the connection (`#fail`); the router closes the real socket. */
export interface ReplShut {
  kind: "repl.shut"
  conn: string
  code?: number
  reason?: string
}

/**
 * Something on this worker moved the node's database set or a database's identity, so the router
 * re-announces. `plan-phase1.md` finding 1 across threads: the registry's `onChange` and C2's
 * promotion are in-process callbacks and cannot reach the router themselves.
 */
export interface ReplAnnounce {
  kind: "repl.announce"
}

// ── following an upstream (C4c) ────────────────────────────────────────────────────────────────
//
// C4b's seam, cut the other way: the router owns the one upstream connection — the socket, the
// reconnect, the HMAC proof, the frame reader, the generation ledger, R7's reconciliation and R2's
// forward queue — and the worker that owns a database owns that database's stream, with
// `registry.openReplica`, the snapshot file, `installSnapshot`, `registry.pin` and
// `tenant.applyRecord` all called on the thread that holds the writer. Nothing that touches a
// tenant is here; the hot path is one `follow.frame` per `TXN` down and one `follow.out` per `ACK`
// up, both irreducible. `docs/c4c-replication-follow.md` §4.

/** Follow `db` on the stream the router minted: open the copy, pin it, send `SUBSCRIBE`. */
export interface FollowStart {
  kind: "follow.start"
  stream: number
  db: string
  /**
   * What the router's ledger says this node's copy is, since the ledger is node-level and the
   * txid, epoch and checksum that go beside it in the body are the worker's. §3.3.
   */
  generation: string | null
  /** "My file cannot be trusted; send a snapshot even at txid 0." */
  reset: boolean
}

/**
 * One frame the router decoded, for this worker's streams. Only `SNAPSHOT_BEGIN`,
 * `SNAPSHOT_CHUNK`, `SNAPSHOT_END` and `TXN` are ever here — the four that touch a tenant. A
 * snapshot chunk crosses **compressed**, so zstd runs on the worker rather than on the one thread
 * that also holds every socket (§3.1), and every one of the four names its own stream in its body.
 */
export interface FollowFrame {
  kind: "follow.frame"
  type: number
  body: Uint8Array
}

/** End one stream. `drop` disposes of the local copy (R7); false is C2's detach, which keeps it. */
export interface FollowStop {
  kind: "follow.stop"
  stream: number
  db: string
  drop: boolean
  reason: string
}

/**
 * The connection-level facts, pushed so a read route on a worker needs no round trip — design
 * §5.3's rule for the lease, applied to the one other node-level fact a handler needs. Changes on
 * connect, close and `retarget`, never per record.
 */
export interface FollowLink {
  kind: "follow.link"
  connected: boolean
  primary: string
  node: string | null
  lastError: string | null
}

/**
 * The generation ledger, after every save. Without it a *chained* sharded replica would mint a
 * fresh identity from its own catalog row for every database it re-announces, and every downstream
 * replica would trash its copy and bootstrap again for no reason. §3.2.
 */
export interface FollowGenerations {
  kind: "follow.generations"
  entries: [string, string][]
}

/** The heartbeat tick: the upstream's positions down, this worker's up, once per `heartbeatMs`. */
export interface FollowStatus {
  kind: "follow.status"
  id: number
  primary: [number, string][]
}

export interface FollowStatusReply {
  kind: "follow.status.reply"
  id: number
  streams: { stream: number; db: string; applied: string; bootstrapping: boolean }[]
}

/** A finished frame for the upstream socket: `SUBSCRIBE`, `ACK`, `ERROR`. */
export interface FollowOut {
  kind: "follow.out"
  bytes: Uint8Array
}

/**
 * A snapshot installed, and the copy now exists. Posted **before** the `ACK` that follows it, so
 * the router writes the ledger before the ack reaches the wire: a copy on disk whose identity is
 * not recorded is the one failure R7 cannot recover from. §3.2.
 */
export interface FollowInstalled {
  kind: "follow.installed"
  stream: number
  db: string
  txid: string
}

/** A diverged apply wants a fresh stream from zero, and only the router may mint one. */
export interface FollowAgain {
  kind: "follow.again"
  stream: number
  db: string
  reason: string
}

/** The local copy was disposed of; the trash path belongs in `ReplicaStatus.unfollowed`. */
export interface FollowStopped {
  kind: "follow.stopped"
  db: string
  trash: string | null
}

/** R2: a write this worker could not take, on its way to the one upstream socket. */
export interface FollowForward {
  kind: "follow.forward"
  id: number
  db: string
  op: string
  body: unknown
}

/** R2: the upstream's answer, back to the worker that asked. The shape of `ResultBody`. */
export interface FollowResult {
  kind: "follow.result"
  id: number
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
    status?: number
    txid?: number
    failedIndex?: number
  }
}

/** C2 on a worker: a promotion detached a database, or a demotion re-attached one. */
export interface FollowDetach {
  kind: "follow.detach" | "follow.attach"
  db: string
}

/**
 * C4b §6's gap: a database fenced on a worker demotes and then wants this node to follow whoever
 * took it over. Starting a client inside a worker is what C4c makes unnecessary — the router has
 * one — so the worker reports the URL and the router retargets.
 */
export interface FollowPrimary {
  kind: "follow.primary"
  url: string
}

// ── worker → router, unsolicited ───────────────────────────────────────────────────────────────

/**
 * A realtime payload, already serialised, for `server.publish`. This is the whole cross-worker
 * change-feed story: a worker has no subscribers, so its `RealtimeBus` publisher posts here and
 * the router fans out over Bun's own pub/sub.
 */
export interface PublishEvent {
  kind: "publish"
  topic: string
  data: string
}

/** Design §5.3's `moved`, raised by a worker's promoter and published by the router. */
export interface MovedEvent {
  kind: "moved"
  db: string
  primary: string
}

/** Something the worker's runtime reported; the router logs it with the worker's index. */
export interface ErrorEvent {
  kind: "error"
  message: string
}

/** The worker is up and its runtime is built. */
export interface ReadyEvent {
  kind: "ready"
  /** Set when the worker failed to start; the router rejects the whole `startServer`. */
  error?: string
}

// ── control ────────────────────────────────────────────────────────────────────────────────────

export interface MetricsAsk {
  kind: "metrics"
  id: number
}

export interface MetricsReply {
  kind: "metrics.reply"
  id: number
  /** This worker's counters, for the router to add to the other workers'. */
  metrics: MetricsState
  /** Its share of the LRU, since `open` and `evictions` are per thread. */
  registry: { open: number; tenants: number; evictions: number }
  /**
   * C4b: this worker's share of the replication figures. `connected` is not here — the router owns
   * every socket and is the only thread that can count them — so this carries only what is per
   * stream: the records this worker emitted and the worst lag across its own streams.
   */
  replication?: Pick<ReplicationMetrics, "lagTxid" | "records"> | null
}

export interface Shutdown {
  kind: "shutdown"
  id: number
}

export interface ShutdownReply {
  kind: "shutdown.reply"
  id: number
}

/** Everything the router sends. */
export type ToWorker =
  /**
   * The resolved configuration, verbatim. Key material is not carried: the router resolved it
   * first, so `<dataDir>/keys.json` exists by the time a worker calls `resolveAuth`, and every
   * worker reads the same admin key and the same signing key from it rather than generating one.
   */
  | { kind: "init"; index: number; workers: number; config: unknown }
  | HttpHop
  | HttpAbort
  | WsHello
  | WsMessage
  | WsClose
  | WsDrain
  | ReplAdopt
  | ReplFrame
  | ReplGone
  | ReplPositions
  | FollowStart
  | FollowFrame
  | FollowStop
  | FollowLink
  | FollowGenerations
  | FollowStatus
  | FollowResult
  | MetricsAsk
  | Shutdown

/** Everything a worker sends. */
export type FromWorker =
  | ReadyEvent
  | HttpReply
  | HttpOpen
  | HttpChunk
  | HttpEnd
  | WsSend
  | WsTopic
  | WsShut
  | ReplOut
  | ReplShut
  | ReplAnnounce
  | ReplPositionsReply
  | FollowOut
  | FollowInstalled
  | FollowAgain
  | FollowStopped
  | FollowForward
  | FollowDetach
  | FollowPrimary
  | FollowStatusReply
  | PublishEvent
  | MovedEvent
  | ErrorEvent
  | MetricsReply
  | ShutdownReply

/** Headers as a list of pairs, which is what structured clone takes. */
export function headerPairs(headers: Headers): [string, string][] {
  const out: [string, string][] = []
  headers.forEach((value, key) => out.push([key, value]))
  return out
}

/**
 * The two frames that mint a routing key, found without parsing every frame. A `tx.begin` reply
 * carries `"tx":"…"` and a `subscribe` reply carries `"sub":"…"` beside `"ok":true`; a change or
 * live event carries `"sub"` too, but never `"ok"`, so the guard is exact rather than merely
 * cheap.
 */
export function bindingsOf(text: string): { tx?: string; sub?: string } | undefined {
  if (!text.includes('"ok":true')) return undefined
  const tx = /"tx":"([^"]+)"/.exec(text)
  const sub = /"sub":"([^"]+)"/.exec(text)
  if (!tx && !sub) return undefined
  return { ...(tx ? { tx: tx[1] as string } : {}), ...(sub ? { sub: sub[1] as string } : {}) }
}
