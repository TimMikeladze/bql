// Invariant: a read-set comes from SQLite's own authorizer, never from parsing SQL. Preparing the
// statement makes SQLite report every `SQLITE_READ(table, column)` it will touch, including
// through views, CTEs and subqueries, so the set is exact and column-precise without a parser.
//
// The statement is prepared outside the connection's prepared-statement cache on purpose: a cache
// hit does not call `sqlite3_prepare` again, and the driver does not re-register the authorizer
// when the callback is swapped, so a cached statement would report nothing at all.

import {
  SQLITE_ALTER_TABLE,
  SQLITE_ANALYZE,
  SQLITE_ATTACH,
  SQLITE_CREATE_INDEX,
  SQLITE_CREATE_TABLE,
  SQLITE_CREATE_TEMP_INDEX,
  SQLITE_CREATE_TEMP_TABLE,
  SQLITE_CREATE_TEMP_TRIGGER,
  SQLITE_CREATE_TEMP_VIEW,
  SQLITE_CREATE_TRIGGER,
  SQLITE_CREATE_VIEW,
  SQLITE_CREATE_VTABLE,
  SQLITE_DELETE,
  SQLITE_DETACH,
  SQLITE_DROP_INDEX,
  SQLITE_DROP_TABLE,
  SQLITE_DROP_TEMP_INDEX,
  SQLITE_DROP_TEMP_TABLE,
  SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_DROP_TEMP_VIEW,
  SQLITE_DROP_TRIGGER,
  SQLITE_DROP_VIEW,
  SQLITE_DROP_VTABLE,
  SQLITE_INSERT,
  SQLITE_OK,
  SQLITE_READ,
  SQLITE_REINDEX,
  SQLITE_UPDATE,
} from "../sqlite/constants.ts"
import type { Authorizer, Database } from "../sqlite/index.ts"
import { prepareStatement } from "../sqlite/statement.ts"
import { AuthorizerHub } from "./authorizer.ts"

export interface ReadSet {
  /** Table → the columns read, or `"*"` when the whole row matters (`count(*)`, `select *`). */
  tables: Map<string, Set<string> | "*">
  /** The statement writes. Live queries must be read-only, so this rejects the subscription. */
  writesDetected: boolean
  /** The statement changes the schema. */
  ddl: boolean
  /** Column names of the result set, which a keyed subscription validates its `key` against. */
  columns: string[]
}

export interface ReadSetOptions {
  /** Hub owning the connection's authorizer. One is created and detached again when absent. */
  hub?: AuthorizerHub
  /** Authorizer to compose with when there is no hub; restored afterwards. */
  base?: Authorizer | null
}

const DDL_ACTIONS: ReadonlySet<number> = new Set([
  SQLITE_ALTER_TABLE,
  SQLITE_CREATE_INDEX,
  SQLITE_CREATE_TABLE,
  SQLITE_CREATE_TEMP_INDEX,
  SQLITE_CREATE_TEMP_TABLE,
  SQLITE_CREATE_TEMP_TRIGGER,
  SQLITE_CREATE_TEMP_VIEW,
  SQLITE_CREATE_TRIGGER,
  SQLITE_CREATE_VIEW,
  SQLITE_CREATE_VTABLE,
  SQLITE_DROP_INDEX,
  SQLITE_DROP_TABLE,
  SQLITE_DROP_TEMP_INDEX,
  SQLITE_DROP_TEMP_TABLE,
  SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_DROP_TEMP_VIEW,
  SQLITE_DROP_TRIGGER,
  SQLITE_DROP_VIEW,
  SQLITE_DROP_VTABLE,
])

const WRITE_ACTIONS: ReadonlySet<number> = new Set([
  SQLITE_INSERT,
  SQLITE_UPDATE,
  SQLITE_DELETE,
  SQLITE_ATTACH,
  SQLITE_DETACH,
  SQLITE_REINDEX,
  SQLITE_ANALYZE,
])

/**
 * Prepares `sql` with a recording authorizer and reports what it reads and whether it writes.
 * `sqlite_*` tables are ignored: the planner and AUTOINCREMENT read them constantly and nothing
 * a live query cares about lives there.
 */
export function readSetOf(db: Database, sql: string, options: ReadSetOptions = {}): ReadSet {
  const tables = new Map<string, Set<string> | "*">()
  let writesDetected = false
  let ddl = false

  const recorder: Authorizer = (action, arg1, arg2) => {
    if (action === SQLITE_READ) {
      const table = arg1 ?? ""
      if (table === "" || table.startsWith("sqlite_")) return SQLITE_OK
      const known = tables.get(table)
      if (known === "*") return SQLITE_OK
      // An empty column name is SQLite's way of saying "the row exists", as in `count(*)`.
      if (arg2 === null || arg2 === "") {
        tables.set(table, "*")
        return SQLITE_OK
      }
      if (known) known.add(arg2)
      else tables.set(table, new Set([arg2]))
      return SQLITE_OK
    }
    if (DDL_ACTIONS.has(action)) {
      ddl = true
      writesDetected = true
    } else if (WRITE_ACTIONS.has(action)) {
      if (arg1 === null || !arg1.startsWith("sqlite_")) writesDetected = true
    }
    return SQLITE_OK
  }

  const hub = options.hub ?? new AuthorizerHub(db)
  const owned = options.hub === undefined
  const base = options.base ?? null
  if (owned && base) hub.setBase(base)
  const remove = hub.addLayer(recorder, { expire: false })
  let columns: string[] = []
  try {
    // A statement of its own, outside the cache, so the authorizer always sees the prepare.
    const stmt = prepareStatement(db, sql, 0)
    try {
      columns = stmt.columnNames
      if (!stmt.readonly) writesDetected = true
    } finally {
      stmt.finalize()
    }
  } finally {
    remove()
    if (owned) {
      hub.detach()
      // The hub was ours, so put back whatever the caller had installed directly.
      if (base) db.authorizer(base)
    }
  }
  return { tables, writesDetected, ddl, columns }
}

/** True when a write-set table/column pair can affect a read-set. */
export function readSetTouched(
  readSet: ReadSet,
  table: string,
  columns: Set<string> | "*" | undefined,
): boolean {
  const read = readSet.tables.get(table)
  if (read === undefined) return false
  if (read === "*" || columns === undefined || columns === "*") return true
  for (const column of columns) if (read.has(column)) return true
  return false
}
