import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import { CloudRuntime, initializeCloud, type CloudOperation } from "../../src/cloud/runtime.ts"
import { AuthKeys } from "../../src/server/auth.ts"
import { loadConfig } from "../../src/server/config.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { cleanup, tempDir } from "../storage/harness.ts"

const runtimes: CloudRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); cleanup() })
async function setup() {
  const store = new FakeObjectStore()
  const jwtKey = Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64")
  const config = loadConfig({ env: {}, overrides: { data: { dir: tempDir() }, auth: { adminKey: "test-admin", jwtKey }, server: { workers: 1 } } })
  await initializeCloud(store, "test", config)
  const open = async () => { const runtime = await CloudRuntime.open({ store, deploymentId: "test", config }); runtimes.push(runtime); return runtime }
  const runtime = await open()
  return { store, config, open, runtime }
}
function run(runtime: CloudRuntime, operation: CloudOperation, key?: string, token = "test-admin") {
  return runtime.run({ request: new Request("http://localhost", { headers: { authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) } }) }, operation)
}
async function query(runtime: CloudRuntime, sql: string, key?: string) {
  return run(runtime, { kind: "query", db: "acme", body: { sql } }, key)
}

test("cloud SQL and catalog survive removal of every local file, and replay keys do not rerun SQL", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  await run(f.runtime, { kind: "batch", db: "acme", body: { atomic: true, statements: [{ sql: "create table items (id integer primary key, value text)" }, { sql: "insert into items values (1, 'kept')" }] } })
  await query(f.runtime, "insert into items values (2, 'once')", "same-key")
  const first = await query(f.runtime, "insert into items values (2, 'once')", "same-key")
  expect(first.status).toBe(200)
  await f.runtime.close()
  fs.rmSync(f.config.data.dir, { recursive: true, force: true })
  const recovered = await f.open()
  const read = await query(recovered, "select value from items order by id")
  expect((await read.json() as { rows: unknown[] }).rows).toEqual([["kept"], ["once"]])
  const list = await run(recovered, { kind: "listDatabases" })
  expect((await list.json() as { databases: { name: string }[] }).databases[0]!.name).toBe("acme")
})

test("failed publication discards tentative SQL even with local acknowledgement", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  await query(f.runtime, "create table items (id integer)")
  const replace = f.store.replace.bind(f.store)
  f.store.replace = async () => { throw new Error("offline") }
  await expect(run(f.runtime, { kind: "query", db: "acme", body: { sql: "insert into items values (1)", ack: "local" } })).rejects.toThrow()
  expect(f.runtime.phase).not.toBe("ready")
  f.store.replace = replace
  expect((await (await query(f.runtime, "select count(*) from items")).json() as { rows: unknown[] }).rows).toEqual([[0]])
})

test("token revocations persist and are checked before returning a saved request result", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  await query(f.runtime, "create table items (id integer)")
  const minted = await (await run(f.runtime, { kind: "mintToken", body: { db: "acme", scope: "rw" } })).json() as { token: string; jti: string }
  const operation: CloudOperation = { kind: "query", db: "acme", body: { sql: "insert into items values (1)" } }
  await run(f.runtime, operation, "token-write", minted.token)
  await run(f.runtime, { kind: "revokeToken", jti: minted.jti })
  await f.runtime.close()
  const recovered = await f.open()
  await expect(run(recovered, operation, "token-write", minted.token)).rejects.toThrow("revoked")
})

test("unsupported batches, session SQL and replica acknowledgements fail before persistent effects", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  for (const operation of [
    { kind: "batch", db: "acme", body: { atomic: false, statements: [{ sql: "create table forbidden (id)" }] } },
    { kind: "query", db: "acme", body: { sql: "BEGIN" } },
    { kind: "query", db: "acme", body: { sql: "create temp table forbidden (id)" } },
    { kind: "query", db: "acme", body: { sql: "pragma foreign_keys = off" } },
    { kind: "query", db: "acme", body: { sql: "create table forbidden (id)", ack: "replica" } },
  ] as CloudOperation[]) await expect(run(f.runtime, operation)).rejects.toMatchObject({ code: "CLOUD_UNSUPPORTED" })
  expect((await (await query(f.runtime, "select name from sqlite_schema where name = 'forbidden'")).json() as { rows: unknown[] }).rows).toEqual([])
})

test("blocked publication exposes no tentative rows locally or to another warm instance", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  await query(f.runtime, "create table items (id integer)")
  const other = await f.open()
  let entered!: () => void
  const atPublication = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const replace = f.store.replace.bind(f.store)
  f.store.replace = async (...args) => { entered(); await blocked; return replace(...args) }
  const write = query(f.runtime, "insert into items values (1)")
  await atPublication
  let readerFinished = false
  const reader = query(f.runtime, "select count(*) from items").then(response => { readerFinished = true; return response })
  const remote = await (await query(other, "select count(*) from items")).json() as { rows: unknown[] }
  expect(remote.rows).toEqual([[0]])
  expect(readerFinished).toBe(false)
  release()
  await write
  expect((await (await reader).json() as { rows: unknown[] }).rows).toEqual([[1]])
  // The second instance has a warm older cache; its next read must refresh.
  expect((await (await query(other, "select count(*) from items")).json() as { rows: unknown[] }).rows).toEqual([[1]])
})

test("an unknown CAS outcome is recoverable by repeating the same authorized request", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  await query(f.runtime, "create table items (id integer)")
  const replace = f.store.replace.bind(f.store)
  f.store.replace = async (...args) => { f.store.dropNextWriteResponse = true; return replace(...args) }
  await expect(query(f.runtime, "insert into items values (1)", "recover-me")).rejects.toMatchObject({ code: "COMMIT_UNKNOWN", requestId: "recover-me" })
  f.store.replace = replace
  expect((await query(f.runtime, "insert into items values (1)", "recover-me")).status).toBe(200)
  expect((await (await query(f.runtime, "select count(*) from items")).json() as { rows: unknown[] }).rows).toEqual([[1]])
})

test("two instances racing from the same root commit once; the loser discards its cache", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  await query(f.runtime, "create table items (id integer)")
  const other = await f.open()
  let arrived = 0
  let release!: () => void
  const both = new Promise<void>(resolve => { release = resolve })
  const replace = f.store.replace.bind(f.store)
  f.store.replace = async (...args) => { if (++arrived === 2) release(); await both; return replace(...args) }
  const writes = await Promise.allSettled([query(f.runtime, "insert into items values (1)"), query(other, "insert into items values (2)")])
  expect(writes.filter(result => result.status === "fulfilled")).toHaveLength(1)
  expect((writes.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code).toBe("CLOUD_CONFLICT")
  for (const runtime of [f.runtime, other]) expect((await (await query(runtime, "select count(*) from items")).json() as { rows: unknown[] }).rows).toEqual([[1]])
})

test("legal names matching Object prototype properties remain ordinary database names", async () => {
  const f = await setup()
  await run(f.runtime, { kind: "createDatabase", body: { name: "acme" } })
  await expect(run(f.runtime, { kind: "query", db: "constructor", body: { sql: "select 1" } })).rejects.toMatchObject({ code: "DB_NOT_FOUND" })
  await run(f.runtime, { kind: "createDatabase", body: { name: "constructor" } })
  expect((await run(f.runtime, { kind: "query", db: "constructor", body: { sql: "select 1" } })).status).toBe(200)
})
