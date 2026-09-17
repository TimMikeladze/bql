// The envelopes that cross the `postMessage` channel between the router (the main thread, which
// owns the listener) and a worker (which owns a shard of databases). `docs/c4-workers.md` §4.
//
// Invariant: every message carries a `kind` and, when it expects an answer, an `id`. It is minted
// by the router for the exchanges the router starts — ids are per pool, not per worker, so a reply
// can be correlated without knowing which worker sent it — and by the worker for the three it
// starts itself (`follow.forward`, `cluster.propose`, `cluster.promote`), which the router keys by
// `(shard, id)` instead.
//
// Second invariant: nothing here is a class and nothing here holds a function. Structured clone
// is what moves these, so a field that cannot survive it — a `Response`, a socket, an object
// identity used as a key — is represented by a string id instead. That is why a transaction's
// owner and a socket are strings here and objects in `src/server/ws.ts`.
//
// A body crosses as `Uint8Array`, which structured clone copies; the alternative, a transferable
// `ArrayBuffer`, would detach the router's copy and is not worth the sharp edge for bodies that
// are almost always a few hundred bytes. Measured, and the body is not where the cost is: removing
// the body clone entirely is worth 6.6% of a hop while removing the *header* clone is worth 37.5%,
// which is why headers cross flat. `docs/p6-router-resolution.md` §4.

import type {
  ClusterViewDb,
  Command,
  PromotionOutcome,
  PromotionRequest,
} from "../../cluster/index.ts"
import type { MetricsState, ReplicationMetrics, StorageMetrics } from "../metrics.ts"

/**
 * One HTTP request, on its way to the worker that owns the database its path names.
 *
 * `headers` is **flat** — `"key\nvalue\nkey\nvalue"` — rather than an array of pairs, because the
 * structured clone of a dozen small strings inside five small arrays is most of what a hop costs.
 * Measured: `docs/p6-router-resolution.md` §4.
 */
export interface HttpHop {
  kind: "http"
  id: number
  method: string
  url: string
  headers: string
  body: Uint8Array | null
}

/** A whole response, for a handler that returned a buffered body. `headers` is flat; see `HttpHop`. */
export interface HttpReply {
  kind: "http.reply"
  id: number
  status: number
  headers: string
  body: Uint8Array | null
}

/** The head of a streamed response — the SSE change feed, `GET /v1/db/{db}/dump`. */
export interface HttpOpen {
  kind: "http.open"
  id: number
  status: number
  headers: string
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
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
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
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  type: number
  body: Uint8Array
}

/** End one stream. `drop` disposes of the local copy (R7); false is C2's detach, which keeps it. */
export interface FollowStop {
  kind: "follow.stop"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
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
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
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
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  entries: [string, string][]
}

/** The heartbeat tick: the upstream's positions down, this worker's up, once per `heartbeatMs`. */
export interface FollowStatus {
  kind: "follow.status"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  id: number
  primary: [number, string][]
}

export interface FollowStatusReply {
  kind: "follow.status.reply"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  id: number
  streams: { stream: number; db: string; applied: string; bootstrapping: boolean }[]
}

/** A finished frame for the upstream socket: `SUBSCRIBE`, `ACK`, `ERROR`. */
export interface FollowOut {
  kind: "follow.out"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  bytes: Uint8Array
}

/**
 * A snapshot installed, and the copy now exists. Posted **before** the `ACK` that follows it, so
 * the router writes the ledger before the ack reaches the wire: a copy on disk whose identity is
 * not recorded is the one failure R7 cannot recover from. §3.2.
 */
export interface FollowInstalled {
  kind: "follow.installed"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  stream: number
  db: string
  txid: string
}

/** A diverged apply wants a fresh stream from zero, and only the router may mint one. */
export interface FollowAgain {
  kind: "follow.again"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  stream: number
  db: string
  reason: string
}

/** The local copy was disposed of; the trash path belongs in `ReplicaStatus.unfollowed`. */
export interface FollowStopped {
  kind: "follow.stopped"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  db: string
  trash: string | null
}

/** R2: a write this worker could not take, on its way to the one upstream socket. */
export interface FollowForward {
  kind: "follow.forward"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  id: number
  db: string
  op: string
  body: unknown
}

/** R2: the upstream's answer, back to the worker that asked. The shape of `ResultBody`. */
export interface FollowResult {
  kind: "follow.result"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
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
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  db: string
}

/**
 * C4b §6's gap: a database fenced on a worker demotes and then wants this node to follow whoever
 * took it over. Starting a client inside a worker is what C4c makes unnecessary — the router has
 * one — so the worker reports the URL and the router retargets.
 */
export interface FollowPrimary {
  kind: "follow.primary"
  /** Which upstream this belongs to; 0 on a node with one. */
  up: number
  url: string
}

// ── the control plane (C4d) ────────────────────────────────────────────────────────────────────
//
// The router owns the `ClusterNode` whole — the Raft log, the socket, the timers, `propose`, the
// lease cache, renewal and failover — and the worker that owns a database owns everything the
// control plane needs *told* about it, because every input to a claim, an ack or a promotion
// request is a tenant's. What crosses for the write path is one thing, downward only: the lease
// deadline, converted into the worker's own monotonic clock.
//
// Nothing here is on the write path. `assertWritable` on a worker is the same `Map.get` and the
// same `performance.now()` it is on a single-threaded node, and costs no message at all — which
// is design §5.3's rule and the reason the view is pushed rather than asked for.
// `docs/c4d-cluster-workers.md` §4.

/**
 * This shard's slice of the replicated state, after every commit that changed it.
 *
 * Filtered to the shard: a worker only ever answers for databases that hash to it (`entry.ts`
 * refuses anything else), so the other shards' state would be state nobody on that thread may
 * read. `hold` carries the deadlines of the leases this *node* holds, stamped on the **router's**
 * monotonic clock — the worker converts them with the offset it measured itself (§3.1).
 */
export interface ClusterViewPush {
  kind: "cluster.view"
  id: string
  /** The raft leader as this node knows it, so a worker's `isLeader()` is not a guess. */
  leader: string | null
  /** Node id to `ws://host:port`, for the redirect a fenced database answers with. */
  nodes: [string, string][]
  proposeTimeoutMs: number
  dbs: ClusterViewDb[]
  /** `db` → `validUntilLocalMs` on the router's clock, for leases this node holds. */
  hold: [string, number][]
}

/**
 * One leg of the clock probe. Each Bun worker has its own `performance.timeOrigin` — measured, not
 * assumed — so a deadline cannot cross verbatim; `t1` comes back untouched beside the worker's own
 * stamp and the router's receive stamp bounds the offset. §3.1.
 */
export interface ClusterProbe {
  kind: "cluster.probe"
  id: number
  t1: number
}

export interface ClusterProbeReply {
  kind: "cluster.probe.reply"
  id: number
  t1: number
  t2: number
}

/**
 * The offset the router computed from one probe: a **lower** bound on (the worker's clock minus
 * the router's), which is what lets a worker convert a deadline the router stamped. Conservative
 * by construction — a low offset makes a deadline early, never late. §3.1.
 */
export interface ClusterOffset {
  kind: "cluster.offset"
  lower: number
}

/** A command for the log. The id is the worker's, as `follow.forward`'s is. */
export interface ClusterPropose {
  kind: "cluster.propose"
  id: number
  command: Command
}

export interface ClusterProposed {
  kind: "cluster.proposed"
  id: number
  ok: boolean
  reason?: string
}

/** A promotion, decided by the Raft leader against its own wall clock and applied on this worker. */
export interface ClusterPromote {
  kind: "cluster.promote"
  id: number
  request: PromotionRequest
}

export interface ClusterPromoted {
  kind: "cluster.promoted"
  id: number
  outcome: PromotionOutcome
}

/**
 * This shard's primaries, so the router can union them. **Never a replace**: `#renewOwn` renews a
 * lease only for a database in the node's owned set, and one shard's set replacing the node's
 * would drop the other shards' leases at the next renewal tick. §3.3.
 */
export interface ClusterOwned {
  kind: "cluster.owned"
  dbs: string[]
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

/**
 * C4d: a database's role flipped on this worker — a promotion or a fencing rewrote its catalog
 * row. The router derives `BunQL-Role` and the `requirePrimary` gate on `POST /v1/db` from its own
 * read of that catalog, and a row rewritten on another thread reaches no `onChange` here, so a
 * promoted sharded node would otherwise keep calling itself a replica for ever.
 */
export interface RoleEvent {
  kind: "role"
  db: string
  role: "primary" | "replica"
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
  /**
   * Its share of the LRU, since `open` and `evictions` are per thread — and of the write queue,
   * which is per tenant and so sums across the shards like any other disjoint quantity (L2).
   */
  registry: {
    open: number
    tenants: number
    evictions: number
    writeQueueDepth: number
    pinned: number
    openRefused: number
    fsync: { total: number; lastDurationUs: number; pending: number; deferred: number } | null
    /** P7: this thread's connections. Disjoint shards, so all three sum. */
    statementCache: { hits: number; misses: number; evictions: number }
  }
  /**
   * C4b: this worker's share of the replication figures. `connected` is not here — the router owns
   * every socket and is the only thread that can count them — so this carries only what is per
   * stream: the records this worker emitted and the worst lag across its own streams.
   */
  replication?: Pick<ReplicationMetrics, "lagTxid" | "records"> | null
  /**
   * This worker's share of the S3 shipper. A shipper is per database and a database belongs to
   * exactly one worker, so the shards are disjoint and the node's figures are the same merge the
   * single-threaded node already does across its own databases: `shippedTxid` maxes,
   * `pendingRecords`, `errors` and `bytes` sum, `behind` counts.
   */
  storage?: StorageMetrics | null
}

/**
 * C4e: which databases a worker holds open, and how far each has got. `GET /v1/db` is answered on
 * the router, which owns the catalog and no tenant, so without this it reported every database as
 * `"open": false` with the catalog's throttled txid — true of the router and false of the node.
 *
 * One gather on an admin listing route, never on a data path.
 */
export interface DbsAsk {
  kind: "dbs"
  id: number
}

export interface DbsReply {
  kind: "dbs.reply"
  id: number
  /** Decimal, because a txid is a u64 and structured clone of a bigint is not worth the asymmetry. */
  open: { name: string; txid: string }[]
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
  | ClusterViewPush
  | ClusterProbe
  | ClusterOffset
  | ClusterProposed
  | ClusterPromoted
  | MetricsAsk
  | DbsAsk
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
  | ClusterProbeReply
  | ClusterPropose
  | ClusterPromote
  | ClusterOwned
  | PublishEvent
  | MovedEvent
  | RoleEvent
  | ErrorEvent
  | MetricsReply
  | DbsReply
  | ShutdownReply

/**
 * Headers as one string for the channel: `"key\nvalue\nkey\nvalue"`.
 *
 * A newline is a safe separator because HTTP forbids one in a header name or value — a request
 * carrying one never reaches here, because Bun's own parser rejects it first.
 *
 * Why not pairs: a structured clone walks every object and every string it meets, and an array of
 * N two-element arrays is 3N+1 allocations against one. Replacing it is worth 19% of a hop's cost
 * on its own (`docs/p6-router-resolution.md` §4).
 */
export function flattenHeaders(headers: Headers): string {
  const parts: string[] = []
  headers.forEach((value, key) => {
    parts.push(key, value)
  })
  return parts.join("\n")
}

/** The same, from pairs the caller already has. */
export function flattenPairs(pairs: readonly (readonly [string, string])[]): string {
  const parts: string[] = []
  for (const [key, value] of pairs) parts.push(key, value)
  return parts.join("\n")
}

/** Back to pairs, which is what `new Request`/`new Response` and `databaseOf` take. */
export function unflattenHeaders(flat: string): [string, string][] {
  if (flat.length === 0) return []
  const parts = flat.split("\n")
  const out: [string, string][] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push([parts[i] as string, parts[i + 1] as string])
  }
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
