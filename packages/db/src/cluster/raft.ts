// Raft, as a pure state machine. `step(input, nowMs)` takes one event and returns the actions a
// driver must perform; it opens no socket, touches no file, and never calls `Date.now()`. Every
// clock it has is the `nowMs` it is handed, which is what lets `test/cluster/sim.ts` run a whole
// five-node cluster through partitions and restarts on a virtual clock with a seeded PRNG.
//
// **Invariant, and the one a driver must not get wrong: `persist` before `send`.** Actions come
// back bucketed and concatenated in the order
//
//     persist · snapshot(install) · send · apply · proposalResult · snapshot(compact)
//
// so a driver that simply walks the array in order is correct by construction. This module depends
// on that: it answers a vote or an append in the same batch that writes the term and the entries,
// because answering first and writing after is how a cluster elects two leaders in one term, or
// tells a leader an entry is durable that a crash then loses. `snapshot(install)` sits before
// `send` for the same reason; `snapshot(compact)` sits last because it can only be answered once
// the state machine has applied everything up to the index it names.
//
// Deviations from the paper, all deliberate:
//
//   * **Pre-vote** (dissertation §9.6). A node that comes back from a partition asks whether it
//     *could* win before it bumps its term, and a voter refuses while it has heard from a leader
//     inside its own election timeout. Without it, a node returning from a partition deposes a
//     perfectly healthy leader for no reason at all.
//   * **Conflict index/term in the rejection** (§5.3's optimisation). A follower that is far
//     behind is found in a round trip per *term*, not per entry.
//   * **A no-op on election, and `commitIndex` only ever advancing onto an entry of the leader's
//     own term** (§5.4.2, figure 8). Cheap, easy to leave out, and leaving it out silently loses
//     committed writes.
//   * **Membership one server at a time** (dissertation §4.1), refusing a second change while one
//     is uncommitted, and taking a configuration into effect when it is *appended* rather than
//     when it commits. Joint consensus was deliberately not built: the control plane's clusters
//     are three or five nodes changed one at a time, and the simpler rule is the one that can be
//     held in a reader's head.
//   * **Check-quorum.** A leader that has not heard from a quorum in an election timeout steps
//     down. Safety never needed it — a partitioned leader cannot commit, so it cannot renew a
//     lease either — but without it `isLeader()` lies for as long as the partition lasts.
//
// This module knows nothing about `ClusterState`. A proposal is `{ kind, data }` and the data is
// opaque bytes; the one kind raft opens for itself is `config`, because a membership change moves
// the quorum it counts against.

import type { NodeId, NodeStatus } from "./state.ts"

export type { NodeId }

/** Whatever a caller wants to match a `proposalResult` against. */
export type ProposalId = string | number

export type EntryKind = "noop" | "command" | "config"

export interface LogEntry {
  index: number
  term: number
  kind: EntryKind
  /** The state machine's command for `"command"`, an encoded `ConfigChange` for `"config"`. */
  data: Uint8Array
}

/** The two things Raft requires on disk before a message that depends on them goes out. */
export interface HardState {
  term: number
  votedFor: NodeId | null
}

export interface ConfigChange {
  type: "add" | "remove"
  node: NodeId
  /** Carried so the state machine can record the member when the change commits. */
  advertise?: string
  zone?: string
  /** A `learner` is replicated to and never counted in a quorum. Default `voter`. */
  status?: NodeStatus
}

export interface RaftSnapshot {
  index: number
  term: number
  /** The voter set as of `index`. A snapshot that lost it would lose the cluster. */
  config: NodeId[]
  learners: NodeId[]
  /** The state machine, encoded by `state.ts`. */
  data: Uint8Array
}

export type RaftMessage =
  | { type: "preVote"; term: number; lastLogIndex: number; lastLogTerm: number }
  | { type: "preVoteResp"; term: number; granted: boolean }
  | { type: "requestVote"; term: number; lastLogIndex: number; lastLogTerm: number }
  | { type: "requestVoteResp"; term: number; granted: boolean }
  | {
      type: "appendEntries"
      term: number
      prevLogIndex: number
      prevLogTerm: number
      entries: LogEntry[]
      leaderCommit: number
    }
  | {
      type: "appendEntriesResp"
      term: number
      success: boolean
      /** Highest index the follower now holds from this leader; 0 on a rejection. */
      matchIndex: number
      /** First index the leader should retry from, on a rejection. */
      conflictIndex?: number
      /** Term of the entry that conflicted; 0 when the follower's log is simply short. */
      conflictTerm?: number
    }
  | { type: "installSnapshot"; term: number; snapshot: RaftSnapshot }
  | { type: "installSnapshotResp"; term: number; index: number }

/** What a caller hands the log. `kind` is all raft reads of it, except for `config`. */
export type RaftCommand =
  | { kind: "command"; data: Uint8Array }
  | { kind: "config"; change: ConfigChange }

export type RaftInput =
  | { type: "tick" }
  | { type: "message"; from: NodeId; message: RaftMessage }
  | { type: "propose"; command: RaftCommand; id: ProposalId }
  /** Forces an election now. Tests use it so they never have to wait for a timeout. */
  | { type: "campaign" }

export type RaftAction =
  | { type: "send"; to: NodeId; message: RaftMessage }
  | {
      type: "persist"
      hardState?: HardState
      /** Delete every entry at this index and above before appending. */
      truncateFrom?: number
      entries?: LogEntry[]
    }
  | { type: "apply"; entries: LogEntry[] }
  | { type: "proposalResult"; id: ProposalId; ok: boolean; reason?: string }
  /** `install`: store this snapshot and reload the state machine from it. */
  | { type: "snapshot"; reason: "install"; snapshot: RaftSnapshot }
  /** `compact`: encode the state machine as of `index` and hand it back through `compact()`. */
  | { type: "snapshot"; reason: "compact"; index: number; term: number }

export type RaftRole = "follower" | "preCandidate" | "candidate" | "leader"

export interface RaftOptions {
  id: NodeId
  /** The voter set, this node included. Empty means "wait to be added by someone else". */
  config?: NodeId[]
  learners?: NodeId[]
  /** Randomised to `[electionTimeoutMs, 2 * electionTimeoutMs)`. Default 1500. */
  electionTimeoutMs?: number
  /** Default 300. */
  heartbeatMs?: number
  /** Compact once the in-memory log passes this many entries. Default 512. */
  snapshotEntries?: number
  /** Entries in one `AppendEntries`. Default 64. */
  maxEntriesPerAppend?: number
  /** Injected so a seeded PRNG makes the simulator reproducible. Default `Math.random`. */
  random?: () => number
  /** Off only for tests that want to watch a bare election. Default on. */
  preVote?: boolean
  /** Restored from `RaftLog` after a crash. */
  hardState?: HardState
  entries?: LogEntry[]
  snapshot?: RaftSnapshot | null
}

interface Progress {
  /** Next index to send this peer. */
  next: number
  /** Highest index known to be on this peer's disk. */
  match: number
  /** Last `nowMs` a message from this peer arrived, for check-quorum and `observe()`. */
  lastContactMs: number
  /** True while an `InstallSnapshot` is outstanding, so the leader stops resending entries. */
  awaitingSnapshot: boolean
  /** When that snapshot went out. A latch with no deadline strands a follower that was down. */
  snapshotSentMs: number
}

interface Pending {
  id: ProposalId
  term: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeConfigChange(change: ConfigChange): Uint8Array {
  return encoder.encode(JSON.stringify(change))
}

export function decodeConfigChange(bytes: Uint8Array): ConfigChange {
  return JSON.parse(decoder.decode(bytes)) as ConfigChange
}

export class Raft {
  readonly id: NodeId
  readonly electionTimeoutMs: number
  readonly heartbeatMs: number
  readonly snapshotEntries: number
  readonly maxEntriesPerAppend: number
  readonly preVote: boolean

  #random: () => number
  #role: RaftRole = "follower"
  #term = 0
  #votedFor: NodeId | null = null
  #leaderId: NodeId | null = null

  /** The bootstrap voter set, used until a snapshot or a config entry says otherwise. */
  #baseConfig: NodeId[]
  #baseLearners: NodeId[]
  #config: NodeId[]
  #learners: NodeId[]

  /** Entries after `#snapshotIndex`, dense and ascending. */
  #entries: LogEntry[] = []
  #snapshot: RaftSnapshot | null = null
  #snapshotIndex = 0
  #snapshotTerm = 0

  #commitIndex = 0
  #lastApplied = 0

  #electionResetMs = 0
  #randomTimeoutMs: number
  #lastHeartbeatMs = 0
  #lastQuorumCheckMs = 0
  /** The `nowMs` of the step in flight. Set once, at the top of `step`, and never read elsewhere. */
  #now = 0

  #votes = new Map<NodeId, boolean>()
  #progress = new Map<NodeId, Progress>()
  #pending = new Map<number, Pending>()
  /** Index of the newest config entry in the log; while it is above `commitIndex`, no second one. */
  #configIndex = 0

  // Action buckets. Draining them in this order is the persist-before-send invariant, made
  // structural rather than something every code path has to remember.
  #persist: RaftAction[] = []
  #install: RaftAction[] = []
  #send: RaftAction[] = []
  #applies: RaftAction[] = []
  #results: RaftAction[] = []
  #compact: RaftAction[] = []

  constructor(options: RaftOptions) {
    this.id = options.id
    this.electionTimeoutMs = options.electionTimeoutMs ?? 1500
    this.heartbeatMs = options.heartbeatMs ?? 300
    this.snapshotEntries = options.snapshotEntries ?? 512
    this.maxEntriesPerAppend = options.maxEntriesPerAppend ?? 64
    this.preVote = options.preVote ?? true
    this.#random = options.random ?? Math.random
    this.#baseConfig = [...(options.config ?? [])]
    this.#baseLearners = [...(options.learners ?? [])]
    this.#config = [...this.#baseConfig]
    this.#learners = [...this.#baseLearners]
    this.#randomTimeoutMs = this.#randomisedTimeout()

    if (options.snapshot) {
      this.#snapshot = options.snapshot
      this.#snapshotIndex = options.snapshot.index
      this.#snapshotTerm = options.snapshot.term
      this.#commitIndex = options.snapshot.index
      this.#lastApplied = options.snapshot.index
    }
    if (options.entries) this.#entries = [...options.entries]
    if (options.hardState) {
      this.#term = options.hardState.term
      this.#votedFor = options.hardState.votedFor
    }
    this.#recomputeConfig()
  }

  // ── what the driver reads ────────────────────────────────────────────────────────────────────

  get role(): RaftRole {
    return this.#role
  }

  get term(): number {
    return this.#term
  }

  get leaderId(): NodeId | null {
    return this.#leaderId
  }

  get commitIndex(): number {
    return this.#commitIndex
  }

  get lastApplied(): number {
    return this.#lastApplied
  }

  get lastIndex(): number {
    return this.#entries.at(-1)?.index ?? this.#snapshotIndex
  }

  get snapshotIndex(): number {
    return this.#snapshotIndex
  }

  /** The voter set as this node currently understands it. */
  get config(): NodeId[] {
    return [...this.#config]
  }

  get learners(): NodeId[] {
    return [...this.#learners]
  }

  get hardState(): HardState {
    return { term: this.#term, votedFor: this.#votedFor }
  }

  /** Entries still in memory, oldest first. */
  get entries(): readonly LogEntry[] {
    return this.#entries
  }

  get snapshot(): RaftSnapshot | null {
    return this.#snapshot
  }

  /** Last `nowMs` a message arrived from each peer; the input to `observe()`'s liveness column. */
  contactMs(peer: NodeId): number {
    return this.#progress.get(peer)?.lastContactMs ?? 0
  }

  // ── the one entry point ──────────────────────────────────────────────────────────────────────

  step(input: RaftInput, nowMs: number): RaftAction[] {
    this.#now = nowMs
    switch (input.type) {
      case "tick":
        this.#tick(nowMs)
        break
      case "campaign":
        this.#campaign(nowMs)
        break
      case "propose":
        this.#propose(input.command, input.id)
        break
      case "message":
        this.#message(input.from, input.message, nowMs)
        break
    }
    return this.#drain()
  }

  /**
   * Answers a `snapshot: "compact"` action: the state machine as of `index`, which lets every
   * entry at or below it go. Not part of `step` because the driver has to encode the state machine
   * in between, and threading that through an input would buy nothing.
   */
  compact(index: number, term: number, data: Uint8Array): void {
    if (index <= this.#snapshotIndex || index > this.#lastApplied) return
    this.#snapshot = {
      index,
      term,
      config: [...this.#config],
      learners: [...this.#learners],
      data,
    }
    this.#snapshotIndex = index
    this.#snapshotTerm = term
    const keep = this.#entries.findIndex((entry) => entry.index > index)
    this.#entries = keep === -1 ? [] : this.#entries.slice(keep)
  }

  // ── timers ───────────────────────────────────────────────────────────────────────────────────

  #tick(now: number): void {
    if (this.#role === "leader") {
      if (now - this.#lastQuorumCheckMs >= this.electionTimeoutMs) {
        this.#lastQuorumCheckMs = now
        if (!this.#quorumAlive(now)) {
          // Nothing unsafe has happened — a leader with no quorum cannot commit, so it cannot renew
          // a lease either — but a node that says it leads a cluster it cannot reach is a lie the
          // rest of bql.sh would act on.
          this.#becomeFollower(this.#term, null, now)
          return
        }
      }
      if (now - this.#lastHeartbeatMs >= this.heartbeatMs) {
        this.#lastHeartbeatMs = now
        this.#broadcastAppend()
      }
      return
    }
    if (now - this.#electionResetMs >= this.#randomTimeoutMs) this.#campaign(now)
  }

  #quorumAlive(now: number): boolean {
    if (this.#config.length <= 1) return true
    let alive = 1 // itself
    for (const peer of this.#config) {
      if (peer === this.id) continue
      const progress = this.#progress.get(peer)
      if (progress && now - progress.lastContactMs < this.electionTimeoutMs) alive += 1
    }
    return alive >= this.#quorum()
  }

  #randomisedTimeout(): number {
    return this.electionTimeoutMs + Math.floor(this.#random() * this.electionTimeoutMs)
  }

  #resetElection(now: number): void {
    this.#electionResetMs = now
    this.#randomTimeoutMs = this.#randomisedTimeout()
  }

  // ── elections ────────────────────────────────────────────────────────────────────────────────

  #campaign(now: number): void {
    // A node that has been voted out of the configuration, or is a learner, never campaigns. It
    // keeps following until someone adds it back.
    if (!this.#config.includes(this.id)) return
    this.#resetElection(now)
    if (!this.preVote) {
      this.#becomeCandidate(now)
      return
    }
    this.#role = "preCandidate"
    this.#leaderId = null
    this.#votes = new Map([[this.id, true]])
    if (this.#counted(true) >= this.#quorum()) {
      this.#becomeCandidate(now)
      return
    }
    for (const peer of this.#voterPeers()) {
      this.#out({
        type: "send",
        to: peer,
        message: {
          type: "preVote",
          // The term it *would* run in. Its own term does not move, which is the whole point.
          term: this.#term + 1,
          lastLogIndex: this.lastIndex,
          lastLogTerm: this.#lastLogTerm(),
        },
      })
    }
  }

  #becomeCandidate(now: number): void {
    this.#term += 1
    this.#votedFor = this.id
    this.#role = "candidate"
    this.#leaderId = null
    this.#resetElection(now)
    this.#persistHardState()
    this.#votes = new Map([[this.id, true]])
    if (this.#counted(true) >= this.#quorum()) {
      this.#becomeLeader(now)
      return
    }
    for (const peer of this.#voterPeers()) {
      this.#out({
        type: "send",
        to: peer,
        message: {
          type: "requestVote",
          term: this.#term,
          lastLogIndex: this.lastIndex,
          lastLogTerm: this.#lastLogTerm(),
        },
      })
    }
  }

  #becomeLeader(now: number): void {
    this.#role = "leader"
    this.#leaderId = this.id
    this.#lastHeartbeatMs = now
    this.#lastQuorumCheckMs = now
    this.#progress.clear()
    for (const peer of this.#peers()) {
      this.#progress.set(peer, {
        next: this.lastIndex + 1,
        match: 0,
        lastContactMs: now,
        awaitingSnapshot: false,
        snapshotSentMs: 0,
      })
    }
    // The no-op of §5.4.2. Until an entry of this leader's own term commits, `#maybeCommit` will
    // not advance the commit index at all, so without it a leader could never commit anything it
    // inherited — and with the wrong rule instead, it could commit something it should not.
    this.#appendLocal({ kind: "noop", data: new Uint8Array(0) })
    this.#maybeCommit()
    this.#broadcastAppend()
  }

  #becomeFollower(term: number, leader: NodeId | null, now: number): void {
    const wasLeader = this.#role === "leader"
    if (term !== this.#term) {
      this.#term = term
      this.#votedFor = null
      this.#persistHardState()
    }
    this.#role = "follower"
    this.#leaderId = leader
    this.#resetElection(now)
    this.#progress.clear()
    if (wasLeader) this.#failPending(0, "lost leadership")
  }

  // ── proposals ────────────────────────────────────────────────────────────────────────────────

  #propose(command: RaftCommand, id: ProposalId): void {
    if (this.#role !== "leader") {
      const where = this.#leaderId === null ? "no leader is known" : `the leader is ${this.#leaderId}`
      this.#out({ type: "proposalResult", id, ok: false, reason: `not the leader: ${where}` })
      return
    }
    if (command.kind === "config") {
      if (this.#configIndex > this.#commitIndex) {
        this.#out({
          type: "proposalResult",
          id,
          ok: false,
          reason: "a membership change is already in flight",
        })
        return
      }
      // The dissertation's other precondition: a new leader may not change membership until it has
      // committed an entry of its own term, because until then it does not know what the
      // configuration really is.
      if (this.#termAt(this.#commitIndex) !== this.#term) {
        this.#out({
          type: "proposalResult",
          id,
          ok: false,
          reason: "the leader has not yet committed an entry of its own term",
        })
        return
      }
    }
    const entry =
      command.kind === "config"
        ? this.#appendLocal({ kind: "config", data: encodeConfigChange(command.change) })
        : this.#appendLocal({ kind: "command", data: command.data })
    this.#pending.set(entry.index, { id, term: entry.term })
    this.#maybeCommit()
    this.#broadcastAppend()
  }

  #appendLocal(entry: { kind: EntryKind; data: Uint8Array }): LogEntry {
    const appended: LogEntry = {
      index: this.lastIndex + 1,
      term: this.#term,
      kind: entry.kind,
      data: entry.data,
    }
    this.#entries.push(appended)
    if (appended.kind === "config") {
      this.#configIndex = appended.index
      // A configuration takes effect when it is appended, not when it commits (dissertation §4.1),
      // so a node added by this entry starts being replicated to immediately — which is the only
      // way it can ever catch up enough to vote.
      this.#recomputeConfig()
      for (const peer of this.#peers()) {
        if (this.#progress.has(peer)) continue
        this.#progress.set(peer, {
          next: appended.index,
          match: 0,
          lastContactMs: 0,
          awaitingSnapshot: false,
          snapshotSentMs: 0,
        })
      }
    }
    this.#out({ type: "persist", entries: [appended] })
    return appended
  }

  // ── messages ─────────────────────────────────────────────────────────────────────────────────

  #message(from: NodeId, message: RaftMessage, now: number): void {
    const progress = this.#progress.get(from)
    if (progress) progress.lastContactMs = now

    if (message.term > this.#term) {
      if (message.type === "preVote") {
        // A pre-vote never moves anybody's term. That is the entire mechanism.
      } else if (message.type === "preVoteResp" && message.granted) {
        // We are about to bump to exactly this term ourselves.
      } else {
        const leader =
          message.type === "appendEntries" || message.type === "installSnapshot" ? from : null
        this.#becomeFollower(message.term, leader, now)
      }
    } else if (message.term < this.#term) {
      switch (message.type) {
        case "preVote":
        case "requestVote":
          // Answer, so the sender learns the real term rather than retrying into the void.
          this.#out({
            type: "send",
            to: from,
            message: {
              type: message.type === "preVote" ? "preVoteResp" : "requestVoteResp",
              term: this.#term,
              granted: false,
            },
          })
          return
        case "appendEntries":
          this.#out({
            type: "send",
            to: from,
            message: { type: "appendEntriesResp", term: this.#term, success: false, matchIndex: 0 },
          })
          return
        case "installSnapshot":
          this.#out({
            type: "send",
            to: from,
            message: { type: "installSnapshotResp", term: this.#term, index: 0 },
          })
          return
        default:
          return
      }
    }

    switch (message.type) {
      case "preVote":
        this.#onPreVote(from, message, now)
        return
      case "preVoteResp":
        this.#onPreVoteResp(from, message, now)
        return
      case "requestVote":
        this.#onRequestVote(from, message, now)
        return
      case "requestVoteResp":
        this.#onRequestVoteResp(from, message, now)
        return
      case "appendEntries":
        this.#onAppendEntries(from, message, now)
        return
      case "appendEntriesResp":
        this.#onAppendEntriesResp(from, message, now)
        return
      case "installSnapshot":
        this.#onInstallSnapshot(from, message, now)
        return
      case "installSnapshotResp":
        this.#onInstallSnapshotResp(from, message)
        return
    }
  }

  #onPreVote(
    from: NodeId,
    message: Extract<RaftMessage, { type: "preVote" }>,
    now: number,
  ): void {
    // The lease rule: a voter that has heard from its leader inside its own election timeout — and
    // a leader itself — refuses, so a node coming back from a partition cannot depose anyone.
    const leaderAlive =
      this.#role === "leader" ||
      (this.#leaderId !== null && now - this.#electionResetMs < this.#randomTimeoutMs)
    const granted = !leaderAlive && message.term > this.#term && this.#upToDate(message)
    this.#out({
      type: "send",
      to: from,
      // Granting echoes the candidate's would-be term so it can match the answer to its campaign;
      // refusing carries ours, so it learns where the cluster actually is.
      message: { type: "preVoteResp", term: granted ? message.term : this.#term, granted },
    })
  }

  #onPreVoteResp(
    from: NodeId,
    message: Extract<RaftMessage, { type: "preVoteResp" }>,
    now: number,
  ): void {
    if (this.#role !== "preCandidate") return
    if (message.granted && message.term !== this.#term + 1) return
    this.#votes.set(from, message.granted)
    if (this.#counted(true) >= this.#quorum()) {
      this.#becomeCandidate(now)
      return
    }
    if (this.#counted(false) >= this.#quorum()) this.#becomeFollower(this.#term, null, now)
  }

  #onRequestVote(
    from: NodeId,
    message: Extract<RaftMessage, { type: "requestVote" }>,
    now: number,
  ): void {
    const free = this.#votedFor === null || this.#votedFor === from
    const granted = message.term === this.#term && free && this.#upToDate(message)
    if (granted) {
      this.#votedFor = from
      // The persist bucket drains before the send bucket, so the vote is on disk before the
      // grant leaves. A vote promised twice in one term is two leaders in one term.
      this.#persistHardState()
      this.#resetElection(now)
    }
    this.#out({
      type: "send",
      to: from,
      message: { type: "requestVoteResp", term: this.#term, granted },
    })
  }

  #onRequestVoteResp(
    from: NodeId,
    message: Extract<RaftMessage, { type: "requestVoteResp" }>,
    now: number,
  ): void {
    if (this.#role !== "candidate" || message.term !== this.#term) return
    this.#votes.set(from, message.granted)
    if (this.#counted(true) >= this.#quorum()) {
      this.#becomeLeader(now)
      return
    }
    if (this.#counted(false) >= this.#quorum()) this.#becomeFollower(this.#term, null, now)
  }

  #onAppendEntries(
    from: NodeId,
    message: Extract<RaftMessage, { type: "appendEntries" }>,
    now: number,
  ): void {
    if (this.#role !== "follower") this.#becomeFollower(message.term, from, now)
    this.#leaderId = from
    this.#resetElection(now)

    // Everything at or below the commit index is already durable and identical everywhere; there
    // is nothing to compare, so point the leader at where this node actually is.
    if (message.prevLogIndex < this.#commitIndex) {
      this.#reply(from, { success: true, matchIndex: this.#commitIndex })
      return
    }

    const prevTerm = this.#termAt(message.prevLogIndex)
    if (prevTerm === null || prevTerm !== message.prevLogTerm) {
      // The §5.3 optimisation: name the first index of the conflicting term, so the leader rewinds
      // a term per round trip instead of an entry per round trip.
      if (message.prevLogIndex > this.lastIndex || prevTerm === null) {
        this.#reply(from, {
          success: false,
          matchIndex: 0,
          conflictIndex: Math.min(message.prevLogIndex, this.lastIndex + 1),
          conflictTerm: 0,
        })
      } else {
        this.#reply(from, {
          success: false,
          matchIndex: 0,
          conflictIndex: this.#firstIndexOfTerm(prevTerm),
          conflictTerm: prevTerm,
        })
      }
      return
    }

    let at = 0
    let truncateFrom = -1
    for (; at < message.entries.length; at++) {
      const entry = message.entries[at] as LogEntry
      const existing = this.#termAt(entry.index)
      if (existing === null) break
      if (existing !== entry.term) {
        truncateFrom = entry.index
        break
      }
    }
    const fresh = message.entries.slice(at)

    if (truncateFrom >= 0) {
      const keep = this.#entries.findIndex((entry) => entry.index >= truncateFrom)
      if (keep !== -1) this.#entries = this.#entries.slice(0, keep)
      this.#failPending(truncateFrom, "the entry was replaced by a new leader")
    }
    if (fresh.length > 0) this.#entries.push(...fresh)
    if (truncateFrom >= 0 || fresh.length > 0) {
      // A truncation can take back a configuration, so the voter set is recomputed from the
      // snapshot forward rather than patched; the log is a few hundred entries, so this is free.
      this.#recomputeConfig()
      this.#out({
        type: "persist",
        ...(truncateFrom >= 0 ? { truncateFrom } : {}),
        ...(fresh.length > 0 ? { entries: fresh } : {}),
      })
    }

    const lastNew = message.prevLogIndex + message.entries.length
    if (message.leaderCommit > this.#commitIndex) {
      this.#commitIndex = Math.min(message.leaderCommit, lastNew)
      this.#emitApply()
    }
    this.#reply(from, { success: true, matchIndex: lastNew })
  }

  #reply(
    to: NodeId,
    body: Omit<Extract<RaftMessage, { type: "appendEntriesResp" }>, "type" | "term">,
  ): void {
    this.#out({
      type: "send",
      to,
      message: { type: "appendEntriesResp", term: this.#term, ...body },
    })
  }

  #onAppendEntriesResp(
    from: NodeId,
    message: Extract<RaftMessage, { type: "appendEntriesResp" }>,
    now: number,
  ): void {
    if (this.#role !== "leader" || message.term !== this.#term) return
    const progress = this.#progress.get(from)
    if (!progress) return
    progress.lastContactMs = now

    if (message.success) {
      progress.awaitingSnapshot = false
      if (message.matchIndex > progress.match) progress.match = message.matchIndex
      progress.next = progress.match + 1
      this.#maybeCommit()
      if (progress.next <= this.lastIndex) this.#sendAppend(from)
      return
    }

    let next = message.conflictIndex ?? Math.max(1, progress.next - 1)
    if (message.conflictTerm !== undefined && message.conflictTerm > 0) {
      // The leader may hold that term itself, in which case it can resume just past its own last
      // entry of it rather than at the follower's first.
      const mine = this.#lastIndexOfTerm(message.conflictTerm)
      if (mine !== null) next = mine + 1
    }
    progress.next = Math.max(1, Math.min(next, this.lastIndex + 1))
    // The follower answered, so whatever the leader thought was in flight to it is not.
    progress.awaitingSnapshot = false
    this.#sendAppend(from)
  }

  #onInstallSnapshot(
    from: NodeId,
    message: Extract<RaftMessage, { type: "installSnapshot" }>,
    now: number,
  ): void {
    this.#leaderId = from
    this.#resetElection(now)
    const snapshot = message.snapshot
    if (snapshot.index <= this.#commitIndex) {
      this.#out({
        type: "send",
        to: from,
        message: { type: "installSnapshotResp", term: this.#term, index: this.#commitIndex },
      })
      return
    }
    this.#snapshot = snapshot
    this.#snapshotIndex = snapshot.index
    this.#snapshotTerm = snapshot.term
    this.#entries = []
    this.#commitIndex = snapshot.index
    this.#lastApplied = snapshot.index
    this.#baseConfig = [...snapshot.config]
    this.#baseLearners = [...snapshot.learners]
    this.#recomputeConfig()
    this.#failPending(0, "the log was replaced by a snapshot")
    // Drains before the send bucket: the acknowledgement must not outrun the file.
    this.#install.push({ type: "snapshot", reason: "install", snapshot })
    this.#out({
      type: "send",
      to: from,
      message: { type: "installSnapshotResp", term: this.#term, index: snapshot.index },
    })
  }

  #onInstallSnapshotResp(
    from: NodeId,
    message: Extract<RaftMessage, { type: "installSnapshotResp" }>,
  ): void {
    if (this.#role !== "leader" || message.term !== this.#term) return
    const progress = this.#progress.get(from)
    if (!progress) return
    progress.awaitingSnapshot = false
    if (message.index > progress.match) progress.match = message.index
    progress.next = progress.match + 1
    this.#maybeCommit()
    if (progress.next <= this.lastIndex) this.#sendAppend(from)
  }

  // ── replication ──────────────────────────────────────────────────────────────────────────────

  #broadcastAppend(): void {
    for (const peer of this.#peers()) this.#sendAppend(peer)
  }

  #sendAppend(to: NodeId): void {
    const now = this.#now
    let progress = this.#progress.get(to)
    if (!progress) {
      progress = {
        next: this.lastIndex + 1,
        match: 0,
        lastContactMs: now,
        awaitingSnapshot: false,
        snapshotSentMs: 0,
      }
      this.#progress.set(to, progress)
    }
    // A snapshot in flight suppresses sends for one election timeout and then is retried. A plain
    // latch would strand a follower that was down when the snapshot went out: it comes back, the
    // leader is still "waiting", and nothing ever moves again.
    if (progress.awaitingSnapshot && now - progress.snapshotSentMs < this.electionTimeoutMs) return

    const prevIndex = progress.next - 1
    const prevTerm = this.#termAt(prevIndex)
    if (prevTerm === null) {
      // The entries this peer needs have been compacted away; the whole state is kilobytes, so
      // sending it is cheaper than keeping a log long enough to avoid this.
      if (!this.#snapshot) return
      progress.awaitingSnapshot = true
      progress.snapshotSentMs = now
      this.#out({
        type: "send",
        to,
        message: { type: "installSnapshot", term: this.#term, snapshot: this.#snapshot },
      })
      return
    }

    const from = this.#entries.findIndex((entry) => entry.index >= progress.next)
    const entries =
      from === -1 ? [] : this.#entries.slice(from, from + this.maxEntriesPerAppend)
    this.#out({
      type: "send",
      to,
      message: {
        type: "appendEntries",
        term: this.#term,
        prevLogIndex: prevIndex,
        prevLogTerm: prevTerm,
        entries,
        leaderCommit: this.#commitIndex,
      },
    })
  }

  #maybeCommit(): void {
    if (this.#role !== "leader") return
    const matches: number[] = [this.lastIndex]
    for (const peer of this.#config) {
      if (peer === this.id) continue
      matches.push(this.#progress.get(peer)?.match ?? 0)
    }
    matches.sort((a, b) => b - a)
    const candidate = matches[this.#quorum() - 1] ?? 0
    // Figure 8: an entry from an earlier term is never committed by counting replicas. It commits
    // when an entry of *this* leader's term commits on top of it, which the no-op guarantees.
    if (candidate > this.#commitIndex && this.#termAt(candidate) === this.#term) {
      this.#commitIndex = candidate
      this.#emitApply()
      this.#broadcastAppend()
    }
  }

  #emitApply(): void {
    if (this.#commitIndex <= this.#lastApplied) return
    const from = this.#lastApplied + 1
    const entries: LogEntry[] = []
    for (const entry of this.#entries) {
      if (entry.index >= from && entry.index <= this.#commitIndex) entries.push(entry)
    }
    this.#lastApplied = this.#commitIndex
    if (entries.length > 0) this.#applies.push({ type: "apply", entries })

    for (const [index, pending] of this.#pending) {
      if (index > this.#commitIndex) continue
      const term = this.#termAt(index)
      this.#pending.delete(index)
      this.#out({
        type: "proposalResult",
        id: pending.id,
        ok: term === pending.term,
        ...(term === pending.term ? {} : { reason: "the entry was replaced before it committed" }),
      })
    }

    // A leader that voted itself out of the configuration hands over rather than leading a cluster
    // it is not a member of.
    if (this.#role === "leader" && !this.#config.includes(this.id)) {
      this.#becomeFollower(this.#term, null, this.#electionResetMs)
    }

    if (this.#entries.length > this.snapshotEntries && this.#lastApplied > this.#snapshotIndex) {
      const term = this.#termAt(this.#lastApplied)
      if (term !== null) {
        this.#compact.push({
          type: "snapshot",
          reason: "compact",
          index: this.#lastApplied,
          term,
        })
      }
    }
  }

  // ── the log ──────────────────────────────────────────────────────────────────────────────────

  #termAt(index: number): number | null {
    if (index === this.#snapshotIndex) return this.#snapshotTerm
    if (index < this.#snapshotIndex) return null
    const first = this.#entries[0]
    if (!first) return null
    const at = index - first.index
    return this.#entries[at]?.term ?? null
  }

  #lastLogTerm(): number {
    return this.#termAt(this.lastIndex) ?? 0
  }

  #firstIndexOfTerm(term: number): number {
    for (const entry of this.#entries) if (entry.term === term) return entry.index
    return this.#snapshotIndex + 1
  }

  #lastIndexOfTerm(term: number): number | null {
    for (let at = this.#entries.length - 1; at >= 0; at--) {
      const entry = this.#entries[at] as LogEntry
      if (entry.term === term) return entry.index
      if (entry.term < term) return null
    }
    return this.#snapshotTerm === term ? this.#snapshotIndex : null
  }

  #upToDate(message: { lastLogIndex: number; lastLogTerm: number }): boolean {
    const mineTerm = this.#lastLogTerm()
    if (message.lastLogTerm !== mineTerm) return message.lastLogTerm > mineTerm
    return message.lastLogIndex >= this.lastIndex
  }

  /** Replays every config entry still in the log over the snapshot's configuration. */
  #recomputeConfig(): void {
    const voters = new Set(this.#baseConfig)
    const learners = new Set(this.#baseLearners)
    let configIndex = 0
    for (const entry of this.#entries) {
      if (entry.kind !== "config") continue
      configIndex = entry.index
      let change: ConfigChange
      try {
        change = decodeConfigChange(entry.data)
      } catch {
        continue
      }
      if (change.type === "remove") {
        voters.delete(change.node)
        learners.delete(change.node)
      } else if (change.status === "learner") {
        voters.delete(change.node)
        learners.add(change.node)
      } else {
        learners.delete(change.node)
        voters.add(change.node)
      }
    }
    this.#config = [...voters]
    this.#learners = [...learners]
    this.#configIndex = configIndex
  }

  #peers(): NodeId[] {
    const out: NodeId[] = []
    for (const node of this.#config) if (node !== this.id) out.push(node)
    for (const node of this.#learners) if (node !== this.id) out.push(node)
    return out
  }

  #voterPeers(): NodeId[] {
    return this.#config.filter((node) => node !== this.id)
  }

  #quorum(): number {
    return Math.floor(this.#config.length / 2) + 1
  }

  #counted(granted: boolean): number {
    let total = 0
    for (const [node, vote] of this.#votes) {
      if (vote === granted && this.#config.includes(node)) total += 1
    }
    return total
  }

  #failPending(fromIndex: number, reason: string): void {
    for (const [index, pending] of this.#pending) {
      if (index < fromIndex) continue
      this.#pending.delete(index)
      this.#out({ type: "proposalResult", id: pending.id, ok: false, reason })
    }
  }

  #persistHardState(): void {
    this.#out({ type: "persist", hardState: { term: this.#term, votedFor: this.#votedFor } })
  }

  // ── action buckets ───────────────────────────────────────────────────────────────────────────

  #out(action: RaftAction): void {
    switch (action.type) {
      case "persist":
        this.#persist.push(action)
        return
      case "send":
        this.#send.push(action)
        return
      case "apply":
        this.#applies.push(action)
        return
      case "proposalResult":
        this.#results.push(action)
        return
      case "snapshot":
        if (action.reason === "install") this.#install.push(action)
        else this.#compact.push(action)
        return
    }
  }

  #drain(): RaftAction[] {
    const out = [
      ...this.#persist,
      ...this.#install,
      ...this.#send,
      ...this.#applies,
      ...this.#results,
      ...this.#compact,
    ]
    this.#persist = []
    this.#install = []
    this.#send = []
    this.#applies = []
    this.#results = []
    this.#compact = []
    return out
  }
}
