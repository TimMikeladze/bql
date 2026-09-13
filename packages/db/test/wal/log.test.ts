// The segment log: rotation, the dense-txid index, reopening after a crash, and retention.

import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import {
  LogGap,
  RECORD_HEADER_SIZE,
  TxnLog,
  type TxnRecordInput,
  WalFormatError,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

const PAGE_SIZE = 1024

function recordAt(txid: bigint, pages = 2, fill = Number(txid & 0xffn)): TxnRecordInput {
  const map = new Map<number, Uint8Array>()
  for (let i = 1; i <= pages; i++) {
    const page = new Uint8Array(PAGE_SIZE)
    page.fill((fill + i) & 0xff)
    // A little incompressible noise so segments actually grow.
    for (let j = 0; j < PAGE_SIZE; j += 3) page[j] = (j * 7 + fill * 13 + i) & 0xff
    map.set(i, page)
  }
  return {
    pageSize: PAGE_SIZE,
    txid,
    prevTxid: txid - 1n,
    epoch: 1,
    timestampUs: BigInt(Date.now()) * 1000n,
    commitSizePages: pages,
    frameCount: pages,
    walSalt1: 1,
    walSalt2: 2,
    walEndFrame: Number(txid),
    preChecksum: 0n,
    postChecksum: txid,
    pages: map,
  }
}

function fill(log: TxnLog, from: number, to: number): void {
  for (let i = from; i <= to; i++) log.append(recordAt(BigInt(i)))
}

describe("appending", () => {
  test("tracks the txid range and refuses a gap", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, fsync: "never" })
    expect(log.lastTxid).toBe(0n)
    expect(log.firstTxid).toBeNull()

    fill(log, 1, 5)
    expect(log.lastTxid).toBe(5n)
    expect(log.firstTxid).toBe(1n)
    expect(() => log.append(recordAt(9n))).toThrow(WalFormatError)
    expect(() => log.append(recordAt(5n))).toThrow(WalFormatError)
    log.close()
  })

  test("reads any record back by txid", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, fsync: "never" })
    fill(log, 1, 20)
    const record = log.read(7n)
    expect(record?.txid).toBe(7n)
    expect(record?.postChecksum).toBe(7n)
    expect(record?.pages.size).toBe(2)
    expect(log.read(21n)).toBeNull()
    log.close()
  })

  test("rotates at the segment size and names segments by their first txid", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 8 * 1024, fsync: "never" })
    fill(log, 1, 40)
    expect(log.segmentCount).toBeGreaterThan(3)

    // Sealed segments carry a sidecar index beside them, so filter to the segments themselves.
    const names = fs
      .readdirSync(path.join(dir, "log"))
      .filter((name) => name.endsWith(".seg"))
      .sort()
    expect(names[0]).toBe("00000000000000000001.seg")
    expect(names.length).toBe(log.segmentCount)
    expect(log.lastTxid).toBe(40n)
    log.close()
  })
})

describe("iterating", () => {
  test("yields exactly the requested tail, across segments", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 8 * 1024, fsync: "never" })
    fill(log, 1, 40)

    expect([...log.iterate(1n)].map((r) => r.txid)).toEqual(
      Array.from({ length: 40 }, (_, i) => BigInt(i + 1)),
    )
    expect([...log.iterate(33n)].map((r) => r.txid)).toEqual(
      Array.from({ length: 8 }, (_, i) => BigInt(i + 33)),
    )
    expect([...log.iterate(41n)]).toEqual([])
    log.close()
  })

  test("a txid that has been retained away is a LogGap, not an empty result", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4 * 1024, fsync: "never" })
    fill(log, 1, 40)
    log.retain({ maxBytes: 1, keepAfterTxid: 35n })
    const first = log.firstTxid
    expect(first).not.toBeNull()
    expect(first).toBeGreaterThan(1n)
    expect(() => [...log.iterate(1n)]).toThrow(LogGap)
    log.close()
  })
})

describe("reopening", () => {
  test("rebuilds the index from the segment files", () => {
    const dir = tempDir()
    const first = TxnLog.open({ dir, segmentBytes: 8 * 1024, fsync: "each" })
    fill(first, 1, 30)
    first.close()

    const second = TxnLog.open({ dir, segmentBytes: 8 * 1024, fsync: "never" })
    expect(second.lastTxid).toBe(30n)
    expect(second.firstTxid).toBe(1n)
    expect(second.repaired).toEqual([])
    expect([...second.iterate(28n)].map((r) => r.txid)).toEqual([28n, 29n, 30n])

    second.append(recordAt(31n))
    expect(second.lastTxid).toBe(31n)
    expect(second.read(31n)?.txid).toBe(31n)
    second.close()
  })

  test("truncates a record that was half written when the process died", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, fsync: "each" })
    fill(log, 1, 10)
    const bytes = log.bytes
    log.close()

    const segment = path.join(dir, "log", "00000000000000000001.seg")
    // Half of an eleventh record made it to disk.
    fs.appendFileSync(segment, Buffer.alloc(RECORD_HEADER_SIZE + 40, 0x7f))

    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(reopened.lastTxid).toBe(10n)
    expect(reopened.bytes).toBe(bytes)
    expect(reopened.repaired).toEqual([segment])
    expect(fs.statSync(segment).size).toBe(bytes)
    // The log is usable again: the next append lands where the torn record was.
    reopened.append(recordAt(11n))
    expect(reopened.read(11n)?.txid).toBe(11n)
    reopened.close()
  })
})

describe("retention", () => {
  test("keeps everything at or after keepAfterTxid", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4 * 1024, fsync: "never" })
    fill(log, 1, 60)
    const before = log.segmentCount

    const result = log.retain({ maxBytes: 1, keepAfterTxid: 50n })
    expect(result.removed.length).toBeGreaterThan(0)
    expect(log.segmentCount).toBeLessThan(before)
    expect(log.bytes).toBeLessThan(result.bytesFreed + log.bytes)
    expect(log.lastTxid).toBe(60n)
    expect([...log.iterate(50n)].map((r) => r.txid)).toEqual(
      Array.from({ length: 11 }, (_, i) => BigInt(i + 50)),
    )
    for (const removed of result.removed) expect(fs.existsSync(removed)).toBe(false)
    log.close()
  })

  test("age-based retention leaves fresh segments alone", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4 * 1024, fsync: "never" })
    fill(log, 1, 40)
    expect(log.retain({ maxAgeMs: 60_000 }).removed).toEqual([])
    expect(log.retain({ maxAgeMs: 0 }).removed.length).toBeGreaterThan(0)
    // The newest segment is never dropped, whatever the policy says.
    expect(log.segmentCount).toBeGreaterThanOrEqual(1)
    expect(log.lastTxid).toBe(40n)
    log.close()
  })

  test("a size budget drops the oldest segments first", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4 * 1024, fsync: "never" })
    fill(log, 1, 60)
    const budget = Math.floor(log.bytes / 2)
    log.retain({ maxBytes: budget })
    expect(log.bytes).toBeLessThanOrEqual(budget + 4 * 1024)
    expect(log.lastTxid).toBe(60n)
    log.close()
  })
})

describe("fsync policy", () => {
  test("each and never both produce a readable log", () => {
    for (const policy of ["each", "never", "interval"] as const) {
      const dir = tempDir()
      const log = TxnLog.open({ dir, fsync: policy, fsyncIntervalMs: 0 })
      fill(log, 1, 5)
      log.flush()
      log.close()
      const reopened = TxnLog.open({ dir, fsync: "never" })
      expect(reopened.lastTxid).toBe(5n)
      reopened.close()
    }
  })
})
