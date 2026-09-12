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

import {
  ChangeFeed,
  LiveQuery,
  decodeChangeEvent,
  decodeLiveDiff,
  decodeLiveRows,
  type ChangeSink,
  type LiveSink,
} from "./client/feed.ts"
import { BunQLClientError } from "./client/errors.ts"
import type {
  Args,
  ChangeEvent,
  LiveDiffEvent,
  LiveRowsEvent,
  QueryResult,
  RequestOptions,
  RowsMode,
  StatementRequest,
} from "./client/protocol.ts"
import {
  Query,
  fromArgs,
  fromTemplate,
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
import { createRuntime, startServer, type ServerHandle } from "./server/app.ts"
import { ADMIN } from "./server/auth.ts"
import { loadConfig, type ServerConfig, type ServerConfigInput } from "./server/config.ts"
import { mapError } from "./server/errors.ts"
import { executeBatch, executeInTx, executeStatement, resolveOptions } from "./server/exec.ts"
import { statsOf } from "./server/routes.ts"
import { mapTenantError, type ServerRuntime, type TxSession } from "./server/runtime.ts"
import type { CommitEvent, Tenant, TenantRow } from "./tenant/index.ts"

export interface OpenOptions extends ServerConfigInput {
  /** Data root. Shorthand for `data: { dir }`. */
  dir?: string
  /** What an integer beyond 2^53 becomes in a result. Default `"number"`, which throws. */
  intMode?: IntMode
  /**
   * A `bunql.toml` to read first. Embedded callers configure in code by default, so no file and
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
}

export interface DatabaseInfo {
  name: string
  txid: number
  epoch: number
  pageSize: number
  quotaBytes: number
  createdAtMs: number
  open: boolean
}

/** What `bq.on("commit", …)` is handed (design §9.2). */
export interface EmbeddedCommit {
  db: string
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
}

/** The embedded `Db`: everything the client's has, plus `sync`. */
export interface EmbeddedDb extends Db {
  readonly sync: SyncDb
  /** The tenant behind this handle, for code that wants the driver itself. */
  tenant(): Tenant
}

/** Every failure crosses this boundary as the error the client SDK would have thrown. */
function toClientError(err: unknown): unknown {
  const mapped = mapTenantError(err)
  if (mapped instanceof BunQLClientError) return mapped
  const { body } = mapError(mapped)
  return BunQLClientError.fromInfo(body.error)
}

function asStatement(item: BatchItem): StatementRequest {
  const candidate = item as { toJSON?: () => StatementRequest; sql?: unknown }
  const statement = typeof candidate.toJSON === "function" ? candidate.toJSON() : item
  const sql = (statement as StatementRequest).sql
  if (typeof sql !== "string" || sql.length === 0) {
    throw BunQLClientError.client("every batch item needs a non-empty sql string")
  }
  return statement as StatementRequest
}

class LocalDb implements EmbeddedDb {
  readonly name: string
  readonly sql: SqlTag
  readonly stmt: StmtTag
  readonly live: LiveTag
  readonly sync: SyncDb

  #owner: BunQL
  #intMode: IntMode

  constructor(owner: BunQL, name: string) {
    this.#owner = owner
    this.#intMode = owner.intMode
    this.name = name
    this.sql = ((strings, ...values) =>
      new Query(this.#runner(), fromTemplate(strings, values), this.#intMode)) as SqlTag
    this.stmt = ((strings, ...values) => fromTemplate(strings, values)) as StmtTag
    this.live = ((strings, ...values) => {
      const request = fromTemplate(strings, values)
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
    try {
      const value = await fn(this.#tx(session) as Tx)
      this.#end(session, "commit")
      return value
    } catch (err) {
      this.#end(session, "rollback")
      throw err
    }
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
      throw BunQLClientError.client("batch needs at least one statement")
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
    try {
      return this.#owner.runtime.beginTx(this.tenant(), ADMIN, {
        ...(options.mode ? { mode: options.mode } : {}),
      })
    } catch (err) {
      throw toClientError(err)
    }
  }

  #end(session: TxSession, how: "commit" | "rollback"): void {
    try {
      this.#owner.runtime.endTx(session, how)
    } catch (err) {
      if (how === "commit") throw toClientError(err)
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
    const query = (request: StatementRequest, options?: StatementOptions): SyncQuery =>
      db.#syncQuery((rows) => db.#step(request, rows, options), request.sql)
    return {
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) =>
        query(fromTemplate(strings, values))) as SyncSqlTag,
      execute: (sql, args, options) => query(fromArgs(sql, args), options),
      batch: (items, options = {}) => db.#batchSync(items, options),
      transaction<T>(fn: (tx: SyncTx) => T, options: TransactionOptions = {}): T {
        const session = db.#begin(options)
        try {
          const value = fn(db.#txSync(session))
          db.#end(session, "commit")
          return value
        } catch (err) {
          db.#end(session, "rollback")
          throw err
        }
      },
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

/** In-process BunQL (design §9.2). */
export class BunQL {
  readonly config: ServerConfig
  readonly runtime: ServerRuntime
  readonly adminKey: string | null
  readonly intMode: IntMode

  #dbs = new Map<string, LocalDb>()
  #commitListeners = new Set<(event: EmbeddedCommit) => void>()
  #unhook = new Map<string, () => void>()
  #served: ServerHandle | null = null
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
  static async open(options: OpenOptions = {}): Promise<BunQL> {
    const { dir, intMode, config: file, env, onError, ...sections } = options
    const overrides: ServerConfigInput = {
      ...sections,
      ...(dir !== undefined ? { data: { dir, ...sections.data } } : {}),
    }
    const config = loadConfig({
      file: file ?? null,
      overrides,
      // An embedded caller configures in code. Reading `BUNQL_*` here would let an unrelated
      // variable in the shell redirect a path the caller wrote out in full.
      env: env ?? {},
    })
    let self: BunQL | null = null
    const bundle = await createRuntime(config, {
      ...(onError ? { onError } : {}),
      onTenantOpen: (tenant) => self?.hookCommits(tenant),
    })
    self = new BunQL({
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
    if (this.#closed) throw BunQLClientError.client("this BunQL instance is closed")
    try {
      return this.runtime.tenant(name)
    } catch (err) {
      throw toClientError(err)
    }
  }

  async create(name: string, options: CreateOptions = {}): Promise<EmbeddedDb> {
    try {
      await this.runtime.registry.create(name, {
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

  list(): DatabaseInfo[] {
    const open = new Set(this.runtime.registry.openNames)
    return this.runtime.registry.list().map((row: TenantRow) => ({
      name: row.name,
      txid: open.has(row.name) ? Number(this.runtime.tenant(row.name).txid) : Number(row.txid),
      epoch: row.epoch,
      pageSize: row.pageSize,
      quotaBytes: row.quotaBytes,
      createdAtMs: row.createdAtMs,
      open: open.has(row.name),
    }))
  }

  /** The stats body of design §6.5 for one database. */
  stat(name: string): Record<string, unknown> {
    return statsOf(this.runtime, this.tenantOf(name))
  }

  /** Every durable commit on every database this process opened (design §9.2). */
  on(event: "commit", listener: (event: EmbeddedCommit) => void): () => void {
    if (event !== "commit") throw BunQLClientError.client(`unknown event ${JSON.stringify(event)}`)
    this.#commitListeners.add(listener)
    return () => {
      this.#commitListeners.delete(listener)
    }
  }

  /** Mounts the HTTP, WebSocket and SSE surface over this engine (design §9.2). */
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
    })
    this.#served = handle
    return handle
  }

  /** Stops the listener, if there is one, and closes the engine. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const served = this.#served
    this.#served = null
    if (served) await served.close()
    for (const off of this.#unhook.values()) off()
    this.#unhook.clear()
    this.#commitListeners.clear()
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

export default BunQL
export { BunQLClientError } from "./client/errors.ts"
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
export type { ServerHandle } from "./server/app.ts"
