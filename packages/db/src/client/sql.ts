// Invariant: a tagged template produces bound parameters and never interpolated SQL. The values a
// caller writes inside `${}` become `?` placeholders and travel in `args`, so a string from a user
// cannot become part of the statement.
//
// Second invariant: a query object runs at most once per row mode. Nothing is sent until the
// caller says what shape it wants — `await` for objects, `.values()` for arrays — because that is
// the only thing that decides `rows` on the request.

import type {
  QueryResult,
  RequestOptions,
  RowsMode,
  StatementRequest,
  Value,
} from "./protocol.ts"
import { asClientError } from "./errors.ts"
import {
  decodeRowid,
  decodeRows,
  encodeAnyArgs,
  encodeValue,
  type IntMode,
  type JsRow,
  type JsValue,
} from "./values.ts"

/** Arguments in either of the shapes design §6.1 accepts. */
export type QueryArgs = readonly unknown[] | Record<string, unknown>

/** What every result array carries besides its rows (design §9.1). */
export interface ResultMeta {
  /** Rows in this result. Same as `length`; `Bun.SQL` spells it this way. */
  count: number
  /** The statement's leading keyword, upper-cased: `SELECT`, `INSERT`, `PRAGMA`… */
  command: string
  lastInsertRowid: number | bigint | string | null
  affectedRows: number
  /** The database's txid as of this statement (design §5.4). */
  txid: number
  columns: string[]
  types: string[]
  durationUs: number
  /** `sqlite3_stmt_status(SQLITE_STMTSTATUS_VM_STEP)`: the server's cost unit. */
  vmSteps: number
}

/** Rows, with the statement's metadata hung off the array. */
export type Result<T> = T[] & ResultMeta

const KEYWORD = /^[a-z]+/i
/** Leading comments and whitespace, which `command` has to look through. */
const LEADING = /^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/

/**
 * The statement's command word. A `WITH …` prefix is looked through, so a CTE that ends in an
 * insert reports `INSERT` rather than `WITH` — which is what the server's own classification
 * (`sqlite3_stmt_readonly`) would say about it.
 */
export function commandOf(sql: string): string {
  const text = sql.replace(LEADING, "")
  const first = KEYWORD.exec(text)?.[0]?.toUpperCase()
  if (first !== "WITH") return first ?? ""
  const tail = /\b(insert|update|delete|select|replace)\b/i.exec(text.slice(4))
  return tail ? (tail[1] as string).toUpperCase() : "WITH"
}

/** Builds `{sql, args}` from a tagged template. */
export function fromTemplate(
  strings: TemplateStringsArray | readonly string[],
  values: readonly unknown[],
): StatementRequest {
  let sql = strings[0] ?? ""
  const args: Value[] = []
  for (let i = 0; i < values.length; i++) {
    args.push(encodeValue(values[i]))
    sql += `?${strings[i + 1] ?? ""}`
  }
  return args.length > 0 ? { sql, args } : { sql }
}

/** Builds `{sql, args}` from a string and whatever arguments came with it. */
export function fromArgs(sql: string, args?: QueryArgs): StatementRequest {
  const encoded = encodeAnyArgs(args as readonly unknown[] | Record<string, unknown> | undefined)
  return encoded === undefined ? { sql } : { sql, args: encoded }
}

const META_KEYS = [
  "count",
  "command",
  "lastInsertRowid",
  "affectedRows",
  "txid",
  "columns",
  "types",
  "durationUs",
  "vmSteps",
] as const

/**
 * Hangs the metadata off the rows array. The properties are non-enumerable, so the array still
 * compares, spreads and serialises as the plain list of rows it looks like.
 */
export function decorate<T>(rows: T[], meta: ResultMeta): Result<T> {
  const descriptors: PropertyDescriptorMap = {}
  for (const key of META_KEYS) {
    descriptors[key] = {
      value: meta[key],
      enumerable: false,
      writable: true,
      configurable: true,
    }
  }
  Object.defineProperties(rows, descriptors)
  return rows as Result<T>
}

/** A server result, as the rows and metadata a caller gets. */
export function toResult<T>(wire: QueryResult, sql: string, intMode: IntMode): Result<T> {
  const rows = decodeRows(wire.rows, intMode) as T[]
  return decorate(rows, {
    count: rows.length,
    command: commandOf(sql),
    lastInsertRowid: decodeRowid(wire.lastInsertRowid, intMode),
    affectedRows: wire.rowsAffected,
    txid: wire.txid,
    columns: wire.columns,
    types: wire.types,
    durationUs: wire.durationUs,
    vmSteps: wire.vmSteps,
  })
}

/** Runs one statement. Every backing — HTTP, WebSocket, in-process — provides one of these. */
export type Runner = (
  request: StatementRequest,
  rows: RowsMode,
  options: RequestOptions | undefined,
) => Promise<QueryResult>

/**
 * A statement that has not been sent yet. `then` makes it a promise of object rows; `values` asks
 * for arrays; `first` and `run` are the two shapes worth a name of their own.
 */
export class Query<T = JsRow> implements PromiseLike<Result<T>> {
  readonly sql: string
  readonly args: StatementRequest["args"]

  #run: Runner
  #intMode: IntMode
  #options: RequestOptions | undefined
  #pending = new Map<RowsMode, Promise<QueryResult>>()

  constructor(
    run: Runner,
    request: StatementRequest,
    intMode: IntMode,
    options?: RequestOptions,
  ) {
    this.#run = run
    this.#intMode = intMode
    this.#options = options
    this.sql = request.sql
    this.args = request.args
  }

  /** The statement as a batch item (design §9.1: `db.batch([db.stmt\`…\`])`). */
  toJSON(): StatementRequest {
    return this.args === undefined ? { sql: this.sql } : { sql: this.sql, args: this.args }
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.#execute("object")
      .then((wire) => this.#decode<T>(wire))
      .then(onfulfilled, onrejected)
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<Result<T> | R> {
    return (this.then() as Promise<Result<T>>).catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<Result<T>> {
    return (this.then() as Promise<Result<T>>).finally(onfinally)
  }

  /** Rows as arrays in column order, which is the compact shape the server sends by default. */
  async values(): Promise<Result<JsValue[]>> {
    return this.#decode<JsValue[]>(await this.#execute("array"))
  }

  /** Alias of `values`, the spelling `Bun.SQL` uses for the same thing (design §9.1). */
  raw(): Promise<Result<JsValue[]>> {
    return this.values()
  }

  /** The first row, or null. */
  async first(): Promise<T | null> {
    const wire = await this.#execute("object")
    try {
      return (decodeRows(wire.rows, this.#intMode)[0] as T | undefined) ?? null
    } catch (err) {
      throw asClientError(err, `decoding ${JSON.stringify(this.sql.slice(0, 80))}`)
    }
  }

  /** Runs the statement for its effect; the rows, if any, still come back. */
  async run(): Promise<Result<JsValue[]>> {
    return this.#decode<JsValue[]>(await this.#execute("array"))
  }

  /** Wire result → rows. Decoding can fail on its own (an integer `intMode` cannot carry). */
  #decode<R>(wire: QueryResult): Result<R> {
    try {
      return toResult<R>(wire, this.sql, this.#intMode)
    } catch (err) {
      throw asClientError(err, `decoding ${JSON.stringify(this.sql.slice(0, 80))}`)
    }
  }

  #execute(rows: RowsMode): Promise<QueryResult> {
    const hit = this.#pending.get(rows)
    if (hit) return hit
    const request = this.toJSON()
    const promise = (async () => {
      try {
        return await this.#run(request, rows, this.#options)
      } catch (err) {
        throw asClientError(err, `query ${JSON.stringify(this.sql.slice(0, 80))}`)
      }
    })()
    this.#pending.set(rows, promise)
    return promise
  }
}
