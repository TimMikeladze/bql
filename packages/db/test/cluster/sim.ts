// A whole Raft cluster in one process, on a virtual clock, with a network that misbehaves.
//
// Nothing here is real: no timer, no socket, no file. `Raft.step()` is called directly with a
// simulated `nowMs`, every random number comes from a seeded PRNG, and a node's "disk" is three
// fields on an object that survive a restart. That is the whole point of `raft.ts` being pure —
// a five-node cluster losing its leader mid-partition is a loop, not a flaky integration test, and
// a failure is reproducible from the seed printed with it.
//
// The safety properties of the paper's figure 3 are checked after *every* delivery, not at the
// end: a violation that heals itself before the assertions run is exactly the kind this is for.

import { expect } from "bun:test"
import {
  type ClusterState,
  type Command,
  apply,
  decodeCommand,
  emptyState,
  encodeCommand,
  encodeSnapshot,
  decodeSnapshot,
} from "../../src/cluster/state.ts"
import {
  type HardState,
  type LogEntry,
  type NodeId,
  type ProposalId,
  Raft,
  type RaftAction,
  type RaftMessage,
  type RaftSnapshot,
} from "../../src/cluster/raft.ts"

/** mulberry32: four lines, good enough for jitter, and identical on every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface NetworkFaults {
  /** Probability a message is dropped outright. */
  drop?: number
  /** Probability a message is delivered twice. */
  duplicate?: number
  /** Delivery delay is uniform in `[minDelayMs, maxDelayMs]`; unequal delays reorder. */
  minDelayMs?: number
  maxDelayMs?: number
}

export interface SimOptions extends NetworkFaults {
  seed: number
  nodes: NodeId[]
  electionTimeoutMs?: number
  heartbeatMs?: number
  snapshotEntries?: number
  preVote?: boolean
}

interface Persisted {
  hardState: HardState
  entries: LogEntry[]
  snapshot: RaftSnapshot | null
}

interface SimNode {
  id: NodeId
  raft: Raft
  /** Everything that survives a restart, and nothing that does not. */
  disk: Persisted
  state: ClusterState
  down: boolean
  /** Log index to signature, taken while this node was leader, for the append-only check. */
  leaderLog: Map<number, string>
}

interface InFlight {
  at: number
  seq: number
  from: NodeId
  to: NodeId
  message: RaftMessage
}

export interface ProposalOutcome {
  id: ProposalId
  ok: boolean
  reason?: string
}

function signature(entry: LogEntry): string {
  return `${entry.index}:${entry.term}:${entry.kind}:${Buffer.from(entry.data).toString("base64")}`
}

export class Simulator {
  now = 0
  readonly seed: number
  readonly random: () => number
  readonly faults: Required<NetworkFaults>

  #nodes = new Map<NodeId, SimNode>()
  #wire: InFlight[] = []
  /** Node pairs that cannot reach each other, as `a|b` with the ids sorted. */
  #cut = new Set<string>()
  #seq = 0
  #nextProposal = 1

  /** index → signature, every entry any node has ever applied. State machine safety. */
  #applied = new Map<number, string>()
  /** index → {term, signature}, every entry any node has ever considered committed. */
  #committed = new Map<number, { term: number; signature: string }>()
  /** term → the node that led it. Election safety. */
  #leaders = new Map<number, NodeId>()
  outcomes: ProposalOutcome[] = []

  constructor(private options: SimOptions) {
    this.seed = options.seed
    this.random = prng(options.seed)
    this.faults = {
      drop: options.drop ?? 0,
      duplicate: options.duplicate ?? 0,
      minDelayMs: options.minDelayMs ?? 1,
      maxDelayMs: options.maxDelayMs ?? 20,
    }
    for (const id of options.nodes) {
      this.#nodes.set(id, {
        id,
        raft: this.#makeRaft(id, { hardState: { term: 0, votedFor: null }, entries: [], snapshot: null }),
        disk: { hardState: { term: 0, votedFor: null }, entries: [], snapshot: null },
        state: emptyState(),
        down: false,
        leaderLog: new Map(),
      })
    }
  }

  #makeRaft(id: NodeId, disk: Persisted): Raft {
    return new Raft({
      id,
      config: [...this.options.nodes],
      electionTimeoutMs: this.options.electionTimeoutMs ?? 1000,
      heartbeatMs: this.options.heartbeatMs ?? 200,
      snapshotEntries: this.options.snapshotEntries ?? 512,
      preVote: this.options.preVote ?? true,
      random: this.random,
      hardState: disk.hardState,
      entries: [...disk.entries],
      snapshot: disk.snapshot,
    })
  }

  // ── inspection ───────────────────────────────────────────────────────────────────────────────

  node(id: NodeId): SimNode {
    const node = this.#nodes.get(id)
    if (!node) throw new Error(`no node ${id}`)
    return node
  }

  get ids(): NodeId[] {
    return [...this.#nodes.keys()]
  }

  /** Every node that currently believes it is leader. More than one is not per se a violation. */
  leaders(): SimNode[] {
    return [...this.#nodes.values()].filter((node) => !node.down && node.raft.role === "leader")
  }

  /** The leader of the highest term, which is the one a test usually means. */
  leader(): SimNode | null {
    const found = this.leaders().sort((a, b) => b.raft.term - a.raft.term)
    return found[0] ?? null
  }

  stateOf(id: NodeId): ClusterState {
    return this.node(id).state
  }

  // ── faults ───────────────────────────────────────────────────────────────────────────────────

  /** Cuts the network into groups; nothing crosses a group boundary. */
  partition(...groups: NodeId[][]): void {
    this.#cut.clear()
    const groupOf = new Map<NodeId, number>()
    groups.forEach((group, at) => {
      for (const id of group) groupOf.set(id, at)
    })
    for (const a of this.ids) {
      for (const b of this.ids) {
        if (a >= b) continue
        if (groupOf.get(a) !== groupOf.get(b)) this.#cut.add(`${a}|${b}`)
      }
    }
  }

  heal(): void {
    this.#cut.clear()
  }

  /** Kills a node: its in-memory state is gone, its disk is not. Messages to it are dropped. */
  stop(id: NodeId): void {
    const node = this.node(id)
    node.down = true
    this.#wire = this.#wire.filter((m) => m.to !== id && m.from !== id)
  }

  /** Brings a node back, rebuilt from its disk exactly as `ClusterNode.start()` would. */
  restart(id: NodeId): void {
    const node = this.node(id)
    node.down = false
    node.raft = this.#makeRaft(id, node.disk)
    node.state = node.disk.snapshot ? decodeSnapshot(node.disk.snapshot.data) : emptyState()
    node.leaderLog = new Map()
  }

  // ── driving ──────────────────────────────────────────────────────────────────────────────────

  /** Forces `id` to start an election now. */
  campaign(id: NodeId): void {
    this.#step(this.node(id), { type: "campaign" })
  }

  propose(id: NodeId, command: Command): ProposalId {
    const proposalId = this.#nextProposal++
    this.#step(this.node(id), {
      type: "propose",
      id: proposalId,
      command: { kind: "command", data: encodeCommand(command) },
    })
    return proposalId
  }

  /** Advances the virtual clock by `ms`, delivering everything due and ticking every live node. */
  advance(ms: number, tickMs = 20): void {
    const until = this.now + ms
    while (this.now < until) {
      this.now = Math.min(this.now + tickMs, until)
      this.#deliver()
      for (const node of this.#nodes.values()) {
        if (node.down) continue
        this.#step(node, { type: "tick" })
      }
      this.#deliver()
    }
  }

  /** Advances until `predicate` holds, or fails the test after `maxMs` of virtual time. */
  runUntil(predicate: () => boolean, maxMs = 30_000, what = "the condition"): void {
    const deadline = this.now + maxMs
    while (this.now < deadline) {
      if (predicate()) return
      this.advance(20)
    }
    throw new Error(`seed ${this.seed}: ${what} did not hold within ${maxMs} ms of virtual time`)
  }

  outcomeOf(id: ProposalId): ProposalOutcome | null {
    return this.outcomes.find((outcome) => outcome.id === id) ?? null
  }

  #deliver(): void {
    for (;;) {
      const due = this.#wire.filter((m) => m.at <= this.now)
      if (due.length === 0) return
      // Sorted by arrival, ties by sequence: the delays are what reorder, not the sort.
      due.sort((a, b) => a.at - b.at || a.seq - b.seq)
      this.#wire = this.#wire.filter((m) => m.at > this.now)
      for (const message of due) {
        const node = this.#nodes.get(message.to)
        if (!node || node.down) continue
        if (this.#isCut(message.from, message.to)) continue
        this.#step(node, { type: "message", from: message.from, message: message.message })
      }
    }
  }

  #isCut(a: NodeId, b: NodeId): boolean {
    return this.#cut.has(a < b ? `${a}|${b}` : `${b}|${a}`)
  }

  #step(node: SimNode, input: Parameters<Raft["step"]>[0]): void {
    if (node.down) return
    const before = node.raft.role
    const actions = node.raft.step(input, this.now)
    this.#drive(node, actions)
    if (node.raft.role === "leader" && before !== "leader") {
      const term = node.raft.term
      const existing = this.#leaders.get(term)
      // Election safety, checked at the moment it could be broken rather than after the fact.
      expect(existing ?? node.id, `seed ${this.seed}: two leaders in term ${term}`).toBe(node.id)
      this.#leaders.set(term, node.id)
      // Leader completeness: every entry anyone ever committed must be in this leader's log.
      for (const [index, entry] of this.#committed) {
        if (node.disk.snapshot && index <= node.disk.snapshot.index) continue
        const held = node.disk.entries.find((candidate) => candidate.index === index)
        expect(
          held ? signature(held) : null,
          `seed ${this.seed}: ${node.id} led term ${term} without committed entry ${index}`,
        ).toBe(entry.signature)
      }
      node.leaderLog = new Map()
    }
    this.#checkLeaderAppendOnly(node)
    this.#checkLogMatching()
  }

  #drive(node: SimNode, actions: RaftAction[]): void {
    for (const action of actions) {
      switch (action.type) {
        case "persist": {
          if (action.hardState) node.disk.hardState = { ...action.hardState }
          if (action.truncateFrom !== undefined) {
            node.disk.entries = node.disk.entries.filter(
              (entry) => entry.index < (action.truncateFrom as number),
            )
          }
          if (action.entries) {
            for (const entry of action.entries) {
              const expected = (node.disk.entries.at(-1)?.index ?? node.disk.snapshot?.index ?? 0) + 1
              expect(
                entry.index,
                `seed ${this.seed}: ${node.id} appended ${entry.index} onto ${expected - 1}`,
              ).toBe(expected)
              node.disk.entries.push(entry)
            }
          }
          break
        }
        case "send":
          this.#enqueue(node.id, action.to, action.message)
          break
        case "apply":
          for (const entry of action.entries) this.#applyEntry(node, entry)
          break
        case "proposalResult":
          this.outcomes.push({
            id: action.id,
            ok: action.ok,
            ...(action.reason === undefined ? {} : { reason: action.reason }),
          })
          break
        case "snapshot":
          if (action.reason === "install") {
            node.disk.snapshot = action.snapshot
            node.disk.entries = []
            node.state = decodeSnapshot(action.snapshot.data)
          } else {
            node.raft.compact(action.index, action.term, encodeSnapshot(node.state))
            const snapshot = node.raft.snapshot
            if (snapshot && snapshot.index === action.index) {
              node.disk.snapshot = snapshot
              node.disk.entries = node.disk.entries.filter((entry) => entry.index > snapshot.index)
            }
          }
          break
      }
    }
  }

  #applyEntry(node: SimNode, entry: LogEntry): void {
    // State machine safety: nobody may ever apply a different entry at the same index.
    const seen = this.#applied.get(entry.index)
    expect(
      seen ?? signature(entry),
      `seed ${this.seed}: ${node.id} applied a different entry at index ${entry.index}`,
    ).toBe(signature(entry))
    this.#applied.set(entry.index, signature(entry))
    this.#committed.set(entry.index, { term: entry.term, signature: signature(entry) })
    if (entry.kind !== "command") return
    node.state = apply(node.state, decodeCommand(entry.data), entry.term)
  }

  #enqueue(from: NodeId, to: NodeId, message: RaftMessage): void {
    if (this.#isCut(from, to)) return
    if (this.random() < this.faults.drop) return
    const copies = this.random() < this.faults.duplicate ? 2 : 1
    const span = this.faults.maxDelayMs - this.faults.minDelayMs
    for (let copy = 0; copy < copies; copy++) {
      const delay = this.faults.minDelayMs + Math.floor(this.random() * (span + 1))
      this.#wire.push({ at: this.now + delay, seq: this.#seq++, from, to, message })
    }
  }

  // ── the invariants ───────────────────────────────────────────────────────────────────────────

  /**
   * Leader append-only: a leader never overwrites or removes an entry in its own log. Compared by
   * log index rather than array position — compaction moves entries down the array without
   * changing one of them, and that is not what this property is about.
   */
  #checkLeaderAppendOnly(node: SimNode): void {
    if (node.raft.role !== "leader") return
    const compactedTo = node.disk.snapshot?.index ?? 0
    for (const entry of node.disk.entries) {
      const seen = node.leaderLog.get(entry.index)
      expect(
        seen ?? signature(entry),
        `seed ${this.seed}: leader ${node.id} changed entry ${entry.index} of its own log`,
      ).toBe(signature(entry))
      node.leaderLog.set(entry.index, signature(entry))
    }
    const last = node.disk.entries.at(-1)?.index ?? compactedTo
    for (const index of node.leaderLog.keys()) {
      if (index <= compactedTo) continue
      expect(
        index <= last,
        `seed ${this.seed}: leader ${node.id} deleted entry ${index} from its own log`,
      ).toBe(true)
    }
  }

  /** Log matching: two logs agreeing on (index, term) agree on every entry before it. */
  #checkLogMatching(): void {
    const logs = [...this.#nodes.values()].map((node) => ({
      id: node.id,
      byIndex: new Map(node.disk.entries.map((entry) => [entry.index, entry])),
    }))
    for (let a = 0; a < logs.length; a++) {
      for (let b = a + 1; b < logs.length; b++) {
        const left = logs[a]
        const right = logs[b]
        if (!left || !right) continue
        for (const [index, entry] of left.byIndex) {
          const other = right.byIndex.get(index)
          if (!other || other.term !== entry.term) continue
          for (let before = index; before >= 1; before--) {
            const one = left.byIndex.get(before)
            const two = right.byIndex.get(before)
            if (!one || !two) break
            expect(
              signature(one),
              `seed ${this.seed}: ${left.id} and ${right.id} agree at ${index} but differ at ${before}`,
            ).toBe(signature(two))
          }
        }
      }
    }
  }

  /** Every node's log, for a test that wants to look. */
  logs(): Record<NodeId, string[]> {
    const out: Record<NodeId, string[]> = {}
    for (const node of this.#nodes.values()) out[node.id] = node.disk.entries.map(signature)
    return out
  }
}
