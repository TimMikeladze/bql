// Reads committed transactions out of a live SQLite `-wal` file.
//
// Invariant: the confirmed position moves only at commit frames. Inside an uncommitted
// transaction SQLite rewrites frame slots in place and recomputes their checksums, so a frame
// that verified a moment ago may hold different bytes now. Every poll therefore re-scans from the
// last confirmed commit frame, and anything read past the newest commit is thrown away.
//
// A salt change in the header means the WAL was reset (salt1 increments, salt2 is re-randomised
// on the first write after a RESTART or TRUNCATE checkpoint): restart at frame 1.
//
// Frames are verified through `checkFrameFast`, which is `codec.checkFrame` in C when the vendored
// libsqlite3 carries `scripts/native/walsum.c` and the JavaScript otherwise. Identical results
// either way; it is 4.5 µs a frame, which is most of a poll. `docs/p3-wal-checksum.md`.

import fs from "node:fs"
import {
  type Checksum,
  headerChecksum,
  parseWalHeader,
  WAL_FRAME_HEADER_SIZE,
  WAL_HEADER_SIZE,
  type WalHeader,
  walFrameOffset,
  walFrameSize,
} from "./codec.ts"
import { WalFormatError } from "./errors.ts"
import { checkFrameFast } from "./native.ts"

/** Where a tailer stands, in a form that survives a restart. */
export interface WalPosition {
  salt1: number
  salt2: number
  /** 1-based index of the last confirmed commit frame; 0 means "start of this WAL generation". */
  frame: number
}

/** One committed transaction, as read off the WAL. */
export interface TxnFrames {
  /** Last version of every page the transaction wrote, page number to page image. */
  frames: Map<number, Uint8Array>
  /** Page numbers in ascending order — the order `record.encode` writes them. */
  pages: number[]
  /** Database size in pages at the commit. */
  commitSize: number
  pageSize: number
  walSalt1: number
  walSalt2: number
  /** 1-based index of the commit frame in the primary's WAL. */
  walEndFrame: number
  /** Physical frames the transaction wrote, before de-duplicating repeated pages. */
  frameCount: number
  /** True when this is the first transaction of a new WAL generation. */
  afterReset: boolean
}

/** What `restore` found when it tried to resume from a saved position. */
export type RestoreOutcome =
  /** The WAL is the same generation and the position was re-validated frame by frame. */
  | "resumed"
  /** The WAL has been reset since; tailing restarts at frame 1 of the new generation. */
  | "reset"
  /** There is no WAL yet. */
  | "absent"

export class WalTailer {
  readonly path: string

  #fd: number | null = null
  #header: WalHeader | null = null
  /** State at the last confirmed commit frame. */
  #frame = 0
  #offset = WAL_HEADER_SIZE
  #running: Checksum = [0, 0]
  #sawReset = false
  #scratch: Uint8Array = new Uint8Array(0)
  /** Reused across polls: the header is 32 bytes and is re-read on every one of them. */
  #headerScratch: Uint8Array = new Uint8Array(WAL_HEADER_SIZE)

  /** The page size and salts come from the WAL header on the first read; nothing to configure. */
  constructor(walPath: string) {
    this.path = walPath
  }

  /** Page size the current WAL generation uses, or 0 before a header has been read. */
  get pageSize(): number {
    return this.#header?.pageSize ?? 0
  }

  get position(): WalPosition {
    return {
      salt1: this.#header?.salt1 ?? 0,
      salt2: this.#header?.salt2 ?? 0,
      frame: this.#frame,
    }
  }

  /** Bytes of the WAL that have been confirmed, for tests and diagnostics. */
  get confirmedOffset(): number {
    return this.#offset
  }

  /**
   * Reads every transaction that has committed since the last poll. Returns an empty array when
   * the WAL has not grown, is mid-write, or does not exist yet.
   */
  poll(): TxnFrames[] {
    const fd = this.#open()
    if (fd === null) return []

    const state = this.#read(fd)
    if (!state) return []
    const { header, size } = state

    const frameSize = walFrameSize(header.pageSize)
    if (this.#scratch.byteLength !== frameSize) this.#scratch = new Uint8Array(frameSize)
    const frame = this.#scratch

    const txns: TxnFrames[] = []
    // Scanning always starts from the last confirmed commit, never from wherever the previous
    // poll happened to stop: frames past a commit can be rewritten underneath us.
    let offset = this.#offset
    let index = this.#frame
    let running = this.#running
    let pending = new Map<number, Uint8Array>()
    let pendingFrames = 0
    let afterReset = this.#sawReset

    while (offset + frameSize <= size) {
      const read = fs.readSync(fd, frame, 0, frameSize, offset)
      if (read < frameSize) break
      const check = checkFrameFast(frame, 0, header, running)
      if (!check.valid) break

      running = check.next
      offset += frameSize
      index += 1
      pendingFrames += 1
      pending.set(check.header.pgno, frame.slice(WAL_FRAME_HEADER_SIZE))

      if (check.header.commitSize !== 0) {
        const pages = [...pending.keys()].sort((a, b) => a - b)
        txns.push({
          frames: pending,
          pages,
          commitSize: check.header.commitSize,
          pageSize: header.pageSize,
          walSalt1: header.salt1,
          walSalt2: header.salt2,
          walEndFrame: index,
          frameCount: pendingFrames,
          afterReset,
        })
        afterReset = false
        pending = new Map()
        pendingFrames = 0
        this.#frame = index
        this.#offset = offset
        this.#running = running
      }
    }

    if (txns.length > 0) this.#sawReset = false
    return txns
  }

  /**
   * Resumes from a saved position. The running checksum is not derivable from a position, so the
   * chain is re-validated from frame 1 up to `position.frame`; a salt change or a WAL that no
   * longer reaches that frame is reported rather than guessed at, and tailing restarts at frame 1.
   */
  restore(position: WalPosition): RestoreOutcome {
    const fd = this.#open()
    if (fd === null) return "absent"
    const state = this.#read(fd)
    if (!state) return "absent"
    const { header, size } = state

    if (header.salt1 !== position.salt1 || header.salt2 !== position.salt2) {
      this.#adopt(header, true)
      return "reset"
    }
    if (position.frame === 0) {
      this.#adopt(header, false)
      return "resumed"
    }

    const frameSize = walFrameSize(header.pageSize)
    const frame = new Uint8Array(frameSize)
    let running = headerChecksum(header)
    let offset = WAL_HEADER_SIZE

    for (let index = 1; index <= position.frame; index++) {
      if (offset + frameSize > size) {
        throw new WalFormatError(
          `cannot resume at frame ${position.frame}: ${this.path} holds ${index - 1} frames`,
        )
      }
      fs.readSync(fd, frame, 0, frameSize, offset)
      const check = checkFrameFast(frame, 0, header, running)
      if (!check.valid) {
        throw new WalFormatError(
          `cannot resume at frame ${position.frame}: frame ${index} of ${this.path} no longer verifies`,
        )
      }
      running = check.next
      offset += frameSize
    }

    this.#header = header
    this.#frame = position.frame
    this.#offset = offset
    this.#running = running
    this.#sawReset = false
    return "resumed"
  }

  /** Forgets everything and starts at frame 1 of whatever generation the WAL is in now. */
  rewind(): void {
    this.#header = null
    this.#frame = 0
    this.#offset = WAL_HEADER_SIZE
    this.#running = [0, 0]
    this.#sawReset = false
  }

  close(): void {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd)
      this.#fd = null
    }
  }

  #open(): number | null {
    if (this.#fd !== null) return this.#fd
    try {
      this.#fd = fs.openSync(this.path, "r")
    } catch {
      return null
    }
    return this.#fd
  }

  /**
   * Re-reads the header on every poll, and returns the file size it had to `fstat` for anyway.
   *
   * A generation change has to be noticed before frames are read, and the salts stamped into each
   * frame make the reverse race (new header, stale frames or the other way round) fail validation
   * rather than corrupt the stream.
   *
   * The size rides back with the header because every caller wants both and `fstat`ing twice
   * microseconds apart on the same fd is a syscall for an answer already in hand
   * (`docs/p3-wal-checksum.md` §2). It must not be cached across polls: a `wal_checkpoint(RESTART)`
   * rewrites the header and restarts frames at the same offsets **without changing the file size**,
   * so an unchanged size is not evidence that nothing changed.
   */
  #read(fd: number): { header: WalHeader; size: number } | null {
    const size = fs.fstatSync(fd).size
    if (size < WAL_HEADER_SIZE) {
      // A TRUNCATE checkpoint empties the file; the next writer rewrites the header.
      if (this.#header !== null) this.#markReset()
      return null
    }
    const buf = this.#headerScratch
    fs.readSync(fd, buf, 0, WAL_HEADER_SIZE, 0)
    const header = parseWalHeader(buf)
    if (!header) {
      if (this.#header !== null) this.#markReset()
      return null
    }
    const current = this.#header
    if (!current) {
      this.#adopt(header, this.#sawReset)
    } else if (current.salt1 !== header.salt1 || current.salt2 !== header.salt2) {
      this.#adopt(header, true)
    }
    return { header, size }
  }

  #markReset(): void {
    this.#header = null
    this.#frame = 0
    this.#offset = WAL_HEADER_SIZE
    this.#running = [0, 0]
    this.#sawReset = true
  }

  /** Starts a WAL generation at frame 1. `reset` marks the next transaction as post-reset. */
  #adopt(header: WalHeader, reset: boolean): void {
    this.#header = header
    this.#frame = 0
    this.#offset = WAL_HEADER_SIZE
    this.#running = headerChecksum(header)
    this.#sawReset = reset
  }
}

/**
 * Every page a WAL currently holds a committed version of, keyed by page number, plus the commit
 * size at the newest commit frame. Used to seed a page-hash overlay when a tailer starts against
 * a WAL that already has frames in it.
 */
export function scanWalPages(
  walPath: string,
  maxFrame = Number.POSITIVE_INFINITY,
): { pages: Map<number, Uint8Array>; commitSize: number; header: WalHeader; frame: number } | null {
  let fd: number
  try {
    fd = fs.openSync(walPath, "r")
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size < WAL_HEADER_SIZE) return null
    const head = new Uint8Array(WAL_HEADER_SIZE)
    fs.readSync(fd, head, 0, WAL_HEADER_SIZE, 0)
    const header = parseWalHeader(head)
    if (!header) return null

    const frameSize = walFrameSize(header.pageSize)
    const frame = new Uint8Array(frameSize)
    let running = headerChecksum(header)
    const pending = new Map<number, Uint8Array>()
    const committed = new Map<number, Uint8Array>()
    let commitSize = 0
    let committedFrame = 0

    for (let index = 1; index <= maxFrame; index++) {
      const offset = walFrameOffset(index, header.pageSize)
      if (offset + frameSize > size) break
      fs.readSync(fd, frame, 0, frameSize, offset)
      const check = checkFrameFast(frame, 0, header, running)
      if (!check.valid) break
      running = check.next
      pending.set(check.header.pgno, frame.slice(WAL_FRAME_HEADER_SIZE))
      if (check.header.commitSize !== 0) {
        for (const [pgno, page] of pending) committed.set(pgno, page)
        pending.clear()
        commitSize = check.header.commitSize
        committedFrame = index
      }
    }
    if (committedFrame === 0) return null
    return { pages: committed, commitSize, header, frame: committedFrame }
  } finally {
    fs.closeSync(fd)
  }
}
