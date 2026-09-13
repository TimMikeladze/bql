// Invariant: one `TenantRealtime` per open database, and it is driven by exactly one call from
// the write path — `afterCommit(txid)`, once the transaction is durable. Everything the hooks
// buffered is materialised there, stamped with that txid, pushed to the ring, fanned out on the
// bus, and turned into live-query re-runs that are coalesced to the end of the tick.
//
// Nothing here knows about HTTP or WebSocket: the route layer subscribes, or hands the bus a
// `Publisher`, and the topic names are already the ones `server.publish` will use.

import type {
  ChangeEvent,
  IncludeLevel,
  IntValue,
  ObjectRow,
  RowChange,
  SchemaEvent,
} from "../client/protocol.ts"
import { encodeInteger, encodeValue } from "../server/json.ts"
import type { Database } from "../sqlite/index.ts"
import type { SqliteValue } from "../sqlite/values.ts"
import { AuthorizerHub } from "./authorizer.ts"
import {
  ChangeCapture,
  type CaptureEngine,
  type CaptureLevel,
  type CapturedRow,
  type TxnChanges,
  type ValueRow,
} from "./capture.ts"
import {
  changesTopic,
  liveTopic,
  RealtimeBus,
  schemaTopic,
  tableTopic,
  type Publisher,
} from "./bus.ts"
import {
  LiveQueryRegistry,
  type LiveEvent,
  type LiveExecute,
  type LiveSubscribeOptions,
  type Scheduler,
} from "./live.ts"
import { ChangeRing, type ChangeRingOptions } from "./ring.ts"

export { AuthorizerHub } from "./authorizer.ts"
export {
  ChangeCapture,
  type CaptureEngine,
  type CaptureLevel,
  type CapturedRow,
  type TableChange,
  type TxnChanges,
} from "./capture.ts"
export {
  changesTopic,
  liveTopic,
  RealtimeBus,
  schemaTopic,
  tableTopic,
  type Publisher,
  type RealtimePayload,
  type TopicListener,
} from "./bus.ts"
export {
  LiveQueryRegistry,
  type LiveEvent,
  type LiveExecute,
  type LiveSubscribeOptions,
  type Scheduler,
} from "./live.ts"
export { readSetOf, readSetTouched, type ReadSet } from "./readset.ts"
export { ChangeRing, type ChangeRingOptions } from "./ring.ts"

/** How much of each row a change subscriber wants; the tenant runs at the highest one asked for. */
export type { IncludeLevel }

const LEVEL_RANK: Readonly<Record<CaptureLevel, number>> = {
  off: 0,
  none: 1,
  pk: 2,
  row: 3,
  "row+old": 4,
}

export interface TenantRealtimeOptions {
  /** Database name, which is what the topics are keyed by. */
  name: string
  /** The tenant's writer connection: the one the hooks attach to. */
  db: Database
  /** Runs a live query with the caller's policy, timeout and row mode already applied. */
  execute: LiveExecute
  /** Shared authorizer hub when the route layer has one; otherwise this creates it. */
  hub?: AuthorizerHub
  /** Level a change subscriber gets when it does not ask for one. Default `"row"`. */
  includeRows?: IncludeLevel
  /** Compare OLD and NEW values so live invalidation is column-precise. Default true. */
  trackColumns?: boolean
  engine?: CaptureEngine | "auto"
  ring?: ChangeRingOptions
  maxLiveQueries?: number
  maxRows?: number
  schedule?: Scheduler
  publisher?: Publisher | null
  /** Uninstall the hooks when the last subscriber leaves. Default true. */
  autoDisable?: boolean
  onError?: (id: string, error: unknown) => void
}

export interface ChangesSubscribeOptions {
  /** Only these tables; every table when absent. */
  tables?: string[]
  /** Replay from this txid. */
  since?: number
  include?: IncludeLevel
  /**
   * DDL on this database, delivered beside the row changes. A table filter does not narrow it:
   * schema changes are a property of the database, and a subscriber watching one table still
   * needs to hear that the table it is watching was altered.
   *
   * There is no backlog for these. The ring holds row changes, so a `since` that the ring can
   * serve replays those and nothing else — a subscriber that was away across a migration learns
   * of it from the first schema event after it reconnects, or by re-reading the schema.
   */
  schema?: (event: SchemaEvent) => void
}

export interface ChangesSubscription {
  sub: string
  /** Events between `since` and now, in order. */
  backlog: ChangeEvent[]
  /** The ring could not serve `since`: the client must re-query before trusting the feed. */
  reset: boolean
}

export interface LiveSubscription {
  sub: string
  /** The result as of now; the first event of a keyed subscription is always a full `rows`. */
  initial: LiveEvent | null
}

export interface CommitReport {
  txid: number
  change: ChangeEvent | null
  schema: SchemaEvent | null
  /** Live subscriptions this commit invalidated. */
  affected: number
  tables: string[]
}

interface ChangeSub {
  id: string
  include: IncludeLevel
  remove: () => void
}

function encodeRow(row: ValueRow): ObjectRow {
  const out: ObjectRow = {}
  for (const key in row) out[key] = encodeValue(row[key] as SqliteValue)
  return out
}

/** Driver-native capture row → the wire shape (design §6.4). */
export function toRowChange(row: CapturedRow): RowChange {
  const change: RowChange = {
    table: row.table,
    op: row.op,
    rowid: row.rowid === null ? null : (encodeInteger(row.rowid) as number | IntValue),
  }
  if (row.pk) change.pk = encodeRow(row.pk)
  if (row.row) change.row = encodeRow(row.row)
  if (row.old) change.old = encodeRow(row.old)
  return change
}

export class TenantRealtime {
  readonly name: string
  readonly db: Database
  readonly hub: AuthorizerHub
  readonly capture: ChangeCapture
  readonly ring: ChangeRing
  readonly bus: RealtimeBus
  readonly live: LiveQueryRegistry

  #defaultInclude: IncludeLevel
  #autoDisable: boolean
  #changeSubs = new Map<string, ChangeSub>()
  #liveSubs = new Map<string, () => void>()
  #nextId = 1
  #txid = 0
  #closed = false

  constructor(options: TenantRealtimeOptions) {
    this.name = options.name
    this.db = options.db
    this.hub = options.hub ?? new AuthorizerHub(options.db)
    this.#defaultInclude = options.includeRows ?? "row"
    this.#autoDisable = options.autoDisable !== false
    this.bus = new RealtimeBus(options.publisher ?? null)
    this.ring = new ChangeRing(options.ring)
    this.capture = new ChangeCapture(options.db, {
      hub: this.hub,
      includeRows: this.#autoDisable ? "off" : this.#defaultInclude,
      trackColumns: options.trackColumns !== false,
      ...(options.engine ? { engine: options.engine } : {}),
    })
    this.live = new LiveQueryRegistry({
      db: options.db,
      execute: options.execute,
      hub: this.hub,
      ...(options.maxLiveQueries !== undefined ? { maxLiveQueries: options.maxLiveQueries } : {}),
      ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      ...(options.schedule ? { schedule: options.schedule } : {}),
      onEvent: (id, event) => {
        this.bus.publish(liveTopic(this.name, id), event)
      },
      ...(options.onError ? { onError: options.onError } : {}),
    })
  }

  get txid(): number {
    return this.#txid
  }

  /** Tells the engine where the database is, before any commit of its own. */
  setTxid(txid: number): void {
    if (txid > this.#txid) this.#txid = txid
  }

  get subscriberCount(): number {
    return this.#changeSubs.size + this.#liveSubs.size
  }

  /**
   * Publishes everything the hooks buffered, stamped with `txid`. Call it once the transaction is
   * durable — never from inside a hook. Any transaction the owner did not drain earlier is folded
   * into this one, so the feed stays ordered and lossless.
   */
  afterCommit(txid: number): CommitReport {
    this.setTxid(txid)
    const drained = this.capture.takeAllCommitted()
    const report: CommitReport = { txid, change: null, schema: null, affected: 0, tables: [] }
    if (drained.length === 0) return report
    const merged = drained.length === 1 ? (drained[0] as TxnChanges) : mergeChanges(drained)
    report.tables = [...merged.tables.keys()]

    if (merged.rows.length > 0) {
      const changes: RowChange[] = new Array(merged.rows.length)
      for (let i = 0; i < merged.rows.length; i++) {
        changes[i] = toRowChange(merged.rows[i] as CapturedRow)
      }
      const event: ChangeEvent = { txid, changes }
      report.change = event
      this.ring.push(txid, event)
      const all = changesTopic(this.name)
      if (this.bus.hasAudience(all)) this.bus.publish(all, event)
      if (merged.tables.size === 1) {
        const table = report.tables[0] as string
        const topic = tableTopic(this.name, table)
        if (this.bus.hasAudience(topic)) this.bus.publish(topic, event)
      } else {
        for (const table of merged.tables.keys()) {
          const topic = tableTopic(this.name, table)
          if (!this.bus.hasAudience(topic)) continue
          const rows = changes.filter((c) => c.table === table)
          this.bus.publish(topic, { txid, changes: rows })
        }
      }
    }

    if (merged.schemaChanged) {
      const event: SchemaEvent = { txid, changes: merged.ddl }
      report.schema = event
      const topic = schemaTopic(this.name)
      if (this.bus.hasAudience(topic)) this.bus.publish(topic, event)
    }

    const affected = this.live.invalidate(merged, txid)
    report.affected = affected.size
    if (affected.size > 0) this.live.scheduleRuns(affected, txid)
    return report
  }

  /**
   * The replica's counterpart to `afterCommit` (design §5.2, `plan-phase1.md` finding 3). A
   * replica's transactions arrive as WAL frames through `Tenant.applyRecord`, so there is no hook
   * buffer to drain and no row-level detail to publish: the change feed gets a `txid`-only event
   * with an empty `changes` array, and every live query is re-run so it converges on the
   * primary's state. Phase 3's logical CDC is what turns the empty array into rows.
   */
  afterApply(txid: number): CommitReport {
    this.setTxid(txid)
    const report: CommitReport = { txid, change: null, schema: null, affected: 0, tables: [] }
    if (this.#closed) return report
    const event: ChangeEvent = { txid, changes: [] }
    report.change = event
    this.ring.push(txid, event)
    const topic = changesTopic(this.name)
    if (this.bus.hasAudience(topic)) this.bus.publish(topic, event)
    const affected = this.live.invalidateAll(txid)
    report.affected = affected.size
    if (affected.size > 0) this.live.scheduleRuns(affected, txid)
    return report
  }

  /** Subscribes to the change feed, optionally replaying from `since`. */
  subscribeChanges(
    options: ChangesSubscribeOptions,
    listener: (event: ChangeEvent) => void,
  ): ChangesSubscription {
    this.#assertOpen()
    const id = `c${this.#nextId++}`
    const topics =
      options.tables && options.tables.length > 0
        ? options.tables.map((t) => tableTopic(this.name, t))
        : [changesTopic(this.name)]
    const removers = topics.map((topic) =>
      this.bus.subscribe(topic, (payload) => listener(payload as ChangeEvent)),
    )
    const onSchema = options.schema
    if (onSchema) {
      removers.push(
        this.bus.subscribe(schemaTopic(this.name), (payload) => onSchema(payload as SchemaEvent)),
      )
    }
    this.#changeSubs.set(id, {
      id,
      include: options.include ?? this.#defaultInclude,
      remove: () => {
        for (const off of removers) off()
      },
    })
    this.#refreshLevel()

    let backlog: ChangeEvent[] = []
    let reset = false
    if (options.since !== undefined) {
      const replay = this.ring.since(options.since)
      if (replay === "reset") reset = true
      else backlog = options.tables?.length ? filterTables(replay, options.tables) : replay
    }
    return { sub: id, backlog, reset }
  }

  /** Registers a live query and runs it once, so the subscriber starts with a full result. */
  subscribeLive(
    options: LiveSubscribeOptions,
    listener: (event: LiveEvent) => void,
  ): LiveSubscription {
    this.#assertOpen()
    const id = this.live.subscribe(options)
    const off = this.bus.subscribe(liveTopic(this.name, id), (payload) =>
      listener(payload as LiveEvent),
    )
    this.#liveSubs.set(id, off)
    this.#refreshLevel()
    let initial: LiveEvent | null = null
    try {
      initial = this.live.run(id, this.#txid)
    } catch (error) {
      this.unsubscribe(id)
      throw error
    }
    if (initial) this.bus.publish(liveTopic(this.name, id), initial)
    return { sub: id, initial }
  }

  unsubscribe(sub: string): boolean {
    const change = this.#changeSubs.get(sub)
    if (change) {
      change.remove()
      this.#changeSubs.delete(sub)
      this.#refreshLevel()
      return true
    }
    const off = this.#liveSubs.get(sub)
    if (!off) return false
    off()
    this.#liveSubs.delete(sub)
    this.live.unsubscribe(sub)
    this.#refreshLevel()
    return true
  }

  /** Runs everything the last commits queued, without waiting for the scheduler. */
  flush(): void {
    this.live.flush()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const sub of this.#changeSubs.values()) sub.remove()
    this.#changeSubs.clear()
    for (const off of this.#liveSubs.values()) off()
    this.#liveSubs.clear()
    this.live.clear()
    this.capture.close()
    this.bus.clear()
    this.hub.detach()
  }

  #refreshLevel(): void {
    if (this.#closed) return
    let level: CaptureLevel = this.#liveSubs.size > 0 ? "none" : "off"
    for (const sub of this.#changeSubs.values()) {
      if (LEVEL_RANK[sub.include] > LEVEL_RANK[level]) level = sub.include
    }
    if (!this.#autoDisable && LEVEL_RANK[level] < LEVEL_RANK[this.#defaultInclude]) {
      level = this.#defaultInclude
    }
    this.capture.setLevel(level)
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`realtime engine for ${this.name} is closed`)
  }
}

function filterTables(events: ChangeEvent[], tables: string[]): ChangeEvent[] {
  const wanted = new Set(tables)
  const out: ChangeEvent[] = []
  for (const event of events) {
    const changes = event.changes.filter((c) => wanted.has(c.table))
    if (changes.length > 0) out.push({ txid: event.txid, changes })
  }
  return out
}

function mergeChanges(list: TxnChanges[]): TxnChanges {
  const merged: TxnChanges = {
    tables: new Map(),
    rows: [],
    rowsTruncated: false,
    schemaChanged: false,
    ddl: [],
  }
  for (const one of list) {
    for (const row of one.rows) merged.rows.push(row)
    merged.rowsTruncated ||= one.rowsTruncated
    merged.schemaChanged ||= one.schemaChanged
    for (const change of one.ddl) merged.ddl.push(change)
    for (const [table, change] of one.tables) {
      const into = merged.tables.get(table)
      if (!into) {
        merged.tables.set(table, { ops: { ...change.ops }, ...(change.columns ? { columns: change.columns } : {}) })
        continue
      }
      into.ops.insert += change.ops.insert
      into.ops.update += change.ops.update
      into.ops.delete += change.ops.delete
      if (change.columns === undefined || change.columns === "*" || into.columns === "*") {
        into.columns = change.columns === undefined ? into.columns : "*"
      } else if (into.columns === undefined) {
        into.columns = change.columns
      } else {
        for (const column of change.columns) into.columns.add(column)
      }
    }
  }
  return merged
}
