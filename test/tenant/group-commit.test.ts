// `writeQueued` folds concurrent writes into one transaction. The fold is only allowed to change
// two things a caller can see — the txid they share, and the fact that they are durable together.
// Everything else has to be indistinguishable from having run alone, which is what this asserts.

import { afterAll, describe, expect, test } from "bun:test"
import { TenantRegistry } from "../../src/tenant/index.ts"
import { strictestAck } from "../../src/tenant/tenant.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

async function tenantWith(options: Record<string, unknown> = {}) {
  const reg = TenantRegistry.open({ dir: tempDir(), ...options })
  const tenant = await reg.create("acme")
  tenant.write((db) => db.exec("create table t(id integer primary key, v text unique)"))
  return { reg, tenant }
}

describe("group commit", () => {
  test("writes issued in one turn commit as one transaction", async () => {
    const { reg, tenant } = await tenantWith()
    const before = tenant.txid

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tenant.writeQueued((db) => db.run("insert into t(v) values (?)", [`v${i}`])),
      ),
    )

    // One transaction: one txid for all of them, and the tenant advanced by exactly one.
    const txids = new Set(results.map((r) => r.txid))
    expect(txids.size).toBe(1)
    expect(tenant.txid).toBe(before + 1n)

    // And each caller still got its own result.
    const rowids = results.map((r) => r.result.lastInsertRowid)
    expect(new Set(rowids).size).toBe(20)
    expect(await tenant.read((db) => db.prepare("select count(*) c from t").get())).toEqual({
      c: 20,
    })
    reg.close()
  })

  test("one failing statement rejects only itself; its neighbours commit", async () => {
    const { reg, tenant } = await tenantWith()
    tenant.write((db) => db.run("insert into t(v) values ('taken')"))

    const settled = await Promise.allSettled([
      tenant.writeQueued((db) => db.run("insert into t(v) values ('a')")),
      // Violates the unique index, so it rolls the whole batch back — and then the batch is
      // re-run one at a time, which is how the other three still land.
      tenant.writeQueued((db) => db.run("insert into t(v) values ('taken')")),
      tenant.writeQueued((db) => db.run("insert into t(v) values ('b')")),
      tenant.writeQueued((db) => db.run("insert into t(v) values ('c')")),
    ])

    expect(settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ])
    const rows = await tenant.read((db) =>
      db.prepare("select v from t order by v").values().flat(),
    )
    expect(rows).toEqual(["a", "b", "c", "taken"])
    reg.close()
  })

  test("a fold is answered at the strictest durability anyone asked for", () => {
    expect(strictestAck(["local", "local"])).toBe("local")
    expect(strictestAck(["local", "fsync", "local"])).toBe("fsync")
    expect(strictestAck(["fsync", "quorum"])).toBe("quorum")
    expect(strictestAck(["replica", "fsync"])).toBe("replica")
    expect(strictestAck([])).toBe("local")
  })

  test("the fold is capped, and the rest go in the next transaction", async () => {
    const { reg, tenant } = await tenantWith({ maxGroupCommit: 4 })
    const before = tenant.txid
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        tenant.writeQueued((db) => db.run("insert into t(v) values (?)", [`v${i}`])),
      ),
    )
    // 10 statements, 4 to a transaction: three transactions.
    expect(new Set(results.map((r) => r.txid)).size).toBe(3)
    expect(tenant.txid).toBe(before + 3n)
    reg.close()
  })

  test("a lone write is not delayed waiting for company", async () => {
    const { reg, tenant } = await tenantWith()
    const before = tenant.txid
    const one = await tenant.writeQueued((db) => db.run("insert into t(v) values ('alone')"))
    expect(one.txid).toBe(before + 1n)
    reg.close()
  })

  test("a baton transaction refuses a queued write rather than parking it", async () => {
    const { reg, tenant } = await tenantWith()
    tenant.txBegin()
    // The documented answer is 409 TX_BUSY, immediately — not a wait of up to txIdleTimeoutMs.
    await expect(tenant.writeQueued((db) => db.run("insert into t(v) values ('x')"))).rejects.toThrow(
      /TX_BUSY|transaction/i,
    )
    tenant.txRollback()
    // And the writer works again afterwards.
    const after = await tenant.writeQueued((db) => db.run("insert into t(v) values ('y')"))
    expect(after.txid).toBeGreaterThan(0n)
    reg.close()
  })

  test("a snapshot parks a queued write rather than refusing it", async () => {
    // The opposite of the baton case above, and for the opposite reason: a snapshot is bounded —
    // a TRUNCATE checkpoint and a reflink — and it is often the *node's own* housekeeping, since
    // `ServerRuntime.maybeSnapshot` takes one from the retention sweep. A 503 there is a refusal
    // the node inflicted on a client that did nothing unusual.
    const { reg, tenant } = await tenantWith()
    const before = tenant.txid
    const snapshotting = tenant.snapshot()
    const queued = tenant.writeQueued((db) => db.run("insert into t(v) values ('during')"))
    const ref = await snapshotting
    const written = await queued
    expect(written.txid).toBe(before + 1n)
    // The snapshot is of the state *before* the parked write, which is the point of parking it
    // rather than folding it in.
    expect(BigInt(ref.txid)).toBe(before)
    expect(tenant.readSync((db) => db.prepare("select count(*) c from t").get())).toEqual({ c: 1 })
    reg.close()
  })

  test("closing rejects what is still queued instead of leaving it pending", async () => {
    const { reg, tenant } = await tenantWith()
    const pending = tenant.writeQueued((db) => db.run("insert into t(v) values ('z')"))
    tenant.close()
    await expect(pending).rejects.toThrow(/closed/i)
    reg.close()
  })

  test("the change feed sees one commit carrying every folded statement", async () => {
    const { reg, tenant } = await tenantWith()
    const commits: bigint[] = []
    tenant.onCommit((event) => commits.push(event.txid))
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        tenant.writeQueued((db) => db.run("insert into t(v) values (?)", [`c${i}`])),
      ),
    )
    expect(commits).toHaveLength(1)
    reg.close()
  })
})
