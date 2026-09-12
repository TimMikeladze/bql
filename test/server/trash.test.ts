// The trash sweep as the server actually runs it: `[durability] retention` governs how long a
// deleted database survives in `<dataDir>/trash/`, and the runtime sweeps once at start so a node
// that was down past its retention comes back clean rather than waiting an hour for the first
// interval.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_CONFIG, loadConfig } from "../../src/server/config.ts"
import { trashDir } from "../../src/tenant/index.ts"
import { startTestServer, stopAll, tempDataDir } from "./harness.ts"

afterAll(stopAll)

describe("trash retention", () => {
  test("the interval has a default and a canonical environment override", () => {
    expect(DEFAULT_CONFIG.durability.trashSweepIntervalMs).toBe(3_600_000)
    expect(DEFAULT_CONFIG.durability.retention).toBe("7d")

    const config = loadConfig({
      env: { BUNQL_DURABILITY_TRASH_SWEEP_INTERVAL_MS: "60000", BUNQL_RETENTION: "1h" },
    })
    expect(config.durability.trashSweepIntervalMs).toBe(60_000)
    expect(config.durability.retention).toBe("1h")

    // A typo in a duration is refused at start rather than quietly keeping everything for ever.
    expect(() => loadConfig({ env: { BUNQL_RETENTION: "7 days" } })).toThrow()
  })

  test("a server sweeps the trash it finds at start", async () => {
    const dir = tempDataDir("bunql-trash-server-")
    const stale = path.join(trashDir(dir), `acme-${Date.now() - 3 * 86_400_000}`)
    const fresh = path.join(trashDir(dir), `beta-${Date.now()}`)
    for (const one of [stale, fresh]) fs.mkdirSync(one, { recursive: true })

    const server = await startTestServer({
      data: { dir },
      durability: { retention: "1d" },
    })
    try {
      expect(fs.existsSync(stale)).toBe(false)
      expect(fs.existsSync(fresh)).toBe(true)
    } finally {
      await server.close()
    }
  })

  test('retention "0" keeps a deleted database for ever', async () => {
    const server = await startTestServer({ durability: { retention: "0" } })
    try {
      await server.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
      const deleted = await server.json<{ trash: string }>("/v1/db/acme", { method: "DELETE" })
      expect(fs.existsSync(deleted.trash)).toBe(true)
      // Sweeping by hand with the same setting is still a no-op, not a removal.
      expect(server.handle.registry.sweepTrash(0).removed).toEqual([])
      expect(fs.existsSync(deleted.trash)).toBe(true)
    } finally {
      await server.close()
    }
  })
})
