// Invariant: a live query re-runs only when a commit's write-set intersects its read-set, and
// emits only when the result actually changed. Intersection is column-precise when both sides
// know their columns and falls back to the whole table otherwise — over-invalidation costs a
// query, under-invalidation would cost correctness, so every unknown resolves to "affected".
//
// This registry never touches the connection to run a query: the route layer hands it an
// `execute` that already carries the principal's policy, timeout and row mode.

import type {
  ArrayRow,
  Args,
  LiveDiffEvent,
  LiveRowsEvent,
  ObjectRow,
  ResultRows,
  Value,
} from "../client/protocol.ts"
import { BunQLError } from "../server/errors.ts"
import type { EncodedRows } from "../server/json.ts"
import type { Database } from "../sqlite/index.ts"
import type { AuthorizerHub } from "./authorizer.ts"
import type { TxnChanges } from "./capture.ts"
import { readSetOf, readSetTouched, type ReadSet } from "./readset.ts"

export type LiveEvent = LiveRowsEvent | LiveDiffEvent
export type LiveExecute = (sql: string, args: Args | undefined) => EncodedRows
export type Scheduler = (run: () => void) => void

type AnyRow = ArrayRow | ObjectRow

export interface LiveSubscribeOptions {
  sql: string
  args?: Args
  /** Result column identifying a row; switches the feed from `rows` to `diff` after the first. */
  key?: string
  maxRows?: number
  /** Runs this subscription under its own principal's policy, instead of the default runner. */
  principalRunner?: LiveExecute
}

export interface LiveQueryRegistryOptions {
  db: Database
  execute: LiveExecute
  hub?: AuthorizerHub
  /** Subscriptions allowed on this database. Default 1000. */
  maxLiveQueries?: number
  /** Rows per result before the event is marked `truncated`. Default 1000. */
  maxRows?: number
  /** Coalescing window. Default `queueMicrotask`. */
  schedule?: Scheduler
  onEvent?: (id: string, event: LiveEvent) => void
  onError?: (id: string, error: unknown) => void
}

interface PrevRow {
  json: string
  key: Value
}

interface Sub {
  id: string
  sql: string
  args: Args | undefined
  key: string | null
  keyIndex: number
  maxRows: number
  execute: LiveExecute
  readSet: ReadSet
  hash: bigint | null
  prev: Map<string, PrevRow> | null
  started: boolean
  /** Row mode of the last result, so `removed` key rows keep the shape of the feed. */
  objectMode: boolean
}

/** A stable string for a key value, including the tagged forms of the JSON codec. */
function keyString(value: Value): string {
  if (value === null) return "0"
  switch (typeof value) {
    case "string":
      return `s${value}`
    case "number":
      return `n${value}`
    case "boolean":
      return `b${value}`
    default:
      break
  }
  if ("$i" in value) return `i${value.$i}`
  if ("$b" in value) return `x${value.$b}`
  return `f${value.$f}`
}

function isObjectRow(row: AnyRow): row is ObjectRow {
  return !Array.isArray(row)
}

export class LiveQueryRegistry {
  readonly db: Database
  readonly maxLiveQueries: number
  readonly defaultMaxRows: number

  #execute: LiveExecute
  #hub: AuthorizerHub | undefined
  #schedule: Scheduler
  #onEvent: ((id: string, event: LiveEvent) => void) | undefined
  #onError: ((id: string, error: unknown) => void) | undefined

  #subs = new Map<string, Sub>()
  #byTable = new Map<string, Set<string>>()
  #pending = new Set<string>()
  #pendingTxid = 0
  #scheduled = false
  #nextId = 1
  #runs = 0

  constructor(options: LiveQueryRegistryOptions) {
    this.db = options.db
    this.#execute = options.execute
    this.#hub = options.hub
    this.maxLiveQueries = options.maxLiveQueries ?? 1000
    this.defaultMaxRows = options.maxRows ?? 1000
    this.#schedule = options.schedule ?? queueMicrotask
    this.#onEvent = options.onEvent
    this.#onError = options.onError
  }

  get size(): number {
    return this.#subs.size
  }

  /** Number of query executions this registry has driven; a coalescing check for tests. */
  get runCount(): number {
    return this.#runs
  }

  get tables(): IterableIterator<string> {
    return this.#byTable.keys()
  }

  /**
   * Registers a live query. The read-set comes from preparing the statement, which also rejects
   * anything that writes and gives the result columns a `key` is checked against.
   */
  subscribe(options: LiveSubscribeOptions): string {
    if (this.#subs.size >= this.maxLiveQueries) {
      throw new BunQLError(
        "TOO_MANY_REQUESTS",
        `this database already has ${this.maxLiveQueries} live queries`,
      )
    }
    const readSet = readSetOf(this.db, options.sql, this.#hub ? { hub: this.#hub } : {})
    if (readSet.writesDetected) {
      throw BunQLError.badRequest("a live query must be read-only")
    }
    if (readSet.columns.length === 0) {
      throw BunQLError.badRequest("a live query must return rows")
    }
    let keyIndex = -1
    if (options.key !== undefined) {
      keyIndex = readSet.columns.indexOf(options.key)
      if (keyIndex < 0) {
        throw BunQLError.badRequest(
          `key ${JSON.stringify(options.key)} is not one of the result columns: ${readSet.columns.join(", ")}`,
        )
      }
    }
    const id = `s${this.#nextId++}`
    const sub: Sub = {
      id,
      sql: options.sql,
      args: options.args,
      key: options.key ?? null,
      keyIndex,
      maxRows: options.maxRows ?? this.defaultMaxRows,
      execute: options.principalRunner ?? this.#execute,
      readSet,
      hash: null,
      prev: null,
      started: false,
      objectMode: false,
    }
    this.#subs.set(id, sub)
    for (const table of readSet.tables.keys()) {
      let set = this.#byTable.get(table)
      if (!set) {
        set = new Set()
        this.#byTable.set(table, set)
      }
      set.add(id)
    }
    return id
  }

  unsubscribe(id: string): boolean {
    const sub = this.#subs.get(id)
    if (!sub) return false
    this.#subs.delete(id)
    this.#pending.delete(id)
    for (const table of sub.readSet.tables.keys()) {
      const set = this.#byTable.get(table)
      if (!set) continue
      set.delete(id)
      if (set.size === 0) this.#byTable.delete(table)
    }
    return true
  }

  has(id: string): boolean {
    return this.#subs.has(id)
  }

  readSetOfSub(id: string): ReadSet | null {
    return this.#subs.get(id)?.readSet ?? null
  }

  /** Subscriptions a committed transaction could have changed the result of. */
  invalidate(changes: TxnChanges, txid: number): Set<string> {
    const affected = new Set<string>()
    if (txid > this.#pendingTxid) this.#pendingTxid = txid
    if (changes.schemaChanged) {
      for (const id of this.#subs.keys()) affected.add(id)
      return affected
    }
    for (const [table, change] of changes.tables) {
      const subs = this.#byTable.get(table)
      if (!subs) continue
      for (const id of subs) {
        if (affected.has(id)) continue
        const sub = this.#subs.get(id)
        if (sub && readSetTouched(sub.readSet, table, change.columns)) affected.add(id)
      }
    }
    return affected
  }

  /**
   * Every subscription, as "assume this commit touched everything". A replica has no preupdate
   * hooks — its pages arrive as WAL frames, not as rows — so `applyRecord` cannot say which tables
   * moved and the honest answer is all of them. Over-invalidation costs a query per live
   * subscription per applied transaction; under-invalidation would cost correctness.
   */
  invalidateAll(txid: number): Set<string> {
    if (txid > this.#pendingTxid) this.#pendingTxid = txid
    return new Set(this.#subs.keys())
  }

  /**
   * Queues `ids` for a re-run at the end of this tick. Several commits in one tick collapse into
   * one run per subscription.
   */
  scheduleRuns(ids: Iterable<string>, txid?: number): void {
    if (txid !== undefined && txid > this.#pendingTxid) this.#pendingTxid = txid
    let queued = false
    for (const id of ids) {
      if (!this.#subs.has(id)) continue
      this.#pending.add(id)
      queued = true
    }
    if (!queued || this.#scheduled) return
    this.#scheduled = true
    this.#schedule(() => this.flush())
  }

  /** Runs everything queued now, rather than waiting for the scheduler. */
  flush(): void {
    this.#scheduled = false
    if (this.#pending.size === 0) return
    const ids = [...this.#pending]
    this.#pending.clear()
    const txid = this.#pendingTxid
    for (const id of ids) {
      try {
        const event = this.run(id, txid)
        if (event) this.#onEvent?.(id, event)
      } catch (error) {
        if (this.#onError) this.#onError(id, error)
        else throw error
      }
    }
  }

  /** Runs one subscription and returns its event, or null when the result is unchanged. */
  run(id: string, txid = this.#pendingTxid): LiveEvent | null {
    const sub = this.#subs.get(id)
    if (!sub) return null
    this.#runs++
    const result = sub.execute(sub.sql, sub.args)
    let rows = result.rows as AnyRow[]
    let truncated = false
    if (rows.length > sub.maxRows) {
      rows = rows.slice(0, sub.maxRows)
      truncated = true
    }
    const hash = Bun.hash.xxHash3(`${result.columns.join(" ")}${JSON.stringify(rows)}`)
    if (sub.started && sub.hash === hash) return null
    sub.hash = hash
    const first = !sub.started
    sub.started = true

    if (sub.key === null) {
      const event: LiveRowsEvent = {
        txid,
        columns: result.columns,
        types: result.types,
        rows: rows as ResultRows,
      }
      if (truncated) event.truncated = true
      return event
    }

    const next = new Map<string, PrevRow>()
    const added: AnyRow[] = []
    const updated: AnyRow[] = []
    const keyName = sub.key
    for (const row of rows) {
      const value = (isObjectRow(row) ? row[keyName] : row[sub.keyIndex]) ?? null
      const ks = keyString(value)
      const json = JSON.stringify(row)
      next.set(ks, { json, key: value })
      const before = sub.prev?.get(ks)
      if (!before) added.push(row)
      else if (before.json !== json) updated.push(row)
    }
    if (rows.length > 0) sub.objectMode = isObjectRow(rows[0] as AnyRow)
    const removed: AnyRow[] = []
    if (sub.prev) {
      for (const [ks, before] of sub.prev) {
        if (next.has(ks)) continue
        removed.push(sub.objectMode ? { [keyName]: before.key } : [before.key])
      }
    }
    sub.prev = next

    if (first) {
      const event: LiveRowsEvent = {
        txid,
        columns: result.columns,
        types: result.types,
        rows: rows as ResultRows,
      }
      if (truncated) event.truncated = true
      return event
    }
    const event: LiveDiffEvent = {
      txid,
      added: added as ResultRows,
      removed: removed as ResultRows,
      updated: updated as ResultRows,
    }
    if (truncated) event.truncated = true
    return event
  }

  clear(): void {
    this.#subs.clear()
    this.#byTable.clear()
    this.#pending.clear()
    this.#scheduled = false
  }
}
