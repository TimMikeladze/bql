// Promotion, demotion and fencing: the one place that decides which databases this node is the
// primary for, right now, and the only place that changes that answer.
//
// Invariant: a database's live role is the catalog row, and nothing may change that row without
// going through `#flip`. `ServerRuntime.role` used to be a `readonly` field copied out of the
// config, which meant a node promoted at runtime kept refusing its own `POST /v1/db` with
// `503 NOT_PRIMARY` while handing clients a `BunQL-Primary` pointing at the node it had just
// replaced (`docs/next.md`). Everything that asks — `requirePrimary`, the forwarder, `BunQL-Role`,
// the replication client and the realtime engine — asks here, so they cannot disagree.
//
// Second invariant, and the one that matters: **no write is accepted without a live lease.**
// `assertWritable` is on the write path and is a `Map.get`, a `performance.now()` and two
// comparisons; a node with no `[cluster]` configured pays one null check. The lease's safety
// argument is in `src/cluster/node.ts`'s header and `docs/c2-promotion.md`.
//
// Third invariant: a promotion the control plane refuses changes nothing. The decision is taken
// before `#flip` is called, and `#flip` is the only thing that touches the catalog, the stream or
// the tenant.

import {
  type ClusterNode,
  decidePromotion,
  type PromotionOutcome,
  type PromotionRequest,
} from "../cluster/index.ts"
import { BunQLError } from "./errors.ts"
import type { ServerRuntime } from "./runtime.ts"

export type NodeRole = "primary" | "replica"

/** Where a client should go for a database this node will not write. */
export interface PrimaryLocation {
  /** The node id, when this node knows one. */
  node: string | null
  /** What goes in `BunQL-Primary`. */
  url: string | null
  /** An HTTP base a request can actually be replayed against, when one is knowable. */
  http: string | null
}

export interface PromoteOptions {
  /** Overrides `STREAM_LIVE`, `LEASE_HELD` and `BEHIND`. Nothing else. */
  force?: boolean
}

/** How often a clustered node reports its applied positions, so failover can pick the best copy. */
const ACK_INTERVAL_MS = 1000

export class Promoter {
  readonly runtime: ServerRuntime

  /** Databases whose catalog row says `replica`. The live per-database role, cached. */
  #following = new Set<string>()
  /** Every database in the catalog, so a name this node has never held falls back to the node. */
  #known = new Set<string>()
  /** Where a fenced database went, as far as this node was able to learn. */
  #moved = new Map<string, PrimaryLocation>()
  /** Last position reported to the control plane, so an unchanged one costs no Raft entry. */
  #acked = new Map<string, bigint>()
  /** Claims in flight, so a retry does not race the attempt it is retrying. */
  #claiming = new Set<string>()
  #ackTimer: ReturnType<typeof setInterval> | null = null
  /** True once this node has been promoted for anything, which is what lets the node role flip. */
  #everPromoted = false
  #closed = false

  constructor(runtime: ServerRuntime) {
    this.runtime = runtime
    this.refresh()
    // A node configured as a replica whose catalog holds databases and calls none of them a
    // replica was promoted in an earlier run and never reconfigured. Remembering that is what
    // makes a promotion survive a restart of a statically configured node.
    if (this.runtime.configuredRole === "replica" && this.#following.size === 0) {
      this.#everPromoted = this.runtime.registry.list().length > 0
    }
  }

  // ── what this node is ────────────────────────────────────────────────────────────────────────

  /** Reads the catalog once and caches which databases this node follows rather than owns. */
  refresh(): void {
    if (this.#closed) return
    const following = new Set<string>()
    const known = new Set<string>()
    try {
      for (const row of this.runtime.registry.list()) {
        known.add(row.name)
        if (row.role === "replica") following.add(row.name)
      }
    } catch {
      // The registry is closing. Whatever is cached is as good an answer as there is.
      return
    }
    this.#following = following
    this.#known = known
  }

  /**
   * The live role for one database.
   *
   * A name this node holds no copy of has no per-database answer, so it falls back to the node's
   * own role — which is what keeps `POST /v1/db/{new}/import` refused on a replica, exactly as it
   * was before promotion existed.
   */
  roleFor(db: string): NodeRole {
    if (this.#following.has(db)) return "replica"
    if (this.#known.has(db)) return "primary"
    return this.nodeRole
  }

  /**
   * The node's own role, for `BunQL-Role` on a response that names no database, `/healthz` and the
   * `requirePrimary` gate on `POST /v1/db`.
   *
   * A configured replica reports `replica` until it has been promoted for something and follows
   * nothing any more. "Follows nothing" alone is not enough: a replica that has just started, or
   * one whose primary is unreachable, also holds no replica-role database and is emphatically not
   * a primary.
   */
  get nodeRole(): NodeRole {
    if (this.runtime.configuredRole === "primary") return "primary"
    return this.#everPromoted && this.#following.size === 0 ? "primary" : "replica"
  }

  /** Databases this node follows rather than owns. */
  get following(): string[] {
    return [...this.#following]
  }

  // ── where a client should go ─────────────────────────────────────────────────────────────────

  /**
   * Where a write this node will not take should go. In order: a fencing event that named the node
   * that took the database, then the control plane's own record, then the statically configured
   * primary.
   */
  primaryFor(db: string): PrimaryLocation {
    const cluster = this.runtime.cluster
    if (cluster) {
      const node = cluster.primaryOf(db)
      if (node && node !== cluster.id) {
        const http = httpBase(cluster.advertiseOf(node))
        return { node, url: http, http }
      }
    }
    const moved = this.#moved.get(db)
    if (moved && (moved.url || moved.node)) return moved
    const configured = this.runtime.config.replication.primary
    if (this.roleFor(db) === "replica" && configured) {
      // Phase 1's value, unchanged: `ws://host/v1/replication`. A client cannot replay a request
      // against that, but the SDK knows how to turn it into the HTTP base beside it.
      return { node: null, url: configured, http: httpBase(configured) }
    }
    return { node: null, url: null, http: null }
  }

  // ── the write path ───────────────────────────────────────────────────────────────────────────

  /**
   * The lease check. Called immediately before a transaction is opened, and nothing else about the
   * control plane is on the write path.
   *
   * A database the control plane has never heard of is not gated: a clustered node that has just
   * created one, or one that predates the cluster, would otherwise be unable to write to its own
   * database until the claim committed. Placement — which closes the "two nodes both created
   * `acme`" hole properly — is C3.
   */
  assertWritable(db: string): void {
    const cluster = this.runtime.cluster
    if (cluster === null) return
    if (cluster.holdsLease(db)) return
    if (!cluster.knows(db)) return
    const where = this.primaryFor(db)
    throw new BunQLError(
      "NOT_PRIMARY",
      `${db}: this node does not hold a valid lease on it` +
        (where.node ? `; ${where.node} does` : ""),
      503,
      { ...(where.url ? { primary: where.url } : {}) },
    )
  }

  // ── promotion ────────────────────────────────────────────────────────────────────────────────

  /**
   * Makes this node the primary for one database.
   *
   * The decision comes first and is taken by the control plane when there is one — on the Raft
   * leader, against the leader's own clock — so a refusal leaves this node exactly as it was.
   */
  async promote(db: string, options: PromoteOptions = {}): Promise<PromotionOutcome> {
    const request = this.#requestFor(db, options.force === true)
    const cluster = this.runtime.cluster
    const outcome: PromotionOutcome = cluster
      ? await cluster.promote(request)
      : decidePromotion({ ...request, placedGeneration: null, cluster: null })
    if (!outcome.ok) return outcome
    try {
      this.#flip(db, "primary", outcome.epoch)
    } catch (err) {
      this.runtime.report(err)
      return {
        ok: false,
        code: "NOT_COMMITTED",
        why: `${db} was granted at epoch ${outcome.epoch} but could not be opened as a primary: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }
    return outcome
  }

  /** Everything this node can say about its own copy, for the decision. */
  #requestFor(db: string, force: boolean): PromotionRequest {
    const registry = this.runtime.registry
    const row = registry.has(db) ? registry.list().find((one) => one.name === db) : undefined
    const replica = this.runtime.replica
    const status = replica?.status().streams.find((one) => one.db === db)
    let applied = "0"
    let localEpoch = row?.epoch ?? 0
    if (row) {
      try {
        const tenant = registry.open(db)
        applied = tenant.txid.toString()
        localEpoch = tenant.epoch
      } catch {
        applied = String(row.txid)
      }
    }
    return {
      db,
      node: this.runtime.node,
      hasCopy: row !== undefined,
      isPrimaryLocally: this.roleFor(db) === "primary",
      localGeneration: this.runtime.generationOf(db),
      applied,
      localEpoch,
      streamLive: (replica?.connected ?? false) && status !== undefined,
      force,
    }
  }

  // ── demotion, which is what fencing does ─────────────────────────────────────────────────────

  /**
   * Stops this node being the primary for one database, at once.
   *
   * Called from two places: a `SUBSCRIBE` claiming an epoch this node does not hold (proof that
   * the control plane granted the database elsewhere after granting it here), and a committed
   * `grantLease` naming somebody else. It never throws — a node that cannot reopen its own copy as
   * a replica must still stop writing to it — and it never deletes anything.
   */
  demote(db: string, reason: string, where?: Partial<PrimaryLocation>): void {
    if (where && (where.node || where.url)) {
      this.#moved.set(db, {
        node: where.node ?? null,
        url: where.url ?? null,
        http: where.http ?? httpBase(where.url ?? null),
      })
    }
    if (this.roleFor(db) === "replica") return
    try {
      this.#flip(db, "replica", null)
    } catch (err) {
      this.runtime.report(err)
    }
    this.runtime.report(new FencedNotice(`${db}: ${reason}`))
    this.runtime.movedFrom(db)
    // Converge without an operator when there is somewhere to converge on. A node that knows only
    // a node id serves reads and says where the database went; inventing a URL from a peer's
    // handshake would let any peer redirect this node's writes.
    const http = this.#moved.get(db)?.http ?? this.primaryFor(db).http
    if (http) this.runtime.followPrimary(replicationUrl(http))
  }

  // ── the local flip ───────────────────────────────────────────────────────────────────────────

  /**
   * Turns one database from a replica copy into a primary or back. The order is the whole of it
   * and `docs/c2-promotion.md` explains each step:
   *
   * evict (the realtime engine captured `replicaMode` at construction) · detach the stream, keeping
   * the copy · close the tenant, which folds its WAL and leaves the file as the state · rewrite the
   * catalog row · reopen · announce.
   */
  #flip(db: string, role: NodeRole, epoch: number | null): void {
    const registry = this.runtime.registry
    const catalog = registry.catalog
    const already = this.roleFor(db) === role
    const tenantEpoch = registry.has(db) ? safeEpoch(registry, db) : 0
    if (already && (epoch === null || epoch <= tenantEpoch)) return

    this.runtime.evict(db)
    if (role === "primary") this.runtime.replica?.detach(db)
    registry.release(db)
    catalog.setRole(db, role)
    if (epoch !== null && epoch > tenantEpoch) catalog.setEpoch(db, epoch)
    if (role === "primary") {
      this.#following.delete(db)
      this.#everPromoted = true
      registry.open(db)
    } else {
      this.#following.add(db)
      registry.openReplica(db)
      this.runtime.replica?.attach(db)
    }
    this.runtime.replication?.announce()
    // The role this node plays for the database has changed, so the control plane is told. Never
    // awaited from here: `#flip` is called from the write-adjacent paths and from a cluster
    // notification, neither of which may block on a round trip.
    void this.claim(db).catch((err) => this.runtime.report(err))
  }

  // ── the control plane ────────────────────────────────────────────────────────────────────────

  /** Starts the position reporter. Called beside `startReplication`. */
  start(): void {
    if (this.#ackTimer !== null || !this.runtime.cluster) return
    this.claimAll()
    this.#ackTimer = setInterval(() => {
      this.#reconcileClaims()
      this.#reportPositions()
    }, ACK_INTERVAL_MS)
    this.#ackTimer.unref?.()
  }

  close(): void {
    this.#closed = true
    if (this.#ackTimer !== null) clearInterval(this.#ackTimer)
    this.#ackTimer = null
  }

  /** Tells the control plane which databases this node holds, and in which role. */
  claimAll(): void {
    const cluster = this.runtime.cluster
    if (!cluster) return
    this.refresh()
    for (const row of this.runtime.registry.list()) void this.claim(row.name)
    cluster.setOwned(this.#ownedNames())
  }

  #ownedNames(): string[] {
    const owned: string[] = []
    for (const row of this.runtime.registry.list()) {
      if (row.role !== "replica") owned.push(row.name)
    }
    return owned
  }

  /**
   * Registers one database with the control plane and, when this node owns it, takes its lease.
   *
   * Awaiting matters on the create path: `claimDb` makes the database *known* to the cluster, and
   * a known database with no lease is refused writes — so a `POST /v1/db` that returned before the
   * grant committed would be followed by a `503` on the caller's very next statement.
   */
  async claim(db: string): Promise<void> {
    const cluster = this.runtime.cluster
    if (!cluster || this.#claiming.has(db)) return
    this.#claiming.add(db)
    try {
      await this.#claim(cluster, db)
    } finally {
      this.#claiming.delete(db)
    }
  }

  async #claim(cluster: ClusterNode, db: string): Promise<void> {
    cluster.setOwned(this.#ownedNames())
    const role = this.roleFor(db)
    if (!this.runtime.registry.has(db)) return
    const claimed = await cluster.propose({
      type: "claimDb",
      db,
      node: this.runtime.node,
      role,
      // Only a primary may state the generation: a replica that has been disconnected across a
      // delete and a re-create still holds the old id, and letting it write that here would
      // overwrite the fact the promotion check depends on. And it is the identity this node's
      // *copy* carries, never one derived from a catalog row this node wrote itself — see
      // `ServerRuntime.generationOf`.
      ...(role === "primary" ? { generation: this.runtime.generationOf(db) ?? undefined } : {}),
    })
    if (!claimed.ok || role !== "primary") return
    // Take the lease for a database this node already owns. It goes through the same decision as
    // any promotion, so the guard applies: a node that has been fenced is told `LEASE_HELD` and
    // demotes rather than quietly re-taking its old database.
    const outcome = await cluster.promote(this.#requestFor(db, false))
    if (outcome.ok) {
      if (outcome.epoch > safeEpoch(this.runtime.registry, db)) {
        this.#flip(db, "primary", outcome.epoch)
      }
      return
    }
    if (outcome.code === "LEASE_HELD") {
      this.demote(db, outcome.why, { node: cluster.primaryOf(db) })
    }
  }

  /**
   * Claims a database and waits until this node actually holds its lease, so the caller that just
   * created it can write to it. Reports rather than throws: a database exists whether or not the
   * control plane answered in time, and the write path refuses on its own if it did not.
   */
  async ensureLease(db: string): Promise<void> {
    const cluster = this.runtime.cluster
    if (!cluster || this.roleFor(db) === "replica") return
    // Polled rather than awaited once: the convergence loop may already have a claim in flight for
    // this database, and what the caller needs is the lease, not one particular attempt at it.
    const deadline = Date.now() + cluster.proposeTimeoutMs * 2
    while (!cluster.holdsLease(db) && !this.#closed) {
      try {
        await this.claim(db)
      } catch (err) {
        this.runtime.report(err)
      }
      if (cluster.holdsLease(db) || Date.now() > deadline) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /**
   * Re-claims any database whose placement does not yet say what this node is.
   *
   * A claim is one Raft proposal, and a proposal a follower makes is forwarded over a socket that
   * may not be up yet — at start, or across an election — in which case it is dropped, because
   * this transport drops rather than queues. Nothing else would ever notice: the node would simply
   * never appear in its own database's placement, and a failover would have no candidate to pick.
   * So the claim is a convergence loop rather than a one-shot, and the conditions below are all
   * "the cluster does not yet agree with what this node is".
   */
  #reconcileClaims(): void {
    const cluster = this.runtime.cluster
    if (!cluster || this.#closed) return
    const me = this.runtime.node
    for (const row of this.runtime.registry.list()) {
      const entry = cluster.state.dbs[row.name]
      const role = this.roleFor(row.name)
      const stale =
        entry === undefined ||
        (role === "primary" && (entry.primary !== me || entry.lease?.node !== me)) ||
        (role === "replica" && !entry.replicas.includes(me))
      if (!stale) continue
      void this.claim(row.name).catch((err) => this.runtime.report(err))
    }
  }

  /** One `ack` per placed database whose applied position has moved. Failover reads these. */
  #reportPositions(): void {
    const cluster = this.runtime.cluster
    if (!cluster || this.#closed) return
    for (const name of this.runtime.registry.openNames) {
      if (!cluster.knows(name)) continue
      let txid: bigint
      try {
        txid = this.runtime.registry.open(name).txid
      } catch {
        continue
      }
      if ((this.#acked.get(name) ?? -1n) >= txid) continue
      this.#acked.set(name, txid)
      void cluster
        .propose({ type: "ack", db: name, node: this.runtime.node, txid: txid.toString() })
        .catch((err) => this.runtime.report(err))
    }
  }

  /**
   * The control plane has committed something. Two facts matter here: a lease granted to somebody
   * else for a database this node owns (demote at once), and a lease granted to *this* node for a
   * database it is following (promote, which is what automatic failover looks like from here).
   */
  onClusterChange(): void {
    const cluster = this.runtime.cluster
    if (!cluster || this.#closed) return
    for (const entry of cluster.observe().dbs) {
      const holder = entry.lease?.node ?? entry.primary
      if (!holder) continue
      if (holder !== cluster.id) {
        if (this.roleFor(entry.db) === "primary" && this.runtime.registry.has(entry.db)) {
          this.demote(
            entry.db,
            `the cluster granted it to ${holder} at epoch ${entry.epoch}`,
            { node: holder, url: httpBase(cluster.advertiseOf(holder)) },
          )
        }
        continue
      }
      if (this.roleFor(entry.db) !== "replica" || !this.runtime.registry.has(entry.db)) continue
      try {
        this.#flip(entry.db, "primary", entry.epoch)
        this.runtime.report(
          new FencedNotice(
            `${entry.db}: the cluster granted it to this node at epoch ${entry.epoch}; promoted`,
          ),
        )
      } catch (err) {
        this.runtime.report(err)
      }
    }
  }
}

/**
 * A promotion or a fencing, reported the way a replica's notices are: operational news about the
 * cluster, not a fault in this process, so it is printed as a message and not as a stack.
 */
export class FencedNotice extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FencedNotice"
  }
}

/** `ws://h:p/v1/replication` or `ws://h:p` → `http://h:p`. Null stays null. */
export function httpBase(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol
    parsed.pathname = ""
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return null
  }
}

/** The inverse: an HTTP base → the `/v1/replication` socket beside it. */
export function replicationUrl(base: string): string {
  return `${base.replace(/^http/i, "ws").replace(/\/+$/, "")}/v1/replication`
}

function safeEpoch(registry: ServerRuntime["registry"], db: string): number {
  try {
    return registry.open(db).epoch
  } catch {
    return 0
  }
}
