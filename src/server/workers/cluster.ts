// The control plane across the worker channel (`docs/c4d-cluster-workers.md`), and the last of C4.
//
// Decision: **the `ClusterNode` stays whole on the router, and only the lease deadline crosses.**
// The router owns the Raft log, the socket, the timers, `propose`, the lease cache, renewal and
// failover; the worker that owns a database owns everything the control plane needs told about it
// — the claim, the ack, the promotion request, the demotion and the local flip — because every
// input to those is a tenant's (`#requestFor` reads `tenant.txid`, `tenant.epoch`, the generation
// ledger and the live stream). So the `Promoter` runs on the worker, unchanged, and the two things
// it cannot do there cross as round trips that were already awaiting a Raft commit.
//
// Invariant, and the whole reason this file is careful: **the write path costs nothing.**
// `assertWritable` on a worker is one `Map.get` and one `performance.now()`, exactly as it is on a
// single-threaded node. Not one message per write, not one per statement. That is design §5.3's
// rule — push the state down, never let a worker block on the control plane.
//
// Second invariant: **a deadline is an instant, not a duration.** Each Bun worker has its own
// `performance.timeOrigin` (measured: 2.465 ms apart on one run, −1.28 on another, constant to
// 64 µs over 2 s), so `validUntilLocalMs` cannot cross verbatim. It is converted with an offset
// the worker measures itself over a round trip on monotonic clocks only, rounded in the direction
// that can only *shorten* a lease. Re-stamping a remaining duration on arrival was rejected: its
// error is the transit time, it is unbounded when the worker's event loop is busy, and it is in
// the unsafe direction. `docs/c4d-cluster-workers.md` §3.1.

import type {
  ClusterLink,
  ClusterState,
  ClusterView,
  ClusterViewDb,
  Command,
  LeaseHandle,
  NodeId,
  PromotionOutcome,
  PromotionRequest,
  RaftHandlers,
} from "../../cluster/index.ts"
import type { ClusterViewPush, FromWorker } from "./protocol.ts"
import type { WorkerPool } from "./pool.ts"

/** Probes the router sends before the first view, so an offset is measured rather than guessed. */
export const PROBES_AT_START = 8

/**
 * A worker's `ClusterLink`: a table the router pushed, a clock offset this thread measured, and
 * two round trips. It holds no decision at all — every decision is the `ClusterNode`'s on the
 * router or the `Promoter`'s on this thread — which is why it is short.
 */
export class HostedCluster implements ClusterLink {
  id: NodeId = ""
  proposeTimeoutMs = 6000

  #post: (message: FromWorker) => void
  #monotonic: () => number
  /** Deadlines already converted into this thread's clock. The write path reads only this. */
  #deadlines = new Map<string, number>()
  /** The last view the router pushed, as `ClusterState` so `Promoter` reads it unchanged. */
  #state: ClusterState = { nodes: {}, dbs: {}, term: 0 }
  #dbs: ClusterViewDb[] = []
  #leader: NodeId | null = null
  /**
   * The greatest lower bound on (this thread's clock − the router's) seen so far, or null before
   * the first probe answers. Conservative by construction: converting with a low offset makes a
   * deadline early, never late.
   */
  #offset: number | null = null
  /** Deadlines that arrived before the first probe answered, kept to convert once it does. */
  #pendingHold: [string, number][] = []
  #listeners = new Set<() => void>()
  #proposals = new Map<number, (reply: { ok: boolean; reason?: string }) => void>()
  #promotions = new Map<number, (outcome: PromotionOutcome) => void>()
  #seq = 0
  #closed = false

  constructor(post: (message: FromWorker) => void, monotonic: () => number = () => performance.now()) {
    this.#post = post
    this.#monotonic = monotonic
  }

  // ── the write path ───────────────────────────────────────────────────────────────────────────

  /**
   * The whole write-path check, and the only member of this class that is on it. One `Map.get` and
   * one `performance.now()`, with no message, no await and no allocation — which is the measure of
   * whether this seam was cut in the right place.
   */
  holdsLease(db: string): boolean {
    const deadline = this.#deadlines.get(db)
    return deadline !== undefined && this.#monotonic() < deadline
  }

  /**
   * The handle as this thread sees it: the deadline already converted into its own clock. A lease
   * held elsewhere reads 0, which is always in the past here exactly as it is on the router.
   */
  leaseFor(db: string): LeaseHandle | null {
    const entry = this.#state.dbs[db]
    if (!entry?.lease) return null
    return {
      node: entry.lease.node,
      epoch: entry.epoch,
      validUntilLocalMs: this.#deadlines.get(db) ?? 0,
    }
  }

  // ── the pushed table ─────────────────────────────────────────────────────────────────────────

  knows(db: string): boolean {
    return this.#state.dbs[db] !== undefined
  }

  epochOf(db: string): number | null {
    const entry = this.#state.dbs[db]
    return entry ? entry.epoch : null
  }

  primaryOf(db: string): NodeId | null {
    const entry = this.#state.dbs[db]
    if (!entry) return null
    return entry.lease?.node ?? entry.primary
  }

  advertiseOf(node: NodeId): string | null {
    const advertise = this.#state.nodes[node]?.advertise ?? ""
    return advertise.length > 0 ? advertise : null
  }

  isLeader(): boolean {
    return this.#leader !== null && this.#leader === this.id
  }

  get state(): ClusterState {
    return this.#state
  }

  observeDbs(): ClusterViewDb[] {
    return this.#dbs
  }

  /**
   * Null, always. The term, the commit index and which peers this node can reach are the router's,
   * and `GET /v1/cluster` is not a `/v1/db/:db/…` route, so it is answered there. Nothing reaches
   * this; if a routing bug ever does, the route says where the control plane is instead of
   * inventing a term and a leader. §3.4.
   */
  observe(): ClusterView | null {
    return null
  }

  /** Likewise: the router owns the listener, so no upgrade can arrive on this thread. */
  get socket(): RaftHandlers | null {
    return null
  }

  // ── the round trips ──────────────────────────────────────────────────────────────────────────

  propose(command: Command): Promise<{ ok: boolean; reason?: string }> {
    if (this.#closed) return Promise.resolve({ ok: false, reason: "this worker is shutting down" })
    const id = this.#seq++
    return new Promise((resolve) => {
      this.#proposals.set(id, resolve)
      this.#post({ kind: "cluster.propose", id, command })
    })
  }

  promote(request: PromotionRequest): Promise<PromotionOutcome> {
    if (this.#closed) {
      return Promise.resolve({ ok: false, code: "NOT_COMMITTED", why: "this worker is shutting down" })
    }
    const id = this.#seq++
    return new Promise((resolve) => {
      this.#promotions.set(id, resolve)
      this.#post({ kind: "cluster.promote", id, request })
    })
  }

  /**
   * This shard's primaries, for the router to **union** with the other shards'. A worker never
   * renews a lease itself — renewal needs the lease cache and `propose`, neither of which is a
   * tenant fact — so this is the whole of what renewal needs to know from here. §3.3.
   */
  setOwned(dbs: Iterable<string>): void {
    this.#post({ kind: "cluster.owned", dbs: [...dbs] })
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Nothing to start: the probes and the first view are the router's to send, and it sends the
   * probes first so an offset is usually measured before the first deadline needs converting.
   * One that is not waits in `#pendingHold` rather than being converted against a guess.
   */
  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.#closed = true
    for (const resolve of this.#proposals.values()) resolve({ ok: false, reason: "this worker is shutting down" })
    this.#proposals.clear()
    for (const resolve of this.#promotions.values()) {
      resolve({ ok: false, code: "NOT_COMMITTED", why: "this worker is shutting down" })
    }
    this.#promotions.clear()
    this.#deadlines.clear()
  }

  // ── what the router sends ────────────────────────────────────────────────────────────────────

  /**
   * The router asked for this thread's stamp. `t1` is carried back untouched so the router can
   * bound the round trip, and `t2` is the only reading of this clock that leaves the thread.
   */
  probed(id: number, t1: number): void {
    this.#post({ kind: "cluster.probe.reply", id, t1, t2: this.#monotonic() })
  }

  /**
   * The offset the router computed from one probe: a **lower** bound on (this clock − the
   * router's). Only ever tightened upward, which is sound because the offset does not drift — both
   * origins are fixed at thread start and both clocks are the same OS monotonic clock — and which
   * can only ever make a converted deadline later by less than one round trip.
   */
  offset(lower: number): void {
    if (this.#offset === null || lower > this.#offset) this.#offset = lower
    if (this.#pendingHold.length > 0 && this.#offset !== null) {
      this.#convert(this.#pendingHold)
      this.#pendingHold = []
    }
  }

  /** The shard's slice of the replicated state, after a commit that changed it. */
  view(push: ClusterViewPush): void {
    this.id = push.id
    this.proposeTimeoutMs = push.proposeTimeoutMs
    this.#leader = push.leader
    this.#dbs = push.dbs
    const nodes: ClusterState["nodes"] = {}
    for (const [id, advertise] of push.nodes) {
      nodes[id] = { advertise, zone: "", joinedTerm: 0, status: "voter" }
    }
    const dbs: ClusterState["dbs"] = {}
    for (const entry of push.dbs) {
      dbs[entry.db] = {
        primary: entry.primary,
        replicas: entry.replicas,
        epoch: entry.epoch,
        lease: entry.lease,
        acked: entry.acked,
        generation: entry.generation,
      }
    }
    this.#state = { nodes, dbs, term: 0 }
    // A database whose lease is not in `hold` is not held here, so its deadline goes rather than
    // going stale: this map *is* the write-path answer and nothing else prunes it.
    if (this.#offset === null) this.#pendingHold = push.hold
    else this.#convert(push.hold)
    for (const listener of this.#listeners) listener()
  }

  #convert(hold: [string, number][]): void {
    const offset = this.#offset ?? 0
    this.#deadlines.clear()
    for (const [db, routerDeadline] of hold) this.#deadlines.set(db, routerDeadline + offset)
  }

  proposed(id: number, ok: boolean, reason?: string): void {
    const resolve = this.#proposals.get(id)
    if (!resolve) return
    this.#proposals.delete(id)
    resolve({ ok, ...(reason === undefined ? {} : { reason }) })
  }

  promoted(id: number, outcome: PromotionOutcome): void {
    const resolve = this.#promotions.get(id)
    if (!resolve) return
    this.#promotions.delete(id)
    resolve(outcome)
  }
}

/**
 * The router's side: the per-shard owned map, the view push, and the two relays. It holds the one
 * decision this seam has — that `setOwned` is a **union** and never a replace — and nothing else.
 */
export class ClusterShards {
  #pool: WorkerPool
  #cluster: ClusterLink
  #onError: (err: unknown) => void
  /** Shard → the primaries it holds. Unioned into the node's owned set; never replaced. */
  #owned = new Map<number, string[]>()
  #probe = 0

  constructor(pool: WorkerPool, cluster: ClusterLink, onError: (err: unknown) => void) {
    this.#pool = pool
    this.#cluster = cluster
    this.#onError = onError
  }

  /**
   * Pushes every shard its own slice, filtered by the shard function. Called once at start and
   * then on every commit that changed the replicated state — a few a second, never per write.
   */
  push(): void {
    const dbs = this.#cluster.observeDbs()
    const nodes: [string, string][] = []
    for (const entry of dbs) {
      for (const node of [entry.primary, ...entry.replicas]) {
        if (node === null) continue
        if (nodes.some(([id]) => id === node)) continue
        const advertise = this.#cluster.advertiseOf(node)
        if (advertise) nodes.push([node, advertise])
      }
    }
    const perShard = new Map<number, ClusterViewDb[]>()
    const hold = new Map<number, [string, number][]>()
    for (const entry of dbs) {
      const shard = this.#pool.shardOf(entry.db)
      const list = perShard.get(shard)
      if (list) list.push(entry)
      else perShard.set(shard, [entry])
      const lease = this.#cluster.leaseFor(entry.db)
      if (lease === null || lease.node !== this.#cluster.id) continue
      const deadline = lease.validUntilLocalMs
      const held = hold.get(shard)
      if (held) held.push([entry.db, deadline])
      else hold.set(shard, [[entry.db, deadline]])
    }
    for (let shard = 0; shard < this.#pool.size; shard++) {
      try {
        this.#pool.clusterView(shard, {
          kind: "cluster.view",
          id: this.#cluster.id,
          leader: this.#cluster.observe()?.leader ?? null,
          nodes,
          proposeTimeoutMs: this.#cluster.proposeTimeoutMs,
          dbs: perShard.get(shard) ?? [],
          hold: hold.get(shard) ?? [],
        })
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  /** One clock probe to every worker. Cheap enough to ride the renewal tick. */
  probe(): void {
    const id = this.#probe++
    for (let shard = 0; shard < this.#pool.size; shard++) {
      const t1 = performance.now()
      try {
        this.#pool.clusterProbe(shard, id, t1)
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  /**
   * A probe came back. `t2` lies between the two instants this thread stamped, so
   * `t2 − t3 ≤ offset ≤ t2 − t1`; the worker is told the **lower** bound, which is conservative by
   * construction. The error is one round trip — 28 µs to 204 µs measured — against a
   * `leaseGuardMs` of 500 ms. §3.1.
   */
  probed(shard: number, t1: number, t2: number): void {
    const t3 = performance.now()
    try {
      this.#pool.clusterOffset(shard, t2 - t3)
    } catch (err) {
      this.#onError(err)
    }
  }

  /** A shard's primaries. The union is the node's owned set; one shard never replaces it. §3.3 */
  owned(shard: number, dbs: string[]): void {
    this.#owned.set(shard, dbs)
    const union: string[] = []
    for (const list of this.#owned.values()) union.push(...list)
    this.#cluster.setOwned(union)
  }

  async propose(shard: number, id: number, command: Command): Promise<void> {
    let reply: { ok: boolean; reason?: string }
    try {
      reply = await this.#cluster.propose(command)
    } catch (err) {
      reply = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    try {
      this.#pool.clusterProposed(shard, id, reply)
    } catch (err) {
      this.#onError(err)
    }
  }

  async promote(shard: number, id: number, request: PromotionRequest): Promise<void> {
    let outcome: PromotionOutcome
    try {
      outcome = await this.#cluster.promote(request)
    } catch (err) {
      outcome = {
        ok: false,
        code: "NOT_COMMITTED",
        why: err instanceof Error ? err.message : String(err),
      }
    }
    try {
      this.#pool.clusterPromoted(shard, id, outcome)
    } catch (err) {
      this.#onError(err)
    }
  }
}
