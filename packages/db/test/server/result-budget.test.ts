// L1. `maxRows` used to be checked on `rows.length` after `values()` had materialised everything,
// so the ceiling described a result the node had already paid for. What is asserted here is the
// thing that changes: refusing a five-million-row scan costs a bounded amount of memory, not a
// five-million-row allocation followed by a 400. Peak RSS is the assertion, because the error
// alone was already correct before the fix.
//
// The generator is a recursive CTE rather than a real table: five million rows with nothing on
// disk, and read-only, so it takes the pooled-reader path an ordinary `SELECT` takes.

import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ErrorBody, QueryResult } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer({
    // Small enough that a modest query reaches it, large enough that the row ceiling is what a
    // plain scan hits first — the two halves are tested apart.
    limits: { maxResultBytes: 4 * 1024 * 1024 },
  })
  await createDb(server, "big", "create table kept (id integer primary key, v text)")
})
afterAll(stopAll)

/** `n` rows of one integer column, generated rather than stored. */
const series = (n: number): string =>
  `with recursive r(i) as (select 1 union all select i + 1 from r where i < ${n}) select i from r`

const post = (body: Record<string, unknown>): Promise<Response> =>
  server.fetch("/v1/db/big/query", { method: "POST", body: JSON.stringify(body) })

const query = (sql: string, extra: Record<string, unknown> = {}): Promise<QueryResult> =>
  server.json<QueryResult>("/v1/db/big/query", {
    method: "POST",
    body: JSON.stringify({ sql, ...extra }),
  })

test("a five-million-row scan is refused in bounded memory", async () => {
  // Warm the path once so the first-call allocations (row factory, buffers) are not charged to
  // the measurement, then settle.
  await post({ sql: series(10), maxRows: 5 })
  Bun.gc(true)
  const before = process.memoryUsage.rss()

  const response = await post({ sql: series(5_000_000), maxRows: 10_000 })
  expect(response.status).toBe(400)
  expect(((await response.json()) as ErrorBody).error.code).toBe("TOO_MANY_ROWS")

  Bun.gc(true)
  const grewMb = (process.memoryUsage.rss() - before) / 1024 / 1024
  // 10 001 rows of one integer is well under a megabyte. Five million is hundreds. The bound is
  // set loosely enough that a GC that has not run yet cannot fail it, and tightly enough that
  // materialising the whole result cannot pass it.
  expect(grewMb).toBeLessThan(100)
})

test("a result at maxRows is served and the next row past it is refused", async () => {
  expect((await query(series(1000), { maxRows: 1000 })).rows.length).toBe(1000)
  const over = await post({ sql: series(1001), maxRows: 1000 })
  expect(over.status).toBe(400)
})

test("a result past maxResultBytes is 413 RESULT_TOO_LARGE", async () => {
  // Rows the row ceiling would never stop: 2048 of them, each a 4 KiB blob, is 8 MiB against a
  // 4 MiB node ceiling.
  const fat =
    "with recursive r(i) as (select 1 union all select i + 1 from r where i < 2048) " +
    "select i, randomblob(4096) from r"
  const response = await post({ sql: fat, maxRows: 100_000 })
  expect(response.status).toBe(413)
  const body = (await response.json()) as ErrorBody
  expect(body.error.code).toBe("RESULT_TOO_LARGE")
  expect(body.error.message).toContain(String(4 * 1024 * 1024))
})

test("a write refused at the ceiling rolls back", async () => {
  await query("delete from kept")
  const before = (await query("select count(*) from kept")).rows[0] as [number]
  expect(before[0]).toBe(0)

  // The insert would succeed; RETURNING is what crosses the ceiling, and the throw comes from
  // inside `tenant.write`, which rolls the transaction back.
  const refused = await post({
    sql: `insert into kept (v) select 'x' from (${series(5000)}) returning id, v`,
    maxRows: 100,
  })
  expect(refused.status).toBe(400)
  expect(((await refused.json()) as ErrorBody).error.code).toBe("TOO_MANY_ROWS")

  const after = (await query("select count(*) from kept")).rows[0] as [number]
  expect(after[0]).toBe(0)
})

test("the largest result built is reported as bunql_result_bytes_max", async () => {
  await query("select i, randomblob(512) from (" + series(200) + ")", { maxRows: 1000 })
  const metrics = await (await server.fetch("/metrics")).text()
  const line = metrics.split("\n").find((l) => l.startsWith("bunql_result_bytes_max{"))
  expect(line).toBeDefined()
  expect(Number(line?.split(" ").pop())).toBeGreaterThan(100_000)
})
