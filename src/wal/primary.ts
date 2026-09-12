// The primary half of the write path: turn committed WAL transactions into transaction records.
// Design §4.3 steps 2 and 3. The tenant owner (M4) drives this after every commit; nothing here
// knows about tenants, logs or replicas.
//
// Invariant: the rolling checksum is folded from pre-images read *before* the transaction's pages
// overwrite them, so `preChecksum` is the database as it was and `postChecksum` is the database
// as it now is. Pre-images come from the page-hash overlay of the live WAL, falling back to a
// pread of the database file — the same two sources design §4.3 names.

import {
  computeFull,
  foldTransaction,
  LivePageSource,
  pageHash,
  RollingChecksum,
  type TxnRecordInput,
} from "./record.ts"
import { WalError } from "./errors.ts"
import {
  type RestoreOutcome,
  scanWalPages,
  type TxnFrames,
  WalTailer,
  type WalPosition,
} from "./tailer.ts"

export interface TxnRecorderOptions {
  /** The primary database file. */
  dbPath: string
  /** Leadership term stamped on every record. */
  epoch?: number
  /** Last txid already recorded. Defaults to 0, i.e. a fresh database. */
  txid?: bigint
  /**
   * Rolling checksum at `txid`. Defaults to the database's current state, computed from the file
   * and its WAL — which is what a fresh primary wants.
   */
  checksum?: bigint
  /** Database size in pages at `txid`. Defaults to the database's current size. */
  dbSizePages?: number
  /**
   * Resume the tailer at a saved WAL position instead of at the current end of the WAL, so
   * transactions that committed while this process was down are re-read rather than skipped
   * (design §4.3, "DB ahead of log"). `checksum` and `dbSizePages` must accompany it, because the
   * database's current state is *not* the state at that position.
   */
  walPosition?: WalPosition
}

export interface RecorderPosition {
  txid: bigint
  epoch: number
  checksum: bigint
  dbSizePages: number
  wal: WalPosition
}

export class TxnRecorder {
  readonly dbPath: string
  readonly tailer: WalTailer

  #txid: bigint
  #epoch: number
  #checksum: RollingChecksum
  #pageSize: number
  #source: LivePageSource | null = null
  #pendingSize: number
  #walRestore: RestoreOutcome | null = null

  private constructor(options: TxnRecorderOptions, pageSize: number, sizePages: number) {
    this.dbPath = options.dbPath
    this.tailer = new WalTailer(`${options.dbPath}-wal`)
    this.#txid = options.txid ?? 0n
    this.#epoch = options.epoch ?? 0
    this.#checksum = new RollingChecksum(options.checksum ?? 0n)
    this.#pageSize = pageSize
    this.#pendingSize = sizePages
  }

  /**
   * Starts recording from the database's current state: the tailer is positioned at the newest
   * commit frame already in the WAL, and the checksum is the database as a reader sees it now.
   */
  static open(options: TxnRecorderOptions): TxnRecorder {
    const walPath = `${options.dbPath}-wal`
    const resuming = options.walPosition !== undefined
    if (resuming && (options.checksum === undefined || options.dbSizePages === undefined)) {
      throw new WalError("resuming at a WAL position needs the checksum and size at that position")
    }

    const scan = scanWalPages(walPath, options.walPosition?.frame)
    const full = resuming ? null : computeFull(options.dbPath)
    const pageSize = full?.pageSize || scan?.header.pageSize || 0
    const sizePages = options.dbSizePages ?? full?.pages ?? 0

    const recorder = new TxnRecorder(
      { ...options, checksum: options.checksum ?? full?.checksum ?? 0n },
      pageSize,
      sizePages,
    )

    const target: WalPosition | null = options.walPosition
      ? options.walPosition
      : scan
        ? { salt1: scan.header.salt1, salt2: scan.header.salt2, frame: scan.frame }
        : null
    if (target) {
      recorder.#walRestore = recorder.tailer.restore(target)
    }
    if (scan && recorder.#walRestore !== "reset") {
      // The database file can lag the WAL; seed the overlay so pre-images come from the WAL.
      const source = recorder.#ensureSource()
      for (const [pgno, page] of scan.pages) source.record(pgno, pageHash(pgno, page))
    }
    return recorder
  }

  /**
   * How the tailer resumed. `"reset"` means the WAL was reset while this recorder was down, so
   * everything up to `txid` is in the database file and the caller should confirm that the
   * database's own checksum matches the last record's `postChecksum` before streaming on.
   */
  get walRestore(): RestoreOutcome | null {
    return this.#walRestore
  }

  get position(): RecorderPosition {
    return {
      txid: this.#txid,
      epoch: this.#epoch,
      checksum: this.#checksum.value,
      dbSizePages: this.#source?.sizePages ?? this.#pendingSize,
      wal: this.tailer.position,
    }
  }

  get pageSize(): number {
    return this.#pageSize
  }

  set epoch(value: number) {
    this.#epoch = value
  }

  get epoch(): number {
    return this.#epoch
  }

  /**
   * Reads every transaction that has committed since the last call and turns each into a record,
   * assigning `txid = last + 1` and folding the rolling checksum forward.
   */
  poll(): TxnRecordInput[] {
    const txns = this.tailer.poll()
    const out: TxnRecordInput[] = []
    for (const txn of txns) out.push(this.record(txn))
    return out
  }

  /** Turns one already-tailed transaction into a record. Advances the position. */
  record(txn: TxnFrames): TxnRecordInput {
    if (this.#pageSize === 0) this.#pageSize = txn.pageSize
    const source = this.#ensureSource()
    if (txn.afterReset) {
      // A RESTART or TRUNCATE checkpoint moved every WAL frame into the database file, so the
      // file is authoritative again and the overlay would only hold stale entries.
      source.resetOverlay()
    }

    const preChecksum = this.#checksum.value
    const fold = foldTransaction(this.#checksum, source, {
      pages: txn.frames,
      commitSizePages: txn.commitSize,
    })

    const record: TxnRecordInput = {
      pageSize: txn.pageSize,
      txid: this.#txid + 1n,
      prevTxid: this.#txid,
      epoch: this.#epoch,
      timestampUs: BigInt(Math.round(performance.timeOrigin * 1000 + performance.now() * 1000)),
      commitSizePages: txn.commitSize,
      frameCount: txn.frameCount,
      walSalt1: txn.walSalt1,
      walSalt2: txn.walSalt2,
      walEndFrame: txn.walEndFrame,
      preChecksum,
      postChecksum: fold.checksum,
      pages: txn.frames,
    }

    fold.commit()
    this.#txid = record.txid
    return record
  }

  close(): void {
    this.tailer.close()
    this.#source?.close()
    this.#source = null
  }

  #ensureSource(): LivePageSource {
    const existing = this.#source
    if (existing && existing.pageSize === this.#pageSize) return existing
    if (existing) {
      this.#pendingSize = existing.sizePages
      existing.close()
    }
    const source = new LivePageSource(this.dbPath, this.#pageSize, this.#pendingSize)
    this.#source = source
    return source
  }
}
