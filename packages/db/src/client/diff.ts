// X2: what changed between two databases — usually a branch and the database it was forked from
// (`docs/x2-branching.md`). Schema first: tables, columns, indexes, triggers, views; then a row
// count per table, which is the cheapest honest answer to "did the data move".
//
// Invariant: read-only SQL through anything with `execute` — `client.db()`, the embedded
// `bq.db()`, a Hrana-backed handle — so the one function works in every mode and never needs a
// route of its own. Five statements a side (seven when a virtual table exists), whatever the table
// count, except the row counts, which are one `union all` per 400 tables (SQLite's compound-select
// ceiling is 500).

import { VIRTUAL_TABLES_SQL, shadowVerdict, virtualTables } from "../sqlite/shadow.ts"

/** Anything that runs a statement and resolves to rows as objects. `Db` is one. */
export interface SchemaSource {
  execute(sql: string): PromiseLike<readonly Record<string, unknown>[]>
}

export interface ColumnInfo {
  name: string
  /** The declared type as written, upper-cased; `""` for none. */
  type: string
  notNull: boolean
  /** The default expression as SQLite stores it, or null. */
  default: string | null
  /** Position in the primary key, 1-based; 0 when the column is not part of it. */
  pk: number
  /** Non-zero for a generated column (`pragma table_xinfo`'s `hidden`). */
  hidden: number
}

export interface TableInfo {
  name: string
  /** `CREATE VIRTUAL TABLE` — FTS5, vec0, R*Tree. Their shadow tables are left out. */
  virtual: boolean
  /** The `CREATE` statement, whitespace-normalised. */
  sql: string
  columns: ColumnInfo[]
  /** `count(*)`, or null when row counts were not asked for. */
  rows: number | null
}

export interface IndexInfo {
  name: string
  table: string
  unique: boolean
  partial: boolean
  /** Key columns in order; an expression column reads `<expr>`, a descending one ends ` desc`. */
  columns: string[]
  sql: string
}

export interface TriggerInfo {
  name: string
  table: string
  sql: string
}

export interface ViewInfo {
  name: string
  sql: string
}

/** One side of a diff: everything `diffSchema` read, by name. */
export interface SchemaSnapshot {
  tables: Map<string, TableInfo>
  indexes: Map<string, IndexInfo>
  triggers: Map<string, TriggerInfo>
  views: Map<string, ViewInfo>
}

export interface ColumnChange {
  name: string
  before: ColumnInfo
  after: ColumnInfo
  /** Which of `type`, `notNull`, `default`, `pk`, `hidden` differ. */
  fields: (keyof Omit<ColumnInfo, "name">)[]
}

export interface TableChange {
  name: string
  columns: { added: ColumnInfo[]; removed: ColumnInfo[]; changed: ColumnChange[] }
  /**
   * The `CREATE` statement differs although no column does — a constraint, `STRICT`, `WITHOUT
   * ROWID`, a check. Also true alongside column changes when the text differs.
   */
  definitionChanged: boolean
  before: TableInfo
  after: TableInfo
}

export interface ObjectDiff<T> {
  added: T[]
  removed: T[]
  changed: { name: string; before: T; after: T }[]
}

export interface RowCount {
  table: string
  /** Rows on the `a` side, or null when the table is not there. */
  a: number | null
  b: number | null
}

export interface SchemaDiff {
  /** No schema difference and no row-count difference. */
  identical: boolean
  /** No schema difference; row counts may still differ. */
  sameSchema: boolean
  tables: { added: TableInfo[]; removed: TableInfo[]; changed: TableChange[] }
  indexes: ObjectDiff<IndexInfo>
  triggers: ObjectDiff<TriggerInfo>
  views: ObjectDiff<ViewInfo>
  /** Every table on either side, by name, with its count on each. Empty with `rows: false`. */
  rows: RowCount[]
}

export interface DiffOptions {
  /** Count the rows of every table. Default true; it is a full scan of each. */
  rows?: boolean
}

// ── reading ────────────────────────────────────────────────────────────────────────────────────

const USER = "name not like 'sqlite_%'"

/** Whitespace-normalised, so a statement reformatted by nothing but `ALTER` still compares. */
function normalise(sql: unknown): string {
  return typeof sql === "string" ? sql.replace(/\s+/g, " ").trim() : ""
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function quoteText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function rowsOf(source: SchemaSource, sql: string): Promise<Record<string, unknown>[]> {
  return [...(await source.execute(sql))]
}

/**
 * Shadow tables of FTS5, vec0 and R*Tree, which are the virtual table's storage rather than
 * schema anyone wrote. `src/sqlite/shadow.ts` decides for the modules it understands — by what
 * the module created for each table's options, which catches vec0's `_vector_chunksNN` and keeps a
 * real `docs_fts_content` beside an external-content `docs_fts` — and `pragma_table_list`'s
 * name-based `type = 'shadow'` (SQLite 3.37+) only for modules it does not.
 */
async function shadowTables(source: SchemaSource): Promise<Set<string>> {
  const out = new Set<string>()
  const vtabs = virtualTables(await rowsOf(source, VIRTUAL_TABLES_SQL))
  if (vtabs.size === 0) return out
  let flagged = new Set<string>()
  try {
    const rows = await rowsOf(
      source,
      "select name from pragma_table_list where schema = 'main' and type = 'shadow'",
    )
    flagged = new Set(rows.map((row) => String(row.name)))
  } catch {
    // Before 3.37 there is no `pragma_table_list`; the module rules are all there is.
  }
  for (const row of await rowsOf(source, "select name from sqlite_schema where type = 'table'")) {
    const name = String(row.name)
    const verdict = shadowVerdict(name, vtabs)
    if (verdict === true || (verdict === null && flagged.has(name))) out.add(name)
  }
  return out
}

/** Reads one side. Exported so a caller can snapshot once and compare it against several. */
export async function readSchema(
  source: SchemaSource,
  options: DiffOptions = {},
): Promise<SchemaSnapshot> {
  const shadows = await shadowTables(source)
  const objects = await rowsOf(
    source,
    `select type, name, tbl_name, sql from sqlite_schema where ${USER} order by name`,
  )
  const columns = await rowsOf(
    source,
    `select m.name as tbl, c.name, c.type, c."notnull" as nn, c.dflt_value as dflt, c.pk,
            c.hidden
       from sqlite_schema m join pragma_table_xinfo(m.name) c
      where m.type = 'table' and m.${USER}
      order by m.name, c.cid`,
  )
  // Only the indexes someone created (`origin = 'c'`): a primary key or `UNIQUE` constraint's
  // automatic index is already visible as the column or the table definition that implies it.
  const indexKeys = await rowsOf(
    source,
    `select il.name as idx, m.name as tbl, il."unique" as uniq, il.partial, ii.name as col,
            ii."desc" as descending
       from sqlite_schema m join pragma_index_list(m.name) il join pragma_index_xinfo(il.name) ii
      where m.type = 'table' and m.${USER} and il.origin = 'c' and ii.key = 1
      order by il.name, ii.seqno`,
  )

  const snapshot: SchemaSnapshot = {
    tables: new Map(),
    indexes: new Map(),
    triggers: new Map(),
    views: new Map(),
  }
  for (const row of objects) {
    const name = String(row.name)
    const sql = normalise(row.sql)
    switch (row.type) {
      case "table":
        if (shadows.has(name)) break
        snapshot.tables.set(name, {
          name,
          virtual: /^create virtual table/i.test(sql),
          sql,
          columns: [],
          rows: null,
        })
        break
      case "index":
        // Filled from the key columns below; an index with no `sql` is an automatic one.
        if (row.sql !== null) {
          snapshot.indexes.set(name, {
            name,
            table: String(row.tbl_name),
            unique: false,
            partial: false,
            columns: [],
            sql,
          })
        }
        break
      case "trigger":
        snapshot.triggers.set(name, { name, table: String(row.tbl_name), sql })
        break
      case "view":
        snapshot.views.set(name, { name, sql })
        break
    }
  }
  for (const row of columns) {
    const table = snapshot.tables.get(String(row.tbl))
    if (!table) continue
    table.columns.push({
      name: String(row.name),
      type: String(row.type ?? "").toUpperCase(),
      notNull: Number(row.nn) !== 0,
      default: row.dflt === null || row.dflt === undefined ? null : String(row.dflt),
      pk: Number(row.pk),
      hidden: Number(row.hidden),
    })
  }
  for (const row of indexKeys) {
    const index = snapshot.indexes.get(String(row.idx))
    if (!index) continue
    index.unique = Number(row.uniq) !== 0
    index.partial = Number(row.partial) !== 0
    const column = row.col === null ? "<expr>" : String(row.col)
    index.columns.push(Number(row.descending) !== 0 ? `${column} desc` : column)
  }

  if (options.rows !== false) {
    const names = [...snapshot.tables.keys()]
    for (let at = 0; at < names.length; at += 400) {
      const chunk = names.slice(at, at + 400)
      const sql = chunk
        .map((name) => `select ${quoteText(name)} as t, count(*) as n from ${quoteIdent(name)}`)
        .join(" union all ")
      for (const row of await rowsOf(source, sql)) {
        const table = snapshot.tables.get(String(row.t))
        if (table) table.rows = Number(row.n)
      }
    }
  }
  return snapshot
}

// ── comparing ──────────────────────────────────────────────────────────────────────────────────

const COLUMN_FIELDS = ["type", "notNull", "default", "pk", "hidden"] as const

function compareMaps<T>(
  a: Map<string, T>,
  b: Map<string, T>,
  same: (x: T, y: T) => boolean,
): ObjectDiff<T> {
  const diff: ObjectDiff<T> = { added: [], removed: [], changed: [] }
  for (const [name, before] of a) {
    const after = b.get(name)
    if (after === undefined) diff.removed.push(before)
    else if (!same(before, after)) diff.changed.push({ name, before, after })
  }
  for (const [name, after] of b) if (!a.has(name)) diff.added.push(after)
  return diff
}

function compareTable(before: TableInfo, after: TableInfo): TableChange | null {
  const old = new Map(before.columns.map((column) => [column.name, column]))
  const now = new Map(after.columns.map((column) => [column.name, column]))
  const columns: TableChange["columns"] = { added: [], removed: [], changed: [] }
  for (const [name, column] of old) {
    const next = now.get(name)
    if (!next) {
      columns.removed.push(column)
      continue
    }
    const fields = COLUMN_FIELDS.filter((field) => column[field] !== next[field])
    if (fields.length > 0) columns.changed.push({ name, before: column, after: next, fields })
  }
  for (const [name, column] of now) if (!old.has(name)) columns.added.push(column)
  const definitionChanged = before.sql !== after.sql
  const columnsChanged =
    columns.added.length + columns.removed.length + columns.changed.length > 0
  if (!columnsChanged && !definitionChanged) return null
  return { name: before.name, columns, definitionChanged, before, after }
}

/** Compares two snapshots `a → b`: "added" is in `b` and not in `a`. */
export function compareSchemas(a: SchemaSnapshot, b: SchemaSnapshot): SchemaDiff {
  const tables: SchemaDiff["tables"] = { added: [], removed: [], changed: [] }
  for (const [name, before] of a.tables) {
    const after = b.tables.get(name)
    if (!after) {
      tables.removed.push(before)
      continue
    }
    const change = compareTable(before, after)
    if (change) tables.changed.push(change)
  }
  for (const [name, after] of b.tables) if (!a.tables.has(name)) tables.added.push(after)

  const indexes = compareMaps(
    a.indexes,
    b.indexes,
    (x, y) => x.sql === y.sql && x.table === y.table && x.columns.join() === y.columns.join(),
  )
  const triggers = compareMaps(a.triggers, b.triggers, (x, y) => x.sql === y.sql)
  const views = compareMaps(a.views, b.views, (x, y) => x.sql === y.sql)

  const names = [...new Set([...a.tables.keys(), ...b.tables.keys()])].sort()
  const counted = [...a.tables.values(), ...b.tables.values()].some((table) => table.rows !== null)
  const rows: RowCount[] = counted
    ? names.map((table) => ({
        table,
        a: a.tables.get(table)?.rows ?? null,
        b: b.tables.get(table)?.rows ?? null,
      }))
    : []

  const empty = (diff: { added: unknown[]; removed: unknown[]; changed: unknown[] }) =>
    diff.added.length + diff.removed.length + diff.changed.length === 0
  const sameSchema = empty(tables) && empty(indexes) && empty(triggers) && empty(views)
  return {
    identical: sameSchema && rows.every((row) => row.a === row.b),
    sameSchema,
    tables,
    indexes,
    triggers,
    views,
    rows,
  }
}

/**
 * What changed from `a` to `b`: tables, columns (type, not null, default, primary key), indexes,
 * triggers and views, plus each table's row count on both sides. Read-only on both.
 *
 * ```ts
 * const diff = await diffSchema(client.db("main"), client.db("pr-42"))
 * if (!diff.sameSchema) console.log(formatSchemaDiff(diff, { a: "main", b: "pr-42" }))
 * ```
 */
export async function diffSchema(
  a: SchemaSource,
  b: SchemaSource,
  options: DiffOptions = {},
): Promise<SchemaDiff> {
  const [left, right] = await Promise.all([readSchema(a, options), readSchema(b, options)])
  return compareSchemas(left, right)
}

// ── rendering ──────────────────────────────────────────────────────────────────────────────────

function describeColumn(column: ColumnInfo): string {
  const parts = [column.name]
  if (column.type) parts.push(column.type)
  if (column.pk > 0) parts.push("PRIMARY KEY")
  if (column.notNull) parts.push("NOT NULL")
  if (column.default !== null) parts.push(`DEFAULT ${column.default}`)
  if (column.hidden !== 0) parts.push("GENERATED")
  return parts.join(" ")
}

function describeIndex(index: IndexInfo): string {
  const flags = `${index.unique ? " unique" : ""}${index.partial ? " partial" : ""}`
  return `${index.name} on ${index.table}(${index.columns.join(", ")})${flags}`
}

function show(value: unknown): string {
  return value === null ? "null" : String(value)
}

/**
 * The text `bql db diff` prints: one line per difference, `+` for only in `b`, `-` for only in
 * `a`, `~` for in both but different. `"no differences"` when there are none.
 */
export function formatSchemaDiff(diff: SchemaDiff, labels: { a?: string; b?: string } = {}): string {
  const lines: string[] = [`--- ${labels.a ?? "a"}`, `+++ ${labels.b ?? "b"}`]
  if (diff.identical) return [...lines, "no differences"].join("\n")

  const { tables } = diff
  if (tables.added.length + tables.removed.length + tables.changed.length > 0) {
    lines.push("tables")
    for (const table of tables.added) {
      // A virtual table's hidden columns (FTS5's own name and `rank`) are not columns anyone wrote.
      const n = table.columns.filter((column) => column.hidden !== 1).length
      const count = `${n} column${n === 1 ? "" : "s"}`
      lines.push(`  + ${table.name} (${count}${table.virtual ? ", virtual" : ""})`)
    }
    for (const table of tables.removed) lines.push(`  - ${table.name}`)
    for (const change of tables.changed) {
      lines.push(`  ~ ${change.name}`)
      for (const column of change.columns.added) lines.push(`      + ${describeColumn(column)}`)
      for (const column of change.columns.removed) lines.push(`      - ${column.name}`)
      for (const column of change.columns.changed) {
        const fields = column.fields
          .map((field) => `${field} ${show(column.before[field])} → ${show(column.after[field])}`)
          .join(", ")
        lines.push(`      ~ ${column.name}: ${fields}`)
      }
      const columnsMoved =
        change.columns.added.length + change.columns.removed.length + change.columns.changed.length
      if (change.definitionChanged && columnsMoved === 0) lines.push("      ~ definition")
    }
  }
  const section = <T>(title: string, part: ObjectDiff<T>, describe: (item: T) => string) => {
    if (part.added.length + part.removed.length + part.changed.length === 0) return
    lines.push(title)
    for (const item of part.added) lines.push(`  + ${describe(item)}`)
    for (const item of part.removed) lines.push(`  - ${describe(item)}`)
    for (const item of part.changed) lines.push(`  ~ ${describe(item.after)}`)
  }
  section("indexes", diff.indexes, describeIndex)
  section("triggers", diff.triggers, (item) => `${item.name} on ${item.table}`)
  section("views", diff.views, (item) => item.name)
  const moved = diff.rows.filter((row) => row.a !== row.b)
  if (moved.length > 0) {
    lines.push("rows")
    const width = Math.max(...moved.map((row) => row.table.length))
    for (const row of moved) {
      const delta =
        row.a !== null && row.b !== null
          ? ` (${row.b - row.a >= 0 ? "+" : ""}${row.b - row.a})`
          : ""
      lines.push(`  ${row.table.padEnd(width)}  ${show(row.a)} → ${show(row.b)}${delta}`)
    }
  }
  return lines.join("\n")
}
