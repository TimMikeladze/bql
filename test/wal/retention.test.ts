// The retention floor and the snapshot prune rule, which are the two pieces of `docs/r6-retention.md`
// that have to be right. Both are pure, so the cases are stated here without a cluster or a bucket;
// what the tenant and the server do with them is `test/tenant/retention.test.ts` and
// `test/server/retention.test.ts`.

import { afterAll, describe, expect, test } from "bun:test"
import {
  logRetentionFloor,
  planSnapshotPrune,
  type SnapshotRef,
  TxnLog,
  type TxnRecordInput,
} from "../../src/wal/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

const PAGE_SIZE = 1024

function recordAt(txid: bigint, ageMs = 0): TxnRecordInput {
  const map = new Map<number, Uint8Array>()
  const page = new Uint8Array(PAGE_SIZE)
  for (let j = 0; j < PAGE_SIZE; j += 3) page[j] = (j * 7 + Number(txid & 0xffn)) & 0xff
  map.set(1, page)
  return {
    pageSize: PAGE_SIZE,
    txid,
    prevTxid: txid - 1n,
    epoch: 1,
    timestampUs: BigInt(Date.now() - ageMs) * 1000n,
    commitSizePages: 1,
    frameCount: 1,
    walSalt1: 1,
    walSalt2: 2,
    walEndFrame: Number(txid),
    preChecksum: 0n,
    postChecksum: txid,
    pages: map,
  }
}

/** A log of `count` one-record segments, every record stamped `ageMs` in the past. */
function agedLog(count: number, ageMs: number): TxnLog {
  const log = TxnLog.open({ dir: tempDir("bunql-retain-"), fsync: "never", segmentBytes: 1 })
  for (let i = 1; i <= count; i++) log.append(recordAt(BigInt(i), ageMs))
  return log
}

function snapshotRef(txid: number, createdAtMs: number): SnapshotRef {
  return {
    path: `/snapshots/${txid}.db`,
    txid: String(txid),
    epoch: 1,
    bytes: 4096,
    pageSize: PAGE_SIZE,
    pages: 1,
    checksum: "0",
    createdAtMs,
  }
}

describe("the retention floor", () => {
  test("is the minimum over the consumers that are present", () => {
    expect(
      logRetentionFloor({ oldestSnapshotTxid: 40n, slowestReplicaTxid: 12n, shippedTxid: 90n }),
    ).toBe(12n)
    expect(
      logRetentionFloor({ oldestSnapshotTxid: 40n, slowestReplicaTxid: 90n, shippedTxid: 12n }),
    ).toBe(12n)
    expect(
      logRetentionFloor({ oldestSnapshotTxid: 12n, slowestReplicaTxid: 40n, shippedTxid: 90n }),
    ).toBe(12n)
  })

  test("ignores a consumer that is absent, and imposes nothing when all three are", () => {
    // No replica attached and no bucket: only the oldest snapshot holds the log.
    expect(logRetentionFloor({ oldestSnapshotTxid: 40n })).toBe(40n)
    // Nothing has ever been snapshotted, but a replica is following.
    expect(
      logRetentionFloor({ oldestSnapshotTxid: null, slowestReplicaTxid: 7n, shippedTxid: null }),
    ).toBe(7n)
    // A node with no snapshot, no replica and no bucket is held by its age bound alone.
    expect(logRetentionFloor({})).toBeUndefined()
    expect(
      logRetentionFloor({ oldestSnapshotTxid: null, slowestReplicaTxid: null, shippedTxid: null }),
    ).toBeUndefined()
  })

  test("counts txid 0 as a real floor, not as an absent consumer", () => {
    // A shipper that has put nothing in the bucket yet is exactly the case that must not be
    // mistaken for "no bucket configured": everything in the log is still owed.
    expect(logRetentionFloor({ oldestSnapshotTxid: 50n, shippedTxid: 0n })).toBe(0n)
  })
})

describe("the log under a floor", () => {
  test("an old segment at or above the floor survives; below it, it goes", () => {
    const log = agedLog(6, 3600_000)
    expect(log.segmentCount).toBe(6)

    // Everything is an hour old and the retention is a minute, so age alone would take all but
    // the open segment. The floor is what actually decides.
    const held = log.retain({ maxAgeMs: 60_000, keepAfterTxid: 3n })
    expect(held.removed.length).toBe(2)
    expect(log.firstTxid).toBe(3n)

    // The floor moves up; the segments below it are now free to go.
    log.retain({ maxAgeMs: 60_000, keepAfterTxid: 5n })
    expect(log.firstTxid).toBe(5n)
    log.close()
  })

  test("a segment younger than the retention is kept whatever the floor says", () => {
    const log = agedLog(4, 0)
    expect(log.retain({ maxAgeMs: 3600_000, keepAfterTxid: 4n }).removed).toEqual([])
    expect(log.firstTxid).toBe(1n)
    log.close()
  })

  test("maxLogBytes never drops below the floor", () => {
    const log = agedLog(8, 3600_000)
    const bytes = log.bytes
    // A size cap of one byte: without a floor this takes everything but the open segment.
    const capped = log.retain({ maxBytes: 1, keepAfterTxid: 4n })
    expect(capped.removed.length).toBe(3)
    expect(log.firstTxid).toBe(4n)
    expect(log.bytes).toBeLessThan(bytes)

    // Still over the cap, and the floor is still what stops it. A full disk is recoverable; a
    // record a replica was about to read is not.
    expect(log.retain({ maxBytes: 1, keepAfterTxid: 4n }).removed).toEqual([])
    expect(log.firstTxid).toBe(4n)
    log.close()
  })
})

describe("pruning snapshots", () => {
  const now = 1_700_000_000_000
  const day = 86_400_000
  const cutoff = now - 7 * day

  test("keeps everything newer than the cutoff plus the newest base at or before it", () => {
    const refs = [
      snapshotRef(10, now - 30 * day),
      snapshotRef(20, now - 20 * day),
      snapshotRef(30, now - 9 * day),
      snapshotRef(40, now - 6 * day),
      snapshotRef(50, now - 1 * day),
    ]
    const plan = planSnapshotPrune(refs, cutoff)
    // 30 is the base a restore to exactly seven days ago replays from, so it stays; 10 and 20 are
    // older bases that nothing inside the window needs.
    expect(plan.keep.map((s) => s.txid)).toEqual(["30", "40", "50"])
    expect(plan.remove.map((s) => s.txid)).toEqual(["10", "20"])
  })

  test("keeps the newest snapshot unconditionally", () => {
    // A database nobody has written to in a month still has to be restorable.
    const refs = [snapshotRef(10, now - 60 * day), snapshotRef(20, now - 40 * day)]
    const plan = planSnapshotPrune(refs, cutoff)
    expect(plan.keep.map((s) => s.txid)).toEqual(["20"])
    expect(plan.remove.map((s) => s.txid)).toEqual(["10"])

    const only = planSnapshotPrune([snapshotRef(10, now - 60 * day)], cutoff)
    expect(only.keep.map((s) => s.txid)).toEqual(["10"])
    expect(only.remove).toEqual([])
  })

  test("removes nothing when every snapshot is inside the window", () => {
    const refs = [snapshotRef(10, now - 6 * day), snapshotRef(20, now - 1 * day)]
    const plan = planSnapshotPrune(refs, cutoff)
    expect(plan.remove).toEqual([])
    expect(plan.keep.length).toBe(2)
  })

  test("the surviving oldest snapshot is what the log floor follows", () => {
    const refs = [
      snapshotRef(10, now - 30 * day),
      snapshotRef(30, now - 9 * day),
      snapshotRef(50, now - 1 * day),
    ]
    const kept = planSnapshotPrune(refs, cutoff).keep
    const floor = logRetentionFloor({ oldestSnapshotTxid: BigInt((kept[0] as SnapshotRef).txid) })
    expect(floor).toBe(30n)
  })
})
