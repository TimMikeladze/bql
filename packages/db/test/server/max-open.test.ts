// L3. `[data] maxOpen` is the node's ceiling, not each thread's. Bun workers are threads sharing
// one file-descriptor table, so eight registries each honouring 1024 held 8192 databases and about
// 57 000 descriptors — while each thread independently warned about 7 168, under-reporting by
// exactly the worker count.
//
// The guarantee asserted here is the one an operator can check: whatever is thrown at it, a node
// started with `workers: N, maxOpen: M` holds at most M databases open across every shard, and
// `GET /v1/db` and `/metrics` say the same number.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { maxOpenShare, maxOpenThrashes } from "../../src/tenant/index.ts"
import { startTestServer, stopAll, type TestServer } from "./harness.ts"

const WORKERS = 4
/** Well past the ceiling, and enough per shard that the share is not the floor. */
const DATABASES = 60
const MAX_OPEN = 40
let server: TestServer

interface DbList {
  open: number
  maxOpen: number
  databases: { name: string; open: boolean }[]
}

beforeAll(async () => {
  server = await startTestServer({
    server: { workers: WORKERS },
    data: { maxOpen: MAX_OPEN },
  })
  // Well past the node ceiling, spread over four shards by the name hash.
  for (let i = 0; i < DATABASES; i++) {
    const created = await server.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: `d${i}` }),
    })
    if (created.status !== 201) throw new Error(`create d${i}: ${await created.text()}`)
    // Touching it is what opens it on its worker.
    await server.fetch(`/v1/db/d${i}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
  }
})
afterAll(stopAll)

test("the node's share per worker is the node budget divided, never repeated", () => {
  expect(maxOpenShare(MAX_OPEN, WORKERS)).toBe(MAX_OPEN / WORKERS)
  expect(maxOpenShare(1024, 8)).toBe(128)
  expect(maxOpenShare(1024, 1)).toBe(1024)
  // A budget too small to divide is still divided: a per-worker floor would be `floor * workers`
  // wearing a disguise, which is the thing this milestone deletes. It warns instead.
  expect(maxOpenShare(4, 8)).toBe(1)
  expect(maxOpenThrashes(4, 8)).toBe(true)
  expect(maxOpenThrashes(1024, 8)).toBe(false)
})

test("a node holds at most maxOpen databases open across every shard", async () => {
  const list = await server.json<DbList>("/v1/db")
  expect(list.maxOpen).toBe(MAX_OPEN)
  expect(list.databases.length).toBe(DATABASES)
  const open = list.databases.filter((one) => one.open).length
  expect(open).toBe(list.open)
  // Before L3 this was bounded by `maxOpen * workers`, which is the whole bug.
  expect(open).toBeLessThanOrEqual(MAX_OPEN)
})

test("GET /v1/db and /metrics agree on the total and on the ceiling", async () => {
  const list = await server.json<DbList>("/v1/db")
  const metrics = await (await server.fetch("/metrics")).text()
  const value = (name: string): number =>
    Number(
      metrics
        .split("\n")
        .find((line) => line.startsWith(`${name}{`))
        ?.split(" ")
        .pop(),
    )
  expect(value("bunql_max_open_tenants")).toBe(MAX_OPEN)
  expect(value("bunql_open_tenants")).toBe(list.open)
  expect(value("bunql_tenants")).toBe(list.databases.length)
})
