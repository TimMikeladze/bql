// The LRU of open tenants (design §4.2). Opening a database costs ~17 µs, so a miss is cheap and
// the cap exists for file descriptors rather than for speed: writer + readers ≈ 7 fds per open
// tenant, so `maxOpen` is checked against `ulimit -n` at start.
//
// Invariant: a tenant with work in flight is never evicted. Eviction closes connections, and a
// connection closed underneath a running write would lose the transaction the caller is waiting
// on, so the sweep skips anything busy rather than waiting for it.
//
// Second invariant: `sweepTrash` removes a directory only when its name carries the timestamp
// `Tenant.delete` stamped on it and that timestamp is older than the retention. Anything else in
// `<dataDir>/trash/` is left where it is — the sweep never guesses at the age of a directory it
// did not name.

import fs from "node:fs"
import path from "node:path"
import { BunQLError } from "../server/errors.ts"
import { Database } from "../sqlite/index.ts"
import { type ApplyMechanism, computeFull } from "../wal/index.ts"
import { FsyncSweep } from "../durability/index.ts"
import {
  type AckWithoutReplicas,
  Catalog,
  positionOf,
  type TenantRole,
  type TenantRow,
} from "./catalog.ts"
import {
  type AckLevel,
  assertValidName,
  type SqlitePragmas,
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
  /** Compress record bodies with zstd. Default true; see `TenantOptions.compressLog`. */
  compressLog?: boolean
  /** P5: file a committed transaction after the client is answered, for `ack: "local"`. */
  deferAppend?: boolean
  /** Most statements one group commit folds; see `TenantOptions.maxGroupCommit`. */
  maxGroupCommit?: number
  /**
   * Distinct databases one principal may hold pinned open with subscriptions (L4). Default 64.
   * Past it, `429 PIN_LIMIT`.
   */
  maxPinnedPerPrincipal?: number
  /** `[durability] fsyncSweep`: `"shared"` puts every tenant's fsync on one sweep (L5). */
  fsyncSweep?: "shared" | "per-db"
  /** Write-queue ceilings, one tenant at a time; see `TenantOptions` (L2). */
  maxQueuedWrites?: number
  maxQueuedWriteBytes?: number
  queueWaitMs?: number
  /** Replica apply mechanism and its lock wait; see `TenantOptions.applyMechanism`. */
  applyMechanism?: ApplyMechanism
  applyBusyMs?: number
  /** Per-connection pragmas for every tenant this registry opens (`docs/p1-pragmas.md`). */
  sqlite?: SqlitePragmas
  /** How often idle tenants are checked for a TRUNCATE checkpoint. Default 250 ms. */
  sweepIntervalMs?: number
  /** Where the fd-budget warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void
  /**
   * L3: the file-descriptor check, when this registry is not the one that should perform it.
   *
   * `data.maxOpen` is the **node's** number. Bun workers are threads sharing one descriptor table,
   * so a node with `workers: 8` and `maxOpen: 1024` divides that into eight shares of 128 — and a
   * worker warning about *its* share would under-report the node's requirement by exactly the
   * worker count, which is what it used to do. Pass `false` on a worker: the router probes once
   * and warns once for the whole node.
   */
  fdBudget?: false
  onError?: (err: unknown) => void
  /** Passed to every tenant: called for each connection opened, writer or reader. */
  onConnection?: (db: Database, role: "writer" | "reader") => void
  /**
   * Called once for every tenant this registry opens, however it was reached — `open`, `create`,
   * a fork or an import. It is the only place a caller can see every live tenant without holding
   * them all open itself, which is what a process-wide commit listener needs.
   */
  onOpen?: (tenant: Tenant) => void
  /**
   * Called after a database is created, imported or deleted — the set `list()` returns has
   * changed. R2's finding 1: the primary announces its databases to attached replicas the moment
   * one appears, so a `follow: ["*"]` replica starts streaming it in milliseconds rather than at
   * the next heartbeat.
   */
  onChange?: (event: { kind: "create" | "delete"; name: string }) => void
}

export interface CreateOptions {
  pageSize?: number
  quotaBytes?: number
  /** `"replica"` creates a database this node follows; see `createReplica`. Default `"primary"`. */
  role?: TenantRole
  epoch?: number
  /** Fork of another database (design §4.4, §6.5): O(1) where the filesystem reflinks. */
  from?: { db: string; at?: bigint }
}

/** Everything the replication client needs to swap a bootstrapped snapshot into place. */
export interface SnapshotInstall {
  /** The verified snapshot file. It is *moved*, so the caller must not touch it afterwards. */
  file: string
  txid: bigint
  epoch: number
  /** Rolling database checksum of the file. */
  checksum: bigint
  pages: number
  pageSize: number
}

export interface RegistryStats {
  open: number
  maxOpen: number
  tenants: number
  evictions: number
  /** Writes queued across every open tenant right now (L2). */
  writeQueueDepth: number
  /** Open tenants a subscription is holding open (L4). */
  pinned: number
  /** Opens refused because every open tenant was pinned (L4). */
  openRefused: number
  /** L5's sweep, absent under `"per-db"`. */
  fsync: { total: number; lastDurationUs: number; pending: number; deferred: number } | null
  /**
   * P7: every connection this registry has opened, added up — including those of tenants it has
   * since evicted, which is why the counters live here rather than being summed from `openTenants`.
   * Rising `evictions` is the thrash `[sqlite] statementCache` raises.
   */
  statementCache: { hits: number; misses: number; evictions: number }
  /** Per-tenant stats for everything currently open. */
  openTenants: TenantStats[]
}

/** Computed once per process; the answer cannot change under us and the probe is a subprocess. */
let fdLimitCache: number | null | undefined

/**
 * The process's open-file limit, or null when there is no such number to read.
 *
 * **Null on Windows, and that is the answer rather than a failure.** Win32 has no per-process
 * descriptor rlimit: the CRT's `_setmaxstdio` bounds only stdio-style handles, and a kernel handle
 * is bounded by paged-pool memory rather than by a count. Before L3 this shelled out to
 * `sh -c "ulimit -n"` on every platform — and on Windows that does not fail, because Git for
 * Windows puts Git Bash on `PATH`: it returned an MSYS shell's limit and warned against a number
 * that describes nothing this process is subject to.
 *
 * On POSIX it is still `ulimit -n`, because Bun's `process.report.getReport()` carries no `rlimit`
 * section (checked on Bun 1.4) and reaching `getrlimit(2)` would mean a second `dlopen` of libc on
 * every start, for a warning. It is memoised, and a sharded node probes on the router and passes
 * the answer to its workers, so a node spawns one subprocess rather than one per thread.
 */
export function fileDescriptorLimit(): number | null {
  if (fdLimitCache !== undefined) return fdLimitCache
  fdLimitCache = probeFileDescriptorLimit()
  return fdLimitCache
}

function probeFileDescriptorLimit(): number | null {
  if (process.platform === "win32") return null
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

/**
 * How many descriptors a node holding `tenants` open databases needs, and what `maxOpen` it could
 * carry within `limit`. One function so the router and a single-threaded node say the same thing.
 */
export function fdBudgetFor(tenants: number): { needed: number; limit: number | null } {
  return { needed: tenants * FDS_PER_TENANT, limit: fileDescriptorLimit() }
}

/**
 * The `maxOpen` share one worker of `workers` gets out of a node budget of `maxOpen`.
 *
 * The floor is **one**, not the eight `docs/plan-limits.md` proposed, and the reason is the rule
 * the whole track is built on: a per-worker floor of eight is `8 * workers` wearing a disguise,
 * which is exactly the "per-tenant limit times open tenants is not a limit" this milestone exists
 * to delete. A node configured small stays small; `maxOpenThrashes` is what says so out loud.
 */
export function maxOpenShare(maxOpen: number, workers: number): number {
  if (workers <= 1) return maxOpen
  return Math.max(1, Math.floor(maxOpen / workers))
}

/**
 * True when dividing `maxOpen` across `workers` leaves each shard too little to work with. A shard
 * that can hold only a handful of databases open evicts and reopens on every request that misses,
 * which is slow rather than wrong — so it is a warning, not a refusal.
 */
export function maxOpenThrashes(maxOpen: number, workers: number): boolean {
  return workers > 1 && maxOpenShare(maxOpen, workers) < 8
}

/**
 * Warns if holding `tenants` databases open would want more descriptors than this process has.
 * Called once per node: by the registry on a single-threaded node, and by the router on a sharded
 * one, where `tenants` is the node's `maxOpen` rather than any worker's share of it.
 */
export function warnFdBudget(tenants: number, warn?: (message: string) => void): void {
  const { needed, limit } = fdBudgetFor(tenants)
  if (limit === null || needed <= limit) return
  const say = warn ?? ((message: string) => console.warn(message))
  say(
    `bunql: maxOpen ${tenants} needs about ${needed} file descriptors but ulimit -n is ` +
      `${limit}. Lower maxOpen to ${Math.floor(limit / FDS_PER_TENANT)} or raise the limit.`,
  )
}

export interface PinOptions {
  /**
   * Count this pin against `maxPinnedPerPrincipal` and refuse past it. True for a client token,
   * which is the principal this ceiling exists for; false for the operator's admin key, for an
   * in-process embedded caller and for the node's own holders — a replica stream, a baton
   * transaction — none of which are a client that can open two thousand subscriptions.
   */
  capped?: boolean
}

/** Shared empty answer for `pinnedBy`, so the common miss allocates nothing. */
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>()

export class TenantRegistry {
  readonly dir: string
  readonly catalog: Catalog
  readonly maxOpen: number
  /** Distinct databases one principal may pin; see `pin` (L4). */
  readonly maxPinnedPerPrincipal: number
  /** This thread's shared fsync sweep, or null under `[durability] fsyncSweep = "per-db"` (L5). */
  readonly fsyncSweep: FsyncSweep | null

  #options: RegistryOptions
  /** Insertion order is recency: the oldest entry is the first eviction candidate. */
  #open = new Map<string, Tenant>()
  /**
   * Names the LRU may not close, and who asked, and how many times. A tenant with a live
   * subscription still has to see commits, and so does one a replica is streaming from — and
   * neither holder may release the other's pin, which is why this is keyed by owner rather than
   * being a bare set.
   *
   * L4 made it a **count** per owner rather than a set membership: with the owner now being the
   * principal, one principal holds several subscriptions to the same database, and the first of
   * them to close must not release the pin the others still need.
   */
  #pinned = new Map<string, Map<string, number>>()
  /** The same thing from the other side, so `maxPinnedPerPrincipal` is a `Set.size` (L4). */
  #pinnedByOwner = new Map<string, Set<string>>()
  /** Opens refused because the LRU was entirely pinned; `bunql_open_refused_total`. */
  #openRefused = 0
  /**
   * Per-database `ackWithoutReplicas`, memoised. `AckTracker` asks on every `replica`/`quorum`
   * write, and the answer is a catalog row that only this class writes — so it is cached here and
   * invalidated wherever that row can change (`docs/r8-per-db-ack.md`). `undefined` in the map is
   * a miss; `null` is the answer "this database follows the node".
   */
  #ackOverrides = new Map<string, AckWithoutReplicas | null>()
  #sweeper: ReturnType<typeof setInterval> | null = null
  #evictions = 0
  /**
   * P7: one object handed to every connection every tenant opens, so the node's totals are
   * monotonic across an open, an evict and a close. Three integer increments per `prepare()`,
   * which is noise against the `Map` lookup beside them.
   */
  #statementCache = { hits: 0, misses: 0, evictions: 0 }
  #closed = false

  private constructor(options: RegistryOptions, catalog: Catalog) {
    this.dir = options.dir
    this.catalog = catalog
    this.maxOpen = options.maxOpen ?? 1024
    this.maxPinnedPerPrincipal = Math.max(1, options.maxPinnedPerPrincipal ?? 64)
    // L5: one sweep per registry, which on a server is one per thread. Created only when asked
    // for, so `"per-db"` — the default, and the back-out — allocates nothing and behaves exactly
    // as it did before L5.
    this.fsyncSweep = options.fsyncSweep === "shared" ? new FsyncSweep() : null
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
      const tenant = this.#openRow(row)
      this.#changed("create", name)
      return tenant
    }

    const dir = tenantDir(this.dir, name)
    fs.mkdirSync(dir, { recursive: true })
    const row = this.catalog.createTenant({
      name,
      pageSize: options.pageSize ?? this.#options.pageSize ?? 4096,
      quotaBytes: options.quotaBytes ?? this.#options.quotaBytes ?? 0,
      ...(options.role ? { role: options.role } : {}),
      ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
    })
    const tenant = this.#openRow(row)
    this.#changed("create", name)
    return tenant
  }

  // ── replica mode (design §5.2) ───────────────────────────────────────────────────────────────

  /**
   * Opens a database this node follows. Unlike `open`, it also switches an existing row into
   * replica mode: a node restarted as a replica of another one must not keep authoring
   * transactions for a database it used to own.
   */
  openReplica(name: string): Tenant {
    this.#assertOpen()
    const hit = this.#open.get(name)
    if (hit && !hit.closed && hit.isReplica) {
      this.#open.delete(name)
      this.#open.set(name, hit)
      return hit
    }
    const row = this.catalog.getTenant(name)
    if (!row) throw BunQLError.dbNotFound(name)
    if (row.role !== "replica") {
      this.release(name)
      this.catalog.setRole(name, "replica")
    }
    return this.#openRow({ ...row, role: "replica" })
  }

  /**
   * Creates a database in replica mode, for one the primary announced that this node has never
   * seen. Synchronous, unlike `create`: there is no file to copy, because the stream will either
   * send a snapshot or start at txid 0 against an empty database.
   */
  createReplica(name: string, options: { pageSize?: number; epoch?: number } = {}): Tenant {
    this.#assertOpen()
    assertValidName(name)
    const existing = this.catalog.getTenant(name)
    if (existing) return this.openReplica(name)
    fs.mkdirSync(tenantDir(this.dir, name), { recursive: true })
    const row = this.catalog.createTenant({
      name,
      pageSize: options.pageSize ?? this.#options.pageSize ?? 4096,
      quotaBytes: this.#options.quotaBytes ?? 0,
      role: "replica",
      ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
    })
    const tenant = this.#openRow(row)
    // A replica that picks up a new database announces it downstream too: chained replication
    // (primary → replica → replica) reaches the third node the same way the second one did.
    this.#changed("create", name)
    return tenant
  }

  /**
   * Replaces a replica's database with a bootstrapped snapshot and reopens it at the snapshot's
   * position. Everything derived from the old file goes with it: the applier's `meta.json`, the
   * `-wal` and `-shm` it wrote, and the local log, whose records no longer connect to anything
   * (see `docs/r1-replication.md` deviation 7).
   */
  installSnapshot(name: string, install: SnapshotInstall): Tenant {
    this.#assertOpen()
    const row = this.catalog.getTenant(name)
    if (!row) throw BunQLError.dbNotFound(name)
    // Every holder's pins, so they can be put back exactly as they were rather than collapsed
    // into one anonymous one — with the owner now being the principal, that distinction is the
    // per-principal cap (L4).
    const heldBy = new Map(this.#pinned.get(name) ?? [])
    this.release(name)
    const dir = tenantDir(this.dir, name)
    const dbPath = path.join(dir, "main.db")
    fs.mkdirSync(dir, { recursive: true })
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true })
    fs.rmSync(path.join(dir, "meta.json"), { force: true })
    fs.rmSync(path.join(dir, "log"), { recursive: true, force: true })
    fs.renameSync(install.file, dbPath)
    this.catalog.setRole(name, "replica")
    this.catalog.savePosition(name, {
      txid: install.txid,
      epoch: install.epoch,
      checksum: install.checksum,
      dbSizePages: install.pages,
      wal: { salt1: 0, salt2: 0, frame: 0 },
    })
    const tenant = this.#openRow({
      ...row,
      role: "replica",
      epoch: install.epoch,
      txid: install.txid,
      checksum: install.checksum,
      dbSizePages: install.pages,
      pageSize: install.pageSize || row.pageSize,
      walSalt1: 0,
      walSalt2: 0,
      walFrame: 0,
    })
    for (const [owner, count] of heldBy) {
      for (let i = 0; i < count; i++) this.pin(name, owner)
    }
    return tenant
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
      const tenant = this.#openRow(row)
      this.#changed("create", name)
      return tenant
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
    this.#clearPins(name)
    // The name is free again, and a database created under it next follows the node.
    this.#ackOverrides.delete(name)
    const trash = tenant.delete()
    this.#changed("delete", name)
    return trash
  }

  /** Tells the owner the database set moved. A throwing listener must not fail the operation. */
  #changed(kind: "create" | "delete", name: string): void {
    const onChange = this.#options.onChange
    if (!onChange) return
    try {
      onChange({ kind, name })
    } catch (err) {
      this.#report(err)
    }
  }

  /**
   * Keeps a tenant out of the eviction sweep. The realtime engine's hooks live on the writer
   * connection, so closing a tenant that somebody is subscribed to would silently stop the feed.
   * `owner` separates holders: `unpin` releases one holder's claim, and the tenant stays pinned
   * while any other holder still has one.
   *
   * **L4: a pin is not a licence.** A pin lasts as long as a client keeps a subscription open, so
   * without a ceiling one client opening a subscription against each of two thousand databases
   * pinned two thousand tenants past `maxOpen` and nothing refused it. An owner may hold at most
   * `maxPinnedPerPrincipal` *distinct* databases pinned; past that, `429 PIN_LIMIT`. Another
   * subscription to a database this owner already pins is always admitted — it costs nothing new.
   */
  pin(name: string, owner = "default", options: PinOptions = {}): void {
    const held = this.#pinnedByOwner.get(owner)
    if (options.capped && held && !held.has(name) && held.size >= this.maxPinnedPerPrincipal) {
      throw new BunQLError(
        "PIN_LIMIT",
        `this principal already holds ${this.maxPinnedPerPrincipal} databases open with ` +
          `subscriptions; close one before subscribing to ${name}`,
        429,
      )
    }
    const owners = this.#pinned.get(name)
    if (owners) owners.set(owner, (owners.get(owner) ?? 0) + 1)
    else this.#pinned.set(name, new Map([[owner, 1]]))
    if (held) held.add(name)
    else this.#pinnedByOwner.set(owner, new Set([name]))
  }

  unpin(name: string, owner = "default"): void {
    const owners = this.#pinned.get(name)
    if (!owners) return
    const count = owners.get(owner)
    if (count === undefined) return
    if (count > 1) {
      owners.set(owner, count - 1)
      return
    }
    owners.delete(owner)
    if (owners.size === 0) this.#pinned.delete(name)
    this.#dropOwner(name, owner)
  }

  /** Every name `owner` holds pinned right now. */
  pinnedBy(owner: string): ReadonlySet<string> {
    return this.#pinnedByOwner.get(owner) ?? EMPTY_NAMES
  }

  get pinned(): ReadonlySet<string> {
    return new Set(this.#pinned.keys())
  }

  #dropOwner(name: string, owner: string): void {
    const held = this.#pinnedByOwner.get(owner)
    if (!held) return
    held.delete(name)
    if (held.size === 0) this.#pinnedByOwner.delete(owner)
  }

  /** Forgets every pin on a name, from every owner. `release` and `delete` take the tenant away. */
  #clearPins(name: string): void {
    const owners = this.#pinned.get(name)
    if (!owners) return
    for (const owner of owners.keys()) this.#dropOwner(name, owner)
    this.#pinned.delete(name)
  }

  /** Closes a tenant without deleting anything. It reopens on the next `open`. */
  /**
   * Sets (or clears, with `null`) one database's `PRAGMA foreign_keys` override.
   *
   * The pragma is per *connection*, so an open tenant is released: the next open reads the catalog
   * and applies it. Releasing is what `Promoter.#flip` does for a role change, for the same reason
   * — a setting written to the catalog under a live connection would not be reached until that
   * connection happened to be evicted.
   */
  setForeignKeys(name: string, value: boolean | null): void {
    this.#assertOpen()
    if (!this.catalog.getTenant(name)) throw BunQLError.dbNotFound(name)
    this.catalog.setForeignKeys(name, value)
    this.release(name)
  }

  /**
   * Sets (or clears, with `null`) one database's `ackWithoutReplicas` override.
   *
   * Nothing is released: unlike `foreign_keys` this is not a connection property, it is read at
   * ack time by `AckTracker`. The next write sees it, whether or not the tenant is open.
   */
  setAckWithoutReplicas(name: string, value: AckWithoutReplicas | null): void {
    this.#assertOpen()
    if (!this.catalog.getTenant(name)) throw BunQLError.dbNotFound(name)
    this.catalog.setAckWithoutReplicas(name, value)
    this.#ackOverrides.set(name, value)
  }

  /**
   * This database's `ackWithoutReplicas`, or null when it follows the node. The write path's
   * question, so it is answered from the memo rather than from SQLite.
   */
  ackWithoutReplicasOf(name: string): AckWithoutReplicas | null {
    const hit = this.#ackOverrides.get(name)
    if (hit !== undefined) return hit
    if (this.#closed) return null
    const value = this.catalog.getTenant(name)?.ackWithoutReplicas ?? null
    this.#ackOverrides.set(name, value)
    return value
  }

  release(name: string): void {
    const tenant = this.#open.get(name)
    this.#clearPins(name)
    // Every holder's pin goes with the tenant; a caller that still wants it pinned reopens it.
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
    const openTenants = [...this.#open.values()].map((tenant) => tenant.stats())
    let writeQueueDepth = 0
    for (const one of openTenants) writeQueueDepth += one.queuedWrites
    return {
      open: this.#open.size,
      maxOpen: this.maxOpen,
      tenants: this.catalog.listTenants().length,
      evictions: this.#evictions,
      writeQueueDepth,
      pinned: this.#pinned.size,
      openRefused: this.#openRefused,
      fsync: this.fsyncSweep
        ? {
            total: this.fsyncSweep.fsyncs,
            lastDurationUs: this.fsyncSweep.lastDurationUs,
            pending: this.fsyncSweep.pending,
            deferred: this.fsyncSweep.deferred,
          }
        : null,
      statementCache: { ...this.#statementCache },
      openTenants,
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
    this.#ackOverrides.clear()
    // After the tenants, so a log that still had unsynced bytes when it closed has already gone.
    this.fsyncSweep?.close()
    this.catalog.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  // -------------------------------------------------------------------------

  #openRow(row: TenantRow): Tenant {
    const options: TenantOptions = {
      name: row.name,
      role: row.role,
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
      ...(this.#options.deferAppend !== undefined ? { deferAppend: this.#options.deferAppend } : {}),
      // The node's pragmas, with this database's own `foreign_keys` on top when it has one. A
      // null in the catalog means "follow the node", which is not the same fact as "off".
      ...(this.#options.sqlite !== undefined || row.foreignKeys !== null
        ? {
            sqlite: {
              ...this.#options.sqlite,
              ...(row.foreignKeys !== null ? { foreignKeys: row.foreignKeys } : {}),
            },
          }
        : {}),
      ...(this.#options.compressLog !== undefined
        ? { compressLog: this.#options.compressLog }
        : {}),
      ...(this.#options.maxGroupCommit !== undefined
        ? { maxGroupCommit: this.#options.maxGroupCommit }
        : {}),
      ...(this.#options.maxQueuedWrites !== undefined
        ? { maxQueuedWrites: this.#options.maxQueuedWrites }
        : {}),
      ...(this.#options.maxQueuedWriteBytes !== undefined
        ? { maxQueuedWriteBytes: this.#options.maxQueuedWriteBytes }
        : {}),
      ...(this.#options.queueWaitMs !== undefined
        ? { queueWaitMs: this.#options.queueWaitMs }
        : {}),
      ...(this.fsyncSweep ? { fsyncSweep: this.fsyncSweep } : {}),
      statementCacheCounters: this.#statementCache,
      ...(this.#options.applyMechanism !== undefined
        ? { applyMechanism: this.#options.applyMechanism }
        : {}),
      ...(this.#options.applyBusyMs !== undefined
        ? { applyBusyMs: this.#options.applyBusyMs }
        : {}),
      ...(this.#options.onError !== undefined ? { onError: this.#options.onError } : {}),
      ...(this.#options.onConnection !== undefined
        ? { onConnection: this.#options.onConnection }
        : {}),
    }
    // L4: make room *before* opening, so a node whose LRU is entirely pinned refuses the open
    // rather than admitting past `maxOpen` and calling the cap a target. A busy tenant still
    // overshoots, still by one statement, still on purpose.
    if (this.#open.size >= this.maxOpen && this.#evict(this.maxOpen - 1) === "pinned") {
      this.#openRefused += 1
      throw new BunQLError(
        "TOO_MANY_OPEN",
        `this node holds its maxOpen of ${this.maxOpen} databases open and every one of them is ` +
          `pinned by a subscription; cannot open ${row.name}`,
        503,
      )
    }
    const tenant = Tenant.open(options)
    this.#open.set(row.name, tenant)
    // The one place every create, fork, import, revive and reopen passes through, so the ack memo
    // is refreshed here rather than at each of them.
    this.#ackOverrides.set(row.name, row.ackWithoutReplicas)
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

  /**
   * Closes least recently used tenants until at most `target` are open, and says what stopped it.
   *
   * `"busy"` is the one overshoot this design allows, and only because it is bounded by the
   * duration of one statement: refusing a correct write because the LRU is full would be a worse
   * answer than being one over the cap for a moment. `"pinned"` is not bounded by anything — a pin
   * lasts as long as a client keeps a subscription open — so the caller refuses the open instead
   * (L4, `docs/l4-pin-limit.md`).
   */
  #evict(target = this.maxOpen): "ok" | "busy" | "pinned" {
    if (this.#open.size <= target) return "ok"
    let busy = false
    let pinned = false
    for (const [name, tenant] of this.#open) {
      if (this.#open.size <= target) break
      if (tenant.busy) {
        busy = true
        continue
      }
      if (this.#pinned.has(name)) {
        pinned = true
        continue
      }
      this.#open.delete(name)
      try {
        tenant.close()
      } catch (err) {
        this.#report(err)
      }
      this.#evictions += 1
    }
    if (this.#open.size <= target) return "ok"
    // A busy tenant is about to stop being busy; a pinned one is not, so it is the honest answer
    // when both are in the way.
    return pinned ? "pinned" : busy ? "busy" : "ok"
  }

  /**
   * `sweepTrash` against this registry's data root, with failures going wherever the registry's
   * own failures go. The server runtime calls it at start and on `[durability] sweepIntervalMs`,
   * alongside the per-database log and snapshot retention (`docs/r6-retention.md`).
   */
  sweepTrash(retentionMs: number, now?: number): { removed: string[]; bytes: number } {
    return sweepTrash(this.dir, retentionMs, now, (err) => this.#report(err))
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
    if (this.#options.fdBudget === false) return
    warnFdBudget(this.maxOpen, this.#options.warn)
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

/**
 * The epoch-millisecond suffix `Tenant.delete` stamps onto a trashed directory, or null when the
 * name does not carry one. A tenant name may itself contain digits and dashes, so the suffix is
 * the part after the *last* dash and nothing else is guessed at: an entry an operator dropped in
 * by hand, or one from a future naming scheme, has no timestamp and is therefore never removed.
 */
function trashedAt(entry: string): number | null {
  const dash = entry.lastIndexOf("-")
  if (dash <= 0 || dash === entry.length - 1) return null
  const suffix = entry.slice(dash + 1)
  if (!/^\d+$/.test(suffix)) return null
  const at = Number(suffix)
  return Number.isSafeInteger(at) ? at : null
}

/** Bytes under `dir`, following no symlinks and charging a directory nothing of its own. */
function bytesUnder(dir: string): number {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += bytesUnder(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

/**
 * Removes the trashed databases older than `retentionMs`. `DELETE /v1/db/{db}` moves a tenant's
 * directory to `<dataDir>/trash/<name>-<ms>` and removes nothing, so without this a node that
 * churns databases grows its trash for ever.
 *
 * Pure by design — it takes a directory and a clock rather than a registry — so a test can state
 * "older than the retention goes, newer stays" without a server. `retentionMs <= 0` means keep
 * for ever and sweeps nothing, matching `[s3] retention = "0"`. A removal that throws (a file
 * still mapped, a permissions error) is handed to `onError` and the sweep carries on: one
 * undeletable directory must not pin every other one.
 */
export function sweepTrash(
  dataDir: string,
  retentionMs: number,
  now: number = Date.now(),
  onError?: (err: unknown) => void,
): { removed: string[]; bytes: number } {
  const removed: string[] = []
  let bytes = 0
  if (!(retentionMs > 0)) return { removed, bytes }
  const root = trashDir(dataDir)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    // Nothing has ever been deleted on this node, which is the common case and not a failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") onError?.(err)
    return { removed, bytes }
  }
  const cutoff = now - retentionMs
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const at = trashedAt(entry.name)
    if (at === null || at > cutoff) continue
    const full = path.join(root, entry.name)
    try {
      const size = bytesUnder(full)
      fs.rmSync(full, { recursive: true, force: true })
      removed.push(full)
      bytes += size
    } catch (err) {
      onError?.(err)
    }
  }
  return { removed, bytes }
}
