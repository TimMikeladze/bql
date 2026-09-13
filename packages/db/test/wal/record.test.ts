// Records and the rolling database checksum. The checksum tests matter most: it is the thing a
// replica uses to prove it holds what the primary holds, so "computed incrementally" and
// "computed from the files" have to agree after every kind of transaction, shrinking included.

import { afterAll, describe, expect, test } from "bun:test"
import {
  computeFull,
  decode,
  decodeHeader,
  encode,
  FLAG_SNAPSHOT_BOUNDARY,
  FLAG_ZSTD,
  foldTransaction,
  LivePageSource,
  pageHash,
  RECORD_HEADER_SIZE,
  RollingChecksum,
  TxnRecorder,
  type TxnRecordInput,
  WalFormatError,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, openPrimary, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

function samplePages(count: number, pageSize: number): Map<number, Uint8Array> {
  const pages = new Map<number, Uint8Array>()
  for (let i = 0; i < count; i++) {
    const page = new Uint8Array(pageSize)
    // Compressible, like a real database page, but not uniform.
    page.fill(i + 1, 0, pageSize / 2)
    for (let j = pageSize / 2; j < pageSize; j += 7) page[j] = (i * 31 + j) & 0xff
    pages.set(count - i, page)
  }
  return pages
}

function sampleRecord(overrides: Partial<TxnRecordInput> = {}): TxnRecordInput {
  return {
    pageSize: 4096,
    txid: 42n,
    prevTxid: 41n,
    epoch: 3,
    timestampUs: 1_757_000_000_000_000n,
    commitSizePages: 9,
    frameCount: 5,
    walSalt1: 0xdeadbeef,
    walSalt2: 0x0badf00d,
    walEndFrame: 17,
    preChecksum: 0x1122334455667788n,
    postChecksum: 0x99aabbccddeeff00n,
    pages: samplePages(4, 4096),
    ...overrides,
  }
}

describe("transaction records", () => {
  test("round-trips every field and every page", () => {
    const input = sampleRecord()
    const bytes = encode(input)
    const { record, byteLength } = decode(bytes)

    expect(byteLength).toBe(bytes.byteLength)
    expect(record.txid).toBe(input.txid)
    expect(record.prevTxid).toBe(input.prevTxid)
    expect(record.epoch).toBe(input.epoch)
    expect(record.timestampUs).toBe(input.timestampUs)
    expect(record.commitSizePages).toBe(input.commitSizePages)
    expect(record.frameCount).toBe(input.frameCount)
    expect(record.walSalt1).toBe(input.walSalt1)
    expect(record.walSalt2).toBe(input.walSalt2)
    expect(record.walEndFrame).toBe(input.walEndFrame)
    expect(record.preChecksum).toBe(input.preChecksum)
    expect(record.postChecksum).toBe(input.postChecksum)
    expect(record.pageSize).toBe(4096)
    expect(record.flags & FLAG_ZSTD).toBe(FLAG_ZSTD)

    expect([...record.pages.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    for (const [pgno, page] of input.pages) {
      expect(record.pages.get(pgno)).toEqual(page)
    }
  })

  test("pages are compressed", () => {
    const input = sampleRecord()
    const bytes = encode(input)
    const plain = input.pages.size * (4 + input.pageSize)
    expect(bytes.byteLength).toBeLessThan(plain / 2)
  })

  test("flags survive and combine with zstd", () => {
    const bytes = encode(sampleRecord({ flags: FLAG_SNAPSHOT_BOUNDARY }))
    const { record } = decode(bytes)
    expect(record.flags & FLAG_SNAPSHOT_BOUNDARY).toBe(FLAG_SNAPSHOT_BOUNDARY)
    expect(record.flags & FLAG_ZSTD).toBe(FLAG_ZSTD)
  })

  test("decodeHeader reads the frame length without the body", () => {
    const bytes = encode(sampleRecord())
    const head = decodeHeader(bytes.subarray(0, RECORD_HEADER_SIZE))
    expect(head).not.toBeNull()
    expect(head?.byteLength).toBe(bytes.byteLength)
    expect(head?.header.txid).toBe(42n)
    expect(decodeHeader(bytes.subarray(0, RECORD_HEADER_SIZE - 1))).toBeNull()
  })

  test("a torn record is refused", () => {
    const bytes = encode(sampleRecord())
    expect(() => decode(bytes.subarray(0, bytes.byteLength - 3))).toThrow(WalFormatError)
  })

  test("a flipped header byte is caught by the header hash", () => {
    const bytes = encode(sampleRecord())
    bytes[10] = (bytes[10] as number) ^ 0xff
    expect(() => decodeHeader(bytes)).toThrow(/header hash mismatch/)
  })

  test("a flipped body byte is caught by the body hash", () => {
    const bytes = encode(sampleRecord({ flags: 0 }))
    // Compression means most single-byte flips fail to inflate at all; both outcomes are a throw.
    bytes[RECORD_HEADER_SIZE + 5] = (bytes[RECORD_HEADER_SIZE + 5] as number) ^ 0x55
    expect(() => decode(bytes)).toThrow()
  })

  test("records sit back to back", () => {
    const a = encode(sampleRecord({ txid: 1n, prevTxid: 0n }))
    const b = encode(sampleRecord({ txid: 2n, prevTxid: 1n, pages: samplePages(2, 4096) }))
    const joined = new Uint8Array(a.byteLength + b.byteLength)
    joined.set(a, 0)
    joined.set(b, a.byteLength)

    const first = decode(joined, 0)
    expect(first.record.txid).toBe(1n)
    const second = decode(joined, first.byteLength)
    expect(second.record.txid).toBe(2n)
    expect(first.byteLength + second.byteLength).toBe(joined.byteLength)
  })
})

describe("rolling checksum", () => {
  test("applying a page twice is its own inverse", () => {
    const page = new Uint8Array(4096).fill(7)
    const other = new Uint8Array(4096).fill(9)
    const rolling = new RollingChecksum()
    rolling.apply(1, null, page)
    const afterFirst = rolling.value
    rolling.apply(1, page, other)
    expect(rolling.value).not.toBe(afterFirst)
    rolling.apply(1, other, page)
    expect(rolling.value).toBe(afterFirst)
  })

  test("page number is part of the hash", () => {
    const page = new Uint8Array(512).fill(3)
    expect(pageHash(1, page)).not.toBe(pageHash(2, page))
  })

  test("computeFull matches an incremental fold over a real workload", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(id integer primary key, v text)")
    db.walCheckpoint("TRUNCATE")

    const recorder = TxnRecorder.open({ dbPath })
    const insert = db.prepare("insert into t(v) values (?)")
    for (let round = 0; round < 12; round++) {
      db.transaction(() => {
        for (let i = 0; i < 20; i++) insert.run(`v-${round}-${i}-${"y".repeat(60)}`)
      })()
      recorder.poll()
    }

    const incremental = recorder.position.checksum
    expect(computeFull(dbPath).checksum).toBe(incremental)

    db.walCheckpoint("TRUNCATE")
    expect(computeFull(dbPath, { includeWal: false }).checksum).toBe(incremental)

    recorder.close()
    db.close()
  })

  test("a shrinking transaction drops the pages it truncated away", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table big(id integer primary key, v text)")
    db.exec("create table keep(id integer primary key)")
    const insert = db.prepare("insert into big(v) values (?)")
    db.transaction(() => {
      for (let i = 0; i < 400; i++) insert.run("z".repeat(300))
    })()
    db.walCheckpoint("TRUNCATE")

    const recorder = TxnRecorder.open({ dbPath })
    const before = Number(db.prepare("pragma page_count").get()?.page_count)

    db.exec("delete from big")
    recorder.poll()
    db.exec("vacuum")
    recorder.poll()

    const after = Number(db.prepare("pragma page_count").get()?.page_count)
    expect(after).toBeLessThan(before)
    expect(recorder.position.dbSizePages).toBe(after)
    expect(computeFull(dbPath).checksum).toBe(recorder.position.checksum)

    recorder.close()
    db.close()
  })

  test("foldTransaction leaves nothing behind until commit", () => {
    const dir = tempDir()
    const { db, dbPath } = openPrimary(dir)
    db.exec("create table t(a)")
    db.walCheckpoint("TRUNCATE")
    const full = computeFull(dbPath, { includeWal: false })

    const source = new LivePageSource(dbPath, full.pageSize, full.pages)
    const rolling = new RollingChecksum(full.checksum)
    const page = new Uint8Array(full.pageSize).fill(0x5a)
    const fold = foldTransaction(rolling, source, {
      pages: new Map([[2, page]]),
      commitSizePages: full.pages,
    })
    expect(rolling.value).toBe(full.checksum)
    expect(source.overlaySize).toBe(0)

    fold.commit()
    expect(rolling.value).toBe(fold.checksum)
    expect(rolling.value).not.toBe(full.checksum)
    expect(source.hash(2)).toBe(pageHash(2, page))

    source.close()
    db.close()
  })
})
