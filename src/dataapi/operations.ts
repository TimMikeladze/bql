// Invariant: this module produces a plain core `Registry` and nothing else. `src/http/` mounts
// it, `src/openapi/` describes it and `src/graphql/` is generated from that description, with no
// special case for the fact that these operations were generated rather than written by hand.
// One introspection, three surfaces (`docs/plan-surfaces.md`).
//
// Every handler does the same four things: turn the request into a `Command` over introspected
// columns, hand that `Command` to `buildStatement` — the choke point in `src/dataapi/sql.ts` —
// run the one statement it returns through `ctx.exec`, and shape the rows. No handler builds SQL,
// opens a database or steps a statement.
//
// Shapes worth knowing before reading the code:
//
//   * **A row component's properties are all optional**, because `?select=id,name` narrows the
//     row and a document declaring them required would be lying about its own responses.
//     Nullability *is* published faithfully, and an insert body keeps real `required`.
//   * **A single-row read, update or delete that matches nothing answers `200` with `null`**, not
//     a 404: `src/server/errors.ts` has no "no such row" code and inventing one here would be the
//     second error vocabulary `docs/plan-surfaces.md` forbids (`docs/h4-dataapi.md`).
//   * **A write answers with the row it wrote**, because every write statement carries `RETURNING`
//     and is therefore one statement, one `exec.ts` call and one txid.
//   * **Views are read-only**, and a table with neither a primary key nor a rowid gets the
//     collection routes and no `/{pk}` routes at all.

import {
  pathParameters,
  type Operation,
  type Props,
  Registry,
  type RegistryInfo,
  s,
  type Schema,
} from "../core/index.ts"
import { BunQLError } from "../server/errors.ts"
import { type DataApiContext, type DataValue, rowObjects } from "./context.ts"
import {
  bindValue,
  type Condition,
  OPERATORS,
  parseListQuery,
  parseSelect,
} from "./filter.ts"
import {
  columnOf,
  type ColumnInfo,
  schemaForColumn,
  type TableInfo,
  type TenantSchema,
} from "./introspect.ts"
import { nameTables, type NameOverride, type TableNames } from "./names.ts"
import { type Assignment, buildStatement } from "./sql.ts"

export interface DataApiOptions {
  /** Route prefix, in Bun.serve syntax. Default `/v1/db/:db/api`. */
  prefix?: string
  /** Rows a list returns when the request does not say. Default 100. */
  defaultLimit?: number
  /** The most a request may ask for; asking for more is a 400. Default 1000. */
  maxLimit?: number
  /** Leaves a table out of the API entirely — a hook for a per-token or per-config filter. */
  include?: (table: TableInfo) => boolean
  /** Overrides the singular/plural for a table whose English `src/dataapi/names.ts` gets wrong. */
  names?: Readonly<Record<string, NameOverride>>
  /** Merged over the generated registry title, version and description. */
  info?: Partial<RegistryInfo>
}

interface Limits {
  defaultLimit: number
  maxLimit: number
}

type Row = Record<string, unknown>
type Input = { path: Row; query: Row; headers: unknown; body: unknown }
type Generated = Operation<Input, unknown, DataApiContext>

const READ_ERRORS = [
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "NOT_AUTHORIZED",
  "DB_NOT_FOUND",
  "QUERY_TIMEOUT",
  "TOO_MANY_ROWS",
  "BUSY",
]

const WRITE_ERRORS = [
  ...READ_ERRORS,
  "PAYLOAD_TOO_LARGE",
  "NOT_PRIMARY",
  "QUOTA_EXCEEDED",
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_CHECK",
]

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A property map with no prototype. A column named `__proto__` would otherwise set the
 * prototype of an ordinary object literal instead of becoming a property of it.
 */
function emptyProps(): Props {
  return Object.create(null) as Props
}

/** One tenant's tables and views as core operations. */
export function dataApiRegistry(
  schema: TenantSchema,
  options: DataApiOptions = {},
): Registry<DataApiContext> {
  const prefix = trimSlash(options.prefix ?? "/v1/db/:db/api")
  const limits: Limits = {
    defaultLimit: options.defaultLimit ?? 100,
    maxLimit: options.maxLimit ?? 1000,
  }
  const tables = schema.tables.filter((table) => options.include?.(table) ?? true)
  const names = nameTables(tables, options.names)
  const registry = new Registry<DataApiContext>({
    title: `${schema.db} data API`,
    version: "1.0.0",
    description:
      `Generated from the tables of database ${schema.db}, at PRAGMA schema_version ` +
      `${schema.schemaVersion}. Filtering follows PostgREST's URL grammar.`,
    ...options.info,
  })
  for (const table of tables) {
    for (const operation of tableOperations(table, names.get(table.name) as TableNames, prefix, limits)) {
      registry.add(operation)
    }
  }
  return registry
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

interface KeyParam {
  column: ColumnInfo
  /** The `:param` this key column is bound by. */
  parameter: string
}

/**
 * A `:param` name per key column. A column name that is not a legal parameter name, or that the
 * prefix already binds, falls back to `pk1`, `pk2`, … — core refuses an operation whose path and
 * `params.path` disagree, so this has to be exact.
 */
function keyParameters(table: TableInfo, taken: readonly string[]): KeyParam[] {
  const used = new Set(taken)
  const out: KeyParam[] = []
  for (let i = 0; i < table.key.length; i++) {
    const column = columnOf(table, table.key[i] as string)
    if (!column) continue
    let parameter = IDENTIFIER.test(column.name) ? column.name : ""
    if (parameter === "" || used.has(parameter)) {
      let n = i + 1
      parameter = `pk${n}`
      while (used.has(parameter)) parameter = `pk${++n}`
    }
    used.add(parameter)
    out.push({ column, parameter })
  }
  return out
}

function tableOperations(
  table: TableInfo,
  names: TableNames,
  prefix: string,
  limits: Limits,
): Generated[] {
  const prefixParams = pathParameters(prefix)
  const collection = `${prefix}/${encodeURIComponent(table.name)}`
  const keys = keyParameters(table, prefixParams)
  const rowNode = rowSchema(table, names)
  const nullableRow = s.union([rowNode, s.null()])
  const writable = table.columns.filter((column) => column.writable)
  const what = table.kind === "view" ? "view" : "table"

  const assertDb = (ctx: DataApiContext, path: Row): void => {
    const asked = path.db
    if (typeof asked === "string" && asked !== ctx.db) {
      throw BunQLError.badRequest(
        `this API was generated for database ${ctx.db} and cannot serve ${JSON.stringify(asked)}`,
      )
    }
  }

  const keyConditions = (path: Row): Condition[] =>
    keys.map(({ column, parameter }) => ({
      column,
      operator: "eq" as const,
      values: [bindValue(column, String(path[parameter] ?? ""))],
    }))

  const operations: Generated[] = [
    {
      id: names.list,
      method: "get",
      path: collection,
      summary: `List rows of ${table.name}`,
      description:
        `Rows of the ${what} ${table.name}. Filter with PostgREST's URL grammar — ` +
        `?column=${OPERATORS.join("|")}.value — and narrow with select, order, limit and offset.`,
      tags: [table.name],
      security: "bearer",
      graphql: { kind: "query" },
      errors: READ_ERRORS,
      params: {
        path: pathSchema(prefixParams, []),
        query: listQuerySchema(table, limits),
      },
      response: { status: 200, schema: s.array(rowNode) },
      handler: async (input, ctx) => {
        assertDb(ctx, input.path)
        const plan = parseListQuery(table, input.query, limits)
        const result = await ctx.exec(buildStatement({ kind: "list", table, plan }))
        return rowObjects(result)
      },
    },
  ]

  if (keys.length > 0) {
    const rowPath = `${collection}${keys.map((key) => `/:${key.parameter}`).join("")}`
    operations.push({
      id: names.get,
      method: "get",
      path: rowPath,
      summary: `One row of ${table.name} by primary key`,
      description: `The row of ${table.name} whose key is ${keys
        .map((key) => key.column.name)
        .join(", ")}, or null when there is none.`,
      tags: [table.name],
      security: "bearer",
      graphql: { kind: "query" },
      errors: READ_ERRORS,
      params: {
        path: pathSchema(prefixParams, keys),
        query: s.object({ select: selectSchema(table) }),
      },
      response: { status: 200, schema: nullableRow },
      handler: async (input, ctx) => {
        assertDb(ctx, input.path)
        onlyKeys(input.query, ["select"])
        const select = parseSelect(table, input.query.select)
        const key = keyConditions(input.path)
        const result = await ctx.exec(buildStatement({ kind: "get", table, select, key }))
        return rowObjects(result)[0] ?? null
      },
    })
  }

  if (table.readOnly) return operations

  const insertNode = insertSchema(table, names, writable)
  operations.push({
    id: names.create,
    method: "post",
    path: collection,
    summary: `Insert into ${table.name}`,
    description:
      `One row, or an array of rows that all name the same columns. Answers with the rows as ` +
      `they were written, so a column SQLite filled in — a rowid, a DEFAULT, a generated ` +
      `column — comes back.`,
    tags: [table.name],
    security: "bearer",
    graphql: { kind: "mutation" },
    errors: WRITE_ERRORS,
    params: { path: pathSchema(prefixParams, []) },
    body: { schema: s.union([insertNode, s.array(insertNode)]), required: true },
    response: { status: 201, schema: s.array(rowNode) },
    handler: async (input, ctx) => {
      assertDb(ctx, input.path)
      const rows = (Array.isArray(input.body) ? input.body : [input.body]) as Row[]
      if (rows.length === 0) throw BunQLError.badRequest("an insert needs at least one row")
      const { columns, values } = insertMatrix(writable, rows)
      const result = await ctx.exec(
        buildStatement({ kind: "insert", table, columns, rows: values, returning: table.columns }),
      )
      return rowObjects(result)
    },
  })

  if (keys.length === 0) return operations
  const rowPath = `${collection}${keys.map((key) => `/:${key.parameter}`).join("")}`

  operations.push({
    id: names.update,
    method: "patch",
    path: rowPath,
    summary: `Update one row of ${table.name}`,
    description:
      `Sets the columns the body names and leaves the rest alone. Answers with the row as it is ` +
      `now, or null when the key matched nothing.`,
    tags: [table.name],
    security: "bearer",
    graphql: { kind: "mutation" },
    errors: WRITE_ERRORS,
    params: { path: pathSchema(prefixParams, keys) },
    body: { schema: patchSchema(table, names, writable), required: true },
    response: { status: 200, schema: nullableRow },
    handler: async (input, ctx) => {
      assertDb(ctx, input.path)
      const patch = (input.body ?? {}) as Row
      const set: Assignment[] = []
      for (const column of writable) {
        if (Object.hasOwn(patch, column.name)) {
          set.push({ column, value: patch[column.name] as DataValue })
        }
      }
      if (set.length === 0) throw BunQLError.badRequest("the body set no columns")
      const result = await ctx.exec(
        buildStatement({
          kind: "update",
          table,
          set,
          key: keyConditions(input.path),
          returning: table.columns,
        }),
      )
      return rowObjects(result)[0] ?? null
    },
  })

  operations.push({
    id: names.delete,
    method: "delete",
    path: rowPath,
    summary: `Delete one row of ${table.name}`,
    description: "Answers with the row that was deleted, or null when the key matched nothing.",
    tags: [table.name],
    security: "bearer",
    graphql: { kind: "mutation" },
    errors: WRITE_ERRORS,
    params: { path: pathSchema(prefixParams, keys) },
    response: { status: 200, schema: nullableRow },
    handler: async (input, ctx) => {
      assertDb(ctx, input.path)
      const result = await ctx.exec(
        buildStatement({
          kind: "delete",
          table,
          key: keyConditions(input.path),
          returning: table.columns,
        }),
      )
      return rowObjects(result)[0] ?? null
    },
  })

  return operations
}

/**
 * Columns and one value array per row. Every row of a bulk insert has to name the same columns:
 * SQLite's multi-row `VALUES` takes one column list, and a row silently filled with NULL where
 * another row named a column would be a different write from the one that was asked for.
 */
function insertMatrix(
  writable: readonly ColumnInfo[],
  rows: readonly Row[],
): { columns: ColumnInfo[]; values: DataValue[][] } {
  const named = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) named.add(key)
  const columns = writable.filter((column) => named.has(column.name))
  const values = rows.map((row, index) =>
    columns.map((column) => {
      if (!Object.hasOwn(row, column.name)) {
        throw BunQLError.badRequest(
          `row ${index} does not set "${column.name}", which another row of the same insert does; ` +
            "every row of a bulk insert must name the same columns",
        )
      }
      return row[column.name] as DataValue
    }),
  )
  return { columns, values }
}

/** A query carrying a key this operation does not declare is a mistake worth reporting. */
function onlyKeys(query: Row, allowed: readonly string[]): void {
  for (const key of Object.keys(query)) {
    if (query[key] === undefined || allowed.includes(key)) continue
    throw BunQLError.badRequest(`unknown query parameter ${JSON.stringify(key)}`)
  }
}

// ── schemas ────────────────────────────────────────────────────────────────────────────────────

function pathSchema(prefixParams: readonly string[], keys: readonly KeyParam[]): Schema {
  const props = emptyProps()
  for (const name of prefixParams) {
    props[name] = s.string().describe(name === "db" ? "The database name." : `Path parameter ${name}.`)
  }
  for (const key of keys) {
    props[key.parameter] = s
      .string()
      .describe(`Primary key column "${key.column.name}" (${key.column.declaredType || "no type"}).`)
  }
  return s.object(props)
}

function selectSchema(table: TableInfo) {
  return s
    .string()
    .optional()
    .describe(
      `Comma-separated columns to return, out of ${table.columns
        .map((column) => column.name)
        .join(", ")}. A name this table does not have is a 400.`,
    )
}

function listQuerySchema(table: TableInfo, limits: Limits): Schema {
  const props = emptyProps()
  for (const column of table.columns) {
    props[column.name] = s
      .string()
      .optional()
      .describe(
        `Filter on ${column.name}: one of ${OPERATORS.join(", ")} and a value, as ` +
          `"gt.10" or "like.ann*".`,
      )
  }
  // The grammar's own keys are written last, so a column that happens to share one of these names
  // cannot be filtered — `docs/h4-dataapi.md` says so.
  props.select = selectSchema(table)
  props.order = s
    .string()
    .optional()
    .describe('Comma-separated order terms, as "name.asc" or "created_at.desc.nullslast".')
  props.limit = s
    .int()
    .min(1)
    .max(limits.maxLimit)
    .default(limits.defaultLimit)
    .describe(`Rows to return, at most ${limits.maxLimit}.`)
  props.offset = s.int().min(0).default(0).describe("Rows to skip.")
  return s.object(props)
}

/**
 * The row component. Every property is optional because `?select=` narrows the row; a property is
 * `.nullable()` exactly when the column can read back NULL.
 */
function rowSchema(table: TableInfo, names: TableNames): Schema {
  const props = emptyProps()
  for (const column of table.columns) {
    props[column.name] = schemaForColumn(column).optional().describe(describeColumn(column))
  }
  return s
    .object(props)
    .describe(`One row of ${table.name}. A property is absent when select= left it out.`)
    .id(names.row)
}

function insertSchema(table: TableInfo, names: TableNames, writable: readonly ColumnInfo[]): Schema {
  const props = emptyProps()
  for (const column of writable) {
    const node = schemaForColumn(column).describe(describeColumn(column))
    props[column.name] = column.optionalOnInsert ? node.optional() : node
  }
  return s
    .object(props)
    .strict()
    .describe(`A new row of ${table.name}.`)
    .id(names.insert)
}

function patchSchema(table: TableInfo, names: TableNames, writable: readonly ColumnInfo[]): Schema {
  const props = emptyProps()
  for (const column of writable) {
    props[column.name] = schemaForColumn(column).optional().describe(describeColumn(column))
  }
  return s
    .object(props)
    .strict()
    .describe(`Columns of ${table.name} to change. Anything left out is left alone.`)
    .id(names.patch)
}

function describeColumn(column: ColumnInfo): string {
  const parts: string[] = [column.declaredType.length > 0 ? column.declaredType : "no declared type"]
  parts.push(`${column.affinity} affinity`)
  if (column.synthetic) parts.push("the table's rowid, which this API addresses rows by")
  else if (column.rowidAlias) parts.push("INTEGER PRIMARY KEY: SQLite fills it in")
  else if (column.pkPosition > 0) parts.push(`primary key column ${column.pkPosition}`)
  if (column.generated) parts.push("generated, so it is read-only")
  if (column.defaultExpression !== null) parts.push(`default ${column.defaultExpression}`)
  if (column.notNull) parts.push("NOT NULL")
  return parts.join("; ")
}
