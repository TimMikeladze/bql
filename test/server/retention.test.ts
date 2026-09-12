// The retention sweep as the server actually runs it. `[durability] retention` governs the log and
// the snapshots as well as the trash now (`docs/r6-retention.md`); before this, `TxnLog.retain` and
// `removeSnapshot` were dead code and a busy node's log grew for ever.
//
// The two claims worth an end-to-end test: the sweep bounds a log without making the database
// unrestorable to a point inside the window, and a replica that is connected and behind holds the
// records it still needs while the same replica gone does not.

import { afterAll, describe, expect, test } from "bun:test"
import { slowestReplicaTxid } from "../../src/server/runtime.ts"
import {
  createDb,
  query,
  silentReplica,
  startPrimary,
  stopAll as stopReplicationNodes,
  until,
} from "../replication/harness.ts"
import { startTestServer, stopAll } from "./harness.ts"

const SCHEMA = "create table t (id integer primary key, v text)"

afterAll(async () => {
  await stopAll()
  await stopReplicationNodes()
})

describe("slowestReplicaTxid", () => {
  test("is the lowest acked position on the wire, and null when nothing is following", () => {
    const view = (node: string, txid: number) => ({
      node,
      stream: 1,
      txid,
      lag: 0,
      ackedAtMs: 0,
      fsynced: true,
    })
    expect(slowestReplicaTxid([view("a", 90), view("b", 12), view("c", 40)])).toBe(12n)
    expect(slowestReplicaTxid([view("a", 90)])).toBe(90n)
    // Nobody is following, so nothing holds the log; a replica that has gone is re-snapshotted.
    expect(slowestReplicaTxid([])).toBeNull()
  })
})

describe("the server's retention sweep", () => {
  test("bounds an open database's log and leaves it restorable inside the window", async () => {
    const server = await startTestServer({
      // A segment per transaction, so a few dozen writes give retention something to choose from.
      durability: { retention: "50ms", sweepIntervalMs: 20, segmentBytes: 1 },
    })
    try {
      await server.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
      const run = (sql: string) =>
        server.fetch("/v1/db/acme/query", { method: "POST", body: JSON.stringify({ sql }) })
      await run(SCHEMA)
      for (let i = 0; i < 8; i++) await run(`insert into t(v) values ('a${i}')`)

      // The PITR base. Everything below it is what the sweep is free to take.
      const snap = await server.json<{ txid: number }>("/v1/db/acme/snapshot", { method: "POST" })
      expect(snap.txid).toBe(9)

      for (let i = 0; i < 3; i++) await run(`insert into t(v) values ('b${i}')`)
      await Bun.sleep(20)
      const mark = new Date().toISOString()
      await Bun.sleep(20)
      for (let i = 0; i < 9; i++) await run(`insert into t(v) values ('c${i}')`)

      const tenant = server.handle.registry.open("acme")
      const before = tenant.log.bytes
      expect(tenant.log.firstTxid).toBe(1n)

      // The timer, not a hand-driven sweep: the bug was that nothing ever called `retain`.
      await until(() => tenant.log.firstTxid === 9n, "the sweep to bound the log")
      expect(tenant.log.bytes).toBeLessThan(before)
      // The floor is the snapshot, and the snapshot is kept however old it is.
      const stats = await server.json<{ lastSnapshotTxid: number }>("/v1/db/acme")
      expect(stats.lastSnapshotTxid).toBe(9)
      // The newest records are never dropped, whatever the age bound says.
      expect(tenant.log.lastTxid).toBe(21n)

      // And the assertion the whole floor exists for: a point in time inside the window still
      // restores, with exactly the rows that point had. Txid 1 is the schema; every txid after it
      // is one row.
      const restored = await server.json<{ name: string; at: number }>("/v1/db/acme/restore", {
        method: "POST",
        body: JSON.stringify({ at: mark, into: "acme-pitr" }),
      })
      expect(restored.at).toBeGreaterThanOrEqual(12)
      expect(restored.at).toBeLessThan(21)
      const rows = await server.json<{ rows: unknown[][] }>("/v1/db/acme-pitr/query", {
        method: "POST",
        body: JSON.stringify({ sql: "select count(*) c from t" }),
      })
      expect(rows.rows[0]?.[0]).toBe(restored.at - 1)
    } finally {
      await server.close()
    }
  })

  test("a connected replica holds the log; the same replica gone does not", async () => {
    // The sweep is driven by hand here: what is under test is the floor, not the timer.
    const primary = await startPrimary({
      durability: { retention: "50ms", sweepIntervalMs: 0, segmentBytes: 1 },
    })
    try {
      await createDb(primary, "acme", SCHEMA)
      for (let i = 0; i < 9; i++) await query(primary, "acme", `insert into t(v) values ('a${i}')`)

      const tenant = primary.handle.registry.open("acme")
      const attached = tenant.txid
      expect(attached).toBe(10n)

      // A replica that subscribes here and then never acks: it is on the wire and it is behind.
      const replica = await silentReplica(primary, "acme")
      for (let i = 0; i < 9; i++) await query(primary, "acme", `insert into t(v) values ('b${i}')`)
      await Bun.sleep(60)

      primary.handle.runtime.retainTenant(tenant, 50)
      expect(tenant.log.firstTxid).toBe(attached)

      // Gone. Nothing holds the log now — a replica beyond the window is re-snapshotted when it
      // comes back — so the retention takes it down to the segment still being appended to.
      await replica.close()
      await until(
        () => (primary.handle.runtime.replication?.replicasOf("acme").length ?? 0) === 0,
        "the silent replica to drop off",
      )
      primary.handle.runtime.retainTenant(tenant, 50)
      expect(tenant.log.firstTxid).toBe(tenant.log.lastTxid)
    } finally {
      await primary.close()
    }
  })
})
