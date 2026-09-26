import { S3Client } from "bun"
import type { S3StoreOptions } from "./s3.ts"
import { type ObjectStore, type ObjectVersion, type StoredObject, PreconditionFailed, StoreOutcomeUnknown, StoreUnavailable } from "./object-store.ts"

export type ObjectTransport = (url: string, init: RequestInit) => Promise<Response>

/** Conditional single-PUT adapter for private S3/R2 endpoints. Bun signs requests;
 * fetch supplies the condition headers absent from Bun's S3 write API. Keep this
 * separate from backup S3Store, whose retry and multipart semantics are different.
 * Provider qualification must verify these operations on the target endpoint. */
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client
  readonly #transport: ObjectTransport

  constructor(options: S3StoreOptions, transport: ObjectTransport = (url, init) => fetch(url, init)) {
    this.#client = new S3Client(options)
    this.#transport = transport
  }

  async get(key: string, signal?: AbortSignal): Promise<StoredObject | null> {
    try {
      const response = await this.#request(key, "GET", {}, undefined, signal)
      if (response.status === 404) {
        // NoSuchBucket and proxy errors must not be treated as an empty root.
        if (/<Code>NoSuchKey<\/Code>/.test(await response.text())) return null
        throw new StoreUnavailable()
      }
      const version = response.headers.get("etag")
      if (!response.ok || !version) throw new StoreUnavailable()
      return { body: new Uint8Array(await response.arrayBuffer()), version }
    } catch { throw new StoreUnavailable() }
  }

  create(key: string, body: Uint8Array, signal?: AbortSignal): Promise<ObjectVersion> {
    return this.#put(key, { "if-none-match": "*" }, body, signal)
  }

  replace(key: string, expectedVersion: string, body: Uint8Array, signal?: AbortSignal): Promise<ObjectVersion> {
    if (!expectedVersion || expectedVersion === "*") return Promise.reject(new StoreUnavailable())
    return this.#put(key, { "if-match": expectedVersion }, body, signal)
  }

  async #put(key: string, headers: Record<string, string>, body: Uint8Array, signal?: AbortSignal): Promise<ObjectVersion> {
    const response = await this.#request(key, "PUT", headers, body, signal)
    // Drain bodies without ever including provider responses or signed URLs in errors.
    try { await response.arrayBuffer() } catch { throw new StoreOutcomeUnknown() }
    if (response.status === 412 || response.status === 409) throw new PreconditionFailed()
    if (response.status >= 500 || response.status === 408) throw new StoreOutcomeUnknown()
    if (!response.ok) throw new StoreUnavailable()
    const version = response.headers.get("etag")
    if (!version) throw new StoreOutcomeUnknown()
    return { version }
  }

  async #request(key: string, method: "GET" | "PUT", headers: Record<string, string>, body?: Uint8Array, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw new StoreUnavailable()
    let url: string
    try {
      url = this.#client.presign(key, { method, expiresIn: 60 })
    } catch { throw new StoreUnavailable() }
    try {
      return await this.#transport(url, {
        method, headers, body, signal, redirect: "error", cache: "no-store",
      })
    } catch {
      // Cancellation during transmission is just as ambiguous as a socket reset.
      throw method === "PUT" ? new StoreOutcomeUnknown() : new StoreUnavailable()
    }
  }
}
