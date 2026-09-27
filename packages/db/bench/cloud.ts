import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CloudRuntime, initializeCloud, type CloudOperation } from "../src/cloud/runtime.ts"
import { AuthKeys } from "../src/server/auth.ts"
import { loadConfig } from "../src/server/config.ts"
import type { ObjectStore } from "../src/storage/object-store.ts"
import { S3ObjectStore } from "../src/storage/s3-object-store.ts"
import { FakeObjectStore } from "../test/cloud/fake-store.ts"

/** Counts protocol traffic, including failed attempts; excludes SDK-internal HTTP overhead. */
export function meterStore(store: ObjectStore) {
  const counts = { get: 0, create: 0, replace: 0, downloadedBytes: 0, uploadedBytes: 0 }
  const objects = new Map<string, number>()
  const metered: ObjectStore = {
    async get(key, signal) { counts.get++; const value = await store.get(key, signal); if (value) counts.downloadedBytes += value.body.byteLength; return value },
    async create(key, body, signal) { counts.create++; counts.uploadedBytes += body.byteLength; const result = await store.create(key, body, signal); objects.set(key, body.byteLength); return result },
    async replace(key, version, body, signal) { counts.replace++; counts.uploadedBytes += body.byteLength; const result = await store.replace(key, version, body, signal); objects.set(key, body.byteLength); return result },
  }
  return { store: metered, counts, retained: () => ({ objects: objects.size, bytes: [...objects.values()].reduce((a, b) => a + b, 0) }) }
}
const ms = (start: number) => Math.round((performance.now() - start) * 100) / 100

export async function benchmarkCloud(source: ObjectStore, provider: string, sizes = [0, 100, 8192]) {
  const results: unknown[] = []
  for (const rows of sizes) {
    const directory = await mkdtemp(join(tmpdir(), "bql-cloud-bench-")), deploymentId = `bench-${crypto.randomUUID()}`
    const measured = meterStore(source), store = measured.store
    const config = loadConfig({ env: {}, overrides: { data: { dir: join(directory, "cache") }, auth: { adminKey: "bench-admin", jwtKey: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64") } } })
    const open = (dir = config.data.dir) => CloudRuntime.open({ store, deploymentId, config: { ...config, data: { ...config.data, dir } }, requestTimeoutMs: 120_000 })
    const run = (runtime: CloudRuntime, operation: CloudOperation, key?: string) => runtime.run({ request: new Request("http://localhost", { headers: { authorization: "Bearer bench-admin", ...(key ? { "idempotency-key": key } : {}) } }) }, operation)
    const query = (sql: string): CloudOperation => ({ kind: "query", db: "bench", body: { sql } })
    let runtime: CloudRuntime | undefined, other: CloudRuntime | undefined
    try {
      await initializeCloud(store, deploymentId, config)
      runtime = await open()
      await run(runtime, { kind: "createDatabase", body: { name: "bench" } })
      await run(runtime, query("create table items (id integer primary key, payload blob)"))
      const writeStart = performance.now()
      if (rows) await run(runtime, query(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${rows}) INSERT INTO items SELECT n, randomblob(1024) FROM seq`), "seed")
      const writeMs = ms(writeStart)
      await runtime.close(); runtime = undefined
      await rm(config.data.dir, { recursive: true, force: true })
      const beforeRestore = { ...measured.counts }, coldStart = performance.now()
      runtime = await open()
      const restored = await (await run(runtime, query("select count(*) from items"))).json() as { rows: number[][] }
      if (restored.rows[0]?.[0] !== rows) throw new Error("Benchmark recovery lost rows")
      const coldMs = ms(coldStart), restoreBytes = measured.counts.downloadedBytes - beforeRestore.downloadedBytes, restoreGets = measured.counts.get - beforeRestore.get
      const warm: number[] = []
      for (let i = 0; i < 5; i++) { const start = performance.now(); await run(runtime, query("select count(*) from items")); warm.push(ms(start)) }
      other = await open(join(directory, "other"))
      const contentionStart = performance.now()
      const writes = await Promise.allSettled([
        run(runtime, query("insert into items values (-1, randomblob(1024))"), "writer-a"),
        run(other, query("insert into items values (-2, randomblob(1024))"), "writer-b"),
      ])
      const successes = writes.filter(result => result.status === "fulfilled" && result.value.status === 200).length
      const rejected = writes.filter(result => result.status === "rejected").map(result => (result.reason as { code?: string }).code ?? "unknown")
      const contentionMs = ms(contentionStart)
      await runtime.close(); runtime = undefined; await other.close(); other = undefined
      await rm(config.data.dir, { recursive: true, force: true })
      runtime = await open()
      const finalRows = await (await run(runtime, query("select count(*) from items"))).json() as { rows: number[][] }
      if (finalRows.rows[0]?.[0] !== rows + successes) throw new Error("Benchmark contention acknowledgement mismatch")
      results.push({ deploymentId, rows, payloadBytes: rows * 1024, writeMs, coldMs, restoreBytes, restoreGets, warmMs: warm, contention: { writers: 2, successes, rejected, elapsedMs: contentionMs }, operations: { ...measured.counts }, retained: measured.retained() })
    } finally { await runtime?.close(); await other?.close(); await rm(directory, { recursive: true, force: true }) }
  }
  return { version: 1, provider, measuredAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, bun: Bun.version, location: "local process; remote object store when selected", requestBudgetMs: 120_000, results }
}

if (import.meta.main) {
  const provider = Bun.argv[Bun.argv.indexOf("--provider") + 1] ?? "fake"
  const selected = Bun.argv.includes("--provider") ? provider : "fake"
  if (!["fake", "r2", "blob"].includes(selected)) throw new Error("Use --provider fake|r2|blob")
  if (selected !== "fake" && process.env.BQL_BILLABLE_TESTS !== "1") throw new Error("Set BQL_BILLABLE_TESTS=1 to authorize storage requests; benchmark objects are retained")
  let store: ObjectStore
  if (selected === "fake") store = new FakeObjectStore()
  else if (selected === "r2") {
    for (const key of ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) if (!process.env[key]) throw new Error(`Missing ${key}`)
    store = new S3ObjectStore({ bucket: process.env.S3_BUCKET!, endpoint: process.env.S3_ENDPOINT!, accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!, region: process.env.S3_REGION ?? "auto" })
  } else {
    if (!process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_RETRIES !== "0") throw new Error("Set BLOB_READ_WRITE_TOKEN and VERCEL_BLOB_RETRIES=0")
    const { BlobObjectStore } = await import("../../../deploy/vercel/blob-store.ts")
    store = new BlobObjectStore(process.env.BLOB_READ_WRITE_TOKEN)
  }
  console.log(JSON.stringify(await benchmarkCloud(store, selected), null, 2))
}
