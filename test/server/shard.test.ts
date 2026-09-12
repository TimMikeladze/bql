// The one function the router and every worker agree on (`docs/c4-workers.md` §3). If these two
// disagreed about a name, two threads would open the same database file for writing.

import { describe, expect, test } from "bun:test"
import { MAX_AUTO_WORKERS, resolveWorkers, shardOf } from "../../src/server/workers/shard.ts"

describe("shardOf", () => {
  test("one worker owns everything", () => {
    for (const name of ["a", "acme", "", "…", "x".repeat(200)]) {
      expect(shardOf(name, 1)).toBe(0)
    }
  })

  test("is total and in range", () => {
    for (let n = 1; n <= 16; n++) {
      for (let i = 0; i < 500; i++) {
        const shard = shardOf(`db-${i}`, n)
        expect(Number.isInteger(shard)).toBe(true)
        expect(shard).toBeGreaterThanOrEqual(0)
        expect(shard).toBeLessThan(n)
      }
    }
  })

  test("is stable for one name and one worker count", () => {
    const first = shardOf("acme", 7)
    for (let i = 0; i < 100; i++) expect(shardOf("acme", 7)).toBe(first)
    // Nothing persists a shard number, so it may move when the count changes; only the agreement
    // between the two sides of the channel at one count has to hold.
    expect(shardOf(`${"ac"}me`, 7)).toBe(first)
  })

  test("spreads a realistic name set well enough to be worth sharding", () => {
    const workers = 4
    const counts = new Array(workers).fill(0) as number[]
    for (let i = 0; i < 4000; i++) {
      const shard = shardOf(`tenant-${i}`, workers)
      counts[shard] = (counts[shard] as number) + 1
    }
    // A perfectly even split is 1000 each; anything inside ±15% means no shard carries the node.
    for (const count of counts) {
      expect(count).toBeGreaterThan(850)
      expect(count).toBeLessThan(1150)
    }
  })
})

describe("resolveWorkers", () => {
  test("1 stays 1", () => {
    expect(resolveWorkers(1)).toBe(1)
  })

  test("0 is one per core, capped", () => {
    const resolved = resolveWorkers(0)
    expect(resolved).toBeGreaterThanOrEqual(1)
    expect(resolved).toBeLessThanOrEqual(MAX_AUTO_WORKERS)
  })

  test("a fraction is floored and never below 1", () => {
    expect(resolveWorkers(3.9)).toBe(3)
    expect(resolveWorkers(-2)).toBe(1)
  })
})
