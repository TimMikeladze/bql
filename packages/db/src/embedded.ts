// The embedded API of design §9.2: the same engine the server runs, in this process, behind the
// same `Db` interface the client SDK exposes — plus a synchronous escape hatch for hot loops.
//
// Invariant: one `ServerRuntime` owns the registry, and `serve()` mounts the HTTP surface over
// that same runtime. Two runtimes over one registry would each install an `AuthorizerHub` on the
// same connection and fight for SQLite's single authorizer slot (`src/server/runtime.ts`).
//
// Second invariant: the embedded caller is the admin principal. It already has the data directory
// open; a token here would be a lock with its key taped to it. Tokens start applying again at
// `serve()`, which is the network surface.

import { basename } from "node:path"
import {
  ChangeFeed,
  LiveQuery,
  decodeChangeEvent,
  decodeLiveDiff,
  decodeLiveRows,
  type ChangeSink,
  type LiveSink,
} from "./client/feed.ts"
import { BqlClientError } from "./client/errors.ts"
import type {
  Ack,
  Args,
  ChangeEvent,
  CheckpointMode,
  CheckpointResult,
  LiveDiffEvent,
  LiveRowsEvent,
  QueryResult,
  RequestOptions,
  RowsMode,
  SnapshotInfo,
  StatementRequest,
} from "./client/protocol.ts"
import {
  Query,
  fromArgs,
  fromTemplate,
  liveRequest,
  toResult,
  type QueryArgs,
  type Result,
  type Runner,
} from "./client/sql.ts"
import type { IntMode, JsRow, JsValue } from "./client/values.ts"
import type {
  BatchItem,
  BatchOptions,
  ChangesOptions,
  Db,
  LiveTag,
  SqlTag,
  StatementOptions,
  StmtTag,
  TransactionOptions,
  Tx,
} from "./client/index.ts"
import { createRuntime, startServer, type Mount, type ServerHandle } from "./server/app.ts"
import { ADMIN } from "./server/auth.ts"
import { loadConfig, type ServerConfig, type ServerConfigInput } from "./server/config.ts"
import { mapError } from "./server/errors.ts"
import { executeBatch, executeInTx, executeStatement, resolveOptions } from "./server/exec.ts"
import { guarded } from "./server/guard.ts"
import { lineageOf, resolveAt, statsOf } from "./server/routes.ts"
import type { NodeRole } from "./server/promote.ts"
import { mapTenantError, type ServerRuntime, type TxSession } from "./server/runtime.ts"
import type { Database } from "./sqlite/index.ts"
import { assertValidName, type CommitEvent, type Tenant, type TenantRow } from "./tenant/index.ts"

export interface OpenOptions extends ServerConfigInput {
  /** Data root. Shorthand for `data: { dir }`. */
  dir?: string
  /** What an integer beyond 2^53 becomes in a result. Default `"number"`, which throws. */
  intMode?: IntMode
  /**
   * A `bql.toml` to read first. Embedded callers configure in code by default, so no file and
   * no environment are consulted unless they are asked for here.
   */
  config?: string | null
  env?: Record<string, string | undefined>
  onError?: (err: unknown) => void
}

export interface CreateOptions {
  pageSize?: number
  quotaBytes?: number
  /** Fork of another database at a txid (design §6.5). */
  from?: { db: string; at?: number | bigint }
}

export interface ServeOptions {
  port?: number
  host?: string
  /** Where the first-start admin key notice goes. */
  log?: (message: string) => void
  /** Handlers served under a path prefix on the same listener; see `StartOptions.mount`. */
  mount?: Mount[]
}

export interface DatabaseInfo {
  name: string
  txid: number
  epoch: number
  pageSize: number
  quotaBytes: number
  createdAtMs: number
  open: boolean
  /** X2: the database this one was forked from, or null. */
  parent: string | null
  /** The parent's txid the fork was taken at, or null. */
  forkedAt: number | null
  /** True when `parent` names a database that no longer exists. */
  parentDeleted: boolean
}

/** What `bq.on("commit", …)` is handed (design §9.2). */
export interface EmbeddedCommit {
  db: string
  txid: number
}

/** What `bq.on("role", …)` is handed: this node now holds `db` as `role`. */
export interface EmbeddedRole {
  db: string
  role: NodeRole
}

/** What `db.sync.write` takes. */
export interface SyncWriteOptions {
  /**
   * What the commit does locally, as `sync.commit` takes it: `"local"`, or an fsync of the log and
   * the WAL before `write` returns for anything stronger. `"replica"` and `"quorum"` are only
   * pre-checked here (`NO_REPLICAS` before anything runs); await `bq.replicated(db, txid, { ack })`
   * for the replicas. Default `[durability] defaultAck`.
   */
  ack?: Ack
}

/** What `db.sync.commit` and `db.sync.write` answer with. */
export interface SyncCommit<T> {
  value: T
  /** The txid the commit was assigned, or the database's current txid when it wrote nothing. */
  txid: number
}

// ── the synchronous surface (design §9.2) ──────────────────────────────────────────────────────

export interface SyncQuery<T = JsRow> {
  all(): Result<T>
  get(): T | null
  values(): Result<JsValue[]>
  run(): Result<JsValue[]>
}

export interface SyncSqlTag {
  <T = JsRow>(strings: TemplateStringsArray, ...values: unknown[]): SyncQuery<T>
}

export interface SyncTx {
  readonly sql: SyncSqlTag
  execute(sql: string, args?: QueryArgs, options?: StatementOptions): SyncQuery
}

export interface SyncDb {
  readonly sql: SyncSqlTag
  execute(sql: string, args?: QueryArgs, options?: StatementOptions): SyncQuery
  batch(items: BatchItem[], options?: BatchOptions): Result<JsRow>[]
  transaction<T>(fn: (tx: SyncTx) => T, options?: TransactionOptions): T
  /** `transaction`, plus the txid it committed at, for `bq.replicated`. */
  commit<T>(fn: (tx: SyncTx) => T, options?: TransactionOptions): SyncCommit<T>
  /**
   * Runs `fn` on the database's writer connection inside `BEGIN IMMEDIATE`, commits, and records
   * the commit in the log like any other write. `d` is the `bql.sh/sqlite` driver: cached
   * `d.query()` statements, `d.transaction()` nesting as a SAVEPOINT, and reads that see this
   * transaction's own writes. `BEGIN`/`COMMIT`/`ROLLBACK`, `ATTACH`/`DETACH` and connection
   * pragmas are refused with `NOT_AUTHORIZED`. Do not keep `d` after `fn` returns.
   */
  write<T>(fn: (d: Database) => T, options?: SyncWriteOptions): SyncCommit<T>
  /**
   * Runs `fn` on a pooled read-only connection. `d.transaction()` gives a consistent snapshot
   * across several statements; a transaction still open when `fn` returns is rolled back and
   * reported as `BAD_REQUEST`. Pragmas and `ATTACH` are refused as in `write`.
   */
  read<T>(fn: (d: Database) => T): T
}

/** The embedded `Db`: everything the client's has, plus `sync`. */
export interface EmbeddedDb extends Db {
  readonly sync: SyncDb
  /** The tenant behind this handle, for code that wants the driver itself. */
  tenant(): Tenant
}

/** No error thrown yet; `undefined` is a value a callback can throw. */
const NOTHING: unique symbol = Symbol("nothing")

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

/** Every failure crosses this boundary as the error the client SDK would have thrown. */
function toClientError(err: unknown): unknown {
  const mapped = mapTenantError(err)
  if (mapped instanceof BqlClientError) return mapped
  const { body } = mapError(mapped)
  return BqlClientError.fromInfo(body.error)
}

function asStatement(item: BatchItem): StatementRequest {
  const candidate = item as { toJSON?: () => StatementRequest; sql?: unknown }
  const statement = typeof candidate.toJSON === "function" ? candidate.toJSON() : item
  const sql = (statement as StatementRequest).sql
  if (typeof sql !== "string" || sql.length === 0) {
    throw BqlClientError.client("every batch item needs a non-empty sql string")
  }
  return statement as StatementRequest
}

class LocalDb implements EmbeddedDb {
  readonly name: string
  readonly sql: SqlTag
  readonly stmt: StmtTag
  readonly live: LiveTag
  readonly sync: SyncDb

  #owner: Bql
  #intMode: IntMode

  constructor(owner: Bql, name: string) {
    this.#owner = owner
    this.#intMode = owner.intMode
    this.name = name
    this.sql = ((strings, ...values) =>
      new Query(this.#runner(), fromTemplate(strings, values), this.#intMode)) as SqlTag
    this.stmt = ((strings, ...values) => fromTemplate(strings, values)) as StmtTag
    this.live = ((first: TemplateStringsArray | string, ...rest: unknown[]) => {
      const request = liveRequest(first, rest)
      return new LiveQuery((sink, options) => this.#startLive(sink, request, options.key))
    }) as LiveTag
    this.sync = this.#syncSurface()
  }

  tenant(): Tenant {
    return this.#owner.tenantOf(this.name)
  }

  get txid(): number {
    return Number(this.tenant().txid)
  }

  execute(sql: string, args?: QueryArgs, options?: StatementOptions): Query {
    return new Query(
      this.#runner(),
      fromArgs(sql, args),
      this.#intMode,
      options as RequestOptions,
    )
  }

  unsafe(sql: string, args?: QueryArgs, options?: StatementOptions): Query {
    return this.execute(sql, args, options)
  }

  batch(items: BatchItem[], options: BatchOptions = {}): Promise<Result<JsRow>[]> {
    try {
      return Promise.resolve(this.#batchSync(items, options))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  async transaction<T>(
    fn: (tx: Tx) => Promise<T> | T,
    options: TransactionOptions = {},
  ): Promise<T> {
    const session = this.#begin(options)
    let value: T
    let txid: bigint
    try {
      value = await fn(this.#tx(session) as Tx)
      txid = this.#end(session, "commit")
    } catch (err) {
      this.#end(session, "rollback")
      throw err
    }
    // `replica` and `quorum` are waited for here, outside the transaction, as the routes do.
    if (options.ack === "replica" || options.ack === "quorum") {
      await this.#owner.replicated(this.name, txid, { ack: options.ack })
    }
    return value
  }

  /** The change feed of design §6.4, straight off the realtime bus — no HTTP in the middle. */
  changes(options: ChangesOptions = {}): ChangeFeed {
    const owner = this.#owner
    const intMode = this.#intMode
    return new ChangeFeed((sink: ChangeSink) => {
      const tenant = this.tenant()
      const runtime = owner.runtime
      runtime.retain(this.name)
      let realtime: ReturnType<ServerRuntime["realtimeFor"]>
      try {
        realtime = runtime.realtimeFor(tenant)
      } catch (err) {
        runtime.releaseSubscription(this.name)
        throw toClientError(err)
      }
      const subscription = realtime.subscribeChanges(
        {
          ...(options.tables?.length ? { tables: options.tables } : {}),
          ...(options.since !== undefined ? { since: options.since } : {}),
          include: options.include ?? "pk",
        },
        (event: ChangeEvent) => sink.change(decodeChangeEvent(event, intMode)),
      )
      if (subscription.reset) {
        sink.reset({
          txid: Number(tenant.txid),
          reason: "the change ring no longer holds that position",
        })
      }
      for (const event of subscription.backlog) sink.change(decodeChangeEvent(event, intMode))
      return () => {
        realtime.unsubscribe(subscription.sub)
        runtime.releaseSubscription(this.name)
      }
    })
  }

  // -------------------------------------------------------------------------

  #runner(): Runner {
    return (request, rows, options) =>
      Promise.resolve(this.#step(request, rows, options as StatementOptions | undefined))
  }

  /** One statement. Synchronous underneath, which is what the `sync` surface exposes directly. */
  #step(
    request: StatementRequest,
    rows: RowsMode,
    options: StatementOptions | undefined,
  ): QueryResult {
    const tenant = this.tenant()
    const resolved = resolveOptions({ ...(options ?? {}), rows }, null, this.#owner.config)
    try {
      return executeStatement(this.#owner.runtime, tenant, ADMIN, request, resolved).result
    } catch (err) {
      throw toClientError(err)
    }
  }

  #batchSync(items: BatchItem[], options: BatchOptions): Result<JsRow>[] {
    const statements = items.map(asStatement)
    if (statements.length === 0) {
      throw BqlClientError.client("batch needs at least one statement")
    }
    const tenant = this.tenant()
    const resolved = resolveOptions(
      { ...options, rows: options.rows ?? "object" },
      null,
      this.#owner.config,
    )
    try {
      const result = executeBatch(
        this.#owner.runtime,
        tenant,
        ADMIN,
        { statements, ...(options.atomic === false ? { atomic: false } : {}) },
        resolved,
      )
      return result.results.map((wire, index) =>
        toResult<JsRow>(wire, statements[index]?.sql ?? "", this.#intMode),
      )
    } catch (err) {
      throw toClientError(err)
    }
  }

  #begin(options: TransactionOptions): TxSession {
    const runtime = this.#owner.runtime
    try {
      const tenant = this.tenant()
      // An ack level this node cannot answer is refused before anything is written, as the
      // routes refuse it.
      if (options.ack) runtime.assertAckAvailable(tenant.name, options.ack)
      return runtime.beginTx(tenant, ADMIN, {
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.ack ? { ack: options.ack } : {}),
      })
    } catch (err) {
      throw toClientError(err)
    }
  }

  /** The txid the commit was assigned; for a rollback, the database's current one. */
  #end(session: TxSession, how: "commit" | "rollback"): bigint {
    try {
      return this.#owner.runtime.endTx(session, how)
    } catch (err) {
      if (how === "commit") throw toClientError(err)
      return session.tenant.txid
    }
  }

  #txStep(
    session: TxSession,
    request: StatementRequest,
    rows: RowsMode,
    options: StatementOptions | undefined,
  ): QueryResult {
    const resolved = resolveOptions({ ...(options ?? {}), rows }, null, this.#owner.config)
    try {
      return executeInTx(this.#owner.runtime, session.tenant, ADMIN, request, resolved)
    } catch (err) {
      throw toClientError(err)
    }
  }

  /** The `tx` an async transaction callback is handed. */
  #tx(session: TxSession): Tx {
    const intMode = this.#intMode
    const runner: Runner = (request, rows, options) =>
      Promise.resolve(this.#txStep(session, request, rows, options as StatementOptions | undefined))
    return {
      db: this.name,
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) =>
        new Query(runner, fromTemplate(strings, values), intMode)) as SqlTag,
      stmt: ((strings: TemplateStringsArray, ...values: unknown[]) =>
        fromTemplate(strings, values)) as StmtTag,
      execute: (sql: string, args?: QueryArgs, options?: StatementOptions) =>
        new Query(runner, fromArgs(sql, args), intMode, options as RequestOptions),
      unsafe: (sql: string, args?: QueryArgs, options?: StatementOptions) =>
        new Query(runner, fromArgs(sql, args), intMode, options as RequestOptions),
    }
  }

  /** The same transaction, without the promise. */
  #txSync(session: TxSession): SyncTx {
    const query = (request: StatementRequest, options?: StatementOptions): SyncQuery =>
      this.#syncQuery((rows) => this.#txStep(session, request, rows, options), request.sql)
    return {
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) =>
        query(fromTemplate(strings, values))) as SyncSqlTag,
      execute: (sql, args, options) => query(fromArgs(sql, args), options),
    }
  }

  /** A synchronous query object over a step function that already knows how to run it. */
  #syncQuery<T>(step: (rows: RowsMode) => QueryResult, sql: string): SyncQuery<T> {
    const intMode = this.#intMode
    return {
      all: () => toResult<T>(step("object"), sql, intMode),
      get: () => toResult<T>(step("object"), sql, intMode)[0] ?? null,
      values: () => toResult<JsValue[]>(step("array"), sql, intMode),
      run: () => toResult<JsValue[]>(step("array"), sql, intMode),
    }
  }

  #syncSurface(): SyncDb {
    const db = this
    const commit = <T>(fn: (tx: SyncTx) => T, options: TransactionOptions = {}): SyncCommit<T> => {
      const session = db.#begin(options)
      let value: T
      try {
        value = fn(db.#txSync(session))
      } catch (err) {
        db.#end(session, "rollback")
        throw err
      }
      return { value, txid: Number(db.#end(session, "commit")) }
    }
    const write = <T>(fn: (d: Database) => T, options: SyncWriteOptions = {}): SyncCommit<T> => {
      const owner = db.#owner
      const runtime = owner.runtime
      // `fn`'s own failure goes back to the caller untouched, as the driver threw it; everything
      // the engine raises around it becomes the `BqlClientError` the rest of the API throws.
      let thrown: unknown = NOTHING
      try {
        const tenant = db.tenant()
        const ack = options.ack ?? owner.config.durability.defaultAck
        // The same checks `executeStatement` makes before it takes the writer: the cluster lease
        // (a fenced node must not write) and an ack level this node could not answer.
        runtime.assertWritable(tenant.name)
        runtime.assertAckAvailable(tenant.name, ack)
        const written = tenant.write(
          (writer) => {
            try {
              return guarded(writer, { transactions: false }, () => {
                let value: T
                try {
                  value = fn(writer)
                } catch (err) {
                  thrown = err
                  throw err
                }
                if (isThenable(value)) {
                  throw BqlClientError.client(
                    "sync.write takes a synchronous callback; the transaction cannot stay open across an await",
                  )
                }
                return value
              })
            } finally {
              // The realtime statement boundary: the whole callback is one statement to the feed.
              runtime.markStatement(tenant.name)
            }
          },
          { ack },
        )
        return { value: written.result, txid: Number(written.txid) }
      } catch (err) {
        if (err === thrown || err instanceof BqlClientError) throw err
        throw toClientError(err)
      }
    }
    const read = <T>(fn: (d: Database) => T): T => {
      let thrown: unknown = NOTHING
      try {
        const tenant = db.tenant()
        return db.#owner.runtime.withReader(tenant, ADMIN, (reader) =>
          guarded(reader, { transactions: true }, () => {
            try {
              return fn(reader)
            } catch (err) {
              thrown = err
              throw err
            }
          }),
        )
      } catch (err) {
        if (err === thrown || err instanceof BqlClientError) throw err
        throw toClientError(err)
      }
    }
    const query = (request: StatementRequest, options?: StatementOptions): SyncQuery =>
      db.#syncQuery((rows) => db.#step(request, rows, options), request.sql)
    return {
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) =>
        query(fromTemplate(strings, values))) as SyncSqlTag,
      execute: (sql, args, options) => query(fromArgs(sql, args), options),
      batch: (items, options = {}) => db.#batchSync(items, options),
      transaction: <T>(fn: (tx: SyncTx) => T, options: TransactionOptions = {}): T =>
        commit(fn, options).value,
      commit,
      write,
      read,
    }
  }

  /** A live query on the in-process registry: the same engine the SSE and WS routes subscribe to. */
  #startLive<T>(sink: LiveSink<T>, request: StatementRequest, key: string | null): () => void {
    const owner = this.#owner
    const runtime = owner.runtime
    const intMode = this.#intMode
    const tenant = this.tenant()
    runtime.retain(this.name)
    let realtime: ReturnType<ServerRuntime["realtimeFor"]>
    try {
      realtime = runtime.realtimeFor(tenant)
    } catch (err) {
      runtime.releaseSubscription(this.name)
      throw toClientError(err)
    }
    let sub: string | null = null
    try {
      const subscription = realtime.subscribeLive(
        {
          sql: request.sql,
          ...(request.args !== undefined ? { args: request.args as Args } : {}),
          ...(key ? { key } : {}),
          principalRunner: runtime.liveRunner(tenant, ADMIN, "object"),
        },
        (event: LiveRowsEvent | LiveDiffEvent) => {
          if ("columns" in event) sink.rows(decodeLiveRows<T>(event, intMode))
          else sink.diff(decodeLiveDiff<T>(event, intMode))
        },
      )
      sub = subscription.sub
    } catch (err) {
      runtime.releaseSubscription(this.name)
      throw toClientError(err)
    }
    return () => {
      if (sub) realtime.unsubscribe(sub)
      sub = null
      runtime.releaseSubscription(this.name)
    }
  }
}

/** In-process bql.sh (design §9.2). */
export class Bql {
  readonly config: ServerConfig
  readonly runtime: ServerRuntime
  readonly adminKey: string | null
  readonly intMode: IntMode

  #dbs = new Map<string, LocalDb>()
  #commitListeners = new Set<(event: EmbeddedCommit) => void>()
  #roleUnhooks = new Set<() => void>()
  #unhook = new Map<string, () => void>()
  #served: ServerHandle | null = null
  /** True once `serve()` has started the cluster, replication and storage background parts. */
  #background = false
  /** `startShipping()` ran: the S3 shipper and outbox relay are up without a listener. */
  #shipping = false
  #closed = false

  private constructor(init: {
    config: ServerConfig
    runtime: ServerRuntime
    adminKey: string | null
    intMode: IntMode
  }) {
    this.config = init.config
    this.runtime = init.runtime
    this.adminKey = init.adminKey
    this.intMode = init.intMode
  }

  /** Opens the data directory and builds the engine. Nothing listens until `serve()`. */
  static async open(options: OpenOptions = {}): Promise<Bql> {
    const { dir, intMode, config: file, env, onError, ...sections } = options
    const overrides: ServerConfigInput = {
      ...sections,
      ...(dir !== undefined ? { data: { dir, ...sections.data } } : {}),
    }
    const config = loadConfig({
      file: file ?? null,
      overrides,
      // An embedded caller configures in code. Reading `BQL_*` here would let an unrelated
      // variable in the shell redirect a path the caller wrote out in full.
      env: env ?? {},
    })
    let self: Bql | null = null
    const bundle = await createRuntime(config, {
      ...(onError ? { onError } : {}),
      onTenantOpen: (tenant) => self?.hookCommits(tenant),
    })
    self = new Bql({
      config,
      runtime: bundle.runtime,
      adminKey: bundle.adminKey,
      intMode: intMode ?? "number",
    })
    // Tenants opened before `self` existed (none today, but `createRuntime` may reconcile) still
    // need their hook.
    for (const name of bundle.runtime.registry.openNames) {
      self.hookCommits(bundle.runtime.registry.open(name))
    }
    return self
  }

  /** A handle for a database. The tenant itself is opened on first use, not here. */
  db(name: string): EmbeddedDb {
    const hit = this.#dbs.get(name)
    if (hit) return hit
    const made = new LocalDb(this, name)
    this.#dbs.set(name, made)
    return made
  }

  /** The open tenant behind a name, or `DB_NOT_FOUND`. */
  tenantOf(name: string): Tenant {
    if (this.#closed) throw BqlClientError.client("this bql.sh instance is closed")
    try {
      return this.runtime.tenant(name)
    } catch (err) {
      throw toClientError(err)
    }
  }

  /**
   * What `POST /v1/db` does, through the same `runtime.createDatabase`: in a cluster, placement's
   * create gate refuses with `NOT_PRIMARY` (and `primary`, the home node's URL) on a node that is
   * not the name's home, and on the home node this resolves once the node holds the lease.
   */
  async create(name: string, options: CreateOptions = {}): Promise<EmbeddedDb> {
    try {
      await this.runtime.createDatabase(name, {
        ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
        ...(options.quotaBytes !== undefined ? { quotaBytes: options.quotaBytes } : {}),
        ...(options.from
          ? {
              from: {
                db: options.from.db,
                ...(options.from.at !== undefined ? { at: BigInt(options.from.at) } : {}),
              },
            }
          : {}),
      })
    } catch (err) {
      throw toClientError(err)
    }
    return this.db(name)
  }

  /** Design §4.4: O(1) where the filesystem reflinks, and at a txid when one is given. */
  fork(name: string, from: string, at?: number | bigint): Promise<EmbeddedDb> {
    return this.create(name, { from: { db: from, ...(at !== undefined ? { at } : {}) } })
  }

  /**
   * Force a snapshot, as `POST /v1/db/{db}/snapshot` does. A process that neither ships to a
   * bucket nor serves a replica takes none on its own, and without one there is no floor for the
   * log to retain — so there is nothing to restore from either.
   */
  async snapshot(name: string): Promise<SnapshotInfo> {
    const tenant = this.tenantOf(name)
    try {
      const ref = await tenant.snapshot()
      return {
        snapshotId: basename(ref.path),
        txid: Number(ref.txid),
        bytes: ref.bytes,
        checksum: ref.checksum,
        createdAtMs: ref.createdAtMs,
      }
    } catch (err) {
      throw toClientError(err)
    }
  }

  /**
   * Point-in-time restore into a **new** database, as `POST /v1/db/{db}/restore` does — the log
   * behind this one still describes the timeline it actually had. `at` is a txid or an instant
   * (an ISO-8601 string, or epoch milliseconds), resolved against the log. The bucket-sourced
   * restore stays on the server route, which is where the S3 store is built.
   */
  async restore(
    name: string,
    options: { at?: number | bigint | string; into?: string } = {},
  ): Promise<EmbeddedDb> {
    const tenant = this.tenantOf(name)
    let at: bigint
    try {
      at =
        options.at === undefined
          ? tenant.txid
          : typeof options.at === "bigint"
            ? options.at
            : resolveAt(tenant, options.at)
    } catch (err) {
      throw toClientError(err)
    }
    if (at <= 0n) throw BqlClientError.client("restore needs a positive txid in `at`")
    const into = options.into ?? `${name}-restore-${at}`.slice(0, 64)
    try {
      assertValidName(into)
      await this.runtime.createDatabase(into, { from: { db: name, at } }, { gate: false })
    } catch (err) {
      throw toClientError(err)
    }
    return this.db(into)
  }

  /** Checkpoint the WAL. `TRUNCATE` and `RESTART` need the database quiet. */
  checkpoint(name: string, mode: CheckpointMode = "PASSIVE"): CheckpointResult {
    const tenant = this.tenantOf(name)
    try {
      return {
        mode,
        ...tenant.checkpoint(mode),
        walBytes: tenant.walBytes,
        txid: Number(tenant.txid),
      }
    } catch (err) {
      throw toClientError(err)
    }
  }

  /** Closes the database and moves its directory to `trash/`, as `DELETE /v1/db/{db}` does. */
  delete(name: string): string {
    try {
      this.runtime.evict(name)
      this.#dbs.delete(name)
      this.#unhook.get(name)?.()
      this.#unhook.delete(name)
      return this.runtime.registry.delete(name)
    } catch (err) {
      throw toClientError(err)
    }
  }

  /** X2: a branch back to its parent's head, same name, as `POST /v1/db/{db}/reset` does. */
  async reset(name: string): Promise<EmbeddedDb> {
    try {
      await this.runtime.registry.reset(name, {
        beforeSwap: () => {
          this.runtime.evict(name)
          // The old tenant's commit hook goes with it; the reopened one is hooked afresh.
          this.#unhook.get(name)?.()
          this.#unhook.delete(name)
        },
      })
    } catch (err) {
      throw toClientError(err)
    }
    return this.db(name)
  }

  list(): DatabaseInfo[] {
    const open = new Set(this.runtime.registry.openNames)
    const rows = this.runtime.registry.list()
    const names = new Set(rows.map((row) => row.name))
    return rows.map((row: TenantRow) => ({
      name: row.name,
      txid: open.has(row.name) ? Number(this.runtime.tenant(row.name).txid) : Number(row.txid),
      epoch: row.epoch,
      pageSize: row.pageSize,
      quotaBytes: row.quotaBytes,
      createdAtMs: row.createdAtMs,
      open: open.has(row.name),
      ...lineageOf(row, (name) => names.has(name)),
    }))
  }

  /** The stats body of design §6.5 for one database. */
  stat(name: string): Record<string, unknown> {
    return statsOf(this.runtime, this.tenantOf(name))
  }

  /**
   * Resolves once `ack` covers `txid` on `name`: at once for `"local"`, after an fsync of the log
   * and the WAL for `"fsync"` (skipped when the commit already did one), and after the fsync plus
   * enough replica acks for `"replica"` / `"quorum"`. Rejects with the errors the routes answer:
   * `ACK_TIMEOUT` after `[replication] ackTimeoutMs` (with `txid`, `acks`, `needed`), and
   * `NO_REPLICAS` when none is attached and `ackWithoutReplicas` is `"error"`. Neither undoes the
   * commit. `ack` defaults to `[durability] defaultAck`.
   */
  async replicated(
    name: string,
    txid: number | bigint,
    options: { ack?: Ack } = {},
  ): Promise<void> {
    const ack = options.ack ?? this.config.durability.defaultAck
    if (ack === "local") return
    const tenant = this.tenantOf(name)
    const at = BigInt(txid)
    try {
      tenant.syncDurable(at)
      await this.runtime.awaitDurable(name, at, ack)
    } catch (err) {
      throw toClientError(err)
    }
  }

  /**
   * Throws `NO_REPLICAS` when this node could not answer `ack` for `name` right now: the check
   * the routes make before a write runs, so a refusal leaves no committed transaction behind.
   */
  assertReplicas(name: string, ack: Ack): void {
    try {
      this.runtime.assertAckAvailable(name, ack)
    } catch (err) {
      throw toClientError(err)
    }
  }

  /** Whether this node holds `name` as primary or replica, right now. */
  role(name: string): NodeRole {
    return this.runtime.roleFor(name)
  }

  /** Every durable commit on every database this process opened (design §9.2). */
  on(event: "commit", listener: (event: EmbeddedCommit) => void): () => void
  /**
   * Every role flip on this node: a promotion, a demotion, a fencing. A flip the Raft control
   * plane decides needs it running, which `serve()` does when `[cluster]` is enabled.
   */
  on(event: "role", listener: (event: EmbeddedRole) => void): () => void
  on(
    event: "commit" | "role",
    listener: ((event: EmbeddedCommit) => void) | ((event: EmbeddedRole) => void),
  ): () => void {
    if (event === "role") {
      const notify = listener as (event: EmbeddedRole) => void
      const off = this.runtime.onRoleChange((db, role) => notify({ db, role }))
      this.#roleUnhooks.add(off)
      return () => {
        off()
        this.#roleUnhooks.delete(off)
      }
    }
    if (event !== "commit") throw BqlClientError.client(`unknown event ${JSON.stringify(event)}`)
    const commit = listener as (event: EmbeddedCommit) => void
    this.#commitListeners.add(commit)
    return () => {
      this.#commitListeners.delete(commit)
    }
  }

  /**
   * Mounts the HTTP, WebSocket and SSE surface over this engine (design §9.2), then starts what
   * `bql serve` starts once it listens: the Raft node and promoter when `[cluster]` is enabled,
   * the replication client when `[replication] primary` is set, and the S3 shipper and outbox
   * relay when they are configured. Always one thread: `[server] workers` is ignored, because the
   * tenants have to live on the thread that holds the `db.sync` handles.
   */
  async serve(options: ServeOptions = {}): Promise<ServerHandle> {
    if (this.#served) return this.#served
    const config: ServerConfig = {
      ...this.config,
      server: {
        ...this.config.server,
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.host !== undefined ? { host: options.host } : {}),
      },
    }
    const handle = await startServer(config, {
      runtime: this.runtime,
      adminKey: this.adminKey,
      ...(options.log ? { log: options.log } : { log: () => {} }),
      ...(options.mount ? { mount: options.mount } : {}),
    })
    this.#served = handle
    // `startServer` starts these only for a runtime it built. In the same order it uses: Raft
    // needs the listener (its socket is mounted on it), and a replica follows only once it can
    // answer its own `/v1/replication`.
    try {
      await this.runtime.startCluster()
      this.runtime.startReplication()
      if (!this.#shipping) this.runtime.startStorage()
      this.#background = true
    } catch (err) {
      this.#served = null
      await handle.close()
      throw err
    }
    return handle
  }

  /**
   * Starts the S3 shipper (`[s3]`) and the outbox relay (`[outbox]`) without a listener, for a
   * process that embeds the engine and never calls `serve()`. Each is a no-op when it is not
   * configured. `close()` ships what is outstanding before it closes the logs.
   */
  startShipping(): void {
    if (this.#shipping || this.#background) return
    this.runtime.startStorage()
    this.#shipping = true
  }

  /** Stops the listener, if there is one, and closes the engine. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const served = this.#served
    this.#served = null
    if (served) await served.close()
    // Everything committed before the listener stopped is shipped before the logs close.
    if (this.#background || this.#shipping) await this.runtime.closeStorage()
    for (const off of this.#unhook.values()) off()
    this.#unhook.clear()
    this.#commitListeners.clear()
    for (const off of this.#roleUnhooks) off()
    this.#roleUnhooks.clear()
    this.runtime.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  /** One commit listener per tenant, fanning out to whoever registered with `on("commit")`. */
  private hookCommits(tenant: Tenant): void {
    if (this.#unhook.has(tenant.name)) return
    const off = tenant.onCommit((event: CommitEvent) => {
      const payload: EmbeddedCommit = { db: tenant.name, txid: Number(event.txid) }
      for (const listener of [...this.#commitListeners]) {
        try {
          listener(payload)
        } catch {
          // A listener that throws is the caller's problem, never the write path's.
        }
      }
    })
    this.#unhook.set(tenant.name, off)
  }
}

export default Bql
export { BqlClientError } from "./client/errors.ts"
export { ChangeFeed, LiveQuery } from "./client/feed.ts"
export { Query, type Result, type ResultMeta } from "./client/sql.ts"
export type { IntMode, JsRow, JsValue } from "./client/values.ts"
export type {
  BatchItem,
  BatchOptions,
  ChangesOptions,
  Db,
  StatementOptions,
  TransactionOptions,
  Tx,
} from "./client/index.ts"
export type { Mount, ServerHandle } from "./server/app.ts"
