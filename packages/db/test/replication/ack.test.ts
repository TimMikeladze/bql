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

  test("the BQL-Ack header and durability.defaultAck mean the same thing", async () => {
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

  // R8 (`docs/r8-per-db-ack.md`). Every case here asserts the *behaviour* on a node with no
  // replicas attached, not the value read back out of `GET /v1/db/{db}` — recording a setting and
  // enforcing it are different claims, and only the second one matters.
  describe("per-database ackWithoutReplicas", () => {
    async function patch(node: Node, db: string, value: string | null): Promise<Response> {
      return await node.fetch(`/v1/db/${db}`, {
        method: "PATCH",
        body: JSON.stringify({ ackWithoutReplicas: value }),
      })
    }

    test("one database can allow while the rest of the node still refuses", async () => {
      const primary = track(await startPrimary())
      for (const name of ["acme", "other"]) await createDb(primary, name, SCHEMA)

      // Default: both follow the node, which is `"error"`.
      expect((await write(primary, "acme", "insert into t (v) values ('a')", { ack: "replica" }))
        .status).toBe(503)
      expect(await patch(primary, "acme", "allow").then((r) => r.status)).toBe(200)

      const allowed = await write(primary, "acme", "insert into t (v) values ('a')", {
        ack: "replica",
      })
      expect(allowed.status).toBe(200)
      // Answered locally means the write happened, not that it was skipped.
      const rows = (await query(primary, "acme", "select count(*) as n from t")).rows[0] as number[]
      expect(rows[0]).toBe(1)

      // The whole point of the milestone: the other nine databases are untouched.
      const refused = await write(primary, "other", "insert into t (v) values ('b')", {
        ack: "replica",
      })
      expect(refused.status).toBe(503)
      expect(((await refused.json()) as ErrorBody).error.code).toBe("NO_REPLICAS")
    })

    test("null puts a database back on the node's setting, in both directions", async () => {
      const primary = track(await startPrimary())
      await createDb(primary, "acme", SCHEMA)
      await patch(primary, "acme", "allow")
      expect((await write(primary, "acme", "insert into t (v) values ('1')", { ack: "replica" }))
        .status).toBe(200)

      // Three states, not two: clearing the override is not the same as setting it to "error".
      expect(
        ((await primary.json("/v1/db/acme")) as { ackWithoutReplicas: string | null })
          .ackWithoutReplicas,
      ).toBe("allow")
      await patch(primary, "acme", null)
      expect(
        ((await primary.json("/v1/db/acme")) as { ackWithoutReplicas: string | null })
          .ackWithoutReplicas,
      ).toBeNull()
      expect((await write(primary, "acme", "insert into t (v) values ('2')", { ack: "replica" }))
        .status).toBe(503)
    })

    test("a database can refuse on a node that allows, which is the override running the hard way", async () => {
      const primary = track(await startPrimary({ replication: { ackWithoutReplicas: "allow" } }))
      for (const name of ["acme", "other"]) await createDb(primary, name, SCHEMA)
      expect(await patch(primary, "acme", "error").then((r) => r.status)).toBe(200)

      const refused = await write(primary, "acme", "insert into t (v) values ('x')", {
        ack: "quorum",
      })
      expect(refused.status).toBe(503)
      expect(((await refused.json()) as ErrorBody).error.code).toBe("NO_REPLICAS")
      // And nothing was written, because the refusal happens before the statement runs.
      const rows = (await query(primary, "acme", "select count(*) as n from t")).rows[0] as number[]
      expect(rows[0]).toBe(0)

      expect((await write(primary, "other", "insert into t (v) values ('y')", { ack: "quorum" }))
        .status).toBe(200)
    })

    test("it survives a restart, because it is a catalog column rather than a memo", async () => {
      const primary = track(await startPrimary())
      await createDb(primary, "acme", SCHEMA)
      await patch(primary, "acme", "allow")
      await primary.close()
      const restarted = track(await startPrimary({}, { dir: primary.dir }))
      expect((await write(restarted, "acme", "insert into t (v) values ('r')", { ack: "replica" }))
        .status).toBe(200)
    })

    test("an override does not follow the name through a delete", async () => {
      const primary = track(await startPrimary())
      await createDb(primary, "acme", SCHEMA)
      await patch(primary, "acme", "allow")
      expect((await primary.fetch("/v1/db/acme", { method: "DELETE" })).status).toBe(200)
      await createDb(primary, "acme", SCHEMA)
      // A new database under a reused name follows the node, not whatever the last one said.
      expect((await write(primary, "acme", "insert into t (v) values ('n')", { ack: "replica" }))
        .status).toBe(503)
    })

    test("anything but error, allow or null is refused", async () => {
      const primary = track(await startPrimary())
      await createDb(primary, "acme", SCHEMA)
      const response = await patch(primary, "acme", "maybe")
      expect(response.status).toBe(400)
    })
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
