import { describe, expect, test } from "bun:test"
import { S3ObjectStore } from "../../src/storage/s3-object-store.ts"
import { PreconditionFailed, StoreOutcomeUnknown, StoreUnavailable } from "../../src/storage/object-store.ts"

// Emulate only the remote HTTP boundary: signing, condition headers, response
// classification and byte/version handling all execute in the production adapter.
function remote() {
  const objects = new Map<string, { body: Uint8Array; version: string }>()
  let revision = 0
  let drop = false
  let calls = 0
  const transport = async (url: string, init: RequestInit) => {
    calls++
    const parsed = new URL(url)
    expect(parsed.searchParams.has("X-Amz-Signature")).toBe(true)
    const key = parsed.pathname
    const current = objects.get(key)
    if (init.method === "GET") {
      return current ? new Response(current.body, { headers: { etag: current.version } })
        : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
    }
    const headers = new Headers(init.headers)
    if ((headers.get("if-none-match") === "*" && current) ||
      (headers.has("if-match") && headers.get("if-match") !== current?.version)) {
      return new Response(null, { status: 412 })
    }
    const value = { body: new Uint8Array(init.body as Uint8Array), version: `"opaque-${++revision}"` }
    objects.set(key, value)
    if (drop) { drop = false; throw new Error("lost response with secret URL") }
    return new Response(null, { headers: { etag: value.version } })
  }
  const store = new S3ObjectStore({ bucket: "test", endpoint: "https://s3.example.test", accessKeyId: "test-key", secretAccessKey: "test-secret" }, transport)
  return { store, dropNext: () => { drop = true }, calls: () => calls }
}
const bytes = (s: string) => new TextEncoder().encode(s)

describe("conditional S3 object store", () => {
  test("concurrent creates and replacements have exactly one winner; stale versions never overwrite", async () => {
    const { store } = remote()
    expect(await store.get("root")).toBeNull()
    const creates = await Promise.allSettled([store.create("root", bytes("a")), store.create("root", bytes("b"))])
    expect(creates.filter(r => r.status === "fulfilled")).toHaveLength(1)
    const failed = creates.find(r => r.status === "rejected") as PromiseRejectedResult
    expect(failed.reason).toBeInstanceOf(PreconditionFailed)
    const base = (await store.get("root"))!
    const replacements = await Promise.allSettled([store.replace("root", base.version, bytes("c")), store.replace("root", base.version, bytes("d"))])
    expect(replacements.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect((await store.get("root"))!.body).toEqual(bytes("c"))
    await expect(store.replace("root", base.version, bytes("stale"))).rejects.toBeInstanceOf(PreconditionFailed)
  })

  test("a stored PUT with a dropped response is unknown and is never retried", async () => {
    const remoteStore = remote()
    remoteStore.dropNext()
    await expect(remoteStore.store.create("root", bytes("durable"))).rejects.toBeInstanceOf(StoreOutcomeUnknown)
    expect(remoteStore.calls()).toBe(1)
    expect((await remoteStore.store.get("root"))!.body).toEqual(bytes("durable"))
  })

  test("failed reads, denied writes and uncertain writes have distinct redacted errors", async () => {
    for (const status of [403, 500]) {
      const store = new S3ObjectStore({ bucket: "test", accessKeyId: "secret-key", secretAccessKey: "secret-value" }, async () => new Response("secret-value", { status }))
      await expect(store.get("root")).rejects.toBeInstanceOf(StoreUnavailable)
      await expect(store.create("root", bytes("x"))).rejects.toBeInstanceOf(status === 403 ? StoreUnavailable : StoreOutcomeUnknown)
      try { await store.create("root", bytes("x")) } catch (error) { expect(String(error)).not.toContain("secret-value") }
    }
  })

  test("missing ETag cannot masquerade as a successful write or usable read", async () => {
    const store = new S3ObjectStore({ bucket: "test", accessKeyId: "key", secretAccessKey: "secret" }, async () => new Response("value"))
    await expect(store.get("root")).rejects.toBeInstanceOf(StoreUnavailable)
    await expect(store.create("root", bytes("x"))).rejects.toBeInstanceOf(StoreOutcomeUnknown)
  })

  test("abort before sending cannot commit and missing buckets cannot initialize an empty deployment", async () => {
    const store = new S3ObjectStore({ bucket: "test", accessKeyId: "key", secretAccessKey: "secret" }, async () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }))
    await expect(store.get("root")).rejects.toBeInstanceOf(StoreUnavailable)
    const r = remote()
    await expect(r.store.create("root", bytes("x"), AbortSignal.abort())).rejects.toBeInstanceOf(StoreUnavailable)
    expect(r.calls()).toBe(0)
  })
})
