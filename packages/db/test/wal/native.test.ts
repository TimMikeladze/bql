// The native WAL checksum against the JavaScript one. This file is the whole warrant for
// `src/wal/native.ts`: it is only allowed to be faster, never to disagree.
//
// `docs/p3-wal-checksum.md`.

import fs from "node:fs"
import { afterAll, describe, expect, test } from "bun:test"
import { sqlite } from "../../src/sqlite/index.ts"
import {
  checkFrame,
  type Checksum,
  checksum,
  encodeFrame,
  encodeWalHeader,
  headerChecksum,
  parseWalHeader,
  randomSalt,
  WAL_HEADER_SIZE,
  WAL_MAGIC_BE,
  WAL_MAGIC_LE,
  type WalHeader,
  walFrameSize,
} from "../../src/wal/index.ts"
import {
  checkFrameFast,
  resetWalChecksum,
  walChecksum,
  walChecksumIsNative,
} from "../../src/wal/native.ts"
import { cleanupTempDirs, openPrimary, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

/**
 * True when this process really is checking frames in C: the loaded libsqlite3 carries
 * `scripts/native/walsum.c` and nothing has switched it off. The differential tests below run
 * either way — with the helper absent they compare `checkFrame` against itself, which is cheap and
 * still worth having — and only the tests that assert the native path exists are gated.
 */
const NATIVE = walChecksumIsNative()

/** A WAL header and a buffer holding `count` valid frames, built with the JavaScript encoder. */
function wal(
  count: number,
  pageSize: number,
  magic: number,
): { header: WalHeader; bytes: Uint8Array } {
  const { bytes: headBytes, header } = encodeWalHeader({
    pageSize,
    salt1: randomSalt(),
    salt2: randomSalt(),
    magic,
  })
  const frameSize = walFrameSize(pageSize)
  const bytes = new Uint8Array(WAL_HEADER_SIZE + frameSize * count)
  bytes.set(headBytes, 0)
  const page = new Uint8Array(pageSize)
  let running = headerChecksum(header)
  for (let i = 0; i < count; i++) {
    crypto.getRandomValues(page.subarray(0, 1024))
    page[0] = i & 0xff
    running = encodeFrame(
      bytes,
      WAL_HEADER_SIZE + i * frameSize,
      { pgno: i + 1, commitSize: i === count - 1 ? count : 0, page },
      header,
      running,
    )
  }
  return { header, bytes }
}

describe("the native WAL checksum", () => {
  test("the capability and the accelerator agree about each other", () => {
    // `features.walsum` is false on a system libsqlite3 and on a vendored build from before
    // `scripts/native/walsum.c` existed — run `bun run sqlite:build`. Everything still works
    // without it; the WAL tail is just 4.5 µs a frame slower.
    expect(NATIVE).toBe(sqlite().features.walsum && process.env.BQL_WAL_NATIVE !== "0")
  })

  test("agrees with checkFrame on every frame of a synthetic WAL, both word orders", () => {
    for (const magic of [WAL_MAGIC_LE, WAL_MAGIC_BE]) {
      for (const pageSize of [512, 4096, 65536]) {
        const count = 6
        const { header, bytes } = wal(count, pageSize, magic)
        const frameSize = walFrameSize(pageSize)
        let js: Checksum = headerChecksum(header)
        let native: Checksum = headerChecksum(header)
        for (let i = 0; i < count; i++) {
          const offset = WAL_HEADER_SIZE + i * frameSize
          const a = checkFrame(bytes, offset, header, js)
          const b = checkFrameFast(bytes, offset, header, native)
          expect(b.valid).toBe(a.valid)
          expect(b.header.pgno).toBe(a.header.pgno)
          expect(b.header.commitSize).toBe(a.header.commitSize)
          expect(b.header.salt1).toBe(a.header.salt1)
          expect(b.header.salt2).toBe(a.header.salt2)
          expect(b.next[0]).toBe(a.next[0])
          expect(b.next[1]).toBe(a.next[1])
          expect(a.valid).toBe(true)
          js = a.next
          native = b.next
        }
      }
    }
  })

  test("rejects exactly what the JavaScript rejects", () => {
    const { header, bytes } = wal(3, 4096, WAL_MAGIC_LE)
    const frameSize = walFrameSize(4096)
    const second = WAL_HEADER_SIZE + frameSize
    const first = checkFrame(bytes, WAL_HEADER_SIZE, header, headerChecksum(header))

    const cases: Array<[string, () => void]> = [
      [
        "a flipped page byte",
        () => {
          bytes[second + 24 + 900] = (bytes[second + 24 + 900] as number) ^ 1
        },
      ],
      [
        "a foreign salt",
        () => {
          bytes[second + 8] = (bytes[second + 8] as number) ^ 0xff
        },
      ],
      ["page number zero", () => { bytes.set([0, 0, 0, 0], second) }],
      [
        "a wrong stored checksum",
        () => {
          bytes[second + 17] = (bytes[second + 17] as number) ^ 0x80
        },
      ],
    ]
    for (const [what, damage] of cases) {
      const copy = bytes.slice()
      damage()
      const a = checkFrame(bytes, second, header, first.next)
      const b = checkFrameFast(bytes, second, header, first.next)
      expect(a.valid).toBe(false)
      expect(`${what}: ${b.valid}`).toBe(`${what}: ${a.valid}`)
      // An invalid frame leaves the chain where it was, in both.
      expect(b.next[0]).toBe(a.next[0])
      expect(b.next[1]).toBe(a.next[1])
      bytes.set(copy)
    }
  })

  test("agrees frame for frame on a WAL SQLite actually wrote", () => {
    const dir = tempDir("bql-native-")
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    db.exec("create table u(id integer primary key, b blob)")
    const insert = db.prepare("insert into t(v) values (?)")
    const big = db.prepare("insert into u(b) values (?)")
    for (let i = 0; i < 120; i++) {
      db.transaction(() => {
        insert.run(`row-${i}`)
        // Every seventh transaction spans several frames, so a non-commit frame is on the path.
        if (i % 7 === 0) big.run(new Uint8Array(9000).fill(i & 0xff))
      })()
    }

    const walPath = `${dbPath}-wal`
    const bytes = new Uint8Array(fs.readFileSync(walPath))
    const header = parseWalHeader(bytes) as WalHeader
    expect(header).not.toBeNull()
    const frameSize = walFrameSize(header.pageSize)
    const frames = Math.floor((bytes.byteLength - WAL_HEADER_SIZE) / frameSize)
    expect(frames).toBeGreaterThan(120)

    let js: Checksum = headerChecksum(header)
    let native: Checksum = headerChecksum(header)
    let commits = 0
    for (let i = 0; i < frames; i++) {
      const offset = WAL_HEADER_SIZE + i * frameSize
      const a = checkFrame(bytes, offset, header, js)
      const b = checkFrameFast(bytes, offset, header, native)
      expect(b.valid).toBe(a.valid)
      expect(b.header.pgno).toBe(a.header.pgno)
      expect(b.header.commitSize).toBe(a.header.commitSize)
      expect(b.next[0]).toBe(a.next[0])
      expect(b.next[1]).toBe(a.next[1])
      if (!a.valid) break
      if (a.header.commitSize !== 0) commits += 1
      js = a.next
      native = b.next
    }
    // 120 inserts plus the two DDL statements.
    expect(commits).toBe(122)
    db.close()
  })

  test.if(NATIVE)("the raw chain agrees for every length and alignment", () => {
    const native = walChecksum()
    expect(native).not.toBeNull()
    const raw = new Uint8Array(8 + 4096 + 16)
    crypto.getRandomValues(raw)
    for (let pad = 0; pad < 8; pad++) {
      const view = raw.subarray(pad)
      for (const length of [8, 24, 512, 4096]) {
        for (const littleEndian of [true, false]) {
          const previous: Checksum = [0x9e3779b1, 0x85ebca77]
          const a = checksum(view, 0, length, previous, littleEndian)
          const b = (native as NonNullable<typeof native>).sum(
            view,
            0,
            length,
            previous,
            littleEndian,
          )
          expect(b[0]).toBe(a[0])
          expect(b[1]).toBe(a[1])
        }
      }
    }
  })

  test.if(NATIVE)("BQL_WAL_NATIVE=0 puts every frame back on the JavaScript", () => {
    const previous = process.env.BQL_WAL_NATIVE
    try {
      process.env.BQL_WAL_NATIVE = "0"
      resetWalChecksum()
      expect(walChecksumIsNative()).toBe(false)
      const { header, bytes } = wal(2, 4096, WAL_MAGIC_LE)
      const a = checkFrame(bytes, WAL_HEADER_SIZE, header, headerChecksum(header))
      const b = checkFrameFast(bytes, WAL_HEADER_SIZE, header, headerChecksum(header))
      expect(b.valid).toBe(a.valid)
      expect(b.next[0]).toBe(a.next[0])
    } finally {
      if (previous === undefined) delete process.env.BQL_WAL_NATIVE
      else process.env.BQL_WAL_NATIVE = previous
      resetWalChecksum()
    }
    expect(walChecksumIsNative()).toBe(true)
  })
})
