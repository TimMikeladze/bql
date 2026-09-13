// Replica apply, design §4.5, in both of the mechanisms that section names.
// `docs/c5-apply-pages.md` is the decision; this is the code.
//
//   "pages" (A, the default) writes the primary's pages straight into the replica's database file
//   and rewrites the wal-index header under SQLite's own WAL locks, so the replica's `-wal` is
//   always zero bytes and a reader never rescans anything.
//
//   "wal" (B) appends the pages to the replica's *own* `-wal` with local salts and a recomputed
//   checksum chain, then zeroes the first 136 bytes of the `-shm` so the next reader rebuilds the
//   wal-index from the WAL file itself. Proven in `experiments/walproto.ts`; kept as the back-out
//   and as the fallback for a VFS that cannot offer `xShmLock`.
//
// Both produce the same database and are proved by the same checksum chain. Nothing outside
// `apply`, `position`, `seed`, `checkpoint` and `verify` leaks which one ran.
//
// Invariant: verify before writing. The rolling checksum the record claims is reproduced from the
// replica's own pre-images first; if it disagrees, nothing is written and the replica is exactly
// as it was. Design §4.5 describes verifying after the apply — doing it first is strictly safer
// and observationally identical to a caller. The crash-resume path of `docs/c5-apply-pages.md`
// §4.4 does not weaken it: it writes nothing either. It only *adopts* a record whose pages the
// database file already holds byte for byte, and only once `computeFull` has proved the whole
// database against that record's `postChecksum`.
//
// Caller's responsibility (design §4.5, "reader coordination"): under `"wal"`, `checkpoint()`
// takes the exclusive WAL locks, so it must not be called while a local reader holds an open read
// transaction. Under `"pages"` the applier takes those locks itself and answers `ApplyBusy` rather
// than writing under a reader.

import fs from "node:fs"
import path from "node:path"
import {
  type CheckpointMode,
  type CheckpointResult,
  Database,
} from "../sqlite/index.ts"
import {
  type Checksum,
  checkFrame,
  databasePageCount,
  databasePageSize,
  encodeFrame,
  encodeWalHeader,
  headerChecksum,
  parseWalHeader,
  randomSalt,
  SHM_HEADER_SIZE,
  WAL_FRAME_HEADER_SIZE,
  WAL_HEADER_SIZE,
  type WalHeader,
  walFrameSize,
} from "./codec.ts"
import {
  ApplyBusy,
  ChecksumMismatch,
  EpochRegression,
  PositionMismatch,
  WalFormatError,
} from "./errors.ts"
import {
  computeFull,
  foldTransaction,
  LivePageSource,
  pageHash,
  RollingChecksum,
  type TransactionFold,
  type TxnRecord,
} from "./record.ts"
import {
  encodeCkptInfo,
  encodeWalIndexHeader,
  readWalIndexHeader,
  WALINDEX_CKPT_OFFSET,
  WALINDEX_HDR_COPY_SIZE,
  WALINDEX_HDR_SIZE,
  WALINDEX_LOCK_OFFSET,
} from "./shm.ts"
import { WalLocks, type WalLocksUnavailable } from "./shmlock.ts"

/** Everything a replica needs to prove where it stands. `(txid, postChecksum)` is the position. */
export interface ReplicaPosition {
  txid: bigint
  epoch: number
  postChecksum: bigint
  dbSizePages: number
  pageSize: number
}

const META_VERSION = 1

/** Which of design §4.5's two mechanisms an applier uses. */
export type ApplyMechanism = "pages" | "wal"

/**
 * Default for `[replication] applyBusyMs`: how long **one** apply attempt spins for the WAL lock
 * set before deferring.
 *
 * 25 ms, not the 5000 it was. The spin is `Bun.sleepSync`, so every millisecond of it is a
 * millisecond of this thread's event loop — and the patience it was buying already exists, without
 * the block: `ReplicaClient.#apply` puts a deferred record back on the queue and retries, for as
 * long as it takes. Five seconds of spinning was therefore not five seconds of extra tolerance, it
 * was five seconds of a stalled node, and R10 turned that from a rare condition into one a client
 * can hold open on purpose (`docs/r10-read-transactions.md` §2.3).
 *
 * 25 ms is comfortably longer than any ordinary read, so a normal replica still applies inside the
 * first attempt and never reaches the retry path at all.
 */
export const DEFAULT_APPLY_BUSY_MS = 25

const BACKOFF_START_MS = 1
const BACKOFF_MAX_MS = 32

/**
 * How hard `meta.json` is pushed to disk after each apply. `"each"` fsyncs the temp file and the
 * directory, so the position survives a power cut. `"rename"` relies on the rename alone, which is
 * atomic and so survives a process crash but not a power cut — a position that ends up behind is
 * recoverable, because re-applying a record the replica already has raises `PositionMismatch`
 * rather than corrupting anything. `"rename"` costs roughly 150 µs less per transaction.
 */
export type MetaFsyncPolicy = "each" | "rename"

export interface WalApplierOptions {
  /** The replica database file. Created empty when missing. */
  dbPath: string
  /** Directory holding `meta.json`; usually the database's own directory. */
  dir: string
  /** Durability of the position file. Default `"each"`. */
  fsync?: MetaFsyncPolicy
  /**
   * Which mechanism to prefer. Default `"pages"`. `"pages"` degrades to `"wal"` when the VFS
   * cannot offer `xShmLock`; `mechanism` reports what is actually running.
   */
  mechanism?: ApplyMechanism
  /** How long one apply attempt spins for the WAL lock set before `ApplyBusy`. Default 25. */
  busyMs?: number
  /** Where the one-line notice about falling back to mechanism B goes. Default `console.warn`. */
  warn?: (message: string) => void
}

export class WalApplier {
  readonly dbPath: string
  readonly dir: string
  readonly fsyncPolicy: MetaFsyncPolicy
  /** What was asked for, before any fallback. */
  readonly requestedMechanism: ApplyMechanism
  readonly busyMs: number
  readonly #warn: (message: string) => void

  #txid = 0n
  #epoch = 0
  #checksum = new RollingChecksum()
  #pageSize = 0
  #source: LivePageSource | null = null

  #walFd: number | null = null
  #walHeader: WalHeader | null = null
  #walOffset = WAL_HEADER_SIZE
  #walRunning: Checksum = [0, 0]

  #db: Database | null = null
  #closed = false

  // ── mechanism A state ────────────────────────────────────────────────────
  #mechanism: ApplyMechanism
  #fallback: WalLocksUnavailable | null = null
  #locks: WalLocks | null = null
  #dbFd: number | null = null
  #shmFd: number | null = null
  #shmTailZeroed = false
  #pagesReady = false
  /** A clean apply since this applier was opened rules the crash-resume path out. */
  #appliedSinceOpen = false
  #resumeAttempted = false

  constructor(options: WalApplierOptions) {
    this.dbPath = options.dbPath
    this.dir = options.dir
    this.fsyncPolicy = options.fsync ?? "each"
    this.requestedMechanism = options.mechanism ?? "pages"
    this.busyMs = options.busyMs ?? DEFAULT_APPLY_BUSY_MS
    this.#warn = options.warn ?? ((message) => console.warn(message))
    this.#mechanism = this.requestedMechanism
    this.#load()
  }

  /** The mechanism actually in use, after any fallback. */
  get mechanism(): ApplyMechanism {
    return this.#mechanism
  }

  /** Why `"pages"` degraded to `"wal"`, or null when it did not. */
  get fallbackReason(): WalLocksUnavailable | null {
    return this.#fallback
  }

  get position(): ReplicaPosition {
    return {
      txid: this.#txid,
      epoch: this.#epoch,
      postChecksum: this.#checksum.value,
      dbSizePages: this.#source?.sizePages ?? 0,
      pageSize: this.#pageSize,
    }
  }

  get metaPath(): string {
    return path.join(this.dir, "meta.json")
  }

  get walPath(): string {
    return `${this.dbPath}-wal`
  }

  /**
   * Declares where the replica starts, for a database that was just copied from a snapshot. The
   * checksum must be the snapshot's, or the first record's `preChecksum` check will reject it.
   */
  seed(position: {
    txid: bigint
    epoch?: number
    postChecksum: bigint
    dbSizePages?: number
    pageSize?: number
  }): void {
    this.#txid = position.txid
    this.#epoch = position.epoch ?? this.#epoch
    this.#checksum.set(position.postChecksum)
    if (position.pageSize) this.#pageSize = position.pageSize
    this.#source = null
    if (position.dbSizePages !== undefined) {
      this.#ensureSource().sizePages = position.dbSizePages
    }
    this.#persist()
  }

  /**
   * Applies one transaction record. Throws `PositionMismatch` when the record does not follow the
   * replica's current txid, `EpochRegression` for a record from a deposed primary, `ApplyBusy`
   * when a local reader held a read transaction for longer than `busyMs`, and `ChecksumMismatch`
   * when the replica's own pre-images do not reproduce the record's checksums — in every case
   * having written nothing.
   */
  apply(record: TxnRecord): void {
    this.#assertOpen()
    if (record.prevTxid !== this.#txid) {
      throw new PositionMismatch(this.#txid, record.prevTxid)
    }
    if (record.epoch < this.#epoch) {
      throw new EpochRegression(this.#epoch, record.epoch)
    }
    if (this.#pageSize === 0) this.#pageSize = record.pageSize
    if (record.pageSize !== this.#pageSize) {
      throw new WalFormatError(
        `record page size ${record.pageSize} does not match the replica's ${this.#pageSize}`,
      )
    }

    const source = this.#ensureSource()
    // Mechanism B's page source overlays the frames its own WAL holds, so the WAL has to be
    // reconciled before any pre-image is read. Mechanism A keeps that WAL empty and the file
    // authoritative, so it reconciles nothing and reads straight through.
    if (this.#mechanism === "wal") this.#ensureWal()
    else this.#preparePages(record.txid)

    let fold: TransactionFold | null = null
    let phase: "pre" | "post" = "pre"
    let actual = this.#checksum.value
    if (record.preChecksum === this.#checksum.value) {
      fold = foldTransaction(this.#checksum, source, {
        pages: record.pages,
        commitSizePages: record.commitSizePages,
      })
      phase = "post"
      actual = fold.checksum
    }
    if (fold === null || fold.checksum !== record.postChecksum) {
      if (this.#canResume(record)) {
        this.#resume(record, source)
        return
      }
      throw new ChecksumMismatch(
        record.txid,
        phase,
        phase === "pre" ? record.preChecksum : record.postChecksum,
        actual,
      )
    }

    if (this.#mechanism === "pages") {
      this.#writeUnderLocks(record)
    } else {
      this.#writeFrames(record)
      this.#invalidateShm()
    }

    fold.commit()
    this.#txid = record.txid
    this.#epoch = record.epoch
    this.#appliedSinceOpen = true
    this.#persist()
  }

  /**
   * Checkpoints the replica through a driver connection. Mechanism B grows the WAL on every
   * apply and resets `nBackfill`, so a replica must checkpoint or its readers pay a full WAL
   * rescan forever. Must not run while a local reader holds an open read transaction.
   *
   * Under mechanism A the WAL is empty by construction, so this is a truthful no-op rather than a
   * refusal — `tenant.ts`'s idle sweep and close path can call it without knowing which mechanism
   * is live.
   */
  checkpoint(mode: CheckpointMode = "TRUNCATE"): CheckpointResult {
    this.#assertOpen()
    if (this.#mechanism === "pages" && this.#walBytes() === 0) {
      return { busy: false, log: 0, checkpointed: 0 }
    }
    const db = this.#connection()
    const result = db.walCheckpoint(mode)
    // The checkpoint may have emptied the WAL underneath us; re-derive rather than assume.
    this.#walHeader = null
    if (this.#mechanism === "wal") this.#ensureWal()
    return result
  }

  /**
   * Recomputes the position's checksum from the replica's own files, for an integrity check. This
   * is the oracle: it reads every page rather than trusting the page source's overlay, so it
   * catches a replica that diverged in a page no recent record touched.
   */
  verify(): boolean {
    this.#assertOpen()
    const full = computeFull(this.dbPath, { includeWal: this.#mechanism === "wal" })
    return full.checksum === this.#checksum.value
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#locks?.unlock()
    this.#locks = null
    if (this.#walFd !== null) {
      fs.closeSync(this.#walFd)
      this.#walFd = null
    }
    if (this.#dbFd !== null) {
      fs.closeSync(this.#dbFd)
      this.#dbFd = null
    }
    if (this.#shmFd !== null) {
      fs.closeSync(this.#shmFd)
      this.#shmFd = null
    }
    this.#source?.close()
    this.#source = null
    this.#db?.close()
    this.#db = null
  }

  // -------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new WalFormatError("applier is closed")
  }

  #connection(): Database {
    if (!this.#db) {
      const db = Database.open(this.dbPath, { wal: false })
      // We own checkpoints; SQLite must not run one behind our back.
      db.exec("pragma wal_autocheckpoint = 0")
      // A pager only opens the WAL once the connection takes a read lock, and
      // `sqlite3_wal_checkpoint_v2` on a connection that has never read is a silent no-op that
      // still returns SQLITE_OK. One trivial read makes the checkpoint real — and, for mechanism
      // A, is what maps the wal-index so `xShmLock` has something to lock.
      db.exec("select count(*) from sqlite_schema")
      this.#db = db
    }
    return this.#db
  }

  #load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.metaPath, "utf8")
    } catch {
      this.#pageSize = this.#pageSizeFromFile()
      return
    }
    const meta = JSON.parse(raw) as {
      version?: number
      txid?: string
      epoch?: number
      postChecksum?: string
      dbSizePages?: number
      pageSize?: number
    }
    if (meta.version !== META_VERSION) {
      throw new WalFormatError(`unsupported replica meta version ${String(meta.version)}`)
    }
    this.#txid = BigInt(meta.txid ?? "0")
    this.#epoch = meta.epoch ?? 0
    this.#checksum.set(BigInt(meta.postChecksum ?? "0"))
    this.#pageSize = meta.pageSize ?? this.#pageSizeFromFile()
    if (this.#pageSize > 0) {
      this.#source = new LivePageSource(this.dbPath, this.#pageSize, meta.dbSizePages ?? 0)
    }
  }

  #persist(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const body = JSON.stringify({
      version: META_VERSION,
      txid: this.#txid.toString(),
      epoch: this.#epoch,
      postChecksum: this.#checksum.value.toString(),
      dbSizePages: this.#source?.sizePages ?? 0,
      pageSize: this.#pageSize,
    })
    const temp = `${this.metaPath}.${process.pid}.tmp`
    const fd = fs.openSync(temp, "w")
    try {
      fs.writeFileSync(fd, body)
      if (this.fsyncPolicy === "each") fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, this.metaPath)
    if (this.fsyncPolicy !== "each") return
    // Durable rename: without this the file can survive a crash while its directory entry does
    // not. Not every filesystem allows fsync on a directory fd; ignoring the failure is correct.
    try {
      const dirFd = fs.openSync(this.dir, "r")
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // best effort
    }
  }

  #pageSizeFromFile(): number {
    try {
      const fd = fs.openSync(this.dbPath, "r")
      try {
        const head = new Uint8Array(100)
        const read = fs.readSync(fd, head, 0, 100, 0)
        if (read < 100) return 0
        return databasePageSize(head) ?? 0
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return 0
    }
  }

  #ensureSource(): LivePageSource {
    if (this.#source && this.#source.pageSize === this.#pageSize) return this.#source
    if (this.#pageSize === 0) {
      throw new WalFormatError(`page size for ${this.dbPath} is not known yet`)
    }
    const previousSize = this.#source?.sizePages
    this.#source?.close()
    const source = new LivePageSource(this.dbPath, this.#pageSize, previousSize ?? 0)
    if (previousSize === undefined) source.sizePages = this.#sizeFromFile()
    this.#source = source
    return source
  }

  /** Page count of the replica database file, for a replica that has no meta yet. */
  #sizeFromFile(): number {
    try {
      const stat = fs.statSync(this.dbPath)
      if (stat.size === 0 || this.#pageSize === 0) return 0
      const fd = fs.openSync(this.dbPath, "r")
      try {
        const head = new Uint8Array(100)
        fs.readSync(fd, head, 0, 100, 0)
        return databasePageCount(head) ?? Math.floor(stat.size / this.#pageSize)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return 0
    }
  }

  #walBytes(): number {
    try {
      return fs.statSync(this.walPath).size
    } catch {
      return 0
    }
  }

  // ── mechanism A ──────────────────────────────────────────────────────────

  /**
   * Brings the replica into the state mechanism A requires — an empty `-wal`, a connection whose
   * wal-index is mapped, and a resolved `xShmLock` — or falls back to mechanism B and says why.
   * Runs once per applier.
   */
  #preparePages(txid: bigint): void {
    if (this.#pagesReady) return

    const connection = this.#connection()
    // A replica that ran mechanism B until the config changed has frames in its own WAL. Fold
    // them into the database file, which is where A expects every page to be.
    if (this.#walBytes() > WAL_HEADER_SIZE) {
      connection.walCheckpoint("TRUNCATE")
      if (this.#walBytes() > WAL_HEADER_SIZE) {
        // A reader held the WAL against the checkpoint. Nothing of the record has been written;
        // the caller retries, exactly as it does for a busy lock.
        throw new ApplyBusy(txid, 0)
      }
    }

    const { locks, probe } = WalLocks.open(connection)
    if (!locks) {
      this.#mechanism = "wal"
      this.#fallback = probe.reason
      this.#warn(
        `bunql: ${this.dbPath}: this VFS cannot offer xShmLock (${probe.reason}); ` +
          "replica apply falls back to mechanism B, which rebuilds the wal-index on every read. " +
          "docs/c5-apply-pages.md §4.6",
      )
      this.#ensureWal()
      return
    }
    this.#locks = locks
    // The database file is authoritative under A: whatever the overlay held belonged to a WAL
    // that has just been folded away.
    this.#source?.resetOverlay()
    this.#walHeader = null
    this.#walOffset = WAL_HEADER_SIZE
    this.#walRunning = [0, 0]
    this.#pagesReady = true
  }

  #dbDescriptor(): number {
    if (this.#dbFd === null) this.#dbFd = fs.openSync(this.dbPath, "r+")
    return this.#dbFd
  }

  #shmDescriptor(): number | null {
    if (this.#shmFd !== null) return this.#shmFd
    try {
      this.#shmFd = fs.openSync(`${this.dbPath}-shm`, "r+")
    } catch {
      return null
    }
    return this.#shmFd
  }

  /**
   * Takes the WAL lock set, writes the record's pages into the database file, publishes a
   * wal-index header that says "the WAL is empty, the file is the database", and releases.
   * `docs/c5-apply-pages.md` §4.3.
   */
  #writeUnderLocks(record: TxnRecord): void {
    const locks = this.#locks
    if (!locks) throw new WalFormatError("mechanism A has no WAL locks")
    this.#acquire(locks, record.txid)
    try {
      this.#writePages(record)
      this.#writeWalIndexHeader(record.commitSizePages)
    } finally {
      locks.unlock()
    }
  }

  /**
   * Spins for the lock set with a bounded backoff. `SQLITE_BUSY` here means a local reader is
   * mid-transaction, which is expected rather than exceptional; `ApplyBusy` is raised only when it
   * outlasts `busyMs`, and it is raised before a single byte has been written.
   *
   * The spin is synchronous — `xShmLock` has no other form — so `busyMs` is deliberately short and
   * the real patience is the caller's asynchronous retry. See `DEFAULT_APPLY_BUSY_MS`.
   */
  #acquire(locks: WalLocks, txid: bigint): void {
    if (locks.tryLock()) return
    const deadline = Date.now() + this.busyMs
    let wait = BACKOFF_START_MS
    while (Date.now() < deadline) {
      Bun.sleepSync(wait + Math.random() * wait)
      if (locks.tryLock()) return
      wait = Math.min(wait * 2, BACKOFF_MAX_MS)
    }
    throw new ApplyBusy(txid, this.busyMs)
  }

  /** `pwrite` every page, shrink the file when the transaction did, and make it durable. */
  #writePages(record: TxnRecord): void {
    const fd = this.#dbDescriptor()
    const pgnos = [...record.pages.keys()].sort((a, b) => a - b)
    for (const pgno of pgnos) {
      const page = record.pages.get(pgno) as Uint8Array
      fs.writeSync(fd, page, 0, this.#pageSize, (pgno - 1) * this.#pageSize)
    }
    const bytes = record.commitSizePages * this.#pageSize
    if (fs.fstatSync(fd).size > bytes) fs.ftruncateSync(fd, bytes)
    fs.fdatasyncSync(fd)
  }

  /**
   * Publishes a wal-index header describing an empty WAL over a database of `nPage` pages, so the
   * next reader takes `WAL_READ_LOCK(0)` and reads the file directly — no recovery, no rescan.
   * Copy 1 and the `WalCkptInfo` go first as one contiguous write, then copy 0, which is the order
   * `walIndexWriteHdr` uses so that a reader catching a half-written header sees the two copies
   * disagree and retries.
   */
  #writeWalIndexHeader(nPage: number): void {
    const fd = this.#shmDescriptor()
    // No `-shm` means nobody has the database open, and the first reader will build the index
    // from the (empty) WAL anyway.
    if (fd === null) return

    const current = new Uint8Array(WALINDEX_HDR_COPY_SIZE)
    const read = fs.readSync(fd, current, 0, WALINDEX_HDR_COPY_SIZE, 0)
    const previous = read === WALINDEX_HDR_COPY_SIZE ? readWalIndexHeader(current) : null
    const header = encodeWalIndexHeader({
      iChange: ((previous?.iChange ?? 0) + 1) >>> 0,
      pageSize: this.#pageSize,
      mxFrame: 0,
      nPage,
    })

    const second = new Uint8Array(WALINDEX_LOCK_OFFSET - WALINDEX_HDR_COPY_SIZE)
    second.set(header, 0)
    second.set(encodeCkptInfo(0), WALINDEX_CKPT_OFFSET - WALINDEX_HDR_COPY_SIZE)
    fs.writeSync(fd, second, 0, second.byteLength, WALINDEX_HDR_COPY_SIZE)
    fs.writeSync(fd, header, 0, WALINDEX_HDR_COPY_SIZE, 0)

    if (!this.#shmTailZeroed) {
      // `nBackfillAttempted` and `notUsed0`, past the eight lock bytes at 120 — which are never
      // written, because the amalgamation says they must not be.
      const tail = new Uint8Array(WALINDEX_HDR_SIZE - (WALINDEX_LOCK_OFFSET + 8))
      fs.writeSync(fd, tail, 0, tail.byteLength, WALINDEX_LOCK_OFFSET + 8)
      this.#shmTailZeroed = true
    }
  }

  // ── crash resume (docs/c5-apply-pages.md §4.4) ───────────────────────────

  /**
   * A checksum check may fail after a crash between the page write and the position write, because
   * mechanism A's pages are durable before `meta.json` moves. The tell is positive and cheap to
   * look for: **every page the record carries is already in the database file, byte for byte, and
   * the file is already `commitSizePages` long.** A record that merely disagrees with the replica
   * cannot look like that, so this never fires on divergence.
   *
   * Allowed once, only before any record has applied cleanly, and only for a record whose position
   * and epoch already checked out.
   */
  #canResume(record: TxnRecord): boolean {
    if (this.#mechanism !== "pages" || this.#appliedSinceOpen || this.#resumeAttempted) return false
    const fd = this.#dbDescriptor()
    if (fs.fstatSync(fd).size !== record.commitSizePages * this.#pageSize) return false
    const buf = new Uint8Array(this.#pageSize)
    for (const [pgno, page] of record.pages) {
      if (pgno > record.commitSizePages) return false
      const read = fs.readSync(fd, buf, 0, this.#pageSize, (pgno - 1) * this.#pageSize)
      if (read !== this.#pageSize) return false
      for (let i = 0; i < this.#pageSize; i++) {
        if (buf[i] !== page[i]) return false
      }
    }
    return true
  }

  /**
   * Adopts a record the database file already holds, after proving the **whole database** against
   * its `postChecksum` with `computeFull`. **Writes nothing** — not one page, not the wal-index
   * header — so the applier's "verify before writing" invariant survives the crash path intact. A
   * replica that diverged fails the same check and raises `ChecksumMismatch`, which is the signal
   * to re-snapshot.
   */
  #resume(record: TxnRecord, source: LivePageSource): void {
    this.#resumeAttempted = true
    const full = computeFull(this.dbPath, { includeWal: false })
    if (full.checksum !== record.postChecksum) {
      throw new ChecksumMismatch(record.txid, "post", record.postChecksum, full.checksum)
    }
    this.#checksum.set(record.postChecksum)
    source.resetOverlay()
    source.sizePages = record.commitSizePages
    this.#txid = record.txid
    this.#epoch = record.epoch
    this.#appliedSinceOpen = true
    this.#persist()
  }

  // ── mechanism B ──────────────────────────────────────────────────────────

  #walDescriptor(): number {
    if (this.#walFd !== null) return this.#walFd
    try {
      this.#walFd = fs.openSync(this.walPath, "r+")
    } catch {
      this.#walFd = fs.openSync(this.walPath, "w+")
    }
    return this.#walFd
  }

  /**
   * Brings the in-memory WAL state in line with the file, reading only. Handles the three ways the
   * file can change underneath us: a TRUNCATE checkpoint empties it, a foreign writer re-salts it,
   * and a fresh replica has no WAL at all. Writing the new header is left to `#writeFrames`, so a
   * record that fails verification leaves the replica byte for byte as it was.
   */
  #ensureWal(): void {
    const fd = this.#walDescriptor()
    const size = fs.fstatSync(fd).size

    if (size >= WAL_HEADER_SIZE) {
      const head = new Uint8Array(WAL_HEADER_SIZE)
      fs.readSync(fd, head, 0, WAL_HEADER_SIZE, 0)
      const header = parseWalHeader(head)
      if (header && header.pageSize === this.#pageSize) {
        const current = this.#walHeader
        if (
          current &&
          current.salt1 === header.salt1 &&
          current.salt2 === header.salt2 &&
          size === this.#walOffset
        ) {
          return
        }
        this.#rescanWal(fd, header, size)
        return
      }
    }

    // No usable WAL. Everything the old one held is in the database file, which the page source
    // reads; the header itself is written on the next frame.
    this.#walHeader = null
    this.#walOffset = WAL_HEADER_SIZE
    this.#walRunning = [0, 0]
    this.#source?.resetOverlay()
  }

  /** Writes a fresh WAL header with new random salts over whatever was there. */
  #startWal(fd: number): WalHeader {
    if (this.#pageSize === 0) {
      throw new WalFormatError(`cannot start a WAL for ${this.dbPath}: page size unknown`)
    }
    const { bytes, header } = encodeWalHeader({
      pageSize: this.#pageSize,
      salt1: randomSalt(),
      salt2: randomSalt(),
    })
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, bytes, 0, WAL_HEADER_SIZE, 0)
    this.#walHeader = header
    this.#walOffset = WAL_HEADER_SIZE
    this.#walRunning = headerChecksum(header)
    return header
  }

  /** Recovers the running checksum and the page overlay by walking the WAL that is on disk. */
  #rescanWal(fd: number, header: WalHeader, size: number): void {
    const frameSize = walFrameSize(header.pageSize)
    const frame = new Uint8Array(frameSize)
    let running = headerChecksum(header)
    let offset = WAL_HEADER_SIZE
    const source = this.#source
    source?.resetOverlay()

    while (offset + frameSize <= size) {
      fs.readSync(fd, frame, 0, frameSize, offset)
      const check = checkFrame(frame, 0, header, running)
      if (!check.valid) break
      running = check.next
      offset += frameSize
      source?.record(
        check.header.pgno,
        pageHash(check.header.pgno, frame.subarray(WAL_FRAME_HEADER_SIZE)),
      )
    }
    if (offset < size) fs.ftruncateSync(fd, offset)
    this.#walHeader = header
    this.#walOffset = offset
    this.#walRunning = running
  }

  #writeFrames(record: TxnRecord): void {
    const fd = this.#walDescriptor()
    const header = this.#walHeader ?? this.#startWal(fd)
    const pgnos = [...record.pages.keys()].sort((a, b) => a - b)
    const frameSize = walFrameSize(header.pageSize)
    const out = new Uint8Array(frameSize * pgnos.length)
    let running = this.#walRunning

    for (let i = 0; i < pgnos.length; i++) {
      const pgno = pgnos[i] as number
      const page = record.pages.get(pgno) as Uint8Array
      running = encodeFrame(
        out,
        i * frameSize,
        {
          pgno,
          // Only the last frame commits, and it carries the database size in pages.
          commitSize: i === pgnos.length - 1 ? record.commitSizePages : 0,
          page,
        },
        header,
        running,
      )
    }

    fs.writeSync(fd, out, 0, out.byteLength, this.#walOffset)
    fs.fdatasyncSync(fd)
    this.#walOffset += out.byteLength
    this.#walRunning = running
  }

  /**
   * Zeroes the wal-index header so the next reader runs SQLite's own recovery and rebuilds the
   * index from the WAL file. Same trick LiteFS uses. Absent `-shm` means nobody has the database
   * open, and the first reader will build the index from scratch anyway.
   */
  #invalidateShm(): void {
    const shm = `${this.dbPath}-shm`
    let fd: number
    try {
      fd = fs.openSync(shm, "r+")
    } catch {
      return
    }
    try {
      fs.writeSync(fd, new Uint8Array(SHM_HEADER_SIZE), 0, SHM_HEADER_SIZE, 0)
    } finally {
      fs.closeSync(fd)
    }
  }
}
