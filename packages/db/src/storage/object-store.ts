/** Origin-consistent object storage. Versions are opaque CAS tokens, not hashes.
 * Implementations must never retry a PUT whose outcome may already be committed.
 * No listing or deletion is required by the cloud publication protocol. */
export interface ObjectStore {
  get(key: string, signal?: AbortSignal): Promise<StoredObject | null>
  create(key: string, body: Uint8Array, signal?: AbortSignal): Promise<ObjectVersion>
  replace(key: string, expectedVersion: string, body: Uint8Array, signal?: AbortSignal): Promise<ObjectVersion>
}
export interface ObjectVersion { version: string }
export interface StoredObject extends ObjectVersion { body: Uint8Array }

export class PreconditionFailed extends Error {
  readonly code = "PRECONDITION_FAILED"
  constructor() { super("Object version changed or object already exists"); this.name = "PreconditionFailed" }
}
export class StoreUnavailable extends Error {
  readonly code = "STORE_UNAVAILABLE"
  constructor() { super("Object store request failed; check credentials, configuration and connectivity"); this.name = "StoreUnavailable" }
}
export class StoreOutcomeUnknown extends Error {
  readonly code = "STORE_OUTCOME_UNKNOWN"
  constructor() { super("Object write may have committed; resolve through an origin read"); this.name = "StoreOutcomeUnknown" }
}
