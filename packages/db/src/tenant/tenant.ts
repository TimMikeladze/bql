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
// Fourth invariant: `retain` prunes snapshots before it computes the log's floor, never after.
// The floor is the minimum over the consumers that could still read the log, and the oldest
// snapshot that *survived* the prune is one of them — held the other way round, the log would be
// pinned to a base that is already gone. See `docs/r6-retention.md`.
//
// Fifth invariant (L2): the write queue is bounded in three ways at once — entries, bytes, and how
// long an entry may wait. A tenant whose disk has stalled refuses admission rather than growing a
// backlog of pending promises until the heap ends, and an entry whose caller has gone is dropped
// before the writer sees it rather than committed for nobody. `maxGroupCommit` bounds a *drain*,
// which is a different thing and always was. See `docs/l2-write-admission.md`.
//
// Hook slots: the tenant takes the writer's WAL hook and nothing else. The commit, rollback and
// authorizer slots belong to `src/realtime` and the route layer (docs/m6-realtime.md), which is
// why `onCommit` here is a list of listeners this class calls after `log.append` rather than
// SQLite's own commit hook — `write()` is synchronous, so it can.
//
// P9 adds one more slot in the same spirit: `setLogicalRecorder` hands this class a function that
// returns opaque bytes for each record's logical section. It is called from `#file` *before* the
// append, because that is the last moment the row changes still exist, and it is opaque because
// this file must not learn what a change event looks like. See `docs/p9-logical-cdc.md`.

import fs from "node:fs"
import path from "node:path"
import { BqlError } from "../server/errors.ts"
import { SqliteError } from "../sqlite/errors.ts"
import {
  type CheckpointMode,
  type CheckpointResult,
  Database,
  type LimitName,
  type StatementCacheCounters,
  type TransactionMode,
} from "../sqlite/index.ts"
import {
  computeFull,
  encode,
  listSnapshots,
  logRetentionFloor,
  pruneSnapshots,
  type RecorderPosition,
  restore,
  type RetentionPolicy,
  snapshot,
  type SnapshotRef,
  TxnLog,
  type TxnRecord,
  type TxnRecordInput,
  TxnRecorder,
  WAL_HEADER_SIZE,
  type ApplyMechanism,
  WalApplier,
  WalError,
  WalFormatError,
} from "../wal/index.ts"
import type { FsyncSweep } from "../durability/index.ts"
import { Catalog, positionOf, type TenantRole } from "./catalog.ts"

/**
 * How durable a write has to be before it is acknowledged (design §5.4).
 *
 * The tenant itself can only keep two of these promises: `"local"` is SQLite's own
 * `synchronous=NORMAL` commit, `"fsync"` adds an explicit `fdatasync` of the WAL and the log.
 * `"replica"` and `"quorum"` are waited for one layer up, by `src/replication/ack.ts`, because
 * they depend on other nodes and `write()` is synchronous — here they mean exactly what `"fsync"`
 * means, since a primary that counts itself in a quorum has to hold the record on disk.
 */
export type AckLevel = "local" | "fsync" | "replica" | "quorum"

/** True for the levels that cost an `fdatasync` on this node. */
export function acksLocallyDurable(ack: AckLevel): boolean {
  return ack !== "local"
}

/** What a commit hook is handed. M6 turns this into change events; nothing here knows how. */
export interface CommitEvent {
  txid: bigint
  record: TxnRecordInput
  /** The encoded record — also the wire format a replica stream sends. */
  bytes: Uint8Array
}

export type CommitListener = (event: CommitEvent) => void

/**
 * P9: the row changes a batch of about-to-be-filed transactions made, as opaque bytes for each
 * record's logical section. Installed by the server runtime when `[replication] logicalChanges` is
 * on, and called once per batch with the txids in order, immediately before the records are
 * encoded.
 *
 * Opaque on purpose. `src/tenant/` knows nothing about `src/realtime/` — the commit, rollback and
 * authorizer hook slots belong to the realtime layer and the tenant deliberately does not reach
 * into them — so this is an option the runtime installs rather than a new dependency edge, and the
 * tenant never learns what is in the bytes it files.
 *
 * Returning null records nothing for the whole batch, which is what the source answers when it
 * cannot line its transactions up with these records. That is a refusal, not a failure: rows filed
 * under the wrong txid would be worse than no rows at all.
 */
export type LogicalRecorder = (txids: readonly bigint[]) => (Uint8Array | null)[] | null

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
  /**
   * Most statements folded into one group commit by `writeQueued`. Default 64. The per-row cost is
   * already flat by fifty (`docs/performance.md` §4B), and the cap bounds how long one transaction
   * holds the writer.
   */
  maxGroupCommit?: number
  /**
   * Entries `writeQueued` will hold waiting for the writer. Default 256. Past it, `WRITE_QUEUE_FULL`
   * with a `Retry-After` derived from the measured drain rate (L2).
   */
  maxQueuedWrites?: number
  /**
   * Bytes those entries may hold between them — the caller's account of its SQL and bound
   * arguments, since the queue holds closures and cannot weigh them itself. Default 8 MiB.
   *
   * An entry larger than the whole budget is admitted when the queue is **empty**, because
   * refusing it would make it unserveable at any time rather than at a busy one.
   */
  maxQueuedWriteBytes?: number
  /** How long a queued write waits before it is refused `WRITE_QUEUE_TIMEOUT`. Default 5000. */
  queueWaitMs?: number
  /**
   * Compress record bodies with zstd. Default true. It is a third of a single-row write
   * (`docs/performance.md` §1) against 4.3x on disk and on every replica's socket, so it is a
   * deployment choice rather than a constant. Per record and in the header: turning it off leaves
   * everything already written readable.
   */
  compressLog?: boolean
  /**
   * L5: the thread's shared fsync sweep, when `[durability] fsyncSweep` is `"shared"`. The log's
   * `"interval"` barriers go there instead of onto the write path; `ack: "fsync"` is unaffected and
   * still fsyncs inline before the caller is answered.
   */
  fsyncSweep?: FsyncSweep | null
  /** P5: file a committed transaction after the client is answered, for `ack: "local"`. */
  deferAppend?: boolean
  /**
   * Replica only: which of design §4.5's two apply mechanisms to prefer, and how long a page apply
   * waits for the WAL lock set. Defaults `"pages"` and 5000. `docs/c5-apply-pages.md`.
   */
  applyMechanism?: ApplyMechanism
  applyBusyMs?: number
  /** `sqlite3_limit` overrides; the defaults below are applied first. */
  limits?: Partial<Record<LimitName, number>>
  /**
   * Pragmas bql.sh states rather than inherits (`docs/p1-pragmas.md`). Left undefined, a connection
   * carries whatever the loaded libsqlite3 defaults to — which differs between builds: Apple's
   * `cache_size` default is in pages where upstream's is in KiB, four times the cache and a
   * different moment for dirty pages to reach the `-wal`.
   */
  sqlite?: SqlitePragmas
  /**
   * P7: where every connection this tenant opens reports its statement-cache activity. One object
   * shared by a registry's tenants, so the node's totals survive an eviction; left undefined, each
   * connection keeps its own and nothing reads them.
   */
  statementCacheCounters?: StatementCacheCounters
  /** Where a throwing commit hook goes. Defaults to `console.error`. */
  onError?: (err: unknown) => void
  /**
   * Called once for every connection this tenant opens, after its pragmas and limits are set and
   * before anything uses it. The seam the route layer installs its authorizer trampoline through,
   * since readers are opened lazily and a pooled one outlives the request that created it.
   */
  onConnection?: (db: Database, role: "writer" | "reader") => void
}

/**
 * Per-connection settings, in bytes where SQLite takes a count. `undefined` leaves the library's
 * own default in place, which is what every path that does not come from `[sqlite]` wants.
 *
 * All of these are pragmas but `statementCache`, which bounds bql.sh's own prepared-statement cache
 * rather than anything SQLite knows about; it travels here because it is `[sqlite]`'s key and takes
 * the same route to the connection.
 */
export interface SqlitePragmas {
  /**
   * Distinct SQL texts one connection keeps compiled. Default 64 (`docs/p7-plan-cache.md`).
   * Per connection: a tenant holds one writer and up to `readers` of these.
   */
  statementCache?: number
  writerCacheBytes?: number
  readerCacheBytes?: number
  /** Readers only, and off by default: a read error on a mapped page is a SIGBUS, not an error. */
  readerMmapBytes?: number
  foreignKeys?: boolean
  trustedSchema?: boolean
  cellSizeCheck?: boolean
  /** `SQLITE_DBCONFIG_DEFENSIVE`; needs the vendored build's shim, and says so if it is absent. */
  defensive?: boolean
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
  /** Writes queued for this tenant right now (L2). */
  queuedWrites: number
  /** Bytes those entries hold between them. */
  queuedWriteBytes: number
}

export interface WriteOptions {
  ack?: AckLevel
}

export interface QueuedWriteOptions extends WriteOptions {
  /**
   * What this entry weighs while it waits — the caller's SQL and its bound arguments. The queue
   * holds a closure and cannot weigh it, so the caller says; 0 means "charge nothing", which is
   * what an internal write that is not holding a client's bytes should pass.
   */
  bytes?: number
  /**
   * The caller's lifetime. A request whose socket closes while its write is queued has the entry
   * dropped before the writer sees it — committing it would be work done for nobody, and on a
   * backlog it is the difference between a queue that drains and one that does not.
   */
  signal?: AbortSignal
}

export interface TxBeginOptions extends WriteOptions {
  /** `BEGIN <mode>`. Default `"immediate"`: a baton transaction is a write that arrives in parts. */
  mode?: TransactionMode
  /** Roll the transaction back after this long with no statement. 0 (default) never expires. */
  idleTimeoutMs?: number
  /** Called after the idle timer rolled the transaction back, so the route layer can drop its baton. */
  onExpire?: () => void
}

/** What `readTxBegin` accepts. */
export interface ReadTxBeginOptions {
  /** Roll the transaction back after this long with no statement. 0 (default) never expires. */
  idleTimeoutMs?: number
  /** Roll it back after this long however busy it is. 0 (default) never expires. */
  maxMs?: number
  /** Called after a timer ended it, so the route layer can drop its baton. */
  onExpire?: () => void
}

/**
 * An open read transaction: a leased reader with `BEGIN DEFERRED` on it (`docs/r10-read-transactions.md`).
 *
 * Nothing about the writer is involved, which is what makes it work on a replica — where the
 * writer belongs to the applier — and what makes it not block writes on a primary.
 */
export interface ReadTx {
  readonly db: Database
  /** False once it has ended, however it ended. */
  open: boolean
}

/** A read transaction and the lease and timers that belong to it. */
interface OpenReadTx {
  tx: ReadTx
  lease: ReaderLease
  idleTimeoutMs: number
  onExpire: (() => void) | null
  idleTimer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
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

/** One `writeQueued` caller, waiting to be folded into the next transaction. */
interface QueuedWrite {
  run: (db: Database) => unknown
  ack: AckLevel
  resolve: (value: WriteResult<unknown>) => void
  reject: (err: unknown) => void
  /** What this entry was charged against `maxQueuedWriteBytes`, refunded when it leaves. */
  bytes: number
  /** `Date.now()` past which it is refused `WRITE_QUEUE_TIMEOUT`, or Infinity. */
  deadlineAt: number
  /** The caller's lifetime, held until the entry is actually going to wait. */
  signal: AbortSignal | null
  /** Drops the abort listener, once one has been attached. */
  detach: (() => void) | null
  /** Set when the caller went away or the deadline passed; the drain steps over it. */
  done: boolean
}

/** Strictest first. `replica` and `quorum` are waited for above the tenant and cost an fsync here. */
const ACK_ORDER: Record<AckLevel, number> = { local: 0, fsync: 1, replica: 2, quorum: 3 }

/** The level a fold is answered at: nobody may be answered weaker than they asked. */
export function strictestAck(acks: readonly AckLevel[]): AckLevel {
  let best: AckLevel = "local"
  for (const ack of acks) if (ACK_ORDER[ack] > ACK_ORDER[best]) best = ack
  return best
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
    throw BqlError.badRequest(
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

/** What one retention pass needs to know about this database's consumers (`Tenant.retain`). */
export interface RetainOptions {
  /** `[durability] retention` in milliseconds. `0` or less keeps everything. */
  retentionMs: number
  /** `[durability] maxLogBytes`. `0` (the default) is unlimited; the floor still wins. */
  maxLogBytes?: number
  /** Lowest txid acked by a replica currently streaming this database, or null when none is. */
  replicaTxid?: bigint | null
  /** What the S3 shipper has put in the bucket, or null when nothing ships this database. */
  shippedTxid?: bigint | null
  /** Clock, for tests. */
  now?: number
}

export interface RetainResult {
  /** Snapshot files removed. */
  snapshots: string[]
  /** Log segment files removed. */
  segments: string[]
  bytesFreed: number
  /** The `keepAfterTxid` the log was held to, or null when no consumer imposed one. */
  floor: bigint | null
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
  /** Most statements one group commit folds; see `writeQueued`. */
  readonly maxGroupCommit: number
  /** Entries the write queue admits; past it, `WRITE_QUEUE_FULL` (L2). */
  readonly maxQueuedWrites: number
  /** Bytes those entries may hold between them. */
  readonly maxQueuedWriteBytes: number
  /** How long a queued write waits before `WRITE_QUEUE_TIMEOUT`. */
  readonly queueWaitMs: number
  readonly checkpointWalBytes: number
  readonly idleCheckpointMs: number
  readonly defaultAck: AckLevel
  readonly waitMs: number
  /** What the reconcile found when this tenant was opened. */
  readonly reconciled: ReconcileOutcome

  #options: TenantOptions
  #free: Database[] = []
  /** Open read transactions, each holding a reader lease (`docs/r10-read-transactions.md`). */
  #readTx = new Set<OpenReadTx>()
  #openReaders = 0
  #leased = 0
  #listeners = new Set<CommitListener>()
  /** Writes waiting to be folded into one transaction; see `writeQueued`. */
  #queue: QueuedWrite[] = []
  /** Sum of `bytes` over `#queue`, kept rather than recomputed so admission is an integer compare. */
  #queuedBytes = 0
  /**
   * One timer for the whole queue: deadlines are armed at push with the same `queueWaitMs`, so
   * they are monotonic and the head is always the earliest. Armed only when the queue is actually
   * backed up, so the ordinary fold — queued and drained inside one event-loop turn — never
   * creates a timer at all.
   */
  #queueTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Milliseconds per entry the last drains took, smoothed. It is what `Retry-After` is derived
   * from: a constant would tell a client to come back at a time that has nothing to do with how
   * fast this tenant is actually committing.
   */
  #msPerQueuedWrite = 0
  #draining = false
  #drainScheduled = false
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
  /** P5: records polled but not yet filed, in order. Never reordered, never dropped. */
  #pending: TxnRecordInput[] = []
  /** A flush is already queued for this turn. */
  #filing = false
  /**
   * Set once nothing may be filed again — at the end of `close()`, after its last capture, and at
   * the start of `abandon()`. `#closed` is too early: `close()` sets it and *then* captures and
   * checkpoints, and a flush refused there would lose the records that capture produced.
   */
  #filingStopped = false
  /** The snapshot in flight, so a second caller waits for it rather than being refused. */
  #snapshotting: Promise<SnapshotRef> | null = null
  /** `[durability] deferAppend`, resolved once. */
  readonly #deferAppend: boolean
  /** P9: where a record's logical section comes from, when anything installed one. */
  #logicalRecorder: LogicalRecorder | null = null
  /** P9: `lastRecordVersion`, computed once and kept current by `applyRecord`. */
  #lastRecordVersion: number | null = null
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
    this.maxGroupCommit = Math.max(1, options.maxGroupCommit ?? 64)
    this.maxQueuedWrites = Math.max(1, options.maxQueuedWrites ?? 256)
    this.maxQueuedWriteBytes = Math.max(1, options.maxQueuedWriteBytes ?? 8 * 1024 * 1024)
    this.queueWaitMs = Math.max(0, options.queueWaitMs ?? 5000)
    this.checkpointWalBytes = options.checkpointWalBytes ?? 4_000_000
    this.idleCheckpointMs = options.idleCheckpointMs ?? 1000
    this.defaultAck = options.defaultAck ?? "local"
    this.#deferAppend = options.deferAppend === true
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
      ...(options.compressLog !== undefined ? { compress: options.compressLog } : {}),
      ...(options.fsyncSweep ? { sweep: options.fsyncSweep } : {}),
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
      queuedWrites: this.#queue.length,
      queuedWriteBytes: this.#queuedBytes,
    }
  }

  /** Snapshots this database holds, oldest first. */
  snapshots(): SnapshotRef[] {
    return listSnapshots(this.dir)
  }

  /**
   * P9: installs the source of the row changes records carry, or removes it with null. The runtime
   * calls this when it creates the realtime engine for a primary and `[replication] logicalChanges`
   * is on; nothing else has any business doing so.
   */
  setLogicalRecorder(recorder: LogicalRecorder | null): void {
    this.#logicalRecorder = recorder
  }

  /**
   * P9: the version of the newest record in this database's log, or 0 when the log is empty. A
   * replica reads it to know whether its primary records row changes across a restart, so a
   * subscription between two transactions is not refused `LOGICAL_UNAVAILABLE` for a feed that can
   * in fact carry rows. Cached: the read is one record header, and `applyRecord` keeps it current.
   */
  get lastRecordVersion(): number {
    const cached = this.#lastRecordVersion
    if (cached !== null) return cached
    let version = 0
    const last = this.log.lastTxid
    if (last !== 0n) {
      try {
        for (const record of this.log.iterate(last)) version = record.version
      } catch {
        // An aged-out or unreadable tail answers "no version", which is the conservative reading.
        version = 0
      }
    }
    this.#lastRecordVersion = version
    return version
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
   * `write`, but folded with whatever else is waiting (design note: `docs/p2-group-commit.md`).
   *
   * Every fixed cost of the write path — the commit, the WAL tail, the page checksums, the record
   * encode, the segment append — is paid **per transaction**, not per statement, so a transaction
   * per statement pays them all every time: 29.04 µs a row at one row, 0.96 µs at fifty
   * (`docs/performance.md` §4B). This queue turns concurrency into batch size. A caller that
   * arrives while the writer is idle runs alone on the next microtask and pays nothing extra; one
   * that arrives while a fold is running joins the next one.
   *
   * Three things make the fold invisible to a caller:
   *
   *  - **Its own result.** Each entry's `fn` runs in order and its return value resolves its own
   *    promise, so a statement still gets its own `lastInsertRowid` and row count.
   *  - **Its own failure.** A throw rolls back the whole transaction, including its neighbours —
   *    so the drain re-runs the batch one at a time, and only the entry that threw is rejected.
   *    Nothing persisted from the rolled-back attempt, so the re-run is a first attempt.
   *  - **The strictest durability asked for.** A fold of `local` and `fsync` is answered as
   *    `fsync`. Nobody is answered at a weaker level than they asked for.
   *
   * What a caller does see: **the txid is shared**, because one transaction is one txid. It stays
   * monotonic and it is the txid the write really landed in, which is what read-your-writes needs.
   */
  writeQueued<T>(
    fn: (db: Database) => T,
    options: QueuedWriteOptions = {},
  ): Promise<WriteResult<T>> {
    this.#assertOpen()
    this.#assertPrimary()
    // **A snapshot is not a refusal.** It holds the writer for a bounded moment — a TRUNCATE
    // checkpoint and a reflink — and `#drain` below is already written to wait it out and be
    // rescheduled when it lets go. Refusing here contradicted that, and the refusal was one the
    // node inflicted on itself: `ServerRuntime.maybeSnapshot` takes a housekeeping snapshot from
    // the retention sweep, so a client doing nothing unusual would get a `503 BUSY` because the
    // node had decided, on its own timer, to snapshot. A write arriving during one now queues.
    //
    // A baton transaction is the other way round and stays a refusal: it holds the writer for as
    // long as its client likes, so queuing would turn a 409 into a wait of up to
    // `txIdleTimeoutMs`, which is a worse answer rather than a better one.
    if (this.#txOpen) return Promise.reject(txBusy(this.name))
    // L2: admission. `maxGroupCommit` bounds a drain, never the backlog, so before this the only
    // thing standing between a stalled disk and the heap was how long the client kept sending.
    const bytes = Math.max(0, options.bytes ?? 0)
    if (this.#queue.length >= this.maxQueuedWrites) {
      return Promise.reject(this.#queueFull(`${this.maxQueuedWrites} writes are already queued`))
    }
    // The empty-queue exemption: a body larger than the whole byte budget is served rather than
    // made permanently unserveable. `[limits] maxBodyBytes` is what bounds it in that case.
    if (this.#queue.length > 0 && this.#queuedBytes + bytes > this.maxQueuedWriteBytes) {
      return Promise.reject(
        this.#queueFull(`${this.#queuedBytes} bytes of writes are already queued`),
      )
    }
    const signal = options.signal ?? null
    if (signal?.aborted) return Promise.reject(abandonedWrite(this.name))
    return new Promise<WriteResult<T>>((resolve, reject) => {
      const entry: QueuedWrite = {
        run: fn as (db: Database) => unknown,
        ack: options.ack ?? this.defaultAck,
        resolve: resolve as (value: WriteResult<unknown>) => void,
        reject,
        bytes,
        deadlineAt: Infinity,
        signal,
        detach: null,
        done: false,
      }
      // Past a full fold, this entry cannot be in the next batch, so it is going to wait. That —
      // not "the queue is non-empty" — is what makes the waiting machinery worth its cost: a burst
      // of sixty-four concurrent writes against a `maxGroupCommit` of sixty-four is drained whole
      // on the next turn and pays for none of it.
      const willWait = this.#queue.length >= this.maxGroupCommit
      this.#queue.push(entry)
      this.#queuedBytes += bytes
      if (willWait) this.#beginWait(entry)
      this.#scheduleDrain()
    })
  }

  /**
   * Marks one entry as *waiting*: stamps its deadline, subscribes it to its caller's signal, and
   * makes sure a timer is armed for whatever expires first.
   *
   * All three are deferred rather than done at push, and the reason is measurement. A write that
   * is queued and drained inside one event-loop turn cannot wait past `queueWaitMs` and cannot
   * outlive its caller, so every one of them is dead weight on the path group commit exists to
   * make fast — and `Date.now()` and `AbortSignal.addEventListener` are both real money against a
   * per-write cost of 0.85 µs at sixty-four concurrent clients. Doing it at push cost **6%** there
   * (`docs/l2-write-admission.md` §4).
   *
   * The deadline therefore runs from the moment the entry was found to be waiting rather than from
   * the moment it was queued. The two differ by at most one event-loop turn, and only for an entry
   * that a stalled writer deferred.
   */
  #beginWait(entry: QueuedWrite): void {
    if (entry.done) return
    if (entry.deadlineAt === Infinity && this.queueWaitMs > 0) {
      entry.deadlineAt = Date.now() + this.queueWaitMs
    }
    const signal = entry.signal
    if (signal !== null && entry.detach === null) {
      if (signal.aborted) {
        this.#finish(entry)
        entry.reject(abandonedWrite(this.name))
        return
      }
      const onAbort = (): void => {
        this.#finish(entry)
        entry.reject(abandonedWrite(this.name))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      entry.detach = () => signal.removeEventListener("abort", onAbort)
    }
    this.#armQueueTimer()
  }

  /**
   * The same for every entry still queued — the genuine-backlog paths, where a drain has left work
   * behind or the writer is not moving at all. Entries already waiting are skipped, so a
   * persistent backlog costs one pass per drain rather than one subscription per drain.
   */
  #beginWaitAll(): void {
    for (const entry of [...this.#queue]) this.#beginWait(entry)
  }

  /**
   * `WRITE_QUEUE_FULL`, carrying a `Retry-After` derived from how fast this tenant is actually
   * draining rather than from a constant. With no measurement yet — the first burst — it is one
   * second, which is the honest floor of "come back later".
   */
  #queueFull(detail: string): BqlError {
    const perEntry = this.#msPerQueuedWrite
    const clearMs = perEntry > 0 ? this.#queue.length * perEntry : 0
    const seconds = Math.min(60, Math.max(1, Math.ceil(clearMs / 1000)))
    return new BqlError(
      "WRITE_QUEUE_FULL",
      `${this.name} cannot accept another write: ${detail}`,
      503,
      { retryAfterSec: seconds },
    )
  }

  /** Takes an entry out of the accounting exactly once, whatever removed it. */
  #finish(entry: QueuedWrite): void {
    if (entry.done) return
    entry.done = true
    entry.detach?.()
    entry.detach = null
    entry.signal = null
    this.#queuedBytes -= entry.bytes
    if (this.#queuedBytes < 0) this.#queuedBytes = 0
  }

  /**
   * One timer for the whole queue, armed for whichever waiting entry expires first. Entries that
   * are not waiting yet carry `Infinity`, so they are simply not candidates. The scan is O(queue)
   * and runs only on the paths that already know there is a backlog.
   */
  #armQueueTimer(): void {
    if (this.#queueTimer !== null) return
    let earliest = Infinity
    for (const entry of this.#queue) {
      if (!entry.done && entry.deadlineAt < earliest) earliest = entry.deadlineAt
    }
    if (earliest === Infinity) return
    const delay = Math.max(0, earliest - Date.now())
    const timer = setTimeout(() => {
      this.#queueTimer = null
      this.#expireQueued()
    }, delay)
    timer.unref?.()
    this.#queueTimer = timer
  }

  #clearQueueTimer(): void {
    if (this.#queueTimer === null) return
    clearTimeout(this.#queueTimer)
    this.#queueTimer = null
  }

  /**
   * Refuses every entry that has waited past `queueWaitMs` and re-arms for the next one. The timer
   * may fire early — the head it was armed for has usually been drained by then — in which case
   * nothing expires and it simply re-arms, which is cheaper than re-arming on every drain.
   */
  #expireQueued(): void {
    const now = Date.now()
    const expired: QueuedWrite[] = []
    const kept: QueuedWrite[] = []
    for (const entry of this.#queue) {
      if (entry.done) continue
      if (entry.deadlineAt <= now) {
        this.#finish(entry)
        expired.push(entry)
      } else {
        kept.push(entry)
      }
    }
    this.#queue = kept
    for (const entry of expired) {
      entry.reject(
        new BqlError(
          "WRITE_QUEUE_TIMEOUT",
          `${this.name} did not reach this write within ${this.queueWaitMs}ms`,
          503,
        ),
      )
    }
    if (this.#queue.length > 0) this.#armQueueTimer()
  }

  /**
   * One drain per turn, scheduled with `setImmediate` — and the choice matters more than it looks.
   *
   * `queueMicrotask` runs as soon as the stack empties, which is the moment the *first* request
   * handler awaits. Every later message is a separate I/O callback that has not run yet, so a
   * microtask drain folds exactly one write and buys nothing; measured, it was 26 700 writes/s
   * against 26 180 without the queue at all. `setImmediate` runs after the I/O callbacks already
   * pending in this loop iteration, so the batch is everything the socket had waiting.
   *
   * It costs a lone write 0.42 µs against the microtask's 0.13 — and rather more than that in
   * practice, because a single socket's messages arrive one per loop iteration, so a client with
   * no company pays a whole iteration per write: 22 827 writes/s against 26 941 with the queue
   * off. That is the trade, and it is the right way round for a server — four concurrent clients
   * already make it 2.2x and sixty-four make it 4.7x (`docs/p2-group-commit.md`). A deployment
   * that really does have one writer at a time sets `[limits] groupCommit = false`.
   *
   * `setTimeout(fn, 0)` is 1.26 ms in Bun and would be a catastrophe here.
   *
   * An adaptive version — inline when the last drain folded nothing — was tried and does not
   * work: the inline path never folds anything, so it never leaves inline mode.
   */
  #scheduleDrain(): void {
    if (this.#draining || this.#drainScheduled) return
    this.#drainScheduled = true
    setImmediate(() => {
      this.#drainScheduled = false
      this.#drain()
    })
  }

  /**
   * Takes everything queued and runs it as one transaction. A baton transaction or an in-flight
   * synchronous write owns the writer, so the drain waits for it rather than failing the callers —
   * `write` and `beginTx` both end by scheduling one.
   */
  #drain(): void {
    if (this.#draining || this.#queue.length === 0) return
    if (this.#closed) {
      const closed = new TenantError("CLOSED", `database ${this.name} is closed`)
      for (const entry of this.#takeAll()) entry.reject(closed)
      return
    }
    // A transaction opened after these were queued: refuse them the way `write` would have, so
    // the answer does not depend on which of the two arrived first.
    if (this.#txOpen) {
      for (const entry of this.#takeAll()) entry.reject(txBusy(this.name))
      return
    }
    // A synchronous write or a snapshot holds the writer for a bounded moment; both schedule
    // another drain when they let go. The queue outlives this turn, so the wait deadline needs a
    // timer behind it — this is the path a stalled writer takes.
    if (this.#writing || this.#exclusive) {
      this.#beginWaitAll()
      return
    }

    // One forward scan and one splice, rather than a shift per entry: the queue can hold
    // `maxQueuedWrites` and repeated shifts on it would be quadratic in the size of the backlog,
    // which is the case this whole milestone exists for.
    const now = Date.now()
    const batch: QueuedWrite[] = []
    let taken = 0
    const stale: QueuedWrite[] = []
    while (batch.length < this.maxGroupCommit && taken < this.#queue.length) {
      const entry = this.#queue[taken] as QueuedWrite
      taken++
      // A caller that has gone: its promise is settled and its bytes are back already. Running it
      // would be a transaction committed for nobody.
      if (entry.done) continue
      // `done` is only ever read by something that could settle this entry from elsewhere, and
      // only an entry that waited long enough to be subscribed has such a thing. Setting it — and
      // dropping the listener — is therefore on the slow path, not on the fold.
      if (entry.detach !== null) {
        entry.done = true
        entry.detach()
        entry.detach = null
        entry.signal = null
      }
      // The deadline is checked here as well as on the timer, so a queue that is draining — just
      // not fast enough — refuses a stale entry rather than committing it late. The timer is for
      // the queue that is not draining at all.
      if (entry.deadlineAt <= now) {
        entry.done = true
        stale.push(entry)
        continue
      }
      batch.push(entry)
    }
    this.#queue.splice(0, taken)
    // The byte account is rebuilt from what is left rather than decremented per entry: in the case
    // this path is written for the queue is now empty, which makes it one assignment instead of
    // one subtraction per folded statement.
    if (this.#queue.length === 0) {
      this.#queuedBytes = 0
      this.#clearQueueTimer()
    } else {
      let held = 0
      for (const entry of this.#queue) if (!entry.done) held += entry.bytes
      this.#queuedBytes = held
      this.#scheduleDrain()
      this.#beginWaitAll()
    }
    for (const entry of stale) {
      entry.reject(
        new BqlError(
          "WRITE_QUEUE_TIMEOUT",
          `${this.name} did not reach this write within ${this.queueWaitMs}ms`,
          503,
        ),
      )
    }
    if (batch.length === 0) return
    const startedNs = Bun.nanoseconds()
    this.#draining = true
    try {
      // `fsync` beats `local`; `replica` and `quorum` are waited for a layer up and cost an fsync
      // here, so the strictest level in the batch is what the whole transaction is answered at.
      const ack = strictestAck(batch.map((entry) => entry.ack))
      const results: unknown[] = new Array(batch.length)
      let failed = -1
      let failure: unknown = null
      try {
        const written = this.write((db) => {
          for (let i = 0; i < batch.length; i++) {
            results[i] = (batch[i] as QueuedWrite).run(db)
          }
          return results
        }, { ack })
        for (let i = 0; i < batch.length; i++) {
          ;(batch[i] as QueuedWrite).resolve({ result: results[i], txid: written.txid })
        }
        return
      } catch (err) {
        failure = err
        failed = batch.length === 1 ? 0 : -1
      }
      // One statement rolled the batch back. Nothing committed, so running them again is running
      // them for the first time — and one at a time, each failure lands on its own caller.
      if (batch.length === 1) {
        ;(batch[0] as QueuedWrite).reject(failure)
        return
      }
      void failed
      for (const entry of batch) {
        try {
          const written = this.write(entry.run, { ack: entry.ack })
          entry.resolve({ result: written.result, txid: written.txid })
        } catch (err) {
          entry.reject(err)
        }
      }
    } finally {
      this.#draining = false
      this.#recordDrain(batch.length, (Bun.nanoseconds() - startedNs) / 1_000_000)
      if (this.#queue.length > 0) this.#scheduleDrain()
    }
  }

  /** Empties the queue for a refusal path, leaving the accounting consistent. */
  #takeAll(): QueuedWrite[] {
    const all = this.#queue.splice(0)
    this.#clearQueueTimer()
    const live: QueuedWrite[] = []
    for (const entry of all) {
      if (entry.done) continue
      this.#finish(entry)
      live.push(entry)
    }
    return live
  }

  /**
   * The drain rate `Retry-After` is derived from, as an exponential moving average of milliseconds
   * per entry. A quarter weight on the newest drain: fast enough to follow a disk that has just
   * stalled, slow enough that one unlucky transaction does not tell every client to wait a minute.
   */
  #recordDrain(count: number, ms: number): void {
    if (count <= 0) return
    const perEntry = ms / count
    this.#msPerQueuedWrite =
      this.#msPerQueuedWrite === 0 ? perEntry : this.#msPerQueuedWrite * 0.75 + perEntry * 0.25
  }

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
      throw BqlError.busy(`${this.name} is taking a snapshot`)
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
      const txid = this.#capture(ack)
      if (acksLocallyDurable(ack)) this.#syncDurable()
      this.#maybeCheckpoint()
      return { result, txid }
    } finally {
      this.#writing = false
      this.#lastActivityMs = Date.now()
      // Anything that queued while this held the writer is now this turn's next drain, so a
      // `writeQueued` caller never waits on a timer for a writer that is already free.
      if (!this.#draining && this.#queue.length > 0) this.#scheduleDrain()
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
    if (this.#exclusive) throw BqlError.busy(`${this.name} is taking a snapshot`)
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
      if (acksLocallyDurable(ack)) this.#syncDurable()
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
    // A baton held the writer; whatever queued behind it drains on the next turn.
    if (this.#queue.length > 0) this.#scheduleDrain()
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
      throw BqlError.txidNotAvailable(Number(minTxid), Number(this.txid))
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
          reject(BqlError.txidNotAvailable(Number(txid), Number(this.txid)))
        }, waitMs),
      }
      this.#waiters.push(waiter)
    })
  }

  // ── read transactions (docs/r10-read-transactions.md) ────────────────────────────────────────

  /**
   * Opens a read transaction on a leased reader. Works on a replica, because the writer — which on
   * a replica belongs to the applier — is not involved; and on a primary it does not block writes,
   * which the writer-based `txBegin` does.
   *
   * `BEGIN DEFERRED`: the snapshot is taken at the first read, which is SQLite's own behaviour for
   * a read transaction and what `BEGIN TRANSACTION READONLY` means to `@libsql/client`.
   */
  readTxBegin(options: ReadTxBeginOptions = {}): ReadTx {
    this.#assertOpen()
    const lease = this.acquireReader()
    try {
      lease.db.exec("begin deferred")
    } catch (err) {
      this.releaseReader(lease)
      throw translateWriteError(err, this.name)
    }
    const entry: OpenReadTx = {
      tx: { db: lease.db, open: true },
      lease,
      idleTimeoutMs: options.idleTimeoutMs ?? 0,
      onExpire: options.onExpire ?? null,
      idleTimer: null,
      maxTimer: null,
    }
    if (options.maxMs && options.maxMs > 0) {
      entry.maxTimer = setTimeout(() => this.#expireReadTx(entry), options.maxMs)
      entry.maxTimer.unref?.()
    }
    this.#readTx.add(entry)
    this.#armReadTxIdle(entry)
    return entry.tx
  }

  /** Runs one statement inside an open read transaction and restarts its idle timer. */
  readTxExec<T>(tx: ReadTx, fn: (db: Database) => T): T {
    const entry = this.#findReadTx(tx)
    this.#lastActivityMs = Date.now()
    this.#armReadTxIdle(entry)
    return fn(entry.tx.db)
  }

  /**
   * Ends a read transaction. Always a rollback: a read transaction has nothing to commit, and
   * rolling back is the only ending that is correct whether or not it ever read anything.
   */
  readTxEnd(tx: ReadTx): void {
    const entry = this.#findReadTx(tx)
    this.#closeReadTx(entry)
  }

  /** Read transactions open on this tenant right now. */
  get openReadTx(): number {
    return this.#readTx.size
  }

  #findReadTx(tx: ReadTx): OpenReadTx {
    for (const entry of this.#readTx) {
      if (entry.tx === tx) return entry
    }
    throw noTx(this.name)
  }

  #armReadTxIdle(entry: OpenReadTx): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    if (entry.idleTimeoutMs <= 0) return
    const timer = setTimeout(() => this.#expireReadTx(entry), entry.idleTimeoutMs)
    timer.unref?.()
    entry.idleTimer = timer
  }

  #expireReadTx(entry: OpenReadTx): void {
    if (!entry.tx.open) return
    const onExpire = entry.onExpire
    this.#closeReadTx(entry)
    onExpire?.()
  }

  #closeReadTx(entry: OpenReadTx): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    if (entry.maxTimer !== null) clearTimeout(entry.maxTimer)
    entry.idleTimer = null
    entry.maxTimer = null
    entry.tx.open = false
    this.#readTx.delete(entry)
    let clean = true
    try {
      if (entry.lease.db.inTransaction) entry.lease.db.exec("rollback")
    } catch {
      // A connection still inside a transaction must not go back in the pool: the next borrower
      // would inherit its snapshot. Release it as unpooled, which closes it.
      clean = false
    }
    this.releaseReader(clean ? entry.lease : { db: entry.lease.db, pooled: false })
    if (!clean && entry.lease.pooled) this.#openReaders -= 1
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
      if (this.#leased > 0) throw BqlError.busy(`a reader on ${this.name} holds a transaction`)
      const result = (this.applier as WalApplier).checkpoint(mode)
      this.#lastActivityMs = Date.now()
      return result
    }
    if (mode !== "PASSIVE" && this.#leased > 0) {
      throw BqlError.busy(`a reader on ${this.name} holds a transaction`)
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
    // A snapshot already in flight is the node's own housekeeping as often as not — the retention
    // sweep takes one every `[durability] snapshotIntervalMs` — so answering a caller `503 BUSY`
    // because of it is a refusal the node inflicted on itself, exactly as it was on the write path
    // (`writeQueued`). Wait for it instead: if nothing has committed since, that snapshot *is*
    // this one, which is the same answer `existing` gives below for a repeat at one txid. One
    // wait, not a loop — a second racer means real contention, and `BUSY` is then honest.
    const inflight = this.#snapshotting
    if (inflight) {
      const ref = await inflight.catch(() => null)
      if (ref && BigInt(ref.txid) === this.position.txid) return ref
    }
    const run = this.#snapshot()
    this.#snapshotting = run
    try {
      return await run
    } finally {
      if (this.#snapshotting === run) this.#snapshotting = null
    }
  }

  /** The snapshot itself. `snapshot()` owns the one-in-flight rule; this owns the exclusive one. */
  async #snapshot(): Promise<SnapshotRef> {
    // P5: a snapshot taken with records outstanding would be one the log cannot explain.
    this.flushPending()
    this.#assertOpen()
    if (this.#leased > 0) {
      throw BqlError.busy(`a reader on ${this.name} holds a transaction`)
    }
    if (this.#exclusive) throw BqlError.busy(`${this.name} is already snapshotting`)
    this.#exclusive = true
    try {
      this.drain()
      this.#openWal()
      const txid = this.position.txid
      const existing = listSnapshots(this.dir).find((ref) => BigInt(ref.txid) === txid)
      if (existing) return existing
      const position = this.position
      const ref = await snapshot(
        { db: this.writer, dbPath: this.dbPath, dir: this.dir },
        txid,
        // The ref records *this tenant's* position, not the file's own page count and XOR: they
        // differ on a pristine database, and a replica or a PITR restore seeded from the file
        // there would diverge on the first record (`docs/r1-replication.md` deviation 9).
        { epoch: this.epoch, position: { checksum: position.checksum, pages: position.dbSizePages } },
      )
      this.catalog.recordSnapshot(this.name, txid, ref.path)
      this.#lastSnapshotTxid = txid
      // The snapshot's TRUNCATE checkpoint emptied the WAL, which is a position worth recording.
      this.#afterCheckpoint()
      return ref
    } finally {
      this.#exclusive = false
      this.#lastActivityMs = Date.now()
      // Anything that queued while this held the writer is now waiting on a drain that `#drain`
      // declined to run. Nothing else will schedule it.
      if (this.#queue.length > 0) this.#scheduleDrain()
    }
  }

  /**
   * One retention pass over this database: prune the snapshots, then drop the log segments that
   * are past the retention and that nothing can still need (design §4.4, `docs/r6-retention.md`).
   *
   * The order is the whole of it. Snapshots go first, so the floor below is computed from what
   * actually survived rather than from a base that is about to be deleted; then the floor is the
   * minimum over every consumer that could still read the log; then the age and size bounds choose
   * among the segments below it. `retentionMs <= 0` keeps everything, matching `retention = "0"`.
   */
  retain(options: RetainOptions): RetainResult {
    this.#assertOpen()
    const result: RetainResult = { snapshots: [], segments: [], bytesFreed: 0, floor: null }
    if (!(options.retentionMs > 0)) return result
    // A snapshot or a fork is copying this database's file right now, and both read the snapshot
    // index and the log. Maintenance that runs every five minutes can wait for the next pass.
    if (this.#exclusive) return result

    const cutoffMs = (options.now ?? Date.now()) - options.retentionMs
    const { removed, kept } = pruneSnapshots(this.dir, cutoffMs, (err) => this.#report(err))
    for (const ref of removed) {
      this.catalog.removeSnapshotRow(this.name, BigInt(ref.txid))
      result.snapshots.push(ref.path)
    }

    const floor = logRetentionFloor({
      oldestSnapshotTxid: kept.length > 0 ? BigInt((kept[0] as SnapshotRef).txid) : null,
      slowestReplicaTxid: options.replicaTxid ?? null,
      shippedTxid: options.shippedTxid ?? null,
    })
    result.floor = floor ?? null

    const maxBytes = options.maxLogBytes ?? 0
    const policy: RetentionPolicy = {
      maxAgeMs: options.retentionMs,
      ...(floor !== undefined ? { keepAfterTxid: floor } : {}),
      ...(maxBytes > 0 ? { maxBytes } : {}),
    }
    const log = this.log.retain(policy)
    result.segments = log.removed
    result.bytesFreed = log.bytesFreed
    return result
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
    const target = tenantDir(this.dataDir, newName)
    if (fs.existsSync(path.join(target, "main.db"))) {
      throw new TenantError("DB_EXISTS", `${target} already holds a database`)
    }
    const copy = await this.forkInto(target, at)
    const parent = this.catalog.getTenant(this.name)
    this.catalog.createTenant({
      name: newName,
      pageSize: copy.pageSize,
      quotaBytes: this.quotaBytes,
      epoch: this.epoch,
      position: copy.position,
      // A branch keeps the parent's per-database overrides. Its file is the parent's file, written
      // under them; a fork of a `foreignKeys = true` database that quietly stopped enforcing them
      // would accept rows the parent never could.
      foreignKeys: parent?.foreignKeys ?? null,
      ackWithoutReplicas: parent?.ackWithoutReplicas ?? null,
      // X2: every fork records where it came from, which is what `bql db branches` reads.
      lineage: { parent: this.name, forkedAt: copy.position.txid },
    })
    return { name: newName, dir: target, txid: copy.position.txid }
  }

  /**
   * The file half of `fork`: this database — as it stands, or as of `at` — written into `target`
   * as a flat `main.db`, with the position a fresh recorder over it starts from. Touches no
   * catalog row, so `reset` can build the replacement beside a branch before it touches the
   * branch at all.
   */
  async forkInto(
    target: string,
    at?: bigint,
  ): Promise<{ pageSize: number; position: Omit<RecorderPosition, "epoch"> }> {
    this.#assertOpen()
    if (at !== undefined && at > this.txid) {
      throw BqlError.badRequest(
        `cannot fork ${this.name} at txid ${at}: it is at ${this.txid}`,
      )
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
      return {
        pageSize: full.pageSize || this.pageSize,
        position: {
          txid,
          checksum: full.checksum,
          dbSizePages: full.pages,
          wal: { salt1: 0, salt2: 0, frame: 0 },
        },
      }
    } finally {
      this.#exclusive = false
      // Same as `snapshot()`: a write that queued behind the fork is waiting on a drain nothing
      // else will schedule.
      if (this.#queue.length > 0) this.#scheduleDrain()
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
    this.#lastRecordVersion = record.version
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
      ...(this.#options.compressLog !== undefined
        ? { compress: this.#options.compressLog }
        : {}),
      ...(this.#options.fsyncSweep ? { sweep: this.#options.fsyncSweep } : {}),
    })
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  /** Flushes, saves the position and marks the tenant cleanly closed. */
  close(): void {
    if (this.#closed) return
    // P5: anything outstanding is filed before the flag goes up, so a clean close leaves a log
    // that explains every transaction this tenant acknowledged.
    this.flushPending()
    this.#closed = true
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new TenantError("CLOSED", `${this.name} was closed while waiting for a txid`))
    }
    this.#waiters = []
    for (const entry of [...this.#readTx]) {
      try {
        this.#closeReadTx(entry)
      } catch {
        // Closing must not throw; a read transaction leaves nothing behind anyway.
      }
    }
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
    // Past this point the log is being put away, so nothing may be filed again — including by a
    // microtask `#scheduleFile` queued before the close began.
    this.#filingStopped = true
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
    // A hard drop files nothing by definition: what is outstanding stays in the WAL, which is
    // exactly what the reconcile is written to find.
    this.#filingStopped = true
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new TenantError("CLOSED", `${this.name} was abandoned while waiting`))
    }
    this.#waiters = []
    for (const entry of this.#takeAll()) {
      entry.reject(new TenantError("CLOSED", `database ${this.name} is closed`))
    }
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
    const txid = this.#capture()
    // A drain is "bring the log up to date now", which is what P5's deferral is the opposite of.
    this.flushPending()
    return txid
  }

  // -------------------------------------------------------------------------

  /** Steps 2–5 of design §4.3. Returns the tenant's txid afterwards. A replica records nothing. */
  #capture(ack?: AckLevel): bigint {
    const recorder = this.recorder
    if (!recorder) return this.position.txid
    const records = recorder.poll()
    if (records.length === 0) return recorder.position.txid
    const txid = recorder.position.txid

    // P5: file it after the client has been answered. The data is already durable — SQLite
    // committed before `#capture` was called — and everything the append serves is an
    // asynchronous consumer, so the client waits for none of it.
    //
    // `ack: "local"` only. `"replica"` and `"quorum"` block on a record having *shipped*, which
    // needs it encoded, so deferring would schedule work the caller is about to wait for.
    if (this.#deferAppend && !this.#closed && (ack ?? this.defaultAck) === "local") {
      for (const record of records) this.#pending.push(record)
      this.#scheduleFile()
      // The rows are committed and visible, so a reader waiting on this txid may proceed now.
      // What is outstanding is the *record*, which no reader of this database is waiting for.
      this.#wake(txid)
      return txid
    }
    // Nothing jumps the queue. A write that is not deferred — `ack: "replica"`, or the flag off —
    // still has to go in *after* anything a deferred write left outstanding, or the log is asked
    // to accept txid 2 while txid 1 is still pending and refuses, correctly.
    this.flushPending()
    this.#file(records)
    return txid
  }

  /** Encode, append, save the position, and tell the subscribers. The deferred half of P5. */
  #file(records: TxnRecordInput[]): void {
    if (records.length === 0) return
    // P9. This runs *before* `#publish`, and `#publish` is what drains the capture buffer through
    // the realtime layer's `afterCommit` — so the rows are still in hand here, and whichever of
    // the two paths reaches them first must leave the other something to publish. The recorder
    // drains once and stages what it drained for `afterCommit`; see `TenantRealtime.recordLogical`.
    const logical = this.#logicalRecorder?.(records.map((record) => record.txid)) ?? null
    const events: CommitEvent[] = []
    for (let i = 0; i < records.length; i++) {
      const record = records[i] as TxnRecordInput
      const rows = logical?.[i]
      if (rows) record.logical = rows
      const bytes = this.log.append(record)
      events.push({ txid: record.txid, record, bytes })
    }
    // Ordered after the append, and it must stay there: the reconcile takes the position from the
    // log's last record, so a catalog position *ahead* of the log would make it skip records that
    // were never written (`docs/p5-deferred-compression.md` §2.2).
    this.#positionDirty = true
    this.#savePosition(Date.now())
    for (const event of events) this.#publish(event)
    this.#wake(this.position.txid)
  }

  #scheduleFile(): void {
    if (this.#filing || this.#pending.length === 0) return
    this.#filing = true
    queueMicrotask(() => {
      this.#filing = false
      this.flushPending()
    })
  }

  /**
   * Everything polled but not yet filed, filed now.
   *
   * Called by the microtask, and **before anything reads the log as a file** — a snapshot, a
   * drain, a close, a replica catching up over `log.iterate`. A snapshot taken with records
   * outstanding would be one the log does not explain, which is the one way this can be got wrong.
   */
  flushPending(): void {
    if (this.#pending.length === 0 || this.#filingStopped) return
    const records = this.#pending.splice(0, this.#pending.length)
    this.#file(records)
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
        this.#report(err)
      }
    }
  }

  /** Where a failure that must not abort what it happened inside of goes. */
  #report(err: unknown): void {
    const onError = this.#options.onError
    if (onError) onError(err)
    else console.error(`bql: ${this.name}`, err)
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
    // **Nothing leaves the WAL before it has been recorded** — design §4.3's precondition on
    // checkpointing ("the log has shipped past mxFrame"), and since P5 it has to be *made* true
    // here rather than assumed. `#capture` used to append before returning; with `deferAppend` it
    // may have left the record in `#pending` instead, and a checkpoint would then fold frames the
    // log cannot explain into the database file. A crash there leaves a database ahead of its log
    // with no WAL left to re-derive from, which is the one state the reconcile cannot repair —
    // it reads as `LOG_DIVERGED`. Checkpoints are rare (`checkpointWalBytes`), so the flush costs
    // the write path nothing it was not about to pay.
    this.flushPending()
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

/**
 * `PRAGMA cache_size` takes KiB when negative and pages when positive; bql.sh configures bytes and
 * converts here, so an operator never has to know which. Everything else is applied only when it
 * was asked for — an unset key means "whatever the library does", not "the value we think it is".
 */
function applyPragmas(db: Database, pragmas: SqlitePragmas | undefined, writer: boolean): void {
  if (!pragmas) return
  const cacheBytes = writer ? pragmas.writerCacheBytes : pragmas.readerCacheBytes
  if (cacheBytes !== undefined && cacheBytes > 0) {
    db.exec(`pragma cache_size = -${Math.max(1, Math.floor(cacheBytes / 1024))}`)
  }
  // Readers only: the writer measured no gain from it, and a mapped page is one more way to die.
  if (!writer && pragmas.readerMmapBytes !== undefined && pragmas.readerMmapBytes > 0) {
    db.exec(`pragma mmap_size = ${Math.floor(pragmas.readerMmapBytes)}`)
  }
  if (pragmas.foreignKeys !== undefined) {
    db.exec(`pragma foreign_keys = ${pragmas.foreignKeys ? "on" : "off"}`)
  }
  if (pragmas.trustedSchema !== undefined) {
    db.exec(`pragma trusted_schema = ${pragmas.trustedSchema ? "on" : "off"}`)
  }
  if (pragmas.cellSizeCheck !== undefined) {
    db.exec(`pragma cell_size_check = ${pragmas.cellSizeCheck ? "on" : "off"}`)
  }
  if (pragmas.defensive !== undefined) {
    // No pragma exists for this one; it is `sqlite3_db_config`, which is variadic, which bun:ffi
    // cannot call — so it goes through the vendored artefact's non-variadic shim and is absent on
    // a system libsqlite3 (`docs/p1-pragmas.md`).
    const settled = db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", pragmas.defensive ? 1 : 0)
    if (settled === null && pragmas.defensive) {
      // Refuse rather than harden silently-not: a node told to be defensive that quietly is not is
      // worse than one that will not start.
      throw new Error(
        "[sqlite] defensive needs the vendored libsqlite3 (bun run sqlite:build): " +
          "SQLITE_DBCONFIG_DEFENSIVE has no pragma and this build has no bql_db_config_int",
      )
    }
  }
}

function openConnection(
  dbPath: string,
  options: TenantOptions,
  role: { writer: boolean },
): Database {
  const db = Database.open(dbPath, {
    busyTimeoutMs: options.busyTimeoutMs ?? 5000,
    wal: false,
    // P7: the ceiling is per connection, so the writer and every pooled reader each get one of
    // this size. Absent, the driver's own default of 64 applies and nothing changes.
    ...(options.sqlite?.statementCache !== undefined
      ? { statementCache: options.sqlite.statementCache }
      : {}),
    ...(options.statementCacheCounters !== undefined
      ? { cacheCounters: options.statementCacheCounters }
      : {}),
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
    applyPragmas(db, options.sqlite, role.writer)
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
function txBusy(name: string): BqlError {
  return new BqlError("TX_BUSY", `${name} already has an open transaction`, 409)
}

/**
 * The caller of a queued write went away before the writer reached it. It is a 499-shaped event
 * with no 499 in the vocabulary, and nobody is listening for the answer anyway — what matters is
 * that the entry is off the queue and its bytes are back.
 */
function abandonedWrite(name: string): BqlError {
  return new BqlError("BAD_REQUEST", `the caller of a queued write on ${name} disconnected`, 400)
}

function noTx(name: string): BqlError {
  return new BqlError("TX_NOT_FOUND", `${name} has no open transaction`, 404)
}

/** SQLite's out-of-space code is the tenant's quota (design §4.7, §6.6). */
function translateWriteError(err: unknown, name: string): unknown {
  if (err instanceof SqliteError && err.code.startsWith("SQLITE_FULL")) {
    return BqlError.quotaExceeded(`database ${name} has reached its storage quota`)
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
  const applier = new WalApplier({
    dbPath,
    dir: options.dir,
    fsync: "each",
    ...(options.applyMechanism ? { mechanism: options.applyMechanism } : {}),
    ...(options.applyBusyMs !== undefined ? { busyMs: options.applyBusyMs } : {}),
  })
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
    // **At txid 0 the catalog is the position, not the file.** A database SQLite has merely
    // *opened* holds the header page it writes on entering WAL mode, and that page belongs to no
    // transaction — so a database created, closed and reopened without a write stands at "0 pages,
    // checksum 0" while `computeFull` of its file says 1 page and a non-zero checksum. Letting the
    // file decide made record 1 carry that checksum as its `preChecksum`, and a replica
    // bootstrapping from nothing refused it, correctly:
    //
    //   ChecksumMismatch: pre-transaction checksum mismatch at txid 1:
    //     expected 80adc3c53d5dd66b, computed 0
    //
    // `openApplier` above already states this rule for the replica half; this is the primary half,
    // and `snapshot()` and `restoreFromBucket` each carry their own copy of it. Only when there is
    // no catalog row at all does the file get a say, because then there is nothing else to ask.
    return {
      recorder: TxnRecorder.open({
        dbPath,
        epoch,
        ...(base ? { txid: 0n, checksum: base.checksum, dbSizePages: base.dbSizePages } : {}),
      }),
      applier: null,
      outcome: "clean",
    }
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
          "The database was changed outside bql.sh; restore it instead.",
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
  const applier = new WalApplier({
    dbPath,
    dir: options.dir,
    fsync: "each",
    ...(options.applyMechanism ? { mechanism: options.applyMechanism } : {}),
    ...(options.applyBusyMs !== undefined ? { busyMs: options.applyBusyMs } : {}),
  })
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
