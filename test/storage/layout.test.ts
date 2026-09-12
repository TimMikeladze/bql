// The layout contract of `docs/r3-storage.md` §1, pinned. A restore written against these keys
// and this manifest shape must keep working, so every rule the doc states is a test here.

import { describe, expect, test } from "bun:test"
import {
  decodeManifest,
  emptyManifest,
  encodeManifest,
  latestTxid,
  type Manifest,
  manifestKey,
  newGenerationId,
  normalizeManifest,
  parseSegmentKey,
  parseSnapshotKey,
  planRestore,
  RestorePlanError,
  type SegmentEntry,
  segmentKey,
  type SnapshotEntry,
  snapshotKey,
} from "../../src/storage/index.ts"

const GEN = "aaaaaaaaaaaaaaaa"

function snapshot(txid: bigint, at = 1000): SnapshotEntry {
  return {
    key: snapshotKey("bunql/", "acme", txid),
    generation: GEN,
    txid: txid.toString(),
    epoch: 0,
    pages: 4,
    pageSize: 4096,
    checksum: "1234",
    bytes: 100,
    plainBytes: 400,
    hash: "99",
    createdAtMs: at,
  }
}

function segment(start: bigint, end: bigint, at = 1000, generation = GEN): SegmentEntry {
  return {
    key: segmentKey("bunql/", "acme", start, end),
    generation,
    startTxid: start.toString(),
    endTxid: end.toString(),
    records: Number(end - start) + 1,
    bytes: 50,
    plainBytes: 200,
    hash: "77",
    createdAtMs: at,
  }
}

describe("keys", () => {
  test("are zero-padded to twenty digits and sort in txid order", () => {
    const keys = [9n, 10n, 100n, 2n, 1n].map((txid) => snapshotKey("bunql/", "acme", txid))
    const sorted = [...keys].sort()
    expect(sorted.map((key) => Number(parseSnapshotKey(key)))).toEqual([1, 2, 9, 10, 100])
    expect(sorted[0]).toBe("bunql/db/acme/snapshots/00000000000000000001.db.zst")
  })

  test("segment keys carry both ends and round-trip", () => {
    const key = segmentKey("bunql/", "acme", 101n, 250n)
    expect(key).toBe(
      "bunql/db/acme/segments/00000000000000000101-00000000000000000250.seg.zst",
    )
    expect(parseSegmentKey(key)).toEqual({ startTxid: 101n, endTxid: 250n })
  })

  test("the prefix is normalised to exactly one trailing slash and no leading one", () => {
    for (const prefix of ["bunql", "bunql/", "/bunql", "/bunql///"]) {
      expect(manifestKey(prefix, "acme")).toBe("bunql/db/acme/manifest.json")
    }
    expect(manifestKey("", "acme")).toBe("db/acme/manifest.json")
  })

  test("a key that is not ours parses as null rather than throwing", () => {
    expect(parseSnapshotKey("bunql/db/acme/snapshots/readme.txt")).toBeNull()
    expect(parseSegmentKey("bunql/db/acme/segments/1-2.seg.zst")).toBeNull()
  })
})

describe("manifest", () => {
  test("round-trips and keeps every txid a string", () => {
    const manifest = emptyManifest("acme", 4096, GEN)
    manifest.snapshots.push(snapshot(0n))
    manifest.segments.push(segment(1n, 120n))
    const decoded = decodeManifest(encodeManifest(normalizeManifest(manifest)))
    expect(decoded).not.toBeNull()
    expect(decoded?.shippedTxid).toBe("120")
    expect(typeof decoded?.segments[0]?.endTxid).toBe("string")
  })

  test("a torn body decodes as nothing, never as an empty manifest", () => {
    const body = encodeManifest(emptyManifest("acme", 4096, GEN))
    expect(decodeManifest(body.slice(0, body.length / 2))).toBeNull()
    expect(decodeManifest("")).toBeNull()
    expect(decodeManifest('{"version":99,"db":"acme","snapshots":[],"segments":[]}')).toBeNull()
  })

  test("normalise sorts the inventory and recomputes the generation bounds", () => {
    const manifest = emptyManifest("acme", 4096, GEN)
    manifest.segments.push(segment(201n, 300n), segment(1n, 200n))
    const normalized = normalizeManifest(manifest)
    expect(normalized.segments.map((one) => one.startTxid)).toEqual(["1", "201"])
    expect(normalized.shippedTxid).toBe("300")
    expect(normalized.generations[0]?.lastTxid).toBe("300")
    expect(latestTxid(normalized)).toBe(300n)
  })
})

describe("planning a restore", () => {
  function manifestWith(entries: Partial<Manifest>): Manifest {
    return normalizeManifest({ ...emptyManifest("acme", 4096, GEN), ...entries })
  }

  test("starts from the newest snapshot at or before the target", () => {
    const manifest = manifestWith({
      snapshots: [snapshot(100n), snapshot(200n)],
      segments: [segment(101n, 200n), segment(201n, 300n)],
    })
    const plan = planRestore(manifest, 250n)
    expect(plan.snapshot?.txid).toBe("200")
    expect(plan.fromTxid).toBe(200n)
    expect(plan.segments.map((one) => one.startTxid)).toEqual(["201"])
  })

  test("a generation whose log reaches txid 1 needs no snapshot at all", () => {
    const manifest = manifestWith({ segments: [segment(1n, 50n)] })
    const plan = planRestore(manifest, 50n)
    expect(plan.snapshot).toBeNull()
    expect(plan.fromTxid).toBe(0n)
    expect(plan.segments).toHaveLength(1)
  })

  test("a hole in the inventory is refused, not skipped", () => {
    const manifest = manifestWith({
      snapshots: [snapshot(0n)],
      segments: [segment(1n, 100n), segment(151n, 200n)],
    })
    expect(() => planRestore(manifest, 200n)).toThrow(RestorePlanError)
    try {
      planRestore(manifest, 200n)
    } catch (err) {
      expect((err as RestorePlanError).code).toBe("S3_INCOMPLETE")
      expect((err as Error).message).toContain("short of 200")
    }
    // Everything before the hole is still restorable.
    expect(planRestore(manifest, 100n).reaches).toBe(100n)
  })

  test("a target past everything shipped is refused", () => {
    const manifest = manifestWith({ snapshots: [snapshot(0n)], segments: [segment(1n, 10n)] })
    expect(() => planRestore(manifest, 11n)).toThrow(RestorePlanError)
  })

  test("the newest generation that reaches the target wins, and an older one is still reachable", () => {
    const second = "bbbbbbbbbbbbbbbb"
    const manifest = manifestWith({
      generations: [
        { id: GEN, startedAtMs: 1, firstTxid: "0", lastTxid: "300" },
        { id: second, startedAtMs: 2, firstTxid: "0", lastTxid: "40" },
      ],
      snapshots: [snapshot(0n), { ...snapshot(0n), generation: second, key: "gen2/snap" }],
      segments: [
        segment(1n, 300n),
        segment(1n, 40n, 2000, second),
      ],
    })
    expect(planRestore(manifest, 40n).generation).toBe(second)
    // Only the first generation ever reached 300.
    expect(planRestore(manifest, 300n).generation).toBe(GEN)
    expect(planRestore(manifest, 40n, GEN).generation).toBe(GEN)
  })

  test("generation ids are unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newGenerationId()))
    expect(ids.size).toBe(200)
  })
})
