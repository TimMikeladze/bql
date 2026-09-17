// The unit of replication: one committed transaction's pages, framed so that it can be appended
// to a segment file, streamed on the wire, and verified without any other context.
//
// Invariant: a record is self-verifying. The header carries a hash of itself and of the
// uncompressed body, and the pair (preChecksum, postChecksum) pins the whole database state
// before and after the transaction, so a replica that applies records in order can prove at every
// step that it holds exactly what the primary holds.
//
// Layout (little-endian; this is our format, not SQLite's, and LE is the native order):
//
//   0   magic "BQL1"            4     80  bodyHash (xxh3-128)   16
//   4   version u8              1     96  headerHash (xxh3-64)   8
//   5   flags u8                1    104  body
//   6   pageSize u16            2
//   8   txid u64                8    body = zstd(plain)
//   16  prevTxid u64            8
//   24  epoch u32               4    v1: plain = [pgno u32 | page]* ascending by pgno
//   28  frameCount u32          4    v2: plain = [pgno u32 | page]* | logical | logicalLength u32
//   32  timestampUs u64         8
//   40  commitSizePages u32     4
//   44  walSalt1 u32            4
//   48  walSalt2 u32            4
//   52  walEndFrame u32         4
//   56  preChecksum u64         8
//   64  postChecksum u64        8
//   72  bodyLength u32          4
//   76  bodyPlainLength u32     4
//
// `bodyLength` and the hash placement are additions to the listing in design §4.3: a segment is
// records back to back, so a record has to state its own length, and putting the hashes in the
// fixed header makes `decodeHeader` a single self-validating read.
//
// **Version 2 (P9, `docs/p9-logical-cdc.md`).** A record may carry the row changes the primary's
// capture saw, so a replica's change feed can publish rows instead of an empty array. They ride in
// the body rather than in the header because the body is what zstd already compresses and what the
// body hash already covers — a record stays self-verifying with no new hash and no new field.
//
// The region is a **trailer with its length last**, and that placement is the whole trick: the
// page region keeps byte offset 0 and byte-for-byte content, so encoding a transaction with and
// without logical changes produces the same first `pages * (4 + pageSize)` bytes. `logicalLength`
// is read from the final four bytes of `plain`, which names where the page region ended.
//
// It is **version 2 and not a flag bit**, because an old reader must refuse it by name. `decode`
// asserts `plain.byteLength % (4 + pageSize) === 0` — "a whole number of pages" — so a trailer
// behind a flag is not invisible to a reader that ignores the flag: it fails that assertion with a
// message about page sizes. `unsupported transaction record version 2` is the message an operator
// needs. A v2 record is written **only when there are rows to carry**, so a primary with
// `[replication] logicalChanges` off writes v1 forever and a mixed log, stream and bucket read
// exactly as a mixed `FLAG_ZSTD` one already does.

import fs from "node:fs"
import {
  checkFrame,
  databasePageCount,
  databasePageSize,
  headerChecksum,
  parseWalHeader,
  WAL_FRAME_HEADER_SIZE,
  WAL_HEADER_SIZE,
  walFrameOffset,
  walFrameSize,
} from "./codec.ts"
import { WalFormatError } from "./errors.ts"

export const RECORD_MAGIC = 0x314c5142 // "BQL1" read as a little-endian u32
export const RECORD_HEADER_SIZE = 104
export const RECORD_VERSION = 1

/** P9: a record that carries logical row changes after its pages. */
export const RECORD_VERSION_LOGICAL = 2

/**
 * The newest version this build can read. A replica announces it on `HELLO` as `maxRecordVersion`
 * and a primary never streams a record past what its peer announced, so an old replica against a
 * new primary keeps replicating rather than failing on a version it never asked for.
 */
export const MAX_RECORD_VERSION = RECORD_VERSION_LOGICAL

export const FLAG_ZSTD = 0x01
export const FLAG_SNAPSHOT_BOUNDARY = 0x02

/**
 * `Bun.hash.xxHash3` only exposes the 64-bit digest. The 128-bit body hash is therefore two
 * 64-bit XXH3 digests over the same bytes with different seeds. This is *not* canonical
 * XXH3-128 and is not interoperable with any other implementation; nothing but this module
 * reads it.
 */
const BODY_HASH_SEED_HIGH = 0x9e3779b1n

export interface TxnRecordHeader {
  version: number
  flags: number
  pageSize: number
  txid: bigint
  prevTxid: bigint
  epoch: number
  timestampUs: bigint
  commitSizePages: number
  /** Physical WAL frames the transaction wrote, before de-duplicating repeated pages. */
  frameCount: number
  walSalt1: number
  walSalt2: number
  /** 1-based index of the transaction's commit frame in the primary's WAL. */
  walEndFrame: number
  preChecksum: bigint
  postChecksum: bigint
  bodyLength: number
  bodyPlainLength: number
}

export interface TxnRecord extends TxnRecordHeader {
  /** Page number to page image, one entry per distinct page the transaction wrote. */
  pages: Map<number, Uint8Array>
  /**
   * P9: the transaction's row changes, opaque here. Present only on a version-2 record. This
   * module frames and verifies the bytes and never looks inside them: what is in there is the
   * change feed's shape, which `src/realtime/` owns and `src/wal/` has no business knowing.
   */
  logical?: Uint8Array
}

export type TxnRecordInput = Omit<
  TxnRecordHeader,
  "version" | "flags" | "bodyLength" | "bodyPlainLength"
> & {
  pages: ReadonlyMap<number, Uint8Array>
  /** P9: see `TxnRecord.logical`. An empty or absent value writes a version-1 record. */
  logical?: Uint8Array | null
  version?: number
  flags?: number
}

function hashParts(bytes: Uint8Array): [bigint, bigint] {
  return [Bun.hash.xxHash3(bytes), Bun.hash.xxHash3(bytes, BODY_HASH_SEED_HIGH)]
}

// Reused across calls so hashing a database page does not allocate; `pageHash` is on the hot path
// of every transaction on both the primary and the replica.
let hashScratch = new Uint8Array(0)
let hashScratchView = new DataView(hashScratch.buffer)

/** `xxh3_64(pgno ‖ page)`, the term the rolling database checksum XORs together. */
export function pageHash(pgno: number, page: Uint8Array): bigint {
  const needed = 4 + page.byteLength
  if (hashScratch.byteLength !== needed) {
    hashScratch = new Uint8Array(needed)
    hashScratchView = new DataView(hashScratch.buffer)
  }
  hashScratchView.setUint32(0, pgno, true)
  hashScratch.set(page, 4)
  return Bun.hash.xxHash3(hashScratch)
}

export interface EncodeOptions {
  /**
   * Compress the body with zstd, which is what every record has done since phase 0 and what
   * `FLAG_ZSTD` in the header says. `false` writes the pages plain — 4.3x larger and ~9.5 µs a
   * record cheaper, which is a third of a single-row write (`docs/performance.md` §1).
   *
   * The flag is per record, and `decode` has always honoured it, so a log, a replica stream and a
   * bucket may hold a mix: a node that changes this setting does not invalidate what it wrote
   * before, and a replica reads either kind without being told which to expect.
   */
  compress?: boolean
}

/** Serialises a record. Pages are written in ascending page-number order. */
export function encode(record: TxnRecordInput, options: EncodeOptions = {}): Uint8Array {
  const pageSize = record.pageSize
  const pgnos = [...record.pages.keys()].sort((a, b) => a - b)
  // P9: the logical trailer goes *after* the pages and states its own length last, so these first
  // bytes are identical whether or not one follows. A record encoded with the flag off is
  // therefore byte-identical to what this function wrote before P9, which `test/wal/record.test.ts`
  // proves by encoding the same transaction both ways.
  const logical = record.logical && record.logical.byteLength > 0 ? record.logical : null
  const pagesLength = pgnos.length * (4 + pageSize)
  const plain = new Uint8Array(pagesLength + (logical ? logical.byteLength + 4 : 0))
  const plainView = new DataView(plain.buffer)
  let at = 0
  for (const pgno of pgnos) {
    const page = record.pages.get(pgno)
    if (!page || page.byteLength !== pageSize) {
      throw new WalFormatError(`page ${pgno} is not ${pageSize} bytes`)
    }
    plainView.setUint32(at, pgno, true)
    plain.set(page, at + 4)
    at += 4 + pageSize
  }
  if (logical) {
    plain.set(logical, pagesLength)
    plainView.setUint32(pagesLength + logical.byteLength, logical.byteLength, true)
  }

  const flags =
    options.compress === false
      ? (record.flags ?? 0) & ~FLAG_ZSTD
      : (record.flags ?? 0) | FLAG_ZSTD
  const body =
    (flags & FLAG_ZSTD) === 0
      ? plain
      : new Uint8Array(Bun.zstdCompressSync(plain, { level: 3 }))

  const out = new Uint8Array(RECORD_HEADER_SIZE + body.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, RECORD_MAGIC, true)
  view.setUint8(4, record.version ?? (logical ? RECORD_VERSION_LOGICAL : RECORD_VERSION))
  view.setUint8(5, flags)
  view.setUint16(6, pageSize === 65536 ? 0 : pageSize, true)
  view.setBigUint64(8, record.txid, true)
  view.setBigUint64(16, record.prevTxid, true)
  view.setUint32(24, record.epoch, true)
  view.setUint32(28, record.frameCount, true)
  view.setBigUint64(32, record.timestampUs, true)
  view.setUint32(40, record.commitSizePages, true)
  view.setUint32(44, record.walSalt1 >>> 0, true)
  view.setUint32(48, record.walSalt2 >>> 0, true)
  view.setUint32(52, record.walEndFrame, true)
  view.setBigUint64(56, record.preChecksum, true)
  view.setBigUint64(64, record.postChecksum, true)
  view.setUint32(72, body.byteLength, true)
  view.setUint32(76, plain.byteLength, true)
  const [low, high] = hashParts(plain)
  view.setBigUint64(80, low, true)
  view.setBigUint64(88, high, true)
  view.setBigUint64(96, Bun.hash.xxHash3(out.subarray(0, 96)), true)
  out.set(body, RECORD_HEADER_SIZE)
  return out
}

export interface DecodedHeader {
  header: TxnRecordHeader
  /** Total bytes of the record, header included: what to skip to reach the next one. */
  byteLength: number
}

/**
 * Reads and validates a record header without touching the body. Returns null when fewer than
 * `RECORD_HEADER_SIZE` bytes are available, which is how a torn tail at the end of a segment
 * announces itself; throws when the bytes are present but not a record.
 */
export function decodeHeader(bytes: Uint8Array, offset = 0): DecodedHeader | null {
  if (bytes.byteLength - offset < RECORD_HEADER_SIZE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, RECORD_HEADER_SIZE)
  if (view.getUint32(0, true) !== RECORD_MAGIC) {
    throw new WalFormatError(`not a transaction record at offset ${offset}`)
  }
  const stored = view.getBigUint64(96, true)
  const computed = Bun.hash.xxHash3(bytes.subarray(offset, offset + 96))
  if (stored !== computed) {
    throw new WalFormatError(`transaction record header hash mismatch at offset ${offset}`)
  }
  const rawPageSize = view.getUint16(6, true)
  const header: TxnRecordHeader = {
    version: view.getUint8(4),
    flags: view.getUint8(5),
    pageSize: rawPageSize === 0 ? 65536 : rawPageSize,
    txid: view.getBigUint64(8, true),
    prevTxid: view.getBigUint64(16, true),
    epoch: view.getUint32(24, true),
    frameCount: view.getUint32(28, true),
    timestampUs: view.getBigUint64(32, true),
    commitSizePages: view.getUint32(40, true),
    walSalt1: view.getUint32(44, true),
    walSalt2: view.getUint32(48, true),
    walEndFrame: view.getUint32(52, true),
    preChecksum: view.getBigUint64(56, true),
    postChecksum: view.getBigUint64(64, true),
    bodyLength: view.getUint32(72, true),
    bodyPlainLength: view.getUint32(76, true),
  }
  if (header.version !== RECORD_VERSION && header.version !== RECORD_VERSION_LOGICAL) {
    throw new WalFormatError(`unsupported transaction record version ${header.version}`)
  }
  return { header, byteLength: RECORD_HEADER_SIZE + header.bodyLength }
}

export interface DecodedRecord {
  record: TxnRecord
  byteLength: number
}

/** Reads a whole record, verifying the header hash and the body hash. */
export function decode(bytes: Uint8Array, offset = 0): DecodedRecord {
  const head = decodeHeader(bytes, offset)
  if (!head) throw new WalFormatError(`truncated transaction record at offset ${offset}`)
  const { header, byteLength } = head
  if (bytes.byteLength - offset < byteLength) {
    throw new WalFormatError(`truncated transaction record body at offset ${offset}`)
  }
  const bodyStart = offset + RECORD_HEADER_SIZE
  const body = bytes.subarray(bodyStart, bodyStart + header.bodyLength)
  const plain =
    (header.flags & FLAG_ZSTD) === 0
      ? body
      : new Uint8Array(Bun.zstdDecompressSync(body))
  if (plain.byteLength !== header.bodyPlainLength) {
    throw new WalFormatError(
      `transaction record body is ${plain.byteLength} bytes, header says ${header.bodyPlainLength}`,
    )
  }
  const stored = new DataView(bytes.buffer, bytes.byteOffset + offset, RECORD_HEADER_SIZE)
  const [low, high] = hashParts(plain)
  if (stored.getBigUint64(80, true) !== low || stored.getBigUint64(88, true) !== high) {
    throw new WalFormatError(`transaction record body hash mismatch at txid ${header.txid}`)
  }

  const plainView = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  // P9: a version-2 body ends with the length of its logical trailer, which is what says where the
  // page region stopped. A version-1 body is all pages, exactly as it has always been.
  let pagesLength = plain.byteLength
  let logical: Uint8Array | undefined
  if (header.version === RECORD_VERSION_LOGICAL) {
    if (plain.byteLength < 4) {
      throw new WalFormatError(`transaction record body has no logical length at txid ${header.txid}`)
    }
    const logicalLength = plainView.getUint32(plain.byteLength - 4, true)
    if (logicalLength > plain.byteLength - 4) {
      throw new WalFormatError(
        `transaction record logical section is ${logicalLength} bytes of a ${plain.byteLength}-byte body`,
      )
    }
    pagesLength = plain.byteLength - 4 - logicalLength
    logical = plain.subarray(pagesLength, pagesLength + logicalLength)
  }

  const stride = 4 + header.pageSize
  if (pagesLength % stride !== 0) {
    throw new WalFormatError(`transaction record body is not a whole number of pages`)
  }
  const pages = new Map<number, Uint8Array>()
  for (let at = 0; at < pagesLength; at += stride) {
    const pgno = plainView.getUint32(at, true)
    pages.set(pgno, plain.subarray(at + 4, at + stride))
  }
  const record: TxnRecord = { ...header, pages }
  if (logical !== undefined) record.logical = logical
  return { record, byteLength }
}

/**
 * P9: the same transaction as a version-1 record, for a replica that announced
 * `maxRecordVersion: 1`. A version-1 record is returned untouched — the common case, and the only
 * one on a primary with `[replication] logicalChanges` off.
 *
 * It costs a zstd round trip, which is why the caller checks the version byte first rather than
 * calling this for every record: the downgrade is paid once per record per old peer, and only
 * while one is attached.
 */
export function stripLogical(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < RECORD_HEADER_SIZE) return bytes
  if (bytes[4] !== RECORD_VERSION_LOGICAL) return bytes
  const { record } = decode(bytes)
  const { logical: _dropped, ...rest } = record
  const input = { ...rest, version: RECORD_VERSION } as unknown as TxnRecordInput
  return encode(input, { compress: (record.flags & FLAG_ZSTD) !== 0 })
}

// ---------------------------------------------------------------------------
// Rolling database checksum (design §4.3): XOR over pages of xxh3_64(pgno ‖ page).
// ---------------------------------------------------------------------------

export class RollingChecksum {
  #value: bigint

  constructor(value = 0n) {
    this.#value = BigInt.asUintN(64, value)
  }

  get value(): bigint {
    return this.#value
  }

  /**
   * Folds one page change in: `chk ^= H(pgno, old) ^ H(pgno, new)`. Pass `null` for `oldPage`
   * when the page did not exist before, and `null` for `newPage` when the transaction shrank the
   * database past it.
   */
  apply(pgno: number, oldPage: Uint8Array | null, newPage: Uint8Array | null): void {
    this.applyHash(
      pgno,
      oldPage === null ? 0n : pageHash(pgno, oldPage),
      newPage === null ? 0n : pageHash(pgno, newPage),
    )
  }

  /** As `apply`, for a caller that already holds the hashes. `0n` means "page absent". */
  applyHash(_pgno: number, oldHash: bigint, newHash: bigint): void {
    this.#value = BigInt.asUintN(64, this.#value ^ oldHash ^ newHash)
  }

  set(value: bigint): void {
    this.#value = BigInt.asUintN(64, value)
  }

  clone(): RollingChecksum {
    return new RollingChecksum(this.#value)
  }
}

/** Where a pre-image comes from: the live WAL's page hashes, else the database file. */
export interface PageSource {
  /** Current size of the database in pages. */
  readonly sizePages: number
  /** Hash of the page as it stands now, or null when `pgno` is past the end. */
  hash(pgno: number): bigint | null
}

/**
 * A `PageSource` over a database file plus an overlay of pages written since the last WAL reset —
 * the `pgno → hash` map design §4.3 calls for. Reads of pages not in the overlay `pread` the
 * database file. The overlay stays correct across a PASSIVE checkpoint (backfilling copies the
 * same bytes into the file) and is cleared on a WAL reset, when the file becomes authoritative.
 */
export class LivePageSource implements PageSource {
  #fd: number | null = null
  readonly #pageSize: number
  #sizePages: number
  #overlay = new Map<number, bigint>()
  readonly dbPath: string

  constructor(dbPath: string, pageSize: number, sizePages: number) {
    this.dbPath = dbPath
    this.#pageSize = pageSize
    this.#sizePages = sizePages
  }

  get pageSize(): number {
    return this.#pageSize
  }

  get sizePages(): number {
    return this.#sizePages
  }

  set sizePages(pages: number) {
    this.#sizePages = pages
  }

  hash(pgno: number): bigint | null {
    if (pgno < 1 || pgno > this.#sizePages) return null
    const overlaid = this.#overlay.get(pgno)
    if (overlaid !== undefined) return overlaid
    const page = this.readPage(pgno)
    return page === null ? null : pageHash(pgno, page)
  }

  /** Raw page image from the database file, or null when the file is shorter than `pgno`. */
  readPage(pgno: number): Uint8Array | null {
    const fd = this.#open()
    if (fd === null) return null
    const buf = new Uint8Array(this.#pageSize)
    const read = fs.readSync(fd, buf, 0, this.#pageSize, (pgno - 1) * this.#pageSize)
    return read === this.#pageSize ? buf : null
  }

  /** Records the hash of a page the WAL now holds a newer version of. */
  record(pgno: number, hash: bigint): void {
    this.#overlay.set(pgno, hash)
  }

  /** Drops a page from the overlay, for a transaction that shrank the database past it. */
  forget(pgno: number): void {
    this.#overlay.delete(pgno)
  }

  /** Called on a WAL reset: the database file now holds every page. */
  resetOverlay(): void {
    this.#overlay.clear()
  }

  get overlaySize(): number {
    return this.#overlay.size
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
      this.#fd = fs.openSync(this.dbPath, "r")
    } catch {
      return null
    }
    return this.#fd
  }
}

/** A transaction's effect on the rolling checksum, computed but not yet committed. */
export interface TransactionFold {
  /** The rolling checksum the transaction would produce. */
  checksum: bigint
  /** Writes the new page hashes and size into the source and the checksum into the rolling. */
  commit(): void
}

/**
 * Works out what a committed transaction does to the rolling checksum, reading pre-images from
 * the page source before anything overwrites them. Nothing is mutated until `commit()` is called,
 * so a replica can compare the result against the record's `postChecksum` and reject a diverged
 * transaction with its own state untouched.
 *
 * A transaction that shrank the database XORs out every page above the new size, otherwise a
 * `VACUUM` would leave phantom pages in the checksum forever.
 */
export function foldTransaction(
  rolling: RollingChecksum,
  source: LivePageSource,
  txn: { pages: ReadonlyMap<number, Uint8Array>; commitSizePages: number },
): TransactionFold {
  const previousSize = source.sizePages
  const newSize = txn.commitSizePages
  const written: Array<[number, bigint]> = []
  const dropped: number[] = []
  let value = rolling.value

  for (const [pgno, page] of txn.pages) {
    const old = source.hash(pgno) ?? 0n
    // A page written and then truncated away inside the same transaction contributes nothing.
    const next = pgno <= newSize ? pageHash(pgno, page) : 0n
    value = BigInt.asUintN(64, value ^ old ^ next)
    written.push([pgno, next])
  }

  for (let pgno = newSize + 1; pgno <= previousSize; pgno++) {
    if (txn.pages.has(pgno)) continue
    const old = source.hash(pgno)
    if (old !== null) value = BigInt.asUintN(64, value ^ old)
    dropped.push(pgno)
  }

  return {
    checksum: value,
    commit(): void {
      for (const pgno of dropped) source.forget(pgno)
      source.sizePages = newSize
      for (const [pgno, hash] of written) {
        if (hash === 0n) source.forget(pgno)
        else source.record(pgno, hash)
      }
      rolling.set(value)
    },
  }
}

export interface FullChecksum {
  checksum: bigint
  pageSize: number
  pages: number
}

/**
 * Recomputes the rolling checksum from scratch, for verification. By default the live `-wal` is
 * overlaid, so the result is the database as a reader would see it; pass `includeWal: false` for
 * the file alone (which is what a snapshot, taken after a TRUNCATE checkpoint, holds).
 */
export function computeFull(
  dbPath: string,
  options: { includeWal?: boolean } = {},
): FullChecksum {
  let stat: fs.Stats
  try {
    stat = fs.statSync(dbPath)
  } catch {
    return { checksum: 0n, pageSize: 0, pages: 0 }
  }
  if (stat.size === 0) return { checksum: 0n, pageSize: 0, pages: 0 }

  const fd = fs.openSync(dbPath, "r")
  try {
    const head = new Uint8Array(100)
    fs.readSync(fd, head, 0, 100, 0)
    const pageSize = databasePageSize(head)
    if (pageSize === null) throw new WalFormatError(`${dbPath} is not a SQLite database`)
    let pages = databasePageCount(head) ?? Math.floor(stat.size / pageSize)

    // Latest committed version of each page held only in the WAL.
    const overlay = new Map<number, Uint8Array>()
    if (options.includeWal !== false) {
      const walPages = readWalOverlay(`${dbPath}-wal`, pageSize)
      if (walPages) {
        for (const [pgno, page] of walPages.pages) overlay.set(pgno, page)
        pages = walPages.commitSize
      }
    }

    const rolling = new RollingChecksum()
    const buf = new Uint8Array(pageSize)
    for (let pgno = 1; pgno <= pages; pgno++) {
      const overlaid = overlay.get(pgno)
      if (overlaid) {
        rolling.applyHash(pgno, 0n, pageHash(pgno, overlaid))
        continue
      }
      const read: number = fs.readSync(fd, buf, 0, pageSize, (pgno - 1) * pageSize)
      if (read !== pageSize) {
        throw new WalFormatError(`${dbPath} is short of page ${pgno} of ${pages}`)
      }
      rolling.applyHash(pgno, 0n, pageHash(pgno, buf))
    }
    return { checksum: rolling.value, pageSize, pages }
  } finally {
    fs.closeSync(fd)
  }
}

/** Latest committed version of every page in a WAL, for `computeFull`. */
function readWalOverlay(
  walPath: string,
  dbPageSize: number,
): { pages: Map<number, Uint8Array>; commitSize: number } | null {
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
    if (!header || header.pageSize !== dbPageSize) return null

    const frameSize = walFrameSize(header.pageSize)
    const frame = new Uint8Array(frameSize)
    let running = headerChecksum(header)
    const pending = new Map<number, Uint8Array>()
    const committed = new Map<number, Uint8Array>()
    let commitSize = 0
    let any = false

    for (let index = 1; ; index++) {
      const offset = walFrameOffset(index, header.pageSize)
      if (offset + frameSize > size) break
      fs.readSync(fd, frame, 0, frameSize, offset)
      const check = checkFrame(frame, 0, header, running)
      if (!check.valid) break
      running = check.next
      pending.set(check.header.pgno, frame.slice(WAL_FRAME_HEADER_SIZE))
      if (check.header.commitSize !== 0) {
        for (const [pgno, page] of pending) committed.set(pgno, page)
        pending.clear()
        commitSize = check.header.commitSize
        any = true
      }
    }
    return any ? { pages: committed, commitSize } : null
  } finally {
    fs.closeSync(fd)
  }
}
