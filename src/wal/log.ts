// The tenant's transaction log: `<dir>/log/<startTxid>.seg`, records appended back to back.
//
// Invariant: txids are dense and ascending, so a segment's index is an offset array rather than a
// map — one number per record instead of a Map entry, which matters at a million transactions a
// day. `append` refuses anything but `lastTxid + 1`, which is what keeps the array dense.
//
// A crash can only tear the tail of the newest segment. On open every segment is walked record by
// record; a torn tail is truncated away and named in `repaired`, so the log always reopens as a
// clean prefix of what was durable.

import fs from "node:fs"
import path from "node:path"
import { LogGap, WalFormatError } from "./errors.ts"
import {
  decode,
  decodeHeader,
  encode,
  RECORD_HEADER_SIZE,
  type TxnRecord,
  type TxnRecordHeader,
  type TxnRecordInput,
} from "./record.ts"

/** 16 MB, per design §4.4. */
export const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024

export type FsyncPolicy = "never" | "each" | "interval"

export interface TxnLogOptions {
  /** Tenant directory; segments live in `<dir>/log`. */
  dir: string
  /** Roll to a new segment once the current one passes this many bytes. */
  segmentBytes?: number
  /** `"each"` fsyncs every append, `"interval"` at most once per `fsyncIntervalMs`. */
  fsync?: FsyncPolicy
  fsyncIntervalMs?: number
}

export interface RetentionPolicy {
  /** Drop segments whose newest record is older than this. */
  maxAgeMs?: number
  /** Drop the oldest segments until the log fits in this many bytes. */
  maxBytes?: number
  /** Never drop a segment holding this txid or anything after it. */
  keepAfterTxid?: bigint
}

export interface RetentionResult {
  removed: string[]
  bytesFreed: number
}

interface Segment {
  path: string
  startTxid: bigint
  /** Records in the segment. */
  count: number
  /** Byte offset of each record, plus a final entry for the end of the file. */
  offsets: number[]
  bytes: number
  /** Wall-clock microseconds of the newest record, from the records themselves. */
  newestUs: bigint
}

function segmentName(startTxid: bigint): string {
  return `${startTxid.toString().padStart(20, "0")}.seg`
}

export class TxnLog {
  readonly dir: string
  readonly logDir: string
  readonly segmentBytes: number
  readonly fsyncPolicy: FsyncPolicy
  readonly fsyncIntervalMs: number

  /** Segments whose torn tail was truncated when the log was opened. */
  readonly repaired: string[] = []

  #segments: Segment[] = []
  #fd: number | null = null
  #openSegment: Segment | null = null
  #lastFsyncMs = 0
  #dirty = false
  #closed = false

  private constructor(options: TxnLogOptions) {
    this.dir = options.dir
    this.logDir = path.join(options.dir, "log")
    this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES
    this.fsyncPolicy = options.fsync ?? "interval"
    this.fsyncIntervalMs = options.fsyncIntervalMs ?? 100
  }

  /** Opens (creating the directory when missing) and rebuilds the index by scanning headers. */
  static open(options: TxnLogOptions): TxnLog {
    const log = new TxnLog(options)
    fs.mkdirSync(log.logDir, { recursive: true })
    log.#rebuild()
    return log
  }

  /** Highest txid in the log, or 0 when empty. */
  get lastTxid(): bigint {
    const last = this.#segments.at(-1)
    if (!last || last.count === 0) return 0n
    return last.startTxid + BigInt(last.count - 1)
  }

  /** Lowest txid still retained, or null when the log is empty. */
  get firstTxid(): bigint | null {
    for (const segment of this.#segments) {
      if (segment.count > 0) return segment.startTxid
    }
    return null
  }

  get segmentCount(): number {
    return this.#segments.length
  }

  /** Total bytes of every segment. */
  get bytes(): number {
    let total = 0
    for (const segment of this.#segments) total += segment.bytes
    return total
  }

  /** Segment file paths, oldest first. */
  get segmentPaths(): string[] {
    return this.#segments.map((s) => s.path)
  }

  /** Encodes and appends a record. Returns the encoded bytes, which are also the wire format. */
  append(record: TxnRecordInput): Uint8Array {
    const bytes = encode(record)
    this.appendEncoded(bytes)
    return bytes
  }

  /** Appends an already-encoded record, validating that it continues the log. */
  appendEncoded(bytes: Uint8Array): void {
    this.#assertOpen()
    const head = decodeHeader(bytes)
    if (!head) throw new WalFormatError("record is shorter than a record header")
    if (head.byteLength !== bytes.byteLength) {
      throw new WalFormatError(
        `record says it is ${head.byteLength} bytes but ${bytes.byteLength} were given`,
      )
    }
    const expected = this.lastTxid + 1n
    if (this.#segments.length > 0 && head.header.txid !== expected) {
      throw new WalFormatError(
        `log is at txid ${this.lastTxid}, record ${head.header.txid} does not follow it`,
      )
    }

    const segment = this.#segmentFor(head.header)
    const fd = this.#descriptor(segment)
    fs.writeSync(fd, bytes, 0, bytes.byteLength, segment.bytes)
    segment.offsets[segment.count] = segment.bytes
    segment.count += 1
    segment.bytes += bytes.byteLength
    segment.offsets[segment.count] = segment.bytes
    segment.newestUs = head.header.timestampUs
    this.#dirty = true
    this.#maybeFsync()
  }

  /** One record by txid, or null when it is outside the log. */
  read(txid: bigint): TxnRecord | null {
    this.#assertOpen()
    const found = this.#locate(txid)
    if (!found) return null
    const { segment, index } = found
    const start = segment.offsets[index] as number
    const end = segment.offsets[index + 1] as number
    const buf = new Uint8Array(end - start)
    const fd = fs.openSync(segment.path, "r")
    try {
      fs.readSync(fd, buf, 0, buf.byteLength, start)
    } finally {
      fs.closeSync(fd)
    }
    return decode(buf).record
  }

  /**
   * Every record from `fromTxid` to the end, in order. Throws `LogGap` when `fromTxid` has been
   * retained away, which is the signal to bootstrap the caller from a snapshot instead.
   */
  *iterate(fromTxid: bigint): IterableIterator<TxnRecord> {
    this.#assertOpen()
    const first = this.firstTxid
    if (first === null) {
      if (fromTxid <= 1n) return
      throw new LogGap(fromTxid, null)
    }
    if (fromTxid < first) throw new LogGap(fromTxid, first)

    for (const segment of this.#segments) {
      if (segment.count === 0) continue
      const endTxid = segment.startTxid + BigInt(segment.count - 1)
      if (endTxid < fromTxid) continue
      const startIndex = fromTxid > segment.startTxid ? Number(fromTxid - segment.startTxid) : 0
      // Segments are capped at `segmentBytes`, so reading one whole is bounded and far cheaper
      // than a pread per record.
      const buf = new Uint8Array(segment.bytes - (segment.offsets[startIndex] as number))
      const fd = fs.openSync(segment.path, "r")
      try {
        fs.readSync(fd, buf, 0, buf.byteLength, segment.offsets[startIndex] as number)
      } finally {
        fs.closeSync(fd)
      }
      let at = 0
      while (at < buf.byteLength) {
        const { record, byteLength } = decode(buf, at)
        yield record
        at += byteLength
      }
    }
  }

  /**
   * Drops whole segments off the front. A segment survives if it holds `keepAfterTxid` or
   * anything after it, and the newest segment is never dropped.
   */
  retain(policy: RetentionPolicy): RetentionResult {
    this.#assertOpen()
    const removed: string[] = []
    let bytesFreed = 0
    const nowUs = BigInt(Date.now()) * 1000n

    while (this.#segments.length > 1) {
      const segment = this.#segments[0] as Segment
      const endTxid = segment.startTxid + BigInt(Math.max(segment.count - 1, 0))
      if (policy.keepAfterTxid !== undefined && endTxid >= policy.keepAfterTxid) break

      const tooOld =
        policy.maxAgeMs !== undefined &&
        nowUs - segment.newestUs > BigInt(policy.maxAgeMs) * 1000n
      const tooBig = policy.maxBytes !== undefined && this.bytes > policy.maxBytes
      if (!tooOld && !tooBig) break

      if (this.#openSegment === segment) this.#closeDescriptor()
      fs.rmSync(segment.path, { force: true })
      removed.push(segment.path)
      bytesFreed += segment.bytes
      this.#segments.shift()
    }
    return { removed, bytesFreed }
  }

  /** Forces an fsync of the open segment regardless of policy. */
  flush(): void {
    if (this.#closed || !this.#dirty || this.#fd === null) return
    fs.fsyncSync(this.#fd)
    this.#dirty = false
    this.#lastFsyncMs = Date.now()
  }

  close(): void {
    if (this.#closed) return
    this.flush()
    this.#closeDescriptor()
    this.#closed = true
  }

  // -------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new WalFormatError("transaction log is closed")
  }

  #locate(txid: bigint): { segment: Segment; index: number } | null {
    for (const segment of this.#segments) {
      if (segment.count === 0) continue
      const endTxid = segment.startTxid + BigInt(segment.count - 1)
      if (txid < segment.startTxid || txid > endTxid) continue
      return { segment, index: Number(txid - segment.startTxid) }
    }
    return null
  }

  #segmentFor(header: TxnRecordHeader): Segment {
    const last = this.#segments.at(-1)
    if (last && last.bytes < this.segmentBytes) return last
    this.flush()
    this.#closeDescriptor()
    const segment: Segment = {
      path: path.join(this.logDir, segmentName(header.txid)),
      startTxid: header.txid,
      count: 0,
      offsets: [0],
      bytes: 0,
      newestUs: header.timestampUs,
    }
    this.#segments.push(segment)
    return segment
  }

  #descriptor(segment: Segment): number {
    if (this.#openSegment === segment && this.#fd !== null) return this.#fd
    this.flush()
    this.#closeDescriptor()
    this.#fd = fs.openSync(segment.path, fs.existsSync(segment.path) ? "r+" : "w+")
    this.#openSegment = segment
    return this.#fd
  }

  #closeDescriptor(): void {
    if (this.#fd !== null) {
      fs.closeSync(this.#fd)
      this.#fd = null
    }
    this.#openSegment = null
  }

  #maybeFsync(): void {
    if (this.fsyncPolicy === "never") return
    if (this.fsyncPolicy === "each") {
      this.flush()
      return
    }
    if (Date.now() - this.#lastFsyncMs >= this.fsyncIntervalMs) this.flush()
  }

  #rebuild(): void {
    const names = fs
      .readdirSync(this.logDir)
      .filter((name) => name.endsWith(".seg"))
      .sort()

    this.#segments = []
    for (const name of names) {
      const filePath = path.join(this.logDir, name)
      const startTxid = BigInt(name.slice(0, -4))
      const segment = this.#scan(filePath, startTxid)
      if (segment.count === 0) {
        // An empty or wholly unreadable segment carries nothing; drop it rather than keep a
        // hole that would break the dense-txid invariant.
        fs.rmSync(filePath, { force: true })
        this.repaired.push(filePath)
        continue
      }
      this.#segments.push(segment)
    }
  }

  /** Walks a segment's record headers, truncating a torn tail. */
  #scan(filePath: string, startTxid: bigint): Segment {
    const size = fs.statSync(filePath).size
    const segment: Segment = {
      path: filePath,
      startTxid,
      count: 0,
      offsets: [0],
      bytes: 0,
      newestUs: 0n,
    }
    if (size === 0) return segment

    const fd = fs.openSync(filePath, "r")
    try {
      const head = new Uint8Array(RECORD_HEADER_SIZE)
      let at = 0
      let expected = startTxid
      while (at + RECORD_HEADER_SIZE <= size) {
        const read = fs.readSync(fd, head, 0, RECORD_HEADER_SIZE, at)
        if (read < RECORD_HEADER_SIZE) break
        let decoded: ReturnType<typeof decodeHeader>
        try {
          decoded = decodeHeader(head)
        } catch {
          break
        }
        if (!decoded) break
        if (decoded.header.txid !== expected) break
        if (at + decoded.byteLength > size) break
        segment.count += 1
        at += decoded.byteLength
        segment.offsets[segment.count] = at
        segment.newestUs = decoded.header.timestampUs
        expected += 1n
      }
      segment.bytes = at
    } finally {
      fs.closeSync(fd)
    }

    if (segment.bytes < size) {
      fs.truncateSync(filePath, segment.bytes)
      this.repaired.push(filePath)
    }
    return segment
  }
}
