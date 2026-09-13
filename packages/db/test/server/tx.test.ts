// Baton transactions over HTTP (design §6.3). The thing worth testing is not that a commit works
// but that the writer is never left held: by a second client, by a crash, or by a client that
// walks away.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ErrorBody, QueryResult, TxBeginResult } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  // A short queue wait so the `TX_BUSY` case does not have to outlast a real one, and an idle
  // timeout longer than it so a queued transaction is refused by the queue rather than served by
  // the holder's leash expiring.
  server = await startTestServer({ limits: { txIdleTimeoutMs: 300, txWaitMs: 100 } })
  await createDb(server, "acme", "create table t(id integer primary key, v text)")
})
afterAll(stopAll)

function begin(mode?: string): Promise<Response> {
  return server.fetch("/v1/db/acme/tx", {
    method: "POST",
    body: JSON.stringify(mode ? { mode } : {}),
  })
}

function count(): Promise<number> {
  return server
    .json<QueryResult>("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
    })
    .then((result) => Number((result.rows[0] as number[])[0]))
}

describe("baton transactions", () => {
  test("statements inside a transaction are invisible until it commits", async () => {
    const before = await count()
    const { tx } = (await (await begin()).json()) as TxBeginResult
    await server.fetch(`/v1/db/acme/tx/${tx}`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('inside')" }),
    })
    expect(await count()).toBe(before)
    const committed = await server.fetch(`/v1/db/acme/tx/${tx}/commit`, { method: "POST" })
    expect(committed.status).toBe(200)
    expect(((await committed.json()) as { txid: number }).txid).toBeGreaterThan(0)
    expect(await count()).toBe(before + 1)
  })

  test("a rollback leaves nothing behind", async () => {
    const before = await count()
    const { tx } = (await (await begin()).json()) as TxBeginResult
    await server.fetch(`/v1/db/acme/tx/${tx}`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('doomed')" }),
    })
    expect((await server.fetch(`/v1/db/acme/tx/${tx}/rollback`, { method: "POST" })).status).toBe(200)
    expect(await count()).toBe(before)
  })

  test("a second transaction waits for the writer and is refused once the wait expires", async () => {
    const { tx } = (await (await begin()).json()) as TxBeginResult
    const startedMs = Date.now()
    const second = await begin()
    // It queued rather than failing on arrival: R5's finding, fixed on the server (R2).
    expect(Date.now() - startedMs).toBeGreaterThanOrEqual(90)
    expect(second.status).toBe(409)
    expect(second.headers.get("retry-after")).toBe("1")
    expect(((await second.json()) as ErrorBody).error.code).toBe("TX_BUSY")
    await server.fetch(`/v1/db/acme/tx/${tx}/rollback`, { method: "POST" })
  })

  test("two concurrent transactions on one database both commit, in order", async () => {
    const before = await count()
    const run = async (tag: string): Promise<number> => {
      const { tx } = (await (await begin()).json()) as TxBeginResult
      await server.fetch(`/v1/db/acme/tx/${tx}`, {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t(v) values (?)", args: [tag] }),
      })
      const committed = await server.fetch(`/v1/db/acme/tx/${tx}/commit`, { method: "POST" })
      expect(committed.status).toBe(200)
      return ((await committed.json()) as { txid: number }).txid
    }
    // Both start before either has the writer; the loser waits its turn instead of failing.
    const [first, second] = await Promise.all([run("first"), run("second")])
    expect(Math.abs(first - second)).toBe(1)
    expect(await count()).toBe(before + 2)
  })

  test("a plain write waits for nothing and is refused while a transaction holds the writer", async () => {
    const { tx } = (await (await begin()).json()) as TxBeginResult
    const blocked = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('blocked')" }),
    })
    expect(blocked.status).toBe(409)
    // Reads keep working: they never touch the writer.
    expect(
      (
        await server.fetch("/v1/db/acme/query", {
          method: "POST",
          body: JSON.stringify({ sql: "select 1" }),
        })
      ).status,
    ).toBe(200)
    await server.fetch(`/v1/db/acme/tx/${tx}/rollback`, { method: "POST" })
  })

  test("an idle transaction is rolled back and its baton stops working", async () => {
    const before = await count()
    const { tx } = (await (await begin()).json()) as TxBeginResult
    await server.fetch(`/v1/db/acme/tx/${tx}`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('abandoned')" }),
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const late = await server.fetch(`/v1/db/acme/tx/${tx}`, {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(late.status).toBe(404)
    expect(await count()).toBe(before)
    // And the writer is free again.
    const next = await begin()
    expect(next.status).toBe(200)
    const { tx: second } = (await next.json()) as TxBeginResult
    await server.fetch(`/v1/db/acme/tx/${second}/rollback`, { method: "POST" })
  })

  test("an unknown baton is a 404", async () => {
    const response = await server.fetch("/v1/db/acme/tx/deadbeef", {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as ErrorBody).error.code).toBe("TX_NOT_FOUND")
  })

  test("a failing statement leaves the transaction open so the client can decide", async () => {
    const { tx } = (await (await begin()).json()) as TxBeginResult
    const failed = await server.fetch(`/v1/db/acme/tx/${tx}`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into nowhere values (1)" }),
    })
    expect(failed.status).toBe(400)
    const recovered = await server.fetch(`/v1/db/acme/tx/${tx}`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('after the error')" }),
    })
    expect(recovered.status).toBe(200)
    expect((await server.fetch(`/v1/db/acme/tx/${tx}/commit`, { method: "POST" })).status).toBe(200)
  })

  test("a deferred transaction is accepted and commits", async () => {
    const response = await begin("deferred")
    expect(response.status).toBe(200)
    const { tx, expiresInMs } = (await response.json()) as TxBeginResult
    expect(expiresInMs).toBe(300)
    await server.fetch(`/v1/db/acme/tx/${tx}`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('deferred')" }),
    })
    expect((await server.fetch(`/v1/db/acme/tx/${tx}/commit`, { method: "POST" })).status).toBe(200)
  })

  test("transactions on different databases do not collide", async () => {
    await createDb(server, "beta", "create table b(id integer primary key)")
    const first = (await (await begin()).json()) as TxBeginResult
    const second = await server.fetch("/v1/db/beta/tx", { method: "POST", body: "{}" })
    expect(second.status).toBe(200)
    const other = (await second.json()) as TxBeginResult
    await server.fetch(`/v1/db/acme/tx/${first.tx}/rollback`, { method: "POST" })
    await server.fetch(`/v1/db/beta/tx/${other.tx}/rollback`, { method: "POST" })
  })
})
