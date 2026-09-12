// Where a database lives: which node is its home and which nodes hold its replicas.
// `docs/c3-placement.md` §2, design §5.3.
//
// Invariant: `place` is pure. No clock, no module state, no I/O — every node runs it over the same
// replicated membership and has to land on the same answer, because that is what lets a create be
// gated without a quorum (§3.2). Two nodes that disagreed here would both create `acme`, which is
// the hole this module exists to close.
//
// Second invariant: it degrades rather than refuses. A two-node cluster in one zone with `rf = 2`
// places both copies; a cluster with fewer zones than `rf` spreads as far as it can and then stops
// spreading. A placement function that answered "cannot satisfy the constraint" would be a control
// plane that stops working when a rack goes away, which is the moment it is needed.
//
// **Rendezvous hashing, not a ring.** A ring needs virtual nodes to be uniform (a tuning parameter
// nobody tunes), a sorted structure rebuilt on every membership change, and that structure kept
// byte-identical on every node. Rendezvous is `argmax` over a loop: uniform without vnodes, moves
// only the minimum share of databases when a node joins or leaves, and is a pure function of
// arguments every node already holds. At a node count in the tens, the ring's `O(log N)` lookup
// against this `O(N)` is not a quantity worth a second data structure.

import type { NodeId } from "./state.ts"

export interface PlacementNode {
  id: NodeId
  /** Rack or AZ label. Empty counts as its own zone, so an unlabelled cluster still spreads. */
  zone: string
}

export interface Placement {
  primary: NodeId
  /** `rf - 1` of them when the cluster is big enough, fewer when it is not. */
  replicas: NodeId[]
}

/**
 * The home node for `db` and its replica set, from the membership and the replica factor.
 *
 * Returns null for an empty cluster — the standalone case, where there is no placement to have and
 * every node creates what it likes.
 *
 * `rf` counts the primary: `rf = 2` is one primary and one replica.
 */
export function place(db: string, nodes: PlacementNode[], rf: number): Placement | null {
  if (nodes.length === 0) return null
  const ranked = rank(db, nodes)
  const primary = ranked[0] as PlacementNode
  const wanted = Math.max(1, Math.min(Math.floor(rf), ranked.length))

  // Spread first: a node whose zone is already represented is skipped.
  const chosen: PlacementNode[] = [primary]
  const zones = new Set<string>([zoneOf(primary)])
  for (const node of ranked.slice(1)) {
    if (chosen.length >= wanted) break
    if (zones.has(zoneOf(node))) continue
    chosen.push(node)
    zones.add(zoneOf(node))
  }
  // Then degrade: fewer zones than `rf` is the common shape, not an error.
  if (chosen.length < wanted) {
    const taken = new Set(chosen.map((one) => one.id))
    for (const node of ranked) {
      if (chosen.length >= wanted) break
      if (taken.has(node.id)) continue
      chosen.push(node)
      taken.add(node.id)
    }
  }
  return { primary: primary.id, replicas: chosen.slice(1).map((one) => one.id) }
}

/** Is `node` the home for `db`? The create gate's whole question. */
export function homeOf(db: string, nodes: PlacementNode[]): NodeId | null {
  if (nodes.length === 0) return null
  return (rank(db, nodes)[0] as PlacementNode).id
}

/**
 * Every node, best first. Sorted by score descending and then by id, so a hash collision — which
 * at 64 bits over a cluster of tens is not going to happen, but which must not be a source of
 * disagreement if it does — resolves the same way everywhere.
 */
function rank(db: string, nodes: PlacementNode[]): PlacementNode[] {
  const scored = nodes.map((node) => ({ node, score: scoreOf(db, node.id) }))
  scored.sort((a, b) =>
    a.score === b.score ? (a.node.id < b.node.id ? -1 : 1) : a.score < b.score ? 1 : -1,
  )
  return scored.map((one) => one.node)
}

/**
 * `hash(db + NUL + node)`. The separator matters: without it `("ab", "c")` and `("a", "bc")` would
 * score identically, and a database name that is a prefix of another's would not be independent
 * of it.
 *
 * Unlike `shardOf`'s hash, this one's answer *is* persisted — `placeDb` writes the chosen nodes
 * into the raft log — so changing it would place new databases differently while leaving existing
 * ones exactly where they are. That is a loss of balance, not a loss of correctness, and it is why
 * a placement is recorded rather than recomputed on every read (§2.3).
 */
function scoreOf(db: string, node: NodeId): bigint {
  return Bun.hash.xxHash3(`${db}\u0000${node}`)
}

/** An unlabelled node is its own zone, so an unlabelled cluster spreads across nodes. */
function zoneOf(node: PlacementNode): string {
  return node.zone.length > 0 ? node.zone : `\u0000${node.id}`
}
