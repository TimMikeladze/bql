// SQLite WAL byte format: header, frames, and the cumulative checksum chain. Pure functions over
// Uint8Array — nothing here opens a file or holds state.
//
// Invariant: a frame is valid iff its salts equal the WAL header's salts, its page number is
// non-zero, and its stored checksum equals the chain continued from the previous valid frame.
// Every field of both the header and the frame header is big-endian; only the *words fed to the
// checksum* follow the byte order named by the header magic.

export const WAL_HEADER_SIZE = 32
export const WAL_FRAME_HEADER_SIZE = 24

/** Magic for a WAL whose checksum words are read little-endian. */
export const WAL_MAGIC_LE = 0x377f0682
/** Magic for a WAL whose checksum words are read big-endian. */
export const WAL_MAGIC_BE = 0x377f0683
/** `WAL_MAX_VERSION` in wal.c. */
export const WAL_VERSION = 3007000

export const MIN_PAGE_SIZE = 512
export const MAX_PAGE_SIZE = 65536

/** The `-shm` prefix SQLite treats as the wal-index header; zeroing it forces a rebuild. */
export const SHM_HEADER_SIZE = 136

/** Running state of the checksum chain: `[s0, s1]`. */
export type Checksum = readonly [number, number]

/** The seed both chains start from, at the WAL header and at each frame's predecessor. */
export const ZERO_CHECKSUM: Checksum = [0, 0]

export interface WalHeader {
  magic: number
  /** True when checksum words are read little-endian (magic 0x377f0682). */
  littleEndianChecksum: boolean
  version: number
  pageSize: number
  /** Checkpoint sequence; incremented on every WAL reset. */
  checkpointSeq: number
  salt1: number
  salt2: number
  checksum1: number
  checksum2: number
}

export interface FrameHeader {
  pgno: number
  /** Database size in pages when this frame commits a transaction, 0 otherwise. */
  commitSize: number
  salt1: number
  salt2: number
  checksum1: number
  checksum2: number
}

/** Bytes one frame occupies: 24-byte header plus a page. */
export function walFrameSize(pageSize: number): number {
  return WAL_FRAME_HEADER_SIZE + pageSize
}

/**
 * Byte offset of frame `index` in the WAL file. Frames are 1-based, matching SQLite's `mxFrame`
 * and the `frame` field of a tailer position; frame 0 means "no frames".
 */
export function walFrameOffset(index: number, pageSize: number): number {
  return WAL_HEADER_SIZE + (index - 1) * walFrameSize(pageSize)
}

/** Number of whole frames a WAL of `size` bytes can hold. */
export function walFrameCapacity(size: number, pageSize: number): number {
  if (size < WAL_HEADER_SIZE) return 0
  return Math.floor((size - WAL_HEADER_SIZE) / walFrameSize(pageSize))
}

/**
 * Continues the WAL checksum chain over `length` bytes at `offset`.
 *
 *     s0 += x[i]   + s1
 *     s1 += x[i+1] + s0
 *
 * `length` must be a multiple of 8; SQLite only ever checksums the 8-byte frame prefix, the
 * 24-byte header prefix, and whole pages.
 */
export function checksum(
  bytes: Uint8Array,
  offset: number,
  length: number,
  previous: Checksum,
  littleEndian: boolean,
): Checksum {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length)
  let s0 = previous[0]
  let s1 = previous[1]
  for (let i = 0; i < length; i += 8) {
    s0 = (s0 + view.getUint32(i, littleEndian) + s1) >>> 0
    s1 = (s1 + view.getUint32(i + 4, littleEndian) + s0) >>> 0
  }
  return [s0, s1]
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

/**
 * Reads a WAL header without validating it. Returns null when the buffer is short, the magic is
 * not a WAL magic, or the page size is not a legal power of two — all of which mean "this is not
 * a WAL header (yet)", not "this file is corrupt".
 */
export function readWalHeader(bytes: Uint8Array, offset = 0): WalHeader | null {
  if (bytes.byteLength - offset < WAL_HEADER_SIZE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, WAL_HEADER_SIZE)
  const magic = view.getUint32(0)
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) return null
  const pageSize = view.getUint32(8)
  if (!isPowerOfTwo(pageSize) || pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) return null
  return {
    magic,
    littleEndianChecksum: (magic & 1) === 0,
    version: view.getUint32(4),
    pageSize,
    checkpointSeq: view.getUint32(12),
    salt1: view.getUint32(16),
    salt2: view.getUint32(20),
    checksum1: view.getUint32(24),
    checksum2: view.getUint32(28),
  }
}

/** True when the header's own checksum, taken over bytes 0..23, matches what it stores. */
export function walHeaderChecksumValid(bytes: Uint8Array, header: WalHeader, offset = 0): boolean {
  const [s0, s1] = checksum(bytes, offset, 24, ZERO_CHECKSUM, header.littleEndianChecksum)
  return s0 === header.checksum1 && s1 === header.checksum2
}

/**
 * Reads and fully validates a WAL header. Returns null when the bytes are not a valid header, so
 * a caller polling a WAL that is mid-reset simply sees "nothing to read".
 */
export function parseWalHeader(bytes: Uint8Array, offset = 0): WalHeader | null {
  const header = readWalHeader(bytes, offset)
  if (!header) return null
  if (!walHeaderChecksumValid(bytes, header, offset)) return null
  return header
}

/** The checksum chain a WAL's first frame continues from: the header's own checksum. */
export function headerChecksum(header: WalHeader): Checksum {
  return [header.checksum1, header.checksum2]
}

/**
 * Encodes a WAL header, computing and filling in its checksum. `version` defaults to
 * `WAL_MAX_VERSION` and `magic` to the little-endian-checksum spelling.
 */
export function encodeWalHeader(header: {
  pageSize: number
  salt1: number
  salt2: number
  checkpointSeq?: number
  magic?: number
  version?: number
}): { bytes: Uint8Array; header: WalHeader } {
  const magic = header.magic ?? WAL_MAGIC_LE
  const littleEndian = (magic & 1) === 0
  const bytes = new Uint8Array(WAL_HEADER_SIZE)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, magic)
  view.setUint32(4, header.version ?? WAL_VERSION)
  view.setUint32(8, header.pageSize)
  view.setUint32(12, header.checkpointSeq ?? 0)
  view.setUint32(16, header.salt1 >>> 0)
  view.setUint32(20, header.salt2 >>> 0)
  const [s0, s1] = checksum(bytes, 0, 24, ZERO_CHECKSUM, littleEndian)
  view.setUint32(24, s0)
  view.setUint32(28, s1)
  return {
    bytes,
    header: {
      magic,
      littleEndianChecksum: littleEndian,
      version: header.version ?? WAL_VERSION,
      pageSize: header.pageSize,
      checkpointSeq: header.checkpointSeq ?? 0,
      salt1: header.salt1 >>> 0,
      salt2: header.salt2 >>> 0,
      checksum1: s0,
      checksum2: s1,
    },
  }
}

/** Reads a frame header from `bytes` at `offset`. Does not validate. */
export function parseFrameHeader(bytes: Uint8Array, offset = 0): FrameHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, WAL_FRAME_HEADER_SIZE)
  return {
    pgno: view.getUint32(0),
    commitSize: view.getUint32(4),
    salt1: view.getUint32(8),
    salt2: view.getUint32(12),
    checksum1: view.getUint32(16),
    checksum2: view.getUint32(20),
  }
}

/**
 * The checksum a frame must carry: the chain continued over the frame's first 8 bytes (pgno and
 * commit size, not the salts) and then over the whole page.
 */
export function frameChecksum(
  frame: Uint8Array,
  offset: number,
  pageSize: number,
  previous: Checksum,
  littleEndian: boolean,
): Checksum {
  const afterHeader = checksum(frame, offset, 8, previous, littleEndian)
  return checksum(frame, offset + WAL_FRAME_HEADER_SIZE, pageSize, afterHeader, littleEndian)
}

export interface FrameCheck {
  valid: boolean
  header: FrameHeader
  /** The chain after this frame; only meaningful when `valid`. */
  next: Checksum
}

/**
 * Validates one frame in place: salts must equal the WAL header's, the page number must be
 * non-zero, and the checksum must continue `previous`.
 */
export function checkFrame(
  bytes: Uint8Array,
  offset: number,
  walHeader: WalHeader,
  previous: Checksum,
): FrameCheck {
  const header = parseFrameHeader(bytes, offset)
  if (header.salt1 !== walHeader.salt1 || header.salt2 !== walHeader.salt2 || header.pgno === 0) {
    return { valid: false, header, next: previous }
  }
  const next = frameChecksum(
    bytes,
    offset,
    walHeader.pageSize,
    previous,
    walHeader.littleEndianChecksum,
  )
  const valid = next[0] === header.checksum1 && next[1] === header.checksum2
  return { valid, header, next }
}

/**
 * Writes one frame into `out` at `offset`, filling the header and computing its checksum from
 * `previous`. Returns the chain after this frame. `page.byteLength` must equal
 * `walHeader.pageSize`.
 */
export function encodeFrame(
  out: Uint8Array,
  offset: number,
  frame: { pgno: number; commitSize: number; page: Uint8Array },
  walHeader: WalHeader,
  previous: Checksum,
): Checksum {
  const view = new DataView(out.buffer, out.byteOffset + offset, walFrameSize(walHeader.pageSize))
  view.setUint32(0, frame.pgno)
  view.setUint32(4, frame.commitSize)
  view.setUint32(8, walHeader.salt1)
  view.setUint32(12, walHeader.salt2)
  out.set(frame.page, offset + WAL_FRAME_HEADER_SIZE)
  const next = frameChecksum(
    out,
    offset,
    walHeader.pageSize,
    previous,
    walHeader.littleEndianChecksum,
  )
  view.setUint32(16, next[0])
  view.setUint32(20, next[1])
  return next
}

/** A 32-bit salt. `salt1` increments on reset, `salt2` is re-randomised; both are opaque. */
export function randomSalt(): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] as number
}

/**
 * Page size recorded in a SQLite database file header (offset 16, big-endian u16, where 1 means
 * 65536). Returns null when the bytes are not a SQLite database header.
 */
export function databasePageSize(headerBytes: Uint8Array): number | null {
  if (headerBytes.byteLength < 100) return null
  const magic = "SQLite format 3\0"
  for (let i = 0; i < magic.length; i++) {
    if (headerBytes[i] !== magic.charCodeAt(i)) return null
  }
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, 100)
  const raw = view.getUint16(16)
  const pageSize = raw === 1 ? 65536 : raw
  if (!isPowerOfTwo(pageSize) || pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) return null
  return pageSize
}

/**
 * Page count from a SQLite database file header (offset 28). Only trustworthy when the file
 * change counter (offset 24) equals the version-valid-for number (offset 92); returns null
 * otherwise so the caller falls back to the file size.
 */
export function databasePageCount(headerBytes: Uint8Array): number | null {
  if (headerBytes.byteLength < 100) return null
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, 100)
  if (view.getUint32(24) !== view.getUint32(92)) return null
  const pages = view.getUint32(28)
  return pages > 0 ? pages : null
}
