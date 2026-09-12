// `Tenant.retain` — the one pass that prunes the snapshots, computes the floor from what survived,
// and then drops the log segments nothing can still need (`docs/r6-retention.md`).
//
// The assertion that matters is the last one in the first test: after the sweep the database is
// still restorable to a point inside the retention window. A floor computed one segment too low
// would leave the snapshot there and the records after it gone, and nothing else in this file
// would notice.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { type Tenant, TenantRegistry } from "../../src/tenant/index.ts"
import { listSnapshots, restore } from "../../src/wal/index.ts"
import { cleanupTempDirs, dumpFile, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

/** A registry whose log rolls a segment per transaction, so retention has something to choose. */
function registry() {
  const dir = tempDir("bunql-retain-")
  return { dir, registry: TenantRegistry.open({ dir, segmentBytes: 1 }) }
}

/** `rows` one-row transactions on `t`, each its own segment. */
function writeRows(tenant: Tenant, rows: number): void {
  for (let i = 0; i < rows; i++) {
    tenant.write((db) => db.run("insert into t(v) values ('x')"))
  }
}

describe("Tenant.retain", () => {
  test("holds the log to the oldest snapshot it kept, and stays restorable inside the window", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    writeRows(tenant, 4)
    expect(tenant.txid).toBe(5n)

    // The PITR base. Everything after it is what a restore replays.
    const base = await tenant.snapshot()
    expect(BigInt(base.txid)).toBe(5n)
    writeRows(tenant, 15)
    expect(tenant.txid).toBe(20n)
    expect(tenant.log.firstTxid).toBe(1n)

    // Every record is now older than the retention, so the age bound alone would take all but the
    // open segment. The floor is the only thing standing between that and an unrestorable database.
    await Bun.sleep(20)
    const result = tenant.retain({ retentionMs: 5 })
    expect(result.floor).toBe(5n)
    expect(result.segments.length).toBe(4)
    expect(tenant.log.firstTxid).toBe(5n)
    // The newest snapshot is kept whatever its age, so the base is still there.
    expect(listSnapshots(tenant.dir).map((s) => s.txid)).toEqual(["5"])

    // And the point of all of it: a restore to a point inside the window still works.
    const into = path.join(tempDir("bunql-restore-"), "pitr")
    const restored = await restore({ dir: tenant.dir, at: 12n, into })
    expect(restored.txid).toBe(12n)
    expect(restored.fromTxid).toBe(5n)
    expect(restored.applied).toBe(7)
    const rows = dumpFile(restored.path).split("\n").length - 1
    expect(rows).toBe(11)

    reg.close()
  })

  test("a connected replica holds the log; the same replica gone does not", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    writeRows(tenant, 19)
    expect(tenant.txid).toBe(20n)
    await Bun.sleep(20)

    // Nothing has been snapshotted and no bucket is configured, so the replica is the only floor.
    expect(tenant.retain({ retentionMs: 5, replicaTxid: 8n }).floor).toBe(8n)
    expect(tenant.log.firstTxid).toBe(8n)

    // A size cap is still subject to it: a full disk is recoverable, a record the replica is about
    // to ask for is not.
    expect(tenant.retain({ retentionMs: 5, maxLogBytes: 1, replicaTxid: 8n }).segments).toEqual([])
    expect(tenant.log.firstTxid).toBe(8n)

    // The replica is gone. It imposes nothing now — it is re-snapshotted when it comes back — so
    // the retention is free to take the log down to the segment still being appended to.
    expect(tenant.retain({ retentionMs: 5 }).floor).toBeNull()
    expect(tenant.log.firstTxid).toBe(20n)

    reg.close()
  })

  test("the S3 shipper holds the records the bucket does not have yet", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    writeRows(tenant, 9)
    await Bun.sleep(20)

    expect(tenant.retain({ retentionMs: 5, shippedTxid: 4n }).floor).toBe(4n)
    expect(tenant.log.firstTxid).toBe(4n)
    reg.close()
  })

  test("prunes snapshots past the cutoff, keeping the newest, and follows it with the floor", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    writeRows(tenant, 4)
    const first = await tenant.snapshot()
    writeRows(tenant, 5)
    const second = await tenant.snapshot()
    expect(listSnapshots(tenant.dir).length).toBe(2)

    // A clock far enough forward that both snapshots are past the cutoff. Only the newest survives,
    // and the log floor follows it.
    await Bun.sleep(20)
    const result = tenant.retain({ retentionMs: 5, now: Date.now() + 86_400_000 })
    expect(result.snapshots).toEqual([first.path])
    expect(fs.existsSync(first.path)).toBe(false)
    expect(fs.existsSync(second.path)).toBe(true)
    expect(result.floor).toBe(BigInt(second.txid))
    expect(tenant.log.firstTxid).toBe(BigInt(second.txid))

    // The catalog row went with the file, so `lastSnapshotTxid` does not point at something gone.
    expect(tenant.stats().lastSnapshotTxid).toBe(BigInt(second.txid))
    reg.close()
  })

  test('retention "0" keeps everything', async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t (id integer primary key, v text)"))
    writeRows(tenant, 9)
    await Bun.sleep(20)

    const result = tenant.retain({ retentionMs: 0 })
    expect(result).toEqual({ snapshots: [], segments: [], bytesFreed: 0, floor: null })
    expect(tenant.log.firstTxid).toBe(1n)
    reg.close()
  })
})
