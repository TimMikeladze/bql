import { expect, test } from "bun:test"
import { qualifyStorage } from "../../../../deploy/shared/storage-contract.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { StoreOutcomeUnknown } from "../../src/storage/object-store.ts"

test("qualification checks create, replace, visibility and stale versions", async () => {
  const store = new FakeObjectStore()
  const result = await qualifyStorage(store, "qualification/")
  expect(result.checks).toHaveLength(4)
  expect(store.objects.size).toBe(1)
})

test("qualification refuses a store that accepts concurrent creates", async () => {
  const store = new FakeObjectStore()
  const unsafe = {
    get: store.get.bind(store),
    replace: store.replace.bind(store),
    async create(key: string, body: Uint8Array) {
      store.objects.delete(key)
      return store.create(key, body)
    },
  }
  await expect(qualifyStorage(unsafe, "qualification/")).rejects.toThrow("Conditional race")
})

test("fault harness persists bytes before losing the response and isolates caller buffers", async () => {
  const store = new FakeObjectStore()
  const body = new Uint8Array([7])
  store.dropNextWriteResponse = true
  await expect(store.create("root", body)).rejects.toBeInstanceOf(StoreOutcomeUnknown)
  body[0] = 8
  const result = (await store.get("root"))!
  expect(result.body).toEqual(new Uint8Array([7]))
  result.body[0] = 9
  expect((await store.get("root"))!.body).toEqual(new Uint8Array([7]))
})

test("qualification supports opaque ETags derived from bytes without accidentally making a no-op CAS", async () => {
  const { S3ObjectStore } = await import("../../src/storage/s3-object-store.ts")
  const objects = new Map<string, { body: Uint8Array; version: string }>()
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname
      if (request.method === "GET") {
        const value = objects.get(key)
        return value ? new Response(value.body, { headers: { etag: value.version } }) : new Response("<Code>NoSuchKey</Code>", { status: 404 })
      }
      const body = new Uint8Array(await request.arrayBuffer())
      const current = objects.get(key)
      if ((request.headers.get("if-none-match") === "*" && current) ||
          (request.headers.has("if-match") && request.headers.get("if-match") !== current?.version)) return new Response(null, { status: 412 })
      const version = `"${new Bun.CryptoHasher("md5").update(body).digest("hex")}"`
      objects.set(key, { body, version })
      return new Response(null, { headers: { etag: version } })
    },
  })
  try {
    const store = new S3ObjectStore({ bucket: "test", endpoint: `http://127.0.0.1:${server.port}`, accessKeyId: "key", secretAccessKey: "secret" })
    expect((await qualifyStorage(store, "qualification/")).checks).toHaveLength(4)
  } finally { server.stop(true) }
})
