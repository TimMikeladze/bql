// A real three-worker primary with a real replica attached (`docs/c4b-replication-workers.md`).
//
// The point of every case is the *boundary*: one replication socket, held by the router, carrying
// two databases that live on two different worker threads. The oracle throughout is the rolling
// checksum — a replica fed through the channel has to land byte for byte on what the primary holds
// — because a C4b bug can then only produce a replica that never converges, never a silently wrong
// one.
//
// Nothing here reaches for `primary.handle.registry`: on a router that would open a tenant on the
// thread whose whole design is to own none. The primary is read over HTTP, which is also what an
// operator has.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { shardOf } from "../../src/server/workers/shard.ts"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  until,
  untilFollowing,
  untilTxid,
  type Node,
} from "../replication/harness.ts"

const WORKERS = 3
const SCHEMA = "create table t (id integer primary key, v text)"

/** Two names on two different workers, so every case below actually crosses a shard boundary. */
const NAMES: string[] = []
for (let i = 0; NAMES.length < 2 && i < 500; i++) {
  const name = `acme${i}`
  if (!NAMES.some((one) => shardOf(one, WORKERS) === shardOf(name, WORKERS))) NAMES.push(name)
}
const [LEFT, RIGHT] = NAMES as [string, string]

let open: { close(): Promise<void> }[] = []

function track<T extends { close(): Promise<void> }>(thing: T): T {
  open.push(thing)
  return thing
}

afterAll(stopAll)

afterEach(async () => {
  const current = open
  open = []
  for (const thing of current.reverse()) {
    try {
      await thing.close()
    } catch {
      // A node a test already closed.
    }
  }
})

/** A three-worker primary that serves `/v1/replication`. */
function startShardedPrimary(heartbeatMs = 100): Promise<Node> {
  return startPrimary({ server: { workers: WORKERS }, replication: { heartbeatMs } })
}

interface Stats {
  txid: number
  checksum: string
}

/** The primary's own view of a database, over HTTP, because the router holds no tenant. */
async function statsOver(node: Node, db: string): Promise<Stats> {
  return await node.json<Stats>(`/v1/db/${db}`)
}

/** Waits until `replica` holds exactly what `primary` holds for `db`, checksum included. */
async function untilMatched(primary: Node, replica: Node, db: string): Promise<void> {
  await untilFollowing(replica, db)
  const at = await statsOver(primary, db)
  await untilTxid(replica, db, at.txid)
  const here = await statsOver(replica, db)
  expect(here.txid).toBe(at.txid)
  expect(here.checksum).toBe(at.checksum)
}

describe("a sharded primary serves replicas", () => {
  test("it starts at all, which is the refusal C4b lifted", async () => {
    const primary = track(await startShardedPrimary())
    expect(primary.handle.workers).toBe(WORKERS)
    expect(primary.handle.config.replication.secret).not.toBe("")
    // The router owns the socket and no `ReplicationServer`; the workers hold the streams.
    expect(primary.handle.runtime.replication).toBeNull()
    expect(primary.handle.runtime.replicationMode).toBe("none")
  })

  test("two databases on two workers stream down one socket and both converge", async () => {
    const primary = track(await startShardedPrimary())
    expect(shardOf(LEFT, WORKERS)).not.toBe(shardOf(RIGHT, WORKERS))
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = track(await startReplica(primary))

    for (const db of [LEFT, RIGHT]) {
      for (let i = 0; i < 5; i++) await query(primary, db, "insert into t (v) values (?)", [`${db}-${i}`])
      await untilMatched(primary, replica, db)
      const rows = await query(replica, db, "select v from t order by id")
      expect(rows.rows.length).toBe(5)
      expect(rows.rows[0]).toEqual([`${db}-0`])
    }
  })

  test("the primary reports the replica on the worker that owns each database", async () => {
    const primary = track(await startShardedPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = track(await startReplica(primary, { node: "r-one" }))
    await untilMatched(primary, replica, LEFT)
    await untilMatched(primary, replica, RIGHT)

    for (const db of [LEFT, RIGHT]) {
      const view = await primary.json<{ replicas: { node: string }[] }>(`/v1/db/${db}/replication`)
      expect(view.replicas.map((one) => one.node)).toContain("r-one")
    }
  })

  test("a database created on a shard reaches a follow-everything replica without a heartbeat", async () => {
    // A heartbeat far outside the test's patience: if the announcement only rode the tick, this
    // would time out. It is the whole test of `repl.announce`.
    const primary = track(await startShardedPrimary(60_000))
    const replica = track(await startReplica(primary))
    await createDb(primary, LEFT, SCHEMA)
    await untilFollowing(replica, LEFT, 5000)
    const written = await query(primary, LEFT, "insert into t (v) values ('new')")
    await untilTxid(replica, LEFT, written.txid, 5000)
  })

  test("ack: replica is honoured on the worker that owns the database (R2)", async () => {
    // The `ACK` frame arrives at the router and is routed by its stream id to the worker that owns
    // the database — which is where the `AckTracker` and the write that is waiting on it both are.
    // A sharded node could not answer this level at all before C4b.
    const primary = track(await startShardedPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = track(await startReplica(primary))
    await untilMatched(primary, replica, LEFT)
    await untilMatched(primary, replica, RIGHT)

    for (const db of [LEFT, RIGHT]) {
      const response = await primary.fetch(`/v1/db/${db}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t (v) values ('acked')", ack: "replica" }),
      })
      expect(response.status).toBe(200)
      const written = (await response.json()) as { txid: number }
      // The answer is the proof: the replica had it before the write was answered.
      const here = await statsOver(replica, db)
      expect(here.txid).toBeGreaterThanOrEqual(written.txid)
    }
  })

  test("/metrics on the router reports replication from both halves", async () => {
    const primary = track(await startShardedPrimary())
    await createDb(primary, LEFT, SCHEMA)
    const replica = track(await startReplica(primary))
    await untilMatched(primary, replica, LEFT)
    await query(primary, LEFT, "insert into t (v) values ('metric')")
    await untilMatched(primary, replica, LEFT)

    const body = await (await primary.fetch("/metrics")).text()
    // `connected` is the router's: it owns every socket. `records` is summed from the workers,
    // which are the threads that emit a `TXN`. `docs/c4b-replication-workers.md` §7.
    expect(body).toMatch(/bql_replication_connected\{[^}]*\} 1/)
    expect(body).toMatch(/bql_replication_bytes_total\{[^}]*\} [1-9]/)
    expect(body).toMatch(/bql_replication_records_total\{[^}]*\} [1-9]/)
  })
})

describe("the scenarios C5 exercised by hand", () => {
  test("a replica killed mid-stream catches up when it comes back", async () => {
    const primary = track(await startShardedPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = await startReplica(primary)
    open.push(replica)
    await untilMatched(primary, replica, LEFT)
    await untilMatched(primary, replica, RIGHT)

    await replica.close()
    open = open.filter((one) => one !== replica)
    // Writes on *both* shards while it is away, so the catch-up crosses the boundary too.
    for (let i = 0; i < 4; i++) {
      await query(primary, LEFT, "insert into t (v) values (?)", [`gone-${i}`])
      await query(primary, RIGHT, "insert into t (v) values (?)", [`gone-${i}`])
    }

    const back = track(await startReplica(primary, { dir: replica.dir }))
    for (const db of [LEFT, RIGHT]) {
      await untilMatched(primary, back, db)
      const rows = await query(back, db, "select count(*) as n from t")
      expect(rows.rows).toEqual([[4]])
    }
    // A resume, not a re-bootstrap.
    expect(back.handle.runtime.replica?.status().lastError).toBeNull()
  })

  test("a replica whose file diverged fails loudly and re-snapshots", async () => {
    const primary = track(await startShardedPrimary())
    await createDb(primary, LEFT, SCHEMA)
    const replica = await startReplica(primary)
    open.push(replica)
    await query(primary, LEFT, "insert into t (v) values ('real')")
    await untilMatched(primary, replica, LEFT)

    await replica.close()
    open = open.filter((one) => one !== replica)
    // Rewrite the checksum the applier trusts over everything else: the copy now claims a state
    // the primary never produced, which is what bit rot looks like from the primary's side.
    const { tenantDir } = await import("../../src/tenant/tenant.ts")
    const metaPath = `${tenantDir(replica.dir, LEFT)}/meta.json`
    const meta = JSON.parse(await Bun.file(metaPath).text()) as Record<string, unknown>
    meta.postChecksum = "1311768467463790320"
    await Bun.write(metaPath, JSON.stringify(meta))

    const more = await query(primary, LEFT, "insert into t (v) values ('second')")
    const back = track(await startReplica(primary, { dir: replica.dir }))
    await untilTxid(back, LEFT, more.txid)
    expect(back.handle.runtime.replica?.status().lastError).toContain("DIVERGED")
    expect((await query(back, LEFT, "select v from t order by id")).rows).toEqual([
      ["real"],
      ["second"],
    ])
    const [here, there] = await Promise.all([statsOver(back, LEFT), statsOver(primary, LEFT)])
    expect(here.checksum).toBe(there.checksum)
  })

  test("the socket closing unpins the tenant on every worker it touched", async () => {
    const primary = track(await startShardedPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = await startReplica(primary)
    open.push(replica)
    await untilMatched(primary, replica, LEFT)
    await untilMatched(primary, replica, RIGHT)
    for (const db of [LEFT, RIGHT]) {
      const view = await primary.json<{ replicas: unknown[] }>(`/v1/db/${db}/replication`)
      expect(view.replicas.length).toBe(1)
    }

    await replica.close()
    open = open.filter((one) => one !== replica)
    // `repl.gone` reaches both workers, each ends its own stream and unpins its own tenant.
    for (const db of [LEFT, RIGHT]) {
      await until(async () => {
        const view = await primary.json<{ replicas: unknown[] }>(`/v1/db/${db}/replication`)
        return view.replicas.length === 0
      }, `the replica to be gone from ${db}`)
    }
  })
})
