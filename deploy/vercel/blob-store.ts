import { get, put, BlobError, BlobPreconditionFailedError, BlobAccessError, BlobStoreNotFoundError, BlobStoreSuspendedError } from "@vercel/blob"
import { type ObjectStore, type ObjectVersion, type StoredObject, PreconditionFailed, StoreOutcomeUnknown, StoreUnavailable } from "../../packages/db/src/storage/object-store.ts"

type BlobSDK = Pick<typeof import("@vercel/blob"), "get" | "put">

/** Experimental until real-provider race qualification passes. SDK is pinned in
 * this package, never added to the dependency-free database core. */
export class BlobObjectStore implements ObjectStore {
  constructor(private readonly token: string, private readonly sdk: BlobSDK = { get, put }) {}

  async get(key: string, signal?: AbortSignal): Promise<StoredObject | null> {
    try {
      const value = await this.sdk.get(key, { token: this.token, access: "private", useCache: false, abortSignal: signal })
      if (value === null) return null
      if (value.statusCode !== 200 || !value.stream || !value.blob.etag) throw new StoreUnavailable()
      return { body: new Uint8Array(await new Response(value.stream).arrayBuffer()), version: value.blob.etag }
    } catch { throw new StoreUnavailable() }
  }

  create(key: string, body: Uint8Array, signal?: AbortSignal): Promise<ObjectVersion> {
    return this.#write(key, body, undefined, signal)
  }

  replace(key: string, expectedVersion: string, body: Uint8Array, signal?: AbortSignal): Promise<ObjectVersion> {
    if (!expectedVersion || expectedVersion === "*") return Promise.reject(new StoreUnavailable())
    return this.#write(key, body, expectedVersion, signal)
  }

  async #write(key: string, body: Uint8Array, version?: string, signal?: AbortSignal): Promise<ObjectVersion> {
    // v2.7.0 reads this setting per request. Do not mutate process-global config
    // here: require it in the provider's startup environment and check each write.
    if (process.env.VERCEL_BLOB_RETRIES !== "0" || signal?.aborted) throw new StoreUnavailable()
    try {
      const result = await this.sdk.put(key, Buffer.from(body), {
        token: this.token, access: "private", addRandomSuffix: false,
        allowOverwrite: version !== undefined, ifMatch: version, multipart: false,
        contentType: "application/octet-stream", abortSignal: signal,
      })
      if (!result.etag) throw new StoreOutcomeUnknown()
      return { version: result.etag }
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new PreconditionFailed()
      // Observed on the live private API with SDK 2.7.0: atomic create rejects
      // existing objects through BlobError rather than BlobPreconditionFailedError.
      // Match the complete known diagnostic, only for create; unknown errors stay ambiguous.
      if (version === undefined && error instanceof BlobError && error.message === "Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename. Read more about this error in our documentation: https://vercel.link/blob-allow-overwrite") throw new PreconditionFailed()
      if (error instanceof BlobAccessError || error instanceof BlobStoreNotFoundError || error instanceof BlobStoreSuspendedError) throw new StoreUnavailable()
      // Includes cancellation and unclassified SDK errors. Never expose tokens,
      // provider response bodies, or claim a definite rollback without evidence.
      throw new StoreOutcomeUnknown()
    }
  }
}
