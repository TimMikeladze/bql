// The LRU of open tenants (design §4.2). Opening a database costs ~17 µs, so a miss is cheap and
// the cap exists for file descriptors rather than for speed: writer + readers ≈ 7 fds per open
// tenant, so `maxOpen` is checked against `ulimit -n` at start.
//
// Invariant: a tenant with work in flight is never evicted. Eviction closes connections, and a
// connection closed underneath a running write would lose the transaction the caller is waiting
// on, so the sweep skips anything busy rather than waiting for it.

import fs from "node:fs"
import path from "node:path"
import { BunQLError } from "../server/errors.ts"
import { Database } from "../sqlite/index.ts"
import { computeFull } from "../wal/index.ts"
import { Catalog, positionOf, type TenantRow } from "./catalog.ts"
import {
  type AckLevel,
  assertValidName,
  Tenant,
  tenantDir,
  TenantError,
  type TenantOptions,
  type TenantStats,
} from "./tenant.ts"

/** Writer + readers + WAL + shm, per design §4.7's "≈ 7 fds per open tenant". */
const FDS_PER_TENANT = 7

export interface RegistryOptions {
  /** Data root. `_system.db`, `dbs/` and `trash/` live here. */
  dir: string
  /** Open tenants held in the LRU. Default 1024 (design §4.2). */
  maxOpen?: number
  /** Reader connections per tenant. Default 2. */
  readers?: number
  /** Page size for databases created from now on. Default 4096. */
  pageSize?: number
  /** Default storage quota for new databases, in bytes. 0 (default) is unlimited. */
  quotaBytes?: number
  checkpointWalBytes?: number
  idleCheckpointMs?: number
  busyTimeoutMs?: number
  defaultAck?: AckLevel
  waitMs?: number
  segmentBytes?: number
  logFsync?: "never" | "each" | "interval"
  /** How often idle tenants are checked for a TRUNCATE checkpoint. Default 250 ms. */
  sweepIntervalMs?: number
  /** Where the fd-budget warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void
  onError?: (err: unknown) => void
  /** Passed to every tenant: called for each connection opened, writer or reader. */
  onConnection?: (db: Database, role: "writer" | "reader") => void
  /**
   * Called once for every tenant this registry opens, however it was reached — `open`, `create`,
   * a fork or an import. It is the only place a caller can see every live tenant without holding
   * them all open itself, which is what a process-wide commit listener needs.
   */
  onOpen?: (tenant: Tenant) => void
}

export interface CreateOptions {
  pageSize?: number
  quotaBytes?: number
  /** Fork of another database (design §4.4, §6.5): O(1) where the filesystem reflinks. */
  from?: { db: string; at?: bigint }
}

export interface RegistryStats {
  open: number
  maxOpen: number
  tenants: number
  evictions: number
  /** Per-tenant stats for everything currently open. */
  openTenants: TenantStats[]
}

/** The process's open-file limit, or null when it cannot be read. */
export function fileDescriptorLimit(): number | null {
  try {
    const result = Bun.spawnSync(["sh", "-c", "ulimit -n"])
    if (!result.success) return null
    const text = new TextDecoder().decode(result.stdout).trim()
    if (text === "unlimited") return Number.POSITIVE_INFINITY
    const value = Number(text)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export class TenantRegistry {
  readonly dir: string
  readonly catalog: Catalog
  readonly maxOpen: number

  #options: RegistryOptions
  /** Insertion order is recency: the oldest entry is the first eviction candidate. */
  #open = new Map<string, Tenant>()
  /** Names the LRU may not close: a tenant with a live subscription still has to see commits. */
  #pinned = new Set<string>()
  #sweeper: ReturnType<typeof setInterval> | null = null
  #evictions = 0
  #closed = false

  private constructor(options: RegistryOptions, catalog: Catalog) {
    this.dir = options.dir
    this.catalog = catalog
    this.maxOpen = options.maxOpen ?? 1024
    this.#options = options
  }

  static open(options: RegistryOptions): TenantRegistry {
    fs.mkdirSync(options.dir, { recursive: true })
    const catalog = Catalog.open(options.dir)
    const registry = new TenantRegistry(options, catalog)
    registry.#checkFdBudget()
    return registry
  }

  /** Every live database name. */
  list(): TenantRow[] {
    this.#assertOpen()
    return this.catalog.listTenants()
  }

  has(name: string): boolean {
    this.#assertOpen()
    return this.catalog.getTenant(name) !== null
  }

  /** Open tenants, most recently used last. */
  get openNames(): string[] {
    return [...this.#open.keys()]
  }

  /**
   * Opens a tenant, or returns the one already open and refreshes its recency. Throws
   * `DB_NOT_FOUND` for a database that was never created.
   */
  open(name: string): Tenant {
    this.#assertOpen()
    const hit = this.#open.get(name)
    if (hit && !hit.closed) {
      this.#open.delete(name)
      this.#open.set(name, hit)
      return hit
    }
    const row = this.catalog.getTenant(name)
    if (!row) throw BunQLError.dbNotFound(name)
    return this.#openRow(row)
  }

  /**
   * Creates a database, or forks one (design §6.5, `POST /v1/db`). Async because a fork copies a
   * file; a plain create never awaits anything that touches the disk twice.
   */
  async create(name: string, options: CreateOptions = {}): Promise<Tenant> {
    this.#assertOpen()
    assertValidName(name)
    if (this.catalog.getTenant(name)) {
      throw new TenantError("DB_EXISTS", `database ${name} already exists`)
    }

    if (options.from) {
      const source = this.open(options.from.db)
      const forked = await source.fork(name, options.from.at)
      const row = this.catalog.getTenant(forked.name)
      if (!row) throw new TenantError("DB_MISSING", `fork of ${name} left no catalog row`)
      return this.#openRow(row)
    }

    const dir = tenantDir(this.dir, name)
    fs.mkdirSync(dir, { recursive: true })
    const row = this.catalog.createTenant({
      name,
      pageSize: options.pageSize ?? this.#options.pageSize ?? 4096,
      quotaBytes: options.quotaBytes ?? this.#options.quotaBytes ?? 0,
    })
    return this.#openRow(row)
  }

  /**
   * Files a raw SQLite file as a new database (design §6.5, `POST /v1/db/{db}/import`). The file
   * is written into the tenant directory, switched to WAL mode and folded flat, and the catalog
   * row starts at txid 1 carrying the file's own rolling checksum — so the imported state is a
   * position that needs no log record behind it, and a replica bootstraps from a snapshot.
   */
  async importDatabase(name: string, bytes: Uint8Array): Promise<Tenant> {
    this.#assertOpen()
    assertValidName(name)
    if (this.catalog.getTenant(name)) {
      throw new TenantError("DB_EXISTS", `database ${name} already exists`)
    }
    const dir = tenantDir(this.dir, name)
    const dbPath = path.join(dir, "main.db")
    fs.mkdirSync(dir, { recursive: true })
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true })
    try {
      await Bun.write(dbPath, bytes)
      // Opening it is the real verification: a file that is not a database, or is a corrupt one,
      // fails here with SQLite's own result code rather than on the first query later.
      const db = Database.open(dbPath, { wal: false })
      try {
        db.exec("pragma journal_mode = wal")
        db.prepare("select count(*) from sqlite_schema").get()
        db.walCheckpoint("TRUNCATE")
      } finally {
        db.close()
      }
      const full = computeFull(dbPath, { includeWal: false })
      const row = this.catalog.createTenant({
        name,
        pageSize: full.pageSize || this.#options.pageSize || 4096,
        quotaBytes: this.#options.quotaBytes ?? 0,
        position: {
          txid: 1n,
          checksum: full.checksum,
          dbSizePages: full.pages,
          wal: { salt1: 0, salt2: 0, frame: 0 },
        },
      })
      return this.#openRow(row)
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw err
    }
  }

  /**
   * Closes the tenant and moves its directory to `<dataDir>/trash/<name>-<ms>`. The catalog row
   * is tombstoned, so the name is free again and the deletion is still on the record.
   */
  delete(name: string): string {
    this.#assertOpen()
    const row = this.catalog.getTenant(name)
    if (!row) throw BunQLError.dbNotFound(name)
    const tenant = this.open(name)
    this.#open.delete(name)
    this.#pinned.delete(name)
    return tenant.delete()
  }

  /**
   * Keeps a tenant out of the eviction sweep. The realtime engine's hooks live on the writer
   * connection, so closing a tenant that somebody is subscribed to would silently stop the feed.
   * Pins nest; `unpin` removes one.
   */
  pin(name: string): void {
    this.#pinned.add(name)
  }

  unpin(name: string): void {
    this.#pinned.delete(name)
  }

  get pinned(): ReadonlySet<string> {
    return this.#pinned
  }

  /** Closes a tenant without deleting anything. It reopens on the next `open`. */
  release(name: string): void {
    const tenant = this.#open.get(name)
    this.#pinned.delete(name)
    if (!tenant) return
    this.#open.delete(name)
    if (!tenant.closed) tenant.close()
    this.#stopSweeperIfIdle()
  }

  /**
   * Drops a tenant the way a crash would: descriptors released, nothing flushed, saved or
   * checkpointed. For tests of the reconcile path and for a hard shutdown.
   */
  abandon(name: string): void {
    const tenant = this.#open.get(name)
    if (!tenant) return
    this.#open.delete(name)
    if (!tenant.closed) tenant.abandon()
    this.#stopSweeperIfIdle()
  }

  stats(): RegistryStats {
    this.#assertOpen()
    return {
      open: this.#open.size,
      maxOpen: this.maxOpen,
      tenants: this.catalog.listTenants().length,
      evictions: this.#evictions,
      openTenants: [...this.#open.values()].map((tenant) => tenant.stats()),
    }
  }

  /** Runs the idle checkpoint policy over every open tenant. The sweeper calls this. */
  maintain(now = Date.now()): void {
    for (const tenant of [...this.#open.values()]) {
      if (tenant.closed) {
        this.#open.delete(tenant.name)
        continue
      }
      try {
        tenant.maintain(now)
      } catch (err) {
        this.#report(err)
      }
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
    for (const tenant of [...this.#open.values()]) {
      try {
        if (!tenant.closed) tenant.close()
      } catch (err) {
        this.#report(err)
      }
    }
    this.#open.clear()
    this.catalog.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  // -------------------------------------------------------------------------

  #openRow(row: TenantRow): Tenant {
    const options: TenantOptions = {
      name: row.name,
      dataDir: this.dir,
      dir: tenantDir(this.dir, row.name),
      catalog: this.catalog,
      pageSize: row.pageSize,
      quotaBytes: row.quotaBytes,
      epoch: row.epoch,
      position: positionOf(row),
      readers: this.#options.readers ?? 2,
      ...(this.#options.busyTimeoutMs !== undefined
        ? { busyTimeoutMs: this.#options.busyTimeoutMs }
        : {}),
      ...(this.#options.checkpointWalBytes !== undefined
        ? { checkpointWalBytes: this.#options.checkpointWalBytes }
        : {}),
      ...(this.#options.idleCheckpointMs !== undefined
        ? { idleCheckpointMs: this.#options.idleCheckpointMs }
        : {}),
      ...(this.#options.defaultAck !== undefined ? { defaultAck: this.#options.defaultAck } : {}),
      ...(this.#options.waitMs !== undefined ? { waitMs: this.#options.waitMs } : {}),
      ...(this.#options.segmentBytes !== undefined
        ? { segmentBytes: this.#options.segmentBytes }
        : {}),
      ...(this.#options.logFsync !== undefined ? { logFsync: this.#options.logFsync } : {}),
      ...(this.#options.onError !== undefined ? { onError: this.#options.onError } : {}),
      ...(this.#options.onConnection !== undefined
        ? { onConnection: this.#options.onConnection }
        : {}),
    }
    const tenant = Tenant.open(options)
    this.#open.set(row.name, tenant)
    if (this.#options.onOpen) {
      try {
        this.#options.onOpen(tenant)
      } catch (err) {
        this.#report(err)
      }
    }
    this.#evict()
    this.#startSweeper()
    return tenant
  }

  /** Closes the least recently used tenants until the cap holds. Busy tenants are skipped. */
  #evict(): void {
    if (this.#open.size <= this.maxOpen) return
    for (const [name, tenant] of this.#open) {
      if (this.#open.size <= this.maxOpen) break
      if (tenant.busy || this.#pinned.has(name)) continue
      this.#open.delete(name)
      try {
        tenant.close()
      } catch (err) {
        this.#report(err)
      }
      this.#evictions += 1
    }
    // Everything left is busy: the cap is a target, not a promise a correct write can break.
  }

  #startSweeper(): void {
    if (this.#sweeper !== null || this.#closed) return
    const interval = this.#options.sweepIntervalMs ?? 250
    this.#sweeper = setInterval(() => this.maintain(), interval)
    // Maintenance must never be the reason a process stays alive.
    this.#sweeper.unref?.()
  }

  #stopSweeperIfIdle(): void {
    if (this.#open.size === 0 && this.#sweeper !== null) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
  }

  /** Design §4.7: the server checks the fd budget at start and warns. */
  #checkFdBudget(): void {
    const limit = fileDescriptorLimit()
    if (limit === null) return
    const needed = this.maxOpen * FDS_PER_TENANT
    if (needed <= limit) return
    const warn = this.#options.warn ?? ((message: string) => console.warn(message))
    warn(
      `bunql: maxOpen ${this.maxOpen} needs about ${needed} file descriptors but ulimit -n is ` +
        `${limit}. Lower maxOpen to ${Math.floor(limit / FDS_PER_TENANT)} or raise the limit.`,
    )
  }

  #report(err: unknown): void {
    const onError = this.#options.onError
    if (onError) onError(err)
    else console.error("bunql: tenant registry", err)
  }

  #assertOpen(): void {
    if (this.#closed) throw new TenantError("CLOSED", `tenant registry for ${this.dir} is closed`)
  }
}

/** The trash directory a deleted tenant's files are moved to. */
export function trashDir(dataDir: string): string {
  return path.join(dataDir, "trash")
}
