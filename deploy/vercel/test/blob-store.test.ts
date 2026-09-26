import { afterEach, expect, test } from "bun:test"
import { BlobPreconditionFailedError, type PutCommandOptions, type GetCommandOptions } from "@vercel/blob"
import { BlobObjectStore } from "../blob-store.ts"
import { PreconditionFailed, StoreOutcomeUnknown, StoreUnavailable } from "../../../packages/db/src/storage/object-store.ts"

const previous = process.env.VERCEL_BLOB_RETRIES
afterEach(() => { if (previous === undefined) delete process.env.VERCEL_BLOB_RETRIES; else process.env.VERCEL_BLOB_RETRIES = previous })

test("Blob writes fail closed unless SDK retries are disabled", async () => {
  delete process.env.VERCEL_BLOB_RETRIES
  const store = new BlobObjectStore("test-token")
  await expect(store.create("root", new Uint8Array())).rejects.toBeInstanceOf(StoreUnavailable)
})

test("private origin reads and conditional writes preserve opaque versions", async () => {
  process.env.VERCEL_BLOB_RETRIES = "0"
  let body = new Uint8Array([1])
  let version = '"first"'
  const store = new BlobObjectStore("test-token", {
    async get(key: string, options: GetCommandOptions) {
      expect(options.useCache).toBe(false)
      expect(options.access).toBe("private")
      return { statusCode: 200 as const, stream: new Response(body).body!, headers: new Headers(), blob: {
        url: "https://test.private.blob.vercel-storage.com/root", downloadUrl: "https://test.private.blob.vercel-storage.com/root?download=1",
        pathname: key, contentType: "application/octet-stream", contentDisposition: "attachment", cacheControl: "max-age=60", etag: version, size: body.length, uploadedAt: new Date(0),
      } }
    },
    async put(key: string, value: unknown, options: PutCommandOptions) {
      expect(options.access).toBe("private")
      expect(options.addRandomSuffix).toBe(false)
      expect(options.multipart).toBe(false)
      if (!options.allowOverwrite || options.ifMatch !== version) throw new BlobPreconditionFailedError()
      body = new Uint8Array(value as Buffer)
      version = '"second"'
      return { url: "https://test.private.blob.vercel-storage.com/root", downloadUrl: "https://test.private.blob.vercel-storage.com/root?download=1", pathname: key, contentType: "application/octet-stream", contentDisposition: "attachment", etag: version }
    },
  })
  const original = (await store.get("root"))!
  await expect(store.create("root", new Uint8Array([9]))).rejects.toBeInstanceOf(PreconditionFailed)
  expect(await store.replace("root", original.version, new Uint8Array([2]))).toEqual({ version: '"second"' })
  expect((await store.get("root"))!.body).toEqual(new Uint8Array([2]))
  await expect(store.replace("root", original.version, new Uint8Array([3]))).rejects.toBeInstanceOf(PreconditionFailed)
})

test("Blob transport errors are ambiguous on writes and redacted on reads", async () => {
  process.env.VERCEL_BLOB_RETRIES = "0"
  let calls = 0
  const store = new BlobObjectStore("test-token", {
    async put() { calls++; throw new Error("test-token") },
    async get() { throw new Error("test-token") },
  })
  await expect(store.create("root", new Uint8Array([1]))).rejects.toBeInstanceOf(StoreOutcomeUnknown)
  expect(calls).toBe(1)
  await expect(store.get("root")).rejects.toBeInstanceOf(StoreUnavailable)
})

test("the pinned SDK's existing-blob create response is a definite conflict only for create", async () => {
  const { BlobError } = await import("@vercel/blob")
  process.env.VERCEL_BLOB_RETRIES = "0"
  const store = new BlobObjectStore("test-token", {
    async get() { return null },
    async put() { throw new BlobError("This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename. Read more about this error in our documentation: https://vercel.link/blob-allow-overwrite") },
  })
  await expect(store.create("root", new Uint8Array([1]))).rejects.toBeInstanceOf(PreconditionFailed)
  await expect(store.replace("root", '"version"', new Uint8Array([1]))).rejects.toBeInstanceOf(StoreOutcomeUnknown)
})
