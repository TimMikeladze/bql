// Invariant: every table name, column name and declared type in a `TenantSchema` came out of
// SQLite's own catalog — `PRAGMA table_list`, `table_xinfo`, `foreign_key_list`, `index_list`,
// `index_info` — and never out of a request, a config file or a guess. That is what makes the
// schema safe to build SQL identifiers from: `src/dataapi/sql.ts` quotes names from *this*
// structure and nothing else, and a name a request supplies is only ever looked up in it.
//
// **Types are keyed on affinity, not on the declared type.** SQLite's declared types are
// advisory: `CREATE TABLE t(a VARCHAR(9), b UNSIGNED BIG INT)` makes a TEXT-affinity column and
// an INTEGER-affinity one, and matching type *names* would call both of them strings. So the
// five rules of SQLite's own "determination of column affinity" are applied to the declared text
// (INT -> INTEGER, CHAR/CLOB/TEXT -> TEXT, BLOB or blank -> BLOB, REAL/FLOA/DOUB -> REAL,
// otherwise NUMERIC) and the core schema follows the affinity.
//
// An INTEGER column is `s.int64()` and never `s.int()`: a SQLite integer is 64 bits, and
// narrowing it to a JSON number is exactly the silent precision loss design §6.1 names in rqlite
// and D1.
//
// Nothing here opens a database or prepares a statement. An `Execute` — supplied by the caller,
// and in the server's case a closure over `src/server/exec.ts` — runs every statement, so
// introspection inherits the same deadline, row cap and accounting as any other read.
//
// Introspection must be run with the *server's* rights, not the caller's: the result is cached
// per database and shared between callers, so a schema read under one token's table ACL would be
// served to the next caller as if it were the whole database. Per-request authority is enforced
// where it belongs — on the data statements themselves, by SQLite's authorizer inside `exec.ts`.
// Two of the pragmas below need that anyway: `src/server/auth.ts` allows `table_list`,
// `table_info`, `index_list` and `foreign_key_list` to a token and denies `table_xinfo` and
// `index_info`.

import { codecOf, type Schema, s } from "../core/index.ts"
import { type DataStatement, type DataValue, type Execute, rowObjects } from "./context.ts"
import { VIRTUAL_TABLES_SQL, shadowVerdict, virtualTables } from "../sqlite/shadow.ts"

/** SQLite's five type affinities. */
export type Affinity = "INTEGER" | "TEXT" | "BLOB" | "REAL" | "NUMERIC"

export interface ColumnInfo {
  name: string
  /** The type exactly as the DDL declared it; `""` for a column declared without one. */
  declaredType: string
  affinity: Affinity
  notNull: boolean
  /** The default expression as SQLite reports it, or null when the column has none. */
  defaultExpression: string | null
  /** Position in the primary key, 1-based, or 0 for a column that is not part of it. */
  pkPosition: number
  /** A GENERATED ALWAYS AS column: readable, never writable. */
  generated: boolean
  /** `INTEGER PRIMARY KEY` on a rowid table, which SQLite fills in when it is omitted. */
  rowidAlias: boolean
  /** The synthetic `rowid` key of a rowid table that declared no primary key. */
  synthetic: boolean
  /** Whether a NULL can be read out of this column. */
  nullable: boolean
  /** False for a generated or synthetic column, and for every column of a view. */
  writable: boolean
  /** May be left out of an insert: nullable, defaulted, or the rowid alias. */
  optionalOnInsert: boolean
}

export interface ForeignKeyInfo {
  /** Columns of this table, in key order. */
  columns: string[]
  /** The table referenced. */
  table: string
  /** Columns of the referenced table; empty when the DDL named none (its primary key). */
  references: string[]
  onUpdate: string
  onDelete: string
}

export interface IndexInfo {
  name: string
  unique: boolean
  partial: boolean
  /** `"c"` for CREATE INDEX, `"u"` for a UNIQUE constraint, `"pk"` for the primary key. */
  origin: string
  /** Indexed columns, in index order. An expression term is left out. */
  columns: string[]
}

export interface TableInfo {
  name: string
  kind: "table" | "view"
  withoutRowid: boolean
  strict: boolean
  columns: ColumnInfo[]
  /** Columns addressing one row, in key order. Empty when no row can be addressed. */
  key: string[]
  /** A view, which the data API never writes through. */
  readOnly: boolean
  foreignKeys: ForeignKeyInfo[]
  indexes: IndexInfo[]
}

export interface TenantSchema {
  /** The database this was read from. */
  db: string
  /** `PRAGMA schema_version` when it was read. The cache key: any DDL moves it. */
  schemaVersion: number
  /** Sorted by name, so generated operation ids are stable across restarts. */
  tables: TableInfo[]
}

export interface IntrospectOptions {
  /**
   * Leaves a table or view out of the schema entirely. SQLite's own objects (`sqlite_%`), shadow
   * tables, virtual tables and anything outside the `main` schema are already skipped.
   */
  skip?: (name: string, kind: "table" | "view") => boolean
}

/** A column of a `TenantSchema` by name, case-insensitively as SQLite compares identifiers. */
export function columnOf(table: TableInfo, name: string): ColumnInfo | undefined {
  const wanted = name.toLowerCase()
  return table.columns.find((column) => column.name.toLowerCase() === wanted)
}

export function tableOf(schema: TenantSchema, name: string): TableInfo | undefined {
  const wanted = name.toLowerCase()
  return schema.tables.find((table) => table.name.toLowerCase() === wanted)
}

/**
 * SQLite's "determination of column affinity", rule for rule and in its order. The declared type
 * is a free-text string — SQLite never rejects one — so this is a substring test, not a lookup.
 */
export function affinityOf(declaredType: string): Affinity {
  const type = declaredType.toUpperCase()
  if (type.includes("INT")) return "INTEGER"
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "TEXT"
  if (type.includes("BLOB") || type.length === 0) return "BLOB"
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "REAL"
  return "NUMERIC"
}

/** A double JSON cannot hold, as `src/server/json.ts` writes it. */
const FLOAT_TAG = s.object({ $f: s.enum(["inf", "-inf", "nan"]) }).strict()

/**
 * The core schema for one column, from its affinity. A nullable column is widened with
 * `.nullable()`, or with an explicit null branch where the node carries a codec.
 *
 * A blank declared type has BLOB affinity, which in SQLite means *no* affinity: nothing is
 * converted on the way in, so the column may hold any of the five storage classes and the only
 * honest schema is `s.sqliteValue()`. A column declared BLOB really is bytes.
 *
 * REAL publishes the union of a JSON number and `{"$f": "inf"}` because that is what the wire
 * carries for a non-finite double. Publishing a bare `number` would be a document that lies about
 * its own responses for the one value that cannot be written as JSON.
 */
export function schemaForColumn(column: ColumnInfo): ColumnSchema {
  const base = baseSchema(column)
  if (!column.nullable) return base
  // `.nullable()` widens a node's `type`, and core's validator reads the CODEC mark *before* the
  // type list — so `s.int64().nullable()` still refuses a null, and a nullable INTEGER column
  // would fail its own response schema on every NULL it read. A union puts the null in a branch
  // of its own, which the codec node never has to answer for. `s.sqliteValue()` already carries a
  // null branch and decodes one, so it only needs the ordinary widening. See the findings in
  // `docs/h4-dataapi.md`.
  const codec = codecOf(base)
  const nulled = codec === "int64" || codec === "blob" ? s.union([base, s.null()]) : base.nullable()
  return nulled as ColumnSchema
}

/**
 * The builder methods a generated column schema is chained with. Every one of core's builders has
 * them; their return types differ, so they meet at this one.
 */
export interface ColumnSchema extends Schema {
  nullable(): ColumnSchema
  optional(): ColumnSchema
  describe(text: string): ColumnSchema
}

function baseSchema(column: ColumnInfo): ColumnSchema {
  switch (column.affinity) {
    case "INTEGER":
      return s.int64() as ColumnSchema
    case "TEXT":
      return s.string() as ColumnSchema
    case "REAL":
      return s.union([s.number(), FLOAT_TAG]) as ColumnSchema
    case "BLOB":
      return (column.declaredType.length === 0 ? s.sqliteValue() : s.blob()) as ColumnSchema
    default:
      // NUMERIC stores an integer, a real or the original text, whichever the value fits.
      return s.sqliteValue() as ColumnSchema
  }
}

// ── reading the catalog ────────────────────────────────────────────────────────────────────────

/** `PRAGMA` arguments cannot be bound, so the one name that reaches SQL text is quoted here. */
function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value)
}

function flag(value: unknown): boolean {
  return value === 1 || value === true || value === "1"
}

function integer(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") return Number(value)
  if (value !== null && typeof value === "object" && typeof (value as { $i?: string }).$i === "string") {
    return Number((value as { $i: string }).$i)
  }
  return 0
}

const ROWID_ALIASES = ["rowid", "_rowid_", "oid"] as const

/**
 * One database's tables and views as a `TenantSchema`.
 *
 * `db` is carried through only so the schema can say what it describes; nothing here resolves it.
 * `exec` runs every statement, and must carry the server's own rights — see the module header.
 */
export async function introspect(
  db: string,
  exec: Execute,
  options: IntrospectOptions = {},
): Promise<TenantSchema> {
  const run = async (sql: string, args: readonly DataValue[] = []): Promise<Record<string, unknown>[]> =>
    rowObjects(await exec({ sql, args } satisfies DataStatement))

  const version = await run("PRAGMA schema_version")
  const schemaVersion = integer(version[0]?.schema_version)

  const listed = await run("PRAGMA table_list")
  // `table_list` already calls most shadow tables `shadow`, but only as far as each module's
  // `xShadowName` goes — sqlite-vec's misses `_vector_chunksNN` (src/sqlite/shadow.ts).
  const vtabs = virtualTables(await run(VIRTUAL_TABLES_SQL))
  const tables: TableInfo[] = []
  for (const entry of listed) {
    const name = text(entry.name)
    const kindText = text(entry.type)
    if (text(entry.schema) !== "main") continue
    // Shadow and virtual tables are a module's own interface, not a set of rows: an INSERT into
    // an FTS5 table means something this API has no way to describe. `table_list`'s `shadow` is
    // name-based, though, so for the modules `shadow.ts` understands its verdict wins — both ways.
    if (name.toLowerCase().startsWith("sqlite_")) continue
    const verdict = vtabs.size > 0 && kindText !== "view" ? shadowVerdict(name, vtabs) : null
    if (verdict === true) continue
    const listed = kindText === "table" || kindText === "view" || (kindText === "shadow" && verdict === false)
    if (!listed) continue
    const kind = (kindText === "view" ? "view" : "table") as "table" | "view"
    if (options.skip?.(name, kind)) continue
    tables.push(await readTable(run, name, kind, flag(entry.wr), flag(entry.strict)))
  }
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { db, schemaVersion, tables }
}

type Run = (sql: string, args?: readonly DataValue[]) => Promise<Record<string, unknown>[]>

async function readTable(
  run: Run,
  name: string,
  kind: "table" | "view",
  withoutRowid: boolean,
  strict: boolean,
): Promise<TableInfo> {
  const readOnly = kind === "view"
  const columns: ColumnInfo[] = []
  for (const row of await run(`PRAGMA main.table_xinfo(${quoted(name)})`)) {
    // hidden: 0 normal, 1 a virtual table's hidden column, 2 VIRTUAL generated, 3 STORED.
    const hidden = integer(row.hidden)
    if (hidden === 1) continue
    const declaredType = text(row.type)
    const generated = hidden === 2 || hidden === 3
    const pkPosition = integer(row.pk)
    const notNull = flag(row.notnull)
    const defaultExpression = row.dflt_value === null || row.dflt_value === undefined ? null : text(row.dflt_value)
    columns.push({
      name: text(row.name),
      declaredType,
      affinity: affinityOf(declaredType),
      notNull,
      defaultExpression,
      pkPosition,
      generated,
      rowidAlias: false,
      synthetic: false,
      nullable: true,
      writable: !readOnly && !generated,
      optionalOnInsert: true,
    })
  }

  const key = columns
    .filter((column) => column.pkPosition > 0)
    .sort((a, b) => a.pkPosition - b.pkPosition)
    .map((column) => column.name)

  // `INTEGER PRIMARY KEY` on a rowid table is the rowid under another name: SQLite assigns it
  // when an insert leaves it out, and it can never read back NULL. The type has to be spelled
  // exactly INTEGER — `INT PRIMARY KEY` is an ordinary indexed column.
  const alias =
    kind === "table" && !withoutRowid && key.length === 1
      ? columns.find(
          (column) => column.pkPosition === 1 && column.declaredType.trim().toUpperCase() === "INTEGER",
        )
      : undefined
  if (alias) alias.rowidAlias = true

  for (const column of columns) {
    const pk = column.pkPosition > 0
    // A PRIMARY KEY column of a WITHOUT ROWID table is implicitly NOT NULL; on a rowid table only
    // the INTEGER PRIMARY KEY alias is, which is SQLite's long-standing documented quirk.
    column.nullable = !column.notNull && !column.rowidAlias && !(withoutRowid && pk)
    column.optionalOnInsert =
      !column.writable || column.rowidAlias || column.defaultExpression !== null || column.nullable
  }

  if (key.length === 0 && kind === "table" && !withoutRowid) {
    const taken = new Set(columns.map((column) => column.name.toLowerCase()))
    const spelling = ROWID_ALIASES.find((candidate) => !taken.has(candidate))
    // Every rowid table has a rowid; a table that shadowed all three of its spellings has no name
    // left to address it by, and gets the collection routes alone.
    if (spelling) {
      columns.unshift({
        name: spelling,
        declaredType: "INTEGER",
        affinity: "INTEGER",
        notNull: true,
        defaultExpression: null,
        pkPosition: 1,
        generated: false,
        rowidAlias: true,
        synthetic: true,
        nullable: false,
        writable: false,
        optionalOnInsert: true,
      })
      key.push(spelling)
    }
  }

  const foreignKeys = readOnly ? [] : foreignKeysOf(await run(`PRAGMA main.foreign_key_list(${quoted(name)})`))
  const indexes = readOnly ? [] : await indexesOf(run, name)
  return { name, kind, withoutRowid, strict, columns, key, readOnly, foreignKeys, indexes }
}

function foreignKeysOf(rows: Record<string, unknown>[]): ForeignKeyInfo[] {
  const byId = new Map<number, ForeignKeyInfo>()
  for (const row of rows) {
    const id = integer(row.id)
    let key = byId.get(id)
    if (!key) {
      key = {
        columns: [],
        table: text(row.table),
        references: [],
        onUpdate: text(row.on_update),
        onDelete: text(row.on_delete),
      }
      byId.set(id, key)
    }
    key.columns.push(text(row.from))
    // A key written `REFERENCES other` names no column: it stands for that table's primary key.
    if (row.to !== null && row.to !== undefined) key.references.push(text(row.to))
  }
  return [...byId.values()]
}

async function indexesOf(run: Run, table: string): Promise<IndexInfo[]> {
  const out: IndexInfo[] = []
  for (const row of await run(`PRAGMA main.index_list(${quoted(table)})`)) {
    const name = text(row.name)
    const columns: string[] = []
    for (const member of await run(`PRAGMA main.index_info(${quoted(name)})`)) {
      // An expression term of an index reports a NULL name and addresses no column.
      if (member.name === null || member.name === undefined) continue
      columns.push(text(member.name))
    }
    out.push({
      name,
      unique: flag(row.unique),
      partial: flag(row.partial),
      origin: text(row.origin),
      columns,
    })
  }
  return out
}
