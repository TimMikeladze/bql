// Forwarding a write off a replica on the libsql-compatible surface (`docs/r4b-hrana-forward.md`).
//
// The decision under test is §2: a baton on a replica means exactly what it means on a primary — a
// local stream — and the stream holds a `RemoteTx` where a primary's holds a `TxSession`. So the
// cases below are about **where the statement ran**, asked by looking at the primary.

import { afterEach, describe, expect, test } from "bun:test"
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

  test("a read-only transaction is refused rather than served or forwarded", async () => {
    // §2.2, and it is the plan being wrong rather than the code: `Tenant.txBegin` takes the
    // tenant's *writer* whatever the mode, and a replica's writer belongs to the applier — a
    // client holding it would stall the replication stream for as long as the transaction lasted.
    const { replica } = await pair()
    const body = await pipeline(replica, [stmt("begin transaction readonly")])
    expect(failed(body, 0)).not.toBeNull()
    // …and it is refused *here*, not by a round trip to the primary that then refuses.
    expect(failed(body, 0)).toContain("NOT_PRIMARY")
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
