// The phase-1 scenario: a primary, two replicas, a bucket and a third-party client, all at once,
// over real sockets. `scenario.test.ts` beside this file is the phase-0 story on a single node;
// this one is the cluster. The tests are a sequence, not a set — `bun test` runs a file in order
// and each step builds on the state the last one left.
//
// Nothing here sleeps. Every wait is a condition on something the cluster reports: a replica's
// applied txid, a live query's rows, a shipper's position. That is what keeps a distributed
// scenario under a minute and off the flake list.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { HEADERS, WS_PROTOCOL } from "../../src/client/protocol.ts"
import { readManifest } from "../../src/storage/index.ts"
import { S3Store } from "../../src/storage/index.ts"
import { FakeS3 } from "../storage/fake-s3.ts"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  until,
  untilSynced,
  type Node,
} from "../replication/harness.ts"

const DB = "orders"
const SCHEMA = "create table orders (id integer primary key, who integer, n integer)"
const TASKS = 6
const WRITES_PER_TASK = 5

let bucket: FakeS3
let prefix = ""
let primary: Node
let replicaA: Node
let replicaB: Node
/** A `@libsql/client` on each node, open for the whole scenario. */
let hranaPrimary: Client
let hranaReplica: Client

/** Rows this file has inserted, by the route that inserted them. */
let expectedRows = 0

beforeAll(async () => {
  bucket = await FakeS3.start({ bucket: "bunql-e2e" })
  prefix = `phase1-${Date.now().toString(36)}/`
  primary = await startPrimary({
    s3: {
      ...bucket.storeOptions,
      prefix,
      shipIntervalMs: 25,
      snapshotIntervalMs: 0,
      snapshotEveryBytes: 0,
      retention: "0",
      retries: 2,
    },
  })
  await createDb(primary, DB, SCHEMA)
  replicaA = await startReplica(primary, { node: "replica-a" })
  replicaB = await startReplica(primary, { node: "replica-b" })
  await untilSynced(primary, replicaA, DB)
  await untilSynced(primary, replicaB, DB)

  // Both clients are opened before the writing starts and stay open through every test below, so
  // the Hrana surface is under load for the whole scenario rather than only in its own test.
  hranaPrimary = createClient({
    url: `http://127.0.0.1:${primary.handle.server.port}/v1/db/${DB}/`,
    authToken: primary.adminKey,
  })
  hranaReplica = createClient({
    url: `http://127.0.0.1:${replicaA.handle.server.port}/v1/db/${DB}/`,
    authToken: replicaA.adminKey,
  })
})

afterAll(async () => {
  hranaPrimary?.close()
  hranaReplica?.close()
  await stopAll()
  bucket?.stop()
})

/** Rows on a node, read locally. A replica never forwards a read. */
async function count(node: Node): Promise<number> {
  const body = await query(node, DB, "select count(*) from orders")
  return (body.rows[0] as number[])[0] as number
}

/** Waits until every node reports the same row count, and returns it. */
async function converged(what: string): Promise<number> {
  let last = -1
  await until(
    async () => {
      const [p, a, b] = await Promise.all([count(primary), count(replicaA), count(replicaB)])
      last = p
      return p === a && p === b
    },
    what,
    20_000,
  )
  return last
}

describe("a primary, two replicas, a bucket and a libsql client", () => {
  test("the cluster comes up and every node agrees on where the database is", async () => {
    const status = await primary.json<{
      role: string
      txid: number
      replicas: { node: string; txid: number }[]
    }>(`/v1/db/${DB}/replication`)
    expect(status.role).toBe("primary")
    expect(status.replicas.map((r) => r.node).sort()).toEqual(["replica-a", "replica-b"])

    for (const replica of [replicaA, replicaB]) {
      const view = await replica.json<{ role: string; primary: string; connected: boolean }>(
        `/v1/db/${DB}/replication`,
      )
      expect(view.role).toBe("replica")
      expect(view.connected).toBe(true)
      expect(view.primary).toBe(primary.replicationUrl)
    }
    expect(await count(replicaA)).toBe(0)
    expect(await count(replicaB)).toBe(0)
  })

  test("concurrent writers on three routes at once land on every node", async () => {
    // Native writes on the primary, forwarded writes through a replica, and a Hrana client, all
    // writing the same table at the same time. The txid space is one dense sequence whichever
    // route a write took, because every one of them ends up on the primary's single writer.
    const before = Number(primary.handle.registry.open(DB).txid)
    const txids: number[] = []

    await Promise.all([
      ...Array.from({ length: TASKS }, async (_, task) => {
        for (let i = 0; i < WRITES_PER_TASK; i++) {
          const node = task % 2 === 0 ? primary : replicaA
          const body = await query(node, DB, "insert into orders (who, n) values (?, ?)", [task, i])
          txids.push(body.txid)
        }
      }),
      (async () => {
        for (let i = 0; i < WRITES_PER_TASK; i++) {
          const rs = await hranaPrimary.execute({
            sql: "insert into orders (who, n) values (?, ?)",
            args: [99, i],
          })
          expect(rs.rowsAffected).toBe(1)
          // The fix this phase closed: a rowid is reported even when it repeats a value the
          // pooled writer last handed out.
          expect(rs.lastInsertRowid).not.toBeUndefined()
        }
      })(),
    ])

    expectedRows = TASKS * WRITES_PER_TASK + WRITES_PER_TASK
    const sorted = [...txids].sort((a, b) => a - b)
    expect(new Set(sorted).size).toBe(sorted.length)
    expect(sorted[0]).toBeGreaterThan(before)

    expect(await converged("every node to hold every write")).toBe(expectedRows)
  }, 30_000)

  test("a write through a replica is executed on the primary and answered by the replica", async () => {
    const response = await replicaB.fetch(`/v1/db/${DB}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into orders (who, n) values (500, 1)" }),
    })
    expect(response.status).toBe(200)
    // The answer names the node that served it and the primary that ran it.
    expect(response.headers.get(HEADERS.role)).toBe("replica")
    expect(response.headers.get(HEADERS.primary)).toBe(primary.replicationUrl)
    const result = (await response.json()) as { txid: number; rowsAffected: number }
    expect(result.rowsAffected).toBe(1)
    expectedRows++

    // The row exists on the primary the moment the replica answered, and on the other replica
    // once it has applied that txid.
    expect(await count(primary)).toBe(expectedRows)
    expect(await converged("the forwarded row to reach both replicas")).toBe(expectedRows)
  })

  test("ack: replica and ack: quorum hold the answer until the replicas have the record", async () => {
    for (const ack of ["replica", "quorum"] as const) {
      const response = await primary.fetch(`/v1/db/${DB}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: `insert into orders (who, n) values (600, 1)`, ack }),
      })
      expect(response.status).toBe(200)
      const { txid } = (await response.json()) as { txid: number }
      expectedRows++
      // No waiting here on purpose: the answer itself is the proof that a replica had the record
      // before it was sent. `quorum` of two replicas needs one; `replica` needs one too, so the
      // assertion is that at least one of them is already at the txid.
      const applied = [replicaA, replicaB].map((node) =>
        Number(node.handle.registry.open(DB).txid),
      )
      expect(Math.max(...applied)).toBeGreaterThanOrEqual(txid)
    }
    const tracker = primary.handle.runtime.acks
    expect(tracker.replicaCount(DB)).toBe(2)
    expect(tracker.needed(DB, "quorum")).toBe(1)
  })

  test("read-your-writes holds across nodes, write on one and read on the other", async () => {
    for (let i = 0; i < 10; i++) {
      // Write through replica A, which forwards it to the primary…
      const written = await query(replicaA, DB, "insert into orders (who, n) values (?, ?)", [700, i])
      expectedRows++
      // …and read it back from replica B, which has to wait for its applier to reach that txid
      // before it may answer. No sleep, no retry: the header is the contract.
      const response = await replicaB.fetch(`/v1/db/${DB}/query`, {
        method: "POST",
        headers: { [HEADERS.minTxid]: String(written.txid) },
        body: JSON.stringify({ sql: "select count(*) from orders where who = 700 and n = ?", args: [i] }),
      })
      expect(response.status).toBe(200)
      expect(Number(response.headers.get(HEADERS.txid))).toBeGreaterThanOrEqual(written.txid)
      const body = (await response.json()) as { rows: number[][] }
      expect((body.rows[0] as number[])[0]).toBe(1)
    }
  }, 20_000)

  test("a live query on a replica converges on writes that happened elsewhere", async () => {
    const socket = new WebSocket(
      `${replicaB.url.replace("http", "ws")}/v1/ws?token=${replicaB.adminKey}`,
      [WS_PROTOCOL],
    )
    const frames: { id?: number; ok?: boolean; event?: string; data?: { rows?: unknown[][] } }[] = []
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve())
      socket.addEventListener("error", () => reject(new Error("the socket did not open")))
    })
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as (typeof frames)[number])
    })
    try {
      socket.send(
        JSON.stringify({
          id: 1,
          op: "subscribe",
          kind: "live",
          db: DB,
          sql: "select count(*) from orders",
        }),
      )
      await until(() => frames.some((f) => f.id === 1 && f.ok === true), "the live subscription")
      await until(() => frames.some((f) => f.event === "rows"), "the first live result")
      const first = frames.find((f) => f.event === "rows")
      expect(first?.data?.rows).toEqual([[expectedRows]])

      // One write on the primary and one forwarded through the other replica: neither touches
      // this node's writer, and the subscription has to converge on both.
      await query(primary, DB, "insert into orders (who, n) values (800, 1)")
      await query(replicaA, DB, "insert into orders (who, n) values (801, 1)")
      expectedRows += 2
      await until(
        () => {
          const rows = frames.filter((f) => f.event === "rows" || f.event === "diff").at(-1)
          return JSON.stringify(rows?.data?.rows) === JSON.stringify([[expectedRows]])
        },
        `the live query on the replica to converge on ${expectedRows}`,
        20_000,
      )
    } finally {
      socket.close()
    }
  }, 25_000)

  test("@libsql/client reads a replica and writes the primary, over the same database", async () => {
    await converged("both replicas to hold everything before the client reads them")
    const onPrimary = await hranaPrimary.execute("select count(*) as n from orders")
    expect(onPrimary.rows[0]?.n).toBe(expectedRows)
    // The replica answers a read locally, with the same rows.
    const onReplica = await hranaReplica.execute("select count(*) as n from orders")
    expect(onReplica.rows[0]?.n).toBe(expectedRows)
    // `replication_index` is our txid, which is what makes a libsql client's reads orderable.
    expect(Number(onReplica.rows.length)).toBe(1)

    // A transaction through the client on the primary, with the rowid the fix made exact.
    const tx = await hranaPrimary.transaction("write")
    const inserted = await tx.execute("insert into orders (who, n) values (900, 1)")
    await tx.execute("insert into orders (who, n) values (900, 2)")
    await tx.commit()
    expect(inserted.lastInsertRowid).not.toBeUndefined()
    expectedRows += 2
    expect(await converged("the client's transaction to reach both replicas")).toBe(expectedRows)

    // Hrana on a replica is a read surface in phase 1: a write there is refused rather than
    // forwarded, and `docs/api.md` says so.
    const refused = await hranaReplica
      .execute("insert into orders (who, n) values (901, 1)")
      .then(() => null)
      .catch((err: Error) => err)
    expect(refused).toBeInstanceOf(Error)
    expect(String(refused)).toContain("NOT_PRIMARY")
  }, 25_000)

  test("the bucket has everything, and restores into a database that matches", async () => {
    await primary.handle.runtime.storage?.flush()
    const at = Number(primary.handle.registry.open(DB).txid)

    const store = new S3Store({ ...bucket.storeOptions, concurrency: 4, retries: 2, retryBaseMs: 10 })
    const manifest = await readManifest(store, prefix, DB)
    expect(Number(manifest.shippedTxid)).toBe(at)

    const status = await primary.json<{
      enabled: boolean
      shipper: { shippedTxid: number; behind: boolean; errors: number }
    }>(`/v1/db/${DB}/backup`)
    expect(status.enabled).toBe(true)
    expect(status.shipper.shippedTxid).toBe(at)
    expect(status.shipper.errors).toBe(0)
    const verified = await primary.json<{ ok: boolean; latest: number }>(
      `/v1/db/${DB}/backup/verify`,
      { method: "POST", body: JSON.stringify({}) },
    )
    expect(verified).toMatchObject({ ok: true, latest: at })

    // The restore lands on a node that never followed this cluster: a fresh server pointed at the
    // same bucket, which is what a recovery actually looks like.
    const recovery = await startPrimary({
      server: { node: "recovery" },
      s3: { ...bucket.storeOptions, prefix, enabled: false, retries: 2 },
    })
    try {
      const restored = await recovery.json<{ name: string; txid: number; applied: number }>(
        `/v1/db/${DB}/restore`,
        { method: "POST", body: JSON.stringify({ from: "s3", into: "orders-restored" }) },
      )
      expect(restored.txid).toBe(at)

      const here = await query(recovery, "orders-restored", "select who, n from orders order by id")
      const there = await query(primary, DB, "select who, n from orders order by id")
      expect(here.rows.length).toBe(expectedRows)
      expect(here.rows).toEqual(there.rows)
    } finally {
      await recovery.close()
    }
  }, 30_000)

  test("every node ends the scenario at the same txid, checksum and row set", async () => {
    const rows = await converged("the cluster to settle")
    expect(rows).toBe(expectedRows)
    const head = await primary.json<{ txid: number; checksum: string }>(`/v1/db/${DB}/replication`)
    for (const replica of [replicaA, replicaB]) {
      await until(
        () => Number(replica.handle.registry.open(DB).txid) >= head.txid,
        `${replica.handle.config.server.node} to reach ${head.txid}`,
      )
      const tenant = replica.handle.registry.open(DB)
      expect(Number(tenant.txid)).toBe(head.txid)
      expect(tenant.checksum.toString()).toBe(head.checksum)
    }
  }, 20_000)
})
