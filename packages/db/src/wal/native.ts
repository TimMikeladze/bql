// The WAL frame checksum, in C when the vendored libsqlite3 carries it. `src/wal/codec.ts` stays
// the reference implementation and this falls back to it; `test/wal/native.test.ts` holds the two
// to each other.
//
// Invariant: a faithful replacement, never a fast path with a narrower domain. When the native
// helper is present every frame goes through it; when it is absent every frame goes through
// `checkFrame`. There is no third behaviour and no size threshold to get wrong.
//
// Why it exists: the JavaScript loop is 1024 bounds-checked scalar loads for a 4 KiB page and
// costs 4.79 µs — 71% of a `WalTailer.poll()`. Four ways of rewriting it in JavaScript were
// measured and none of them moved it. `docs/p3-wal-checksum.md`.

import { sqlite, type WalsumSymbols } from "../sqlite/index.ts"
import {
  checkFrame,
  type Checksum,
  type FrameCheck,
  parseFrameHeader,
  type WalHeader,
} from "./codec.ts"

/** The host's own word order, which is what makes the native fast branch legal. */
const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/**
 * `BQL_WAL_NATIVE=0` forces the JavaScript, so the fallback is testable without deleting a
 * library, and CI exercises both paths on a machine that has the helper.
 */
function wanted(): boolean {
  return process.env.BQL_WAL_NATIVE !== "0"
}

/**
 * Five `u32` the helper writes into: valid, pgno, commitSize, s0, s1. One per accelerator, not one
 * per call — the helper is synchronous and single-threaded, so the buffer cannot be in use twice.
 */
const OUT_WORDS = 5

export class WalChecksum {
  readonly #symbols: WalsumSymbols
  readonly #out = new Uint32Array(OUT_WORDS)

  private constructor(symbols: WalsumSymbols) {
    this.#symbols = symbols
  }

  /**
   * The accelerator this process can use, or null when the loaded libsqlite3 does not carry the
   * helper — a system library, or a vendored build from before `docs/p3-wal-checksum.md`.
   */
  static open(): WalChecksum | null {
    if (!wanted()) return null
    try {
      const lib = sqlite()
      return lib.walsum ? new WalChecksum(lib.walsum) : null
    } catch {
      // No library at all. Every caller here already needs one, but failing to *accelerate* must
      // never be the thing that throws.
      return null
    }
  }

  /**
   * Validates one frame in place, exactly as `checkFrame` does. `bytes` must start the frame at
   * `offset`; the helper reads `24 + walHeader.pageSize` bytes from there.
   */
  check(bytes: Uint8Array, offset: number, walHeader: WalHeader, previous: Checksum): FrameCheck {
    const frame = offset === 0 ? bytes : bytes.subarray(offset)
    const out = this.#out
    this.#symbols.bql_wal_check_frame(
      frame,
      walHeader.pageSize,
      walHeader.salt1,
      walHeader.salt2,
      previous[0],
      previous[1],
      walHeader.littleEndianChecksum === NATIVE_LITTLE_ENDIAN ? 1 : 0,
      out,
    )
    const valid = out[0] === 1
    return {
      valid,
      // The frame header is eight cheap byte reads; building it here keeps `FrameCheck` the same
      // shape the JavaScript returns, salts included, which is what the differential test compares.
      header: parseFrameHeader(bytes, offset),
      next: [out[3] as number, out[4] as number],
    }
  }

  /** Continues the chain over `length` bytes at `offset`. Same contract as `codec.checksum`. */
  sum(
    bytes: Uint8Array,
    offset: number,
    length: number,
    previous: Checksum,
    littleEndian: boolean,
  ): Checksum {
    const view = offset === 0 ? bytes : bytes.subarray(offset)
    const out = this.#out
    out[0] = previous[0]
    out[1] = previous[1]
    this.#symbols.bql_wal_checksum(
      view,
      length,
      littleEndian === NATIVE_LITTLE_ENDIAN ? 1 : 0,
      out,
    )
    return [out[0] as number, out[1] as number]
  }
}

/**
 * The process-wide accelerator, resolved once. `null` means every caller uses `checkFrame`, which
 * is what a node on a system libsqlite3 does.
 */
let accelerator: WalChecksum | null | undefined

export function walChecksum(): WalChecksum | null {
  if (accelerator === undefined) accelerator = WalChecksum.open()
  return accelerator
}

/** Forgets the resolved accelerator, so a test can flip `BQL_WAL_NATIVE` and re-resolve. */
export function resetWalChecksum(): void {
  accelerator = undefined
}

/** True when this process is checking frames in C. `bql serve` says so when it is false. */
export function walChecksumIsNative(): boolean {
  return walChecksum() !== null
}

/**
 * `checkFrame`, accelerated where it can be. Identical results either way — that is the invariant
 * at the top of this file, and `test/wal/native.test.ts` is what holds it.
 */
export function checkFrameFast(
  bytes: Uint8Array,
  offset: number,
  walHeader: WalHeader,
  previous: Checksum,
): FrameCheck {
  const native = walChecksum()
  if (native === null) return checkFrame(bytes, offset, walHeader, previous)
  return native.check(bytes, offset, walHeader, previous)
}
