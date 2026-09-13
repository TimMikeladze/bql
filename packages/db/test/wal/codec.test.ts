// The codec is checked against WAL bytes SQLite actually wrote, not against a fixture: the point
// of the module is that it agrees with wal.c, and only real bytes can show that.

import fs from "node:fs"
import { afterAll, describe, expect, test } from "bun:test"
import {
  checkFrame,
  checksum,
  databasePageCount,
  databasePageSize,
  encodeFrame,
  encodeWalHeader,
  headerChecksum,
  parseFrameHeader,
  parseWalHeader,
  readWalHeader,
  WAL_FRAME_HEADER_SIZE,
  WAL_HEADER_SIZE,
  WAL_MAGIC_BE,
  WAL_MAGIC_LE,
  WAL_VERSION,
  walFrameCapacity,
  walFrameOffset,
  walFrameSize,
  ZERO_CHECKSUM,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, openPrimary, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

function walBytesFor(rows: number): { bytes: Uint8Array; pageSize: number; pages: number } {
  const dir = tempDir()
  const { db, dbPath } = openPrimary(dir)
  db.exec("create table t(id integer primary key, v text)")
  const insert = db.prepare("insert into t(v) values (?)")
  for (let i = 0; i < rows; i++) {
    db.transaction(() => insert.run(`row-${i}-${"x".repeat(40)}`))()
  }
  const pageSize = Number(db.prepare("pragma page_size").get()?.page_size)
  const pages = Number(db.prepare("pragma page_count").get()?.page_count)
  // Read before closing: the last connection to close checkpoints and unlinks the WAL.
  const bytes = new Uint8Array(fs.readFileSync(`${dbPath}-wal`))
  db.close()
  return { bytes, pageSize, pages }
}

describe("wal header", () => {
  test("parses a header SQLite wrote", () => {
    const { bytes, pageSize } = walBytesFor(4)
    const header = parseWalHeader(bytes)
    expect(header).not.toBeNull()
    if (!header) return
    expect([WAL_MAGIC_LE, WAL_MAGIC_BE]).toContain(header.magic)
    expect(header.version).toBe(WAL_VERSION)
    expect(header.pageSize).toBe(pageSize)
    expect(header.littleEndianChecksum).toBe((header.magic & 1) === 0)
  })

  test("rejects a header whose checksum was tampered with", () => {
    const { bytes } = walBytesFor(2)
    expect(parseWalHeader(bytes)).not.toBeNull()
    const broken = bytes.slice(0, WAL_HEADER_SIZE)
    broken[20] = (broken[20] as number) ^ 0xff // salt2, covered by the header checksum
    expect(readWalHeader(broken)).not.toBeNull()
    expect(parseWalHeader(broken)).toBeNull()
  })

  test("round-trips through encodeWalHeader", () => {
    const { header } = encodeWalHeader({ pageSize: 4096, salt1: 7, salt2: 0xdeadbeef })
    const { bytes } = encodeWalHeader({ pageSize: 4096, salt1: 7, salt2: 0xdeadbeef })
    const parsed = parseWalHeader(bytes)
    expect(parsed).toEqual(header)
    expect(parsed?.salt2).toBe(0xdeadbeef)
  })

  test("checksum of a big-endian WAL uses big-endian words", () => {
    const le = encodeWalHeader({ pageSize: 4096, salt1: 1, salt2: 2, magic: WAL_MAGIC_LE })
    const be = encodeWalHeader({ pageSize: 4096, salt1: 1, salt2: 2, magic: WAL_MAGIC_BE })
    expect(le.header.checksum1).not.toBe(be.header.checksum1)
    expect(parseWalHeader(be.bytes)?.littleEndianChecksum).toBe(false)
  })
})

describe("wal frames", () => {
  test("every frame SQLite wrote verifies, and the chain ends at a commit frame", () => {
    const { bytes, pageSize, pages } = walBytesFor(6)
    const header = parseWalHeader(bytes)
    expect(header).not.toBeNull()
    if (!header) return

    let running = headerChecksum(header)
    let count = 0
    let commits = 0
    let lastCommitSize = 0
    const frameSize = walFrameSize(header.pageSize)
    expect(frameSize).toBe(pageSize + WAL_FRAME_HEADER_SIZE)

    for (let index = 1; ; index++) {
      const offset = walFrameOffset(index, header.pageSize)
      if (offset + frameSize > bytes.byteLength) break
      const check = checkFrame(bytes, offset, header, running)
      expect(check.valid).toBe(true)
      expect(check.header.pgno).toBeGreaterThan(0)
      expect(check.header.salt1).toBe(header.salt1)
      running = check.next
      count += 1
      if (check.header.commitSize !== 0) {
        commits += 1
        lastCommitSize = check.header.commitSize
      }
    }

    expect(count).toBe(walFrameCapacity(bytes.byteLength, header.pageSize))
    // Six inserts plus the CREATE TABLE, each its own transaction and so its own commit frame.
    expect(commits).toBe(7)
    expect(lastCommitSize).toBe(pages)
  })

  test("a flipped byte in the page breaks the frame", () => {
    const { bytes } = walBytesFor(2)
    const header = parseWalHeader(bytes)
    if (!header) throw new Error("no header")
    const offset = walFrameOffset(1, header.pageSize)
    expect(checkFrame(bytes, offset, header, headerChecksum(header)).valid).toBe(true)
    const corrupt = bytes.slice()
    const at = offset + WAL_FRAME_HEADER_SIZE + 17
    corrupt[at] = (corrupt[at] as number) ^ 0x01
    expect(checkFrame(corrupt, offset, header, headerChecksum(header)).valid).toBe(false)
  })

  test("a frame from another WAL generation is rejected on its salts", () => {
    const { bytes } = walBytesFor(2)
    const header = parseWalHeader(bytes)
    if (!header) throw new Error("no header")
    const other = { ...header, salt1: header.salt1 + 1 }
    const offset = walFrameOffset(1, header.pageSize)
    expect(checkFrame(bytes, offset, other, headerChecksum(header)).valid).toBe(false)
  })

  test("encodeFrame produces frames checkFrame accepts", () => {
    const pageSize = 512
    const { header } = encodeWalHeader({ pageSize, salt1: 11, salt2: 22 })
    const out = new Uint8Array(walFrameSize(pageSize) * 2)
    const page = new Uint8Array(pageSize).fill(0xab)
    let running = headerChecksum(header)
    running = encodeFrame(out, 0, { pgno: 3, commitSize: 0, page }, header, running)
    running = encodeFrame(
      out,
      walFrameSize(pageSize),
      { pgno: 1, commitSize: 5, page },
      header,
      running,
    )

    let verify = headerChecksum(header)
    const first = checkFrame(out, 0, header, verify)
    expect(first.valid).toBe(true)
    expect(first.header.pgno).toBe(3)
    expect(first.header.commitSize).toBe(0)
    verify = first.next
    const second = checkFrame(out, walFrameSize(pageSize), header, verify)
    expect(second.valid).toBe(true)
    expect(second.header.commitSize).toBe(5)
    expect(second.next).toEqual(running)
    expect(parseFrameHeader(out, walFrameSize(pageSize)).salt2).toBe(22)
  })
})

describe("offsets and helpers", () => {
  test("frames are 1-based and packed", () => {
    expect(walFrameOffset(1, 4096)).toBe(WAL_HEADER_SIZE)
    expect(walFrameOffset(2, 4096)).toBe(WAL_HEADER_SIZE + 4096 + WAL_FRAME_HEADER_SIZE)
    expect(walFrameCapacity(WAL_HEADER_SIZE + 3 * walFrameSize(4096) + 7, 4096)).toBe(3)
    expect(walFrameCapacity(10, 4096)).toBe(0)
  })

  test("the checksum chain is order dependent", () => {
    const a = new Uint8Array(16)
    a[0] = 1
    const b = new Uint8Array(16)
    b[8] = 1
    expect(checksum(a, 0, 16, ZERO_CHECKSUM, true)).not.toEqual(
      checksum(b, 0, 16, ZERO_CHECKSUM, true),
    )
  })

  test("reads page size and count out of a database header", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(a)")
    db.walCheckpoint("TRUNCATE")
    const pageSize = Number(db.prepare("pragma page_size").get()?.page_size)
    const pages = Number(db.prepare("pragma page_count").get()?.page_count)
    const head = new Uint8Array(fs.readFileSync(dbPath).subarray(0, 100))
    db.close()

    expect(databasePageSize(head)).toBe(pageSize)
    expect(databasePageCount(head)).toBe(pages)
    expect(databasePageSize(new Uint8Array(100))).toBeNull()
  })
})
