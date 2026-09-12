// Replica apply, mechanism B of design §4.5: append the primary's pages to the replica's *own*
// `-wal` with local salts and a recomputed checksum chain, fdatasync, then zero the first 136
// bytes of the `-shm` so the next reader rebuilds the wal-index from the WAL file itself. Proven
// in `experiments/walproto.ts`. Mechanism A (page apply under SQLite's own WAL locks) will
// implement this same class later; nothing outside `apply`, `position` and `checkpoint` leaks.
//
// Invariant: verify before writing. The rolling checksum the record claims is reproduced from the
// replica's own pre-images first; if it disagrees, nothing is written and the replica is exactly
// as it was. Design §4.5 describes verifying after the apply — doing it first is strictly safer
// and observationally identical to a caller.
//
// Caller's responsibility (design §4.5, "reader coordination"): `checkpoint()` takes the
// exclusive WAL locks, so it must not be called while a local reader holds an open read
// transaction. The applier documents this and does not police it.

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
import { ChecksumMismatch, EpochRegression, PositionMismatch, WalFormatError } from "./errors.ts"
import {
  foldTransaction,
  LivePageSource,
  pageHash,
  RollingChecksum,
  type TxnRecord,
} from "./record.ts"

/** Everything a replica needs to prove where it stands. `(txid, postChecksum)` is the position. */
export interface ReplicaPosition {
  txid: bigint
  epoch: number
  postChecksum: bigint
  dbSizePages: number
  pageSize: number
}

const META_VERSION = 1

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
}

export class WalApplier {
  readonly dbPath: string
  readonly dir: string
  readonly fsyncPolicy: MetaFsyncPolicy

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

  constructor(options: WalApplierOptions) {
    this.dbPath = options.dbPath
    this.dir = options.dir
    this.fsyncPolicy = options.fsync ?? "each"
    this.#load()
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
   * replica's current txid, `EpochRegression` for a record from a deposed primary, and
   * `ChecksumMismatch` when the replica's own pre-images do not reproduce the record's
   * checksums — in every case having written nothing.
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
    this.#ensureWal()

    if (record.preChecksum !== this.#checksum.value) {
      throw new ChecksumMismatch(record.txid, "pre", record.preChecksum, this.#checksum.value)
    }
    const fold = foldTransaction(this.#checksum, source, {
      pages: record.pages,
      commitSizePages: record.commitSizePages,
    })
    if (fold.checksum !== record.postChecksum) {
      throw new ChecksumMismatch(record.txid, "post", record.postChecksum, fold.checksum)
    }

    this.#writeFrames(record)
    this.#invalidateShm()

    fold.commit()
    this.#txid = record.txid
    this.#epoch = record.epoch
    this.#persist()
  }

  /**
   * Checkpoints the replica through a driver connection. Mechanism B grows the WAL on every
   * apply and resets `nBackfill`, so a replica must checkpoint or its readers pay a full WAL
   * rescan forever. Must not run while a local reader holds an open read transaction.
   */
  checkpoint(mode: CheckpointMode = "TRUNCATE"): CheckpointResult {
    this.#assertOpen()
    const db = this.#connection()
    const result = db.walCheckpoint(mode)
    // The checkpoint may have emptied the WAL underneath us; re-derive rather than assume.
    this.#walHeader = null
    this.#ensureWal()
    return result
  }

  /** Recomputes the position's checksum from the replica's files, for an integrity check. */
  verify(): boolean {
    this.#assertOpen()
    const source = this.#ensureSource()
    const rolling = new RollingChecksum()
    for (let pgno = 1; pgno <= source.sizePages; pgno++) {
      const hash = source.hash(pgno)
      if (hash === null) return false
      rolling.applyHash(pgno, 0n, hash)
    }
    return rolling.value === this.#checksum.value
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#walFd !== null) {
      fs.closeSync(this.#walFd)
      this.#walFd = null
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
      // still returns SQLITE_OK. One trivial read makes the checkpoint real.
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
