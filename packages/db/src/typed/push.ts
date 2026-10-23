// Makes a database satisfy the schema its DDL strings describe, which is what the types assume.
// docs/plan-typed-sql.md has the table of what changes by default and what needs `allowDataLoss`.
//
// The rule: push only moves the database toward what the types need. Missing things are created
// and a column looser than the schema is tightened; anything extra or stricter is left. That is
// what lets old and new code, and tenants at different points, push against the same databases
// without undoing each other.
//
// The desired schema is the DDL run in a scratch `:memory:` database, read with the same
// `readSchema` as the live one, so SQLite does the parsing.

import { compareSchemas, readSchema, type ColumnInfo, type SchemaSnapshot, type TableInfo } from "../client/diff.ts"
import type { Query, QueryArgs } from "../client/sql.ts"

interface Exec {
  execute(sql: string, args?: QueryArgs): Query<unknown>
}

export interface PushOptions {
  /**
   * Also drop columns the schema doesn't have, loosen constraints, and convert a column whose type
   * changed. Each of those rebuilds the table, and the first loses that column's data.
   */
  allowDataLoss?: boolean
  /**
   * Renames to apply before comparing: `{ "users.name": "users.full_name" }` for a column,
   * `{ people: "users" }` for a table. Each applies only while the old name exists and the new
   * one doesn't, so it can stay in the code after it has run everywhere.
   */
  rename?: Record<string, string>
}

export interface Plan {
  /** What `push` would run, in order. Empty when the database already satisfies the schema. */
  statements: string[]
  /** Changes `push` refuses without `allowDataLoss`, one sentence each. */
  blocked: string[]
}

export interface Desired {
  snapshot: SchemaSnapshot
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** The DDL run in a scratch database. Needs the bundled driver, so it's loaded on first use only. */
export async function desiredSchema(ddl: readonly string[]): Promise<Desired> {
  // A variable specifier keeps bundlers from pulling `bun:ffi` into a browser build of `bql.sh/typed`.
  const driver = "../sqlite/index.ts"
  let Database: typeof import("../sqlite/index.ts").Database
  try {
    ;({ Database } = (await import(driver)) as typeof import("../sqlite/index.ts"))
  } catch (err) {
    throw new Error("bql: push and plan build the schema in a scratch SQLite and need Bun", { cause: err })
  }
  const scratch = Database.open(":memory:")
  try {
    for (const sql of ddl) scratch.exec(sql)
    return { snapshot: await readSchema({ execute: async (sql) => scratch.query(sql).all() }, { rows: false }) }
  } finally {
    scratch.close()
  }
}

/** A definition with its name and spacing taken out, for comparing two spellings of one table. */
function body(sql: string): string {
  const at = sql.indexOf("(")
  return (at < 0 ? sql : sql.slice(at)).replace(/\s*([(),])\s*/g, "$1").replace(/\s+/g, " ").trim().toLowerCase()
}

function fnv(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h | 0
}

/**
 * The DDL text, hashed. It is the text and not the parsed schema so the in-step check needs no
 * scratch database; reformatting a string costs one full comparison that finds nothing to do.
 */
export function hashDdl(ddl: readonly string[]): number {
  return fnv(ddl.join("\u0000"))
}

/** `user_version` after a push: the schema's hash and the schema version it left, folded together. */
function fingerprint(hash: number, schemaVersion: number): number {
  return fnv(`${hash}:${schemaVersion}`)
}

/**
 * Whether `user_version` says this schema was pushed and no DDL has run since. `schema_version`
 * moves on every DDL statement from any source, and writing `user_version` doesn't move it.
 */
async function inStep(db: Exec, hash: number): Promise<boolean> {
  const row = (await db.execute("select * from pragma_user_version, pragma_schema_version").first()) as {
    user_version?: unknown
    schema_version?: unknown
  } | null
  return Number(row?.user_version) === fingerprint(hash, Number(row?.schema_version))
}

interface TxExec extends Exec {
  transaction<T>(fn: (tx: Exec) => Promise<T> | T, options?: { mode?: "deferred" | "immediate" | "exclusive" }): Promise<T>
}

/** About 5 seconds of backoff before a busy writer is reported instead of waited for. */
const PUSH_RETRIES = 25

function codeOf(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code
}

/**
 * Brings `db` in step with the schema. When it already is, that's one read and no lock; it runs on
 * every first query, so that is the case that has to be cheap.
 */
export async function pushTo(db: TxExec, hash: number, want: () => Promise<Desired>, options: PushOptions): Promise<void> {
  if (await inStep(db, hash)) return
  const target = await want()
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(
        async (tx) => {
          if (await inStep(tx, hash)) return
          const plan = await planLive(tx, target, options)
          if (plan.blocked.length > 0) {
            throw new Error(
              `bql: push won't make these changes without { allowDataLoss: true }:\n${plan.blocked.map((b) => `  - ${b}`).join("\n")}`,
            )
          }
          for (const sql of plan.statements) await tx.execute(sql).run()
          const broken = (await tx.execute("pragma foreign_key_check")) as unknown[]
          if (broken.length > 0) throw new Error(`bql: push would leave ${broken.length} rows breaking a foreign key`)
          const version = Number(((await tx.execute("pragma schema_version").first()) as { schema_version?: unknown } | null)?.schema_version ?? 0)
          await tx.execute(`pragma user_version = ${fingerprint(hash, version)}`).run()
        },
        { mode: "immediate" },
      )
      return
    } catch (err) {
      const code = codeOf(err)
      if (code === "NOT_AUTHORIZED") {
        throw new Error(
          "bql: the database isn't in step with the schema, and this token can't read or change its schema. Push with the admin key, or pass { sync: false }",
          { cause: err },
        )
      }
      // Another process or request is pushing the same database. Wait for it; once it commits,
      // this run finds the database in step.
      if ((code !== "TX_BUSY" && code !== "BUSY") || attempt >= PUSH_RETRIES) throw err
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 250)))
    }
  }
}

/** The TS type a declared type maps to, by the same affinity rules as `ddl.ts`. */
function tsType(declared: string): "number" | "string" | "blob" | "any" {
  const d = declared.toLowerCase()
  if (d.includes("int")) return "number"
  if (/char|clob|text/.test(d)) return "string"
  if (d.includes("blob")) return "blob"
  if (d === "" || d === "any") return "any"
  if (/real|floa|doub/.test(d)) return "number"
  if (/date|time/.test(d)) return "string"
  return "number"
}

/** Each column's definition as written in a `create table`, by lower-cased name. */
function columnDefs(sql: string): Map<string, string> {
  const open = sql.indexOf("(")
  const out = new Map<string, string>()
  let depth = 0
  let start = open + 1
  let quoteChar: string | null = null
  const items: string[] = []
  for (let i = open + 1; i < sql.length; i++) {
    const c = sql[i] as string
    if (quoteChar) {
      if (c === quoteChar) quoteChar = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") quoteChar = c
    else if (c === "[") quoteChar = "]"
    else if (c === "(") depth++
    else if (c === ")") {
      if (depth === 0) {
        items.push(sql.slice(start, i))
        break
      }
      depth--
    } else if (c === "," && depth === 0) {
      items.push(sql.slice(start, i))
      start = i + 1
    }
  }
  for (const raw of items) {
    const item = raw.trim()
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(item)) continue
    const name = /^("([^"]|"")+"|`[^`]+`|\[[^\]]+\]|[^\s(]+)/.exec(item)?.[0] ?? ""
    out.set(name.replace(/^["`[]|["`\]]$/g, "").replaceAll('""', '"').toLowerCase(), item)
  }
  return out
}

/** Whether `alter table add column` takes this definition (SQLite's documented restrictions). */
function alterable(column: ColumnInfo, def: string): boolean {
  if (column.pk > 0) return false
  if (/\b(unique|primary\s+key)\b/i.test(def)) return false
  if (/\bstored\b/i.test(def)) return false
  return !(column.notNull && column.default === null && column.hidden === 0)
}

function byLower<T extends { name: string }>(items: Iterable<T>): Map<string, T> {
  return new Map([...items].map((item) => [item.name.toLowerCase(), item]))
}

async function rows(db: Exec, sql: string): Promise<Record<string, unknown>[]> {
  return [...((await db.execute(sql)) as Record<string, unknown>[])]
}

type Rename =
  | { table: string; to: string; sql: string }
  | { table: string; column: string; to: string; sql: string }

/**
 * The renames in `rename` that still apply: the old name is live, the new one isn't, and the
 * schema wants it. Table renames go first, so a column rename can name its table by either name.
 */
function renames(live: SchemaSnapshot, desired: SchemaSnapshot, rename: Record<string, string>): Rename[] {
  const out: Rename[] = []
  const liveTables = byLower(live.tables.values())
  const wantTables = byLower(desired.tables.values())
  const split = (name: string) => name.toLowerCase().split(".") as [string, string | undefined]
  for (const [from, to] of Object.entries(rename)) {
    const [ft, fc] = split(from)
    const [tt, tc] = split(to)
    if (fc !== undefined || tc !== undefined) continue
    const table = liveTables.get(ft)
    const want = wantTables.get(tt)
    if (table && want && !liveTables.has(tt)) {
      out.push({ table: table.name, to: want.name, sql: `alter table ${quote(table.name)} rename to ${quote(want.name)}` })
      liveTables.delete(ft)
      liveTables.set(tt, { ...table, name: want.name })
      liveTables.set(ft, { ...table, name: want.name })
    }
  }
  for (const [from, to] of Object.entries(rename)) {
    const [ft, fc] = split(from)
    const [tt, tc] = split(to)
    if (fc === undefined || tc === undefined) continue
    const table = liveTables.get(ft) ?? liveTables.get(tt)
    const want = wantTables.get(tt)
    const col = table && byLower(table.columns).get(fc)
    const wantCol = want && byLower(want.columns).get(tc)
    if (table && col && wantCol && !byLower(table.columns).has(tc)) {
      out.push({
        table: table.name,
        column: col.name,
        to: wantCol.name,
        sql: `alter table ${quote(table.name)} rename column ${quote(col.name)} to ${quote(wantCol.name)}`,
      })
    }
  }
  return out
}

/** `live` as it will read after `ops`. Renames move no data, so nothing else changes. */
function afterRenames(live: SchemaSnapshot, ops: Rename[]): SchemaSnapshot {
  const tables = new Map(live.tables)
  for (const op of ops) {
    const table = tables.get(op.table)
    if (!table) continue
    if ("column" in op) {
      tables.set(op.table, { ...table, columns: table.columns.map((c) => (c.name === op.column ? { ...c, name: op.to } : c)) })
    } else {
      tables.delete(op.table)
      tables.set(op.to, { ...table, name: op.to })
    }
  }
  return { ...live, tables }
}

/** The statements that make `live` satisfy `desired`. Reads the live database for foreign keys. */
export async function planFor(db: Exec, live: SchemaSnapshot, desired: SchemaSnapshot, options: PushOptions): Promise<Plan> {
  const loss = options.allowDataLoss === true
  const blocked: string[] = []
  const creates: string[] = []
  const alters: string[] = []
  const rebuild = new Map<string, { want: TableInfo; have: TableInfo }>()
  const liveTables = byLower(live.tables.values())

  for (const want of desired.tables.values()) {
    const have = liveTables.get(want.name.toLowerCase())
    if (!have) {
      creates.push(want.sql)
      continue
    }
    if (want.virtual || have.virtual) {
      if (body(want.sql) === body(have.sql)) continue
      const sameColumns = want.columns.map((c) => c.name.toLowerCase()).join() === have.columns.map((c) => c.name.toLowerCase()).join()
      if (loss) creates.push(`drop table ${quote(have.name)}`, want.sql)
      else if (!sameColumns) blocked.push(`virtual table ${want.name} has different columns; recreating it drops its contents`)
      continue
    }

    const haveCols = byLower(have.columns)
    const wantCols = byLower(want.columns)
    const defs = columnDefs(want.sql)
    let needsRebuild = false
    const added: string[] = []
    for (const [key, col] of wantCols) {
      const existing = haveCols.get(key)
      if (!existing) {
        const def = defs.get(key)
        if (def && alterable(col, def)) added.push(`alter table ${quote(have.name)} add column ${def}`)
        else needsRebuild = true
        continue
      }
      const label = `${want.name}.${col.name}`
      const [t1, t2] = [tsType(existing.type), tsType(col.type)]
      if (t1 !== t2 && t1 !== "any" && t2 !== "any") {
        if (loss) needsRebuild = true
        else blocked.push(`${label} is ${existing.type || "untyped"} in the database and ${col.type || "untyped"} in the schema`)
      }
      if (existing.pk !== col.pk) {
        if (loss) needsRebuild = true
        else blocked.push(`${label} is ${existing.pk ? "" : "not "}in the primary key in the database and ${col.pk ? "" : "not "}in the schema`)
      }
      if (col.notNull && !existing.notNull) needsRebuild = true
      if (loss && (existing.notNull !== col.notNull || existing.default !== col.default || existing.type !== col.type || existing.hidden !== col.hidden)) {
        needsRebuild = true
      }
    }
    if (loss && (have.columns.some((c) => !wantCols.has(c.name.toLowerCase())) || body(have.sql) !== body(want.sql))) {
      needsRebuild = true
    }
    if (needsRebuild) rebuild.set(want.name.toLowerCase(), { want, have })
    else alters.push(...added)
  }

  if (blocked.length > 0 && !loss) return { statements: [], blocked }

  // With foreign keys on, dropping a table runs an implicit delete, which fires ON DELETE actions
  // in the tables that reference it. A rebuild would cascade into their rows.
  if (rebuild.size > 0) {
    const fk = await rows(db, "pragma foreign_keys")
    if (Number(fk[0]?.foreign_keys ?? 0) !== 0) {
      const referenced = await rows(
        db,
        `select distinct f."table" as parent, m.name as child from sqlite_schema m join pragma_foreign_key_list(m.name) f where m.type = 'table'`,
      )
      for (const ref of referenced) {
        const parent = String(ref.parent).toLowerCase()
        if (rebuild.has(parent) && String(ref.child).toLowerCase() !== parent) {
          blocked.push(`${rebuild.get(parent)!.want.name} has to be rebuilt, and with foreign_keys on that would fire ON DELETE actions in ${ref.child}`)
        }
      }
      if (blocked.length > 0) return { statements: [], blocked }
    }
  }

  const statements: string[] = []
  const diff = compareSchemas(live, desired)
  const rebuilt = (table: string) => rebuild.has(table.toLowerCase())
  const views = rebuild.size > 0 ? [...live.views.values()] : []
  if (rebuild.size > 0) {
    statements.push("pragma defer_foreign_keys = on")
    for (const view of views) statements.push(`drop view ${quote(view.name)}`)
  }
  statements.push(...creates, ...alters)

  for (const { want, have } of rebuild.values()) {
    const temp = `__bql_new_${want.name}`
    const wantCols = byLower(want.columns)
    const shared = have.columns
      .filter((c) => c.hidden === 0 && wantCols.get(c.name.toLowerCase())?.hidden === 0)
      .map((c) => quote(wantCols.get(c.name.toLowerCase())!.name))
    const from = have.columns
      .filter((c) => c.hidden === 0 && wantCols.get(c.name.toLowerCase())?.hidden === 0)
      .map((c) => quote(c.name))
    statements.push(
      `create table ${quote(temp)} ${want.sql.slice(want.sql.indexOf("("))}`,
      `insert into ${quote(temp)} (${shared.join(", ")}) select ${from.join(", ")} from ${quote(have.name)}`,
      `drop table ${quote(have.name)}`,
      `alter table ${quote(temp)} rename to ${quote(want.name)}`,
    )
    // Dropping the table dropped its indexes and triggers. The schema's come back below; the live
    // ones the schema doesn't know come back too, unless the caller asked for an exact match.
    if (!loss) {
      for (const index of live.indexes.values()) {
        if (index.table.toLowerCase() === have.name.toLowerCase() && !desired.indexes.has(index.name)) statements.push(index.sql)
      }
      for (const trigger of live.triggers.values()) {
        if (trigger.table.toLowerCase() === have.name.toLowerCase() && !desired.triggers.has(trigger.name)) statements.push(trigger.sql)
      }
    }
  }

  for (const kind of ["indexes", "triggers"] as const) {
    const verb = kind === "indexes" ? "index" : "trigger"
    for (const obj of diff[kind].added) statements.push(obj.sql)
    for (const { before, after } of diff[kind].changed) {
      if (!rebuilt(before.table)) statements.push(`drop ${verb} ${quote(before.name)}`)
      statements.push(after.sql)
    }
    // An index or trigger on a rebuilt table went with it, so the schema's one is created again.
    for (const obj of desired[kind].values()) {
      if (rebuilt(obj.table) && live[kind].has(obj.name) && !diff[kind].changed.some((c) => c.name === obj.name)) statements.push(obj.sql)
    }
  }

  if (rebuild.size > 0) {
    for (const view of desired.views.values()) statements.push(view.sql)
    for (const view of views) if (!desired.views.has(view.name)) statements.push(view.sql)
  } else {
    for (const view of diff.views.added) statements.push(view.sql)
    for (const { before, after } of diff.views.changed) statements.push(`drop view ${quote(before.name)}`, after.sql)
  }
  return { statements, blocked: [] }
}

/** Renames first, then the plan, against the live database as it reads now. */
export async function planLive(db: Exec, desired: Desired, options: PushOptions): Promise<Plan> {
  const live = await readSchema(db as unknown as Parameters<typeof readSchema>[0], { rows: false })
  const ops = options.rename ? renames(live, desired.snapshot, options.rename) : []
  const plan = await planFor(db, afterRenames(live, ops), desired.snapshot, options)
  return plan.blocked.length > 0 ? plan : { statements: [...ops.map((op) => op.sql), ...plan.statements], blocked: [] }
}
