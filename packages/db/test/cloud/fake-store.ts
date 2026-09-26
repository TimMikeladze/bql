import { type ObjectStore, type StoredObject, PreconditionFailed, StoreOutcomeUnknown, StoreUnavailable } from "../../src/storage/object-store.ts"

/** Deterministic object-store fault harness. All mutations happen atomically
 * before yielding; dropped responses occur AFTER persistence. No production
 * dependencies on this helper. */
export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>()
  readonly operations: Array<{ op: string; key: string }> = []
  unavailable = false
  dropNextWriteResponse = false
  #version = 0

  async get(key: string, signal?: AbortSignal): Promise<StoredObject | null> {
    this.operations.push({ op: "get", key })
    if (this.unavailable || signal?.aborted) throw new StoreUnavailable()
    const value = this.objects.get(key)
    return value ? { body: value.body.slice(), version: value.version } : null
  }
  async create(key: string, body: Uint8Array, signal?: AbortSignal) {
    return this.#write(key, null, body, signal)
  }
  async replace(key: string, expectedVersion: string, body: Uint8Array, signal?: AbortSignal) {
    return this.#write(key, expectedVersion, body, signal)
  }
  #write(key: string, expected: string | null, body: Uint8Array, signal?: AbortSignal) {
    this.operations.push({ op: expected === null ? "create" : "replace", key })
    if (this.unavailable || signal?.aborted) throw new StoreUnavailable()
    const current = this.objects.get(key)
    if (expected === null ? current !== undefined : !current || current.version !== expected) throw new PreconditionFailed()
    const version = `version-${++this.#version}`
    this.objects.set(key, { body: body.slice(), version })
    if (this.dropNextWriteResponse) {
      this.dropNextWriteResponse = false
      throw new StoreOutcomeUnknown()
    }
    return { version }
  }
}
