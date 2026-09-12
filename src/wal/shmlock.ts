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
// `sqlite3_io_methods` on a 64-bit target: `int iVersion` plus four bytes of padding, then
// xClose, xRead, xWrite, xTruncate, xSync, xFileSize, xLock, xUnlock, xCheckReservedLock,
// xFileControl, xSectorSize, xDeviceCharacteristics, xShmMap, xShmLock — so xShmLock is at
// 8 + 13 * 8 = 112, and it is only present when `iVersion >= 2`.

import { CFunction, FFIType as T, type Pointer, read } from "bun:ffi"
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
const IO_METHODS_XSHMLOCK_OFFSET = 112
const IO_METHODS_MIN_VERSION = 2

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
    const out = new BigUint64Array(1)
    const rc = db.fileControl(SQLITE_FCNTL_FILE_POINTER, out)
    if (rc !== SQLITE_OK || out[0] === 0n) {
      return { locks: null, probe: { available: false, reason: "no-file-pointer" } }
    }
    const file = Number(out[0])
    const methods = read.ptr(file, 0)
    if (methods === 0) {
      return { locks: null, probe: { available: false, reason: "no-methods" } }
    }
    if (read.i32(methods, 0) < IO_METHODS_MIN_VERSION) {
      return { locks: null, probe: { available: false, reason: "no-shm-methods" } }
    }
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
