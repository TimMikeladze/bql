// C3b: which node subscribes to which (`docs/c3-placement.md` §3.4).
//
// Decision: **one client per upstream *node*, not per database.** With `[cluster] rf = 2` over four
// nodes a node is in the replica set of databases whose primaries are different nodes, so it holds
// a connection to each — and every database that node is the primary of travels down the one
// connection to it, which is what a `follow` list is for.
//
// Invariant: this plans, it does not place. `place()` decides where a database *should* live and
// `claimDb` records where it *does*; this reads the second, falls back to the first only for a
// database the cluster knows but nothing has claimed, and never proposes anything. A planner that
// wrote to the log would be a second placement authority.
//
// Second invariant: a database this node is the primary of is never followed, whatever placement
// says. That is the two-writers case arriving through the back door, and `ReplicaClient` already
// refuses it per stream (`#detached`); refusing it here as well means it never gets that far.

import { place, type PlacementNode } from "../cluster/index.ts"
import { httpBase, replicationUrl } from "./promote.ts"
import type { ServerRuntime } from "./runtime.ts"

/** How often the plan is recomputed when nothing has changed. Cheap: a loop over the databases. */
const SWEEP_MS = 1000

export class FollowPlanner {
  readonly #runtime: ServerRuntime
  #timer: ReturnType<typeof setInterval> | null = null
  #closed = false
  /** The last plan applied, so an unchanged one costs nothing. */
  #applied = ""

  constructor(runtime: ServerRuntime) {
    this.#runtime = runtime
  }

  /** Starts planning. A node with no cluster plans nothing and this is a no-op. */
  start(): void {
    if (this.#timer !== null || !this.#runtime.cluster) return
    this.plan()
    this.#timer = setInterval(() => this.plan(), SWEEP_MS)
    this.#timer.unref?.()
  }

  close(): void {
    this.#closed = true
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * Recomputes which upstreams this node should hold and reconciles them.
   *
   * Called on every cluster change and once a second, because both a placement and an *advertise*
   * can move — a node that restarts on a new port is the same node with a different URL, and the
   * sweep is what notices.
   */
  plan(): void {
    const runtime = this.#runtime
    const cluster = runtime.cluster
    if (!cluster || this.#closed) return
    // Never on a worker. The upstream connections are the router's — a worker's hosted clients are
    // created by the `follow.start` it sends — and a worker that planned would open one socket per
    // thread to every upstream. `start()` guards this too, but the cluster's `onChange` reaches
    // `plan` directly, so the guard belongs here where the decision is.
    if (runtime.replicationMode === "hosted") return
    if (!runtime.config.replication.secret) return

    const me = cluster.id
    const members: PlacementNode[] = Object.entries(cluster.state.nodes).map(([id, info]) => ({
      id,
      zone: info.zone,
    }))
    const wanted = new Map<string, string[]>()
    for (const entry of cluster.observeDbs()) {
      const primary = entry.lease?.node ?? entry.primary
      // Nowhere to follow from, or this node *is* the primary: both mean no stream.
      if (!primary || primary === me) continue
      // The **catalog row**, not `roleFor`: on the router of a sharded node the `Promoter`'s cache
      // is a read of a catalog that its workers write, so a replica row a worker created during a
      // bootstrap does not reach it and `roleFor` still answers "primary". The row is the truth on
      // every thread. (`primary === me` above is the cluster's view of the same question; this is
      // the local one, for the window where the two disagree.)
      const row = runtime.registry.list().find((one) => one.name === entry.db)
      if (row && row.role !== "replica") continue
      // Recorded first: a node that has claimed a copy keeps it whatever the function now says
      // (§2.3). The function only decides for a database nobody has claimed a copy of yet.
      const holds =
        entry.replicas.includes(me) ||
        (entry.replicas.length === 0 &&
          (place(entry.db, members, runtime.config.cluster.rf)?.replicas.includes(me) ?? false))
      if (!holds) continue
      const http = httpBase(cluster.advertiseOf(primary))
      if (!http) continue
      const url = replicationUrl(http)
      const list = wanted.get(url)
      if (list) list.push(entry.db)
      else wanted.set(url, [entry.db])
    }

    // A statically configured upstream is kept whatever the plan says: an operator who wrote
    // `[replication] primary` outranks a placement function.
    const configured = runtime.config.replication.primary
    if (configured && !wanted.has(configured)) {
      wanted.set(configured, [...runtime.config.replication.follow])
    }

    const key = [...wanted]
      .map(([url, dbs]) => `${url}=${[...dbs].sort().join(",")}`)
      .sort()
      .join("|")
    if (key === this.#applied) return
    this.#applied = key

    for (const [url, dbs] of wanted) runtime.ensureUpstream(url, [...dbs].sort())
    for (const client of runtime.replicaClients) {
      if (!wanted.has(client.primary)) runtime.dropUpstream(client.primary)
    }
  }
}
