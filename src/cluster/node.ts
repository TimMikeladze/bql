// The cluster node: timers, transport, log and the pure state machine driven together, and the
// only thing in `src/cluster/` the rest of BunQL ever calls.
//
// Invariant, and the reason this module exists at all: **the data path never waits on Raft.**
// `leaseFor(db)` is synchronous, returns a cached object it does not rebuild, and compares nothing
// but a monotonic clock. A write is 28 µs today and consulting the control plane must not be
// visible in that number, so there is no `await` anywhere a write can reach.
//
// The lease arithmetic, which is the whole safety argument:
//
//   * The Raft *leader* stamps `until = Date.now() + leaseTtlMs` into the `grantLease` command. It
//     is the leader's wall clock, and it is the only wall clock in the system.
//   * The *holder* ignores that number for its own purposes entirely. When the grant applies, it
//     stamps `grantedAtLocalMs` from its own monotonic clock and treats the lease as valid until
//     `grantedAtLocalMs + leaseTtlMs - leaseGuardMs` on that same clock.
//   * So only elapsed time is ever compared, and only ever the holder's own. A clock *offset*
//     between two machines — the thing NTP is usually blamed for — cannot matter here, because no
//     node ever reads another node's clock.
//   * `leaseGuardMs` covers clock *rate* skew over one TTL, and nothing else. The holder stamps
//     strictly after the leader did (the grant had to commit and reach it), so its deadline is
//     already earlier in real time than the leader's `until`; the guard is the margin on top that
//     makes it impossible for the holder to still believe it holds the lease at the moment the
//     leader becomes free to grant it elsewhere. That margin is what makes two writers impossible,
//     and it is why 500 ms of a 3000 ms lease is spent on nothing.
//
// Raft's own timers run on `performance.now()`, not `Date.now()`: an election timeout is an
// elapsed-time question and a wall clock that steps backwards over NTP would otherwise stall an
// election or start a spurious one.
//
// Second invariant: the driver walks `raft.step()`'s actions in the order they come back, and that
// order is `persist` before `send` (see `raft.ts`). Nothing here may reorder them, batch them, or
// make one of them asynchronous.

import {
  type ConfigChange,
  type HardState,
  type LogEntry,
  Raft,
  type RaftAction,
  type RaftInput,
  type RaftMessage,
  type RaftRole,
  type RaftSnapshot,
  type ProposalId,
} from "./raft.ts"
import { RaftLog } from "./log.ts"
import {
  apply,
  type ClusterState,
  type Command,
  decodeCommand,
  decodeSnapshot,
  type DbState,
  emptyState,
  encodeCommand,
  encodeSnapshot,
  type NodeId,
  type NodeStatus,
} from "./state.ts"
import {
  RaftTransport,
  type RaftSocket,
  type RaftSocketData,
  type RaftSocketFactory,
} from "./transport.ts"

/**
 * What the write path reads. `validUntilLocalMs` is a deadline on *this* node's monotonic clock,
 * and it is only meaningful when `node` is this node: for a lease held elsewhere it is 0, which is
 * always in the past, so `node === me && monotonic() < validUntilLocalMs` is the whole check.
 */
export interface LeaseHandle {
  node: NodeId
  epoch: number
  validUntilLocalMs: number
}

export interface ClusterViewNode {
  id: NodeId
  advertise: string
  zone: string
  status: NodeStatus
  joinedTerm: number
  /** Whether this node currently holds an outbound socket to it. */
  reachable: boolean
  /** Highest index this node knows the peer holds; leader only, 0 elsewhere. */
  matchIndex: number
}

export interface ClusterViewDb {
  db: string
  primary: NodeId | null
  replicas: NodeId[]
  epoch: number
  lease: { node: NodeId; until: number } | null
  acked: Record<NodeId, string>
}

/** What `GET /v1/cluster` will render. */
export interface ClusterView {
  id: NodeId
  role: RaftRole
  term: number
  leader: NodeId | null
  commitIndex: number
  lastIndex: number
  appliedIndex: number
  /** Raft's voter set, which is not the same thing as every node the state machine knows about. */
  voters: NodeId[]
  learners: NodeId[]
  nodes: ClusterViewNode[]
  dbs: ClusterViewDb[]
}

export interface ClusterNodeOptions {
  id: NodeId
  /** Where `meta`, `entries.log` and `snapshot` live. Usually `<dataDir>/cluster`. */
  dir: string
  /** `ws://host:port` this node is reachable at, recorded in the state machine. */
  advertise?: string
  zone?: string
  /** Peer id to `ws://host:port/v1/cluster/raft`. The initial voter set is its keys plus `id`. */
  peers?: Record<NodeId, string>
  /** Form a new cluster from `peers` rather than waiting to be added to one. */
  bootstrap?: boolean
  /** The shared cluster secret. Empty disables the listening half. */
  secret?: string
  leaseTtlMs?: number
  leaseRenewMs?: number
  leaseGuardMs?: number
  electionTimeoutMs?: number
  heartbeatMs?: number
  snapshotEntries?: number
  /** How long `propose` waits for its entry to commit. Default `4 * electionTimeoutMs`. */
  proposeTimeoutMs?: number
  random?: () => number
  /** Injected so tests do not have to wait out real time. */
  monotonic?: () => number
  wall?: () => number
  onError?: (err: unknown) => void
  factory?: RaftSocketFactory
  /** Off for a test that wants the disk out of the measurement. Default on. */
  fsync?: boolean
}

interface PendingProposal {
  resolve: (result: { ok: boolean; reason?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULTS = {
  leaseTtlMs: 3000,
  leaseRenewMs: 1000,
  leaseGuardMs: 500,
  electionTimeoutMs: 1500,
  heartbeatMs: 300,
  snapshotEntries: 512,
} as const

export class ClusterNode {
  readonly id: NodeId
  readonly dir: string
  readonly leaseTtlMs: number
  readonly leaseRenewMs: number
  readonly leaseGuardMs: number
  readonly electionTimeoutMs: number
  readonly heartbeatMs: number
  readonly snapshotEntries: number
  readonly proposeTimeoutMs: number

  #options: ClusterNodeOptions
  #monotonic: () => number
  #wall: () => number
  #onError: (err: unknown) => void

  #log: RaftLog | null = null
  #raft: Raft | null = null
  #transport: RaftTransport | null = null
  #state: ClusterState = emptyState()

  /** One cached handle per database, replaced only when the lease actually changes. */
  #leases = new Map<string, LeaseHandle>()
  #peerUrls: Record<NodeId, string>
  #pending = new Map<ProposalId, PendingProposal>()
  #listeners = new Set<(view: ClusterView) => void>()
  #nextProposal = 1

  #tickTimer: ReturnType<typeof setInterval> | null = null
  #renewTimer: ReturnType<typeof setInterval> | null = null
  #started = false
  #closed = false
  #lastRole: RaftRole = "follower"

  constructor(options: ClusterNodeOptions) {
    this.#options = options
    this.id = options.id
    this.dir = options.dir
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULTS.leaseTtlMs
    this.leaseRenewMs = options.leaseRenewMs ?? DEFAULTS.leaseRenewMs
    this.leaseGuardMs = options.leaseGuardMs ?? DEFAULTS.leaseGuardMs
    this.electionTimeoutMs = options.electionTimeoutMs ?? DEFAULTS.electionTimeoutMs
    this.heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs
    this.snapshotEntries = options.snapshotEntries ?? DEFAULTS.snapshotEntries
    this.proposeTimeoutMs = options.proposeTimeoutMs ?? this.electionTimeoutMs * 4
    this.#monotonic = options.monotonic ?? (() => performance.now())
    this.#wall = options.wall ?? (() => Date.now())
    this.#onError = options.onError ?? (() => {})
    this.#peerUrls = { ...(options.peers ?? {}) }
  }

  // ── the surface the server calls ─────────────────────────────────────────────────────────────

  /**
   * The data path's only entry point. Synchronous, allocation-free on the hot path — the handle is
   * the same object until the lease changes — and never a round trip.
   */
  leaseFor(db: string): LeaseHandle | null {
    return this.#leases.get(db) ?? null
  }

  isLeader(): boolean {
    return this.#raft?.role === "leader"
  }

  get term(): number {
    return this.#raft?.term ?? 0
  }

  get leaderId(): NodeId | null {
    return this.#raft?.leaderId ?? null
  }

  /** The replicated state as this node has applied it. Read-only; `propose` is the way to change it. */
  get state(): ClusterState {
    return this.#state
  }

  /**
   * Puts a command through Raft. Resolves when the entry commits, or with `ok: false` and a reason
   * when this node is not the leader, the entry is overtaken by a new leader, or it does not commit
   * inside `proposeTimeoutMs`.
   *
   * `addNode` and `removeNode` are routed through a Raft configuration change when they would move
   * the voter set, because membership and the quorum that decides membership have to be the same
   * fact. One at a time: a second change while one is uncommitted is refused.
   */
  propose(command: Command): Promise<{ ok: boolean; reason?: string }> {
    const raft = this.#raft
    if (!raft) return Promise.resolve({ ok: false, reason: "the cluster node is not started" })

    const change = this.#configChangeFor(command, raft)
    const id = this.#nextProposal++
    const promise = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({ ok: false, reason: "the proposal did not commit in time" })
      }, this.proposeTimeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, timer })
    })
    this.#step({
      type: "propose",
      id,
      command: change
        ? { kind: "config", change }
        : { kind: "command", data: encodeCommand(command) },
    })
    return promise
  }

  observe(): ClusterView {
    const raft = this.#raft
    const transport = this.#transport
    const nodes: ClusterViewNode[] = Object.entries(this.#state.nodes).map(([id, info]) => ({
      id,
      advertise: info.advertise,
      zone: info.zone,
      status: info.status,
      joinedTerm: info.joinedTerm,
      reachable: id === this.id ? true : (transport?.isConnected(id) ?? false),
      matchIndex: 0,
    }))
    const dbs: ClusterViewDb[] = Object.entries(this.#state.dbs).map(([db, entry]) => ({
      db,
      primary: entry.primary,
      replicas: [...entry.replicas],
      epoch: entry.epoch,
      lease: entry.lease ? { ...entry.lease } : null,
      acked: { ...entry.acked },
    }))
    return {
      id: this.id,
      role: raft?.role ?? "follower",
      term: raft?.term ?? 0,
      leader: raft?.leaderId ?? null,
      commitIndex: raft?.commitIndex ?? 0,
      lastIndex: raft?.lastIndex ?? 0,
      appliedIndex: raft?.lastApplied ?? 0,
      voters: raft?.config ?? [],
      learners: raft?.learners ?? [],
      nodes,
      dbs,
    }
  }

  /** Fired whenever the replicated state, the role, the term or the leader changes. */
  onChange(listener: (view: ClusterView) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** The handlers `app.ts` mounts at `/v1/cluster/raft`. */
  get socket(): {
    onUpgrade: (request: Request) => { data: RaftSocketData } | Response
    onOpen: (ws: RaftSocket) => void
    onMessage: (ws: RaftSocket, data: string | Uint8Array | ArrayBuffer) => void
    onClose: (ws: RaftSocket) => void
  } {
    const transport = this.#transport
    if (!transport) throw new Error("the cluster node is not started")
    return {
      onUpgrade: (request) => transport.onUpgrade(request),
      onOpen: (ws) => transport.onOpen(ws),
      onMessage: (ws, data) => transport.onMessage(ws, data),
      onClose: (ws) => transport.onClose(ws),
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true

    const log = RaftLog.open({ dir: this.dir, fsync: this.#options.fsync ?? true })
    this.#log = log
    this.#state = log.snapshot ? decodeSnapshot(log.snapshot.data) : emptyState()
    this.#rebuildLeases()

    const voters = this.#options.bootstrap === false ? [] : this.#initialVoters()
    this.#raft = new Raft({
      id: this.id,
      config: log.snapshot ? log.snapshot.config : voters,
      learners: log.snapshot ? log.snapshot.learners : [],
      electionTimeoutMs: this.electionTimeoutMs,
      heartbeatMs: this.heartbeatMs,
      snapshotEntries: this.snapshotEntries,
      ...(this.#options.random ? { random: this.#options.random } : {}),
      hardState: log.hardState,
      entries: [...log.entries],
      snapshot: log.snapshot,
    })

    this.#transport = new RaftTransport({
      id: this.id,
      secret: this.#options.secret ?? "",
      peers: this.#peerUrls,
      onMessage: (from, message) => this.#onMessage(from, message),
      onError: this.#onError,
      ...(this.#options.factory ? { factory: this.#options.factory } : {}),
      ...(this.#options.random ? { random: this.#options.random } : {}),
    })
    this.#transport.start()

    // One interval drives every Raft timer; the machine works in elapsed milliseconds, so the tick
    // only has to be fine enough that a heartbeat is not late by much.
    const tickMs = Math.max(10, Math.floor(this.heartbeatMs / 3))
    this.#tickTimer = setInterval(() => this.#step({ type: "tick" }), tickMs)
    this.#tickTimer.unref?.()
    this.#renewTimer = setInterval(() => this.#renewLeases(), this.leaseRenewMs)
    this.#renewTimer.unref?.()

    // A single-voter cluster has no one to ask, so it stops being a cluster without a leader the
    // moment it starts rather than one election timeout later.
    const config = this.#raft.config
    if (config.length === 1 && config[0] === this.id) this.#step({ type: "campaign" })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#tickTimer) clearInterval(this.#tickTimer)
    if (this.#renewTimer) clearInterval(this.#renewTimer)
    this.#tickTimer = null
    this.#renewTimer = null
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, reason: "the cluster node is shutting down" })
    }
    this.#pending.clear()
    this.#transport?.close()
    this.#transport = null
    this.#log?.close()
    this.#log = null
    this.#listeners.clear()
  }

  // ── driving the machine ──────────────────────────────────────────────────────────────────────

  #step(input: RaftInput): void {
    const raft = this.#raft
    if (!raft || this.#closed) return
    let actions: RaftAction[]
    try {
      actions = raft.step(input, this.#monotonic())
    } catch (err) {
      this.#onError(err)
      return
    }
    this.#drive(actions)
  }

  #onMessage(from: NodeId, message: RaftMessage): void {
    this.#step({ type: "message", from, message })
  }

  /**
   * Walks the actions in order. Persisting is synchronous and fsynced, which is the point: a
   * `send` that follows a `persist` in this array is a send whose premise is already on disk.
   */
  #drive(actions: RaftAction[]): void {
    const log = this.#log
    const raft = this.#raft
    if (!log || !raft) return
    let changed = false

    for (const action of actions) {
      try {
        switch (action.type) {
          case "persist":
            this.#persist(log, action.hardState, action.truncateFrom, action.entries)
            break
          case "send":
            this.#transport?.send(action.to, action.message)
            break
          case "apply":
            for (const entry of action.entries) this.#applyEntry(entry)
            changed = true
            break
          case "proposalResult": {
            const pending = this.#pending.get(action.id)
            if (!pending) break
            this.#pending.delete(action.id)
            clearTimeout(pending.timer)
            pending.resolve(
              action.ok ? { ok: true } : { ok: false, reason: action.reason ?? "refused" },
            )
            break
          }
          case "snapshot":
            if (action.reason === "install") {
              this.#state = decodeSnapshot(action.snapshot.data)
              log.installSnapshot(action.snapshot)
              this.#rebuildLeases()
              changed = true
            } else {
              raft.compact(action.index, action.term, encodeSnapshot(this.#state))
              const snapshot: RaftSnapshot | null = raft.snapshot
              if (snapshot && snapshot.index === action.index) log.saveSnapshot(snapshot)
            }
            break
        }
      } catch (err) {
        this.#onError(err)
      }
    }

    if (raft.role !== this.#lastRole) {
      this.#lastRole = raft.role
      changed = true
      if (raft.role === "leader") this.#reconcileMembership()
    }
    if (changed) this.#notify()
  }

  #persist(
    log: RaftLog,
    hardState: HardState | undefined,
    truncateFrom: number | undefined,
    entries: readonly LogEntry[] | undefined,
  ): void {
    if (hardState) log.setHardState(hardState)
    if (truncateFrom !== undefined) log.truncate(truncateFrom)
    if (entries && entries.length > 0) log.append(entries)
  }

  #applyEntry(entry: LogEntry): void {
    if (entry.kind === "noop") return
    const command =
      entry.kind === "config"
        ? commandForConfigChange(entry.data, this.#state)
        : decodeCommand(entry.data)
    if (!command) return
    const before = this.#state.dbs
    this.#state = apply(this.#state, command, entry.term)
    if (before !== this.#state.dbs) this.#syncLeases(before)
    if (command.type === "addNode" || command.type === "removeNode") this.#syncPeers()
  }

  // ── leases ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Refreshes the cached handles for every database whose lease record actually changed. A lease
   * this node holds is stamped against *its own* monotonic clock, here, at the moment the grant
   * applies — never against the `until` the leader wrote, which belongs to another machine.
   */
  #syncLeases(before: Record<string, DbState>): void {
    for (const [db, entry] of Object.entries(this.#state.dbs)) {
      const previous = before[db]
      if (previous === entry) continue
      const lease = entry.lease
      if (!lease) {
        this.#leases.delete(db)
        continue
      }
      const cached = this.#leases.get(db)
      const unchanged =
        previous?.lease?.node === lease.node && previous.lease.until === lease.until
      // A renewal moves `until`, and a renewal is exactly when the holder has to re-stamp its own
      // clock; only a record that did not move at all keeps the handle it already has.
      if (cached && unchanged && cached.epoch === entry.epoch) continue
      this.#leases.set(db, this.#handleFor(lease.node, entry.epoch))
    }
    for (const db of [...this.#leases.keys()]) {
      if (!this.#state.dbs[db]?.lease) this.#leases.delete(db)
    }
  }

  #rebuildLeases(): void {
    this.#leases.clear()
    for (const [db, entry] of Object.entries(this.#state.dbs)) {
      if (entry.lease) this.#leases.set(db, this.#handleFor(entry.lease.node, entry.epoch))
    }
  }

  #handleFor(node: NodeId, epoch: number): LeaseHandle {
    return {
      node,
      epoch,
      // 0 for a lease held elsewhere: always in the past on this clock, which is exactly right.
      validUntilLocalMs:
        node === this.id ? this.#monotonic() + this.leaseTtlMs - this.leaseGuardMs : 0,
    }
  }

  /**
   * The leader renews every lease it has granted. In C1 renewal is leader-driven because the
   * leader is the one that must not grant the database elsewhere; a primary that is not the Raft
   * leader asking for its own renewal is C2's failover path.
   */
  #renewLeases(): void {
    if (!this.isLeader() || this.#closed) return
    const now = this.#wall()
    for (const [db, entry] of Object.entries(this.#state.dbs)) {
      const lease = entry.lease
      if (!lease) continue
      // Already renewed inside this interval — an out-of-band grant, usually.
      if (lease.until - now > this.leaseTtlMs - this.leaseRenewMs) continue
      void this.propose({
        type: "grantLease",
        db,
        node: lease.node,
        until: now + this.leaseTtlMs,
      }).catch(this.#onError)
    }
  }

  // ── membership ───────────────────────────────────────────────────────────────────────────────

  #initialVoters(): NodeId[] {
    const voters = new Set<NodeId>([this.id])
    for (const node of Object.keys(this.#peerUrls)) voters.add(node)
    return [...voters]
  }

  /**
   * `addNode`/`removeNode` become Raft configuration changes exactly when they would move the
   * voter set; otherwise they are plain commands that only record an address or a zone. Anything
   * else would leave the quorum and the membership table disagreeing about who is in the cluster.
   */
  #configChangeFor(command: Command, raft: Raft): ConfigChange | null {
    if (command.type === "addNode") {
      const wanted = command.status ?? "voter"
      const present =
        wanted === "learner" ? raft.learners.includes(command.node) : raft.config.includes(command.node)
      if (present) return null
      return {
        type: "add",
        node: command.node,
        ...(command.advertise === undefined ? {} : { advertise: command.advertise }),
        ...(command.zone === undefined ? {} : { zone: command.zone }),
        status: wanted,
      }
    }
    if (command.type === "removeNode") {
      const present = raft.config.includes(command.node) || raft.learners.includes(command.node)
      if (!present) return null
      return { type: "remove", node: command.node }
    }
    return null
  }

  /**
   * A freshly elected leader records every voter the state machine has not heard of yet, so
   * `GET /v1/cluster` shows the cluster that actually exists rather than the empty table a
   * bootstrap starts with.
   */
  #reconcileMembership(): void {
    const raft = this.#raft
    if (!raft) return
    for (const node of raft.config) {
      const known = this.#state.nodes[node]
      const advertise = node === this.id ? (this.#options.advertise ?? "") : (this.#peerUrls[node] ?? "")
      const zone = node === this.id ? (this.#options.zone ?? "") : (known?.zone ?? "")
      if (known && known.advertise === advertise && known.zone === zone) continue
      void this.propose({ type: "addNode", node, advertise, zone, status: "voter" }).catch(
        this.#onError,
      )
    }
  }

  /** Keeps the transport's dial table in step with the addresses the state machine knows. */
  #syncPeers(): void {
    const peers: Record<NodeId, string> = { ...this.#peerUrls }
    for (const [node, info] of Object.entries(this.#state.nodes)) {
      if (node === this.id || info.advertise.length === 0) continue
      peers[node] = info.advertise
    }
    for (const node of Object.keys(peers)) {
      if (node !== this.id && !this.#state.nodes[node] && !this.#peerUrls[node]) delete peers[node]
    }
    this.#transport?.setPeers(peers)
  }

  #notify(): void {
    if (this.#listeners.size === 0) return
    const view = this.observe()
    for (const listener of this.#listeners) {
      try {
        listener(view)
      } catch (err) {
        this.#onError(err)
      }
    }
  }
}

/** Turns a committed configuration change into the state machine's own membership command. */
function commandForConfigChange(data: Uint8Array, state: ClusterState): Command | null {
  let change: ConfigChange
  try {
    change = JSON.parse(new TextDecoder().decode(data)) as ConfigChange
  } catch {
    return null
  }
  if (change.type === "remove") return { type: "removeNode", node: change.node }
  const known = state.nodes[change.node]
  return {
    type: "addNode",
    node: change.node,
    advertise: change.advertise ?? known?.advertise ?? "",
    zone: change.zone ?? known?.zone ?? "",
    status: change.status ?? "voter",
  }
}
