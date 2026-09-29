// Invariant: nothing is published from inside a SQLite hook. A hook appends to a buffer and
// returns; the commit hook only moves that buffer to a committed queue. Everything that needs the
// connection — primary-key metadata, the schema cookie — happens in `takeCommitted()`, which the
// tenant owner calls once the transaction is durable and which stamps nothing: the owner owns the
// txid.
//
// Engine: the preupdate hook is the source (design §4.6). It reports `WITHOUT ROWID` tables,
// carries OLD and NEW values, and disables the DELETE truncate optimisation on its own. The
// update hook is the fallback for a libsqlite3 built without SQLITE_ENABLE_PREUPDATE_HOOK: no
// values, no `WITHOUT ROWID` tables, and an authorizer layer answering SQLITE_IGNORE to
// SQLITE_DELETE so `DELETE FROM t` still reports every row.
//
// SQLite gives a connection one commit-hook slot and one rollback-hook slot, so while capture is
// enabled it owns both; a layer that wants its own commit callback takes `onCommit`, which fires
// from inside the hook and may do nothing but schedule work.

import type { ChangeOp, SchemaChange, SchemaObject, SchemaOp } from "../client/protocol.ts"
import {
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
  SQLITE_DELETE,
  SQLITE_DROP_INDEX,
  SQLITE_DROP_TABLE,
  SQLITE_DROP_TEMP_INDEX,
  SQLITE_DROP_TEMP_TABLE,
  SQLITE_DROP_TEMP_TRIGGER,
  SQLITE_DROP_TEMP_VIEW,
  SQLITE_DROP_TRIGGER,
  SQLITE_DROP_VIEW,
  SQLITE_DROP_VTABLE,
  SQLITE_IGNORE,
  SQLITE_INSERT,
  SQLITE_OK,
} from "../sqlite/constants.ts"
import type { Authorizer, Database, PreupdateAccessor } from "../sqlite/index.ts"
import type { SqliteValue } from "../sqlite/values.ts"
import { VIRTUAL_TABLES_SQL, shadowOwner, virtualTables } from "../sqlite/shadow.ts"
import { AuthorizerHub } from "./authorizer.ts"

/**
 * How much of each changed row the capture buffers.
 *
 * - `off` — hooks uninstalled; a tenant with no subscribers pays nothing.
 * - `none` — table, op and rowid only, which is all live-query invalidation needs.
 * - `pk` — plus the primary key of the row.
 * - `row` — plus the new row for inserts and updates.
 * - `row+old` — plus the previous row for updates and deletes.
 */
export type CaptureLevel = "off" | "none" | "pk" | "row" | "row+old"

export type CaptureEngine = "preupdate" | "update"

/** Driver-native values; the wire encoding happens in the facade, not in the hook. */
export type ValueRow = Record<string, SqliteValue>

export interface CapturedRow {
  table: string
  op: ChangeOp
  /** Null for a `WITHOUT ROWID` table, where the preupdate hook reports no meaningful rowid. */
  rowid: bigint | null
  pk?: ValueRow
  row?: ValueRow
  old?: ValueRow
}

export interface TableChange {
  ops: { insert: number; update: number; delete: number }
  /** Columns the transaction changed, or `"*"` when any column may have changed. */
  columns?: Set<string> | "*"
}

export interface TxnChanges {
  tables: Map<string, TableChange>
  rows: CapturedRow[]
  /**
   * L8: where one statement's rows end and the next one's begin, as offsets into `rows`. Recorded
   * by `mark()` from the one place that knows — the request layer, which runs the statements — so
   * a group commit of fifty writes can be published as fifty events rather than one.
   *
   * Empty means "nobody marked anything", which is a single-statement transaction and every
   * transaction written before L8. It is not the same as `[0]`.
   */
  marks: number[]
  /** True when the transaction changed more rows than `maxRowsPerTxn` and `rows` is short. */
  rowsTruncated: boolean
  schemaChanged: boolean
  /** DDL the authorizer saw, kept only when the schema cookie confirms it ran. */
  ddl: SchemaChange[]
}

export interface ChangeCaptureOptions {
  /** Starting level. Default `"none"`. */
  includeRows?: CaptureLevel
  /** Compare OLD and NEW values so invalidation can be column-precise. Default false. */
  trackColumns?: boolean
  /** `"auto"` prefers the preupdate hook when the library has it. Default `"auto"`. */
  engine?: CaptureEngine | "auto"
  /** Rows buffered per transaction before `rowsTruncated` is set. Default 10000. */
  maxRowsPerTxn?: number
  /** Committed transactions held for the owner to drain. Default 256. */
  maxBufferedTxns?: number
  /** Shared authorizer hub, so capture composes with the token policy. */
  hub?: AuthorizerHub
  /** Called from the commit hook. Must not publish or touch the connection. */
  onCommit?: (capture: ChangeCapture) => void
}

interface RawRow {
  table: string
  op: ChangeOp
  rowid: bigint | null
  /** NEW values for an insert or update, OLD values for a delete. */
  vals: SqliteValue[] | null
  /** True when `vals` holds only the key columns, in `TableMeta.pkIndexes` order. */
  partial: boolean
  /** OLD values of an update. */
  prev: SqliteValue[] | null
  /** Emit `vals` as a row payload (`row` for insert and update, `old` for delete). */
  emitRow: boolean
  /** Emit `prev` as `old`. */
  emitOld: boolean
  /** The level asked for a key, so resolve one even when no values were read. */
  wantPk: boolean
  changed: number[] | null
}

interface RawTable {
  insert: number
  update: number
  delete: number
  /** Any column may have changed: an insert, a delete, or a table without metadata. */
  all: boolean
  cols: Set<number> | null
}

interface PendingTxn {
  rows: RawRow[]
  tables: Map<string, RawTable>
  ddl: SchemaChange[]
  truncated: boolean
  /** Statement boundaries as offsets into `rows`; see `TxnChanges.marks`. */
  marks: number[]
}

interface TableMeta {
  columns: string[]
  pkIndexes: number[]
  withoutRowid: boolean
  /** Name of the `INTEGER PRIMARY KEY` column, which is the rowid under another name. */
  rowidAlias: string | null
}

interface DdlAction {
  op: SchemaOp
  object: SchemaObject
  temp: boolean
  /** Which authorizer argument carries the object name. */
  nameArg: 1 | 2
}

const DDL_ACTIONS: Readonly<Record<number, DdlAction>> = {
  [SQLITE_CREATE_INDEX]: { op: "create", object: "index", temp: false, nameArg: 1 },
  [SQLITE_CREATE_TABLE]: { op: "create", object: "table", temp: false, nameArg: 1 },
  [SQLITE_CREATE_TEMP_INDEX]: { op: "create", object: "index", temp: true, nameArg: 1 },
  [SQLITE_CREATE_TEMP_TABLE]: { op: "create", object: "table", temp: true, nameArg: 1 },
  [SQLITE_CREATE_TEMP_TRIGGER]: { op: "create", object: "trigger", temp: true, nameArg: 1 },
  [SQLITE_CREATE_TEMP_VIEW]: { op: "create", object: "view", temp: true, nameArg: 1 },
  [SQLITE_CREATE_TRIGGER]: { op: "create", object: "trigger", temp: false, nameArg: 1 },
  [SQLITE_CREATE_VIEW]: { op: "create", object: "view", temp: false, nameArg: 1 },
  [SQLITE_CREATE_VTABLE]: { op: "create", object: "table", temp: false, nameArg: 1 },
  [SQLITE_DROP_INDEX]: { op: "drop", object: "index", temp: false, nameArg: 1 },
  [SQLITE_DROP_TABLE]: { op: "drop", object: "table", temp: false, nameArg: 1 },
  [SQLITE_DROP_TEMP_INDEX]: { op: "drop", object: "index", temp: true, nameArg: 1 },
  [SQLITE_DROP_TEMP_TABLE]: { op: "drop", object: "table", temp: true, nameArg: 1 },
  [SQLITE_DROP_TEMP_TRIGGER]: { op: "drop", object: "trigger", temp: true, nameArg: 1 },
  [SQLITE_DROP_TEMP_VIEW]: { op: "drop", object: "view", temp: true, nameArg: 1 },
  [SQLITE_DROP_TRIGGER]: { op: "drop", object: "trigger", temp: false, nameArg: 1 },
  [SQLITE_DROP_VIEW]: { op: "drop", object: "view", temp: false, nameArg: 1 },
  [SQLITE_DROP_VTABLE]: { op: "drop", object: "table", temp: false, nameArg: 1 },
  // For ALTER TABLE the first argument is the database, the second the table (SQLite's own rule).
  [SQLITE_ALTER_TABLE]: { op: "alter", object: "table", temp: false, nameArg: 2 },
}

/** Values of one column before and after, for column-precise invalidation. */
function sameValue(a: SqliteValue, b: SqliteValue): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a === "bigint" || typeof b === "bigint") {
    // A float never equals a bigint, and `BigInt(1.5)` would throw inside the hook.
    if (typeof a === "number" && !Number.isInteger(a)) return false
    if (typeof b === "number" && !Number.isInteger(b)) return false
    if (typeof a === "string" || typeof b === "string") return false
    if (a instanceof Uint8Array || b instanceof Uint8Array) return false
    return BigInt(a as bigint | number) === BigInt(b as bigint | number)
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  return false
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export class ChangeCapture {
  readonly db: Database
  readonly hub: AuthorizerHub
  readonly engine: CaptureEngine

  #level: CaptureLevel = "off"
  #trackColumns: boolean
  #maxRowsPerTxn: number
  #maxBufferedTxns: number
  #onCommit: ((capture: ChangeCapture) => void) | undefined

  #pending: PendingTxn | null = null
  #committed: PendingTxn[] = []
  #meta = new Map<string, TableMeta | null>()
  /** Shadow table → the virtual table it stores, or null until read. Cleared with `#meta`. */
  #shadows: Map<string, string> | null = null
  #schemaCookie: number | null = null
  #removeLayer: (() => void) | null = null
  #hooksOn = false
  #closed = false
  /** Set once `pragma_table_info(?)` is known to work, so metadata is one cached statement. */
  #tableFn: boolean | null = null

  constructor(db: Database, options: ChangeCaptureOptions = {}) {
    this.db = db
    this.hub = options.hub ?? new AuthorizerHub(db)
    this.#trackColumns = options.trackColumns === true
    this.#maxRowsPerTxn = options.maxRowsPerTxn ?? 10_000
    this.#maxBufferedTxns = options.maxBufferedTxns ?? 256
    this.#onCommit = options.onCommit
    const wanted = options.engine ?? "auto"
    const hasPreupdate = db.lib.features.preupdate && db.lib.preupdate !== null
    this.engine = wanted === "update" || (wanted === "auto" && !hasPreupdate) ? "update" : "preupdate"
    if (wanted === "preupdate" && !hasPreupdate) {
      throw new Error("preupdate capture was requested but this libsqlite3 has no preupdate hook")
    }
    this.setLevel(options.includeRows ?? "none")
  }

  get level(): CaptureLevel {
    return this.#level
  }

  get trackColumns(): boolean {
    return this.#trackColumns
  }

  /** Number of committed transactions waiting for `takeCommitted()`. */
  get buffered(): number {
    return this.#committed.length
  }

  /**
   * L8: "a statement just finished." Records where its rows end, so a transaction that folded
   * several statements can be published as one event per statement rather than one per fold.
   *
   * Called from the request layer, which is the only place that knows where a statement begins and
   * ends — the preupdate hooks see rows, not statements. A transaction nobody marks yields no
   * marks and is published exactly as it was before L8, which is what keeps the embedded API, the
   * replica apply path and every internal write unchanged.
   *
   * A statement that changed nothing leaves a mark equal to the one before it, which is an empty
   * slice and therefore no event: `seq` numbers the *events*, which is what a dedupe key needs,
   * not the statements, which a consumer cannot see anyway.
   */
  mark(): void {
    const txn = this.#pending
    if (!txn) return
    txn.marks.push(txn.rows.length)
  }

  set trackColumns(on: boolean) {
    this.#trackColumns = on
  }

  /**
   * Installs or removes the hooks. `"off"` leaves the connection exactly as it was found, which
   * is what a tenant with no subscribers runs with.
   */
  setLevel(level: CaptureLevel): void {
    if (this.#closed || level === this.#level) return
    this.#level = level
    if (level === "off") {
      this.#uninstall()
      this.#pending = null
      this.#committed.length = 0
      return
    }
    this.#install()
  }

  /**
   * The oldest committed transaction, resolved into names and values, or null when none is
   * waiting. Call it once per commit, after the transaction is durable.
   */
  takeCommitted(): TxnChanges | null {
    const txn = this.#committed.shift()
    if (!txn) return null
    const schemaChanged = this.#schemaMoved()
    const shadows = this.#shadowMap()
    if (shadows.size > 0) this.#hideShadows(txn, shadows)
    const tables = new Map<string, TableChange>()
    for (const [name, raw] of txn.tables) {
      const change: TableChange = {
        ops: { insert: raw.insert, update: raw.update, delete: raw.delete },
      }
      if (this.#trackColumns) change.columns = this.#columnsOf(name, raw)
      tables.set(name, change)
    }
    const rows: CapturedRow[] = new Array(txn.rows.length)
    for (let i = 0; i < txn.rows.length; i++) {
      rows[i] = this.#materialize(txn.rows[i] as RawRow)
    }
    return {
      tables,
      rows,
      marks: txn.marks,
      rowsTruncated: txn.truncated,
      schemaChanged,
      ddl: schemaChanged ? txn.ddl : [],
    }
  }

  /** Drains every committed transaction, oldest first. */
  takeAllCommitted(): TxnChanges[] {
    const out: TxnChanges[] = []
    for (;;) {
      const next = this.takeCommitted()
      if (!next) return out
      out.push(next)
    }
  }

  /** Forgets cached table metadata, as after DDL this capture did not see. */
  invalidateMetadata(): void {
    this.#meta.clear()
    this.#shadows = null
    if (this.#hooksOn) this.#shadowMap()
  }

  /** Uninstalls everything. The connection is left as it was before the capture attached. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#level = "off"
    this.#uninstall()
    this.#pending = null
    this.#committed.length = 0
    this.#meta.clear()
  }

  // ── hooks ────────────────────────────────────────────────────────────────────────────────────

  #install(): void {
    if (!this.#removeLayer) {
      this.#removeLayer = this.hub.addLayer(this.#authLayer, { expire: this.engine === "update" })
    }
    if (this.#hooksOn) return
    this.#hooksOn = true
    if (this.#schemaCookie === null) this.#schemaMoved()
    // The hooks read this map and may not build it: no SQL inside a hook.
    this.#shadowMap()
    if (this.engine === "preupdate") this.db.onPreupdate(this.#preupdate)
    else this.db.onUpdate(this.#update)
    this.db.onCommit(this.#commit)
    this.db.onRollback(this.#rollback)
  }

  #uninstall(): void {
    this.#removeLayer?.()
    this.#removeLayer = null
    if (!this.#hooksOn) return
    this.#hooksOn = false
    if (this.db.closed) return
    if (this.engine === "preupdate") this.db.onPreupdate(null)
    else this.db.onUpdate(null)
    this.db.onCommit(null)
    this.db.onRollback(null)
  }

  #authLayer: Authorizer = (action, arg1, arg2) => {
    const ddl = DDL_ACTIONS[action]
    if (ddl) {
      const name = (ddl.nameArg === 1 ? arg1 : arg2) ?? arg1 ?? ""
      const change: SchemaChange = { op: ddl.op, object: ddl.object, name }
      if (ddl.temp) change.temp = true
      this.#ensure().ddl.push(change)
      return SQLITE_OK
    }
    // Fallback engine only: the truncate optimisation hides the rows of `DELETE FROM t` from the
    // update hook unless the authorizer answers IGNORE (design §4.6). The rows are still deleted.
    if (
      this.engine === "update" &&
      action === SQLITE_DELETE &&
      arg1 !== null &&
      !arg1.startsWith("sqlite_")
    ) {
      return SQLITE_IGNORE
    }
    return SQLITE_OK
  }

  // The driver's preupdate callback has no catch of its own, and an exception must never unwind
  // through C. Anything that goes wrong degrades this table to "every column changed", which
  // over-invalidates and stays correct.
  #preupdate = (
    op: number,
    dbName: string,
    table: string,
    oldRowid: bigint,
    newRowid: bigint,
    acc: PreupdateAccessor,
  ): void => {
    try {
      this.#capture(op, dbName, table, oldRowid, newRowid, acc)
    } catch {
      const txn = this.#pending
      const entry = txn?.tables.get(table)
      if (entry) entry.all = true
      if (txn) txn.truncated = true
    }
  }

  #capture(
    op: number,
    _dbName: string,
    table: string,
    oldRowid: bigint,
    newRowid: bigint,
    acc: PreupdateAccessor,
  ): void {
    const level = this.#level
    if (level === "off") return
    const kind: ChangeOp = op === SQLITE_INSERT ? "insert" : op === SQLITE_DELETE ? "delete" : "update"
    const txn = this.#ensure()
    if (this.#hideShadow(txn, table, kind)) return
    const meta = this.#meta.get(table) ?? null
    const entry = this.#touch(txn, table, kind)

    if (txn.rows.length >= this.#maxRowsPerTxn) {
      txn.truncated = true
      entry.all = true
      return
    }

    const row: RawRow = {
      table,
      op: kind,
      rowid: kind === "delete" ? oldRowid : newRowid,
      vals: null,
      partial: false,
      prev: null,
      emitRow: level === "row+old" || (level === "row" && kind !== "delete"),
      emitOld: level === "row+old" && kind === "update",
      wantPk: level !== "none",
      changed: null,
    }
    // An update that must be compared column by column needs both sides in full; so does any
    // level above `none` for a table whose key columns are not known yet.
    const compare = this.#trackColumns && kind === "update"
    const full = level === "row+old" || (level === "row" && kind !== "delete") || compare || !meta
    const count = level === "none" && !compare ? 0 : acc.count()

    if (count > 0) {
      const fromNew = kind !== "delete"
      if (full) {
        const vals: SqliteValue[] = new Array(count)
        for (let i = 0; i < count; i++) vals[i] = fromNew ? acc.new(i) : acc.old(i)
        row.vals = vals
        if (compare || row.emitOld) {
          const prev: SqliteValue[] = new Array(count)
          for (let i = 0; i < count; i++) prev[i] = kind === "insert" ? null : acc.old(i)
          row.prev = prev
          if (compare) {
            const changed: number[] = []
            // An empty set is the answer "nothing changed", which is not the same as `null`,
            // "we do not know" — the first invalidates nothing, the second invalidates the table.
            const cols = (entry.cols ??= new Set())
            for (let i = 0; i < count; i++) {
              if (sameValue(vals[i] as SqliteValue, prev[i] as SqliteValue)) continue
              changed.push(i)
              cols.add(i)
            }
            row.changed = changed
          }
        }
      } else if (meta && meta.pkIndexes.length > 0) {
        const vals: SqliteValue[] = new Array(meta.pkIndexes.length)
        for (let i = 0; i < meta.pkIndexes.length; i++) {
          const c = meta.pkIndexes[i] as number
          vals[i] = fromNew ? acc.new(c) : acc.old(c)
        }
        row.vals = vals
        row.partial = true
      }
    }
    // Anything but an update whose changed columns are known can touch any column.
    if (kind !== "update" || row.changed === null) entry.all = true
    txn.rows.push(row)
  }

  #update = (op: number, _dbName: string, table: string, rowid: bigint): void => {
    const level = this.#level
    if (level === "off") return
    // The update hook reads no values, so the only way this throws is out of memory.

    const kind: ChangeOp = op === SQLITE_INSERT ? "insert" : op === SQLITE_DELETE ? "delete" : "update"
    const txn = this.#ensure()
    if (this.#hideShadow(txn, table, kind)) return
    const entry = this.#touch(txn, table, kind)
    // Without the preupdate hook there are no values, so every column is suspect.
    entry.all = true
    if (txn.rows.length >= this.#maxRowsPerTxn) {
      txn.truncated = true
      return
    }
    txn.rows.push({
      table,
      op: kind,
      rowid,
      vals: null,
      partial: false,
      prev: null,
      emitRow: false,
      emitOld: false,
      wantPk: level !== "none",
      changed: null,
    })
  }

  #commit = (): void => {
    const txn = this.#pending
    this.#pending = null
    if (txn && (txn.rows.length > 0 || txn.tables.size > 0 || txn.ddl.length > 0)) {
      if (this.#committed.length >= this.#maxBufferedTxns) this.#committed.shift()
      this.#committed.push(txn)
    }
    this.#onCommit?.(this)
  }

  #rollback = (): void => {
    this.#pending = null
  }

  #ensure(): PendingTxn {
    let txn = this.#pending
    if (!txn) {
      txn = { rows: [], tables: new Map(), ddl: [], truncated: false, marks: [] }
      this.#pending = txn
    }
    return txn
  }

  // ── shadow tables (src/sqlite/shadow.ts) ────────────────────────────────────────────────────

  /**
   * In the hook, before the row cap and before a single value is read: a write to a virtual
   * table's storage becomes "the virtual table changed, any column", and nothing else. Counting
   * those rows against `maxRowsPerTxn` truncated a transaction after ~1,300 FTS-indexed rows (and
   * copied every shadow blob only to drop it). The map is whatever `#shadowMap` last built — at
   * install, and after every commit whose schema moved — so the one case it can miss is a
   * transaction that creates a virtual table and writes it; `#hideShadows` catches that one.
   */
  #hideShadow(txn: PendingTxn, table: string, kind: ChangeOp): boolean {
    const shadows = this.#shadows
    if (shadows === null || shadows.size === 0) return false
    const owner = shadows.get(table.toLowerCase())
    if (owner === undefined) return false
    this.#touch(txn, owner, kind).all = true
    return true
  }

  /**
   * The backstop for `#hideShadow`: storage rows the hook's map did not know about yet (a
   * transaction that created the virtual table), taken out of what this transaction reports. The
   * rows are dropped — they are the module's internals, and a change-feed consumer never created
   * those tables — and the statement marks are re-based onto the rows that remain. The table
   * entry is folded into the virtual table's, as "any column may have changed", because that is
   * what a live query over `docs_fts MATCH …` reads and must be invalidated by.
   */
  #hideShadows(txn: PendingTxn, shadows: Map<string, string>): void {
    let hidden = false
    const folded = new Map<string, RawTable>()
    for (const [name, raw] of txn.tables) {
      const owner = shadows.get(name.toLowerCase())
      if (owner !== undefined) hidden = true
      const key = owner ?? name
      const into = folded.get(key)
      if (!into) {
        folded.set(key, owner === undefined ? raw : { ...raw, all: true, cols: null })
        continue
      }
      // The hook may already have folded some of this transaction's storage writes into the
      // owner, so the owner can meet itself here; either way the merge is "any column".
      into.insert += raw.insert
      into.update += raw.update
      into.delete += raw.delete
      into.all = true
    }
    if (!hidden) return
    txn.tables = folded
    const kept: RawRow[] = []
    // `before[i]` is how many rows were kept before original offset i, which is what a mark
    // recorded at offset i becomes.
    const before: number[] = new Array(txn.rows.length + 1)
    for (let i = 0; i < txn.rows.length; i++) {
      before[i] = kept.length
      const row = txn.rows[i] as RawRow
      if (!shadows.has(row.table.toLowerCase())) kept.push(row)
    }
    before[txn.rows.length] = kept.length
    txn.marks = txn.marks.map((at) => before[Math.min(at, txn.rows.length)] as number)
    txn.rows = kept
  }

  #shadowMap(): Map<string, string> {
    if (this.#shadows) return this.#shadows
    const shadows = new Map<string, string>()
    try {
      this.hub.bypass(() => {
        const vtabs = virtualTables(
          this.db.prepare(VIRTUAL_TABLES_SQL).all() as { name: unknown; sql: unknown }[],
        )
        if (vtabs.size === 0) return
        const names = this.db
          .prepare("select name from sqlite_schema where type = 'table'")
          .all() as { name: unknown }[]
        for (const { name } of names) {
          if (typeof name !== "string") continue
          const owner = shadowOwner(name, vtabs)
          if (owner !== null) shadows.set(name.toLowerCase(), owner)
        }
      })
    } catch {
      // Reporting a shadow table is the lesser failure than dropping a real one.
    }
    this.#shadows = shadows
    return shadows
  }

  #touch(txn: PendingTxn, table: string, op: ChangeOp): RawTable {
    let entry = txn.tables.get(table)
    if (!entry) {
      entry = { insert: 0, update: 0, delete: 0, all: false, cols: null }
      txn.tables.set(table, entry)
    }
    entry[op]++
    return entry
  }

  // ── materialisation, outside the hooks ───────────────────────────────────────────────────────

  #columnsOf(table: string, raw: RawTable): Set<string> | "*" {
    if (raw.all || raw.cols === null) return "*"
    const meta = this.#metaFor(table)
    if (!meta) return "*"
    const names = new Set<string>()
    for (const i of raw.cols) {
      const name = meta.columns[i]
      if (name === undefined) return "*"
      names.add(name)
    }
    return names
  }

  #materialize(raw: RawRow): CapturedRow {
    const meta = this.#metaFor(raw.table)
    const out: CapturedRow = {
      table: raw.table,
      op: raw.op,
      rowid: meta?.withoutRowid ? null : raw.rowid,
    }
    if (!meta) return out
    const vals = raw.vals
    if (vals === null) {
      // Update-hook fallback: the only key we can name is an INTEGER PRIMARY KEY alias.
      if (raw.wantPk && meta.rowidAlias !== null && raw.rowid !== null) {
        out.pk = { [meta.rowidAlias]: this.#narrow(raw.rowid) }
      }
      return out
    }
    if (raw.partial) {
      const pk: ValueRow = {}
      for (let i = 0; i < meta.pkIndexes.length; i++) {
        const name = meta.columns[meta.pkIndexes[i] as number]
        if (name !== undefined) pk[name] = vals[i] as SqliteValue
      }
      if (meta.pkIndexes.length > 0) out.pk = pk
      return out
    }
    if (meta.pkIndexes.length > 0 && vals.length >= meta.columns.length) {
      const pk: ValueRow = {}
      for (const i of meta.pkIndexes) {
        const name = meta.columns[i]
        if (name !== undefined) pk[name] = vals[i] as SqliteValue
      }
      out.pk = pk
    }
    if (raw.emitRow) {
      const row = this.#toObject(meta, vals)
      if (raw.op === "delete") out.old = row
      else out.row = row
    }
    if (raw.emitOld && raw.prev !== null) out.old = this.#toObject(meta, raw.prev)
    return out
  }

  /** Matches the driver's own rule: an integer stays a number unless it needs to be a bigint. */
  #narrow(value: bigint): SqliteValue {
    if (this.db.safeIntegers) return value
    return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value
  }

  #toObject(meta: TableMeta, vals: SqliteValue[]): ValueRow {
    const out: ValueRow = {}
    for (let i = 0; i < vals.length; i++) {
      out[meta.columns[i] ?? `column${i}`] = vals[i] as SqliteValue
    }
    return out
  }

  #metaFor(table: string): TableMeta | null {
    const hit = this.#meta.get(table)
    if (hit !== undefined) return hit
    let meta: TableMeta | null = null
    try {
      meta = this.hub.bypass(() => this.#loadMeta(table))
    } catch {
      meta = null
    }
    this.#meta.set(table, meta)
    return meta
  }

  #loadMeta(table: string): TableMeta | null {
    const info = this.#tableInfo(table)
    if (info.length === 0) return null
    const columns: string[] = []
    const pkIndexes: number[] = []
    let alias: string | null = null
    let pkCount = 0
    for (const row of info) {
      const cid = Number(row.cid ?? columns.length)
      const name = String(row.name ?? `column${cid}`)
      columns[cid] = name
      const pk = Number(row.pk ?? 0)
      if (pk > 0) {
        pkIndexes.push(cid)
        pkCount++
        if (String(row.type ?? "").toUpperCase() === "INTEGER") alias = name
      }
    }
    for (let i = 0; i < columns.length; i++) if (columns[i] === undefined) columns[i] = `column${i}`
    const withoutRowid = this.#isWithoutRowid(table)
    return {
      columns,
      pkIndexes,
      withoutRowid,
      rowidAlias: !withoutRowid && pkCount === 1 ? alias : null,
    }
  }

  #tableInfo(table: string): Record<string, SqliteValue>[] {
    if (this.#tableFn !== false) {
      try {
        const rows = this.db
          .prepare("select cid, name, type, pk from pragma_table_info(?)")
          .all(table) as Record<string, SqliteValue>[]
        this.#tableFn = true
        return rows
      } catch {
        this.#tableFn = false
      }
    }
    return this.db.prepare(`pragma table_info(${quoteIdent(table)})`).all() as Record<
      string,
      SqliteValue
    >[]
  }

  #isWithoutRowid(table: string): boolean {
    try {
      const row = this.db.prepare("select wr from pragma_table_list where name = ?").get(table)
      if (row) return Number(row.wr ?? 0) === 1
    } catch {
      // Older libsqlite3 without pragma_table_list: probe for the rowid column instead.
    }
    try {
      this.db.prepare(`select rowid from ${quoteIdent(table)} limit 0`).finalize()
      return false
    } catch {
      return true
    }
  }

  /** True when the schema cookie moved since the last call; clears the metadata cache if so. */
  #schemaMoved(): boolean {
    let cookie: number | null = null
    try {
      cookie = this.hub.bypass(() => {
        const row = this.db.prepare("pragma schema_version").get()
        return row ? Number(row.schema_version ?? 0) : null
      })
    } catch {
      return false
    }
    if (cookie === null) return false
    const before = this.#schemaCookie
    this.#schemaCookie = cookie
    if (before === null || before === cookie) return false
    this.#meta.clear()
    this.#shadows = null
    return true
  }
}
