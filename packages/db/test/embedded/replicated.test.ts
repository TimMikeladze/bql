// The embedded write path with a durability level: `db.sync.commit` answers with the txid, and
// `bq.replicated` waits for an ack level outside the synchronous transaction, with the errors the
// routes answer. The replica tests run a served `Bql` as the primary and the replication harness's
// nodes as its replicas.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bql, type EmbeddedRole, type OpenOptions } from "../../src/embedded.ts"
import { BqlClientError } from "../../src/client/errors.ts"
import type { ServerConfigInput } from "../../src/server/config.ts"
import {
  CLUSTER_SECRET,
  silentReplica,
  startReplica,
  stopAll,
  untilSynced,
  type Node,
} from "../replication/harness.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []
let open: { close(): Promise<void> }[] = []

async function openBql(overrides: OpenOptions = {}): Promise<Bql> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-embedded-ack-"))
  dirs.push(dir)
  const bq = await Bql.open({ dir, ...overrides })
  open.push(bq)
  return bq
}

/** A served `Bql` as the harness's `Node`, so `startReplica` and `silentReplica` can point at it. */
async function servedPrimary(overrides: ServerConfigInput = {}): Promise<{ bq: Bql; node: Node }> {
  const bq = await openBql({
    ...overrides,
    server: { node: "primary" },
    replication: { secret: CLUSTER_SECRET, heartbeatMs: 100, ...overrides.replication },
  })
  const handle = await bq.serve({ port: 0, host: "127.0.0.1" })
  const node = {
    handle,
    url: `http://127.0.0.1:${handle.server.port}`,
    replicationUrl: `ws://127.0.0.1:${handle.server.port}/v1/replication`,
  } as Node
  return { bq, node }
}

async function failure(promise: PromiseLike<unknown> | (() => unknown)): Promise<BqlClientError> {
  try {
    await (typeof promise === "function" ? promise() : promise)
  } catch (err) {
    return err as BqlClientError
  }
  throw new Error("expected the call to fail, and it did not")
}

afterEach(async () => {
  const current = open
  open = []
  for (const thing of current.reverse()) await thing.close()
})

afterAll(async () => {
  await stopAll()
  while (dirs.length > 0) removeTempDir(dirs.pop() as string)
})

describe("sync.commit", () => {
  test("answers with the value and the txid the commit was assigned", async () => {
    const bq = await openBql()
    const db = await bq.create("acme")
    db.sync.execute("create table t (id integer primary key, v text)").run()
    const before = db.txid

    const { value, txid } = db.sync.commit((tx) => {
      tx.sql`insert into t (v) values (${"a"})`.run()
      return tx.sql`select count(*) as n from t`.get()
    })
    expect(value).toEqual({ n: 1 })
    expect(txid).toBe(before + 1)
    expect(db.txid).toBe(txid)

    // A transaction that wrote nothing reports where the database already is.
    const empty = db.sync.commit((tx) => tx.sql`select 1 as one`.get())
    expect(empty).toEqual({ value: { one: 1 }, txid })
  })
})

describe("bq.replicated", () => {
  test("local and fsync resolve on a node with no replicas", async () => {
    const bq = await openBql()
    const db = await bq.create("acme")
    const { txid } = db.sync.commit(
      (tx) => tx.sql`create table t (id integer primary key)`.run(),
      { ack: "local" },
    )
    await bq.replicated("acme", txid, { ack: "local" })
    await bq.replicated("acme", txid, { ack: "fsync" })
  })

  test("NO_REPLICAS is raised before the write, and by the wait", async () => {
    const bq = await openBql()
    const db = await bq.create("acme")
    db.sync.execute("create table t (id integer primary key)").run()
    const before = db.txid

    expect((await failure(() => bq.assertReplicas("acme", "replica"))).code).toBe("NO_REPLICAS")
    const refused = await failure(() =>
      db.sync.commit((tx) => tx.sql`insert into t default values`.run(), { ack: "replica" }),
    )
    expect(refused.code).toBe("NO_REPLICAS")
    expect(db.txid).toBe(before)

    const { txid } = db.sync.commit((tx) => tx.sql`insert into t default values`.run())
    const waited = await failure(bq.replicated("acme", txid, { ack: "quorum" }))
    expect(waited.code).toBe("NO_REPLICAS")
    expect(waited.txid).toBe(txid)
  })

  test("replica resolves once a replica has the commit", async () => {
    const { bq, node } = await servedPrimary()
    const replica = await startReplica(node)
    open.push(replica)
    const db = await bq.create("acme")
    db.sync.execute("create table t (id integer primary key, v text)").run()
    await untilSynced(node, replica, "acme")

    bq.assertReplicas("acme", "replica")
    const { txid } = db.sync.commit((tx) => tx.sql`insert into t (v) values (${"r"})`.run(), {
      ack: "replica",
    })
    await bq.replicated("acme", txid, { ack: "replica" })
    expect(Number(replica.handle.registry.open("acme").txid)).toBeGreaterThanOrEqual(txid)
  })

  test("a replica that never acks ends in ACK_TIMEOUT, and the commit stays", async () => {
    const { bq, node } = await servedPrimary({ replication: { ackTimeoutMs: 150 } })
    const db = await bq.create("acme")
    db.sync.execute("create table t (id integer primary key)").run()
    open.push(await silentReplica(node, "acme"))

    const { txid } = db.sync.commit((tx) => tx.sql`insert into t default values`.run())
    const err = await failure(bq.replicated("acme", txid, { ack: "replica" }))
    expect(err.code).toBe("ACK_TIMEOUT")
    expect(err.txid).toBe(txid)
    expect(err.acks).toBe(0)
    expect(err.needed).toBe(1)
    expect(db.sync.sql`select count(*) as n from t`.get()).toEqual({ n: 1 })
  })
})

describe("bq.on('role')", () => {
  test("fires when this node stops being the primary for a database", async () => {
    // The demotion reports a FencedNotice through `onError`.
    const bq = await openBql({ onError: () => {} })
    await bq.create("acme")
    const seen: EmbeddedRole[] = []
    bq.on("role", (event) => seen.push(event))

    expect(bq.role("acme")).toBe("primary")
    bq.runtime.promoter.demote("acme", "test")
    expect(seen).toEqual([{ db: "acme", role: "replica" }])
    expect(bq.role("acme")).toBe("replica")
  })
})
