// The milestone's real claim: everything a tenant commits reaches the bucket, and the bucket
// rebuilds the database exactly — at the end of the log, at a txid in the middle of it, and at a
// wall-clock moment — or fails loudly. Plus the three promises `docs/r3-storage.md` makes about
// failure: the write path is never blocked, a transient 500 is survived, and retention never
// removes an object a surviving snapshot replays from.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  decodeIndexChunk,
  INDEX_CHUNK,
  listIndexChunks,
  manifestKey,
  readManifest,
  RestoreError,
  restoreFromBucket,
  restoreIntoCatalog,
  segmentPrefix,
  Shipper,
  verifyBucket,
} from "../../src/storage/index.ts"
import {
  type Backend,
  cleanup,
  dumpFile,
  openBackend,
  openRegistry,
  openTenant,
  tempDir,
  writeRows,
} from "./harness.ts"

let backend: Backend

beforeAll(async () => {
  backend = await openBackend()
})

afterAll(() => cleanup())

/** A shipper wired to a fresh prefix, with the timers turned off so tests drive it by hand. */
function shipperFor(
  db: string,
  prefix: string,
  overrides: Partial<ConstructorParameters<typeof Shipper>[0]> = {},
): Shipper {
  return new Shipper({
    store: backend.store(),
    prefix,
    db,
    shipIntervalMs: 20,
    snapshotIntervalMs: 0,
    snapshotEveryBytes: 0,
    retentionMs: 0,
    onError: () => {},
    ...overrides,
  })
}

describe("shipping and restoring", () => {
  test("a tenant's whole history restores into a fresh directory with an identical dump", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "acme")
    writeRows(tenant, 1, 40)

    const prefix = backend.prefix()
    const shipper = shipperFor("acme", prefix)
    shipper.bind(tenant)
    await shipper.flush()

    expect(shipper.shippedTxid).toBe(tenant.txid)
    expect(shipper.behind).toBe(false)

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "acme",
      dir: into,
    })
    expect(result.txid).toBe(tenant.txid)
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    expect(result.checksum).toBe(tenant.checksum)
    await shipper.close()
  })

  test("restores to a txid in the middle of the log", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "mid")
    writeRows(tenant, 1, 10)

    const prefix = backend.prefix()
    const shipper = shipperFor("mid", prefix)
    shipper.bind(tenant)
    await shipper.flush()
    const midTxid = tenant.txid
    const midDump = dumpFile(tenant.dbPath)

    writeRows(tenant, 100, 10)
    await shipper.flush()
    expect(shipper.shippedTxid).toBe(tenant.txid)

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "mid",
      at: { txid: midTxid },
      dir: into,
    })
    expect(result.txid).toBe(midTxid)
    expect(dumpFile(result.path)).toBe(midDump)
    // The rows written after the target are not there.
    expect(dumpFile(result.path)).not.toContain("todo 100")
    await shipper.close()
  })

  test("restores to a timestamp", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "clock")
    writeRows(tenant, 1, 5)
    const earlyDump = dumpFile(tenant.dbPath)
    const earlyTxid = tenant.txid

    // The record timestamps are microseconds from the clock, so a real gap is needed for the
    // boundary to be unambiguous.
    await Bun.sleep(25)
    const cut = Date.now()
    await Bun.sleep(25)

    writeRows(tenant, 100, 5)
    const prefix = backend.prefix()
    const shipper = shipperFor("clock", prefix)
    shipper.bind(tenant)
    await shipper.flush()

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "clock",
      at: { timestamp: cut },
      dir: into,
    })
    expect(result.txid).toBe(earlyTxid)
    expect(dumpFile(result.path)).toBe(earlyDump)
    await shipper.close()
  })

  test("a restore writes a catalog row the registry opens as a normal primary", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "promote")
    writeRows(tenant, 1, 12)
    const prefix = backend.prefix()
    const shipper = shipperFor("promote", prefix)
    shipper.bind(tenant)
    await shipper.flush()
    await shipper.close()

    const target = openRegistry()
    const result = await restoreIntoCatalog({
      store: backend.store(),
      prefix,
      db: "promote",
      dataDir: target.dir,
      catalog: target.catalog,
      into: "recovered",
    })
    expect(result.name).toBe("recovered")

    const restored = target.open("recovered")
    expect(restored.isReplica).toBe(false)
    expect(restored.txid).toBe(tenant.txid)
    expect(dumpFile(restored.dbPath)).toBe(dumpFile(tenant.dbPath))
    // And it is a working primary: it can take a write and carry on from the restored txid.
    const next = restored.write((db) => {
      db.prepare("insert into todos (id, title, done) values (?, ?, ?)").run(999, "after", 0)
    })
    expect(next.txid).toBe(tenant.txid + 1n)
  })

  test("segment objects are contiguous and the manifest describes exactly what is there", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "inv")
    const prefix = backend.prefix()
    const shipper = shipperFor("inv", prefix, { maxBatchBytes: 4096 })
    shipper.bind(tenant)

    for (let round = 0; round < 4; round++) {
      writeRows(tenant, round * 100 + 1, 8)
      await shipper.flush()
    }

    const manifest = await readManifest(backend.store(), prefix, "inv")
    expect(manifest.segments.length).toBeGreaterThan(1)
    let next = 1n
    for (const segment of manifest.segments) {
      expect(BigInt(segment.startTxid)).toBe(next)
      next = BigInt(segment.endTxid) + 1n
    }
    expect(next - 1n).toBe(tenant.txid)
    expect(manifest.shippedTxid).toBe(tenant.txid.toString())
    await shipper.close()
  })
})

describe("failure handling", () => {
  test("a bucket missing a segment fails loudly rather than restoring a hole", async () => {
    if (!backend.fake) return
    const registry = openRegistry()
    const tenant = await openTenant(registry, "holed")
    const prefix = backend.prefix()
    const shipper = shipperFor("holed", prefix, { maxBatchBytes: 2048 })
    shipper.bind(tenant)
    for (let round = 0; round < 4; round++) {
      writeRows(tenant, round * 100 + 1, 6)
      await shipper.flush()
    }
    const manifest = await readManifest(backend.store(), prefix, "holed")
    expect(manifest.segments.length).toBeGreaterThan(2)
    const victim = manifest.segments[1] as { key: string }
    expect(backend.fake.drop(victim.key)).toBe(true)

    const verified = await verifyBucket({ store: backend.store(), prefix, db: "holed" })
    expect(verified.ok).toBe(false)
    expect(verified.missing).toContain(victim.key)

    const into = tempDir("bunql-restore-")
    await expect(
      restoreFromBucket({ store: backend.store(), prefix, db: "holed", dir: into }),
    ).rejects.toMatchObject({ code: "S3_INCOMPLETE" })
    await shipper.close()
  })

  test("a corrupted object fails the hash check rather than being applied", async () => {
    if (!backend.fake) return
    const registry = openRegistry()
    const tenant = await openTenant(registry, "corrupt")
    writeRows(tenant, 1, 6)
    const prefix = backend.prefix()
    const shipper = shipperFor("corrupt", prefix)
    shipper.bind(tenant)
    await shipper.flush()

    const manifest = await readManifest(backend.store(), prefix, "corrupt")
    const key = (manifest.segments[0] as { key: string }).key
    backend.fake.corrupt(key, new Uint8Array(Bun.zstdCompressSync(new Uint8Array(64))))

    const into = tempDir("bunql-restore-")
    await expect(
      restoreFromBucket({ store: backend.store(), prefix, db: "corrupt", dir: into }),
    ).rejects.toMatchObject({ code: "S3_CORRUPT" })
    await shipper.close()
  })

  test("a torn manifest is ignored, never read as an empty one", async () => {
    if (!backend.fake) return
    const registry = openRegistry()
    const tenant = await openTenant(registry, "torn")
    writeRows(tenant, 1, 4)
    const prefix = backend.prefix()
    const shipper = shipperFor("torn", prefix)
    shipper.bind(tenant)
    await shipper.flush()

    const key = manifestKey(prefix, "torn")
    const whole = await backend.store().get(key)
    backend.fake.corrupt(key, whole.subarray(0, Math.floor(whole.byteLength / 2)))

    await expect(readManifest(backend.store(), prefix, "torn")).rejects.toMatchObject({
      code: "S3_NO_MANIFEST",
    })
    await shipper.close()
  })

  test("the manifest is written last, after every object it names", async () => {
    if (!backend.fake) return
    const registry = openRegistry()
    const tenant = await openTenant(registry, "order")
    writeRows(tenant, 1, 6)
    const prefix = backend.prefix()
    const shipper = shipperFor("order", prefix)
    shipper.bind(tenant)
    backend.fake.log.length = 0
    await shipper.flush()

    const puts = backend.fake.log.filter((one) => one.method === "PUT").map((one) => one.key)
    const manifestAt = puts.indexOf(manifestKey(prefix, "order"))
    expect(manifestAt).toBeGreaterThanOrEqual(0)
    // Every segment and snapshot PUT comes before it.
    for (let i = manifestAt + 1; i < puts.length; i++) {
      expect(puts[i]).toBe(manifestKey(prefix, "order"))
    }
    expect(puts.slice(0, manifestAt).some((key) => key.includes("/segments/"))).toBe(true)
    await shipper.close()
  })

  test("the shipper survives a transient 500 and resumes", async () => {
    if (!backend.fake) return
    const registry = openRegistry()
    const tenant = await openTenant(registry, "blip")
    writeRows(tenant, 1, 6)
    const prefix = backend.prefix()
    const shipper = shipperFor("blip", prefix)
    shipper.bind(tenant)

    backend.fake.failNext = 3
    await shipper.flush()
    expect(shipper.shippedTxid).toBe(tenant.txid)

    writeRows(tenant, 100, 6)
    await shipper.flush()
    expect(shipper.shippedTxid).toBe(tenant.txid)

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({ store: backend.store(), prefix, db: "blip", dir: into })
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    await shipper.close()
  })

  test("the write path is not blocked when the bucket is unreachable", async () => {
    if (!backend.fake) return
    const registry = openRegistry()
    const tenant = await openTenant(registry, "offline")
    const prefix = backend.prefix()
    // Retries have to be cheap here or the drain sits on backoff for the whole test.
    const shipper = shipperFor("offline", prefix, {
      store: backend.store(),
      shipIntervalMs: 5,
    })
    shipper.bind(tenant)
    writeRows(tenant, 1, 3)
    await shipper.flush()
    const shippedBefore = shipper.shippedTxid

    backend.fake.goOffline()
    const startedNs = Bun.nanoseconds()
    writeRows(tenant, 100, 30)
    const perWriteUs = (Bun.nanoseconds() - startedNs) / 1000 / 30
    // A commit that waited on an unreachable bucket would be measured in milliseconds. Design
    // §10's budget for a single-row write is 40 µs; a very loose ceiling still proves the point.
    expect(perWriteUs).toBeLessThan(2000)
    expect(tenant.txid).toBe(shippedBefore + 30n)

    // The drain that runs while the bucket is down fails and says so.
    await shipper.flush().catch(() => {})
    expect(shipper.behind).toBe(true)
    expect(shipper.shippedTxid).toBe(shippedBefore)

    backend.fake.goOnline()
    await shipper.flush()
    expect(shipper.behind).toBe(false)
    expect(shipper.shippedTxid).toBe(tenant.txid)

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "offline",
      dir: into,
    })
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    await shipper.close()
  })

  test("an overflowing queue is dropped and the records are re-read from the log", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "overflow")
    const prefix = backend.prefix()
    // A ceiling of a few hundred bytes overflows on the first record, which forces every drain
    // down the log-reading path rather than the in-memory one.
    const shipper = shipperFor("overflow", prefix, { maxPendingBytes: 1 })
    shipper.bind(tenant)
    writeRows(tenant, 1, 20)
    expect(shipper.state().behind).toBe(true)

    await shipper.flush()
    expect(shipper.shippedTxid).toBe(tenant.txid)
    expect(shipper.behind).toBe(false)

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "overflow",
      dir: into,
    })
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    await shipper.close()
  })
})

describe("retention", () => {
  test("never deletes an object a retained snapshot needs to replay from", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "keep")
    const prefix = backend.prefix()
    const shipper = shipperFor("keep", prefix, {
      // Everything is "old", so retention would remove whatever it is allowed to.
      retentionMs: 1,
      retentionSweepMs: 0,
      maxBatchBytes: 2048,
    })
    shipper.bind(tenant)

    for (let round = 0; round < 3; round++) {
      writeRows(tenant, round * 100 + 1, 6)
      await shipper.flush()
    }
    // Two snapshots, so the sweep has something it is allowed to drop.
    await tenant.snapshot()
    await shipper.flush()
    writeRows(tenant, 500, 6)
    await shipper.flush()
    await tenant.snapshot()
    await shipper.flush()
    await shipper.flush()

    const manifest = await readManifest(backend.store(), prefix, "keep")
    // The newest snapshot is always kept.
    expect(manifest.snapshots.length).toBeGreaterThanOrEqual(1)
    const oldest = BigInt(manifest.snapshots[0]?.txid ?? "0")
    // Every segment that survives is one the oldest surviving snapshot could still need.
    for (const segment of manifest.segments) {
      expect(BigInt(segment.endTxid)).toBeGreaterThanOrEqual(oldest)
    }
    // And what is left is genuinely restorable, which is the only claim that matters.
    const verified = await verifyBucket({ store: backend.store(), prefix, db: "keep" })
    expect(verified.ok).toBe(true)
    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({ store: backend.store(), prefix, db: "keep", dir: into })
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    await shipper.close()
  })

  test("with retention off, nothing is ever deleted", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "forever")
    const prefix = backend.prefix()
    const shipper = shipperFor("forever", prefix, { retentionMs: 0, maxBatchBytes: 1024 })
    shipper.bind(tenant)
    for (let round = 0; round < 3; round++) {
      writeRows(tenant, round * 100 + 1, 5)
      await shipper.flush()
    }
    await tenant.snapshot()
    await shipper.flush()
    const manifest = await readManifest(backend.store(), prefix, "forever")
    expect(BigInt(manifest.segments[0]?.startTxid ?? "0")).toBe(1n)
    await shipper.close()
  })
})

describe("verify and generations", () => {
  test("verify reports the latest restorable txid and writes nothing", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "verify")
    writeRows(tenant, 1, 9)
    const prefix = backend.prefix()
    const shipper = shipperFor("verify", prefix)
    shipper.bind(tenant)
    await shipper.flush()

    const before = backend.fake ? backend.fake.objects.size : 0
    const result = await verifyBucket({ store: backend.store(), prefix, db: "verify" })
    expect(result.ok).toBe(true)
    expect(result.latest).toBe(Number(tenant.txid))
    expect(result.at).toBe(Number(tenant.txid))
    if (backend.fake) expect(backend.fake.objects.size).toBe(before)
    await shipper.close()
  })

  test("a prefix with nothing in it is `S3_NO_MANIFEST`, not an empty success", async () => {
    await expect(
      verifyBucket({ store: backend.store(), prefix: backend.prefix(), db: "absent" }),
    ).rejects.toBeInstanceOf(RestoreError)
  })

  test("a restore shipped back into the same prefix starts a new generation", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "gen")
    writeRows(tenant, 1, 10)
    const prefix = backend.prefix()
    const first = shipperFor("gen", prefix)
    first.bind(tenant)
    await first.flush()
    const original = await readManifest(backend.store(), prefix, "gen")
    await first.close()

    // A second database at the same name but standing further back in its own history: the bucket
    // is ahead of it, which is exactly the "this is not the same timeline" case.
    const rewound = openRegistry()
    const short = await openTenant(rewound, "gen")
    writeRows(short, 1, 2)
    const second = shipperFor("gen", prefix)
    second.bind(short)
    await second.flush()

    const after = await readManifest(backend.store(), prefix, "gen")
    expect(after.generation).not.toBe(original.generation)
    expect(after.generations.length).toBe(2)
    // The old timeline is still restorable, because retention has not touched it.
    const into = tempDir("bunql-restore-")
    const restored = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "gen",
      generation: original.generation,
      dir: into,
    })
    expect(restored.txid).toBe(tenant.txid)
    await second.close()
  })
})

describe("a shipper that loses and regains its tenant", () => {
  test("rebinding to a reopened tenant keeps the bucket position and catches up", async () => {
    const dir = tempDir()
    const registry = openRegistry({ dir })
    const tenant = await openTenant(registry, "rebind")
    writeRows(tenant, 1, 5)
    const prefix = backend.prefix()
    const shipper = shipperFor("rebind", prefix)
    shipper.bind(tenant)
    await shipper.flush()
    const shipped = shipper.shippedTxid

    // The LRU closed the tenant while more was committed by whoever reopened it.
    shipper.unbind()
    registry.release("rebind")
    const reopened = registry.open("rebind")
    writeRows(reopened, 100, 5)
    expect(shipper.shippedTxid).toBe(shipped)

    shipper.bind(reopened)
    expect(shipper.hasWork).toBe(true)
    await shipper.flush()
    expect(shipper.shippedTxid).toBe(reopened.txid)

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "rebind",
      dir: into,
    })
    expect(dumpFile(result.path)).toBe(dumpFile(reopened.dbPath))
    await shipper.close()
  })

  test("a fresh shipper against an existing prefix resumes from the manifest", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "resume")
    writeRows(tenant, 1, 6)
    const prefix = backend.prefix()
    const first = shipperFor("resume", prefix)
    first.bind(tenant)
    await first.flush()
    await first.close()

    writeRows(tenant, 100, 6)
    const second = shipperFor("resume", prefix)
    second.bind(tenant)
    await second.flush()
    expect(second.shippedTxid).toBe(tenant.txid)

    const manifest = await readManifest(backend.store(), prefix, "resume")
    let next = 1n
    for (const segment of manifest.segments) {
      expect(BigInt(segment.startTxid)).toBe(next)
      next = BigInt(segment.endTxid) + 1n
    }
    await second.close()
  })
})

describe("a snapshot base", () => {
  test("a log that no longer reaches txid 1 forces a snapshot, and it restores", async () => {
    const registry = openRegistry({ segmentBytes: 4096 })
    const tenant = await openTenant(registry, "aged")
    writeRows(tenant, 1, 40)
    // Retain away the front of the log, which is what makes a snapshot the only possible base.
    // `maxBytes`, not `maxAgeMs`: record timestamps are microseconds off the same clock the sweep
    // reads, so on a fast machine forty writes can all land inside the current millisecond and
    // "older than zero" is then false.
    tenant.log.retain({ maxBytes: 1, keepAfterTxid: tenant.txid })
    expect(tenant.log.firstTxid).not.toBe(1n)

    const prefix = backend.prefix()
    const shipper = shipperFor("aged", prefix)
    shipper.bind(tenant)
    writeRows(tenant, 100, 5)
    await shipper.flush()

    const manifest = await readManifest(backend.store(), prefix, "aged")
    expect(manifest.snapshots.length).toBe(1)
    expect(BigInt(manifest.snapshots[0]?.txid ?? "-1")).toBeGreaterThan(0n)

    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({ store: backend.store(), prefix, db: "aged", dir: into })
    expect(result.txid).toBe(tenant.txid)
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    expect(fs.existsSync(path.join(into, "meta.json"))).toBe(false)
    await shipper.close()
  })
})

// R9 (`docs/r9-segment-index.md`). The claim is not "the inventory is smaller" — it is the same
// inventory — but that the *manifest body* stops growing with the age of the database, because the
// old one was rewritten whole on every drain and carried an entry per segment ever shipped.
describe("the segment index", () => {
  /** The manifest object's size in the bucket, which is what a drain uploads. */
  async function manifestBytes(prefix: string, db: string): Promise<number> {
    const head = await backend.store().head(manifestKey(prefix, db))
    return head?.size ?? 0
  }

  async function chunkCount(prefix: string, db: string): Promise<number> {
    return (await listIndexChunks(backend.store(), prefix, db)).length
  }

  test("the manifest stops growing while the inventory keeps growing", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "bounded")
    const prefix = backend.prefix()
    const shipper = shipperFor("bounded", prefix, { retentionMs: 0 })
    shipper.bind(tenant)

    // One drain per write, which is what `shipIntervalMs` does to a steadily written database and
    // the shape that made the old manifest quadratic.
    let early = 0
    for (let i = 1; i <= 200; i++) {
      writeRows(tenant, i, 1)
      await shipper.flush()
      if (i === 40) early = await manifestBytes(prefix, "bounded")
    }
    const late = await manifestBytes(prefix, "bounded")

    const manifest = await readManifest(backend.store(), prefix, "bounded")
    // The inventory really did grow — otherwise the size claim below is about nothing.
    expect(manifest.segments.length).toBeGreaterThan(INDEX_CHUNK * 3)
    expect(await chunkCount(prefix, "bounded")).toBeGreaterThanOrEqual(3)
    // And the body a drain uploads did not. The bound is the tail, which never holds more than
    // `INDEX_CHUNK` entries however many segments the database has.
    expect(late).toBeLessThan(early * 2)
    expect(manifest.shippedTxid).toBe(tenant.txid.toString())

    // Bounded and still restorable byte for byte, which is the only thing the inventory is for.
    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({
      store: backend.store(),
      prefix,
      db: "bounded",
      dir: into,
    })
    expect(result.txid).toBe(tenant.txid)
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    await shipper.close()
  })

  test("a frozen chunk is only ever written full, and never rewritten", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "chunks")
    const prefix = backend.prefix()
    const shipper = shipperFor("chunks", prefix, { retentionMs: 0 })
    shipper.bind(tenant)
    for (let i = 1; i <= 120; i++) {
      writeRows(tenant, i, 1)
      await shipper.flush()
    }
    const keys = await listIndexChunks(backend.store(), prefix, "chunks")
    expect(keys.length).toBeGreaterThanOrEqual(3)

    const fake = backend.fake
    if (fake) {
      // Immutable is the property the whole design leans on: a chunk written twice would be the
      // quadratic rewrite back again, wearing a different name.
      for (const [key, count] of fake.uploadCounts((one) => one.includes("/index/"))) {
        expect({ key, count }).toEqual({ key, count: 1 })
      }
    }
    // Each chunk holds exactly `INDEX_CHUNK` entries, which is what makes the number of objects a
    // restore lists `segments / INDEX_CHUNK` rather than one per drain.
    for (const key of keys) {
      const entries = decodeIndexChunk(await backend.store().get(key))
      expect(entries?.length).toBe(INDEX_CHUNK)
    }
    await shipper.close()
  })

  test("retention prunes the chunks with the segments, and what is left still restores", async () => {
    const registry = openRegistry()
    const tenant = await openTenant(registry, "pruned")
    const prefix = backend.prefix()
    const shipper = shipperFor("pruned", prefix, {
      retentionMs: 1,
      retentionSweepMs: 0,
      maxBatchBytes: 512,
    })
    shipper.bind(tenant)
    for (let i = 1; i <= 120; i++) {
      writeRows(tenant, i, 1)
      await shipper.flush()
    }
    const before = await chunkCount(prefix, "pruned")
    expect(before).toBeGreaterThanOrEqual(3)

    // Two snapshots with writes between them, so retention has a floor it is allowed to move up to.
    await tenant.snapshot()
    await shipper.flush()
    writeRows(tenant, 500, 40)
    await shipper.flush()
    await tenant.snapshot()
    await shipper.flush()
    await shipper.flush()

    expect(await chunkCount(prefix, "pruned")).toBeLessThan(before)
    const manifest = await readManifest(backend.store(), prefix, "pruned")
    const oldest = BigInt(manifest.snapshots[0]?.txid ?? "0")
    // Nothing the surviving snapshot still needs was taken with them.
    for (const segment of manifest.segments) {
      expect(BigInt(segment.endTxid)).toBeGreaterThanOrEqual(oldest)
    }
    // And no entry survives in a chunk naming an object that has been deleted, which is the one
    // thing a reader is promised never to meet.
    const keys = new Set((await backend.store().list({ prefix: segmentPrefix(prefix, "pruned") })).map((one) => one.key))
    for (const segment of manifest.segments) expect(keys.has(segment.key)).toBe(true)

    const verified = await verifyBucket({ store: backend.store(), prefix, db: "pruned" })
    expect(verified.ok).toBe(true)
    const into = tempDir("bunql-restore-")
    const result = await restoreFromBucket({ store: backend.store(), prefix, db: "pruned", dir: into })
    expect(dumpFile(result.path)).toBe(dumpFile(tenant.dbPath))
    await shipper.close()
  })

  test("a torn chunk fails loudly rather than restoring a hole", async () => {
    const fake = backend.fake
    if (!fake) return
    const registry = openRegistry()
    const tenant = await openTenant(registry, "torn")
    const prefix = backend.prefix()
    const shipper = shipperFor("torn", prefix, { retentionMs: 0 })
    shipper.bind(tenant)
    for (let i = 1; i <= 80; i++) {
      writeRows(tenant, i, 1)
      await shipper.flush()
    }
    const [key] = await listIndexChunks(backend.store(), prefix, "torn")
    expect(key).toBeDefined()
    // Half a chunk is what a PUT that did not complete leaves behind.
    await backend.store().put(key as string, '{"version":2,"db":"torn","segm', "application/json")

    await expect(
      restoreFromBucket({ store: backend.store(), prefix, db: "torn", dir: tempDir("bunql-restore-") }),
    ).rejects.toMatchObject({ code: "S3_INDEX_UNREADABLE" })
    await shipper.close()
  })
})
