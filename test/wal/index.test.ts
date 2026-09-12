// The sidecar segment index of `docs/r3-storage.md` §5. The claim under test is narrow and the
// whole point of the feature: the index makes a cold open cheap, and it is never a second source
// of truth — absent, stale, truncated or corrupt, the log reopens with exactly the same records.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { encode, type TxnRecordInput } from "../../src/wal/record.ts"
import { segmentIndexPath, TxnLog } from "../../src/wal/log.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterEach(() => cleanupTempDirs())

const PAGE_SIZE = 256

function record(txid: number, pages = 1): TxnRecordInput {
  const map = new Map<number, Uint8Array>()
  for (let i = 1; i <= pages; i++) {
    const page = new Uint8Array(PAGE_SIZE)
    page.fill((txid + i) % 251)
    map.set(i, page)
  }
  return {
    pageSize: PAGE_SIZE,
    txid: BigInt(txid),
    prevTxid: BigInt(txid - 1),
    epoch: 1,
    frameCount: pages,
    timestampUs: BigInt(1_700_000_000_000_000 + txid * 1000),
    commitSizePages: pages,
    walSalt1: 1,
    walSalt2: 2,
    walEndFrame: txid,
    preChecksum: BigInt(txid - 1),
    postChecksum: BigInt(txid),
    pages: map,
  }
}

function fill(log: TxnLog, count: number, from = 1): void {
  for (let txid = from; txid < from + count; txid++) log.append(record(txid))
}

/** Every record's `(txid, postChecksum)`, which is what "the log reopened the same" means. */
function positions(log: TxnLog): string[] {
  return [...log.iterate(1n)].map((one) => `${one.txid}:${one.postChecksum}`)
}

function indexPaths(dir: string): string[] {
  const logDir = path.join(dir, "log")
  return fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith(".idx"))
    .map((name) => path.join(logDir, name))
    .sort()
}

describe("the segment index", () => {
  test("is written beside every segment and is read back on open", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4096, fsync: "never", indexIntervalMs: 0 })
    fill(log, 60)
    const expected = positions(log)
    log.close()

    expect(indexPaths(dir).length).toBe(log.segmentCount)

    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(reopened.rescanned).toEqual([])
    expect(reopened.lastTxid).toBe(60n)
    expect(positions(reopened)).toEqual(expected)
    reopened.close()
  })

  test("an absent index costs a scan and nothing else", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4096, fsync: "never" })
    fill(log, 40)
    const expected = positions(log)
    log.close()

    for (const file of indexPaths(dir)) fs.rmSync(file)
    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(reopened.rescanned.length).toBe(reopened.segmentCount)
    expect(reopened.lastTxid).toBe(40n)
    expect(positions(reopened)).toEqual(expected)
    reopened.close()
  })

  test("a corrupt index is rejected and the log reopens identically", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4096, fsync: "never" })
    fill(log, 40)
    const expected = positions(log)
    log.close()

    // Three ways an index can be wrong: a broken magic, a broken hash, and a plausible body that
    // was never written by this code at all.
    const files = indexPaths(dir)
    const first = files[0] as string
    const bytes = new Uint8Array(fs.readFileSync(first))
    for (const damage of [
      () => {
        const copy = bytes.slice()
        copy[0] = 0
        return copy
      },
      () => {
        const copy = bytes.slice()
        // The trailing hash is the last eight bytes.
        copy[copy.byteLength - 1] = (copy[copy.byteLength - 1] as number) ^ 0xff
        return copy
      },
      () => new Uint8Array(96),
    ]) {
      fs.writeFileSync(first, damage())
      const reopened = TxnLog.open({ dir, fsync: "never" })
      expect(reopened.rescanned).toContain(first.replace(/\.idx$/, ".seg"))
      expect(positions(reopened)).toEqual(expected)
      expect(reopened.lastTxid).toBe(40n)
      reopened.close()
    }
  })

  test("a stale index shortens the scan rather than truncating the log", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, fsync: "never", indexIntervalMs: 0 })
    fill(log, 20)
    log.flush()
    // The index now describes twenty records; twenty more are appended without another flush,
    // which is exactly what a crash leaves behind.
    const staleIndex = new Uint8Array(fs.readFileSync(indexPaths(dir)[0] as string))
    fill(log, 20, 21)
    const expected = positions(log)
    log.close()
    fs.writeFileSync(indexPaths(dir)[0] as string, staleIndex)

    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(reopened.rescanned).toEqual([])
    expect(reopened.lastTxid).toBe(40n)
    expect(positions(reopened)).toEqual(expected)
    reopened.close()
  })

  test("an index claiming more than the segment holds is rejected outright", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, fsync: "never" })
    fill(log, 30)
    const expected = positions(log)
    log.close()

    const segment = log.segmentPaths[0] as string
    const size = fs.statSync(segment).size
    // The segment is cut back under a surviving index: the index now describes bytes that are
    // gone, which is the one case a resumed scan must not be trusted for.
    const head = new Uint8Array(fs.readFileSync(segment)).subarray(0, Math.floor(size / 2))
    fs.writeFileSync(segment, head)

    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(reopened.rescanned).toContain(segment)
    expect(reopened.lastTxid).toBeLessThan(30n)
    expect(reopened.lastTxid).toBeGreaterThan(0n)
    // Whatever survived is still a clean prefix of what was there.
    expect(expected.slice(0, positions(reopened).length)).toEqual(positions(reopened))
    reopened.close()
  })

  test("a torn record after the indexed prefix is still truncated away", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, fsync: "never", indexIntervalMs: 0 })
    fill(log, 10)
    log.flush()
    fill(log, 5, 11)
    log.close()

    const segment = log.segmentPaths[0] as string
    const whole = new Uint8Array(fs.readFileSync(segment))
    // Half of record 15 is on disk. The index covers ten, so the scan resumes into the tear.
    fs.writeFileSync(segment, whole.subarray(0, whole.byteLength - 40))

    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(reopened.repaired).toContain(segment)
    expect(reopened.lastTxid).toBe(14n)
    reopened.close()
  })

  test("retention removes a dropped segment's index with it", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 2048, fsync: "never", indexIntervalMs: 0 })
    fill(log, 60)
    log.saveIndexes()
    expect(log.segmentCount).toBeGreaterThan(2)

    const removed = log.retain({ maxAgeMs: 0, keepAfterTxid: log.lastTxid })
    expect(removed.removed.length).toBeGreaterThan(0)
    for (const segment of removed.removed) {
      expect(fs.existsSync(segment)).toBe(false)
      expect(fs.existsSync(segmentIndexPath(segment))).toBe(false)
    }
    log.close()

    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(reopened.rescanned).toEqual([])
    expect(reopened.segmentCount).toBe(log.segmentCount)
    reopened.close()
  })

  test("`index: false` writes none, and the log still reopens by scanning", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, fsync: "never", index: false })
    fill(log, 20)
    const expected = positions(log)
    log.close()
    expect(indexPaths(dir)).toEqual([])

    const reopened = TxnLog.open({ dir, fsync: "never" })
    expect(positions(reopened)).toEqual(expected)
    reopened.close()
  })

  test("`iterateEncoded` yields the same records as `iterate`, still encoded", () => {
    const dir = tempDir()
    const log = TxnLog.open({ dir, segmentBytes: 4096, fsync: "never" })
    fill(log, 30)

    const decoded = [...log.iterate(5n)]
    const encoded = [...log.iterateEncoded(5n)]
    expect(encoded.map((one) => one.txid)).toEqual(decoded.map((one) => one.txid))
    // The bytes are exactly what `encode` produces, which is what makes a segment object a
    // concatenation rather than a re-encoding.
    expect(encoded[0]?.bytes).toEqual(encode(record(5)))
    expect(encoded.at(-1)?.txid).toBe(30n)
    log.close()
  })

  test("opening a long log with an index is much faster than scanning it", () => {
    const dir = tempDir()
    const log = TxnLog.open({
      dir,
      segmentBytes: 1024 * 1024 * 1024,
      fsync: "never",
      indexIntervalMs: 0,
    })
    fill(log, 6000)
    log.close()

    const withIndexNs = measure(() => TxnLog.open({ dir, fsync: "never" }))
    for (const file of indexPaths(dir)) fs.rmSync(file)
    const scanningNs = measure(() => TxnLog.open({ dir, fsync: "never", index: false }))

    console.log(
      `cold open of a 6000-record log: ${(scanningNs / 1e6).toFixed(2)} ms scanning, ` +
        `${(withIndexNs / 1e6).toFixed(2)} ms from the index`,
    )
    expect(withIndexNs).toBeLessThan(scanningNs)
  })
})

function measure(open: () => TxnLog): number {
  const started = Bun.nanoseconds()
  const log = open()
  const elapsed = Bun.nanoseconds() - started
  expect(log.lastTxid).toBe(6000n)
  log.close()
  return elapsed
}
