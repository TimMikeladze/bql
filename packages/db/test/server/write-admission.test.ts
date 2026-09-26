// L2 over a real listener: what a client actually receives when a database's write queue is full.
// The tenant-level guarantees are pinned in `test/tenant/write-admission.test.ts`; this is the
// wire contract — a 503 with a code, a `Retry-After` a client can act on, and a node that is still
// answering everything else.

import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ErrorBody, QueryResult } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer({
    // One statement per transaction and a queue of four, so a burst of ordinary writes reaches
    // the ceiling without needing a stalled disk to simulate one.
    limits: { groupCommitMax: 1, maxQueuedWrites: 4 },
  })
  await createDb(server, "acme", "create table t (id integer primary key, v integer)")
})
afterAll(stopAll)

const write = (i: number): Promise<Response> =>
  server.fetch("/v1/db/acme/query", {
    method: "POST",
    body: JSON.stringify({ sql: "insert into t (v) values (?)", args: [i] }),
  })

test("a burst past the queue is refused with WRITE_QUEUE_FULL and a Retry-After", async () => {
  const responses = await Promise.all(Array.from({ length: 64 }, (_, i) => write(i)))
  const refused = responses.filter((r) => r.status === 503)
  const accepted = responses.filter((r) => r.status === 200)
  expect(refused.length).toBeGreaterThan(0)
  expect(accepted.length + refused.length).toBe(64)

  const body = (await refused[0]!.json()) as ErrorBody
  expect(body.error.code).toBe("WRITE_QUEUE_FULL")
  expect(body.error.status).toBe(503)
  // The hint is on the header and in the body, because a WebSocket client has no headers.
  expect(Number(refused[0]!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
  expect((body.error as unknown as { retryAfterSec: number }).retryAfterSec).toBeGreaterThanOrEqual(1)

  // A refusal is not a partial write: the rows in the table are exactly the writes that were
  // answered 200, and reads are unaffected throughout.
  const counted = await server.json<QueryResult>("/v1/db/acme/query", {
    method: "POST",
    body: JSON.stringify({ sql: "select count(*) from t" }),
  })
  expect((counted.rows[0] as [number])[0]).toBe(accepted.length)
})

test("the refusals are counted and the queue is reported empty again", async () => {
  const metrics = await (await server.fetch("/metrics")).text()
  const value = (name: string): number =>
    Number(
      metrics
        .split("\n")
        .find((line) => line.startsWith(`${name}{`))
        ?.split(" ")
        .pop(),
    )
  expect(value("bql_write_queue_rejected_total")).toBeGreaterThan(0)
  expect(value("bql_write_queue_depth")).toBe(0)
})
