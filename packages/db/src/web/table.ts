// `table()` (docs/plan-web.md): a collection of JSON documents that is a real SQLite table, so
// table modes, CHECK constraints and raw SQL all see the same thing. Every field name and value
// reaches SQL as a bound parameter — `json_extract(data, ?)` with the path bound — so nothing a
// page passes is ever spliced into SQL except the table name, which is checked and quoted.

import type { JsRow } from "../client/values.ts"

/** The columns every `table()` has. `data` holds the document minus these three. */
export const TABLE_COLUMNS = "id, data, created_at, updated_at"
/** A shared table's, which add the visitor who wrote the row (`sharedTableSql`). */
export const SHARED_COLUMNS = "id, author, data, created_at, updated_at"

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Doc = Record<string, unknown>
/** A stored document: its fields, plus the three the table keeps for it. */
export type Row<T extends Doc = Doc> = T & { id: string; createdAt: number; updatedAt: number }
/** A row of a shared table: also the `sub` of the visitor who wrote it (`db.author` is yours). */
export type SharedRow<T extends Doc = Doc> = Row<T> & { author: string }
/** Equality on top-level or dotted fields: `{ done: false, "author.name": "ann" }`. */
export type Filter = Record<string, string | number | boolean | null>
export type Direction = "asc" | "desc"

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const RESERVED = new Set(["id", "createdAt", "updatedAt"])
const SHARED_RESERVED = new Set([...RESERVED, "author"])
const COLUMN_OF: Record<string, string> = { id: "id", createdAt: "created_at", updatedAt: "updated_at" }
/** `author` is a column only in a shared table; in a private one it is an ordinary field. */
const SHARED_COLUMN_OF: Record<string, string> = { ...COLUMN_OF, author: "author" }
const NOW_MS = "cast(unixepoch('subsec') * 1000 as integer)"

export function assertTableName(name: string): void {
  if (!NAME.test(name)) {
    throw new TypeError(`table name ${JSON.stringify(name)} must be a plain identifier ([A-Za-z_][A-Za-z0-9_]*)`)
  }
}

function assertField(field: string): void {
  if (!FIELD.test(field)) {
    throw new TypeError(`field ${JSON.stringify(field)} must be a name or a dotted path of names`)
  }
}

export function createTableSql(name: string): string {
  return `create table if not exists "${name}" (
  id text primary key,
  data text not null check (json_valid(data)),
  created_at integer not null default (${NOW_MS}),
  updated_at integer not null default (${NOW_MS})
) strict`
}

/**
 * A `table()` in the app's shared database, created by the owner (`bql app table`), never by a
 * page. `author` is the visitor's `sub`: filled in by `bql_sub()`, checked against it, and the
 * triggers let only the author change or remove a row. The admin (`bql_sub()` is NULL) passes
 * every check and must name an author itself.
 */
export function sharedTableSql(name: string): string[] {
  assertTableName(name)
  return [
    `create table if not exists "${name}" (
  id text primary key,
  author text not null default (bql_sub()) check (bql_sub() is null or author = bql_sub()),
  data text not null check (json_valid(data)),
  created_at integer not null default (${NOW_MS}),
  updated_at integer not null default (${NOW_MS})
) strict`,
    `create trigger if not exists "${name}_author_update" before update on "${name}"
when bql_sub() is not null and old.author is not bql_sub()
begin select raise(abort, 'only the author can change this row'); end`,
    `create trigger if not exists "${name}_author_delete" before delete on "${name}"
when bql_sub() is not null and old.author is not bql_sub()
begin select raise(abort, 'only the author can remove this row'); end`,
    // `id` is the only unique key, so with it fixed an UPDATE OR REPLACE has no other row to
    // replace. INSERT OR REPLACE is refused by the policy, since it skips DELETE triggers.
    `create trigger if not exists "${name}_id_fixed" before update of id on "${name}"
when bql_sub() is not null and new.id is not old.id
begin select raise(abort, 'a row id cannot change'); end`,
  ]
}

/** A statement as the client's template tag takes it: the SQL split at each bound value. */
export interface Statement {
  strings: string[]
  values: unknown[]
}

function statement(parts: (string | { value: unknown })[]): Statement {
  const strings = [""]
  const values: unknown[] = []
  for (const part of parts) {
    if (typeof part === "string") strings[strings.length - 1] += part
    else {
      values.push(part.value)
      strings.push("")
    }
  }
  return { strings, values }
}

const bind = (value: unknown) => ({ value })

/** An RFC 9562 version 7 UUID: time-ordered, so ids sort roughly by creation. */
export function uuidv7(nowMs = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let ms = nowMs
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms & 0xff
    ms = Math.floor(ms / 256)
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A stored row back into the document the page put in. */
export function toRow<T extends Doc>(raw: JsRow): Row<T> {
  const data = JSON.parse(String(raw.data)) as T
  const row = { ...data, id: String(raw.id), createdAt: Number(raw.created_at), updatedAt: Number(raw.updated_at) }
  return "author" in raw ? { ...row, author: String(raw.author) } : row
}

/** The document minus the fields the table keeps itself, as the JSON stored in `data`. */
function dataOf(doc: Doc, shared: boolean): string {
  const reserved = shared ? SHARED_RESERVED : RESERVED
  const out: Doc = {}
  for (const [key, value] of Object.entries(doc)) {
    if (!reserved.has(key)) out[key] = value
  }
  return JSON.stringify(out)
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

export interface ReadShape {
  where: [field: string, value: string | number | boolean | null][]
  order: [field: string, direction: Direction][]
  limit: number | null
}

export const EMPTY_SHAPE: ReadShape = { where: [], order: [], limit: null }

function valueOf(field: string, shared: boolean) {
  const column = (shared ? SHARED_COLUMN_OF : COLUMN_OF)[field]
  return column ? [column] : ["json_extract(data, ", bind(`$.${field}`), ")"]
}

export function selectSql(table: string, shape: ReadShape, shared = false): Statement {
  const parts: (string | { value: unknown })[] = [`select ${shared ? SHARED_COLUMNS : TABLE_COLUMNS} from "${table}"`]
  shape.where.forEach(([field, value], i) => {
    parts.push(i === 0 ? " where " : " and ", ...valueOf(field, shared))
    if (value === null) parts.push(" is null")
    // JSON `true`/`false` come out of `json_extract` as 1 and 0.
    else parts.push(" = ", bind(typeof value === "boolean" ? (value ? 1 : 0) : value))
  })
  parts.push(" order by ")
  for (const [field, direction] of shape.order) parts.push(...valueOf(field, shared), ` ${direction}, `)
  // Ties always fall back to creation order, so the server's order and `compareRows` agree.
  parts.push("created_at, id")
  if (shape.limit !== null) parts.push(" limit ", bind(shape.limit))
  return statement(parts)
}

function fieldOf(row: Row, field: string): unknown {
  if (field in COLUMN_OF || field === "author") return row[field]
  let value: unknown = row
  for (const key of field.split(".")) {
    value = value !== null && typeof value === "object" ? (value as Doc)[key] : undefined
  }
  return value
}

/** SQLite's order for the values `json_extract` returns: NULL, numbers, text, then the rest. */
function rank(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "number" || typeof value === "boolean") return 1
  if (typeof value === "string") return 2
  return 3
}

function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 1) return Number(a) - Number(b)
  if (ra === 2) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0
  if (ra === 3) {
    const ja = JSON.stringify(a)
    const jb = JSON.stringify(b)
    return ja < jb ? -1 : ja > jb ? 1 : 0
  }
  return 0
}

/** The client-side twin of `selectSql`'s ORDER BY, for re-sorting after a live diff. */
export function compareRows(order: ReadShape["order"]): (a: Row, b: Row) => number {
  return (a, b) => {
    for (const [field, direction] of order) {
      const c = compareValues(fieldOf(a, field), fieldOf(b, field))
      if (c !== 0) return direction === "desc" ? -c : c
    }
    return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }
}

// ── the builder ────────────────────────────────────────────────────────────────────────────────

/** What a view needs from the connection: run a statement, and subscribe to one. */
export interface TableHost {
  /** A table in the app's shared database: it has `author`, and the page never creates it. */
  readonly shared: boolean
  run(statement: Statement): Promise<JsRow[]>
  live(statement: Statement, onRows: (rows: JsRow[]) => void, onDiff: (diff: LiveDiff) => void, onError: (err: unknown) => void): () => void
  /** Creates the table once per connection; every other call awaits the same promise. */
  ensure(table: string): Promise<void>
}

export interface LiveDiff {
  added: JsRow[]
  removed: JsRow[]
  updated: JsRow[]
}

/** A filtered, ordered, limited read of a table. Each method returns a new view. */
export class View<T extends Doc = Doc> {
  protected readonly host: TableHost
  readonly name: string
  protected readonly shape: ReadShape

  constructor(host: TableHost, name: string, shape: ReadShape = EMPTY_SHAPE) {
    assertTableName(name)
    this.host = host
    this.name = name
    this.shape = shape
  }

  where(filter: Filter): View<T> {
    const where = [...this.shape.where]
    for (const [field, value] of Object.entries(filter)) {
      assertField(field)
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
        throw new TypeError(`where() compares ${field} to a string, number, boolean or null`)
      }
      where.push([field, value])
    }
    return new View<T>(this.host, this.name, { ...this.shape, where })
  }

  orderBy(field: string, direction: Direction = "asc"): View<T> {
    assertField(field)
    if (direction !== "asc" && direction !== "desc") throw new TypeError('direction is "asc" or "desc"')
    return new View<T>(this.host, this.name, { ...this.shape, order: [...this.shape.order, [field, direction]] })
  }

  limit(count: number): View<T> {
    if (!Number.isInteger(count) || count < 0) throw new TypeError("limit() takes a non-negative integer")
    return new View<T>(this.host, this.name, { ...this.shape, limit: count })
  }

  async list(): Promise<Row<T>[]> {
    await this.host.ensure(this.name)
    return (await this.host.run(selectSql(this.name, this.shape, this.host.shared))).map((raw) => toRow<T>(raw))
  }

  /**
   * Calls `onChange` with the whole result now and after every commit that changes it. Diffs are
   * merged and re-sorted here, so the callback always gets the full, ordered list. Returns the
   * function that stops it.
   */
  live(onChange: (rows: Row<T>[]) => void, onError?: (err: unknown) => void): () => void {
    let stop: (() => void) | null = null
    let stopped = false
    const rows = new Map<string, Row<T>>()
    const sort = compareRows(this.shape.order)
    const limit = this.shape.limit
    const emit = () => {
      const list = [...rows.values()].sort(sort)
      onChange(limit === null ? list : list.slice(0, limit))
    }
    const fail = onError ?? ((err: unknown) => console.error("bql: live table", err))
    this.host
      .ensure(this.name)
      .then(() => {
        if (stopped) return
        stop = this.host.live(
          selectSql(this.name, this.shape, this.host.shared),
          (raw) => {
            rows.clear()
            for (const one of raw) {
              const row = toRow<T>(one)
              rows.set(row.id, row)
            }
            emit()
          },
          (diff) => {
            for (const key of diff.removed) rows.delete(String(key.id))
            for (const one of [...diff.added, ...diff.updated]) {
              const row = toRow<T>(one)
              rows.set(row.id, row)
            }
            emit()
          },
          fail,
        )
      })
      .catch(fail)
    return () => {
      stopped = true
      stop?.()
    }
  }
}

/** A table: a view with no filter, plus the writes. */
export class Table<T extends Doc = Doc> extends View<T> {
  get #columns(): string {
    return this.host.shared ? SHARED_COLUMNS : TABLE_COLUMNS
  }

  /** Inserts a document. `id` is kept when given and is a UUIDv7 otherwise. */
  async insert(doc: T & { id?: string }): Promise<Row<T>> {
    const id = typeof doc.id === "string" && doc.id.length > 0 ? doc.id : uuidv7()
    await this.host.ensure(this.name)
    const [raw] = await this.host.run(
      statement([
        `insert into "${this.name}" (id, data) values (`,
        bind(id),
        ", ",
        bind(dataOf(doc, this.host.shared)),
        `) returning ${this.#columns}`,
      ]),
    )
    return toRow<T>(raw as JsRow)
  }

  async get(id: string): Promise<Row<T> | null> {
    await this.host.ensure(this.name)
    const [raw] = await this.host.run(statement([`select ${this.#columns} from "${this.name}" where id = `, bind(id)]))
    return raw ? toRow<T>(raw) : null
  }

  /**
   * Merges `patch` into the document (RFC 7396, `json_patch`): a key set to `null` is removed,
   * nested objects merge, arrays are replaced. Returns the new row, or null when `id` is missing.
   */
  async update(id: string, patch: Partial<T>): Promise<Row<T> | null> {
    await this.host.ensure(this.name)
    const [raw] = await this.host.run(
      statement([
        `update "${this.name}" set data = json_patch(data, `,
        bind(dataOf(patch as Doc, this.host.shared)),
        `), updated_at = ${NOW_MS} where id = `,
        bind(id),
        ` returning ${this.#columns}`,
      ]),
    )
    return raw ? toRow<T>(raw) : null
  }

  /** Returns false when there was no such row. */
  async delete(id: string): Promise<boolean> {
    await this.host.ensure(this.name)
    const rows = await this.host.run(statement([`delete from "${this.name}" where id = `, bind(id), " returning id"]))
    return rows.length > 0
  }
}
