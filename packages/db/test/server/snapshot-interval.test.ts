// `docs/r6-retention.md` left one hole open: the log's retention floor is derived from the oldest
// snapshot kept, and only the S3 shipper and a replica bootstrap ever took a snapshot. A node with
// neither took none, ever — so it had no floor, and once its oldest segment aged out it quietly
// stopped being restorable to any point before it. `[durability] snapshotIntervalMs` is the floor
// such a node gets, and this is what it has to do.

import { afterAll, describe, expect, test } from "bun:test"
import type { ServerRuntime } from "../../src/server/runtime.ts"
import { startTestServer, stopAll } from "./harness.ts"

afterAll(stopAll)

async function nodeWith(snapshotIntervalMs: number): Promise<ServerRuntime> {
  const server = await startTestServer({
    durability: { snapshotIntervalMs, sweepIntervalMs: 0 },
  })
  return server.handle.runtime
}

describe("periodic local snapshots", () => {
  test("a node with no bucket and no replica takes one, and so gets a retention floor", async () => {
    const rt = await nodeWith(60 * 60 * 1000)
    const tenant = await rt.registry.create("acme")
    tenant.write((db) => db.exec("create table t(id integer primary key, v text)"))
    expect(tenant.snapshots()).toHaveLength(0)

    // The first pass has nothing to compare against, so it snapshots.
    expect(await rt.maybeSnapshot(tenant)).toBe(true)
    const snapshots = tenant.snapshots()
    expect(snapshots).toHaveLength(1)
    expect(BigInt(snapshots[0]!.txid)).toBe(tenant.txid)
  })

  test("it does nothing while the newest snapshot is inside the interval", async () => {
    const rt = await nodeWith(60 * 60 * 1000)
    const tenant = await rt.registry.create("acme")
    tenant.write((db) => db.exec("create table t(id integer primary key, v text)"))
    expect(await rt.maybeSnapshot(tenant)).toBe(true)

    tenant.write((db) => db.run("insert into t(v) values ('a')"))
    // Written since, but the snapshot is minutes old, not hours.
    expect(await rt.maybeSnapshot(tenant)).toBe(false)
    expect(tenant.snapshots()).toHaveLength(1)

    // An hour later, the same database has moved on and is snapshotted again.
    expect(await rt.maybeSnapshot(tenant, Date.now() + 61 * 60 * 1000)).toBe(true)
    expect(tenant.snapshots()).toHaveLength(2)
  })

  test("a database nothing has written since its snapshot is left alone", async () => {
    const rt = await nodeWith(60 * 60 * 1000)
    const tenant = await rt.registry.create("acme")
    tenant.write((db) => db.exec("create table t(id integer primary key)"))
    await rt.maybeSnapshot(tenant)

    // A day later, with no writes in between: the snapshot would be the same file at the same
    // txid, so taking it would be copying a database to say nothing new.
    expect(await rt.maybeSnapshot(tenant, Date.now() + 24 * 60 * 60 * 1000)).toBe(false)
    expect(tenant.snapshots()).toHaveLength(1)
  })

  test("an empty database is not snapshotted", async () => {
    const rt = await nodeWith(60 * 60 * 1000)
    const tenant = await rt.registry.create("acme")
    expect(tenant.txid).toBe(0n)
    expect(await rt.maybeSnapshot(tenant)).toBe(false)
    expect(tenant.snapshots()).toHaveLength(0)
  })

  test("zero turns it off, which is what a node that snapshots elsewhere wants", async () => {
    const rt = await nodeWith(0)
    const tenant = await rt.registry.create("acme")
    tenant.write((db) => db.exec("create table t(id integer primary key)"))
    expect(await rt.maybeSnapshot(tenant)).toBe(false)
    expect(tenant.snapshots()).toHaveLength(0)
  })

  test("the snapshot is a real restore point, not a bookkeeping entry", async () => {
    const rt = await nodeWith(60 * 60 * 1000)
    const tenant = await rt.registry.create("acme")
    tenant.write((db) => {
      db.exec("create table t(id integer primary key, v text)")
      db.run("insert into t(v) values ('before')")
    })
    await rt.maybeSnapshot(tenant)
    const at = tenant.txid
    tenant.write((db) => db.run("insert into t(v) values ('after')"))

    // Restoring to the snapshot's txid gives the database as it was, which is the whole point of
    // having a floor: the log alone could no longer reach back past a retention sweep.
    // `fork` returns the new database's name and txid; open it to read it.
    const forked = await tenant.fork("acme-at", at)
    expect(forked.txid).toBe(at)
    const restored = rt.registry.open(forked.name)
    const rows = await restored.read((db) =>
      db.prepare("select v from t order by id").values().flat(),
    )
    expect(rows).toEqual(["before"])
  })
})
