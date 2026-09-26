import { afterEach, expect, test } from "bun:test"
import { startCloudServer } from "../../src/cloud/server.ts"
import { initializeCloud } from "../../src/cloud/runtime.ts"
import { createClient } from "../../src/client/index.ts"
import { AuthKeys } from "../../src/server/auth.ts"
import { loadConfig } from "../../src/server/config.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { cleanup, tempDir } from "../storage/harness.ts"

const handles: Awaited<ReturnType<typeof startCloudServer>>[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); cleanup() })
async function start() {
  const store = new FakeObjectStore()
  const config = loadConfig({ env: {}, overrides: { server: { host: "127.0.0.1", port: 0 }, data: { dir: tempDir() }, auth: { adminKey: "test-admin", jwtKey: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64") } } })
  await initializeCloud(store, "test", config)
  const handle = await startCloudServer({ store, deploymentId: "test", config })
  handles.push(handle)
  return { store, handle, url: `http://127.0.0.1:${handle.server.port}` }
}

test("the existing client can create, write, query and delete through the cloud HTTP boundary", async () => {
  const { url } = await start()
  const client = createClient({ url, token: "test-admin" })
  try {
    await client.admin.create("acme")
    const response = await fetch(`${url}/v1/db/acme/batch`, { method: "POST", headers: { authorization: "Bearer test-admin", "content-type": "application/json", "idempotency-key": "setup" }, body: JSON.stringify({ atomic: true, statements: [{ sql: "create table items (id integer)" }, { sql: "insert into items values (42)" }] }) })
    expect(response.status).toBe(200)
    expect(response.headers.get("BQL-Durability")).toBe("remote")
    expect(response.headers.get("BQL-Generation")).toBeTruthy()
    const result = await client.db("acme").execute("select id from items")
    expect([...result]).toEqual([{ id: 42 }])
    await client.admin.delete("acme")
  } finally { client.close() }
})

test("unsupported protocols are rejected and malformed input keeps ordinary validation", async () => {
  const { url } = await start()
  for (const endpoint of ["/v1/ws", "/v1/replication", "/v2/pipeline", "/v1/db/acme/tx", "/v1/db/acme/api/items"]) {
    const response = await fetch(`${url}${endpoint}`, { method: "POST", headers: { authorization: "Bearer test-admin" } })
    expect(response.status).toBe(501)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("CLOUD_UNSUPPORTED")
  }
  const malformed = await fetch(`${url}/v1/db`, { method: "POST", headers: { authorization: "Bearer test-admin", "content-type": "application/json" }, body: '{"name":42}' })
  expect(malformed.status).toBe(400)
  const discovery = await fetch(`${url}/v1/cloud`)
  expect((await discovery.json() as { durability: string }).durability).toBe("remote")
})

test("every registered server operation is explicitly supported or rejected before execution", async () => {
  const { serverOperations } = await import("../../src/server/registry.ts")
  const { CLOUD_OPERATIONS } = await import("../../src/cloud/runtime.ts")
  const { url } = await start()
  for (const operation of serverOperations()) {
    if ([...CLOUD_OPERATIONS as readonly string[], "healthz", "readyz"].includes(operation.id)) continue
    const endpoint = operation.path.replace(/:[a-z]+/g, "unused")
    const response = await fetch(`${url}${endpoint}`, { method: operation.method.toUpperCase(), headers: { authorization: "Bearer test-admin" } })
    expect(response.status).toBe(501)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("CLOUD_UNSUPPORTED")
  }
})

test("client idempotency keys resolve uncertain commits without automatic SQL replay", async () => {
  const { url, store } = await start()
  const client = createClient({ url, token: "test-admin", consistency: "ryw" })
  try {
    await client.admin.create("acme")
    await client.db("acme").execute("create table items (id integer)")
    const original = store.replace.bind(store)
    let attempts = 0
    store.replace = async (...args) => {
      attempts++
      if (attempts === 1) store.dropNextWriteResponse = true
      return original(...args)
    }
    const write = async () => client.db("acme").execute("insert into items values (1)", [], { idempotencyKey: "sdk-write" })
    await expect(write()).rejects.toMatchObject({ code: "COMMIT_UNKNOWN", requestId: "sdk-write" })
    expect(attempts).toBe(1)
    await write()
    await write()
    expect(attempts).toBe(1)
    expect([...(await client.db("acme").execute("select count(*) as n from items"))]).toEqual([{ n: 1 }])
  } finally { client.close() }
})

test("read-your-writes rejects positions from a deleted database generation", async () => {
  const { url } = await start()
  const client = createClient({ url, token: "test-admin", consistency: "ryw" })
  try {
    await client.admin.create("acme")
    await client.db("acme").execute("create table items (id integer)")
    await client.admin.delete("acme")
    await client.admin.create("acme")
    await expect(Promise.resolve(client.db("acme").execute("select 1", [], { timeoutMs: 100 }))).rejects.toMatchObject({ code: "GENERATION_CHANGED" })
    // Explicitly reading the current database starts a new causal position.
    await client.db("acme").execute("select 1", [], { consistency: "primary" })
    expect([...(await client.db("acme").execute("select 2 as n"))]).toEqual([{ n: 2 }])
  } finally { client.close() }
}, 2000)

test("shared provider smoke checks SQL, saved results, catalog, settings and revocation", async () => {
  const { seedSmoke, verifySmoke } = await import("../../../../deploy/shared/http-smoke.ts")
  const { url } = await start()
  const options = { url, token: "test-admin" }
  const receipt = await seedSmoke(options)
  expect((await verifySmoke(options, receipt)).checks).toHaveLength(5)
})

test("a keyed no-op mutation remains a no-op when retried after later writes", async () => {
  const { url } = await start()
  const client = createClient({ url, token: "test-admin" })
  try {
    await client.admin.create("acme")
    await client.db("acme").execute("create table items (id integer)")
    await client.db("acme").execute("delete from items", [], { idempotencyKey: "empty-delete" })
    await client.db("acme").execute("insert into items values (1)")
    await client.db("acme").execute("delete from items", [], { idempotencyKey: "empty-delete" })
    expect([...(await client.db("acme").execute("select count(*) as n from items"))]).toEqual([{ n: 1 }])
  } finally { client.close() }
})

test("unchanged keyed settings keep their saved response after intervening changes", async () => {
  const { url } = await start()
  const client = createClient({ url, token: "test-admin" })
  const configure = async (foreignKeys: boolean, key: string) => {
    const response = await fetch(`${url}/v1/db/acme`, { method: "PATCH", headers: { authorization: "Bearer test-admin", "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ foreignKeys }) })
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    await client.admin.create("acme")
    await configure(false, "initial")
    const saved = await configure(false, "same")
    await configure(true, "intervening")
    expect(await configure(false, "same")).toEqual(saved)
    expect((await client.admin.stat("acme")).foreignKeys).toBe(true)
  } finally { client.close() }
})
