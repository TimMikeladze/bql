// Invariant: a statement is always left reset. Every verb resets before it binds and resets
// again when it stops stepping, including on the error and early-return paths, so no statement
// ever holds a read transaction open between calls.

import {
  SQLITE_DONE,
  SQLITE_OK,
  SQLITE_ROW,
  STMT_STATUS,
  type StmtStatusName,
} from "./constants.ts"
import { SqliteError } from "./errors.ts"
import { ptr } from "bun:ffi"
import { cbuf, cstr, type SqliteLibrary } from "./lib.ts"
import {
  bindOne,
  columnValue,
  type BindArg,
  type BindValue,
  type NamedParams,
  type SqliteValue,
} from "./values.ts"

/** The part of Database a Statement needs; keeps the two modules free of a runtime cycle. */
export interface StatementHost {
  readonly lib: SqliteLibrary
  readonly handle: number
  readonly safeIntegers: boolean
  /** Raises the connection's current error as a SqliteError. */
  fail(rc: number): never
  /** Drops a finalized statement from the connection's prepared-statement cache. */
  uncache(stmt: Statement): void
}

export interface RunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export type Row = Record<string, SqliteValue>

function isNamedParams(params: readonly BindArg[]): params is [NamedParams] {
  if (params.length !== 1) return false
  const first = params[0]
  return (
    typeof first === "object" &&
    first !== null &&
    !ArrayBuffer.isView(first) &&
    !(first instanceof ArrayBuffer)
  )
}

export class Statement {
  #host: StatementHost
  #handle: number
  #sql: string
  #columnCount: number
  #names: string[] | null = null
  #types: (string | null)[] | null = null
  #nameIndex: Map<string, number> | null = null
  #rowFactory: (() => Row) | null = null
  #boundCount = 0
  #finalized = false
  /** True while a generator from `.iterate()` is mid-flight. */
  #iterating = false

  constructor(host: StatementHost, sql: string, handle: number) {
    this.#host = host
    this.#sql = sql
    this.#handle = handle
    this.#columnCount = host.lib.symbols.sqlite3_column_count(handle)
  }

  /** The SQL text this statement was prepared from. */
  get sql(): string {
    return this.#sql
  }

  /** Raw `sqlite3_stmt *`. */
  get handle(): number {
    return this.#handle
  }

  get finalized(): boolean {
    return this.#finalized
  }

  /** Column names of the result set, in order. */
  get columnNames(): string[] {
    if (!this.#names) {
      const s = this.#host.lib.symbols
      const names: string[] = []
      for (let i = 0; i < this.#columnCount; i++) {
        names.push(cstr(s.sqlite3_column_name(this.#handle, i)) ?? `column${i}`)
      }
      this.#names = names
    }
    return this.#names
  }

  /** Declared types of the result columns; null where the expression has no declared type. */
  get declaredTypes(): (string | null)[] {
    if (!this.#types) {
      const s = this.#host.lib.symbols
      const types: (string | null)[] = []
      for (let i = 0; i < this.#columnCount; i++) {
        types.push(cstr(s.sqlite3_column_decltype(this.#handle, i)))
      }
      this.#types = types
    }
    return this.#types
  }

  /** Number of bindable parameters, i.e. the largest parameter index. */
  get paramsCount(): number {
    this.#assertLive()
    return this.#host.lib.symbols.sqlite3_bind_parameter_count(this.#handle)
  }

  /** True when the statement makes no direct changes to the database. */
  get readonly(): boolean {
    this.#assertLive()
    return this.#host.lib.symbols.sqlite3_stmt_readonly(this.#handle) !== 0
  }

  /**
   * One `sqlite3_stmt_status` counter for this statement. Counters accumulate over every run of
   * the statement until `reset` is passed, which zeroes the counter after reading it.
   */
  status(op: StmtStatusName, reset = false): number {
    this.#assertLive()
    const code = STMT_STATUS[op]
    if (code === undefined) throw new RangeError(`unknown statement counter ${op}`)
    return this.#host.lib.symbols.sqlite3_stmt_status(this.#handle, code, reset ? 1 : 0)
  }

  /**
   * Virtual-machine instructions the statement has executed. This is the cost unit design §6.1
   * bills on: SQLite has no native rows-read counter, and VM steps are the honest equivalent.
   */
  vmSteps(reset = false): number {
    return this.status("VM_STEP", reset)
  }

  /** Resets the statement, aborting any in-progress iteration. */
  reset(): this {
    this.#assertLive()
    this.#iterating = false
    this.#host.lib.symbols.sqlite3_reset(this.#handle)
    return this
  }

  /** Releases the statement. Further use throws; the prepared-statement cache drops it. */
  finalize(): void {
    if (this.#finalized) return
    this.#finalized = true
    this.#iterating = false
    this.#host.uncache(this)
    this.#host.lib.symbols.sqlite3_finalize(this.#handle)
    this.#handle = 0
  }

  /** Runs to completion and returns the first row as an object, or null for an empty result. */
  get(...params: BindArg[]): Row | null {
    const s = this.#host.lib.symbols
    const h = this.#handle
    this.#prepareCall(params)
    const rc = s.sqlite3_step(h)
    if (rc === SQLITE_ROW) {
      const row = this.#row()
      s.sqlite3_reset(h)
      return row
    }
    s.sqlite3_reset(h)
    if (rc !== SQLITE_DONE) this.#host.fail(rc)
    return null
  }

  /** All rows as objects. */
  all(...params: BindArg[]): Row[] {
    const s = this.#host.lib.symbols
    const h = this.#handle
    this.#prepareCall(params)
    const out: Row[] = []
    try {
      let rc = s.sqlite3_step(h)
      while (rc === SQLITE_ROW) {
        out.push(this.#row())
        rc = s.sqlite3_step(h)
      }
      if (rc !== SQLITE_DONE) this.#host.fail(rc)
    } finally {
      s.sqlite3_reset(h)
    }
    return out
  }

  /** All rows as arrays, in column order. */
  values(...params: BindArg[]): SqliteValue[][] {
    const s = this.#host.lib.symbols
    const h = this.#handle
    this.#prepareCall(params)
    const out: SqliteValue[][] = []
    try {
      let rc = s.sqlite3_step(h)
      while (rc === SQLITE_ROW) {
        out.push(this.#values())
        rc = s.sqlite3_step(h)
      }
      if (rc !== SQLITE_DONE) this.#host.fail(rc)
    } finally {
      s.sqlite3_reset(h)
    }
    return out
  }

  /** Steps to completion, discarding rows, and reports what changed. */
  run(...params: BindArg[]): RunResult {
    const s = this.#host.lib.symbols
    const h = this.#handle
    this.#prepareCall(params)
    try {
      let rc = s.sqlite3_step(h)
      while (rc === SQLITE_ROW) rc = s.sqlite3_step(h)
      if (rc !== SQLITE_DONE) this.#host.fail(rc)
    } finally {
      s.sqlite3_reset(h)
    }
    const db = this.#host.handle
    return this.#host.safeIntegers
      ? {
          changes: this.#host.lib.wide.sqlite3_changes64(db),
          lastInsertRowid: this.#host.lib.wide.sqlite3_last_insert_rowid(db),
        }
      : {
          changes: s.sqlite3_changes64(db),
          lastInsertRowid: s.sqlite3_last_insert_rowid(db),
        }
  }

  /** Lazily yields rows as objects. Resets when exhausted, on error, and on early `break`. */
  *iterate(...params: BindArg[]): Generator<Row, void, undefined> {
    const s = this.#host.lib.symbols
    const h = this.#handle
    this.#prepareCall(params)
    this.#iterating = true
    try {
      let rc = s.sqlite3_step(h)
      while (rc === SQLITE_ROW) {
        yield this.#row()
        if (!this.#iterating) return
        rc = s.sqlite3_step(h)
      }
      if (rc !== SQLITE_DONE) this.#host.fail(rc)
    } finally {
      this.#iterating = false
      s.sqlite3_reset(h)
    }
  }

  /** `for (const row of stmt)` with no parameters. */
  [Symbol.iterator](): Generator<Row, void, undefined> {
    return this.iterate()
  }

  #row(): Row {
    return (this.#rowFactory ??= this.#buildRowFactory())()
  }

  /**
   * Builds a row constructor for this statement's exact column list. An object literal with a
   * fixed set of keys gets one hidden class the engine can reuse for every row, which is
   * measurably faster than adding properties to `{}` one at a time in a loop.
   */
  #buildRowFactory(): () => Row {
    const names = this.columnNames
    const lib = this.#host.lib
    const safe = this.#host.safeIntegers
    const h = this.#handle
    if (names.length === 0) return () => ({})
    const literal = names
      .map((name, i) => `${JSON.stringify(name)}: read(lib, h, ${i}, safe)`)
      .join(", ")
    const build = new Function(
      "read",
      "lib",
      "h",
      "safe",
      `return function row() { return { ${literal} } }`,
    ) as (
      read: typeof columnValue,
      lib: SqliteLibrary,
      h: number,
      safe: boolean,
    ) => () => Row
    return build(columnValue, lib, h, safe)
  }

  #values(): SqliteValue[] {
    const lib = this.#host.lib
    const safe = this.#host.safeIntegers
    const h = this.#handle
    const n = this.#columnCount
    const out: SqliteValue[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = columnValue(lib, h, i, safe)
    return out
  }

  #prepareCall(params: readonly BindArg[]): void {
    this.#assertLive()
    const s = this.#host.lib.symbols
    s.sqlite3_reset(this.#handle)
    this.#iterating = false
    if (params.length === 0) {
      if (this.#boundCount > 0) {
        s.sqlite3_clear_bindings(this.#handle)
        this.#boundCount = 0
      }
      return
    }
    if (isNamedParams(params)) {
      this.#bindNamed(params[0])
      return
    }
    if (params.length < this.#boundCount) s.sqlite3_clear_bindings(this.#handle)
    for (let i = 0; i < params.length; i++) {
      const rc = bindOne(s, this.#handle, i + 1, params[i] as BindValue)
      if (rc !== SQLITE_OK) this.#host.fail(rc)
    }
    this.#boundCount = params.length
  }

  #bindNamed(obj: NamedParams): void {
    const s = this.#host.lib.symbols
    s.sqlite3_clear_bindings(this.#handle)
    this.#boundCount = this.paramsCount
    const index = this.#namedIndex()
    for (const key of Object.keys(obj)) {
      const slot = index.get(key)
      if (slot === undefined) {
        throw new RangeError(
          `no parameter named "${key}" in: ${this.#sql} ` +
            `(parameters: ${[...index.keys()].join(", ") || "none"})`,
        )
      }
      const rc = bindOne(s, this.#handle, slot, obj[key])
      if (rc !== SQLITE_OK) this.#host.fail(rc)
    }
  }

  /**
   * Maps every spelling of a named parameter to its slot: the literal name as written in the
   * SQL (`:id`, `@id`, `$id`) and the bare name, so `{ id: 1 }` binds any of the three.
   */
  #namedIndex(): Map<string, number> {
    if (this.#nameIndex) return this.#nameIndex
    const s = this.#host.lib.symbols
    const map = new Map<string, number>()
    const count = this.paramsCount
    for (let i = 1; i <= count; i++) {
      const name = cstr(s.sqlite3_bind_parameter_name(this.#handle, i))
      if (!name) continue
      map.set(name, i)
      const bare = name.slice(1)
      if (bare && !map.has(bare)) map.set(bare, i)
    }
    this.#nameIndex = map
    return map
  }

  #assertLive(): void {
    if (this.#finalized) {
      throw new SqliteError(`statement has been finalized: ${this.#sql}`, 21)
    }
  }
}

/**
 * Prepares one statement, raising the connection's error on failure. SQL holding more than one
 * statement is rejected rather than silently preparing only the first: use `exec` for a script.
 */
export function prepareStatement(
  host: StatementHost,
  sql: string,
  flags: number,
): Statement {
  const s = host.lib.symbols
  const out = new BigUint64Array(1)
  const tail = new BigUint64Array(1)
  const text = cbuf(sql)
  const base = ptr(text)
  const rc = s.sqlite3_prepare_v3(host.handle, text, text.length - 1, flags, out, tail)
  if (rc !== SQLITE_OK) host.fail(rc)
  const handle = Number(out[0])
  if (handle === 0) {
    throw new SqliteError(`statement contains no SQL: ${JSON.stringify(sql)}`, 21)
  }
  const consumed = Number(tail[0]) - Number(base)
  const rest = sql.slice(consumed).trim()
  if (rest.length > 0 && rest !== ";") {
    s.sqlite3_finalize(handle)
    throw new SqliteError(
      `prepare() takes a single statement; this SQL has more after ${JSON.stringify(
        sql.slice(0, consumed).trim(),
      )}. Use exec() to run a script.`,
      21,
    )
  }
  return new Statement(host, sql, handle)
}
