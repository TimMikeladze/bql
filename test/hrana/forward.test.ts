// Forwarding a write off a replica on the libsql-compatible surface (`docs/r4b-hrana-forward.md`).
//
// The decision under test is §2: a baton on a replica means exactly what it means on a primary — a
// local stream — and the stream holds a `RemoteTx` where a primary's holds a `TxSession`. So the
// cases below are about **where the statement ran**, asked by looking at the primary.

import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import {
  createDb,
  startPrimary,
  startReplica,
  stopAll,
  untilFollowing,
  untilSynced,
  type Node,
} from "../replication/harness.ts"
import type { PipelineReqBody, PipelineRespBody, StreamRequest } from "../../src/server/hrana/proto.ts"

afterEach(stopAll)

/** One `/v2/pipeline` POST against a node, with the admin key. */
async function pipeline(
  node: Node,
  requests: StreamRequest[],
  baton: string | null = null,
): Promise<PipelineRespBody & { message?: string }> {
  const body: PipelineReqBody = { baton, requests }
  const response = await node.fetch("/v1/db/acme/v2/pipeline", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return (await response.json()) as PipelineRespBody & { message?: string }
}

function stmt(sql: string): StreamRequest {
  return { type: "execute", stmt: { sql, want_rows: true } }
}

/** The rows of the n-th response, as flat values. */
function rowsOf(body: PipelineRespBody, at = 0): unknown[][] {
  const result = body.results[at]
  if (!result || result.type !== "ok") throw new Error(`step ${at}: ${JSON.stringify(result)}`)
  const response = result.response as { type: string; result?: { rows?: { value: unknown }[][] } }
  return (response.result?.rows ?? []).map((row) => row.map((cell) => cell.value))
}

function failed(body: PipelineRespBody, at = 0): string | null {
  const result = body.results[at]
  if (!result) return "missing"
  return result.type === "error" ? JSON.stringify(result) : null
}

async function pair(): Promise<{ primary: Node; replica: Node }> {
  const primary = await startPrimary()
  await createDb(primary, "acme", "create table t (id integer primary key, v text)")
  const replica = await startReplica(primary)
  await untilFollowing(replica, "acme")
  return { primary, replica }
}

describe("hrana on a replica", () => {
  test("forwards a write outside a transaction, and serves the read locally", async () => {
    const { primary, replica } = await pair()

    const wrote = await pipeline(replica, [stmt("insert into t (v) values ('one')")])
    expect(failed(wrote)).toBeNull()

    // It landed on the primary, which is the only place it can have landed.
    await untilSynced(primary, replica, "acme")
    const onPrimary = await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select v from t" }),
    })
    expect(((await onPrimary.json()) as { rows: string[][] }).rows).toEqual([["one"]])

    // And the replica can read it back over its own surface.
    const read = await pipeline(replica, [stmt("select v from t")])
    expect(rowsOf(read)).toEqual([["one"]])
  }, 30_000)

  test("a read on a replica never leaves the node", async () => {
    const { primary, replica } = await pair()
    await pipeline(replica, [stmt("insert into t (v) values ('one')")])
    await untilSynced(primary, replica, "acme")
    // With the primary gone there is nothing to forward to, so a read that still answers is a read
    // that was served here.
    await primary.close()
    const read = await pipeline(replica, [stmt("select v from t")])
    expect(rowsOf(read)).toEqual([["one"]])
  }, 30_000)

  test("runs a client-shaped transaction, and a read in it sees its own write", async () => {
    // BEGIN / insert / select / COMMIT is the shape `@libsql/client` builds a transaction out of,
    // and the select is §2.1: once the transaction is remote every statement in it is remote, so
    // the row is visible before the commit even though the local file does not hold it.
    const { primary, replica } = await pair()
    const body = await pipeline(replica, [
      stmt("begin"),
      stmt("insert into t (v) values ('inside')"),
      stmt("select v from t"),
      stmt("commit"),
    ])
    for (let i = 0; i < 4; i++) expect(failed(body, i)).toBeNull()
    expect(rowsOf(body, 2)).toEqual([["inside"]])

    await untilSynced(primary, replica, "acme")
    const onPrimary = await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select v from t" }),
    })
    expect(((await onPrimary.json()) as { rows: string[][] }).rows).toEqual([["inside"]])
  }, 30_000)

  test("rolls back, and the row is on neither node", async () => {
    const { primary, replica } = await pair()
    const body = await pipeline(replica, [
      stmt("begin"),
      stmt("insert into t (v) values ('gone')"),
      stmt("rollback"),
    ])
    for (let i = 0; i < 3; i++) expect(failed(body, i)).toBeNull()
    const onPrimary = await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
    })
    expect(((await onPrimary.json()) as { rows: number[][] }).rows).toEqual([[0]])
  }, 30_000)

  test("a read-only transaction is served by the replica, and not forwarded", async () => {
    // R10 (`docs/r10-read-transactions.md`) replaced R4b §2.2's refusal. The reason that refusal
    // existed is unchanged — `Tenant.txBegin` takes the tenant's *writer* whatever the mode, and a
    // replica's writer belongs to the applier — so the transaction went to a leased *reader*
    // instead, where it blocks nothing and needs no round trip.
    const { replica } = await pair()
    const body = await pipeline(replica, [
      stmt("begin transaction readonly"),
      stmt("select count(*) from t"),
      stmt("commit"),
    ])
    for (let i = 0; i < 3; i++) expect(failed(body, i)).toBeNull()
  }, 30_000)

  test("a write inside a read-only transaction on a replica is refused, not forwarded", async () => {
    // The read mode has to mean something, and forwarding the write would mean a transaction that
    // read locally and wrote remotely — which would not show the client its own writes.
    const { primary, replica } = await pair()
    const body = await pipeline(replica, [
      stmt("begin transaction readonly"),
      stmt("insert into t (v) values ('nope')"),
      stmt("rollback"),
    ])
    expect(failed(body, 1)).toContain("SQLITE_READONLY")
    const onPrimary = await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
    })
    expect(((await onPrimary.json()) as { rows: number[][] }).rows).toEqual([[0]])
  }, 30_000)

  test("forwarding off makes the replica visibly read-only", async () => {
    // The switch an operator sets for exactly that, and R4b changes nothing about it.
    const primary = await startPrimary()
    await createDb(primary, "acme", "create table t (id integer primary key, v text)")
    const replica = await startReplica(primary, {
      overrides: { replication: { forwardWrites: false } },
    })
    await untilFollowing(replica, "acme")
    const write = await pipeline(replica, [stmt("insert into t (v) values ('nope')")])
    expect(failed(write)).not.toBeNull()
  }, 30_000)
})

// R10 (`docs/r10-read-transactions.md`). The claim is that a read transaction lives on a leased
// reader on *both* roles: it works on a replica, where the writer belongs to the applier, and it no
// longer blocks writes on a primary.
describe("read transactions", () => {
  test("@libsql/client's transaction(\"read\") works against a replica", async () => {
    const { primary, replica } = await pair()
    await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('one')" }),
    })
    await untilSynced(primary, replica, "acme")

    const client = createClient({
      url: replica.url.replace("http://", "http://") + "/v1/db/acme/",
      authToken: replica.adminKey,
    })
    try {
      const tx = await client.transaction("read")
      const rows = await tx.execute("select v from t")
      expect(rows.rows.map((row) => row.v)).toEqual(["one"])
      // The read mode has to mean something, and this is the only thing that makes it so.
      await expect(tx.execute("insert into t (v) values ('x')")).rejects.toThrow()
      await tx.close()
    } finally {
      client.close()
    }
  }, 30_000)

  test("the snapshot is real: a write replicated in between is not seen inside it", async () => {
    const { primary, replica } = await pair()
    await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('first')" }),
    })
    await untilSynced(primary, replica, "acme")

    // Open the transaction and take its first read, which is where `BEGIN DEFERRED` pins the
    // snapshot. Without that read there is no snapshot yet and the case proves nothing.
    const opened = await pipeline(replica, [
      stmt("begin transaction readonly"),
      stmt("select count(*) from t"),
    ])
    expect(failed(opened, 0)).toBeNull()
    // Hrana renders an integer as a decimal string, which is `values.ts` doing what the protocol says.
    expect(rowsOf(opened, 1)).toEqual([["1"]])
    const baton = opened.baton as string

    await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('second')" }),
    })
    // Deliberately *not* waiting for the replica here: §2.3 is that an open read transaction makes
    // the page applier defer, so the record lands when the transaction lets go. Waiting for it
    // while holding the transaction would be waiting for the thing the transaction is preventing.
    const inside = await pipeline(replica, [stmt("select count(*) from t"), stmt("commit")], baton)
    expect(rowsOf(inside, 0)).toEqual([["1"]])

    // Once it is committed the deferred record applies, and the replica has both rows.
    await untilSynced(primary, replica, "acme")
    const after = await pipeline(replica, [stmt("select count(*) from t")])
    expect(rowsOf(after, 0)).toEqual([["2"]])
  }, 30_000)

  test("on a primary a read transaction no longer blocks writes", async () => {
    const primary = await startPrimary()
    await createDb(primary, "acme", "create table t (id integer primary key, v text)")
    const opened = await pipeline(primary, [
      stmt("begin transaction readonly"),
      stmt("select count(*) from t"),
    ])
    expect(failed(opened, 0)).toBeNull()
    const baton = opened.baton as string

    // The behaviour change of §2.2: against the old writer-based path this would have been
    // `TX_BUSY`, because the read transaction held the one writer.
    const write = await primary.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('while open')" }),
    })
    expect(write.status).toBe(200)

    await pipeline(primary, [stmt("commit")], baton)
  }, 30_000)

  test("past [limits] maxReadTx the next one is TX_BUSY", async () => {
    const primary = await startPrimary({ limits: { maxReadTx: 2 } })
    await createDb(primary, "acme", "create table t (id integer primary key, v text)")
    const batons: string[] = []
    for (let i = 0; i < 2; i++) {
      const opened = await pipeline(primary, [stmt("begin transaction readonly")])
      expect(failed(opened, 0)).toBeNull()
      batons.push(opened.baton as string)
    }
    const refused = await pipeline(primary, [stmt("begin transaction readonly")])
    expect(failed(refused, 0)).toContain("TX_BUSY")

    for (const baton of batons) await pipeline(primary, [stmt("commit")], baton)
    // And the slots come back.
    const after = await pipeline(primary, [stmt("begin transaction readonly"), stmt("commit")])
    expect(failed(after, 0)).toBeNull()
  }, 30_000)

  test("a read transaction left open past readTxTimeoutMs is gone", async () => {
    const primary = await startPrimary({ limits: { readTxTimeoutMs: 120, txIdleTimeoutMs: 60_000 } })
    await createDb(primary, "acme", "create table t (id integer primary key, v text)")
    const opened = await pipeline(primary, [
      stmt("begin transaction readonly"),
      stmt("select count(*) from t"),
    ])
    const baton = opened.baton as string
    await Bun.sleep(300)
    expect(primary.handle.runtime.openReadTxCount).toBe(0)
    // The stream's baton outlives the transaction, so the client is *told* rather than quietly
    // served outside a transaction it still believes it is in.
    const after = await pipeline(primary, [stmt("select count(*) from t")], baton)
    expect(failed(after, 0)).toContain("TX_NOT_FOUND")
    // …and the stream recovers: the expired transaction is not a permanent trap.
    const recovered = await pipeline(primary, [stmt("select count(*) from t")], after.baton as string)
    expect(failed(recovered, 0)).toBeNull()
  }, 30_000)
})
