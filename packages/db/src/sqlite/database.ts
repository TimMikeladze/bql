// Invariant: every callback this connection has handed to SQLite is reachable from the instance
// for as long as SQLite might call it, and is detached from the connection before it is freed.
// A JSCallback that SQLite still holds a pointer to but JS has collected is a segfault, so
// installing a hook always stores it and closing always unwires it first.
//
// The authorizer is the one callback that is always installed: SQLite calls it while compiling a
// statement, and that is the only place the connection can learn what a program will do before it
// does it. `authorizer()` therefore swaps the JS function behind a permanent trampoline rather
// than wiring and unwiring the C callback — and still calls `sqlite3_set_authorizer` on every
// change, because that is what expires statements already in the cache under the old verdicts.

import { JSCallback, FFIType as T, toArrayBuffer } from "bun:ffi"
import {
  CHECKPOINT_MODES,
  DB_CONFIGS,
  type DbConfigName,
  FILE_CONTROLS,
  LIMITS,
  SQLITE_BUSY,
  SQLITE_DONE,
  SQLITE_OK,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_NOMUTEX,
  SQLITE_OPEN_READONLY,
  SQLITE_OPEN_READWRITE,
  SQLITE_OPEN_URI,
  SQLITE_PREPARE_PERSISTENT,
  SQLITE_FUNCTION,
  SQLITE_INSERT,
  SQLITE_ROW,
  type CheckpointMode,
  type FileControlName,
  type LimitName,
} from "./constants.ts"
import { FeatureUnavailableError, SqliteError } from "./errors.ts"
import { capabilityDetail, cbuf, cstr, sqlite, type SqliteLibrary } from "./lib.ts"
import {
  prepareStatement,
  Statement,
  type ProgramFacts,
  type RunResult,
  type StatementHost,
} from "./statement.ts"
import {
  protectedValue,
  type BindValue,
  type NamedParams,
  type SqliteValue,
} from "./values.ts"

export interface OpenOptions {
  /** Open the database read-only. Implies `create: false`. */
  readonly?: boolean
  /** Create the file when missing. Default true for writable databases. */
  create?: boolean
  /** Switch the database to WAL journal mode on open. Default true. */
  wal?: boolean
  /** `sqlite3_busy_timeout` in milliseconds. Default 5000. */
  busyTimeoutMs?: number
  /** Return every INTEGER as a bigint instead of narrowing safe values to numbers. */
  safeIntegers?: boolean
  /**
   * Distinct SQL texts `prepare()` keeps compiled on this connection. Default 64.
   *
   * The ceiling is a cliff rather than a slope: one text past it and every `prepare()` compiles
   * and finalizes a victim instead of returning a `Map` hit, which measured 82x on this machine
   * and 186x on a loaded one (`docs/p7-plan-cache.md`).
   */
  statementCache?: number
  /**
   * Where this connection reports its cache activity. Supply one object to several connections to
   * get a total that survives them — which is what a registry does, so `bql_statement_cache_*`
   * does not go backwards when a tenant is evicted. Omitted, the connection keeps its own.
   */
  cacheCounters?: StatementCacheCounters
}

/**
 * Statement-cache activity, counted per `prepare()`. `hits + misses` is every call; `evictions`
 * is how many compiled statements the ceiling has finalized, and a non-zero and *rising* eviction
 * count on a live connection is the thrash `[sqlite] statementCache` exists to raise.
 *
 * A hit here is a hit in *this* cache, not proof SQLite did not recompile: `sqlite3_set_authorizer`
 * expires every statement on the connection, so a cached hit that has been expired still pays a
 * compile inside `sqlite3_step`. `docs/p7-plan-cache.md` §4 has the number and where it bites.
 */
export interface StatementCacheCounters {
  hits: number
  misses: number
  evictions: number
}

export type TransactionMode = "deferred" | "immediate" | "exclusive"

export interface CheckpointResult {
  /** True when another connection held the database and the checkpoint did nothing. */
  busy: boolean
  /** Frames in the WAL after the checkpoint, or -1 when unknown. */
  log: number
  /** Frames moved into the database file, or -1 when unknown. */
  checkpointed: number
}

/** Reads the OLD/NEW row of the change a preupdate hook is reporting. */
export interface PreupdateAccessor {
  /** Column count of the row being changed. */
  count(): number
  /** Value of column `i` before the change; throws for an INSERT. */
  old(i: number): SqliteValue
  /** Value of column `i` after the change; throws for a DELETE. */
  "new"(i: number): SqliteValue
}

export type UpdateHook = (
  op: number,
  dbName: string,
  table: string,
  rowid: bigint,
) => void

export type PreupdateHook = (
  op: number,
  dbName: string,
  table: string,
  oldRowid: bigint,
  newRowid: bigint,
  accessor: PreupdateAccessor,
) => void

/** Return `false` to turn the commit into a rollback; anything else lets it through. */
export type CommitHook = () => boolean | void
export type RollbackHook = () => void
export type WalHook = (dbName: string, frameCount: number) => void

/**
 * Called before each action a statement takes. Return 0 to allow, 1 (`SQLITE_DENY`) to fail the
 * statement, 2 (`SQLITE_IGNORE`) to make the action a no-op (a denied column read reads NULL).
 */
export type Authorizer = (
  action: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  trigger: string | null,
) => number

export interface ChangesetSession {
  /** Every change since the session was created, as a changeset. */
  changeset(): Uint8Array
  /** The same changes as a patchset: no OLD values for updates, smaller, not invertible. */
  patchset(): Uint8Array
  /** Stop recording and release the session. */
  close(): void
  /** Pause or resume recording. */
  enable(on: boolean): void
}

/** `OpenOptions.statementCache` when the caller does not say; `[sqlite] statementCache`'s default. */
const CACHE_LIMIT = 64
const SQLITE_CHANGESET_OMIT = 0
const SQLITE_CHANGESET_REPLACE = 1
const SQLITE_CHANGESET_ABORT = 2

/** How `applyChangeset` resolves a row that does not apply cleanly. */
export type ConflictPolicy = "abort" | "omit" | "replace"

export class Database implements StatementHost {
  readonly lib: SqliteLibrary
  readonly safeIntegers: boolean
  readonly filename: string

  /** Statement-cache activity; shared with the registry's total when one was supplied. */
  readonly cacheCounters: StatementCacheCounters

  #handle: number
  #closed = false
  #cache = new Map<string, Statement>()
  #cacheLimit: number
  #txDepth = 0

  // Retained so SQLite never holds a pointer to a collected callback.
  #updateCb: JSCallback | null = null
  #preupdateCb: JSCallback | null = null
  #commitCb: JSCallback | null = null
  #rollbackCb: JSCallback | null = null
  #walCb: JSCallback | null = null
  #authCb: JSCallback | null = null
  #progressCb: JSCallback | null = null
  #conflictCb: JSCallback | null = null

  #onUpdate: UpdateHook | null = null
  #onPreupdate: PreupdateHook | null = null
  #onCommit: CommitHook | null = null
  #onRollback: RollbackHook | null = null
  #onWal: WalHook | null = null
  #onAuth: Authorizer | null = null
  #deadlineAt = Infinity
  #sessions = new Set<number>()

  // Set while `prepare()` is compiling; the authorizer trampoline writes what it sees into them.
  #probing = false
  #probeInserts = false
  #probeReadsRowid = false

  private constructor(
    handle: number,
    filename: string,
    safeIntegers: boolean,
    cacheLimit: number,
    counters: StatementCacheCounters,
  ) {
    this.lib = sqlite()
    this.#handle = handle
    this.filename = filename
    this.safeIntegers = safeIntegers
    this.#cacheLimit = cacheLimit
    this.cacheCounters = counters
  }

  /** Opens (and by default creates) a database file. `":memory:"` is supported. */
  static open(path: string, options: OpenOptions = {}): Database {
    const lib = sqlite()
    const s = lib.symbols
    const readonly = options.readonly === true
    const create = options.create ?? !readonly
    let flags = SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX
    flags |= readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE
    if (!readonly && create) flags |= SQLITE_OPEN_CREATE

    const out = new BigUint64Array(1)
    const rc = s.sqlite3_open_v2(cbuf(path), out, flags, null)
    const handle = Number(out[0])
    if (rc !== SQLITE_OK) {
      const message = handle ? (cstr(s.sqlite3_errmsg(handle)) ?? "open failed") : "open failed"
      if (handle) s.sqlite3_close_v2(handle)
      throw new SqliteError(`${message}: ${path}`, rc)
    }
    s.sqlite3_extended_result_codes(handle, 1)

    const limit = options.statementCache
    const db = new Database(
      handle,
      path,
      options.safeIntegers === true,
      // Zero and below would evict the statement `prepare` is about to return, so one is the floor.
      limit === undefined ? CACHE_LIMIT : Math.max(1, Math.floor(limit)),
      options.cacheCounters ?? { hits: 0, misses: 0, evictions: 0 },
    )
    try {
      db.#installAuthorizer()
      db.busyTimeout(options.busyTimeoutMs ?? 5000)
      if (options.wal !== false && !readonly) db.exec("pragma journal_mode = wal")
    } catch (err) {
      db.close()
      throw err
    }
    return db
  }

  /** Raw `sqlite3 *`. Valid until `close()`. */
  get handle(): number {
    this.#assertOpen()
    return this.#handle
  }

  get closed(): boolean {
    return this.#closed
  }

  /** True while a transaction or savepoint is open on this connection. */
  get inTransaction(): boolean {
    this.#assertOpen()
    return this.lib.symbols.sqlite3_get_autocommit(this.#handle) === 0
  }

  /** Rows changed by the most recent statement. */
  get changes(): number | bigint {
    this.#assertOpen()
    return this.safeIntegers
      ? this.lib.wide.sqlite3_changes64(this.#handle)
      : this.lib.symbols.sqlite3_changes64(this.#handle)
  }

  /**
   * Rowid of the most recent successful insert on this connection. `Statement.run` reports the
   * same number; this getter is for the paths that step with `values()` because the statement had
   * a `RETURNING` clause and still have to answer `lastInsertRowid`.
   */
  get lastInsertRowid(): number | bigint {
    this.#assertOpen()
    return this.safeIntegers
      ? this.lib.wide.sqlite3_last_insert_rowid(this.#handle)
      : this.lib.symbols.sqlite3_last_insert_rowid(this.#handle)
  }

  /**
   * Overwrites the connection's insert counter (`sqlite3_set_last_insert_rowid`). SQL running on
   * the connection sees the new value through `last_insert_rowid()`, so a caller that borrows the
   * counter as a marker owns putting the old value back.
   */
  setLastInsertRowid(rowid: number | bigint): void {
    this.#assertOpen()
    this.lib.symbols.sqlite3_set_last_insert_rowid(this.#handle, BigInt(rowid))
  }

  /** Rows changed since the connection was opened. */
  get totalChanges(): number | bigint {
    this.#assertOpen()
    return this.safeIntegers
      ? this.lib.wide.sqlite3_total_changes64(this.#handle)
      : this.lib.symbols.sqlite3_total_changes64(this.#handle)
  }

  /** Runs one or more statements, discarding any rows. */
  exec(sql: string): void {
    this.#assertOpen()
    const rc = this.lib.symbols.sqlite3_exec(this.#handle, cbuf(sql), null, null, null)
    if (rc !== SQLITE_OK) this.fail(rc)
  }

  /**
   * Prepares a statement, reusing the cached one when the same SQL text comes back. Because the
   * same object is handed out twice, two call sites that iterate the same SQL text at the same
   * time share one cursor; `.all()` and `.get()` are unaffected since they never leave a
   * statement stepping.
   */
  prepare(sql: string): Statement {
    this.#assertOpen()
    const hit = this.#cache.get(sql)
    if (hit && !hit.finalized) {
      // Refresh recency.
      this.#cache.delete(sql)
      this.#cache.set(sql, hit)
      this.cacheCounters.hits++
      return hit
    }
    this.cacheCounters.misses++
    this.#probing = true
    this.#probeInserts = false
    this.#probeReadsRowid = false
    let stmt: Statement
    try {
      stmt = prepareStatement(this, sql, SQLITE_PREPARE_PERSISTENT)
    } finally {
      this.#probing = false
    }
    this.#cache.set(sql, stmt)
    if (this.#cache.size > this.#cacheLimit) {
      const oldest = this.#cache.keys().next()
      if (!oldest.done) {
        const victim = this.#cache.get(oldest.value)
        this.#cache.delete(oldest.value)
        this.cacheCounters.evictions++
        victim?.finalize()
      }
    }
    return stmt
  }

  /** Distinct SQL texts this connection keeps compiled; `OpenOptions.statementCache`. */
  get statementCacheLimit(): number {
    return this.#cacheLimit
  }

  /** How many it is holding right now. At the limit, the next new text evicts. */
  get statementCacheSize(): number {
    return this.#cache.size
  }

  /** Alias for `prepare`, matching the bun:sqlite spelling. */
  query(sql: string): Statement {
    return this.prepare(sql)
  }

  /** Prepares (or reuses) `sql`, runs it once, and reports what changed. */
  run(sql: string, params?: readonly BindValue[] | NamedParams): RunResult {
    const stmt = this.prepare(sql)
    if (params === undefined) return stmt.run()
    return Array.isArray(params) ? stmt.run(...(params as BindValue[])) : stmt.run(params as NamedParams)
  }

  /**
   * Wraps `fn` so calling it runs inside a transaction. A nested call joins the open
   * transaction through a SAVEPOINT, so an inner throw rolls back only the inner work.
   */
  transaction<A extends unknown[], R>(
    fn: (...args: A) => R,
    mode: TransactionMode = "deferred",
  ): (...args: A) => R {
    const begin =
      mode === "deferred" ? "begin" : mode === "immediate" ? "begin immediate" : "begin exclusive"
    return (...args: A): R => {
      if (this.#txDepth > 0) return this.#runSavepoint(fn, args)
      this.exec(begin)
      this.#txDepth = 1
      let result: R
      try {
        result = fn(...args)
      } catch (err) {
        this.#txDepth = 0
        if (this.inTransaction) this.exec("rollback")
        throw err
      }
      try {
        this.exec("commit")
      } catch (err) {
        if (this.inTransaction) this.exec("rollback")
        throw err
      } finally {
        this.#txDepth = 0
      }
      return result
    }
  }

  #runSavepoint<A extends unknown[], R>(fn: (...args: A) => R, args: A): R {
    const name = `bql_sp_${this.#txDepth}`
    this.exec(`savepoint ${name}`)
    this.#txDepth++
    try {
      const result = fn(...args)
      this.exec(`release ${name}`)
      return result
    } catch (err) {
      if (this.inTransaction) {
        this.exec(`rollback to ${name}`)
        this.exec(`release ${name}`)
      }
      throw err
    } finally {
      this.#txDepth--
    }
  }

  /** Sets `sqlite3_busy_timeout` for this connection. */
  busyTimeout(ms: number): void {
    this.#assertOpen()
    const rc = this.lib.symbols.sqlite3_busy_timeout(this.#handle, ms)
    if (rc !== SQLITE_OK) this.fail(rc)
  }

  /** Sets a `sqlite3_limit` category and returns its previous value. */
  limit(name: LimitName, value: number): number {
    this.#assertOpen()
    const id = LIMITS[name]
    if (id === undefined) throw new RangeError(`unknown limit ${name}`)
    return this.lib.symbols.sqlite3_limit(this.#handle, id, value)
  }

  /**
   * Aborts any statement still running `ms` from now with `SQLITE_INTERRUPT`. Pass null to
   * clear. The check runs from the progress handler every 1000 virtual-machine instructions.
   */
  deadline(ms: number | null): void {
    this.#assertOpen()
    const s = this.lib.symbols
    if (ms === null) {
      this.#deadlineAt = Infinity
      s.sqlite3_progress_handler(this.#handle, 0, null, null)
      this.#progressCb?.close()
      this.#progressCb = null
      return
    }
    this.#deadlineAt = performance.now() + ms
    if (!this.#progressCb) {
      this.#progressCb = new JSCallback(() => (performance.now() > this.#deadlineAt ? 1 : 0), {
        args: [T.ptr],
        returns: T.i32,
      })
      s.sqlite3_progress_handler(this.#handle, 1000, this.#progressCb.ptr, null)
    }
  }

  /** Asks SQLite to abort the statement currently running on this connection. */
  interrupt(): void {
    this.#assertOpen()
    this.lib.symbols.sqlite3_interrupt(this.#handle)
  }

  /**
   * Sets the statement authorizer, or clears it with null. The trampoline underneath stays
   * installed either way — it is also how the connection learns what a statement's program does
   * — so this swaps the JS function and then re-arms `sqlite3_set_authorizer`, which is what
   * expires statements the cache prepared under the previous verdicts.
   */
  authorizer(cb: Authorizer | null): void {
    this.#assertOpen()
    this.#onAuth = cb
    this.#installAuthorizer()
  }

  /**
   * Installs (or re-arms) the permanent trampoline. Re-arming matters: `sqlite3_set_authorizer`
   * expires every prepared statement on the connection, which is the only way a statement
   * compiled under an old authorizer gets re-authorised.
   */
  #installAuthorizer(): void {
    const s = this.lib.symbols
    this.#authCb ??= new JSCallback(
      (_ctx: number, action: number, a1: number, a2: number, a3: number, a4: number) => {
        if (this.#probing) {
          // The compile-time facts of design §6.1's `lastInsertRowid`. `cstr` is skipped unless
          // the action can carry one of them, so a connection with no authorizer of its own
          // allocates nothing here.
          if (action === SQLITE_INSERT) this.#probeInserts = true
          else if (
            action === SQLITE_FUNCTION &&
            !this.#probeReadsRowid &&
            cstr(a2) === "last_insert_rowid"
          ) {
            this.#probeReadsRowid = true
          }
        }
        const fn = this.#onAuth
        if (!fn) return SQLITE_OK
        try {
          return fn(action, cstr(a1), cstr(a2), cstr(a3), cstr(a4)) | 0
        } catch {
          return 1 // SQLITE_DENY: a throwing authorizer must not unwind through C.
        }
      },
      { args: [T.ptr, T.i32, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
    )
    const rc = s.sqlite3_set_authorizer(this.#handle, this.#authCb.ptr, null)
    if (rc !== SQLITE_OK) this.fail(rc)
  }

  /**
   * What the authorizer saw while compiling the statement just prepared, and the end of the
   * probe window. Called by `prepareStatement` as it builds the Statement.
   */
  takeProgramFacts(): ProgramFacts {
    this.#probing = false
    return { inserts: this.#probeInserts, readsLastInsertRowid: this.#probeReadsRowid }
  }

  /** Fires once per inserted, updated or deleted row, after the change, in rowid tables. */
  onUpdate(cb: UpdateHook | null): void {
    this.#assertOpen()
    const s = this.lib.symbols
    this.#onUpdate = cb
    if (!cb) {
      s.sqlite3_update_hook(this.#handle, null, null)
      this.#updateCb?.close()
      this.#updateCb = null
      return
    }
    if (this.#updateCb) return
    this.#updateCb = new JSCallback(
      (_ctx: number, op: number, dbName: number, table: number, rowid: bigint) => {
        this.#onUpdate?.(op, cstr(dbName) ?? "", cstr(table) ?? "", rowid)
      },
      { args: [T.ptr, T.i32, T.ptr, T.ptr, T.i64], returns: T.void },
    )
    s.sqlite3_update_hook(this.#handle, this.#updateCb.ptr, null)
  }

  /**
   * Fires before each row change, with access to the OLD and NEW column values. Unlike the
   * update hook it also reports WITHOUT ROWID tables. Requires a library built with
   * `SQLITE_ENABLE_PREUPDATE_HOOK`.
   */
  onPreupdate(cb: PreupdateHook | null): void {
    this.#assertOpen()
    const pre = this.lib.preupdate
    if (!pre || !this.lib.features.preupdate) {
      if (cb === null) return
      throw new FeatureUnavailableError(
        "preupdate hook",
        capabilityDetail(this.lib, "SQLITE_ENABLE_PREUPDATE_HOOK"),
      )
    }
    this.#onPreupdate = cb
    if (!cb) {
      pre.sqlite3_preupdate_hook(this.#handle, null, null)
      this.#preupdateCb?.close()
      this.#preupdateCb = null
      return
    }
    if (this.#preupdateCb) return
    const out = new BigUint64Array(1)
    const accessor: PreupdateAccessor = {
      count: () => pre.sqlite3_preupdate_count(this.#handle),
      old: (i: number) => {
        const rc = pre.sqlite3_preupdate_old(this.#handle, i, out)
        if (rc !== SQLITE_OK) this.fail(rc)
        return protectedValue(this.lib, Number(out[0]), this.safeIntegers)
      },
      "new": (i: number) => {
        const rc = pre.sqlite3_preupdate_new(this.#handle, i, out)
        if (rc !== SQLITE_OK) this.fail(rc)
        return protectedValue(this.lib, Number(out[0]), this.safeIntegers)
      },
    }
    this.#preupdateCb = new JSCallback(
      (
        _ctx: number,
        _db: number,
        op: number,
        dbName: number,
        table: number,
        key1: bigint,
        key2: bigint,
      ) => {
        this.#onPreupdate?.(op, cstr(dbName) ?? "", cstr(table) ?? "", key1, key2, accessor)
      },
      { args: [T.ptr, T.ptr, T.i32, T.ptr, T.ptr, T.i64, T.i64], returns: T.void },
    )
    pre.sqlite3_preupdate_hook(this.#handle, this.#preupdateCb.ptr, null)
  }

  /** Fires just before each commit. Returning `false` turns the commit into a rollback. */
  onCommit(cb: CommitHook | null): void {
    this.#assertOpen()
    const s = this.lib.symbols
    this.#onCommit = cb
    if (!cb) {
      s.sqlite3_commit_hook(this.#handle, null, null)
      this.#commitCb?.close()
      this.#commitCb = null
      return
    }
    if (this.#commitCb) return
    this.#commitCb = new JSCallback(
      () => {
        try {
          return this.#onCommit?.() === false ? 1 : 0
        } catch {
          return 1
        }
      },
      { args: [T.ptr], returns: T.i32 },
    )
    s.sqlite3_commit_hook(this.#handle, this.#commitCb.ptr, null)
  }

  /** Fires when a transaction rolls back. */
  onRollback(cb: RollbackHook | null): void {
    this.#assertOpen()
    const s = this.lib.symbols
    this.#onRollback = cb
    if (!cb) {
      s.sqlite3_rollback_hook(this.#handle, null, null)
      this.#rollbackCb?.close()
      this.#rollbackCb = null
      return
    }
    if (this.#rollbackCb) return
    this.#rollbackCb = new JSCallback(
      () => {
        try {
          this.#onRollback?.()
        } catch {
          // A hook must not unwind through C.
        }
      },
      { args: [T.ptr], returns: T.void },
    )
    s.sqlite3_rollback_hook(this.#handle, this.#rollbackCb.ptr, null)
  }

  /**
   * Fires after each WAL commit with the frame count. Installing it replaces SQLite's own WAL
   * hook, which is what performs autocheckpointing, so a database with this hook installed does
   * not autocheckpoint and the caller owns checkpoint policy.
   */
  onWal(cb: WalHook | null): void {
    this.#assertOpen()
    const s = this.lib.symbols
    this.#onWal = cb
    if (!cb) {
      s.sqlite3_wal_hook(this.#handle, null, null)
      this.#walCb?.close()
      this.#walCb = null
      return
    }
    if (this.#walCb) return
    this.#walCb = new JSCallback(
      (_ctx: number, _db: number, dbName: number, frames: number) => {
        try {
          this.#onWal?.(cstr(dbName) ?? "", frames)
        } catch {
          // A hook must not unwind through C.
        }
        return SQLITE_OK
      },
      { args: [T.ptr, T.ptr, T.ptr, T.i32], returns: T.i32 },
    )
    s.sqlite3_wal_hook(this.#handle, this.#walCb.ptr, null)
  }

  /** Runs `sqlite3_wal_checkpoint_v2` and reports what it moved. */
  walCheckpoint(mode: CheckpointMode = "PASSIVE", dbName = "main"): CheckpointResult {
    this.#assertOpen()
    const eMode = CHECKPOINT_MODES[mode]
    if (eMode === undefined) throw new RangeError(`unknown checkpoint mode ${mode}`)
    const log = new Int32Array(1)
    const ckpt = new Int32Array(1)
    const rc = this.lib.symbols.sqlite3_wal_checkpoint_v2(
      this.#handle,
      cbuf(dbName),
      eMode,
      log,
      ckpt,
    )
    if (rc !== SQLITE_OK && (rc & 0xff) !== SQLITE_BUSY) this.fail(rc)
    return {
      busy: (rc & 0xff) === SQLITE_BUSY,
      log: log[0] as number,
      checkpointed: ckpt[0] as number,
    }
  }

  /**
   * Sends a VFS file-control opcode. Returns the raw result code; `SQLITE_NOTFOUND` (12) simply
   * means this VFS does not implement the opcode.
   */
  /**
   * `sqlite3_db_config` for the (int, int*) ops, through the non-variadic shim in the vendored
   * artefact. Returns the setting as it stands afterwards, or **null on a build that has no shim**
   * — a system libsqlite3, where it is not reachable at all.
   *
   * Why it needs a shim: `sqlite3_db_config` is variadic and bun:ffi cannot express that. Calling
   * it as fixed-arity was tried and fails three ways, because on arm64 a variadic argument is
   * passed on the stack where a fixed one goes in a register, so SQLite reads whatever was there —
   * the value ignored, the out-parameter never written, and a SIGKILL on the second call
   * (`docs/p1-pragmas.md`).
   *
   * `value` is 1 to enable, 0 to disable, -1 to read without changing.
   */
  dbConfig(op: DbConfigName | number, value: number): number | null {
    this.#assertOpen()
    const shim = this.lib.walsum
    if (!shim) return null
    const opcode = typeof op === "number" ? op : DB_CONFIGS[op]
    if (opcode === undefined) throw new RangeError(`unknown db config ${String(op)}`)
    const out = new Int32Array(1)
    const rc = shim.bql_db_config_int(this.#handle, opcode, value, out)
    if (rc !== SQLITE_OK) this.fail(rc)
    return out[0] as number
  }

  fileControl(op: FileControlName | number, arg: ArrayBufferView | null = null): number {
    this.#assertOpen()
    const opcode = typeof op === "number" ? op : FILE_CONTROLS[op]
    if (opcode === undefined) throw new RangeError(`unknown file control ${String(op)}`)
    const rc = this.lib.symbols.sqlite3_file_control(
      this.#handle,
      cbuf("main"),
      opcode,
      arg,
    )
    if (rc !== SQLITE_OK && rc !== 12) this.fail(rc)
    return rc
  }

  /**
   * Starts recording row changes for the whole `main` database. Requires a library built with
   * `SQLITE_ENABLE_SESSION`.
   */
  session(dbName = "main"): ChangesetSession {
    this.#assertOpen()
    const api = this.lib.session
    if (!api || !this.lib.features.session) {
      throw new FeatureUnavailableError(
        "session extension",
        capabilityDetail(this.lib, "SQLITE_ENABLE_SESSION"),
      )
    }
    const out = new BigUint64Array(1)
    const rc = api.sqlite3session_create(this.#handle, cbuf(dbName), out)
    if (rc !== SQLITE_OK) this.fail(rc)
    const handle = Number(out[0])
    this.#sessions.add(handle)
    const attachRc = api.sqlite3session_attach(handle, null)
    if (attachRc !== SQLITE_OK) {
      api.sqlite3session_delete(handle)
      this.#sessions.delete(handle)
      this.fail(attachRc)
    }
    let closed = false
    const collect = (which: "changeset" | "patchset"): Uint8Array => {
      if (closed) throw new SqliteError("session has been closed", 21)
      const size = new Int32Array(1)
      const buf = new BigUint64Array(1)
      const fn =
        which === "changeset" ? api.sqlite3session_changeset : api.sqlite3session_patchset
      const crc = fn(handle, size, buf)
      if (crc !== SQLITE_OK) this.fail(crc)
      const n = size[0] as number
      const p = Number(buf[0])
      if (!p || n <= 0) return new Uint8Array(0)
      const copy = new Uint8Array(n)
      copy.set(new Uint8Array(toArrayBuffer(p, 0, n)))
      this.lib.symbols.sqlite3_free(p)
      return copy
    }
    return {
      changeset: () => collect("changeset"),
      patchset: () => collect("patchset"),
      enable: (on: boolean) => {
        if (!closed) api.sqlite3session_enable(handle, on ? 1 : 0)
      },
      close: () => {
        if (closed) return
        closed = true
        this.#sessions.delete(handle)
        api.sqlite3session_delete(handle)
      },
    }
  }

  /** Applies a changeset or patchset produced by `session()`. */
  applyChangeset(bytes: Uint8Array, onConflict: ConflictPolicy = "abort"): void {
    this.#assertOpen()
    const api = this.lib.session
    if (!api || !this.lib.features.session) {
      throw new FeatureUnavailableError(
        "session extension",
        capabilityDetail(this.lib, "SQLITE_ENABLE_SESSION"),
      )
    }
    const verdict =
      onConflict === "omit"
        ? SQLITE_CHANGESET_OMIT
        : onConflict === "replace"
          ? SQLITE_CHANGESET_REPLACE
          : SQLITE_CHANGESET_ABORT
    if (!this.#conflictCb) {
      // A null xConflict would be dereferenced on the first conflicting row.
      this.#conflictCb = new JSCallback(() => this.#conflictVerdict, {
        args: [T.ptr, T.i32, T.ptr],
        returns: T.i32,
      })
    }
    this.#conflictVerdict = verdict
    const rc = api.sqlite3changeset_apply(
      this.#handle,
      bytes.byteLength,
      bytes.byteLength === 0 ? new Uint8Array(1) : bytes,
      null,
      this.#conflictCb.ptr,
      null,
    )
    if (rc !== SQLITE_OK) this.fail(rc)
  }

  #conflictVerdict = SQLITE_CHANGESET_ABORT

  /** Finalizes cached statements, detaches every hook and closes the connection. */
  close(): void {
    if (this.#closed) return
    const s = this.lib.symbols
    const h = this.#handle
    for (const stmt of [...this.#cache.values()]) stmt.finalize()
    this.#cache.clear()
    for (const session of this.#sessions) this.lib.session?.sqlite3session_delete(session)
    this.#sessions.clear()

    // Unwire first: after this point SQLite cannot reach any JS function.
    s.sqlite3_update_hook(h, null, null)
    s.sqlite3_commit_hook(h, null, null)
    s.sqlite3_rollback_hook(h, null, null)
    s.sqlite3_wal_hook(h, null, null)
    s.sqlite3_set_authorizer(h, null, null)
    s.sqlite3_progress_handler(h, 0, null, null)
    this.lib.preupdate?.sqlite3_preupdate_hook(h, null, null)

    this.#closed = true
    this.#handle = 0
    s.sqlite3_close_v2(h)

    for (const cb of [
      this.#updateCb,
      this.#preupdateCb,
      this.#commitCb,
      this.#rollbackCb,
      this.#walCb,
      this.#authCb,
      this.#progressCb,
      this.#conflictCb,
    ]) {
      cb?.close()
    }
    this.#updateCb = null
    this.#preupdateCb = null
    this.#commitCb = null
    this.#rollbackCb = null
    this.#walCb = null
    this.#authCb = null
    this.#progressCb = null
    this.#conflictCb = null
  }

  /** Raises the connection's current error. Never returns. */
  fail(rc: number): never {
    const s = this.lib.symbols
    const handle = this.#handle
    const extended = handle ? s.sqlite3_extended_errcode(handle) : rc
    const code = extended && extended !== SQLITE_OK ? extended : rc
    const message = handle
      ? (cstr(s.sqlite3_errmsg(handle)) ?? cstr(s.sqlite3_errstr(code)) ?? "SQLite error")
      : (cstr(s.sqlite3_errstr(code)) ?? "SQLite error")
    throw new SqliteError(message, code)
  }

  /** Drops a finalized statement from the cache. Called by Statement.finalize(). */
  uncache(stmt: Statement): void {
    const hit = this.#cache.get(stmt.sql)
    if (hit === stmt) this.#cache.delete(stmt.sql)
  }

  #assertOpen(): void {
    if (this.#closed) throw new SqliteError("database is closed", 21)
  }
}

// Re-exported so callers can name the step codes without reaching into constants.
export { SQLITE_DONE, SQLITE_ROW }
