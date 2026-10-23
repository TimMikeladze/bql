// `db.state()` (docs/plan-web.md): the page's state as one object it mutates in place, kept in the
// visitor's database and in step across tabs. One row per top-level key in `bql_state`.
//
// Mutations become JSON operations on the server rather than a rewrite of the whole object:
// assigning a field is `json_set`, `push` is `json_insert(…, '$[#]')`, `delete` is `json_remove`.
// So two tabs pushing to the same list both land. Anything else that changes an array (splice,
// sort, a shorter `length`) writes that array whole: last writer wins for that array. Writes made
// in one turn of the event loop go out together, after it.

import type { JsRow } from "../client/values.ts"
import type { LiveDiff, Statement } from "./table.ts"

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export const STATE_TABLE = "bql_state"
const NOW_MS = "cast(unixepoch('subsec') * 1000 as integer)"

export const STATE_TABLE_SQL = `create table if not exists ${STATE_TABLE} (
  key text primary key,
  value text not null check (json_valid(value)),
  updated_at integer not null default (${NOW_MS})
) strict`

/** What the store needs from the connection. */
export interface StateHost {
  run(statement: Statement): Promise<JsRow[]>
  live(statement: Statement, onRows: (rows: JsRow[]) => void, onDiff: (diff: LiveDiff) => void, onError: (err: unknown) => void): () => void
  report(err: unknown): void
}

/** The root object `db.state()` resolves with: your fields, plus these. */
export interface StateApi<T> {
  /** `change` after every local or remote change; `error` when a write fails. Returns `off`. */
  $on(event: "change", listener: (state: T) => void): () => void
  $on(event: "error", listener: (err: unknown) => void): () => void
  /** Resolves when every write made so far has been committed. */
  readonly $saved: Promise<void>
  /** Stops following other tabs. Writes already made still go out. */
  $close(): void
}

export type State<T> = T & StateApi<T>

type Segment = string | number
type Op =
  | { kind: "set"; path: Segment[] }
  | { kind: "append"; path: Segment[]; value: Json }
  | { kind: "remove"; path: Segment[] }

function sql(text: string, ...values: unknown[]): Statement {
  const strings = text.split("?")
  if (strings.length !== values.length + 1) throw new Error("placeholder count")
  return { strings, values }
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** A JSON path SQLite reads: `$."todos"[3]."title"`. */
function jsonPath(segments: Segment[]): string {
  let out = "$"
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`
    else {
      if (segment.includes('"')) throw new TypeError(`state keys may not contain '"': ${segment}`)
      out += `."${segment}"`
    }
  }
  return out
}

function isPrefix(prefix: Segment[], path: Segment[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => String(segment) === String(path[i]))
}

function valueAt(root: Record<string, unknown>, path: Segment[]): unknown {
  let value: unknown = root
  for (const segment of path) value = (value as Record<string, unknown>)?.[segment as string]
  return value
}

export class StateStore<T extends Record<string, Json>> {
  readonly #host: StateHost
  readonly #defaults: T
  readonly #raw: Record<string, Json>
  readonly #root: State<T>
  #ops: Op[] = []
  #flushing: Promise<void> = Promise.resolve()
  #scheduled = false
  /** Keys with a write queued or in flight: live echoes for them are ignored until it lands. */
  readonly #busy = new Map<string, number>()
  readonly #listeners = { change: new Set<(state: T) => void>(), error: new Set<(err: unknown) => void>() }
  #stop: (() => void) | null = null
  #changeQueued = false

  constructor(host: StateHost, defaults: T) {
    this.#host = host
    this.#defaults = clone(defaults)
    this.#raw = clone(defaults)
    this.#root = this.#wrap(this.#raw, []) as State<T>
  }

  get root(): State<T> {
    return this.#root
  }

  async open(): Promise<void> {
    await this.#host.run(sql(STATE_TABLE_SQL))
    for (const row of await this.#host.run(sql(`select key, value from ${STATE_TABLE}`))) {
      this.#raw[String(row.key)] = JSON.parse(String(row.value)) as Json
    }
    this.#stop = this.#host.live(
      sql(`select key, value from ${STATE_TABLE}`),
      (rows) => {
        for (const row of rows) this.#remote(String(row.key), String(row.value))
        this.#changed()
      },
      (diff) => {
        for (const row of [...diff.added, ...diff.updated]) this.#remote(String(row.key), String(row.value))
        for (const row of diff.removed) this.#remote(String(row.key), null)
        this.#changed()
      },
      (err) => this.#error(err),
    )
  }

  close(): void {
    this.#stop?.()
    this.#stop = null
  }

  // ── remote ───────────────────────────────────────────────────────────────────────────────────

  #remote(key: string, value: string | null): void {
    if ((this.#busy.get(key) ?? 0) > 0) return
    if (value === null) {
      if (key in this.#defaults) this.#raw[key] = clone(this.#defaults[key] as Json)
      else delete this.#raw[key]
    } else {
      this.#raw[key] = JSON.parse(value) as Json
    }
  }

  // ── local ────────────────────────────────────────────────────────────────────────────────────

  #wrap(target: object, path: Segment[]): unknown {
    return new Proxy(target, {
      get: (t, prop, receiver) => {
        if (typeof prop === "symbol") return Reflect.get(t, prop, receiver)
        if (path.length === 0) {
          if (prop === "$on") return (event: "change" | "error", listener: never) => this.#on(event, listener)
          if (prop === "$saved") return this.#saved()
          if (prop === "$close") return () => this.close()
        }
        const value = Reflect.get(t, prop, receiver)
        if (value !== null && typeof value === "object") {
          return this.#wrap(value as object, [...path, Array.isArray(t) ? Number(prop) : prop])
        }
        return value
      },
      set: (t, prop, value) => {
        if (typeof prop === "symbol") return Reflect.set(t, prop, value)
        if (path.length === 0 && prop.startsWith("$")) throw new TypeError(`state keys may not start with "$": ${prop}`)
        const stored = clone(value) as Json
        if (Array.isArray(t)) {
          if (prop === "length") {
            if (Number(value) !== t.length) this.#queue({ kind: "set", path })
          } else if (/^\d+$/.test(prop) && Number(prop) === t.length) {
            this.#queue({ kind: "append", path, value: stored })
          } else {
            this.#queue({ kind: "set", path })
          }
        } else {
          this.#queue({ kind: "set", path: [...path, prop] })
        }
        return Reflect.set(t, prop, stored)
      },
      deleteProperty: (t, prop) => {
        if (typeof prop === "symbol") return Reflect.deleteProperty(t, prop)
        if (Array.isArray(t)) this.#queue({ kind: "set", path })
        else this.#queue({ kind: "remove", path: [...path, prop] })
        return Reflect.deleteProperty(t, prop)
      },
    })
  }

  #queue(op: Op): void {
    if (op.path.length === 0) return // only fields of the root are stored, never the root itself
    const key = String(op.path[0])
    this.#busy.set(key, (this.#busy.get(key) ?? 0) + 1)
    this.#ops.push(op)
    this.#changed()
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      const ops = this.#ops
      this.#ops = []
      this.#flushing = this.#flushing.then(() => this.#flush(ops))
    })
  }

  /** One statement per surviving op, in order; an op under a path written whole is dropped. */
  async #flush(ops: Op[]): Promise<void> {
    const whole = ops.filter((op) => op.kind !== "append").map((op) => op.path)
    const statements: Statement[] = []
    const seen = new Set<string>()
    const created = new Set<string>()
    for (const op of ops) {
      const covered = whole.some((path) => path !== op.path && path.length <= op.path.length && isPrefix(path, op.path) && (op.kind === "append" || path.length < op.path.length))
      if (covered) continue
      const id = `${op.kind}:${jsonPath(op.path)}`
      if (op.kind !== "append" && seen.has(id)) continue
      seen.add(id)
      const key = String(op.path[0])
      // A nested write or a push needs the row. A missing one starts from the default, which is
      // what this key holds for a key never written; the local value would already carry this
      // batch's pushes, and the json_insert below would add them a second time.
      if (op.path.length > 1 || op.kind === "append") {
        if (!created.has(key)) {
          created.add(key)
          statements.push(
            sql(
              `insert into ${STATE_TABLE} (key, value) values (?, ?) on conflict(key) do nothing`,
              key,
              JSON.stringify(this.#defaults[key] ?? null),
            ),
          )
        }
      }
      statements.push(this.#statement(op))
    }
    const keys = ops.map((op) => String(op.path[0]))
    try {
      for (const statement of statements) await this.#host.run(statement)
    } catch (err) {
      this.#error(err)
    } finally {
      for (const key of keys) {
        const left = (this.#busy.get(key) ?? 1) - 1
        if (left > 0) this.#busy.set(key, left)
        else this.#busy.delete(key)
      }
      // Another tab's write to one of these keys may have arrived and been ignored meanwhile.
      await this.#reread([...new Set(keys)].filter((key) => !this.#busy.has(key)))
    }
  }

  #statement(op: Op): Statement {
    const key = String(op.path[0])
    const rest = op.path.slice(1)
    const update = `update ${STATE_TABLE} set updated_at = ${NOW_MS}, value = `
    if (op.kind === "remove") {
      if (rest.length === 0) return sql(`delete from ${STATE_TABLE} where key = ?`, key)
      return sql(`${update}json_remove(value, ?) where key = ?`, jsonPath(rest), key)
    }
    if (op.kind === "append") {
      return sql(`${update}json_insert(value, ?, json(?)) where key = ?`, `${jsonPath(rest)}[#]`, JSON.stringify(op.value), key)
    }
    if (rest.length === 0) {
      return sql(
        `insert into ${STATE_TABLE} (key, value) values (?, ?) on conflict(key) do update set updated_at = ${NOW_MS}, value = excluded.value`,
        key,
        JSON.stringify(this.#raw[key] ?? null),
      )
    }
    return sql(`${update}json_set(value, ?, json(?)) where key = ?`, jsonPath(rest), JSON.stringify(valueAt(this.#raw, op.path) ?? null), key)
  }

  async #reread(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    let changed = false
    for (const key of keys) {
      try {
        const [row] = await this.#host.run(sql(`select value from ${STATE_TABLE} where key = ?`, key))
        if (row && !this.#busy.has(key)) {
          const next = String(row.value)
          if (JSON.stringify(this.#raw[key]) !== next) {
            this.#raw[key] = JSON.parse(next) as Json
            changed = true
          }
        }
      } catch (err) {
        this.#error(err)
      }
    }
    if (changed) this.#changed()
  }

  #saved(): Promise<void> {
    // A write queued this turn is flushed on the next microtask; wait for that chain too.
    return new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => this.#flushing)
  }

  // ── events ───────────────────────────────────────────────────────────────────────────────────

  #on(event: "change" | "error", listener: (payload: never) => void): () => void {
    const set = this.#listeners[event] as Set<unknown>
    set.add(listener)
    return () => set.delete(listener)
  }

  /** One `change` per turn, however many fields moved in it. */
  #changed(): void {
    if (this.#changeQueued) return
    this.#changeQueued = true
    queueMicrotask(() => {
      this.#changeQueued = false
      for (const listener of this.#listeners.change) listener(this.#root as T)
    })
  }

  #error(err: unknown): void {
    if (this.#listeners.error.size === 0) this.#host.report(err)
    for (const listener of this.#listeners.error) listener(err)
  }
}
