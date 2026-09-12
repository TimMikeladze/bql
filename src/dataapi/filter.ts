// Invariant: nothing this module returns carries a column *name* from the request. A filter, an
// order term and a `select` list are each resolved against the introspected table on the way in,
// and what comes out holds `ColumnInfo` objects — the very records `PRAGMA table_xinfo` produced.
// A name that is not in that table is a `400` here and never reaches `src/dataapi/sql.ts`, which
// is why that module can quote a name without ever having to ask where it came from.
//
// The grammar is PostgREST's, because it is the one people already know and it stays cacheable
// and loggable (`docs/plan-surfaces.md`):
//
//   ?id=gt.10&name=like.ann*&order=name.asc&limit=20&offset=40&select=id,name
//
// Operators: eq ne gt gte lt lte like ilike in is. Every operand becomes a bound parameter; the
// only text this module chooses is an operator and an `IS` literal, both from fixed sets.
//
// Values are coerced by the column's **affinity**, not by what they look like. `?id=eq.10` on an
// INTEGER column binds the integer 10, because SQLite would convert the text anyway and a column
// with no affinity — an untyped one — would not, so the comparison would silently match nothing.
// A value that cannot be what its column stores is a `400`, not a query that returns zero rows.

import { BunQLError } from "../server/errors.ts"
import type { DataValue } from "./context.ts"
import { columnOf, type ColumnInfo, type TableInfo } from "./introspect.ts"

export type Operator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is"

export const OPERATORS: readonly Operator[] = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "in",
  "is",
]

/** The right-hand side of `IS`, chosen from this fixed set and never from the request's text. */
export type IsLiteral = "NULL" | "NOT NULL" | "TRUE" | "FALSE"

export interface Condition {
  /** The introspected column, not its name. */
  column: ColumnInfo
  operator: Operator
  /** Bound parameters; empty for `is`, one for most, many for `in`. */
  values: DataValue[]
  /** Only for `is`. */
  literal?: IsLiteral
}

export interface OrderTerm {
  column: ColumnInfo
  descending: boolean
  /** `undefined` leaves SQLite's own NULL ordering alone. */
  nulls?: "first" | "last"
}

export interface ListPlan {
  /** Columns the response carries, in order. Never empty. */
  select: ColumnInfo[]
  where: Condition[]
  order: OrderTerm[]
  limit: number
  offset: number
}

export interface ListLimits {
  defaultLimit: number
  maxLimit: number
}

/** Query keys the grammar owns; a column sharing one of these names cannot be filtered. */
export const RESERVED_QUERY_KEYS: readonly string[] = ["select", "order", "limit", "offset"]

/** Columns a response may carry: everything readable, generated and synthetic ones included. */
export function readableColumns(table: TableInfo): ColumnInfo[] {
  return table.columns
}

/**
 * One list request as a plan over introspected columns. Throws `BAD_REQUEST` for any name,
 * operator or value the table cannot account for.
 */
export function parseListQuery(
  table: TableInfo,
  query: Record<string, unknown>,
  limits: ListLimits,
): ListPlan {
  const select = parseSelect(table, query.select)
  const order = parseOrder(table, query.order)
  const where: Condition[] = []
  for (const key of Object.keys(query)) {
    if (RESERVED_QUERY_KEYS.includes(key)) continue
    const value = query[key]
    if (value === undefined) continue
    if (typeof value !== "string") {
      throw BunQLError.badRequest(
        `${describe(table, key)} takes one value, written "<operator>.<value>"`,
      )
    }
    where.push(parseCondition(table, key, value))
  }
  return {
    select,
    where,
    order,
    limit: resolveLimit(query.limit, limits),
    offset: resolveOffset(query.offset),
  }
}

function describe(table: TableInfo, key: string): string {
  return `the query parameter "${key}" of table ${table.name}`
}

function resolveLimit(raw: unknown, limits: ListLimits): number {
  const asked = typeof raw === "number" ? raw : limits.defaultLimit
  // Floor and ceiling, as `resolveOptions` in `src/server/exec.ts` treats every other limit: a
  // request may ask for less than the node allows, never for more.
  return Math.max(1, Math.min(asked, limits.maxLimit))
}

function resolveOffset(raw: unknown): number {
  return typeof raw === "number" && raw > 0 ? Math.floor(raw) : 0
}

export function parseSelect(table: TableInfo, raw: unknown): ColumnInfo[] {
  if (raw === undefined || raw === null || raw === "") return readableColumns(table)
  if (typeof raw !== "string") throw BunQLError.badRequest("select must be a comma-separated list of columns")
  const out: ColumnInfo[] = []
  const seen = new Set<string>()
  for (const part of raw.split(",")) {
    const name = part.trim()
    if (name.length === 0) continue
    const column = resolveColumn(table, name, "select")
    if (seen.has(column.name)) continue
    seen.add(column.name)
    out.push(column)
  }
  if (out.length === 0) throw BunQLError.badRequest("select named no columns")
  return out
}

function parseOrder(table: TableInfo, raw: unknown): OrderTerm[] {
  if (raw === undefined || raw === null || raw === "") return []
  if (typeof raw !== "string") throw BunQLError.badRequest("order must be a comma-separated list of terms")
  const out: OrderTerm[] = []
  for (const part of raw.split(",")) {
    const term = part.trim()
    if (term.length === 0) continue
    const pieces = term.split(".")
    const column = resolveColumn(table, pieces[0] as string, "order")
    let descending = false
    let nulls: "first" | "last" | undefined
    for (const modifier of pieces.slice(1)) {
      switch (modifier.toLowerCase()) {
        case "asc":
          descending = false
          break
        case "desc":
          descending = true
          break
        case "nullsfirst":
          nulls = "first"
          break
        case "nullslast":
          nulls = "last"
          break
        default:
          throw BunQLError.badRequest(
            `order term "${term}" has an unknown modifier "${modifier}"; expected asc, desc, ` +
              "nullsfirst or nullslast",
          )
      }
    }
    out.push(nulls === undefined ? { column, descending } : { column, descending, nulls })
  }
  return out
}

/**
 * The one place a request's column name is turned into a column. Everything downstream holds the
 * `ColumnInfo` this returned, so an unknown name cannot travel any further than here.
 */
export function resolveColumn(table: TableInfo, name: string, where: string): ColumnInfo {
  const column = columnOf(table, name)
  if (!column) {
    throw BunQLError.badRequest(
      `${where}: table ${table.name} has no column ${JSON.stringify(name)}`,
    )
  }
  return column
}

function parseCondition(table: TableInfo, key: string, raw: string): Condition {
  const column = resolveColumn(table, key, "filter")
  const dot = raw.indexOf(".")
  if (dot < 0) {
    throw BunQLError.badRequest(
      `filter on "${column.name}" must be written "<operator>.<value>", got ${JSON.stringify(raw)}`,
    )
  }
  const name = raw.slice(0, dot).toLowerCase()
  const rest = raw.slice(dot + 1)
  if (!OPERATORS.includes(name as Operator)) {
    throw BunQLError.badRequest(
      `filter on "${column.name}": unknown operator ${JSON.stringify(name)}; expected one of ` +
        OPERATORS.join(", "),
    )
  }
  const operator = name as Operator
  switch (operator) {
    case "is":
      return { column, operator, values: [], literal: parseIs(column, rest) }
    case "in":
      return { column, operator, values: parseIn(column, rest) }
    case "like":
    case "ilike":
      // A pattern is text whatever the column stores, so it is never coerced by affinity: on an
      // INTEGER column `like.1*` has to bind the string "1%", not the number 1.
      return { column, operator, values: [globToLike(rest)] }
    default:
      return { column, operator, values: [bindValue(column, rest)] }
  }
}

function parseIs(column: ColumnInfo, raw: string): IsLiteral {
  switch (raw.toLowerCase()) {
    case "null":
      return "NULL"
    case "not_null":
    case "notnull":
      return "NOT NULL"
    case "true":
      return "TRUE"
    case "false":
      return "FALSE"
    default:
      throw BunQLError.badRequest(
        `filter on "${column.name}": is.${raw} is not one of is.null, is.not_null, is.true, is.false`,
      )
  }
}

/**
 * `in.(1,2,3)`, and `in.1,2,3` without the parentheses. A member may be double-quoted when it
 * contains a comma, with `""` for a quote inside it — otherwise a comma in a value would be
 * unreachable through a URL.
 */
function parseIn(column: ColumnInfo, raw: string): DataValue[] {
  const body = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw
  const members = splitMembers(column, body)
  if (members.length === 0) {
    throw BunQLError.badRequest(`filter on "${column.name}": in.() names no values`)
  }
  return members.map((member) => bindValue(column, member))
}

interface Member {
  text: string
  /** A quoted member is kept even when it is empty: `in.("")` is the empty string. */
  quoted: boolean
}

function splitMembers(column: ColumnInfo, body: string): string[] {
  const out: Member[] = []
  let current: Member = { text: "", quoted: false }
  let inQuote = false
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string
    if (inQuote) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          current.text += '"'
          i++
        } else inQuote = false
      } else current.text += char
      continue
    }
    if (char === '"') {
      inQuote = true
      current.quoted = true
      continue
    }
    if (char === ",") {
      out.push(current)
      current = { text: "", quoted: false }
      continue
    }
    current.text += char
  }
  if (inQuote) {
    throw BunQLError.badRequest(
      `filter on "${column.name}": an in.() member is missing its closing quote`,
    )
  }
  out.push(current)
  return out.filter((member) => member.quoted || member.text.length > 0).map((member) => member.text)
}

/** PostgREST's `*` for SQL's `%`. A literal `%` or `_` is left alone, as PostgREST leaves it. */
function globToLike(pattern: string): string {
  return pattern.replaceAll("*", "%")
}

const INTEGER_TEXT = /^[+-]?\d+$/
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

/**
 * One URL string as the value its column stores. A SQLite integer is 64 bits, so an id past
 * 2^53 binds as a `bigint` rather than losing its last digits to a double.
 */
export function bindValue(column: ColumnInfo, raw: string): DataValue {
  switch (column.affinity) {
    case "INTEGER": {
      if (!INTEGER_TEXT.test(raw)) {
        throw BunQLError.badRequest(
          `column "${column.name}" holds integers; ${JSON.stringify(raw)} is not one`,
        )
      }
      const value = BigInt(raw)
      return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value
    }
    case "REAL": {
      const value = Number(raw)
      if (raw.trim().length === 0 || !Number.isFinite(value)) {
        throw BunQLError.badRequest(
          `column "${column.name}" holds numbers; ${JSON.stringify(raw)} is not one`,
        )
      }
      return value
    }
    case "TEXT":
      return raw
    case "BLOB":
      // A declared BLOB is bytes, and a URL has no honest spelling for them. A column declared
      // with no type at all has BLOB affinity too but converts nothing, so it is the one case
      // where the text has to be read the way JSON would read it or it will match nothing.
      if (column.declaredType.length > 0) {
        throw BunQLError.badRequest(
          `column "${column.name}" is a BLOB and can only be filtered with is.null or is.not_null`,
        )
      }
      return looseValue(raw)
    default:
      return looseValue(raw)
  }
}

/** NUMERIC, and a column declared with no type: an integer if it is one, a number if it is one, else text. */
function looseValue(raw: string): DataValue {
  if (INTEGER_TEXT.test(raw)) {
    const value = BigInt(raw)
    return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value
  }
  const asNumber = Number(raw)
  if (raw.trim().length > 0 && Number.isFinite(asNumber)) return asNumber
  return raw
}
