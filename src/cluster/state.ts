// The replicated state machine behind the cluster: who the members are, where each database lives,
// and which node may write to it right now. A few KB of it, snapshotted whole.
//
// Invariant: `apply` is a pure function of `(state, command)`. It reads no clock, no environment
// and no module state, because every node runs it independently over the same log and has to land
// on the same object — a state machine that reads a clock is not a state machine, it is a source
// of divergence. Every time that matters rides *in* the command: `grantLease.until` is the Raft
// leader's clock at the moment it proposed, never anybody's clock at the moment it applies.
//
// Second invariant: `epoch` only goes up, and no epoch is ever handed out twice. It is the same
// fencing token every `TxnRecord` already carries (`src/wal/record.ts`) and that a replica already
// refuses when it is behind, with `EPOCH_AHEAD` (`docs/r1-replication.md`) — not a second number
// beside it. A change of lease holder bumps it; a renewal by the node that already holds it does
// not, because a renewal fences nobody off.
//
// What `apply` deliberately does *not* decide: whether a lease may be granted at all. Refusing to
// hand a database to a second node before the first can possibly have noticed it lost it needs a
// clock, so that check lives at the proposal site (C2's failover) and this module applies what the
// log says was committed.

export type NodeId = string

export type NodeStatus = "voter" | "learner"

export interface NodeInfo {
  /** `ws://host:port` this node is reachable at. */
  advertise: string
  /** Rack or AZ label; C3's placement reads it. */
  zone: string
  joinedTerm: number
  status: NodeStatus
}

/** The lease a primary holds. `until` is the Raft leader's clock, not the holder's. */
export interface Lease {
  node: NodeId
  until: number
}

export interface DbState {
  primary: NodeId | null
  replicas: NodeId[]
  /** Fencing token. Monotonic per database; bumped whenever the lease changes hands. */
  epoch: number
  lease: Lease | null
  /** Highest txid each node has told the control plane it has durably applied, decimal. */
  acked: Record<NodeId, string>
}

export interface ClusterState {
  nodes: Record<NodeId, NodeInfo>
  /** Absent means the cluster has never heard of the database. */
  dbs: Record<string, DbState>
  /** Raft term the state was last written in, for `GET /v1/cluster` and for debugging. */
  term: number
}

export type Command =
  | { type: "addNode"; node: NodeId; advertise?: string; zone?: string; status?: NodeStatus }
  | { type: "removeNode"; node: NodeId }
  | { type: "placeDb"; db: string; primary: NodeId | null; replicas: NodeId[] }
  | { type: "grantLease"; db: string; node: NodeId; until: number; epoch?: number }
  | { type: "releaseLease"; db: string }
  | { type: "ack"; db: string; node: NodeId; txid: string }

/** Bumped when the shape of a snapshot changes, so a future format is detected, not misread. */
export const SNAPSHOT_VERSION = 1

/** A snapshot or a command that cannot be read back. Fatal: the caller has no usable state. */
export class ClusterFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClusterFormatError"
  }
}

export function emptyState(): ClusterState {
  return { nodes: {}, dbs: {}, term: 0 }
}

function emptyDb(): DbState {
  return { primary: null, replicas: [], epoch: 0, lease: null, acked: {} }
}

/**
 * Applies one committed command. Returns a new state; the input is never mutated, so a caller can
 * keep the previous one to diff against.
 *
 * `term` is the term of the log entry the command came from, which is the only thing about the
 * Raft layer this module knows. It defaults to the state's own term so that `apply(state, command)`
 * — the two-argument shape — stays meaningful in a test.
 */
export function apply(state: ClusterState, command: Command, term = state.term): ClusterState {
  const next: ClusterState = { nodes: { ...state.nodes }, dbs: { ...state.dbs }, term }

  switch (command.type) {
    case "addNode": {
      const existing = next.nodes[command.node]
      next.nodes[command.node] = {
        advertise: command.advertise ?? existing?.advertise ?? "",
        zone: command.zone ?? existing?.zone ?? "",
        joinedTerm: existing?.joinedTerm ?? term,
        status: command.status ?? existing?.status ?? "voter",
      }
      return next
    }

    case "removeNode": {
      // Membership only. A database whose primary has just been removed keeps pointing at it until
      // its lease lapses and the control plane grants the database somewhere else; conflating the
      // two facts would let a removal hand a live database to a second writer.
      delete next.nodes[command.node]
      return next
    }

    case "placeDb": {
      const current = next.dbs[command.db] ?? emptyDb()
      const replicas = [...command.replicas]
      const acked: Record<NodeId, string> = {}
      // Placement is also where `acked` is pruned: a node that no longer holds the database has no
      // position worth remembering, and nothing else ever removes an entry.
      for (const node of [command.primary, ...replicas]) {
        if (node === null) continue
        const seen = current.acked[node]
        if (seen !== undefined) acked[node] = seen
      }
      next.dbs[command.db] = { ...current, primary: command.primary, replicas, acked }
      return next
    }

    case "grantLease": {
      const current = next.dbs[command.db] ?? emptyDb()
      const changedHands = current.lease === null || current.lease.node !== command.node
      let epoch = current.epoch
      if (changedHands) epoch += 1
      // An explicit epoch is how C2 will float the control plane up to a tenant's own on-disk
      // epoch, which may already be ahead of anything this state machine has issued. It can only
      // ever raise it: an epoch that went backwards would un-fence a node that was already fenced.
      if (command.epoch !== undefined && command.epoch > epoch) epoch = command.epoch
      next.dbs[command.db] = {
        ...current,
        primary: command.node,
        epoch,
        lease: { node: command.node, until: command.until },
      }
      return next
    }

    case "releaseLease": {
      const current = next.dbs[command.db]
      if (!current) return next
      next.dbs[command.db] = { ...current, lease: null }
      return next
    }

    case "ack": {
      const current = next.dbs[command.db] ?? emptyDb()
      const seen = current.acked[command.node]
      // Acks race past each other on the wire, and a position that went backwards would make
      // C2 promote the wrong replica.
      if (seen !== undefined && compareTxid(command.txid, seen) <= 0) return next
      next.dbs[command.db] = {
        ...current,
        acked: { ...current.acked, [command.node]: command.txid },
      }
      return next
    }
  }
}

/** Decimal u64 strings, compared as numbers would be: length first, then lexically. */
function compareTxid(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "")
  const right = b.replace(/^0+(?=\d)/, "")
  if (left.length !== right.length) return left.length - right.length
  return left < right ? -1 : left > right ? 1 : 0
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A command on its way into the log. Commands are tens of bytes, so JSON is the whole story. */
export function encodeCommand(command: Command): Uint8Array {
  return encoder.encode(JSON.stringify(command))
}

export function decodeCommand(bytes: Uint8Array): Command {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new ClusterFormatError("cluster command is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as Command).type !== "string") {
    throw new ClusterFormatError("cluster command has no type")
  }
  return parsed as Command
}

/**
 * The whole state, versioned. `InstallSnapshot` carries this and nothing else, which is what makes
 * log compaction here a matter of throwing entries away rather than a format of its own.
 */
export function encodeSnapshot(state: ClusterState): Uint8Array {
  return encoder.encode(JSON.stringify({ version: SNAPSHOT_VERSION, state }))
}

export function decodeSnapshot(bytes: Uint8Array): ClusterState {
  let parsed: { version?: unknown; state?: unknown }
  try {
    parsed = JSON.parse(decoder.decode(bytes)) as { version?: unknown; state?: unknown }
  } catch {
    throw new ClusterFormatError("cluster snapshot is not valid JSON")
  }
  if (parsed.version !== SNAPSHOT_VERSION) {
    throw new ClusterFormatError(
      `cluster snapshot is version ${String(parsed.version)}, this build reads ${SNAPSHOT_VERSION}`,
    )
  }
  const state = parsed.state as ClusterState | undefined
  if (!state || typeof state !== "object" || !state.nodes || !state.dbs) {
    throw new ClusterFormatError("cluster snapshot has no state")
  }
  return { nodes: state.nodes, dbs: state.dbs, term: state.term ?? 0 }
}
