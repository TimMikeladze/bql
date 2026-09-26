// SQLite's wal-index header — the 136 bytes at the start of a `-shm` file that tell a reader
// where the database's current content lives. Pure functions over Uint8Array; nothing here opens
// a file or holds state. `codec.ts` plays this role for the WAL itself.
//
// Invariant: every field is read and written in **native** byte order, and the checksum over the
// first 40 bytes is `walChecksumBytes(nativeCksum = 1, …)` seeded from zero. This is shared
// memory, not a file format — it never crosses a machine, and SQLite reads it as a struct.
//
// Layout (amalgamation, `struct WalIndexHdr` / `struct WalCkptInfo`):
//
//    0  iVersion u32           48  the same 48 bytes again, copy 1
//    4  unused u32             96  nBackfill u32
//    8  iChange u32           100  aReadMark[5] u32
//   12  isInit u8             120  aLock[8]  — reserved for locks, never read or written
//   13  bigEndCksum u8        128  nBackfillAttempted u32
//   14  szPage u16            132  notUsed0 u32
//   16  mxFrame u32
//   20  nPage u32             A reader reads copy 0, then copy 1, and treats a mismatch as a torn
//   24  aFrameCksum[2] u32    read. `walIndexWriteHdr` therefore writes copy 1 first and copy 0
//   32  aSalt[2] u32          second, and so does the applier — a writer that goes the other way
//   40  aCksum[2] u32         is still safe, but this way the reason is the same one.

/** One `WalIndexHdr`. Two copies start the `-shm` file. */
export const WALINDEX_HDR_COPY_SIZE = 48
/** Both copies plus the `WalCkptInfo` that follows them: SQLite's `WALINDEX_HDR_SIZE`. */
export const WALINDEX_HDR_SIZE = 136
/** Offset of `WalCkptInfo` — `nBackfill`, then the five read marks. */
export const WALINDEX_CKPT_OFFSET = 96
/** `WalCkptInfo.aLock`. Reserved for byte-range locks; never read, never written. */
export const WALINDEX_LOCK_OFFSET = 120
export const WALINDEX_LOCK_SIZE = 8
/** `WALINDEX_MAX_VERSION` in wal.c. */
export const WALINDEX_MAX_VERSION = 3007000
/** `READMARK_NOT_USED`: this read mark is free. */
export const READMARK_NOT_USED = 0xffffffff
/** `WAL_NREADER` — read marks, and therefore read locks, in a wal-index. */
export const WAL_NREADER = 5
/** `SQLITE_SHM_NLOCK` — write, checkpoint, recover, and five read locks. */
export const SHM_NLOCK = 8

export interface WalIndexHeader {
  iVersion: number
  iChange: number
  isInit: boolean
  bigEndCksum: boolean
  /** Page size in bytes. Stored as 1 for 65536; this field holds the real size. */
  pageSize: number
  mxFrame: number
  nPage: number
  frameCksum: readonly [number, number]
  salt: readonly [number, number]
  cksum: readonly [number, number]
}

/** True everywhere bql.sh runs; the header is native-order, so it is asked rather than assumed. */
export const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/**
 * `walChecksumBytes(nativeCksum = 1, a, nByte, 0, out)`. The same chain the WAL frame checksum
 * uses, but always reading 32-bit words in the host's own order and always seeded from zero.
 * `length` must be a multiple of 8.
 */
export function walIndexChecksum(bytes: Uint8Array, offset = 0, length = 40): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length)
  const native = NATIVE_LITTLE_ENDIAN
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < length; i += 8) {
    s1 = (s1 + view.getUint32(i, native) + s2) >>> 0
    s2 = (s2 + view.getUint32(i + 4, native) + s1) >>> 0
  }
  return [s1, s2]
}

/**
 * Encodes one `WalIndexHdr` copy, filling in `iVersion`, `isInit` and the checksum the way
 * `walIndexWriteHdr` does. The returned bytes are 48 long and go at offset 0 and offset 48.
 */
export function encodeWalIndexHeader(header: {
  iChange: number
  pageSize: number
  mxFrame?: number
  nPage: number
  bigEndCksum?: boolean
  frameCksum?: readonly [number, number]
  salt?: readonly [number, number]
}): Uint8Array {
  const bytes = new Uint8Array(WALINDEX_HDR_COPY_SIZE)
  const view = new DataView(bytes.buffer)
  const native = NATIVE_LITTLE_ENDIAN
  const frameCksum = header.frameCksum ?? [0, 0]
  const salt = header.salt ?? [0, 0]
  view.setUint32(0, WALINDEX_MAX_VERSION, native)
  view.setUint32(4, 0, native)
  view.setUint32(8, header.iChange >>> 0, native)
  bytes[12] = 1
  bytes[13] = header.bigEndCksum ? 1 : 0
  view.setUint16(14, header.pageSize === 65536 ? 1 : header.pageSize, native)
  view.setUint32(16, header.mxFrame ?? 0, native)
  view.setUint32(20, header.nPage, native)
  view.setUint32(24, frameCksum[0] >>> 0, native)
  view.setUint32(28, frameCksum[1] >>> 0, native)
  view.setUint32(32, salt[0] >>> 0, native)
  view.setUint32(36, salt[1] >>> 0, native)
  const [c1, c2] = walIndexChecksum(bytes, 0, 40)
  view.setUint32(40, c1, native)
  view.setUint32(44, c2, native)
  return bytes
}

/**
 * Reads one `WalIndexHdr` copy. Returns null when the bytes are short or `isInit` is 0, which is
 * what a freshly created `-shm` looks like — "not a header yet", not "corrupt".
 */
export function readWalIndexHeader(bytes: Uint8Array, offset = 0): WalIndexHeader | null {
  if (bytes.byteLength - offset < WALINDEX_HDR_COPY_SIZE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, WALINDEX_HDR_COPY_SIZE)
  const native = NATIVE_LITTLE_ENDIAN
  if (bytes[offset + 12] !== 1) return null
  const raw = view.getUint16(14, native)
  return {
    iVersion: view.getUint32(0, native),
    iChange: view.getUint32(8, native),
    isInit: true,
    bigEndCksum: bytes[offset + 13] === 1,
    pageSize: raw === 1 ? 65536 : raw,
    mxFrame: view.getUint32(16, native),
    nPage: view.getUint32(20, native),
    frameCksum: [view.getUint32(24, native), view.getUint32(28, native)],
    salt: [view.getUint32(32, native), view.getUint32(36, native)],
    cksum: [view.getUint32(40, native), view.getUint32(44, native)],
  }
}

/** True when the header's stored checksum matches the one its first 40 bytes produce. */
export function walIndexHeaderValid(bytes: Uint8Array, offset = 0): boolean {
  const header = readWalIndexHeader(bytes, offset)
  if (!header) return false
  const [c1, c2] = walIndexChecksum(bytes, offset, 40)
  return c1 === header.cksum[0] && c2 === header.cksum[1]
}

/**
 * Encodes the 24 bytes of `WalCkptInfo` before the lock bytes: `nBackfill` and the five read
 * marks. `aReadMark[0]` is always 0 — a reader holding `WAL_READ_LOCK(0)` ignores the WAL entirely
 * and reads the database file, which is the state mechanism A keeps a replica in. The remaining
 * four are `READMARK_NOT_USED`.
 *
 * The eight lock bytes at 120 are **not** part of this and are never written: the amalgamation
 * says they "should never be read or written".
 */
export function encodeCkptInfo(nBackfill = 0): Uint8Array {
  const bytes = new Uint8Array(WALINDEX_LOCK_OFFSET - WALINDEX_CKPT_OFFSET)
  const view = new DataView(bytes.buffer)
  const native = NATIVE_LITTLE_ENDIAN
  view.setUint32(0, nBackfill, native)
  view.setUint32(4, 0, native)
  for (let i = 1; i < WAL_NREADER; i++) view.setUint32(4 + i * 4, READMARK_NOT_USED, native)
  return bytes
}
