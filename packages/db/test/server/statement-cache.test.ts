// P7. `[sqlite] statementCache` and `bql_statement_cache_*` end to end: that the config key
// reaches the connections a tenant opens, and that the three counters a node exports are the
// thing an operator would alert on. The driver's own behaviour is `test/sqlite/cache.test.ts`;
// this is the wiring between it and `/metrics`.

import { afterAll, expect, test } from "bun:test"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

afterAll(stopAll)

async function counters(server: TestServer): Promise<Record<string, number>> {
  const text = await (await server.fetch("/metrics")).text()
  const out: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const match = /^(bql_statement_cache_\w+)\{.*\} (\d+)$/.exec(line)
    if (match) out[match[1] as string] = Number(match[2])
  }
  return out
}

/** Sends `count` distinct SQL texts, each differing only in a bound-free literal. */
async function distinct(server: TestServer, db: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const response = await server.fetch(`/v1/db/${db}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: `select id, v from t where id >= ${i} limit 5` }),
    })
    expect(response.status).toBe(200)
  }
}

test("a small [sqlite] statementCache evicts, and /metrics says so", async () => {
  const server = await startTestServer({ sqlite: { statementCache: 4 } })
  await createDb(server, "small", "create table t (id integer primary key, v text)")

  const before = await counters(server)
  expect(before.bql_statement_cache_hits_total).toBeGreaterThanOrEqual(0)
  expect(before.bql_statement_cache_misses_total).toBeGreaterThan(0)

  await distinct(server, "small", 12)
  const after = await counters(server)
  // Twelve texts through a four-entry cache is eight evictions at the very least, and the read
  // path prepares each text twice (`.readonly`, then `step`), so it is more.
  expect(after.bql_statement_cache_evictions_total).toBeGreaterThan(
    (before.bql_statement_cache_evictions_total as number) + 6,
  )
  expect(after.bql_statement_cache_misses_total).toBeGreaterThan(
    before.bql_statement_cache_misses_total as number,
  )
})

test("the default 64 holds the same working set without evicting", async () => {
  const server = await startTestServer()
  await createDb(server, "roomy", "create table t (id integer primary key, v text)")

  const before = await counters(server)
  await distinct(server, "roomy", 12)
  const after = await counters(server)

  expect(after.bql_statement_cache_evictions_total).toBe(
    before.bql_statement_cache_evictions_total as number,
  )
  // Repeating them is all hits: the second pass adds no misses at all.
  const warm = { ...after }
  await distinct(server, "roomy", 12)
  const twice = await counters(server)
  expect(twice.bql_statement_cache_misses_total).toBe(warm.bql_statement_cache_misses_total as number)
  expect(twice.bql_statement_cache_hits_total).toBeGreaterThan(warm.bql_statement_cache_hits_total as number)
})
