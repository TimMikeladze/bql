// Invariant: the connection has at most one authorizer installed and it is this hub's trampoline.
// Change capture, read-set recording and the token policy all want to see the same actions, and
// `Database.authorizer()` has one slot, so every party registers a layer here instead. Layers are
// consulted in order — the base (policy) first, then recorders — and the most restrictive verdict
// wins: any DENY denies, otherwise any IGNORE ignores.
//
// Swapping the callback on the driver does not call `sqlite3_set_authorizer` again, so statements
// already in the connection's prepared-statement cache keep their old authorisation. Whenever a
// layer changes what SQLite is allowed to do (the policy base, or capture's IGNORE-on-delete) the
// hub therefore cycles the authorizer for real, which expires those cached statements.

import { SQLITE_DENY, SQLITE_IGNORE, SQLITE_OK } from "../sqlite/constants.ts"
import type { Authorizer, Database } from "../sqlite/index.ts"

export interface LayerOptions {
  /**
   * Cycle `sqlite3_set_authorizer` so statements already prepared on this connection are
   * re-authorised. Needed when the layer changes a verdict; not needed for a recorder that
   * prepares its own statement. Default true.
   */
  expire?: boolean
}

export class AuthorizerHub {
  readonly #db: Database
  #base: Authorizer | null = null
  #layers: Authorizer[] = []
  #installed = false
  #bypass = false
  readonly #trampoline: Authorizer

  constructor(db: Database) {
    this.#db = db
    this.#trampoline = (action, arg1, arg2, dbName, trigger) => {
      if (this.#bypass) return SQLITE_OK
      let verdict = SQLITE_OK
      const base = this.#base
      if (base) {
        const rc = base(action, arg1, arg2, dbName, trigger)
        if (rc === SQLITE_DENY) return SQLITE_DENY
        if (rc === SQLITE_IGNORE) verdict = SQLITE_IGNORE
      }
      const layers = this.#layers
      for (let i = 0; i < layers.length; i++) {
        const rc = (layers[i] as Authorizer)(action, arg1, arg2, dbName, trigger)
        if (rc === SQLITE_DENY) return SQLITE_DENY
        if (rc === SQLITE_IGNORE) verdict = SQLITE_IGNORE
      }
      return verdict
    }
  }

  /** True while an authorizer is installed on the connection. */
  get installed(): boolean {
    return this.#installed
  }

  get layerCount(): number {
    return this.#layers.length
  }

  /** Installs the token policy's authorizer, or removes it. Cached statements are expired. */
  setBase(authorizer: Authorizer | null): void {
    this.#base = authorizer
    this.#sync(true)
  }

  /** Adds a layer and returns the function that removes it again. */
  addLayer(layer: Authorizer, options: LayerOptions = {}): () => void {
    this.#layers.push(layer)
    this.#sync(options.expire !== false)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const at = this.#layers.indexOf(layer)
      if (at >= 0) this.#layers.splice(at, 1)
      this.#sync(options.expire !== false)
    }
  }

  /**
   * Runs `fn` with every layer answering `SQLITE_OK`, for the engine's own bookkeeping queries
   * (`PRAGMA table_info` and friends), which must not be denied by a token policy and must not be
   * recorded as part of somebody's read-set.
   */
  bypass<T>(fn: () => T): T {
    const before = this.#bypass
    this.#bypass = true
    try {
      return fn()
    } finally {
      this.#bypass = before
    }
  }

  /** Removes the authorizer from the connection and forgets every layer. */
  detach(): void {
    this.#base = null
    this.#layers = []
    this.#sync(false)
  }

  #sync(expire: boolean): void {
    const want = this.#base !== null || this.#layers.length > 0
    if (want === this.#installed) {
      if (want && expire) {
        // A real set_authorizer cycle: the driver skips the FFI call when only swapping callbacks.
        this.#db.authorizer(null)
        this.#db.authorizer(this.#trampoline)
      }
      return
    }
    this.#installed = want
    this.#db.authorizer(want ? this.#trampoline : null)
  }
}
