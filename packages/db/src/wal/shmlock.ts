// SQLite's WAL lock set, taken through SQLite's own VFS. The only file in `src/wal/` that touches
// FFI, and it exists for one reason: mechanism A (design §4.5, `docs/c5-apply-pages.md`) rewrites
// a replica's database file, and it must not do that while a reader is mid-transaction.
//
// Invariant: the locks are taken through `xShmLock` on the connection's own `sqlite3_file`, never
// with `fcntl` on the `-shm` file by hand. POSIX byte-range locks are per *process*: a lock taken
// on our own descriptor would be invisible to a reader in this process and would be dropped by
// any `close()` of any descriptor for that file. Going through the VFS gets `unixShmNode`'s
// in-process bookkeeping, which is what makes an in-process reader block the applier.
//
// The same file also reaches the wal-index *itself*, through `xShmMap`, and `WalIndex` is why:
// mechanism A publishes a header into shared memory, and writing shared memory through the `-shm`
// file descriptor is a thing POSIX tolerates and Windows refuses outright while a mapping exists
// (`ERROR_USER_MAPPED_FILE`, which libuv reports as `EBUSY`). `walIndexWriteHdr` stores into the
// mapping and calls `xShmBarrier`; so do we. `docs/e2-windows-gate.md` §2.
//
// `sqlite3_io_methods` on a 64-bit target: `int iVersion` plus four bytes of padding, then
// xClose, xRead, xWrite, xTruncate, xSync, xFileSize, xLock, xUnlock, xCheckReservedLock,
// xFileControl, xSectorSize, xDeviceCharacteristics, xShmMap, xShmLock, xShmBarrier — so xShmMap
// is at 8 + 12 * 8 = 104, xShmLock at 112 and xShmBarrier at 120, and none of them is present
// unless `iVersion >= 2`.

import { CFunction, FFIType as T, type Pointer, read, toArrayBuffer } from "bun:ffi"
import {
  type Database,
  SHM_EXCLUSIVE,
  SHM_LOCK,
  SHM_UNLOCK,
  SQLITE_BUSY,
  SQLITE_OK,
} from "../sqlite/index.ts"
import { SHM_NLOCK } from "./shm.ts"

const SQLITE_FCNTL_FILE_POINTER = 7
const IO_METHODS_XSHMMAP_OFFSET = 104
const IO_METHODS_XSHMLOCK_OFFSET = 112
const IO_METHODS_XSHMBARRIER_OFFSET = 120
const IO_METHODS_MIN_VERSION = 2

/**
 * `WALINDEX_PGSZ` in wal.c: one wal-index region. Region 0 begins with the two `WalIndexHdr`
 * copies and the `WalCkptInfo`, which is everything the applier publishes.
 */
const WALINDEX_REGION_SIZE = 32768

/** Why the WAL lock set could not be reached on this connection. */
export type WalLocksUnavailable =
  | "no-file-pointer"
  | "no-methods"
  | "no-shm-methods"
  | "no-shm-mapping"

export interface WalLocksProbe {
  available: boolean
  reason: WalLocksUnavailable | null
}

type ShmLock = (file: number, offset: number, n: number, flags: number) => number
type ShmMap = (file: number, region: number, size: number, extend: number, pp: PtrArg) => number
type ShmBarrier = (file: number) => void
type PtrArg = ArrayBufferView | number | null

/**
 * The `sqlite3_file` behind a connection and its `sqlite3_io_methods`, or why neither can be had.
 * Both `WalLocks` and `WalIndex` start here; there is one copy of the two `read.ptr` steps and of
 * the `iVersion` check that says whether the shm half of the table exists at all.
 */
function ioMethods(db: Database): { file: number; methods: number } | WalLocksUnavailable {
  const out = new BigUint64Array(1)
  const rc = db.fileControl(SQLITE_FCNTL_FILE_POINTER, out)
  if (rc !== SQLITE_OK || out[0] === 0n) return "no-file-pointer"
  const file = Number(out[0])
  const methods = read.ptr(file, 0)
  if (methods === 0) return "no-methods"
  if (read.i32(methods, 0) < IO_METHODS_MIN_VERSION) return "no-shm-methods"
  return { file, methods }
}

/**
 * The eight WAL locks — write, checkpoint, recover and five read marks — of one connection,
 * taken and released as a set. Construct with `WalLocks.open`, which answers null when the VFS
 * cannot offer them and the caller must fall back to mechanism B.
 */
export class WalLocks {
  readonly #file: number
  readonly #lock: ShmLock
  #held = false

  private constructor(file: number, lock: ShmLock) {
    this.#file = file
    this.#lock = lock
  }

  /**
   * Resolves `xShmLock` for `db`, or explains why it cannot. The connection must already have a
   * wal-index mapped — a single read statement does it, and `unixShmLock` answers
   * `SQLITE_IOERR_SHMLOCK` on one that has not — so this proves the whole path by taking the lock
   * set once and releasing it.
   */
  static open(db: Database): { locks: WalLocks | null; probe: WalLocksProbe } {
    const resolved = ioMethods(db)
    if (typeof resolved === "string") {
      return { locks: null, probe: { available: false, reason: resolved } }
    }
    const { file, methods } = resolved
    const fn = read.ptr(methods, IO_METHODS_XSHMLOCK_OFFSET)
    if (fn === 0) {
      return { locks: null, probe: { available: false, reason: "no-shm-methods" } }
    }
    const call = CFunction({
      ptr: fn as unknown as Pointer,
      args: [T.ptr, T.i32, T.i32, T.i32],
      returns: T.i32,
    }) as unknown as ShmLock

    // Prove the shm is mapped rather than assuming it: a connection that has never read has no
    // `pShm` and every lock would fail with SQLITE_IOERR_SHMLOCK. SQLITE_BUSY is a *working* lock
    // path with a reader on it, so it counts as available.
    const probeRc = call(file, 0, SHM_NLOCK, SHM_LOCK | SHM_EXCLUSIVE)
    if (probeRc === SQLITE_OK) {
      call(file, 0, SHM_NLOCK, SHM_UNLOCK | SHM_EXCLUSIVE)
    } else if (probeRc !== SQLITE_BUSY) {
      return { locks: null, probe: { available: false, reason: "no-shm-mapping" } }
    }
    return { locks: new WalLocks(file, call), probe: { available: true, reason: null } }
  }

  get held(): boolean {
    return this.#held
  }

  /**
   * Takes all eight slots exclusively in one call. Returns true, or false for `SQLITE_BUSY` —
   * a reader mid-transaction, which is the expected answer rather than an error.
   *
   * One call rather than eight: `unixShmLock` takes or refuses the whole range atomically, so the
   * applier never holds a partial set. SQLite's own ordering rule — recover, checkpointer, writer,
   * readers — exists to stop a caller that *escalates* one lock at a time from deadlocking, and
   * there is nothing to escalate here.
   */
  tryLock(): boolean {
    if (this.#held) return true
    if (this.#lock(this.#file, 0, SHM_NLOCK, SHM_LOCK | SHM_EXCLUSIVE) !== SQLITE_OK) return false
    this.#held = true
    return true
  }

  /** Releases the set. Safe to call when nothing is held. */
  unlock(): void {
    if (!this.#held) return
    this.#held = false
    this.#lock(this.#file, 0, SHM_NLOCK, SHM_UNLOCK | SHM_EXCLUSIVE)
  }
}

/**
 * Region 0 of a connection's wal-index, as SQLite's own VFS mapped it — the 32 KiB that begins
 * with the two `WalIndexHdr` copies and the `WalCkptInfo`.
 *
 * Invariant: this never extends the mapping. `bExtend = 0` means "the region if it is already
 * there, nothing if it is not", so `open` answers null for a connection that has never read and
 * the caller writes the `-shm` file instead — which is the right answer in exactly that case,
 * because nothing has the file mapped.
 *
 * Why a mapping rather than the descriptor the applier already holds: a store into shared memory
 * is what SQLite itself does, it is coherent with every other mapping of the same region, and it
 * is the only form Windows permits at all while a section object exists over the file
 * (`docs/e2-windows-gate.md` §2).
 */
export class WalIndex {
  readonly #file: number
  readonly #barrier: ShmBarrier
  readonly #bytes: Uint8Array

  private constructor(file: number, barrier: ShmBarrier, bytes: Uint8Array) {
    this.#file = file
    this.#barrier = barrier
    this.#bytes = bytes
  }

  /** Resolves and maps region 0, or answers null when this VFS or this connection has none. */
  static open(db: Database): WalIndex | null {
    const resolved = ioMethods(db)
    if (typeof resolved === "string") return null
    const { file, methods } = resolved
    const mapFn = read.ptr(methods, IO_METHODS_XSHMMAP_OFFSET)
    const barrierFn = read.ptr(methods, IO_METHODS_XSHMBARRIER_OFFSET)
    if (mapFn === 0 || barrierFn === 0) return null

    const map = CFunction({
      ptr: mapFn as unknown as Pointer,
      args: [T.ptr, T.i32, T.i32, T.i32, T.ptr],
      returns: T.i32,
    }) as unknown as ShmMap
    const barrier = CFunction({
      ptr: barrierFn as unknown as Pointer,
      args: [T.ptr],
      returns: T.void,
    }) as unknown as ShmBarrier

    const pp = new BigUint64Array(1)
    if (map(file, 0, WALINDEX_REGION_SIZE, 0, pp) !== SQLITE_OK) return null
    const region = Number(pp[0])
    if (region === 0) return null

    const bytes = new Uint8Array(
      toArrayBuffer(region as unknown as Pointer, 0, WALINDEX_REGION_SIZE),
    )
    return new WalIndex(file, barrier, bytes)
  }

  /** `length` bytes from `offset` within region 0, copied out of shared memory. */
  read(length: number, offset: number): Uint8Array {
    return this.#bytes.slice(offset, offset + length)
  }

  /** Copies `src` to `offset` within region 0. Bounds are checked; a short region is a bug. */
  write(src: Uint8Array, offset: number): void {
    if (offset < 0 || offset + src.byteLength > this.#bytes.byteLength) {
      throw new RangeError(
        `wal-index write of ${src.byteLength} bytes at ${offset} leaves region 0`,
      )
    }
    this.#bytes.set(src, offset)
  }

  /**
   * `xShmBarrier`. Between the two header copies, because a reader that sees copy 0 updated and
   * copy 1 not yet treats the pair as a torn read — which is safe, but it costs it a recovery.
   */
  barrier(): void {
    this.#barrier(this.#file)
  }
}
