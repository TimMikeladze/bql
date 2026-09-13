// Write forwarding and read-your-writes across nodes (design §5.2, §5.4). A write that arrives on
// a replica is executed once, on the primary, and the replica answers with the primary's own
// result — including its errors, which must not arrive wrapped in a transport failure.
//
// The loop worth proving is the last one: write on the primary, read on the replica with the txid
// that came back, get the row. Everything else in here is what makes that loop usable without the
// client having to know which node it reached.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HEADERS, WS_PROTOCOL } from "../../src/client/protocol.ts"
import {
  createDb,
  query,
  startPrimary,
  startReplica,
  stopAll,
  until,
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

interface QueryBody {
  rows: unknown[][]
  txid: number
  rowsAffected: number
}

interface ErrorBody {
  error: { code: string; message: string; status: number; failedIndex?: number }
}

/** A primary with `acme`, and a replica of it that has caught up. */
async function pair(): Promise<{ primary: Node; replica: Node }> {
  const primary = track(await startPrimary())
  await createDb(primary, "acme", SCHEMA)
  const replica = track(await startReplica(primary))
  await untilSynced(primary, replica, "acme")
  return { primary, replica }
}

function post(node: Node, route: string, body: unknown): Promise<Response> {
  return node.fetch(route, { method: "POST", body: JSON.stringify(body) })
}

describe("write forwarding", () => {
  test("a write on a replica is executed on the primary and visible on both", async () => {
    const { primary, replica } = await pair()

    const response = await post(replica, "/v1/db/acme/query", {
      sql: "insert into t (v) values ('forwarded')",
    })
    expect(response.status).toBe(200)
    expect(response.headers.get(HEADERS.role)).toBe("replica")
    expect(response.headers.get(HEADERS.primary)).toBe(primary.replicationUrl)
    const result = (await response.json()) as QueryBody
    expect(result.rowsAffected).toBe(1)
    expect(result.txid).toBeGreaterThan(0)
    expect(response.headers.get(HEADERS.txid)).toBe(String(result.txid))

    // The replica answered only after its own applier reached that txid, so a read on the same
    // node sees the write with no `minTxid` and no wait.
    expect((await query(replica, "acme", "select v from t")).rows).toEqual([["forwarded"]])
    expect((await query(primary, "acme", "select v from t")).rows).toEqual([["forwarded"]])
    expect(Number(replica.handle.registry.open("acme").txid)).toBeGreaterThanOrEqual(result.txid)
  })

  test("a read on a replica is served locally and never forwarded", async () => {
    const { primary, replica } = await pair()
    await query(primary, "acme", "insert into t (v) values ('local')")
    await untilSynced(primary, replica, "acme")
    const before = replica.handle.runtime.metrics.snapshot({ open: 0, tenants: 0, evictions: 0 })

    expect((await query(replica, "acme", "select v from t")).rows).toEqual([["local"]])
    const after = replica.handle.runtime.metrics.snapshot({ open: 0, tenants: 0, evictions: 0 })
    expect(after.forwarded).toBe(before.forwarded)
  })

  test("a batch is forwarded whole and lands under one txid", async () => {
    const { primary, replica } = await pair()
    const response = await post(replica, "/v1/db/acme/batch", {
      statements: [
        { sql: "insert into t (v) values ('one')" },
        { sql: "insert into t (v) values ('two')" },
      ],
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { results: QueryBody[]; txid: number }
    expect(body.results).toHaveLength(2)
    expect((await query(primary, "acme", "select count(*) as n from t")).rows).toEqual([[2]])
    expect((await query(replica, "acme", "select v from t order by id")).rows).toEqual([
      ["one"],
      ["two"],
    ])
  })

  test("the primary's error reaches the client under its own code", async () => {
    const { replica } = await pair()
    await post(replica, "/v1/db/acme/query", {
      sql: "insert into t (id, v) values (1, 'first')",
    })
    const conflict = await post(replica, "/v1/db/acme/query", {
      sql: "insert into t (id, v) values (1, 'again')",
    })
    expect(conflict.status).toBe(409)
    const body = (await conflict.json()) as ErrorBody
    // Not `INTERNAL`, not `NOT_PRIMARY`: the constraint the primary hit, with its own status.
    expect(body.error.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY")

    const broken = await post(replica, "/v1/db/acme/query", { sql: "insert into nope (v) values (1)" })
    expect(broken.status).toBe(400)
    expect(((await broken.json()) as ErrorBody).error.code).toBe("SQLITE_ERROR")
  })

  test("a failing statement in a forwarded batch keeps its failedIndex", async () => {
    const { replica } = await pair()
    const response = await post(replica, "/v1/db/acme/batch", {
      statements: [{ sql: "insert into t (v) values ('ok')" }, { sql: "insert into nope values (1)" }],
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as ErrorBody
    expect(body.error.failedIndex).toBe(1)
  })

  test("an interactive transaction on a replica runs on the primary", async () => {
    const { primary, replica } = await pair()
    const begun = await post(replica, "/v1/db/acme/tx", {})
    expect(begun.status).toBe(200)
    const { tx } = (await begun.json()) as { tx: string }

    const inside = await post(replica, `/v1/db/acme/tx/${tx}`, {
      sql: "insert into t (v) values ('in tx')",
    })
    expect(inside.status).toBe(200)
    // Uncommitted, so neither node can see it yet.
    expect((await query(primary, "acme", "select count(*) as n from t")).rows).toEqual([[0]])

    const committed = await post(replica, `/v1/db/acme/tx/${tx}/commit`, {})
    expect(committed.status).toBe(200)
    const { txid } = (await committed.json()) as { txid: number }
    expect(txid).toBeGreaterThan(0)
    expect((await query(replica, "acme", "select v from t")).rows).toEqual([["in tx"]])
    // The baton is gone on both sides, so the primary's only writer is free again.
    expect((await post(replica, `/v1/db/acme/tx/${tx}/commit`, {})).status).toBe(404)
    expect(primary.handle.runtime.openTxCount).toBe(0)
  })

  test("a rolled-back forwarded transaction leaves nothing behind", async () => {
    const { primary, replica } = await pair()
    const { tx } = (await (await post(replica, "/v1/db/acme/tx", {})).json()) as { tx: string }
    await post(replica, `/v1/db/acme/tx/${tx}`, { sql: "insert into t (v) values ('doomed')" })
    expect((await post(replica, `/v1/db/acme/tx/${tx}/rollback`, {})).status).toBe(200)
    expect((await query(primary, "acme", "select count(*) as n from t")).rows).toEqual([[0]])
    expect(primary.handle.runtime.openTxCount).toBe(0)
  })

  test("a replica that loses its socket takes its forwarded transactions with it", async () => {
    const { primary, replica } = await pair()
    const { tx } = (await (await post(replica, "/v1/db/acme/tx", {})).json()) as { tx: string }
    await post(replica, `/v1/db/acme/tx/${tx}`, { sql: "insert into t (v) values ('orphan')" })
    expect(primary.handle.runtime.openTxCount).toBe(1)

    await replica.close()
    await until(
      () => primary.handle.runtime.openTxCount === 0,
      "the primary to roll back the transaction the replica left open",
    )
    expect((await query(primary, "acme", "select count(*) as n from t")).rows).toEqual([[0]])
  })

  test("forwardWrites = false keeps the old 503 NOT_PRIMARY", async () => {
    const primary = track(await startPrimary())
    await createDb(primary, "acme", SCHEMA)
    const replica = track(
      await startReplica(primary, { overrides: { replication: { forwardWrites: false } } }),
    )
    await untilSynced(primary, replica, "acme")

    const response = await post(replica, "/v1/db/acme/query", {
      sql: "insert into t (v) values ('no')",
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as ErrorBody).error.code).toBe("NOT_PRIMARY")
    expect(response.headers.get(HEADERS.primary)).toBe(primary.replicationUrl)
  })

  test("a replica that cannot reach its primary answers NOT_PRIMARY rather than hanging", async () => {
    const { primary, replica } = await pair()
    await primary.close()
    await until(
      () => !replica.handle.runtime.replica?.connected,
      "the replica to notice its primary is gone",
    )
    const response = await post(replica, "/v1/db/acme/query", { sql: "insert into t (v) values ('x')" })
    expect(response.status).toBe(503)
    expect(((await response.json()) as ErrorBody).error.code).toBe("NOT_PRIMARY")
  })

  test("a write forwarded over a WebSocket behaves the same way", async () => {
    const { primary, replica } = await pair()
    const socket = new WebSocket(`${replica.url.replace("http", "ws")}/v1/ws?token=${replica.adminKey}`, [
      WS_PROTOCOL,
    ])
    const replies: Record<string, unknown>[] = []
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve())
      socket.addEventListener("error", () => reject(new Error("the socket did not open")))
    })
    socket.addEventListener("message", (event) => {
      replies.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    })
    socket.send(
      JSON.stringify({ id: 1, op: "query", db: "acme", sql: "insert into t (v) values ('ws')" }),
    )
    await until(() => replies.some((r) => r.id === 1), "the forwarded write to be answered")
    const reply = replies.find((r) => r.id === 1) as { ok: boolean; result: QueryBody }
    expect(reply.ok).toBe(true)
    expect(reply.result.rowsAffected).toBe(1)
    // The greeting names the node's real role, which is what tells a socket client where it is.
    const hello = replies.find((r) => r.event === "hello") as { role: string; primary: string }
    expect(hello.role).toBe("replica")
    expect(hello.primary).toBe(primary.replicationUrl)
    socket.close()
    expect((await query(replica, "acme", "select v from t")).rows).toEqual([["ws"]])
  })
})

describe("read-your-writes across nodes", () => {
  test("a write on the primary is readable on the replica with the txid it returned", async () => {
    const { primary, replica } = await pair()
    const written = await query(primary, "acme", "insert into t (v) values ('ryw')")

    // No polling and no sleep: the replica is handed the txid and has to wait for it itself.
    const response = await replica.fetch("/v1/db/acme/query", {
      method: "POST",
      headers: { [HEADERS.minTxid]: String(written.txid) },
      body: JSON.stringify({ sql: "select v from t" }),
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as QueryBody).rows).toEqual([["ryw"]])
    expect(response.headers.get(HEADERS.role)).toBe("replica")
    expect(Number(response.headers.get(HEADERS.txid))).toBeGreaterThanOrEqual(written.txid)
  })

  test("a txid the replica will never see is 425 TXID_NOT_AVAILABLE", async () => {
    const { primary, replica } = await pair()
    const written = await query(primary, "acme", "insert into t (v) values ('one')")
    await untilSynced(primary, replica, "acme")

    const response = await replica.fetch("/v1/db/acme/query", {
      method: "POST",
      headers: { [HEADERS.minTxid]: String(written.txid + 100) },
      body: JSON.stringify({ sql: "select v from t", waitMs: 50 }),
    })
    expect(response.status).toBe(425)
    const body = (await response.json()) as ErrorBody & { error: { txid?: number } }
    expect(body.error.code).toBe("TXID_NOT_AVAILABLE")
    expect(body.error.txid).toBe(written.txid)
  })

  test("every response on both nodes carries the node, role and txid headers", async () => {
    const { primary, replica } = await pair()
    for (const [node, role] of [
      [primary, "primary"],
      [replica, "replica"],
    ] as const) {
      const response = await post(node, "/v1/db/acme/query", { sql: "select 1" })
      expect(response.headers.get(HEADERS.role)).toBe(role)
      expect(response.headers.get(HEADERS.node)).toBe(role === "primary" ? "primary" : "replica")
      expect(Number(response.headers.get(HEADERS.txid))).toBeGreaterThanOrEqual(0)
      expect(response.headers.get(HEADERS.primary)).toBe(
        role === "replica" ? primary.replicationUrl : null,
      )
    }
  })
})
