// Replica-mode tenants without a socket in the way: two registries in one process, records moved
// from one to the other by hand. What the transport does for real, this does by calling
// `applyRecord` — so a failure here is the tenant's, not the network's.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { TenantError, TenantRegistry, tenantDir, type Tenant } from "../../src/tenant/index.ts"
import { encode, type TxnRecord } from "../../src/wal/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

function registry(): { dir: string; registry: TenantRegistry } {
  const dir = tempDir()
  return { dir, registry: TenantRegistry.open({ dir }) }
}

/** Ships every record after `from` from the primary's log into the replica. */
function ship(primary: Tenant, replica: Tenant, from = replica.txid): number {
  let shipped = 0
  for (const record of primary.log.iterate(from + 1n)) {
    replica.applyRecord(record, encode(record))
    shipped += 1
  }
  return shipped
}

describe("replica-mode tenants", () => {
  test("applies records, advances the position and serves reads", async () => {
    const primaryReg = registry()
    const replicaReg = registry()
    const primary = await primaryReg.registry.create("acme")
    const replica = replicaReg.registry.createReplica("acme")

    expect(replica.role).toBe("replica")
    expect(replica.isReplica).toBe(true)
    expect(replica.recorder).toBeNull()
    expect(replica.applier).not.toBeNull()

    primary.write((db) => db.exec("create table t (id integer primary key, v text)"))
    primary.write((db) => db.run("insert into t (v) values ('one')"))
    primary.write((db) => db.run("insert into t (v) values ('two')"))

    expect(ship(primary, replica)).toBe(3)
    expect(replica.txid).toBe(primary.txid)
    expect(replica.checksum).toBe(primary.checksum)
    expect(replica.readSync((db) => db.prepare("select count(*) c from t").get())).toEqual({ c: 2 })

    primaryReg.registry.close()
    replicaReg.registry.close()
  })

  test("every write verb is refused with NOT_PRIMARY", async () => {
    const primaryReg = registry()
    const replicaReg = registry()
    const primary = await primaryReg.registry.create("acme")
    const replica = replicaReg.registry.createReplica("acme")
    primary.write((db) => db.exec("create table t (id integer primary key, v text)"))
    ship(primary, replica)

    for (const attempt of [
      () => replica.write((db) => db.run("insert into t (v) values ('x')")),
      () => replica.txBegin(),
      () => replica.txCommit(),
      () => replica.checkpoint("TRUNCATE"),
      () => replica.checkpoint("RESTART"),
    ]) {
      let thrown: unknown = null
      try {
        attempt()
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(TenantError)
      expect((thrown as TenantError).code).toBe("NOT_PRIMARY")
    }

    // The reads the plan promises keep working, and so does the checkpoint the applier needs.
    expect(replica.readSync((db) => db.prepare("select count(*) c from t").get())).toEqual({ c: 0 })
    expect(replica.checkpoint("PASSIVE").busy).toBe(false)
    expect(replica.stats().role).toBe("replica")

    primaryReg.registry.close()
    replicaReg.registry.close()
  })

  test("a primary refuses applyRecord", async () => {
    const { registry: reg } = registry()
    const primary = await reg.create("acme")
    primary.write((db) => db.exec("create table t (id integer primary key)"))
    const record = primary.log.read(1n) as TxnRecord
    expect(() => primary.applyRecord(record)).toThrow(/is a primary/)
    reg.close()
  })

  test("waitFor and read({minTxid}) resolve from an applied record", async () => {
    const primaryReg = registry()
    const replicaReg = registry()
    const primary = await primaryReg.registry.create("acme")
    const replica = replicaReg.registry.createReplica("acme")
    primary.write((db) => db.exec("create table t (id integer primary key, v text)"))
    ship(primary, replica)

    primary.write((db) => db.run("insert into t (v) values ('later')"))
    const target = primary.txid
    // The read is issued before the record exists here: it has to wait, not fail.
    const pending = replica.read((db) => db.prepare("select v from t").get(), {
      minTxid: target,
      waitMs: 2000,
    })
    const waiting = replica.waitFor(target, 2000)
    ship(primary, replica)
    await waiting
    expect(await pending).toEqual({ v: "later" })

    primaryReg.registry.close()
    replicaReg.registry.close()
  })

  test("commit listeners fire for applied records, which is R2's ack seam", async () => {
    const primaryReg = registry()
    const replicaReg = registry()
    const primary = await primaryReg.registry.create("acme")
    const replica = replicaReg.registry.createReplica("acme")
    const seen: bigint[] = []
    replica.onCommit((event) => seen.push(event.txid))

    primary.write((db) => db.exec("create table t (id integer primary key)"))
    primary.write((db) => db.run("insert into t default values"))
    ship(primary, replica)

    expect(seen).toEqual([1n, 2n])
    primaryReg.registry.close()
    replicaReg.registry.close()
  })

  test("the replica keeps its own log, so it can serve a downstream replica", async () => {
    const primaryReg = registry()
    const middleReg = registry()
    const tailReg = registry()
    const primary = await primaryReg.registry.create("acme")
    const middle = middleReg.registry.createReplica("acme")
    const tail = tailReg.registry.createReplica("acme")

    primary.write((db) => db.exec("create table t (id integer primary key, v text)"))
    primary.write((db) => db.run("insert into t (v) values ('chained')"))
    ship(primary, middle)
    expect(middle.log.lastTxid).toBe(primary.log.lastTxid)

    // The middle node's log is the source for the one behind it.
    ship(middle, tail)
    expect(tail.txid).toBe(primary.txid)
    expect(tail.checksum).toBe(primary.checksum)
    expect(tail.readSync((db) => db.prepare("select v from t").get())).toEqual({ v: "chained" })

    primaryReg.registry.close()
    middleReg.registry.close()
    tailReg.registry.close()
  })

  test("the role survives a close and reopen, and openReplica converts a primary", async () => {
    const { dir, registry: reg } = registry()
    const replica = reg.createReplica("acme")
    expect(reg.catalog.getTenant("acme")?.role).toBe("replica")
    reg.close()

    const again = TenantRegistry.open({ dir })
    expect(again.open("acme").isReplica).toBe(true)
    again.close()

    // A node that used to own a database and is now a replica of it must stop authoring.
    const converted = registry()
    await converted.registry.create("acme")
    expect(converted.registry.open("acme").isReplica).toBe(false)
    expect(converted.registry.openReplica("acme").isReplica).toBe(true)
    expect(converted.registry.catalog.getTenant("acme")?.role).toBe("replica")
    converted.registry.close()
    void replica
  })

  test("installSnapshot swaps the file in and reopens at the snapshot's position", async () => {
    const primaryReg = registry()
    const replicaReg = registry()
    const primary = await primaryReg.registry.create("acme")
    primary.write((db) => db.exec("create table t (id integer primary key, v text)"))
    for (let i = 0; i < 5; i++) {
      primary.write((db) => db.run("insert into t (v) values (?)", [`v${i}`]))
    }
    const ref = await primary.snapshot()

    const replica = replicaReg.registry.createReplica("acme")
    // A record the replica must forget: the snapshot supersedes everything it holds.
    expect(replica.txid).toBe(0n)
    const staging = path.join(replicaReg.dir, "incoming.db")
    fs.copyFileSync(ref.path, staging)

    const installed = replicaReg.registry.installSnapshot("acme", {
      file: staging,
      txid: BigInt(ref.txid),
      epoch: ref.epoch,
      checksum: BigInt(ref.checksum),
      pages: ref.pages,
      pageSize: ref.pageSize,
    })
    expect(fs.existsSync(staging)).toBe(false)
    expect(installed.txid).toBe(primary.txid)
    expect(installed.checksum).toBe(primary.checksum)
    expect(installed.readSync((db) => db.prepare("select count(*) c from t").get())).toEqual({
      c: 5,
    })
    // The old log went with the old file: keeping records that no longer connect would leave a
    // log that cannot be replayed onto its own database.
    expect(installed.log.lastTxid).toBe(0n)

    primary.write((db) => db.run("insert into t (v) values ('after')"))
    ship(primary, installed)
    expect(installed.txid).toBe(primary.txid)
    expect(installed.checksum).toBe(primary.checksum)

    primaryReg.registry.close()
    replicaReg.registry.close()
  })

  test("a record that does not follow is refused and nothing is written", async () => {
    const primaryReg = registry()
    const replicaReg = registry()
    const primary = await primaryReg.registry.create("acme")
    const replica = replicaReg.registry.createReplica("acme")
    primary.write((db) => db.exec("create table t (id integer primary key)"))
    primary.write((db) => db.run("insert into t default values"))

    // Skipping txid 1 leaves the replica exactly where it was.
    const second = primary.log.read(2n) as TxnRecord
    expect(() => replica.applyRecord(second, encode(second))).toThrow()
    expect(replica.txid).toBe(0n)
    expect(replica.checksum).toBe(0n)

    // And the right record still applies afterwards.
    const first = primary.log.read(1n) as TxnRecord
    replica.applyRecord(first, encode(first))
    expect(replica.txid).toBe(1n)

    primaryReg.registry.close()
    replicaReg.registry.close()
  })

  test("a replica restarts from meta.json, not from the file", async () => {
    const primaryReg = registry()
    const replicaReg = registry()
    const primary = await primaryReg.registry.create("acme")
    let replica = replicaReg.registry.createReplica("acme")
    primary.write((db) => db.exec("create table t (id integer primary key, v text)"))
    primary.write((db) => db.run("insert into t (v) values ('before')"))
    ship(primary, replica)
    const at = replica.txid

    replicaReg.registry.release("acme")
    expect(fs.existsSync(path.join(tenantDir(replicaReg.dir, "acme"), "meta.json"))).toBe(true)
    replica = replicaReg.registry.openReplica("acme")
    expect(replica.txid).toBe(at)
    expect(replica.checksum).toBe(primary.checksum)

    primary.write((db) => db.run("insert into t (v) values ('after')"))
    ship(primary, replica)
    expect(replica.txid).toBe(primary.txid)
    expect(replica.readSync((db) => db.prepare("select count(*) c from t").get())).toEqual({ c: 2 })

    primaryReg.registry.close()
    replicaReg.registry.close()
  })
})
