import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CloudRuntime, initializeCloud, type CloudOperation } from "../../packages/db/src/cloud/runtime.ts"
import { AuthKeys } from "../../packages/db/src/server/auth.ts"
import { loadConfig } from "../../packages/db/src/server/config.ts"
import { StoreOutcomeUnknown, type ObjectStore } from "../../packages/db/src/storage/object-store.ts"

/** Real provider persists the CAS, then this transport boundary loses its reply.
 * Unique roots are retained. This is opt-in through the calling smoke runner. */
export async function qualifyAmbiguousRecovery(source: ObjectStore) {
  const deploymentId = `fault-${crypto.randomUUID()}`, directory = await mkdtemp(join(tmpdir(), "bql-provider-fault-"))
  const config = loadConfig({ env: {}, overrides: { data: { dir: join(directory, "cache") }, auth: { adminKey: "qualification", jwtKey: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64") } } })
  let loseResponse = false, dropped = false
  const store: ObjectStore = {
    get: (...args) => source.get(...args), create: (...args) => source.create(...args),
    async replace(...args) {
      const result = await source.replace(...args)
      if (loseResponse) { loseResponse = false; dropped = true; throw new StoreOutcomeUnknown() }
      return result
    },
  }
  const open = () => CloudRuntime.open({ store, deploymentId, config, requestTimeoutMs: 120_000 })
  const run = (runtime: CloudRuntime, operation: CloudOperation, key?: string) => runtime.run({ request: new Request("http://localhost", { headers: { authorization: "Bearer qualification", ...(key ? { "idempotency-key": key } : {}) } }) }, operation)
  const operation: CloudOperation = { kind: "query", db: "check", body: { sql: "INSERT INTO items VALUES (1)" } }
  let runtime: CloudRuntime | undefined
  try {
    await initializeCloud(store, deploymentId, config)
    runtime = await open()
    await run(runtime, { kind: "createDatabase", body: { name: "check" } })
    await run(runtime, { kind: "query", db: "check", body: { sql: "CREATE TABLE items (id INTEGER PRIMARY KEY)" } })
    loseResponse = true
    let unknown = false
    try { await run(runtime, operation, "lost-response") }
    catch (error) { if ((error as { code?: string }).code !== "COMMIT_UNKNOWN") throw error; unknown = true }
    if (!dropped || !unknown) throw new Error("Expected an explicitly uncertain commit result")
    await runtime.close(); runtime = undefined
    await rm(config.data.dir, { recursive: true, force: true })
    runtime = await open()
    if ((await run(runtime, operation, "lost-response")).status !== 200) throw new Error("Could not resolve saved result")
    const read = await (await run(runtime, { kind: "query", db: "check", body: { sql: "SELECT id FROM items" } })).json() as { rows: number[][] }
    if (JSON.stringify(read.rows) !== "[[1]]") throw new Error("Recovery replayed or lost the acknowledged mutation")
    return { deploymentId, checks: ["lost-root-response", "empty-disk-recovery", "same-key-resolution"] }
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }) }
}
