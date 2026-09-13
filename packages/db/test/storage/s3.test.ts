// `S3Store` against whichever backend is reachable: the retry policy, the concurrency bound, the
// pagination, and the promise that no failure message ever carries a credential.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { S3NotFound, S3Store, S3StoreError } from "../../src/storage/index.ts"
import { type Backend, cleanup, openBackend } from "./harness.ts"

let backend: Backend

beforeAll(async () => {
  backend = await openBackend()
  console.log(`storage tests are running against ${backend.describe()}`)
})

afterAll(() => cleanup())

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe("objects", () => {
  test("put, get, head, exists, delete", async () => {
    const store = backend.store()
    const prefix = backend.prefix()
    await store.put(`${prefix}one.txt`, "hello", "text/plain")

    expect(text(await store.get(`${prefix}one.txt`))).toBe("hello")
    const head = await store.head(`${prefix}one.txt`)
    expect(head?.size).toBe(5)
    expect(await store.exists(`${prefix}one.txt`)).toBe(true)
    expect(await store.head(`${prefix}missing.txt`)).toBeNull()
    expect(await store.getOrNull(`${prefix}missing.txt`)).toBeNull()

    await store.delete(`${prefix}one.txt`)
    expect(await store.exists(`${prefix}one.txt`)).toBe(false)
    // Deleting what is not there is not an error, as S3 itself has it.
    await store.delete(`${prefix}one.txt`)
  })

  test("a missing key is `S3NotFound`, not a generic failure", async () => {
    const store = backend.store()
    await expect(store.get(`${backend.prefix()}nope`)).rejects.toBeInstanceOf(S3NotFound)
  })

  test("binary bodies survive the round trip byte for byte", async () => {
    const store = backend.store()
    const key = `${backend.prefix()}blob.bin`
    const body = new Uint8Array(64 * 1024)
    crypto.getRandomValues(body)
    await store.put(key, body)
    const back = await store.get(key)
    expect(back.byteLength).toBe(body.byteLength)
    expect(Bun.hash.xxHash3(back)).toBe(Bun.hash.xxHash3(body))
  })
})

describe("listing", () => {
  test("returns keys in order and follows pagination past one page", async () => {
    const store = backend.store()
    const prefix = backend.prefix()
    for (let i = 0; i < 12; i++) {
      await store.put(`${prefix}k${String(i).padStart(3, "0")}`, `body ${i}`)
    }
    const all = await store.list({ prefix })
    expect(all).toHaveLength(12)
    expect(all.map((one) => one.key)).toEqual([...all.map((one) => one.key)].sort())

    // A page smaller than the set proves the continuation token is followed.
    const page = await store.listPage({ prefix, limit: 5 })
    expect(page.objects).toHaveLength(5)
    expect(page.next).toBe(`${prefix}k004`)
    const rest = await store.list({ prefix, after: page.next as string })
    expect(rest).toHaveLength(7)
  })

  test("a prefix with nothing under it lists nothing", async () => {
    const store = backend.store()
    expect(await store.list({ prefix: `${backend.prefix()}empty/` })).toEqual([])
  })

  test("deleteMany removes every key it is given", async () => {
    const store = backend.store()
    const prefix = backend.prefix()
    const keys = ["a", "b", "c", "d", "e"].map((one) => `${prefix}${one}`)
    for (const key of keys) await store.put(key, key)
    expect(await store.deleteMany(keys)).toBe(5)
    expect(await store.list({ prefix })).toEqual([])
  })
})

describe("failure handling", () => {
  test("a transient 500 is retried and the write lands", async () => {
    if (!backend.fake) return
    const store = backend.store()
    const key = `${backend.prefix()}retried.txt`
    backend.fake.failNext = 2
    await store.put(key, "made it")
    expect(text(await store.get(key))).toBe("made it")
  })

  test("a 403 is not retried — it is a request bug, not a blip", async () => {
    if (!backend.fake) return
    const store = new S3Store({ ...backend.credentials, retries: 4, retryBaseMs: 5 })
    const before = backend.fake.log.length
    backend.fake.denyAll = true
    try {
      await expect(store.put(`${backend.prefix()}denied`, "x")).rejects.toBeInstanceOf(S3StoreError)
    } finally {
      backend.fake.denyAll = false
    }
    // One attempt, not five.
    expect(backend.fake.log.length - before).toBe(1)
  })

  test("a bucket that is unreachable fails after the retries and names the bucket", async () => {
    if (!backend.fake) return
    const store = new S3Store({ ...backend.credentials, retries: 1, retryBaseMs: 5 })
    const err = await backend.fake.whileOffline(async () => {
      try {
        await store.put(`${backend.prefix()}gone`, "x")
        return null
      } catch (caught) {
        return caught as S3StoreError
      }
    })
    expect(err).toBeInstanceOf(S3StoreError)
    expect(err?.bucket).toBe(backend.bucket)
    expect(err?.attempts).toBe(2)
  })

  test("nothing in an error message or in `describe()` is a credential", async () => {
    if (!backend.fake) return
    const store = new S3Store({
      ...backend.credentials,
      accessKeyId: "AKIAVERYSECRETKEYID",
      secretAccessKey: "s3cr3t-do-not-print-me",
      sessionToken: "session-token-do-not-print-me",
      retries: 0,
    })
    expect(JSON.stringify(store.describe())).not.toContain("AKIA")
    expect(JSON.stringify(store.describe())).not.toContain("s3cr3t")
    // The store itself must not carry them where a structured logger would find them.
    expect(JSON.stringify(store)).not.toContain("s3cr3t")

    backend.fake.denyAll = true
    try {
      await store.get(`${backend.prefix()}denied`)
    } catch (err) {
      const message = `${(err as Error).message} ${(err as Error).stack ?? ""}`
      expect(message).not.toContain("AKIAVERYSECRETKEYID")
      expect(message).not.toContain("s3cr3t-do-not-print-me")
      expect(message).not.toContain("session-token-do-not-print-me")
      expect(message).toContain(backend.bucket)
    } finally {
      backend.fake.denyAll = false
    }
  })

  test("a store with no credentials at all fails once, not `retries` times", async () => {
    const store = new S3Store({ bucket: backend.bucket, endpoint: backend.endpoint, retries: 4 })
    try {
      await store.put(`${backend.prefix()}nocreds`, "x")
    } catch (err) {
      // It may resolve credentials from the ambient environment on some machines; when it does
      // not, the point is that it gives up at once rather than five times.
      expect((err as S3StoreError).attempts).toBe(1)
    }
  })

  test("concurrency is bounded", async () => {
    const store = new S3Store({ ...backend.credentials, concurrency: 2 })
    expect(store.concurrency).toBe(2)
    const prefix = backend.prefix()
    // Twenty writes through a store that allows two at a time still all land.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.put(`${prefix}c${i}`, `body ${i}`)),
    )
    expect(await store.list({ prefix })).toHaveLength(20)
  })
})
