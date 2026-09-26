// A real three-worker replica following a real primary (`docs/c4c-replication-follow.md`).
//
// The point of every case is the *boundary*: one upstream socket, held by the router, feeding two
// databases that live on two different worker threads. The oracle throughout is the rolling
// checksum — a replica whose streams are spread over N workers has to land byte for byte on what
// the primary holds — because a C4c bug can then only produce a replica that never converges,
// never a silently wrong one.
//
// Nothing here reaches for `replica.handle.registry` to read a tenant: on a router that would open
// a database on the thread whose whole design is to own none. Both nodes are read over HTTP, which
// is also what an operator has.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { shardOf } from "../../src/server/workers/shard.ts"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  until,
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

/** A three-worker replica of `primary`. */
function startShardedReplica(primary: Node, options: { dir?: string } = {}): Promise<Node> {
  return startReplica(primary, {
    ...(options.dir ? { dir: options.dir } : {}),
    overrides: { server: { workers: WORKERS } },
  })
}

interface Stats {
  txid: number
  checksum: string
}

/** A node's own view of a database, over HTTP, because a router holds no tenant. */
async function statsOver(node: Node, db: string): Promise<Stats> {
  return await node.json<Stats>(`/v1/db/${db}`)
}

/** Waits until `replica` holds exactly what `primary` holds for `db`, checksum included. */
async function untilMatched(primary: Node, replica: Node, db: string): Promise<void> {
  const at = await statsOver(primary, db)
  await until(
    async () => {
      const response = await replica.fetch(`/v1/db/${db}`)
      if (!response.ok) return false
      return ((await response.json()) as Stats).txid >= at.txid
    },
    `the replica to reach ${db}@${at.txid}`,
  )
  const here = await statsOver(replica, db)
  expect(here.txid).toBe(at.txid)
  expect(here.checksum).toBe(at.checksum)
}

interface ReplicationView {
  role: string
  connected: boolean
  primary: string
  applied: number
  lagTxid: number
  bootstrapping: boolean
}

describe("a sharded replica follows an upstream", () => {
  test("it starts at all, which is the refusal C4c lifted", async () => {
    const primary = track(await startPrimary())
    const replica = track(await startShardedReplica(primary))
    expect(replica.handle.workers).toBe(WORKERS)
    expect(replica.handle.config.replication.role).toBe("replica")
    // The router holds the one client, in `"routed"` mode; the workers hold the streams.
    expect(replica.handle.runtime.replica?.mode).toBe("routed")
    expect(replica.handle.runtime.replicationMode).toBe("none")
  })

  test("two databases on two workers stream down one socket and both converge", async () => {
    const primary = track(await startPrimary())
    expect(shardOf(LEFT, WORKERS)).not.toBe(shardOf(RIGHT, WORKERS))
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = track(await startShardedReplica(primary))

    for (const db of [LEFT, RIGHT]) {
      for (let i = 0; i < 5; i++) {
        await query(primary, db, "insert into t (v) values (?)", [`${db}-${i}`])
      }
      await untilMatched(primary, replica, db)
      const rows = await query(replica, db, "select v from t order by id")
      expect(rows.rows.length).toBe(5)
      expect(rows.rows[0]).toEqual([`${db}-0`])
    }
  })

  test("a database created after the replica attached is picked up on its own shard", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    const replica = track(await startShardedReplica(primary))
    await untilMatched(primary, replica, LEFT)

    await createDb(primary, RIGHT, SCHEMA)
    await query(primary, RIGHT, "insert into t (v) values ('late')")
    await untilMatched(primary, replica, RIGHT)
    const rows = await query(replica, RIGHT, "select v from t")
    expect(rows.rows).toEqual([["late"]])
  })

  test("GET /v1/db/{db}/replication reports each shard's stream beside the shared connection", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = track(await startShardedReplica(primary))
    for (const db of [LEFT, RIGHT]) {
      await query(primary, db, "insert into t (v) values ('x')")
      await untilMatched(primary, replica, db)
    }

    for (const db of [LEFT, RIGHT]) {
      const view = await replica.json<ReplicationView>(`/v1/db/${db}/replication`)
      expect(view.role).toBe("replica")
      // The stream half is the worker's own; the connection half was pushed down to it.
      expect(view.applied).toBeGreaterThan(0)
      expect(view.bootstrapping).toBe(false)
      expect(view.connected).toBe(true)
      expect(view.primary).toBe(primary.replicationUrl)
    }
  })

  test("readyz is one fact, and it is the router's", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    const replica = track(await startShardedReplica(primary))
    await untilMatched(primary, replica, LEFT)
    expect((await replica.fetch("/readyz")).status).toBe(200)

    await primary.close()
    await until(
      async () => (await replica.fetch("/readyz")).status === 503,
      "the replica to report itself not ready",
    )
  })

  test("a replica restarted mid-stream resumes from its own positions on both shards", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    let replica = track(await startShardedReplica(primary))
    for (const db of [LEFT, RIGHT]) {
      await query(primary, db, "insert into t (v) values ('before')")
      await untilMatched(primary, replica, db)
    }
    const dir = replica.dir
    await replica.close()

    for (const db of [LEFT, RIGHT]) {
      for (let i = 0; i < 4; i++) await query(primary, db, "insert into t (v) values (?)", [`after-${i}`])
    }
    replica = track(await startShardedReplica(primary, { dir }))
    for (const db of [LEFT, RIGHT]) {
      await untilMatched(primary, replica, db)
      const rows = await query(replica, db, "select count(*) from t")
      expect(rows.rows[0]).toEqual([5])
    }
  })

  test("R2 forwards a write from a worker over the one upstream socket", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    const replica = track(await startShardedReplica(primary))
    await untilMatched(primary, replica, LEFT)

    // The write cannot be taken here, so the shard hands it to the router, which owns the socket.
    const written = await query(replica, LEFT, "insert into t (v) values ('forwarded')")
    expect(written.rowsAffected).toBe(1)
    await untilMatched(primary, replica, LEFT)
    const rows = await query(replica, LEFT, "select v from t")
    expect(rows.rows).toEqual([["forwarded"]])
  })

  test("R7 drops a database deleted upstream and trashes the copy on the worker that owned it", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = track(await startShardedReplica(primary))
    for (const db of [LEFT, RIGHT]) {
      await query(primary, db, "insert into t (v) values ('x')")
      await untilMatched(primary, replica, db)
    }

    expect((await primary.fetch(`/v1/db/${LEFT}`, { method: "DELETE" })).status).toBe(200)
    await until(
      async () => (await replica.fetch(`/v1/db/${LEFT}`)).status === 404,
      `the replica to let go of ${LEFT}`,
    )
    // The trash path comes back from the worker that held the copy, one hop later.
    await until(() => {
      const dropped = replica.handle.runtime.replica?.status().unfollowed ?? []
      return dropped.some((one) => one.db === LEFT && one.trash !== null)
    }, "the worker to report where the copy went")
    // The other shard is untouched.
    await untilMatched(primary, replica, RIGHT)
  })

  test("a database re-created upstream under the same name is bootstrapped again", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await query(primary, LEFT, "insert into t (v) values ('first')")
    const replica = track(await startShardedReplica(primary))
    await untilMatched(primary, replica, LEFT)

    expect((await primary.fetch(`/v1/db/${LEFT}`, { method: "DELETE" })).status).toBe(200)
    await createDb(primary, LEFT, SCHEMA)
    await query(primary, LEFT, "insert into t (v) values ('second')")

    await until(async () => {
      const response = await replica.fetch(`/v1/db/${LEFT}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "select v from t" }),
      })
      if (!response.ok) return false
      const body = (await response.json()) as { rows: unknown[][] }
      return body.rows.length === 1 && body.rows[0]?.[0] === "second"
    }, `${LEFT} to be re-bootstrapped from the new generation`)
    await untilMatched(primary, replica, LEFT)
  })

  test("/metrics on the router counts the socket itself and sums the workers' applies", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, LEFT, SCHEMA)
    await createDb(primary, RIGHT, SCHEMA)
    const replica = track(await startShardedReplica(primary))
    // Both bootstraps finish *before* the writes, so each write is a `TXN` on its own shard rather
    // than a row that happened to be inside a snapshot — which is what makes the sum exact.
    for (const db of [LEFT, RIGHT]) await untilMatched(primary, replica, db)
    for (const db of [LEFT, RIGHT]) await query(primary, db, "insert into t (v) values ('x')")
    for (const db of [LEFT, RIGHT]) await untilMatched(primary, replica, db)

    const body = await (await replica.fetch("/metrics")).text()
    const value = (name: string): number =>
      Number(new RegExp(`^${name}\\{[^}]*\\} (\\d+)$`, "m").exec(body)?.[1] ?? "-1")
    // The router reads every byte off the one socket, so it counts both itself.
    expect(value("bql_replication_connected")).toBe(1)
    expect(value("bql_replication_bytes_total")).toBeGreaterThan(0)
    // A record is applied by exactly one worker, so this is a sum across two shards.
    expect(value("bql_replication_records_total")).toBeGreaterThanOrEqual(2)
  })
})
