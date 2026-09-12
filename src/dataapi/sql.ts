// Invariant — and this is the security boundary of the whole data API:
//
//   **Every identifier in the generated SQL comes from introspection, and every value is a bound
//   parameter. There is no path by which a string from a request reaches the SQL text.**
//
// It is enforced by the shape of this module's input, not by care. `buildStatement` takes a
// `Command` holding `TableInfo` and `ColumnInfo` records — the very objects `PRAGMA table_list`
// and `PRAGMA table_xinfo` produced in `src/dataapi/introspect.ts` — and `DataValue`s. It takes
// no column name, no table name and no fragment of SQL. A request's `?select=`, `?order=` and
// filter keys are turned into `ColumnInfo`s by `src/dataapi/filter.ts`, which answers `400` for a
// name the table does not have; so a name that is not in the catalog cannot be represented in
// this module's argument type, let alone quoted into a statement.
//
// The only text this module writes is its own: `SELECT`, `FROM`, a comparison operator chosen
// from a fixed set, an `IS` literal chosen from a fixed set, `ASC`/`DESC`, and `?`. Names are
// quoted with `quote`, which doubles an embedded `"`, so a table named `we"ird` is addressable
// and a table named `users"; drop table users--` is still one identifier.
//
// Statements are schema-qualified as `"main"."t"`: readers are pooled and a temp table of the
// same name would otherwise shadow the one that was introspected.
//
// Reads are a single `SELECT`. Writes are a single `INSERT`/`UPDATE`/`DELETE … RETURNING`, so a
// write and the row it produced are one statement, one `exec.ts` call and one txid — never a
// write followed by a read that another transaction could slip between.

import { BunQLError } from "../server/errors.ts"
import type { DataStatement, DataValue } from "./context.ts"
import type { Condition, ListPlan, Operator } from "./filter.ts"
import type { ColumnInfo, TableInfo } from "./introspect.ts"

/** SQL for each operator. A fixed table: a request chooses a key, never the text. */
const COMPARISON: Readonly<Record<Exclude<Operator, "in" | "is">, string>> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  // SQLite's LIKE is already case-insensitive over ASCII, so `like` and `ilike` are the same
  // operator here. `docs/h4-dataapi.md` says so rather than this pretending otherwise.
  like: "LIKE",
  ilike: "LIKE",
}

export interface Assignment {
  column: ColumnInfo
  value: DataValue
}

export type Command =
  | { kind: "list"; table: TableInfo; plan: ListPlan }
  | { kind: "get"; table: TableInfo; select: ColumnInfo[]; key: Condition[] }
  | {
      kind: "insert"
      table: TableInfo
      /** Columns being written, in the order every row's values are given. */
      columns: ColumnInfo[]
      rows: DataValue[][]
      returning: ColumnInfo[]
    }
  | {
      kind: "update"
      table: TableInfo
      set: Assignment[]
      key: Condition[]
      returning: ColumnInfo[]
    }
  | { kind: "delete"; table: TableInfo; key: Condition[]; returning: ColumnInfo[] }

/** One identifier, quoted. The only way a name ever becomes SQL text. */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function qualified(table: TableInfo): string {
  return `"main".${quote(table.name)}`
}

function columnList(columns: readonly ColumnInfo[]): string {
  return columns.map((column) => quote(column.name)).join(", ")
}

/**
 * The choke point. A `Command` in, `{sql, args}` out; read the module header for why this is the
 * one place a reviewer has to be convinced of.
 */
export function buildStatement(command: Command): DataStatement {
  switch (command.kind) {
    case "list":
      return listStatement(command.table, command.plan)
    case "get":
      return getStatement(command.table, command.select, command.key)
    case "insert":
      return insertStatement(command.table, command.columns, command.rows, command.returning)
    case "update":
      return updateStatement(command.table, command.set, command.key, command.returning)
    case "delete":
      return deleteStatement(command.table, command.key, command.returning)
  }
}

function listStatement(table: TableInfo, plan: ListPlan): DataStatement {
  const args: DataValue[] = []
  let sql = `SELECT ${columnList(plan.select)} FROM ${qualified(table)}`
  sql += whereClause(plan.where, args)
  if (plan.order.length > 0) {
    const terms = plan.order.map((term) => {
      const nulls = term.nulls === undefined ? "" : term.nulls === "first" ? " NULLS FIRST" : " NULLS LAST"
      return `${quote(term.column.name)} ${term.descending ? "DESC" : "ASC"}${nulls}`
    })
    sql += ` ORDER BY ${terms.join(", ")}`
  }
  sql += " LIMIT ? OFFSET ?"
  args.push(plan.limit, plan.offset)
  return { sql, args }
}

function getStatement(table: TableInfo, select: ColumnInfo[], key: Condition[]): DataStatement {
  const args: DataValue[] = []
  const sql = `SELECT ${columnList(select)} FROM ${qualified(table)}${whereClause(key, args)} LIMIT 1`
  return { sql, args }
}

function insertStatement(
  table: TableInfo,
  columns: ColumnInfo[],
  rows: DataValue[][],
  returning: ColumnInfo[],
): DataStatement {
  if (rows.length === 0) throw BunQLError.badRequest("an insert needs at least one row")
  const into = qualified(table)
  const back = ` RETURNING ${columnList(returning)}`
  if (columns.length === 0) {
    if (rows.length > 1) {
      throw BunQLError.badRequest("a bulk insert of empty rows would be one row's defaults, repeated")
    }
    return { sql: `INSERT INTO ${into} DEFAULT VALUES${back}`, args: [] }
  }
  const placeholders = `(${columns.map(() => "?").join(", ")})`
  const args: DataValue[] = []
  for (const row of rows) args.push(...row)
  const sql =
    `INSERT INTO ${into} (${columnList(columns)}) VALUES ` +
    `${rows.map(() => placeholders).join(", ")}${back}`
  return { sql, args }
}

function updateStatement(
  table: TableInfo,
  set: Assignment[],
  key: Condition[],
  returning: ColumnInfo[],
): DataStatement {
  if (set.length === 0) throw BunQLError.badRequest("an update needs at least one column to set")
  const args: DataValue[] = []
  let sql = `UPDATE ${qualified(table)} SET `
  sql += set.map((one) => `${quote(one.column.name)} = ?`).join(", ")
  for (const one of set) args.push(one.value)
  sql += whereClause(key, args)
  sql += ` RETURNING ${columnList(returning)}`
  return { sql, args }
}

function deleteStatement(
  table: TableInfo,
  key: Condition[],
  returning: ColumnInfo[],
): DataStatement {
  const args: DataValue[] = []
  const sql =
    `DELETE FROM ${qualified(table)}${whereClause(key, args)} RETURNING ${columnList(returning)}`
  return { sql, args }
}

/** Appends every condition's parameters to `args` and returns the clause, or `""` for none. */
function whereClause(conditions: readonly Condition[], args: DataValue[]): string {
  if (conditions.length === 0) return ""
  const terms = conditions.map((condition) => {
    const name = quote(condition.column.name)
    if (condition.operator === "is") return `${name} IS ${condition.literal as string}`
    if (condition.operator === "in") {
      args.push(...condition.values)
      return `${name} IN (${condition.values.map(() => "?").join(", ")})`
    }
    args.push(condition.values[0] as DataValue)
    return `${name} ${COMPARISON[condition.operator] as string} ?`
  })
  return ` WHERE ${terms.join(" AND ")}`
}
