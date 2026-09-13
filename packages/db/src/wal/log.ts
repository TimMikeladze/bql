// The tenant's transaction log: `<dir>/log/<startTxid>.seg`, records appended back to back.
//
// Invariant: txids are dense and ascending, so a segment's index is an offset array rather than a
// map — one number per record instead of a Map entry, which matters at a million transactions a
// day. `append` refuses anything but `lastTxid + 1`, which is what keeps the array dense.
//
// A crash can only tear the tail of the newest segment. On open every segment is walked record by
// record; a torn tail is truncated away and named in `repaired`, so the log always reopens as a
// clean prefix of what was durable.
//
// Third invariant: the sidecar index (`<startTxid>.idx`) is a *cache of that walk*, never a second
// source of truth. It is accepted only when its magic, version, start txid and trailing hash all
// check out, when it claims no more bytes than the segment file holds, and when the last record it
// indexes decodes at the offset it gives with the txid it implies. Anything else is a full scan; a
// pass resumes the scan at the byte the index stops at, so the ordinary crash — an index one flush
// behind the file — costs a scan of the tail and nothing more. Phase 0 measured 3.1 ms of a 3.6 ms
// cold open walking 6k record headers; this removes it.
//
// Fourth invariant: `retain` never drops a record somebody can still ask for. It is given a
// `keepAfterTxid` computed by `logRetentionFloor` from every consumer that could still read the
// log — the oldest snapshot kept, the slowest connected replica, the S3 shipper — and the age and
// size bounds only ever choose *among* the segments below that floor. See `docs/r6-retention.md`.

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

/** `<startTxid>.idx`, the sidecar that makes a cold open cheap. */
export const SEGMENT_INDEX_SUFFIX = ".idx"

/** "BQLI" read as a little-endian u32. */
const INDEX_MAGIC = 0x494c5142
const INDEX_VERSION = 1
/** magic, version, startTxid, count, segBytes, newestUs — the offsets follow. */
const INDEX_HEADER_SIZE = 40
/** The trailing `xxHash3` over everything before it. */
const INDEX_HASH_SIZE = 8

export type FsyncPolicy = "never" | "each" | "interval"

export interface TxnLogOptions {
  /** Tenant directory; segments live in `<dir>/log`. */
  dir: string
  /** Roll to a new segment once the current one passes this many bytes. */
  segmentBytes?: number
  /** `"each"` fsyncs every append, `"interval"` at most once per `fsyncIntervalMs`. */
  fsync?: FsyncPolicy
  fsyncIntervalMs?: number
  /**
   * How often the open segment's index is rewritten while appending, in milliseconds. Default
   * 1000. A stale index is never wrong — it only shortens the scan — so this trades index IO
   * against how much tail a crash makes the next open walk. 0 writes one on every flush.
   */
  indexIntervalMs?: number
  /** Set false to stop writing sidecar indexes at all; opening still reads one that is there. */
  index?: boolean
  /**
   * Compress record bodies with zstd. Default true. Per record and in the header, so turning it
   * off does not make what is already written unreadable — `decode` reads either.
   */
  compress?: boolean
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

/**
 * Where every consumer that could still read this log stands. A consumer that is not present —
 * no snapshot ever taken, no replica attached, no bucket configured — is left out, and imposes
 * nothing.
 */
export interface LogConsumers {
  /**
   * The txid of the oldest snapshot being kept. A point-in-time restore copies a snapshot and
   * replays the records after it, so the records above the oldest snapshot are the only thing
   * that makes that snapshot restorable to anything but its own txid.
   */
  oldestSnapshotTxid?: bigint | null
  /**
   * The lowest txid acked by a replica that is *currently connected*. A replica resumes from the
   * record after the one it acked. A replica that has gone imposes nothing: it is told `RETENTION`
   * and given a snapshot when it comes back (`docs/r1-replication.md` deviation 4), which is what
   * stops one dead follower pinning the log for ever.
   */
  slowestReplicaTxid?: bigint | null
  /**
   * The highest txid the S3 shipper has put in the bucket. A node whose bucket is behind has to
   * keep the records the bucket does not hold: the shipper uploads them out of this log, so a
   * segment dropped before it ships is a hole in the backup that nothing can ever fill.
   */
  shippedTxid?: bigint | null
}

/**
 * The lowest txid the log must still hold, or `undefined` when nothing needs it.
 *
 * Getting this wrong in one direction wastes disk and in the other loses data silently, so it is
 * the minimum over the consumers above and nothing else: whichever one is furthest behind decides,
 * and one that is absent does not vote. `undefined` is handed to `retain` as no `keepAfterTxid`,
 * which leaves only the age and size bounds — a database with no snapshot, no replica and no
 * bucket is held by its own retention alone, which is what that key promises.
 */
export function logRetentionFloor(consumers: LogConsumers): bigint | undefined {
  let floor: bigint | undefined
  for (const at of [
    consumers.oldestSnapshotTxid,
    consumers.slowestReplicaTxid,
    consumers.shippedTxid,
  ]) {
    if (at === undefined || at === null) continue
    if (floor === undefined || at < floor) floor = at
  }
  return floor
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
  /** `bytes` as of the last index written for this segment; -1 when none has been. */
  indexedBytes: number
}

function segmentName(startTxid: bigint): string {
  return `${startTxid.toString().padStart(20, "0")}.seg`
}

/** The sidecar beside a segment file: `…/00000000000000000001.idx`. */
export function segmentIndexPath(segmentPath: string): string {
  return `${segmentPath.slice(0, -4)}${SEGMENT_INDEX_SUFFIX}`
}

/** What a readable index gave us: a verified prefix of the walk, to resume from. */
interface IndexHint {
  count: number
  bytes: number
  offsets: number[]
  newestUs: bigint
}

export class TxnLog {
  readonly dir: string
  readonly logDir: string
  readonly segmentBytes: number
  readonly fsyncPolicy: FsyncPolicy
  readonly fsyncIntervalMs: number
  readonly indexIntervalMs: number
  readonly writeIndex: boolean
  /** Whether records this log writes are compressed. Records it reads carry their own flag. */
  readonly compress: boolean

  /** Segments whose torn tail was truncated when the log was opened. */
  readonly repaired: string[] = []
  /** Segments whose sidecar index was unusable and had to be rebuilt by a full scan. */
  readonly rescanned: string[] = []

  #segments: Segment[] = []
  #fd: number | null = null
  #openSegment: Segment | null = null
  #lastFsyncMs = 0
  #lastIndexMs = 0
  #dirty = false
  #closed = false

  private constructor(options: TxnLogOptions) {
    this.dir = options.dir
    this.logDir = path.join(options.dir, "log")
    this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES
    this.fsyncPolicy = options.fsync ?? "interval"
    this.fsyncIntervalMs = options.fsyncIntervalMs ?? 100
    this.indexIntervalMs = options.indexIntervalMs ?? 1000
    this.writeIndex = options.index ?? true
    this.compress = options.compress ?? true
  }

  /**
   * Opens (creating the directory when missing) and rebuilds the in-memory offset table, from
   * each segment's sidecar index where there is a usable one and from a header walk where there
   * is not.
   */
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
    const bytes = encode(record, { compress: this.compress })
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
   * The same records as `iterate`, still encoded. The S3 shipper wants the bytes exactly as they
   * are on disk — a segment object is records back to back, which is what a segment file already
   * is — so decompressing every page image only to re-encode it would be pure waste.
   */
  *iterateEncoded(fromTxid: bigint): IterableIterator<{ txid: bigint; bytes: Uint8Array }> {
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
      const from = segment.offsets[startIndex] as number
      const buf = new Uint8Array(segment.bytes - from)
      const fd = fs.openSync(segment.path, "r")
      try {
        fs.readSync(fd, buf, 0, buf.byteLength, from)
      } finally {
        fs.closeSync(fd)
      }
      for (let i = startIndex; i < segment.count; i++) {
        const start = (segment.offsets[i] as number) - from
        const end = (segment.offsets[i + 1] as number) - from
        yield { txid: segment.startTxid + BigInt(i), bytes: buf.subarray(start, end) }
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
      // The sidecar describes a file that no longer exists; leaving it would make the next open
      // read an index for a segment it cannot find.
      fs.rmSync(segmentIndexPath(segment.path), { force: true })
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
    const now = this.#lastFsyncMs
    if (now - this.#lastIndexMs >= this.indexIntervalMs) {
      this.#lastIndexMs = now
      this.#saveIndex(this.#openSegment)
    }
  }

  /** Writes every segment's sidecar index out now, whatever the interval says. */
  saveIndexes(): void {
    if (this.#closed) return
    for (const segment of this.#segments) this.#saveIndex(segment)
  }

  close(): void {
    if (this.#closed) return
    this.flush()
    this.#saveIndex(this.#openSegment)
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
    // A segment that is being left behind is final, so its index is written once, in full, and
    // never touched again — which is the case a cold open benefits from most.
    this.#saveIndex(last ?? null)
    this.#closeDescriptor()
    const segment: Segment = {
      path: path.join(this.logDir, segmentName(header.txid)),
      startTxid: header.txid,
      count: 0,
      offsets: [0],
      bytes: 0,
      newestUs: header.timestampUs,
      indexedBytes: -1,
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
      const hint = this.#readIndex(filePath, startTxid)
      if (hint === null) this.rescanned.push(filePath)
      const segment = this.#scan(filePath, startTxid, hint)
      if (segment.count === 0) {
        // An empty or wholly unreadable segment carries nothing; drop it rather than keep a
        // hole that would break the dense-txid invariant.
        fs.rmSync(filePath, { force: true })
        fs.rmSync(segmentIndexPath(filePath), { force: true })
        this.repaired.push(filePath)
        continue
      }
      this.#segments.push(segment)
    }
  }

  /**
   * Walks a segment's record headers, truncating a torn tail. `hint` is a verified index prefix,
   * so the walk starts where the index stops rather than at byte zero.
   */
  #scan(filePath: string, startTxid: bigint, hint: IndexHint | null = null): Segment {
    const size = fs.statSync(filePath).size
    const segment: Segment = {
      path: filePath,
      startTxid,
      count: hint?.count ?? 0,
      offsets: hint ? hint.offsets : [0],
      bytes: hint?.bytes ?? 0,
      newestUs: hint?.newestUs ?? 0n,
      indexedBytes: hint ? hint.bytes : -1,
    }
    if (size === 0) return segment
    if (hint && hint.bytes === size) return segment

    const fd = fs.openSync(filePath, "r")
    try {
      const head = new Uint8Array(RECORD_HEADER_SIZE)
      let at = segment.bytes
      let expected = startTxid + BigInt(segment.count)
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
      // The sidecar now describes a file that has been cut back; rewrite it rather than leave an
      // index whose byte count no longer matches anything.
      segment.indexedBytes = -1
    }
    return segment
  }

  // ── the sidecar index ────────────────────────────────────────────────────────────────────────

  /**
   * Reads `<startTxid>.idx` and returns the prefix of the walk it proves, or null when it cannot
   * be trusted. Five things have to hold: the magic and version, the start txid the file name
   * already implies, the trailing hash over everything before it, a byte count no larger than the
   * segment file, and — the one check a hash cannot make — that the last record it indexes really
   * decodes at the offset it gives, with the txid its position implies.
   */
  #readIndex(segmentPath: string, startTxid: bigint): IndexHint | null {
    const indexPath = segmentIndexPath(segmentPath)
    let raw: Buffer
    let segmentSize: number
    try {
      segmentSize = fs.statSync(segmentPath).size
      raw = fs.readFileSync(indexPath)
    } catch {
      return null
    }
    if (raw.byteLength < INDEX_HEADER_SIZE + 8 + INDEX_HASH_SIZE) return null

    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    if (view.getUint32(0, true) !== INDEX_MAGIC) return null
    if (view.getUint8(4) !== INDEX_VERSION) return null
    if (view.getBigUint64(8, true) !== startTxid) return null

    const count = view.getUint32(16, true)
    const expectedLength = INDEX_HEADER_SIZE + (count + 1) * 8 + INDEX_HASH_SIZE
    if (count === 0 || raw.byteLength !== expectedLength) return null

    const stored = view.getBigUint64(raw.byteLength - INDEX_HASH_SIZE, true)
    if (Bun.hash.xxHash3(bytes.subarray(0, raw.byteLength - INDEX_HASH_SIZE)) !== stored) {
      return null
    }

    const indexedBytes = Number(view.getBigUint64(24, true))
    if (!Number.isSafeInteger(indexedBytes) || indexedBytes > segmentSize) return null
    const newestUs = view.getBigUint64(32, true)

    const offsets: number[] = new Array(count + 1)
    for (let i = 0; i <= count; i++) {
      const offset = Number(view.getBigUint64(INDEX_HEADER_SIZE + i * 8, true))
      if (!Number.isSafeInteger(offset) || offset > indexedBytes) return null
      offsets[i] = offset
    }
    if (offsets[count] !== indexedBytes) return null

    // The hash proves the index is the one that was written; this proves it was written for *this*
    // segment file. A file replaced under a surviving sidecar fails here.
    const lastOffset = offsets[count - 1] as number
    try {
      const head = new Uint8Array(RECORD_HEADER_SIZE)
      const fd = fs.openSync(segmentPath, "r")
      try {
        if (fs.readSync(fd, head, 0, RECORD_HEADER_SIZE, lastOffset) < RECORD_HEADER_SIZE) {
          return null
        }
      } finally {
        fs.closeSync(fd)
      }
      const decoded = decodeHeader(head)
      if (!decoded) return null
      if (decoded.header.txid !== startTxid + BigInt(count - 1)) return null
      if (lastOffset + decoded.byteLength !== indexedBytes) return null
      if (decoded.header.timestampUs !== newestUs) return null
    } catch {
      return null
    }

    return { count, bytes: indexedBytes, offsets, newestUs }
  }

  /** Writes the sidecar through a temp file and a rename, so a torn index is never read. */
  #saveIndex(segment: Segment | null): void {
    if (!segment || !this.writeIndex) return
    if (segment.count === 0 || segment.indexedBytes === segment.bytes) return

    const count = segment.count
    const length = INDEX_HEADER_SIZE + (count + 1) * 8 + INDEX_HASH_SIZE
    const out = new Uint8Array(length)
    const view = new DataView(out.buffer)
    view.setUint32(0, INDEX_MAGIC, true)
    view.setUint8(4, INDEX_VERSION)
    view.setBigUint64(8, segment.startTxid, true)
    view.setUint32(16, count, true)
    view.setBigUint64(24, BigInt(segment.bytes), true)
    view.setBigUint64(32, segment.newestUs, true)
    for (let i = 0; i <= count; i++) {
      view.setBigUint64(INDEX_HEADER_SIZE + i * 8, BigInt(segment.offsets[i] as number), true)
    }
    view.setBigUint64(length - INDEX_HASH_SIZE, Bun.hash.xxHash3(out.subarray(0, length - INDEX_HASH_SIZE)), true)

    const indexPath = segmentIndexPath(segment.path)
    const temp = `${indexPath}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, out)
      fs.renameSync(temp, indexPath)
      segment.indexedBytes = segment.bytes
    } catch {
      // An index that cannot be written costs a scan on the next open and nothing else, so a full
      // disk or a read-only directory must not take the log down with it.
      fs.rmSync(temp, { force: true })
    }
  }
}
