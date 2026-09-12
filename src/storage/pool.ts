// One shipper per database, attached through the registry's `onOpen` seam.
//
// Invariant: a shipper follows its tenant's lifetime, and a database with unshipped records is
// never forgotten. The LRU may evict a tenant at any time, so the pool remembers the names that
// were behind when their tenant closed and reopens exactly those on its sweep — rather than
// pinning every shipped database open, which would defeat `data.maxOpen` at ten thousand tenants.
//
// Second invariant: nothing here is on a request path. The sweep is a timer, every upload is the
// shipper's own async drain, and `close()` is the only thing that waits.

import type { Tenant, TenantRegistry } from "../tenant/index.ts"
import { Shipper, type ShipperOptions, type ShipperState } from "./shipper.ts"
import type { S3Store } from "./s3.ts"

export interface ShipperPoolOptions extends Omit<ShipperOptions, "db"> {
  registry: TenantRegistry
  /** How often closed shippers are reaped and behind databases reopened. Default `shipIntervalMs`. */
  sweepIntervalMs?: number
}

export class ShipperPool {
  readonly store: S3Store
  readonly prefix: string
  readonly sweepIntervalMs: number

  #options: ShipperPoolOptions
  #shippers = new Map<string, Shipper>()
  /** Databases whose tenant closed while the bucket was still behind. */
  #owed = new Set<string>()
  /** Databases this node does not ship — a replica authors nothing. Skipped by the sweep. */
  #skip = new Set<string>()
  #sweeper: ReturnType<typeof setInterval> | null = null
  #closed = false

  constructor(options: ShipperPoolOptions) {
    this.#options = options
    this.store = options.store
    this.prefix = options.prefix
    this.sweepIntervalMs = options.sweepIntervalMs ?? options.shipIntervalMs ?? 1000
  }

  /** Starts the sweep. Separate from the constructor so a test can drive the pool by hand. */
  start(): void {
    if (this.#sweeper || this.#closed) return
    const timer = setInterval(() => this.sweep(), this.sweepIntervalMs)
    timer.unref?.()
    this.#sweeper = timer
  }

  /** Every open shipper, by database name. */
  get shippers(): ReadonlyMap<string, Shipper> {
    return this.#shippers
  }

  shipperFor(db: string): Shipper | undefined {
    return this.#shippers.get(db)
  }

  /** Called for every tenant the registry opens. A replica ships nothing: it authors nothing. */
  attach(tenant: Tenant): Shipper | null {
    if (this.#closed) return null
    if (tenant.isReplica) {
      // A replica's transactions arrive from its primary, which is the node that ships them. Note
      // it so the sweep stops reconsidering it every tick.
      this.#skip.add(tenant.name)
      return null
    }
    this.#skip.delete(tenant.name)
    let shipper = this.#shippers.get(tenant.name)
    if (!shipper) {
      const { registry: _registry, sweepIntervalMs: _sweep, ...rest } = this.#options
      shipper = new Shipper({ ...rest, db: tenant.name })
      this.#shippers.set(tenant.name, shipper)
    }
    shipper.bind(tenant)
    this.#owed.delete(tenant.name)
    return shipper
  }

  /** Drops a database's shipper outright — what a delete does. */
  async forget(db: string): Promise<void> {
    const shipper = this.#shippers.get(db)
    if (!shipper) return
    this.#shippers.delete(db)
    this.#owed.delete(db)
    this.#skip.delete(db)
    await shipper.close()
  }

  /**
   * Unbinds shippers whose tenant has closed, remembering the ones still behind, then reopens
   * those so they can catch up. Reopening goes through the registry, which calls `attach` again.
   */
  sweep(): void {
    if (this.#closed) return
    for (const [db, shipper] of this.#shippers) {
      if (shipper.bound) continue
      shipper.unbind()
      if (shipper.hasWork) this.#owed.add(db)
    }
    // A registry handed in from outside does not route through this pool's `onOpen`, and a tenant
    // can be opened before the pool exists. Anything open without a bound shipper is adopted here.
    for (const db of this.#options.registry.openNames) {
      if (this.#skip.has(db)) continue
      if (this.#shippers.get(db)?.bound) continue
      this.#owed.add(db)
    }
    for (const db of [...this.#owed]) {
      this.#owed.delete(db)
      try {
        // `open` fires the registry's `onOpen`, which is `attach`, which rebinds and arms a drain.
        this.#options.registry.open(db)
      } catch {
        // The database was deleted, or the registry is closing. Either way nothing is owed.
        this.#shippers.delete(db)
      }
    }
  }

  /** Ships everything outstanding, everywhere. What a test and a shutdown use. */
  async flush(): Promise<void> {
    await Promise.all([...this.#shippers.values()].map((one) => one.flush().catch(() => {})))
  }

  state(): ShipperState[] {
    return [...this.#shippers.values()].map((one) => one.state())
  }

  /** Totals for `/metrics`, which is per process and never per database. */
  totals(): { shippedTxid: number; pendingRecords: number; errors: number; bytes: number } {
    let shippedTxid = 0
    let pendingRecords = 0
    let errors = 0
    let bytes = 0
    for (const shipper of this.#shippers.values()) {
      const state = shipper.state()
      if (state.shippedTxid > shippedTxid) shippedTxid = state.shippedTxid
      pendingRecords += state.pendingRecords
      errors += state.errors
      bytes += state.bytesShipped
    }
    return { shippedTxid, pendingRecords, errors, bytes }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#sweeper) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
    const shippers = [...this.#shippers.values()]
    this.#shippers.clear()
    this.#owed.clear()
    this.#skip.clear()
    await Promise.all(shippers.map((one) => one.close().catch(() => {})))
  }
}
