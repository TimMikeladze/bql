// `ack: "replica" | "quorum"` (design §5.4), built on the one seam R1 left: every `ACK` frame the
// primary receives fires `ReplicationServer.onAck`.
//
// Invariant: an ack waiter counts distinct replica *nodes*, never streams or sockets. A node that
// reconnects, or that follows the same database on two connections, is one vote — which is the
// only counting rule under which "a quorum has it" means what it says.
//
// Second invariant: nothing here can un-commit anything. By the time `wait` is called the record
// is in the log and fsynced locally; a timeout is a slower answer to the client about a
// transaction that definitely happened, never a rollback.

import type { AckLevel } from "../tenant/index.ts"
import type { AckEvent, ReplicationServer } from "./primary.ts"

/** What a waiter resolves with, and what the failure carries into the HTTP body. */
export interface AckOutcome {
  /** Distinct replica nodes at or past the txid when the wait ended. */
  acks: number
  /** How many were needed. */
  needed: number
  /** Replica nodes attached to the database when the wait ended. */
  replicas: number
}

export class AckTimeout extends Error {
  readonly code = "ACK_TIMEOUT"
  readonly txid: bigint
  readonly outcome: AckOutcome

  constructor(db: string, txid: bigint, waitedMs: number, outcome: AckOutcome) {
    super(
      `${db}: txid ${txid} is durable on this node, but only ${outcome.acks} of ${outcome.needed} ` +
        `replica acks arrived in ${waitedMs}ms`,
    )
    this.name = "AckTimeout"
    this.txid = txid
    this.outcome = outcome
  }
}

/** No replica is attached and `ackWithoutReplicas` is `"error"`. */
export class NoReplicas extends Error {
  readonly code = "NO_REPLICAS"
  readonly txid: bigint | null

  constructor(db: string, level: AckLevel, txid: bigint | null) {
    super(`${db}: ack ${JSON.stringify(level)} needs a replica, and none is attached to this node`)
    this.name = "NoReplicas"
    this.txid = txid
  }
}

export interface AckTrackerOptions {
  /** Null on a node with no cluster secret: every replica level is then "no replicas". */
  server: ReplicationServer | null
  /** `replication.ackTimeoutMs`. */
  timeoutMs?: number
  /** `replication.ackWithoutReplicas`. The node's answer, and the fallback for every database. */
  withoutReplicas?: "error" | "allow"
  /**
   * One database's own answer, or null when it follows the node (`docs/r8-per-db-ack.md`).
   *
   * The tracker still owns the rule — this only says which default applies to this database — so a
   * tracker built without a resolver behaves exactly as it did before there was one.
   */
  withoutReplicasOf?: (db: string) => "error" | "allow" | null
}

interface Waiter {
  db: string
  txid: bigint
  needed: number
  resolve: (outcome: AckOutcome) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Highest acked txid per `(db, node)`, and the waiters that are watching for one.
 *
 * The tracker is the only thing that decides how many acks a level needs, so the rule lives in
 * `#needed` and nowhere else.
 */
export class AckTracker {
  readonly timeoutMs: number
  readonly withoutReplicas: "error" | "allow"

  #server: ReplicationServer | null
  #withoutReplicasOf: ((db: string) => "error" | "allow" | null) | null
  #acked = new Map<string, Map<string, bigint>>()
  #waiters = new Set<Waiter>()
  #unhook: (() => void) | null = null

  constructor(options: AckTrackerOptions) {
    this.#server = options.server
    this.timeoutMs = options.timeoutMs ?? 2000
    this.withoutReplicas = options.withoutReplicas ?? "error"
    this.#withoutReplicasOf = options.withoutReplicasOf ?? null
    if (this.#server) this.#unhook = this.#server.onAck((event) => this.#onAck(event))
  }

  /**
   * What `db` does when the level it was asked for cannot be satisfied: its own override, or the
   * node's setting when it has none. The single place the rule is read, so the two call sites
   * below cannot disagree about it.
   */
  ruleFor(db: string): "error" | "allow" {
    return this.#withoutReplicasOf?.(db) ?? this.withoutReplicas
  }

  /** True when this node could ever satisfy a replica ack level. */
  get enabled(): boolean {
    return this.#server !== null
  }

  /** Replica nodes currently following `db`, counted once each. */
  replicaCount(db: string): number {
    if (!this.#server) return 0
    const nodes = new Set<string>()
    for (const replica of this.#server.replicasOf(db)) nodes.add(replica.node)
    return nodes.size
  }

  /** Distinct replica nodes that have acked at or past `txid`. */
  ackedNodes(db: string, txid: bigint): number {
    const byNode = this.#acked.get(db)
    if (!byNode) return 0
    let count = 0
    for (const at of byNode.values()) {
      if (at >= txid) count += 1
    }
    return count
  }

  /**
   * Replica acks a level needs, given the replicas attached now.
   *
   * `"replica"` is one. `"quorum"` is a majority of primary + replicas — `floor((n + 1) / 2)`
   * replica acks, the primary counting as one member. `plan-phase1.md` writes the quorum size as
   * `ceil((replicas + 1) / 2)` *including* the primary, which for one replica works out to one
   * node and so makes `quorum` weaker than `replica`; see `docs/r2-durability.md`.
   */
  needed(db: string, level: AckLevel, replicas = this.replicaCount(db)): number {
    if (level === "quorum") return Math.max(1, Math.floor((replicas + 1) / 2))
    return 1
  }

  /**
   * Resolves once enough nodes have acked `txid`, or rejects with `AckTimeout`. `txid` of 0 is a
   * statement that wrote nothing and is already as durable as it will ever be.
   */
  wait(db: string, txid: bigint, level: AckLevel, timeoutMs = this.timeoutMs): Promise<AckOutcome> {
    if (level !== "replica" && level !== "quorum") {
      return Promise.resolve({ acks: 0, needed: 0, replicas: 0 })
    }
    if (txid <= 0n) return Promise.resolve({ acks: 0, needed: 0, replicas: this.replicaCount(db) })
    const replicas = this.replicaCount(db)
    if (replicas === 0) {
      if (this.ruleFor(db) === "allow") return Promise.resolve({ acks: 0, needed: 0, replicas })
      return Promise.reject(new NoReplicas(db, level, txid))
    }
    const needed = this.needed(db, level, replicas)
    const acks = this.ackedNodes(db, txid)
    if (acks >= needed) return Promise.resolve({ acks, needed, replicas })

    const startedMs = Date.now()
    return new Promise<AckOutcome>((resolve, reject) => {
      const waiter: Waiter = {
        db,
        txid,
        needed,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter)
          reject(
            new AckTimeout(db, txid, Date.now() - startedMs, {
              acks: this.ackedNodes(db, txid),
              needed,
              replicas: this.replicaCount(db),
            }),
          )
        }, timeoutMs),
      }
      waiter.timer.unref?.()
      this.#waiters.add(waiter)
    })
  }

  /**
   * Raises `NoReplicas` when this node could not possibly answer `level`. Called before a write
   * runs, so the common misconfiguration — asking for replica durability on a node with none —
   * costs nothing and leaves no txid behind.
   */
  assertAvailable(db: string, level: AckLevel): void {
    if (level !== "replica" && level !== "quorum") return
    if (this.ruleFor(db) === "allow") return
    if (this.replicaCount(db) === 0) throw new NoReplicas(db, level, null)
  }

  /** Drops a database's ack bookkeeping; the tenant is gone. */
  forget(db: string): void {
    this.#acked.delete(db)
  }

  close(): void {
    this.#unhook?.()
    this.#unhook = null
    for (const waiter of this.#waiters) clearTimeout(waiter.timer)
    this.#waiters.clear()
    this.#acked.clear()
  }

  #onAck(event: AckEvent): void {
    let byNode = this.#acked.get(event.db)
    if (!byNode) {
      byNode = new Map()
      this.#acked.set(event.db, byNode)
    }
    const previous = byNode.get(event.node) ?? 0n
    if (event.txid <= previous) return
    byNode.set(event.node, event.txid)
    if (this.#waiters.size === 0) return
    for (const waiter of [...this.#waiters]) {
      if (waiter.db !== event.db || event.txid < waiter.txid) continue
      const acks = this.ackedNodes(waiter.db, waiter.txid)
      if (acks < waiter.needed) continue
      this.#waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve({ acks, needed: waiter.needed, replicas: this.replicaCount(waiter.db) })
    }
  }
}
