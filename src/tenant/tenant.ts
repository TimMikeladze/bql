// One database and everything that owns it: the single writer connection, a small reader pool,
// the M3 recorder and log, the checkpoint policy and the crash reconcile. Design §4.2, §4.3.
//
// Invariant: a transaction is acknowledged only after its record is in the log and the position
// is saved. The order is commit → tail → append → save → hooks, so a crash can leave the catalog
// behind the log (repairable from the log's own records) but never ahead of it.
//
// Second invariant: only this class checkpoints. SQLite's autocheckpoint is off, so no frame can
// leave the WAL before the tailer has read it, which is what makes the log complete by
// construction rather than by luck.
//
// Third invariant (replica mode, design §5.2): a replica tenant never authors a transaction.
// Every txid it holds arrived as a record that its `WalApplier` verified against its own
// pre-images, so `write`, `txBegin`/`txCommit` and an operator TRUNCATE checkpoint are refused
// with `NOT_PRIMARY` rather than quietly producing a txid no primary knows about.
//
// Hook slots: the tenant takes the writer's WAL hook and nothing else. The commit, rollback and
// authorizer slots belong to `src/realtime` and the route layer (docs/m6-realtime.md), which is
// why `onCommit` here is a list of listeners this class calls after `log.append` rather than
// SQLite's own commit hook — `write()` is synchronous, so it can.

import fs from "node:fs"
import path from "node:path"
import { BunQLError } from "../server/errors.ts"
import { SqliteError } from "../sqlite/errors.ts"
import {
  type CheckpointMode,
  type CheckpointResult,
  Database,
  type LimitName,
  type TransactionMode,
} from "../sqlite/index.ts"
import {
  computeFull,
  encode,
  listSnapshots,
  type RecorderPosition,
  restore,
  snapshot,
  type SnapshotRef,
  TxnLog,
  type TxnRecord,
  type TxnRecordInput,
  TxnRecorder,
  WAL_HEADER_SIZE,
  WalApplier,
  WalError,
  WalFormatError,
} from "../wal/index.ts"
import { Catalog, positionOf, type TenantRole } from "./catalog.ts"

/** How durable a write has to be before it is acknowledged (design §5.4, minus the replicas). */
export type AckLevel = "local" | "fsync"

/** What a commit hook is handed. M6 turns this into change events; nothing here knows how. */
export interface CommitEvent {
  txid: bigint
  record: TxnRecordInput
  /** The encoded record — also the wire format a replica stream sends. */
  bytes: Uint8Array
}

export type CommitListener = (event: CommitEvent) => void

/** What `Tenant.open` found when it reconciled the log, the catalog and the database. */
export type ReconcileOutcome =
  /** The three agreed. */
  | "clean"
  /** The database held transactions the log did not; they were tailed back into it. */
  | "tailed"
  /** The log held a transaction the database did not; it was applied to the database. */
  | "applied"

export interface TenantOptions {
  name: string
  /**
   * `"primary"` (default) owns the write path. `"replica"` opens readers and a `WalApplier`,
   * takes its transactions from `applyRecord`, and refuses every write verb.
   */
  role?: TenantRole
  /** The data root, `<dataDir>`; forks resolve their own directory under it. */
  dataDir: string
  /** This tenant's directory, `<dataDir>/dbs/<hh>/<name>`. */
  dir: string
  catalog: Catalog
  /** Page size for a database that does not exist yet. Default 4096. */
  pageSize?: number
  /** Storage quota in bytes, enforced by `max_page_count`. 0 (default) is unlimited. */
  quotaBytes?: number
  epoch?: number
  /**
   * Position to resume from. The registry passes the catalog row it already read; without it the
   * catalog is consulted.
   */
  position?: RecorderPosition
  /** Reader connections held open. Default 2 (design §4.2). */
  readers?: number
  busyTimeoutMs?: number
  /** PASSIVE checkpoint once the WAL passes this many bytes. Default 4 MB (design §4.3). */
  checkpointWalBytes?: number
  /** TRUNCATE checkpoint once the tenant has been idle this long. Default 1000 ms. */
  idleCheckpointMs?: number
  /** Default durability for `write`. Default `"local"`. */
  defaultAck?: AckLevel
  /** How long `read({minTxid})` waits by default. Default 2000 ms (design §5.4). */
  waitMs?: number
  /**
   * How often the catalog position is refreshed while writing, in milliseconds. Default 200. The
   * position is a fast-start hint, not a durability record: a crash that leaves it stale is
   * repaired from the log's own records, which carry the WAL position they were tailed at.
   */
  positionIntervalMs?: number
  segmentBytes?: number
  logFsync?: "never" | "each" | "interval"
  /** `sqlite3_limit` overrides; the defaults below are applied first. */
  limits?: Partial<Record<LimitName, number>>
  /** Where a throwing commit hook goes. Defaults to `console.error`. */
  onError?: (err: unknown) => void
  /**
   * Called once for every connection this tenant opens, after its pragmas and limits are set and
   * before anything uses it. The seam the route layer installs its authorizer trampoline through,
   * since readers are opened lazily and a pooled one outlives the request that created it.
   */
  onConnection?: (db: Database, role: "writer" | "reader") => void
}

/** Design §4.7: SQL bombs are bounded by the library, not by parsing. */
const DEFAULT_LIMITS: Partial<Record<LimitName, number>> = {
  SQLITE_LIMIT_SQL_LENGTH: 1_000_000,
  SQLITE_LIMIT_EXPR_DEPTH: 200,
  SQLITE_LIMIT_COMPOUND_SELECT: 50,
  SQLITE_LIMIT_VARIABLE_NUMBER: 32_766,
  SQLITE_LIMIT_ATTACHED: 0,
}

export interface TenantStats {
  name: string
  role: TenantRole
  sizeBytes: number
  walBytes: number
  txid: bigint
  epoch: number
  checksum: bigint
  openReaders: number
  logBytes: number
  lastSnapshotTxid: bigint | null
}

export interface WriteOptions {
  ack?: AckLevel
}

export interface TxBeginOptions extends WriteOptions {
  /** `BEGIN <mode>`. Default `"immediate"`: a baton transaction is a write that arrives in parts. */
  mode?: TransactionMode
  /** Roll the transaction back after this long with no statement. 0 (default) never expires. */
  idleTimeoutMs?: number
  /** Called after the idle timer rolled the transaction back, so the route layer can drop its baton. */
  onExpire?: () => void
}

export interface ReadOptions {
  /** Refuse (or wait) until the tenant has reached this txid — design §5.4, read-your-writes. */
  minTxid?: bigint
  waitMs?: number
}

export interface WriteResult<T> {
  result: T
  txid: bigint
}

/** A failure that is the tenant's own, not SQLite's and not the client's. */
export class TenantError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "TenantError"
    this.code = code
  }
}

/** Design §4.2: `[a-z0-9][a-z0-9-_]{0,63}`. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Names that would collide with the node's own files under `<dataDir>`. */
const RESERVED = new Set(["_system", "dbs", "trash"])

/** Throws unless `name` is a legal database name. Every path below is built from one. */
export function assertValidName(name: string): void {
  if (!NAME.test(name) || RESERVED.has(name)) {
    throw BunQLError.badRequest(
      `invalid database name ${JSON.stringify(name)}: expected [a-z0-9][a-z0-9-_]{0,63}`,
    )
  }
}

/** Design §4.2: `data/dbs/<2-char hash>/<name>/`. */
export function tenantDir(dataDir: string, name: string): string {
  const prefix = Bun.hash.xxHash3(name).toString(16).padStart(16, "0").slice(0, 2)
  return path.join(dataDir, "dbs", prefix, name)
}

interface Waiter {
  txid: bigint
  resolve: () => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * A borrowed reader connection. `pooled` is false for a connection opened past the pool's size,
 * which is closed rather than returned on release.
 */
export interface ReaderLease {
  db: Database
  pooled: boolean
}

export class Tenant {
  readonly name: string
  readonly role: TenantRole
  readonly dataDir: string
  readonly dir: string
  readonly dbPath: string
  readonly catalog: Catalog
  /**
   * The tenant's control connection. On a primary it is the single writer; on a replica it is a
   * `query_only` connection that exists so the realtime engine and the checkpoint verbs have
   * somewhere to attach — a replica's pages arrive through `applier`, never through SQL.
   */
  readonly writer: Database
  log: TxnLog
  /** Null on a replica: nothing here authors a transaction. */
  readonly recorder: TxnRecorder | null
  /** Null on a primary: set on a replica, where it is the only thing that moves the txid. */
  readonly applier: WalApplier | null
  readonly pageSize: number
  readonly quotaBytes: number
  readonly maxReaders: number
  readonly checkpointWalBytes: number
  readonly idleCheckpointMs: number
  readonly defaultAck: AckLevel
  readonly waitMs: number
  /** What the reconcile found when this tenant was opened. */
  readonly reconciled: ReconcileOutcome

  #options: TenantOptions
  #free: Database[] = []
  #openReaders = 0
  #leased = 0
  #listeners = new Set<CommitListener>()
  #waiters: Waiter[] = []
  #walFd: number | null = null
  #writing = false
  #txOpen = false
  #txAck: AckLevel = "local"
  #txIdleTimeoutMs = 0
  #txOnExpire: (() => void) | null = null
  #txTimer: ReturnType<typeof setTimeout> | null = null
  #exclusive = false
  #closed = false
  #lastActivityMs = Date.now()
  #maintainedAt = 0
  #lastSnapshotTxid: bigint | null
  #positionSavedMs = 0
  #positionDirty = false
  #positionIntervalMs: number
  /** Frames in the current WAL generation, from the WAL hook: `walBytes` without a syscall. */
  #walFrames = 0
  #walOpened = false

  private constructor(
    options: TenantOptions,
    writer: Database,
    log: TxnLog,
    recorder: TxnRecorder | null,
    applier: WalApplier | null,
    pageSize: number,
    reconciled: ReconcileOutcome,
  ) {
    this.name = options.name
    this.role = options.role ?? "primary"
    this.applier = applier
    this.dataDir = options.dataDir
    this.dir = options.dir
    this.dbPath = path.join(options.dir, "main.db")
    this.catalog = options.catalog
    this.writer = writer
    this.log = log
    this.recorder = recorder
    this.pageSize = pageSize
    this.quotaBytes = options.quotaBytes ?? 0
    this.maxReaders = options.readers ?? 2
    this.checkpointWalBytes = options.checkpointWalBytes ?? 4_000_000
    this.idleCheckpointMs = options.idleCheckpointMs ?? 1000
    this.defaultAck = options.defaultAck ?? "local"
    this.waitMs = options.waitMs ?? 2000
    this.#positionIntervalMs = options.positionIntervalMs ?? 200
    this.reconciled = reconciled
    this.#options = options
    this.#lastSnapshotTxid = options.catalog.lastSnapshotTxid(options.name)
  }

  /**
   * Opens the database, resumes the recorder from the catalog and reconciles the three sources
   * of truth (design §4.3). Every path here is synchronous: opening a tenant must be cheap
   * enough that an LRU miss is not worth avoiding.
   */
  static open(options: TenantOptions): Tenant {
    fs.mkdirSync(options.dir, { recursive: true })
    const dbPath = path.join(options.dir, "main.db")
    const replica = (options.role ?? "primary") === "replica"
    // A replica's pages arrive as WAL frames the applier writes by hand, and SQLite ignores a
    // `-wal` unless the database header says the file is in WAL mode. A database that does not
    // exist yet therefore has to be created before the first record can land in it.
    if (replica && !hasPages(dbPath)) createEmptyDatabase(dbPath, options.pageSize ?? 4096)
    const log = TxnLog.open({
      dir: options.dir,
      ...(options.segmentBytes !== undefined ? { segmentBytes: options.segmentBytes } : {}),
      fsync: options.logFsync ?? "interval",
    })

    try {
      const { recorder, applier, outcome } = replica
        ? openApplier(options, dbPath)
        : openRecorder(options, dbPath, log)
      const writer = openConnection(dbPath, options, { writer: !replica })
      let pageSize = options.pageSize ?? 4096
      try {
        pageSize = Number(writer.prepare("pragma page_size").get()?.page_size ?? pageSize)
        if (!replica) applyQuota(writer, options.quotaBytes ?? 0, pageSize)
        const tenant = new Tenant(options, writer, log, recorder, applier, pageSize, outcome)
        // Installing a WAL hook is also what turns SQLite's own autocheckpoint off (design §4.1);
        // `wal_autocheckpoint = 0` above says the same thing twice, on purpose.
        if (!replica) tenant.trackWal()
        return tenant
      } catch (err) {
        writer.close()
        throw err
      }
    } catch (err) {
      log.close()
      throw err
    }
  }

  /** True when this node follows the database rather than owning its write path. */
  get isReplica(): boolean {
    return this.role === "replica"
  }

  /** Throws `NOT_PRIMARY` on a replica; every write verb calls it first. */
  #assertPrimary(): void {
    if (this.role !== "replica") return
    throw new TenantError(
      "NOT_PRIMARY",
      `${this.name} is a replica of another node; writes go to the primary`,
    )
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────────

  /** Last txid this tenant has recorded (a primary) or applied (a replica). */
  get txid(): bigint {
    return this.position.txid
  }

  get epoch(): number {
    return this.recorder ? this.recorder.epoch : this.position.epoch
  }

  get checksum(): bigint {
    return this.position.checksum
  }

  /**
   * A replica has no WAL position of its own worth saving: its `-wal` is written by the applier
   * with local salts, so the zeroed marker is the honest answer and is also what a reopen wants.
   */
  get position(): RecorderPosition {
    if (this.recorder) return this.recorder.position
    const applied = (this.applier as WalApplier).position
    return {
      txid: applied.txid,
      epoch: applied.epoch,
      checksum: applied.postChecksum,
      dbSizePages: applied.dbSizePages,
      wal: { salt1: 0, salt2: 0, frame: 0 },
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  /** True while a write, a read lease or a snapshot is in flight; the registry never evicts then. */
  get busy(): boolean {
    return (
      this.#writing ||
      this.#txOpen ||
      this.#exclusive ||
      this.#leased > 0 ||
      this.#waiters.length > 0
    )
  }

  get walBytes(): number {
    try {
      return fs.statSync(`${this.dbPath}-wal`).size
    } catch {
      return 0
    }
  }

  get sizeBytes(): number {
    try {
      return fs.statSync(this.dbPath).size
    } catch {
      return 0
    }
  }

  stats(): TenantStats {
    const position = this.position
    return {
      name: this.name,
      role: this.role,
      sizeBytes: this.sizeBytes,
      walBytes: this.walBytes,
      txid: position.txid,
      epoch: position.epoch,
      checksum: position.checksum,
      openReaders: this.#openReaders,
      logBytes: this.log.bytes,
      lastSnapshotTxid: this.#lastSnapshotTxid,
    }
  }

  /** Subscribes to durable commits. Returns the unsubscribe function. */
  onCommit(listener: CommitListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // ── write path (design §4.3) ─────────────────────────────────────────────────────────────────

  /**
   * Runs `fn` inside `BEGIN IMMEDIATE` … `COMMIT` on the single writer, turns the committed WAL
   * frames into a record, appends it to the log and saves the position. The txid returned is the
   * one the transaction was assigned, or the tenant's current txid when it wrote nothing.
   */
  write<T>(fn: (db: Database) => T, options: WriteOptions = {}): WriteResult<T> {
    this.#assertOpen()
    this.#assertPrimary()
    if (this.#txOpen) throw txBusy(this.name)
    if (this.#writing) {
      throw new TenantError("WRITE_IN_PROGRESS", `a write is already running on ${this.name}`)
    }
    if (this.#exclusive) {
      throw BunQLError.busy(`${this.name} is taking a snapshot`)
    }
    const ack = options.ack ?? this.defaultAck
    this.#writing = true
    this.#lastActivityMs = Date.now()
    try {
      let result: T
      try {
        result = this.writer.transaction(fn, "immediate")(this.writer)
      } catch (err) {
        throw translateWriteError(err, this.name)
      }
      const txid = this.#capture()
      if (ack === "fsync") this.#syncDurable()
      this.#maybeCheckpoint()
      return { result, txid }
    } finally {
      this.#writing = false
      this.#lastActivityMs = Date.now()
    }
  }

  // ── interactive transactions (design §6.3, §7) ───────────────────────────────────────────────
  //
  // A baton transaction is `write()` taken apart: the same BEGIN IMMEDIATE, the same post-commit
  // path, but with the statements arriving over several requests. It holds the tenant's only
  // writer for as long as it is open, which is why there is at most one and why it is leashed by
  // an idle timer rather than by the client's goodwill.

  /** True while an interactive transaction holds the writer. */
  get txOpen(): boolean {
    return this.#txOpen
  }

  /**
   * Takes the writer with `BEGIN <mode>`. Throws `TX_BUSY` when anything else already holds it.
   * The idle timer rolls the transaction back and calls `onExpire` if no statement arrives for
   * `idleTimeoutMs`; every `txExec` restarts it.
   */
  txBegin(options: TxBeginOptions = {}): void {
    this.#assertOpen()
    this.#assertPrimary()
    if (this.#txOpen || this.#writing) throw txBusy(this.name)
    if (this.#exclusive) throw BunQLError.busy(`${this.name} is taking a snapshot`)
    const mode = options.mode ?? "immediate"
    try {
      this.writer.exec(
        mode === "deferred" ? "begin" : mode === "exclusive" ? "begin exclusive" : "begin immediate",
      )
    } catch (err) {
      throw translateWriteError(err, this.name)
    }
    this.#txOpen = true
    this.#txAck = options.ack ?? this.defaultAck
    this.#txIdleTimeoutMs = options.idleTimeoutMs ?? 0
    this.#txOnExpire = options.onExpire ?? null
    this.#lastActivityMs = Date.now()
    this.#armTxTimer()
  }

  /** Runs one statement inside the open transaction and restarts its idle timer. */
  txExec<T>(fn: (db: Database) => T): T {
    this.#assertOpen()
    if (!this.#txOpen) throw noTx(this.name)
    this.#lastActivityMs = Date.now()
    this.#armTxTimer()
    try {
      return fn(this.writer)
    } catch (err) {
      throw translateWriteError(err, this.name)
    }
  }

  /**
   * `COMMIT`, then the same steps `write()` runs afterwards: tail, append, save, publish,
   * checkpoint. Returns the txid the transaction was assigned, or the current one when it wrote
   * nothing. A failed COMMIT rolls back, so the writer is free either way.
   */
  txCommit(options: WriteOptions = {}): bigint {
    this.#assertOpen()
    this.#assertPrimary()
    if (!this.#txOpen) throw noTx(this.name)
    const ack = options.ack ?? this.#txAck
    this.#clearTxTimer()
    try {
      try {
        this.writer.exec("commit")
      } catch (err) {
        if (this.writer.inTransaction) this.writer.exec("rollback")
        throw translateWriteError(err, this.name)
      }
      const txid = this.#capture()
      if (ack === "fsync") this.#syncDurable()
      this.#maybeCheckpoint()
      return txid
    } finally {
      this.#endTx()
    }
  }

  /** `ROLLBACK`. Safe to call on a transaction SQLite has already rolled back itself. */
  txRollback(): void {
    if (!this.#txOpen) return
    this.#clearTxTimer()
    try {
      if (!this.#closed && this.writer.inTransaction) this.writer.exec("rollback")
    } catch (err) {
      this.#options.onError?.(err)
    } finally {
      this.#endTx()
    }
  }

  #armTxTimer(): void {
    this.#clearTxTimer()
    if (this.#txIdleTimeoutMs <= 0) return
    this.#txTimer = setTimeout(() => {
      this.#txTimer = null
      const onExpire = this.#txOnExpire
      this.txRollback()
      onExpire?.()
    }, this.#txIdleTimeoutMs)
    this.#txTimer.unref?.()
  }

  #clearTxTimer(): void {
    if (this.#txTimer === null) return
    clearTimeout(this.#txTimer)
    this.#txTimer = null
  }

  #endTx(): void {
    this.#txOpen = false
    this.#txOnExpire = null
    this.#lastActivityMs = Date.now()
  }

  /**
   * Reads through a pooled connection. Async because `minTxid` can only be waited for by
   * yielding; `readSync` is the same path without the microtask when no wait is possible.
   */
  async read<T>(fn: (db: Database) => T, options: ReadOptions = {}): Promise<T> {
    this.#assertOpen()
    const minTxid = options.minTxid
    if (minTxid !== undefined && minTxid > this.txid) {
      await this.waitFor(minTxid, options.waitMs ?? this.waitMs)
    }
    return this.readSync(fn)
  }

  /** The synchronous read path. Throws `TXID_NOT_AVAILABLE` at once when `minTxid` is ahead. */
  readSync<T>(fn: (db: Database) => T, options: { minTxid?: bigint } = {}): T {
    this.#assertOpen()
    const minTxid = options.minTxid
    if (minTxid !== undefined && minTxid > this.txid) {
      throw BunQLError.txidNotAvailable(Number(minTxid), Number(this.txid))
    }
    const lease = this.acquireReader()
    try {
      return fn(lease.db)
    } finally {
      this.releaseReader(lease)
    }
  }

  /**
   * Resolves once the tenant reaches `txid`, or rejects with `TXID_NOT_AVAILABLE` after `waitMs`.
   * On a single node only a concurrent write can satisfy this; on a replica it is the stream.
   */
  waitFor(txid: bigint, waitMs = this.waitMs): Promise<void> {
    if (txid <= this.txid) return Promise.resolve()
    if (this.#closed) return Promise.reject(new TenantError("CLOSED", `${this.name} is closed`))
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        txid,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#drop(waiter)
          reject(BunQLError.txidNotAvailable(Number(txid), Number(this.txid)))
        }, waitMs),
      }
      this.#waiters.push(waiter)
    })
  }

  /**
   * Borrows a reader. The lease is what keeps a TRUNCATE checkpoint or a snapshot from taking the
   * exclusive WAL locks underneath an open read transaction (design §4.5).
   */
  acquireReader(): ReaderLease {
    this.#assertOpen()
    this.#lastActivityMs = Date.now()
    const pooled = this.#free.pop()
    if (pooled) {
      this.#leased += 1
      return { db: pooled, pooled: true }
    }
    if (this.#openReaders < this.maxReaders) {
      const db = openConnection(this.dbPath, this.#options, { writer: false })
      this.#openReaders += 1
      this.#leased += 1
      return { db, pooled: true }
    }
    // Overflow: a burst of concurrent reads opens a connection that is closed on release rather
    // than failing the read. ~17 µs (design §2.4), and the pool size is back to normal after it.
    this.#leased += 1
    return { db: openConnection(this.dbPath, this.#options, { writer: false }), pooled: false }
  }

  releaseReader(lease: ReaderLease): void {
    this.#leased -= 1
    this.#lastActivityMs = Date.now()
    if (!lease.pooled || this.#closed) {
      lease.db.close()
      if (lease.pooled) this.#openReaders -= 1
      return
    }
    this.#free.push(lease.db)
  }

  // ── checkpoints (design §4.3) ────────────────────────────────────────────────────────────────

  /** Manual checkpoint, the `POST /v1/db/{db}/checkpoint` of design §6.5. */
  checkpoint(mode: CheckpointMode = "PASSIVE"): CheckpointResult {
    this.#assertOpen()
    if (this.isReplica) {
      // A replica's WAL belongs to the applier, which rewrites its header and its checksum chain
      // on every apply. An operator TRUNCATE between two applies would leave the applier pointing
      // at a generation that is gone; the idle sweep in `maintain` does it safely instead.
      if (mode === "TRUNCATE" || mode === "RESTART") {
        throw new TenantError(
          "NOT_PRIMARY",
          `${this.name} is a replica; its WAL is checkpointed by the applier`,
        )
      }
      if (this.#leased > 0) throw BunQLError.busy(`a reader on ${this.name} holds a transaction`)
      const result = (this.applier as WalApplier).checkpoint(mode)
      this.#lastActivityMs = Date.now()
      return result
    }
    if (mode !== "PASSIVE" && this.#leased > 0) {
      throw BunQLError.busy(`a reader on ${this.name} holds a transaction`)
    }
    this.drain()
    this.#openWal()
    const result = this.writer.walCheckpoint(mode)
    this.#afterCheckpoint()
    this.#lastActivityMs = Date.now()
    return result
  }

  /**
   * The idle half of the policy: TRUNCATE once nothing has happened for `idleCheckpointMs` and no
   * reader holds a lease. The registry calls this from one interval for every open tenant.
   */
  maintain(now = Date.now()): void {
    if (this.#closed || this.busy) return
    if (this.#maintainedAt === this.#lastActivityMs) return
    if (now - this.#lastActivityMs < this.idleCheckpointMs) return
    this.#maintainedAt = this.#lastActivityMs
    if (this.walBytes <= WAL_HEADER_SIZE) return
    if (this.isReplica) {
      // Mechanism B (design §4.5) appends to the replica's own WAL on every apply and resets
      // `nBackfill`, so without this the readers pay a full WAL rescan that only ever grows.
      ;(this.applier as WalApplier).checkpoint("TRUNCATE")
      return
    }
    // Nothing may leave the WAL before it is recorded; draining first is what guarantees it.
    this.drain()
    this.#openWal()
    this.writer.walCheckpoint("TRUNCATE")
    this.#afterCheckpoint()
  }

  // ── snapshots and forks (design §4.4) ────────────────────────────────────────────────────────

  /**
   * Checkpoints everything into the database file and copies it to `snapshots/<txid>.db`
   * (a reflink where the filesystem has one). Taking a second snapshot at the same txid returns
   * the first: the file is already the database at that txid.
   */
  async snapshot(): Promise<SnapshotRef> {
    this.#assertOpen()
    if (this.#leased > 0) {
      throw BunQLError.busy(`a reader on ${this.name} holds a transaction`)
    }
    if (this.#exclusive) throw BunQLError.busy(`${this.name} is already snapshotting`)
    this.#exclusive = true
    try {
      this.drain()
      this.#openWal()
      const txid = this.position.txid
      const existing = listSnapshots(this.dir).find((ref) => BigInt(ref.txid) === txid)
      if (existing) return existing
      const ref = await snapshot(
        { db: this.writer, dbPath: this.dbPath, dir: this.dir },
        txid,
        { epoch: this.epoch },
      )
      this.catalog.recordSnapshot(this.name, txid, ref.path)
      this.#lastSnapshotTxid = txid
      // The snapshot's TRUNCATE checkpoint emptied the WAL, which is a position worth recording.
      this.#afterCheckpoint()
      return ref
    } finally {
      this.#exclusive = false
      this.#lastActivityMs = Date.now()
    }
  }

  /**
   * Branches this database into a new tenant (design §4.4, "fork/branch = snapshot reflink + new
   * tenant + fresh log"). With `at`, the fork is the database as of that txid, rebuilt from the
   * newest snapshot at or before it plus the log; without, it is the database as it stands now.
   *
   * Returns the new tenant's catalog row; the registry opens it.
   */
  async fork(newName: string, at?: bigint): Promise<{ name: string; dir: string; txid: bigint }> {
    this.#assertOpen()
    assertValidName(newName)
    if (this.catalog.getTenant(newName)) {
      throw new TenantError("DB_EXISTS", `database ${newName} already exists`)
    }
    if (at !== undefined && at > this.txid) {
      throw BunQLError.badRequest(
        `cannot fork ${this.name} at txid ${at}: it is at ${this.txid}`,
      )
    }
    const target = tenantDir(this.dataDir, newName)
    if (fs.existsSync(path.join(target, "main.db"))) {
      throw new TenantError("DB_EXISTS", `${target} already holds a database`)
    }
    // Without `at` the fork is this database as it stands, which is exactly what a snapshot is.
    const source = at === undefined ? await this.snapshot() : null
    const txid = at ?? BigInt((source as SnapshotRef).txid)

    this.#exclusive = true
    try {
      fs.mkdirSync(target, { recursive: true })
      const targetPath = path.join(target, "main.db")
      if (at === undefined) {
        await copyFile((source as SnapshotRef).path, targetPath)
      } else {
        await this.#restoreInto(target, at)
      }

      // `restore` leaves the applier's frames in the new `-wal`; they are already counted in the
      // checksum below, so a fresh recorder tailing them would count them twice.
      foldWal(targetPath)
      fs.rmSync(path.join(target, "meta.json"), { force: true })

      const full = computeFull(targetPath, { includeWal: false })
      this.catalog.createTenant({
        name: newName,
        pageSize: full.pageSize || this.pageSize,
        quotaBytes: this.quotaBytes,
        epoch: this.epoch,
        position: {
          txid,
          checksum: full.checksum,
          dbSizePages: full.pages,
          wal: { salt1: 0, salt2: 0, frame: 0 },
        },
      })
      return { name: newName, dir: target, txid }
    } finally {
      this.#exclusive = false
    }
  }

  /** Rebuilds this database as of `at` into `dir`, from a snapshot plus log records. */
  async #restoreInto(dir: string, at: bigint): Promise<void> {
    this.drain()
    const snapshots = listSnapshots(this.dir).filter((s) => BigInt(s.txid) <= at)
    if (snapshots.length > 0) {
      await restore({ dir: this.dir, at, into: dir })
      return
    }
    // No snapshot that old. The log can still rebuild the database from nothing when it reaches
    // back to the first transaction, which is the common case for a young tenant.
    const first = this.log.firstTxid
    if (first === null || first > 1n) {
      throw new TenantError(
        "NO_SNAPSHOT",
        `cannot fork ${this.name} at txid ${at}: no snapshot at or before it and the log starts at ${first ?? "nothing"}`,
      )
    }
    const targetPath = path.join(dir, "main.db")
    createEmptyDatabase(targetPath, this.pageSize)
    const applier = new WalApplier({ dbPath: targetPath, dir, fsync: "rename" })
    try {
      applier.seed({
        txid: 0n,
        epoch: this.epoch,
        postChecksum: 0n,
        dbSizePages: 0,
        pageSize: this.pageSize,
      })
      for (const record of this.log.iterate(1n)) {
        if (record.txid > at) break
        applier.apply(record)
      }
    } finally {
      applier.close()
    }
  }

  // ── replica apply (design §4.5, §5.2) ────────────────────────────────────────────────────────

  /**
   * Applies one record from the primary. The order mirrors the write path's — verify and write,
   * then log, then save the position, then publish — so a replica that crashes mid-apply comes
   * back with a position the applier can prove, never one it merely claimed.
   *
   * `bytes` is the record exactly as it arrived; passing it avoids re-compressing the pages just
   * to file the record in this node's own log. Throws `PositionMismatch` for a record that does
   * not follow, and `ChecksumMismatch` when the replica's own pre-images disagree with the
   * primary's — both leaving the replica untouched, both meaning "send me a snapshot".
   */
  applyRecord(record: TxnRecord, bytes?: Uint8Array): void {
    this.#assertOpen()
    if (!this.isReplica) {
      throw new TenantError("NOT_REPLICA", `${this.name} is a primary; it records its own writes`)
    }
    if (this.#exclusive) {
      throw new TenantError("BUSY", `${this.name} is taking a snapshot`)
    }
    const applier = this.applier as WalApplier
    applier.apply(record)
    const encoded = bytes ?? encode(record)
    this.#appendReplicated(encoded, record.txid)
    // The applier's own `meta.json` is the durable position and is already fsynced by `apply`;
    // the catalog copy is a fast-start hint, so it is throttled exactly as the primary's is.
    this.#positionDirty = true
    this.#savePosition(Date.now())
    this.#publish({ txid: record.txid, record, bytes: encoded })
    this.#wake(record.txid)
    this.#lastActivityMs = Date.now()
  }

  /**
   * Files a replicated record in this node's own log, so it can serve a downstream replica and so
   * `restore --at` works locally. The log is written *after* the applier has persisted its
   * position, so it can only ever be behind; a gap means the tail was lost to a crash, and a log
   * with a hole cannot be replayed at all, so it is restarted from this record.
   */
  #appendReplicated(bytes: Uint8Array, txid: bigint): void {
    const last = this.log.lastTxid
    if (last !== 0n && last + 1n !== txid) this.#resetLog()
    try {
      this.log.appendEncoded(bytes)
    } catch (err) {
      if (!(err instanceof WalFormatError)) throw err
      this.#resetLog()
      this.log.appendEncoded(bytes)
    }
  }

  /** Drops every segment and reopens the log empty. The next append starts a fresh segment. */
  #resetLog(): void {
    this.log.close()
    fs.rmSync(path.join(this.dir, "log"), { recursive: true, force: true })
    this.log = TxnLog.open({
      dir: this.dir,
      ...(this.#options.segmentBytes !== undefined
        ? { segmentBytes: this.#options.segmentBytes }
        : {}),
      fsync: this.#options.logFsync ?? "interval",
    })
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  /** Flushes, saves the position and marks the tenant cleanly closed. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new TenantError("CLOSED", `${this.name} was closed while waiting for a txid`))
    }
    this.#waiters = []
    if (this.#txOpen) {
      this.#clearTxTimer()
      try {
        if (this.writer.inTransaction) this.writer.exec("rollback")
      } catch {
        // Closing must not throw; an uncommitted transaction leaves nothing behind anyway.
      }
      this.#txOpen = false
      this.#txOnExpire = null
    }
    try {
      this.#capture()
      // Fold the WAL into the database file. Resuming a tailer costs two verification passes
      // over the WAL, so leaving an empty one behind is what keeps a cold open cheap — and the
      // backfill is work SQLite would have had to do later anyway.
      if (this.#leased === 0 && this.walBytes > WAL_HEADER_SIZE) {
        if (this.isReplica) {
          ;(this.applier as WalApplier).checkpoint("TRUNCATE")
        } else {
          this.#openWal()
          this.writer.walCheckpoint("TRUNCATE")
        }
        this.#walFrames = 0
      }
    } catch {
      // Closing must not throw: whatever could not be captured is still in the WAL and the next
      // open reconciles it.
    }
    this.log.flush()
    if (!this.catalog.closed) {
      const position = this.position
      const wal =
        this.walBytes <= WAL_HEADER_SIZE ? { salt1: 0, salt2: 0, frame: 0 } : position.wal
      this.catalog.savePosition(this.name, { ...position, wal }, true)
    }
    this.log.close()
    this.recorder?.close()
    this.applier?.close()
    for (const reader of this.#free) reader.close()
    this.#free = []
    this.#openReaders = 0
    if (this.#walFd !== null) {
      fs.closeSync(this.#walFd)
      this.#walFd = null
    }
    this.writer.close()
  }

  /**
   * Drops the tenant's descriptors without flushing, saving the position or checkpointing — what
   * a process going down hard leaves behind. Everything not yet recorded stays in the WAL, and
   * the next open reconciles it (design §4.3). The crash-reconcile tests use this; production
   * code wants `close()`.
   */
  abandon(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new TenantError("CLOSED", `${this.name} was abandoned while waiting`))
    }
    this.#waiters = []
    this.#clearTxTimer()
    this.#txOpen = false
    this.#txOnExpire = null
    this.log.close()
    this.recorder?.close()
    this.applier?.close()
    for (const reader of this.#free) reader.close()
    this.#free = []
    this.#openReaders = 0
    if (this.#walFd !== null) {
      fs.closeSync(this.#walFd)
      this.#walFd = null
    }
    this.writer.close()
  }

  /**
   * Closes the tenant and moves its directory to `<dataDir>/trash/<name>-<ms>`; the catalog row
   * is tombstoned. Design §6.5 keeps the log and snapshots after a delete, so nothing is removed
   * here — sweeping the trash is an operator decision.
   */
  delete(): string {
    const trash = path.join(this.dataDir, "trash", `${this.name}-${Date.now()}`)
    this.close()
    fs.mkdirSync(path.dirname(trash), { recursive: true })
    fs.renameSync(this.dir, trash)
    this.catalog.deleteTenant(this.name)
    return trash
  }

  /**
   * Tails anything that has committed but is not in the log yet, appends it and saves the
   * position. The write path does this itself; snapshots and checkpoints call it to guarantee
   * that no frame leaves the WAL before it has been recorded.
   */
  drain(): bigint {
    return this.#capture()
  }

  // -------------------------------------------------------------------------

  /** Steps 2–5 of design §4.3. Returns the tenant's txid afterwards. A replica records nothing. */
  #capture(): bigint {
    const recorder = this.recorder
    if (!recorder) return this.position.txid
    const records = recorder.poll()
    if (records.length === 0) return recorder.position.txid

    const events: CommitEvent[] = []
    for (const record of records) {
      const bytes = this.log.append(record)
      events.push({ txid: record.txid, record, bytes })
    }
    const position = recorder.position
    this.#positionDirty = true
    this.#savePosition(Date.now())
    for (const event of events) this.#publish(event)
    this.#wake(position.txid)
    return position.txid
  }

  /**
   * Writes the position to the catalog at most every `positionIntervalMs` while writing. A
   * commit that does not refresh it is not at risk: the reconcile takes the position from the
   * log's last record, which is always at least as new as the catalog's.
   */
  #savePosition(now: number, force = false): void {
    if (!this.#positionDirty && !force) return
    if (!force && now - this.#positionSavedMs < this.#positionIntervalMs) return
    if (this.catalog.closed) return
    this.catalog.savePosition(this.name, this.position)
    this.#positionDirty = false
    this.#positionSavedMs = now
  }

  /**
   * One read, the first time this connection is about to checkpoint. A checkpoint on a connection
   * whose pager has never opened the WAL does nothing at all, and reports that it did nothing in
   * counters that cannot be told apart from an empty WAL. Doing it here rather than at open keeps
   * the cost off the open path, where it measured 1.8 ms a tenant.
   */
  #openWal(): void {
    if (this.#walOpened) return
    this.#walOpened = true
    this.writer.prepare("select 1 from sqlite_schema limit 1").get()
  }

  /** True once the WAL hook has fired, which only a real WAL commit can do. */

  /** Counts WAL frames as they commit, so the checkpoint policy costs no `stat` per write. */
  trackWal(): void {
    this.writer.onWal((_dbName, frames) => {
      this.#walFrames = frames
      // A WAL commit proves this connection's pager has the WAL open, so no probe read is needed.
      this.#walOpened = true
    })
  }

  #publish(event: CommitEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (err) {
        const onError = this.#options.onError
        if (onError) onError(err)
        else console.error(`bunql: commit hook for ${this.name} threw`, err)
      }
    }
  }

  #wake(txid: bigint): void {
    if (this.#waiters.length === 0) return
    const remaining: Waiter[] = []
    for (const waiter of this.#waiters) {
      if (waiter.txid <= txid) {
        clearTimeout(waiter.timer)
        waiter.resolve()
      } else {
        remaining.push(waiter)
      }
    }
    this.#waiters = remaining
  }

  #drop(waiter: Waiter): void {
    const at = this.#waiters.indexOf(waiter)
    if (at >= 0) this.#waiters.splice(at, 1)
  }

  /**
   * `ack: "fsync"` (design §5.4). `synchronous=NORMAL` leaves the WAL unsynced at commit, so the
   * durability this level promises is an explicit `fdatasync` of the WAL descriptor plus the log.
   * The unix VFS does not answer `SQLITE_FCNTL_SYNC` from `sqlite3_file_control` — it is a
   * pager-internal opcode — and switching `synchronous` per commit costs two extra statements.
   */
  #syncDurable(): void {
    this.log.flush()
    const walPath = `${this.dbPath}-wal`
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#walFd === null) {
        try {
          this.#walFd = fs.openSync(walPath, "r+")
        } catch {
          return // No WAL on disk: nothing committed through it yet.
        }
      }
      try {
        fs.fdatasyncSync(this.#walFd)
        return
      } catch {
        // A TRUNCATE checkpoint can replace the file underneath the descriptor; reopen once.
        fs.closeSync(this.#walFd)
        this.#walFd = null
      }
    }
  }

  /** The size half of the policy: PASSIVE once the WAL is large and everything in it is logged. */
  #maybeCheckpoint(): void {
    const walBytes = WAL_HEADER_SIZE + this.#walFrames * (24 + this.pageSize)
    if (walBytes <= this.checkpointWalBytes) return
    // The write path has just drained, so every committed frame is already in the log — the
    // precondition design §4.3 puts on checkpointing ("the log has shipped past mxFrame").
    this.#openWal()
    this.writer.walCheckpoint("PASSIVE")
    this.#afterCheckpoint()
  }

  /**
   * A checkpoint that emptied the WAL makes the database file the whole state at the current
   * txid. That is worth recording, because a zeroed WAL position is the one position an open can
   * trust without re-hashing the database: it says "the file alone is this txid", so the frames
   * a later generation holds are new transactions and the file is their pre-image.
   */
  #afterCheckpoint(): void {
    this.#walFrames = 0
    if (this.walBytes > WAL_HEADER_SIZE) {
      this.#savePosition(Date.now(), true)
      return
    }
    const position = this.position
    this.catalog.savePosition(this.name, {
      ...position,
      wal: { salt1: 0, salt2: 0, frame: 0 },
    })
    this.#positionDirty = false
    this.#positionSavedMs = Date.now()
  }

  #assertOpen(): void {
    if (this.#closed) throw new TenantError("CLOSED", `database ${this.name} is closed`)
  }
}

// ── opening ────────────────────────────────────────────────────────────────────────────────────

function openConnection(
  dbPath: string,
  options: TenantOptions,
  role: { writer: boolean },
): Database {
  const db = Database.open(dbPath, {
    busyTimeoutMs: options.busyTimeoutMs ?? 5000,
    wal: false,
  })
  try {
    if (role.writer) {
      if (options.pageSize && !hasPages(dbPath)) db.exec(`pragma page_size = ${options.pageSize}`)
      db.exec("pragma journal_mode = wal")
      db.exec("pragma synchronous = normal")
      // We own checkpoints (design §4.3): without this the tailer could lose frames.
      db.exec("pragma wal_autocheckpoint = 0")
      // Keep the WAL file across the last close, so a crash reconcile still has its frames and a
      // reopen does not pay for recreating it.
      db.fileControl("SQLITE_FCNTL_PERSIST_WAL", new Int32Array([1]))
    }
    const limits = { ...DEFAULT_LIMITS, ...options.limits }
    for (const [name, value] of Object.entries(limits)) {
      if (value !== undefined) db.limit(name as LimitName, value)
    }
    options.onConnection?.(db, role.writer ? "writer" : "reader")
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

function hasPages(dbPath: string): boolean {
  try {
    return fs.statSync(dbPath).size > 0
  } catch {
    return false
  }
}

/** Design §4.7: the storage quota is `max_page_count`, enforced by SQLite itself. */
function applyQuota(db: Database, quotaBytes: number, pageSize: number): void {
  if (quotaBytes <= 0) return
  const pages = Math.max(1, Math.floor(quotaBytes / pageSize))
  db.exec(`pragma max_page_count = ${pages}`)
}

/**
 * Moves everything in a database's WAL into the database file and leaves the WAL empty. The read
 * comes first because a checkpoint on a connection whose pager has not opened the WAL does
 * nothing at all, and the size check afterwards is what proves it did.
 */
function foldWal(dbPath: string): void {
  const db = Database.open(dbPath, { wal: false })
  try {
    db.exec("pragma journal_mode = wal")
    db.prepare("select 1 from sqlite_schema limit 1").get()
    const result = db.walCheckpoint("TRUNCATE")
    if (result.busy) {
      throw new TenantError("BUSY", `checkpoint of ${dbPath} was blocked by another connection`)
    }
  } finally {
    db.close()
  }
  const walPath = `${dbPath}-wal`
  const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  if (walBytes > WAL_HEADER_SIZE) {
    throw new TenantError(
      "CHECKPOINT_INCOMPLETE",
      `${walBytes} bytes of WAL survived the checkpoint of ${dbPath}`,
    )
  }
}

/**
 * A database with nothing in it but a header, in WAL mode. A zero-length file would not do: with
 * no header SQLite cannot know the file is in WAL mode, so it would ignore the `-wal` an applier
 * writes. The single header page is not part of any record — a fresh tenant's database has one
 * too, which is why records start from a checksum of zero over zero pages.
 */
function createEmptyDatabase(dbPath: string, pageSize: number): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  fs.rmSync(dbPath, { force: true })
  fs.rmSync(`${dbPath}-wal`, { force: true })
  fs.rmSync(`${dbPath}-shm`, { force: true })
  const db = Database.open(dbPath, { wal: false })
  try {
    db.exec(`pragma page_size = ${pageSize}`)
    db.exec("pragma journal_mode = wal")
  } finally {
    db.close()
  }
}

async function copyFile(from: string, to: string): Promise<void> {
  try {
    await Bun.write(to, Bun.file(from))
  } catch {
    fs.copyFileSync(from, to)
  }
}

/** Design §6.3: the tenant has one writer, so a second interactive transaction has to wait. */
function txBusy(name: string): BunQLError {
  return new BunQLError("TX_BUSY", `${name} already has an open transaction`, 409)
}

function noTx(name: string): BunQLError {
  return new BunQLError("TX_NOT_FOUND", `${name} has no open transaction`, 404)
}

/** SQLite's out-of-space code is the tenant's quota (design §4.7, §6.6). */
function translateWriteError(err: unknown, name: string): unknown {
  if (err instanceof SqliteError && err.code.startsWith("SQLITE_FULL")) {
    return BunQLError.quotaExceeded(`database ${name} has reached its storage quota`)
  }
  return err
}

interface RecorderOpen {
  recorder: TxnRecorder | null
  applier: WalApplier | null
  outcome: ReconcileOutcome
}

/**
 * The replica half of `openRecorder`: no tailer, no reconcile against a WAL this node wrote, just
 * the applier seeded from the catalog. The applier keeps its own `meta.json` and treats it as
 * authoritative; the catalog position is passed only so a directory restored from somewhere else
 * (a snapshot installed by the replication client) starts where that snapshot ended.
 */
function openApplier(options: TenantOptions, dbPath: string): RecorderOpen {
  const saved =
    options.position ??
    (() => {
      const row = options.catalog.getTenant(options.name, { includeDeleted: true })
      return row ? positionOf(row) : null
    })()
  const applier = new WalApplier({ dbPath, dir: options.dir, fsync: "each" })
  const local = applier.position
  // With no `meta.json` the applier has inferred its state from the file, and the file is not the
  // position: a database SQLite has only ever opened holds a header page that belongs to no
  // transaction, so a fresh replica stands at "0 pages, checksum 0" exactly as a fresh primary
  // does. The catalog is authoritative in that case, and whenever it is ahead.
  const fresh = !fs.existsSync(applier.metaPath)
  if (saved && (fresh || saved.txid > local.txid)) {
    applier.seed({
      txid: saved.txid,
      epoch: options.epoch ?? saved.epoch,
      postChecksum: saved.checksum,
      dbSizePages: saved.dbSizePages,
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    })
  }
  return { recorder: null, applier, outcome: "clean" }
}

/**
 * Design §4.3's crash recovery, which is "the replica applier pointed at itself" plus the
 * tailer's own resume. Three sources disagree after a crash: the catalog position (written last,
 * so it can only lag), the log (self-verifying, each record carrying the WAL position it was
 * tailed from) and the database with its WAL (authoritative for data).
 */
function openRecorder(options: TenantOptions, dbPath: string, log: TxnLog): RecorderOpen {
  const saved =
    options.position ??
    (() => {
      const row = options.catalog.getTenant(options.name, { includeDeleted: true })
      return row ? positionOf(row) : null
    })()
  const epoch = options.epoch ?? saved?.epoch ?? 0
  const lastTxid = log.lastTxid
  const lastRecord = lastTxid > 0n ? log.read(lastTxid) : null

  let base = saved
  if (lastRecord && (!base || base.txid !== lastRecord.txid)) {
    // The log leads when the crash fell between `append` and `savePosition`; it trails when its
    // torn tail was repaired away. Either way its last record is the position the WAL can be
    // re-read from, because the record carries the WAL position it was tailed at.
    base = {
      txid: lastRecord.txid,
      epoch: lastRecord.epoch,
      checksum: lastRecord.postChecksum,
      dbSizePages: lastRecord.commitSizePages,
      wal: {
        salt1: lastRecord.walSalt1,
        salt2: lastRecord.walSalt2,
        frame: lastRecord.walEndFrame,
      },
    }
  }

  if (!base || base.txid === 0n) {
    return { recorder: TxnRecorder.open({ dbPath, epoch }), applier: null, outcome: "clean" }
  }

  /** A zeroed WAL position is the marker a TRUNCATE checkpoint leaves: the file is the state. */
  const fileIsState = base.wal.frame === 0 && base.wal.salt1 === 0 && base.wal.salt2 === 0

  let recorder: TxnRecorder | null = null
  try {
    recorder = TxnRecorder.open({
      dbPath,
      epoch,
      txid: base.txid,
      checksum: base.checksum,
      dbSizePages: base.dbSizePages,
      walPosition: base.wal,
    })
  } catch (err) {
    if (!(err instanceof WalFormatError)) throw err
    // The WAL no longer reaches the saved position: the database is behind the log and has to be
    // repaired from it before anything can be tailed.
    recorder = null
  }

  if (recorder) {
    // The position is provable when the tailer re-validated the chain up to it, and when the
    // marker says the database file alone is that state. Otherwise the WAL is a generation that
    // cannot be shown to continue the position, and the database has to say where it stands.
    const proven = recorder.walRestore === "resumed" || fileIsState
    if (!proven) {
      const full = computeFull(dbPath)
      if (full.checksum === base.checksum) {
        // The database is exactly at the position; whatever the WAL holds is already counted in
        // it. Restart the tailer at the WAL's current end so those frames are not read twice.
        recorder.close()
        const rewound = TxnRecorder.open({
          dbPath,
          epoch,
          txid: base.txid,
          checksum: base.checksum,
          dbSizePages: full.pages,
        })
        return { recorder: rewound, applier: null, outcome: "clean" }
      }
      if (lastRecord && full.checksum === lastRecord.preChecksum) {
        recorder.close()
        return {
          recorder: applyLastRecord(options, dbPath, lastRecord, full.pages, epoch),
          applier: null,
          outcome: "applied",
        }
      }
    }

    const before = recorder.position.txid
    let records: TxnRecordInput[]
    try {
      records = recorder.poll()
    } catch (err) {
      recorder.close()
      throw err
    }
    if (records.length === 0) return { recorder, applier: null, outcome: "clean" }

    // Transactions committed that never reached the log (design §4.3, "DB ahead of log"). They
    // were folded against pre-images from the WAL overlay and the database file; if either was
    // stale the rolling checksum will not match the database as it now stands, and shipping such
    // a record would diverge every replica that applied it.
    const full = computeFull(dbPath)
    if (full.checksum !== recorder.position.checksum) {
      recorder.close()
      throw new TenantError(
        "LOG_DIVERGED",
        `${options.name}: recovering ${records.length} transaction(s) after txid ${before} produced ` +
          `checksum ${recorder.position.checksum} but the database is at ${full.checksum}. ` +
          "The database was changed outside BunQL; restore it instead.",
      )
    }
    for (const record of records) log.append(record)
    log.flush()
    options.catalog.savePosition(options.name, recorder.position)
    return { recorder, applier: null, outcome: "tailed" }
  }

  if (!lastRecord) {
    throw new TenantError(
      "LOG_DIVERGED",
      `${options.name}: the WAL no longer reaches the saved position and the log is empty`,
    )
  }
  const full = computeFull(dbPath)
  if (full.checksum !== lastRecord.preChecksum) {
    throw new TenantError(
      "LOG_DIVERGED",
      `${options.name}: the database is at checksum ${full.checksum}, which is neither the last ` +
        `record's state (${lastRecord.postChecksum}) nor the state before it ` +
        `(${lastRecord.preChecksum}). Restore it instead.`,
    )
  }
  return {
    recorder: applyLastRecord(options, dbPath, lastRecord, full.pages, epoch),
    applier: null,
    outcome: "applied",
  }
}

/**
 * Design §4.3's "crash recovery on the primary is the replica applier pointed at itself": the log
 * holds a transaction the database does not, so it is applied to the database, and the recorder
 * then starts at the end of the WAL the applier just wrote.
 */
function applyLastRecord(
  options: TenantOptions,
  dbPath: string,
  record: TxnRecord,
  pages: number,
  epoch: number,
): TxnRecorder {
  const applier = new WalApplier({ dbPath, dir: options.dir, fsync: "each" })
  try {
    applier.seed({
      txid: record.prevTxid,
      epoch: record.epoch,
      postChecksum: record.preChecksum,
      dbSizePages: pages,
      pageSize: record.pageSize,
    })
    applier.apply(record)
  } catch (err) {
    applier.close()
    throw err instanceof WalError
      ? new TenantError("LOG_DIVERGED", `${options.name}: ${err.message}`)
      : err
  }
  applier.close()

  const repaired = TxnRecorder.open({
    dbPath,
    epoch,
    txid: record.txid,
    checksum: record.postChecksum,
    dbSizePages: record.commitSizePages,
  })
  options.catalog.savePosition(options.name, repaired.position)
  return repaired
}
