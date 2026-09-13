// Whether a node may become the primary for a database, and which node a lapsed lease goes to.
//
// Invariant: both functions here are pure. They read no clock, no socket and no module state —
// every time, position and identity they need rides in the input — so the decision that must never
// be wrong can be tested exhaustively without a cluster, exactly as `raft.ts` and
// `logRetentionFloor` are. A promotion's failure mode is two writers and silence, which is the
// house test for "make it a pure function".
//
// Second invariant: `decidePromotion` refuses before it permits. Every refusal is checked in a
// fixed order, and the one that matters for safety — `LEASE_HELD` — is checked against the *Raft
// leader's* wall clock, because the leader is the only node that may decide a lease has lapsed.
// See `docs/c2-promotion.md` for the three-leg argument this sits inside.

import { compareTxid, type NodeId } from "./state.ts"

/** Why a promotion was refused. Every one of these leaves the candidate exactly as it was. */
export type PromotionRefusal =
  | "NO_COPY"
  | "GENERATION_MISMATCH"
  | "STREAM_LIVE"
  | "LEASE_HELD"
  | "ALREADY_PRIMARY"
  | "BEHIND"

/**
 * Everything `ClusterNode.promote` can answer: the decision's own refusals, plus the two that are
 * about reaching the control plane rather than about the database. They are kept out of
 * `PromotionRefusal` so the pure function's set stays exhaustive and exhaustively tested.
 */
export type PromotionOutcomeCode = PromotionRefusal | "NO_LEADER" | "NOT_COMMITTED"

export type PromotionOutcome =
  | { ok: true; epoch: number; why: string }
  | { ok: false; code: PromotionOutcomeCode; why: string }

/** The control plane's record for one database, as the Raft leader sees it when it decides. */
export interface ClusterFacts {
  epoch: number
  primary: NodeId | null
  replicas: NodeId[]
  lease: { node: NodeId; until: number } | null
  /** Highest txid each node has told the control plane it holds, decimal. */
  acked: Record<NodeId, string>
  /** The leader's own wall clock. The only wall clock in the decision. */
  nowMs: number
}

export interface PromotionInput {
  db: string
  /** The node asking to become the primary. */
  node: NodeId
  /** False when this node holds no copy of the database at all. */
  hasCopy: boolean
  /** True when this node already authors transactions for it. */
  isPrimaryLocally: boolean
  /** The generation id of the local copy, or null against a peer that announces none. */
  localGeneration: string | null
  /** The generation the cluster placed, or null when nothing has recorded one. */
  placedGeneration: string | null
  /** Highest txid this node has durably applied, decimal. */
  applied: string
  /** The epoch this node's copy carries. */
  localEpoch: number
  /**
   * True when this node still has a live replication stream for the database — the old primary is
   * up, announcing it, and streaming records onto this copy right now.
   */
  streamLive: boolean
  /** The control plane's record, or null in a static topology. */
  cluster: ClusterFacts | null
  /** Overrides `STREAM_LIVE`, `LEASE_HELD` and `BEHIND`, and nothing else. */
  force: boolean
}

export type PromotionDecision =
  | { ok: true; epoch: number; why: string }
  | { ok: false; code: PromotionRefusal; why: string }

/**
 * Everything a candidate can say about itself, as it travels to the Raft leader. It is
 * `PromotionInput` minus the two facts only the leader may supply — the control plane's record and
 * the wall clock the lease is stamped in — which is the whole reason the decision is taken there.
 */
export type PromotionRequest = Omit<PromotionInput, "cluster" | "placedGeneration">

/**
 * The whole promotion decision, as one function of explicit inputs.
 *
 * The epoch it returns is the one the `grantLease` command must carry: one past the highest epoch
 * anybody is known to hold when the lease changes hands, and unchanged when it does not — a holder
 * whose lease lapsed and is re-taking it fences nobody off, and burning an epoch there would make
 * every replica of that database re-snapshot for nothing.
 */
export function decidePromotion(input: PromotionInput): PromotionDecision {
  const { db, node, cluster } = input

  if (!input.hasCopy) {
    return { ok: false, code: "NO_COPY", why: `${node} holds no copy of ${db} to promote` }
  }

  // A name is not an identity (R7). A copy of the *previous* database to wear this name would
  // promote cleanly and agree on every txid while serving the wrong rows, which is precisely the
  // failure `082f651` fixed and precisely the one promotion could re-open.
  const ours = input.localGeneration
  const theirs = input.placedGeneration
  if (ours && theirs && ours !== theirs) {
    return {
      ok: false,
      code: "GENERATION_MISMATCH",
      why:
        `${node} holds generation ${ours} of ${db}, the cluster placed ${theirs} — ` +
        "a different database has worn this name, and promoting this copy would serve its rows",
    }
  }

  // Static topology has no lease to consult, so a live stream is the only evidence this node has
  // that somebody else is still the primary — and promoting against a primary that is up and
  // streaming is precisely the two-writers case. In a cluster the lease is the authority and a
  // stream that has not noticed the failover yet must not block the failover.
  if (!cluster && input.streamLive && !input.force) {
    return {
      ok: false,
      code: "STREAM_LIVE",
      why:
        `${node} is still streaming ${db} from its primary, which is therefore up; ` +
        "promoting now would leave two nodes accepting writes. Stop the primary, or force it",
    }
  }

  if (cluster) {
    const lease = cluster.lease
    if (lease && lease.node !== node && cluster.nowMs < lease.until && !input.force) {
      const remaining = lease.until - cluster.nowMs
      return {
        ok: false,
        code: "LEASE_HELD",
        why:
          `${lease.node} holds the lease on ${db} for another ${remaining}ms; ` +
          "it may still be accepting writes",
      }
    }
  }

  const leaseIsMineAndLive =
    cluster !== null &&
    cluster.lease !== null &&
    cluster.lease.node === node &&
    cluster.nowMs < cluster.lease.until
  if (input.isPrimaryLocally && (cluster === null || leaseIsMineAndLive)) {
    return { ok: false, code: "ALREADY_PRIMARY", why: `${node} is already the primary for ${db}` }
  }

  if (cluster && !input.force) {
    const ahead = furthestAhead(cluster.acked, node, input.applied)
    if (ahead) {
      return {
        ok: false,
        code: "BEHIND",
        why:
          `${node} has applied ${input.applied} of ${db} but ${ahead.node} has acked ` +
          `${ahead.txid}; promoting here would discard those transactions`,
      }
    }
  }

  if (!cluster) {
    return {
      ok: true,
      epoch: input.localEpoch + 1,
      why: `${node} takes ${db} at epoch ${input.localEpoch + 1} (no control plane; the operator is the authority)`,
    }
  }

  const highest = Math.max(cluster.epoch, input.localEpoch)
  // "Changes hands" is about who *was* the primary, not merely about whether a lease object
  // exists. A node claiming a database the cluster has never placed, or re-taking one it is
  // already recorded as the primary of after a restart, fences nobody — and bumping the epoch
  // there would move every node's fencing token on every restart for nothing.
  const changesHands = cluster.lease
    ? cluster.lease.node !== node
    : cluster.primary !== null && cluster.primary !== node
  const epoch = changesHands ? highest + 1 : highest
  return {
    ok: true,
    epoch,
    why: changesHands
      ? `${node} takes ${db} at epoch ${epoch}, fencing ${cluster.lease?.node ?? cluster.primary ?? "nobody"}`
      : `${node} renews its own lapsed lease on ${db}; the epoch stays at ${epoch}`,
  }
}

/** The node with the highest acked position other than `node`, or null when none is ahead. */
function furthestAhead(
  acked: Record<NodeId, string>,
  node: NodeId,
  applied: string,
): { node: NodeId; txid: string } | null {
  let best: { node: NodeId; txid: string } | null = null
  for (const [other, txid] of Object.entries(acked)) {
    if (other === node) continue
    if (compareTxid(txid, applied) <= 0) continue
    if (best === null || compareTxid(txid, best.txid) > 0) best = { node: other, txid }
  }
  return best
}

export interface FailoverInput {
  db: string
  primary: NodeId | null
  replicas: NodeId[]
  lease: { node: NodeId; until: number } | null
  acked: Record<NodeId, string>
  /** Nodes the leader can reach right now, including itself. */
  reachable: ReadonlySet<NodeId>
  /** The leader's own wall clock. */
  nowMs: number
}

/**
 * Which node a lapsed lease goes to, decided by the Raft leader on its own wall clock.
 *
 * `null` while the lease is still live is the guard that makes two primaries impossible: the
 * earliest moment this can name a second node is `lease.until`, and the holder stopped accepting
 * writes `leaseGuardMs` before that. Nothing else here may be allowed to return a node earlier.
 *
 * The pick is the highest acked txid among the reachable placement, ties broken by node id so two
 * leaders elected in succession make the same choice from the same state. The current holder is a
 * candidate when it is reachable: a primary that merely hiccupped is handed its own database back,
 * which costs no epoch and no re-snapshot.
 */
export function pickFailover(input: FailoverInput): { node: NodeId; applied: string } | null {
  if (input.lease && input.nowMs < input.lease.until) return null

  const placed = new Set<NodeId>(input.replicas)
  if (input.primary) placed.add(input.primary)
  if (placed.size === 0) return null

  let best: { node: NodeId; applied: string } | null = null
  for (const node of [...placed].sort()) {
    if (!input.reachable.has(node)) continue
    const applied = input.acked[node] ?? "0"
    if (best === null || compareTxid(applied, best.applied) > 0) best = { node, applied }
  }
  return best
}
