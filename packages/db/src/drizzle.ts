// Drizzle over bql.sh (plan-phase1.md R5), through Drizzle's own libsql session.
//
// Invariant: this module is a libsql-shaped `Client` over a bql.sh `Db` and nothing else. Drizzle's
// libsql driver core (`drizzle-orm/libsql/driver-core`) takes any object with `execute`, `batch`
// and `transaction` on it, so bql.sh gets Drizzle's real transactions and its real `db.batch()`
// rather than the `begin`/`commit`-as-one-shot-statements emulation `sqlite-proxy` would have to
// use — which over HTTP would commit nothing, because each statement on the tenant's writer is its
// own transaction.
//
// Second invariant: the rows this module builds are libsql's row shape exactly — an object with
// non-enumerable indices and a non-enumerable `length`, plus one enumerable property per column.
// Drizzle reads a row both as an array (`Array.prototype.slice.call(row)`) and as an object
// (`Object.keys(row)`), and only that shape answers both.
//
// Third invariant: `drizzle-orm` is a peer, not a dependency. Nothing under `src/` imports it
// except this module.

import type { DrizzleConfig } from "drizzle-orm"
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core"
import * as libsqlCore from "drizzle-orm/libsql/driver-core"
import {
  createClient,
  type Client,
  type ClientOptions,
  type Db,
  type StatementOptions,
  type Tx,
} from "./client/index.ts"
import type { JsValue } from "./client/values.ts"

// ── the libsql shapes we answer with ───────────────────────────────────────────────────────────
//
// Declared here rather than imported: `@libsql/client` is not a dependency of bql.sh, and these are
// the only parts of its surface Drizzle's session touches.

/** A row as `@libsql/client` builds it: array-like, plus one enumerable property per column. */
export type LibSqlRow = Record<string, unknown> & { length: number }

export interface LibSqlResultSet {
  columns: string[]
  columnTypes: string[]
  rows: LibSqlRow[]
  rowsAffected: number
  lastInsertRowid: bigint | undefined
  toJSON(): unknown
}

export type LibSqlArgs = readonly unknown[] | Record<string, unknown>

export type LibSqlStatement = string | { sql: string; args?: LibSqlArgs }

/** libsql's transaction modes. `"write"` and `"deferred"` are bql.sh's `immediate`/`deferred`. */
export type LibSqlTransactionMode = "write" | "read" | "deferred"

export interface LibSqlTransaction {
  execute(statement: LibSqlStatement, args?: LibSqlArgs): Promise<LibSqlResultSet>
  batch(statements: LibSqlStatement[]): Promise<LibSqlResultSet[]>
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): void
  readonly closed: boolean
}

/** The slice of `@libsql/client`'s `Client` that Drizzle's libsql session calls. */
export interface LibSqlClient {
  readonly protocol: string
  readonly closed: boolean
  execute(statement: LibSqlStatement, args?: LibSqlArgs): Promise<LibSqlResultSet>
  batch(statements: LibSqlStatement[], mode?: LibSqlTransactionMode): Promise<LibSqlResultSet[]>
  migrate(statements: LibSqlStatement[]): Promise<LibSqlResultSet[]>
  transaction(mode?: LibSqlTransactionMode): Promise<LibSqlTransaction>
  close(): void
  /** The bql.sh handle underneath, for anything this shim does not cover. */
  readonly bql: Db
}

// ── bql.sh → libsql ─────────────────────────────────────────────────────────────────────────────

function statementOf(statement: LibSqlStatement, args?: LibSqlArgs): { sql: string; args?: LibSqlArgs } {
  if (typeof statement === "string") {
    return args === undefined ? { sql: statement } : { sql: statement, args }
  }
  return statement
}

/**
 * A blob as libsql hands it over: an `ArrayBuffer`. Drizzle's own `normalizeFieldValue` turns that
 * into a `Buffer` where one exists, which is what a `blob()` column expects, so answering with the
 * `Uint8Array` our codec produces would quietly give a `blob({mode:"bigint"})` column the wrong
 * value.
 */
function toLibsqlValue(value: JsValue): unknown {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  }
  return value
}

/** libsql's row: non-enumerable `length` and indices, one enumerable property per column. */
function toRow(values: readonly JsValue[], columns: readonly string[]): LibSqlRow {
  const row = {} as LibSqlRow
  Object.defineProperty(row, "length", { value: values.length, enumerable: false })
  for (let i = 0; i < values.length; i++) {
    const value = toLibsqlValue(values[i] as JsValue)
    Object.defineProperty(row, i, { value, enumerable: false, configurable: true })
    const column = columns[i]
    // A duplicate column name keeps the first, as libsql does; the index still reaches both.
    if (column !== undefined && !Object.hasOwn(row, column)) {
      Object.defineProperty(row, column, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }
  return row
}

function toRowid(value: number | bigint | string | null): bigint | undefined {
  if (value === null) return undefined
  if (typeof value === "bigint") return value
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(value) : undefined
  const text = value.trim()
  return text.length > 0 ? BigInt(text) : undefined
}

interface RowsResult {
  readonly columns: string[]
  readonly types: string[]
  readonly affectedRows: number
  readonly lastInsertRowid: number | bigint | string | null
}

/** One bql.sh result as a libsql `ResultSet`. */
function toResultSet(values: readonly JsValue[][], meta: RowsResult): LibSqlResultSet {
  const columns = meta.columns
  const rows = values.map((row) => toRow(row, columns))
  const set: LibSqlResultSet = {
    columns,
    columnTypes: meta.types,
    rows,
    rowsAffected: meta.affectedRows,
    lastInsertRowid: toRowid(meta.lastInsertRowid),
    toJSON() {
      return {
        columns,
        columnTypes: meta.types,
        rows: rows.map((row) => Array.prototype.slice.call(row) as unknown[]),
        rowsAffected: meta.affectedRows,
        lastInsertRowid: set.lastInsertRowid?.toString() ?? null,
      }
    },
  }
  return set
}

/** Rejecting the parked transaction callback with this asks for a rollback; it is not an error. */
const ROLLBACK = Symbol("bql.drizzle.rollback")

/**
 * One transaction at a time per database. A bql.sh tenant has a single writer and an open
 * transaction holds it, so a second `db.transaction()` while one is open is `TX_BUSY` from the
 * server — which two concurrent request handlers would hit routinely. They queue here instead.
 * The wait is capped, because a transaction opened from inside another one on the same handle
 * would otherwise wait for itself forever.
 */
class WriterQueue {
  #tail: Promise<void> = Promise.resolve()

  async enter(db: string, waitMs: number): Promise<() => void> {
    const ahead = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    let left = false
    const leave = (): void => {
      if (left) return
      left = true
      release()
    }
    if (waitMs <= 0) {
      await ahead
      return leave
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ahead,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `bql/drizzle: waited ${waitMs} ms for the open transaction on ${db} to end. ` +
                    "A transaction cannot be opened from inside another one on the same database; " +
                    "use the `tx` the callback gives you, or raise transactionWaitMs.",
                ),
              ),
            waitMs,
          )
        }),
      ])
    } catch (err) {
      // Nothing was taken, so the next waiter must not be left behind this one.
      leave()
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
    return leave
  }
}

/** One queue per `Db`, however many clients are wrapped around it. */
const queues = new WeakMap<Db, WriterQueue>()

function queueFor(db: Db): WriterQueue {
  const hit = queues.get(db)
  if (hit) return hit
  const made = new WriterQueue()
  queues.set(db, made)
  return made
}

/**
 * `db.transaction()` is callback-scoped and libsql's is a handle, so the callback is parked on a
 * promise that `commit()` resolves and `rollback()` rejects.
 */
async function openTransaction(
  db: Db,
  statement: StatementOptions | undefined,
  mode: LibSqlTransactionMode | undefined,
  waitMs: number,
): Promise<LibSqlTransaction> {
  const leave = await queueFor(db).enter(db.name, waitMs)
  try {
    return await parkTransaction(db, statement, mode, leave)
  } catch (err) {
    leave()
    throw err
  }
}

async function parkTransaction(
  db: Db,
  statement: StatementOptions | undefined,
  mode: LibSqlTransactionMode | undefined,
  leave: () => void,
): Promise<LibSqlTransaction> {
  let handOver!: (tx: Tx) => void
  let handFail!: (err: unknown) => void
  const opened = new Promise<Tx>((ok, fail) => {
    handOver = ok
    handFail = fail
  })
  let release!: (how: "commit" | "rollback") => void
  const done = db
    .transaction<void>(
      (tx) =>
        new Promise<void>((resolve, reject) => {
          release = (how) => (how === "commit" ? resolve() : reject(ROLLBACK))
          handOver(tx)
        }),
      // libsql's own default is `"write"`, and Drizzle opens a transaction without naming a mode.
      { mode: mode === "read" || mode === "deferred" ? "deferred" : "immediate" },
    )
    .then(
      () => undefined,
      (err: unknown) => {
        if (err !== ROLLBACK) throw err
      },
    )
  // A transaction the server refused never reaches the callback, so `opened` would hang on it.
  done.catch(handFail)
  const tx = await opened

  let settled = false
  const end = async (how: "commit" | "rollback"): Promise<void> => {
    if (settled) return
    settled = true
    release(how)
    try {
      await done
    } finally {
      leave()
    }
  }
  const run = async (one: LibSqlStatement, args?: LibSqlArgs): Promise<LibSqlResultSet> => {
    if (settled) throw new Error("bql/drizzle: this transaction is already closed")
    const request = statementOf(one, args)
    const result = await tx.execute(request.sql, request.args as readonly unknown[], statement).values()
    return toResultSet(result as unknown as JsValue[][], result)
  }

  return {
    execute: run,
    async batch(statements) {
      const out: LibSqlResultSet[] = []
      for (const one of statements) out.push(await run(one))
      return out
    },
    commit: () => end("commit"),
    rollback: () => end("rollback"),
    close(): void {
      void end("rollback")
    },
    get closed(): boolean {
      return settled
    },
  }
}

export interface LibSqlClientOptions {
  /** Options applied to every statement: `timeoutMs`, `maxRows`, `ack`, `consistency`. */
  statement?: StatementOptions
  /**
   * How long a `transaction()` waits for another one on the same database to finish before it
   * gives up. Default 10 s; `0` waits forever.
   */
  transactionWaitMs?: number
  /** Called by `close()`; set when this module built the client it is wrapping. */
  onClose?: () => void
}

/**
 * A bql.sh `Db` behind the part of `@libsql/client`'s `Client` that Drizzle uses. Useful on its own
 * for anything else that takes a libsql client.
 */
export function libsqlClient(db: Db, options: LibSqlClientOptions = {}): LibSqlClient {
  const statement = options.statement
  const waitMs = options.transactionWaitMs ?? 10_000
  let closed = false

  const execute = async (one: LibSqlStatement, args?: LibSqlArgs): Promise<LibSqlResultSet> => {
    const request = statementOf(one, args)
    const result = await db.execute(request.sql, request.args as readonly unknown[], statement).values()
    return toResultSet(result as unknown as JsValue[][], result)
  }

  const batch = async (statements: LibSqlStatement[]): Promise<LibSqlResultSet[]> => {
    if (statements.length === 0) return []
    const items = statements.map((one) => statementOf(one))
    // One bql.sh batch is one transaction over one txid (design §6.2), which is what libsql's
    // default batch mode promises too.
    const results = await db.batch(
      items.map((item) => ({
        sql: item.sql,
        ...(item.args === undefined ? {} : { args: item.args as never }),
      })),
      { ...statement, rows: "array" },
    )
    return results.map((result) => toResultSet(result as unknown as JsValue[][], result))
  }

  return {
    protocol: "bql",
    get closed(): boolean {
      return closed
    },
    bql: db,
    execute,
    batch,
    migrate: batch,
    transaction: (mode) => openTransaction(db, statement, mode, waitMs),
    close(): void {
      closed = true
      options.onClose?.()
    },
  }
}

// ── the entry point ────────────────────────────────────────────────────────────────────────────

/** A client this adapter builds and owns, rather than a `Db` the caller already has. */
export interface BqlDrizzleClientConfig extends Omit<ClientOptions, "db" | "url" | "intMode"> {
  /** Base URL of the server, `https://sql.example.com`. */
  url: string
  /** Database name on that server. */
  db: string
  token?: string
  /**
   * What an integer beyond 2^53 becomes. Defaults to `"bigint"` here rather than the client's own
   * `"number"`: an ORM that throws on a large rowid is worse than one that hands back a bigint.
   */
  intMode?: ClientOptions["intMode"]
}

export type BqlDrizzleSource = Db | LibSqlClient | BqlDrizzleClientConfig

export interface BqlDrizzleConfig<TSchema extends Record<string, unknown>>
  extends DrizzleConfig<TSchema> {
  /** Options applied to every statement: `timeoutMs`, `maxRows`, `ack`, `consistency`. */
  statement?: StatementOptions
  /**
   * How long `db.transaction()` waits for another transaction on the same database to finish
   * before it gives up. Default 10 s; `0` waits forever.
   */
  transactionWaitMs?: number
}

export type BqlDatabase<TSchema extends Record<string, unknown> = Record<string, never>> =
  LibSQLDatabase<TSchema> & { $client: LibSqlClient }

/**
 * `construct` is what `drizzle-orm/libsql`'s own entry point calls once it has a client; the
 * package exports it at runtime but leaves it out of its types, so it is named here.
 */
type Construct = <TSchema extends Record<string, unknown>>(
  client: LibSqlClient,
  config?: DrizzleConfig<TSchema>,
) => LibSQLDatabase<TSchema>

const construct = (libsqlCore as unknown as { construct?: Construct }).construct

function isDb(value: unknown): value is Db {
  const candidate = value as Partial<Db> | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.name === "string" &&
    typeof candidate.execute === "function" &&
    typeof candidate.transaction === "function"
  )
}

/**
 * A libsql client, which a bql.sh `Db` also resembles — both have `execute`, `batch` and
 * `transaction`. Only a `Db` names its database, so that is what tells the two apart, and `isDb`
 * is asked first everywhere this is used.
 */
function isLibSqlClient(value: unknown): value is LibSqlClient {
  const candidate = value as Partial<LibSqlClient> | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.execute === "function" &&
    typeof candidate.transaction === "function" &&
    typeof candidate.batch === "function"
  )
}

/**
 * Drizzle over bql.sh.
 *
 * ```ts
 * const db = drizzle({ url, token, db: "acme" }, { schema })
 * await db.insert(todos).values({ title: "write it" })
 * ```
 */
export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  source: BqlDrizzleSource,
  config: BqlDrizzleConfig<TSchema> = {},
): BqlDatabase<TSchema> {
  if (typeof construct !== "function") {
    throw new Error(
      "bql/drizzle: this drizzle-orm no longer exports `construct` from " +
        "drizzle-orm/libsql/driver-core; pin drizzle-orm or open an issue",
    )
  }
  const { statement, transactionWaitMs, ...drizzleConfig } = config
  const shim: LibSqlClientOptions = {
    ...(statement ? { statement } : {}),
    ...(transactionWaitMs === undefined ? {} : { transactionWaitMs }),
  }
  let client: LibSqlClient
  if (isDb(source)) {
    client = libsqlClient(source, shim)
  } else if (isLibSqlClient(source)) {
    client = source
  } else {
    const { db: name, ...rest } = source
    if (typeof rest.url !== "string" || typeof name !== "string") {
      throw new TypeError("bql/drizzle: pass a bql.sh Db, a libsql client, or {url, db}")
    }
    const owned: Client = createClient({ intMode: "bigint", ...rest, db: name })
    client = libsqlClient(owned.db(name), { ...shim, onClose: () => owned.close() })
  }
  const db = construct<TSchema>(client, drizzleConfig) as BqlDatabase<TSchema>
  db.$client = client
  return db
}

export default drizzle
export type { Db, StatementOptions } from "./client/index.ts"
