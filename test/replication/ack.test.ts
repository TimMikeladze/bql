// R2's durability levels (design §5.4): `ack: "replica"` and `ack: "quorum"` hold the answer back
// until enough replicas have the record, `ACK_TIMEOUT` says the transaction committed anyway, and
// a node with no replicas refuses rather than quietly downgrading the promise.
//
// The ack path is a race by nature, so nothing here sleeps for an outcome: a test that wants a
// timeout attaches a replica that never acks, rather than hoping a real one is slow enough.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HEADERS } from "../../src/client/protocol.ts"
import { AckTracker } from "../../src/replication/ack.ts"
import {
  createDb,
  query,
  startCluster,
  startPrimary,
  silentReplica,
  startReplica,
  stopAll,
  untilSynced,
  type Node,
} from "./harness.ts"

const SCHEMA = "create table t (id integer primary key, v text)"

let open: { close(): Promise<void> }[] = []

function track<T extends { close(): Promise<void> }>(thing: T): T {
  open.push(thing)
  return thing
}

afterEach(async () => {
  const current = open
  open = []
  for (const thing of current.reverse()) {
    try {
      await thing.close()
    } catch {
      // Already closed by the test itself.
    }
  }
})

afterAll(stopAll)

interface ErrorBody {
  error: { code: string; message: string; txid?: number; acks?: number; needed?: number }
}

async function write(
  node: Node,
  db: string,
  sql: string,
  init: { ack?: string; header?: string } = {},
): Promise<Response> {
  return await node.fetch(`/v1/db/${db}/query`, {
    method: "POST",
    ...(init.header ? { headers: { [HEADERS.ack]: init.header } } : {}),
    body: JSON.stringify({ sql, ...(init.ack ? { ack: init.ack } : {}) }),
  })
}

describe("ack levels", () => {
  test("a write with ack: replica is answered once the replica has it", async () => {
    const cluster = track(await startCluster(1))
    const [replica] = cluster.replicas as [Node]
    await createDb(cluster.primary, "acme", SCHEMA)
    await untilSynced(cluster.primary, replica, "acme")

    const response = await write(cluster.primary, "acme", "insert into t (v) values ('a')", {
      ack: "replica",
    })
    expect(response.status).toBe(200)
    const txid = ((await response.json()) as { txid: number }).txid
    // The answer is the proof: the replica acked at or past this txid before it was sent.
    expect(Number(replica.handle.registry.open("acme").txid)).toBeGreaterThanOrEqual(txid)
  })

  test("the BunQL-Ack header and durability.defaultAck mean the same thing", async () => {
    // `defaultAck: "replica"` applies to every write on the node, the schema included, so the
    // replica has to be attached before there is anything to create.
    const primary = track(await startPrimary({ durability: { defaultAck: "replica" } }))
    const replica = track(await startReplica(primary))
    await createDb(primary, "acme")
    await untilSynced(primary, replica, "acme")
    await query(primary, "acme", SCHEMA)

    const byHeader = await write(primary, "acme", "insert into t (v) values ('h')", {
      header: "replica",
    })
    expect(byHeader.status).toBe(200)
    // Nothing asked for a level here, so `defaultAck` is what applies — and it is `replica`.
    const byDefault = await write(primary, "acme", "insert into t (v) values ('d')")
    expect(byDefault.status).toBe(200)
    const at = ((await byDefault.json()) as { txid: number }).txid
    expect(Number(replica.handle.registry.open("acme").txid)).toBeGreaterThanOrEqual(at)
  })

  test("a quorum of one primary and two replicas needs one replica ack", async () => {
    const cluster = track(await startCluster(2))
    await createDb(cluster.primary, "acme", SCHEMA)
    for (const replica of cluster.replicas) await untilSynced(cluster.primary, replica, "acme")

    const response = await write(cluster.primary, "acme", "insert into t (v) values ('q')", {
      ack: "quorum",
    })
    expect(response.status).toBe(200)
    const tracker = cluster.primary.handle.runtime.acks
    expect(tracker.replicaCount("acme")).toBe(2)
    expect(tracker.needed("acme", "quorum")).toBe(1)
  })

  test("a node with no replicas refuses ack: replica with NO_REPLICAS and writes nothing", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const before = (await query(primary, "acme", "select count(*) as n from t")).rows[0] as number[]

    const response = await write(primary, "acme", "insert into t (v) values ('no')", {
      ack: "replica",
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as ErrorBody).error.code).toBe("NO_REPLICAS")
    const after = (await query(primary, "acme", "select count(*) as n from t")).rows[0] as number[]
    expect(after[0]).toBe(before[0] as number)
  })

  test("ackWithoutReplicas: allow answers locally instead", async () => {
    const primary = track(
      await startPrimary({ replication: { ackWithoutReplicas: "allow" } }),
    )
    await createDb(primary, "acme", SCHEMA)
    const response = await write(primary, "acme", "insert into t (v) values ('local')", {
      ack: "quorum",
    })
    expect(response.status).toBe(200)
  })

  test("a replica that never acks answers ACK_TIMEOUT, and the write still committed", async () => {
    const primary = track(await startPrimary({ replication: { ackTimeoutMs: 150 } }))
    await createDb(primary, "acme", SCHEMA)
    // Attached, streaming, and silent: the difference between "nobody is listening" and "nobody
    // answered" is exactly what the two error codes are for.
    track(await silentReplica(primary, "acme"))

    const response = await write(primary, "acme", "insert into t (v) values ('slow')", {
      ack: "replica",
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as ErrorBody
    expect(body.error.code).toBe("ACK_TIMEOUT")
    expect(body.error.txid).toBeGreaterThan(0)
    expect(body.error.needed).toBe(1)
    expect(body.error.acks).toBe(0)
    // The transaction is committed and durable here, which is the whole point of the code: a
    // durability level that cannot be met is not a reason to lose a transaction.
    expect((await query(primary, "acme", "select v from t")).rows).toEqual([["slow"]])
    expect(Number(primary.handle.registry.open("acme").txid)).toBe(body.error.txid as number)
  })

  test("an unknown ack level is a 400 before anything runs", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const response = await write(primary, "acme", "insert into t (v) values ('x')", { ack: "both" })
    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorBody).error.code).toBe("BAD_REQUEST")
  })
})

describe("the quorum rule", () => {
  // The counting rule is worth pinning down on its own: it decides how many nodes a promise of
  // "quorum" actually involves, and `plan-phase1.md`'s formula and this one disagree at one
  // replica (see docs/r2-durability.md).
  const tracker = new AckTracker({ server: null })

  test("quorum is a majority of primary plus replicas, and never weaker than replica", () => {
    for (const [replicas, expected] of [
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
    ] as const) {
      expect(tracker.needed("acme", "quorum", replicas)).toBe(expected)
      expect(tracker.needed("acme", "quorum", replicas)).toBeGreaterThanOrEqual(
        tracker.needed("acme", "replica", replicas),
      )
    }
  })
})
