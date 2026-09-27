import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { CloudRuntime, initializeCloud, type CloudOperation } from "../../src/cloud/runtime.ts"
import { StoreOutcomeUnknown, StoreUnavailable } from "../../src/storage/object-store.ts"
import { AuthKeys } from "../../src/server/auth.ts"
import { loadConfig } from "../../src/server/config.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { cleanup, tempDir } from "../storage/harness.ts"
afterEach(cleanup)
const run = (runtime: CloudRuntime, operation: CloudOperation, key?: string) => runtime.run({ request: new Request("http://localhost", { headers: { authorization: "Bearer admin", ...(key ? { "idempotency-key": key } : {}) } }) }, operation)
const query = (sql: string): CloudOperation => ({ kind: "query", db: "acme", body: { sql } })

test("every upload/publication cut point and dropped response recovers acknowledged SQL exactly once", async () => {
  const jwtKey = Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64")
  let boundaryCount = 0
  for (const mode of ["measure", "before", "after"] as const) {
    for (let cut = 1; cut <= (mode === "measure" ? 1 : boundaryCount); cut++) {
      const store = new FakeObjectStore()
      const config = loadConfig({ env: {}, overrides: { data: { dir: tempDir() }, auth: { adminKey: "admin", jwtKey } } })
      await initializeCloud(store, "chaos", config)
      let runtime = await CloudRuntime.open({ store, deploymentId: "chaos", config })
      try {
        await run(runtime, { kind: "createDatabase", body: { name: "acme" } })
        await run(runtime, query("create table items (id integer primary key)"))
        await run(runtime, query("insert into items values (1)"), "baseline")
        let writes = 0
        const create = store.create.bind(store), replace = store.replace.bind(store)
        const fault = async <T>(write: () => Promise<T>) => {
          const atCut = ++writes === cut
          if (atCut && mode === "before") throw new StoreUnavailable()
          const result = await write()
          if (atCut && mode === "after") throw new StoreOutcomeUnknown()
          return result
        }
        store.create = (...args) => fault(() => create(...args))
        store.replace = (...args) => fault(() => replace(...args))
        let acknowledged = false
        try { acknowledged = (await run(runtime, query("insert into items values (2)"), "candidate")).status === 200 }
        catch { /* Intentional uncertain/unavailable boundary. */ }
        if (mode === "measure") boundaryCount = writes
        store.create = create; store.replace = replace
        await runtime.close()
        rmSync(config.data.dir, { recursive: true, force: true })
        runtime = await CloudRuntime.open({ store, deploymentId: "chaos", config })
        const recovered = await (await run(runtime, query("select id from items order by id"))).json() as { rows: number[][] }
        expect(recovered.rows[0]).toEqual([1])
        if (acknowledged) expect(recovered.rows).toEqual([[1], [2]])
        else expect([JSON.stringify([[1]]), JSON.stringify([[1], [2]])]).toContain(JSON.stringify(recovered.rows))
        // Resolve the original identity: a committed candidate must not execute twice.
        expect((await run(runtime, query("insert into items values (2)"), "candidate")).status).toBe(200)
        expect((await (await run(runtime, query("select count(*) from items"))).json() as { rows: number[][] }).rows).toEqual([[2]])
      } finally { await runtime.close() }
    }
  }
  expect(boundaryCount).toBeGreaterThanOrEqual(4)
})
