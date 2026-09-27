import { afterEach, expect, test } from "bun:test"
import { CloudRuntime, initializeCloud, type CloudOperation } from "../../src/cloud/runtime.ts"
import { AuthKeys } from "../../src/server/auth.ts"
import { loadConfig } from "../../src/server/config.ts"
import { StoreOutcomeUnknown } from "../../src/storage/object-store.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { cleanup, tempDir } from "../storage/harness.ts"
const runtimes: CloudRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(Date.now()); cleanup() })
async function setup() {
  const store = new FakeObjectStore()
  const config = loadConfig({ env: {}, overrides: { data: { dir: tempDir() }, auth: { adminKey: "admin", jwtKey: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64") } } })
  await initializeCloud(store, "life", config)
  const open = async () => { const runtime = await CloudRuntime.open({ store, deploymentId: "life", config, maxPending: 2 }); runtimes.push(runtime); return runtime }
  const runtime = await open()
  await run(runtime, { kind: "createDatabase", body: { name: "db" } })
  await run(runtime, { kind: "query", db: "db", body: { sql: "create table items (id)" } })
  return { runtime, store, open }
}
function run(runtime: CloudRuntime, operation: CloudOperation, headers = {}) {
  return runtime.run({ request: new Request("http://localhost", { headers: { authorization: "Bearer admin", ...headers } }) }, operation)
}
const insert: CloudOperation = { kind: "query", db: "db", body: { sql: "insert into items values (1)" } }
const select: CloudOperation = { kind: "query", db: "db", body: { sql: "select count(*) from items" } }

test("readiness recovery shares admission with user traffic and shutdown cancels it", async () => {
  const f = await setup()
  await expect(f.runtime.run({ request: new Request("http://localhost", { headers: { authorization: "Bearer invalid" } }) }, select)).rejects.toThrow()
  const original = f.store.get.bind(f.store)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let blocked = true
  f.store.get = async (key, signal) => {
    if (blocked) { entered.resolve(); await release.promise }
    return original(key, signal)
  }
  const recovering = f.runtime.ready()
  await entered.promise
  expect(await f.runtime.ready()).toBe(false)
  let finished = false
  const write = run(f.runtime, insert).then(response => { finished = true; return response })
  await Bun.sleep(1)
  expect(finished).toBe(false)
  blocked = false; release.resolve()
  expect(await recovering).toBe(true)
  expect((await write).status).toBe(200)
  expect((await (await run(f.runtime, select)).json() as { rows: number[][] }).rows).toEqual([[1]])

  await expect(f.runtime.run({ request: new Request("http://localhost") }, select)).rejects.toThrow()
  const stopping = Promise.withResolvers<void>()
  f.store.get = async (_key, signal) => {
    stopping.resolve()
    return new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
    })
  }
  const lastProbe = f.runtime.ready()
  await stopping.promise
  await f.runtime.close(Date.now() + 10)
  expect(await lastProbe).toBe(false)
  expect(f.runtime.phase).toBe("stopped")
})

function blockPublication(store: FakeObjectStore) {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const original = store.replace.bind(store)
  store.replace = async (key, version, body, signal) => {
    reached.resolve()
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new StoreOutcomeUnknown())
      signal?.addEventListener("abort", abort, { once: true })
      released.promise.then(() => { signal?.removeEventListener("abort", abort); resolve() })
      if (signal?.aborted) abort()
    })
    return original(key, version, body, signal)
  }
  return { reached: reached.promise, release: () => released.resolve(), restore: () => { store.replace = original } }
}

test("bounded admission rejects excess work and shutdown drains accepted publication", async () => {
  const f = await setup()
  const block = blockPublication(f.store)
  const write = run(f.runtime, insert)
  await block.reached
  const read = run(f.runtime, select)
  await expect(run(f.runtime, select)).rejects.toMatchObject({ code: "CLOUD_BACKPRESSURE" })
  const closing = f.runtime.close(Date.now() + 1000)
  expect(f.runtime.phase).toBe("draining")
  await expect(run(f.runtime, select)).rejects.toMatchObject({ code: "CLOUD_DRAINING" })
  block.release()
  expect((await write).status).toBe(200)
  expect((await (await read).json() as { rows: number[][] }).rows).toEqual([[1]])
  await closing
  expect(f.runtime.phase).toBe("stopped")
})

test("shutdown deadline cancels blocked publication and recovery ignores tentative rows", async () => {
  const f = await setup()
  const block = blockPublication(f.store)
  const write = run(f.runtime, insert)
  const outcome = write.then(() => null, error => error)
  await block.reached
  await f.runtime.close(Date.now() + 20)
  expect(await outcome).toMatchObject({ code: "COMMIT_UNKNOWN" })
  expect(f.runtime.phase).toBe("stopped")
  block.restore()
  const fresh = await f.open()
  expect((await (await run(fresh, select)).json() as { rows: number[][] }).rows).toEqual([[0]])
})

test("an unavailable causal position never waits inside the serialized gate", async () => {
  const f = await setup()
  await expect(run(f.runtime, select, { "BQL-Min-Txid": "999" })).rejects.toMatchObject({ code: "TXID_NOT_AVAILABLE" })
}, 300)

test("shutdown cancels a stalled body without waiting for the caller to release it", async () => {
  const f = await setup()
  const reached = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<Record<string, unknown>>()
  const pending = f.runtime.run({ request: new Request("http://localhost", { headers: { authorization: "Bearer admin" } }), readBody: () => { reached.resolve(); return waiting.promise } }, { kind: "query", db: "db" }).then(() => null, error => error)
  await reached.promise
  const closing = f.runtime.close(Date.now())
  const marker = Symbol("timeout")
  const outcome = await Promise.race([closing, Bun.sleep(100).then(() => marker)])
  // Always release after measuring so a regression doesn't hang test cleanup.
  waiting.resolve({ sql: "select 1" })
  await closing
  expect(outcome).not.toBe(marker)
  expect(await pending).toBeInstanceOf(Error)
  expect(f.runtime.phase).toBe("stopped")
})

test("body reader cancels the incoming stream when its request deadline aborts", async () => {
  const { bodyReader } = await import("../../src/http/index.ts")
  const { serverOperations } = await import("../../src/server/registry.ts")
  const abort = new AbortController()
  const pulled = Promise.withResolvers<void>()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ pull() { pulled.resolve() }, cancel() { cancelled = true } })
  const request = new Request("http://localhost/v1/db/db/query", { method: "POST", body: stream, signal: abort.signal })
  const read = bodyReader(serverOperations().find(op => op.id === "query")!, {})
  const result = read({ request, params: { db: "db" }, url: new URL(request.url) }).then(() => null, error => error)
  await pulled.promise
  abort.abort(new Error("deadline"))
  const marker = Symbol("timeout")
  const outcome = await Promise.race([result, Bun.sleep(100).then(() => marker)])
  if (outcome === marker) {
    // Old implementation leaves reader locked; this test's isolated stream has no
    // runtime/filesystem resources, so report the cancellation failure directly.
    expect(outcome).not.toBe(marker)
  }
  expect(outcome).toBeInstanceOf(Error)
  expect(cancelled).toBe(true)
})
