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
  RowChange,
  SchemaEvent,
} from "../client/protocol.ts"
import { BqlError } from "../server/errors.ts"
import type { Database } from "../sqlite/index.ts"
import { AuthorizerHub } from "./authorizer.ts"
import {
  ChangeCapture,
  type CaptureEngine,
  type CaptureLevel,
  type CapturedRow,
  type TxnChanges,
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
import {
  decodeLogical,
  encodeLogical,
  sliceEnds,
  toRowChange,
  type LogicalChanges,
} from "./logical.ts"
import { ChangeRing, type ChangeRingOptions, type RingPosition } from "./ring.ts"

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
export {
  decodeLogical,
  encodeLogical,
  type LogicalChanges,
  narrowRowChange,
  toRowChange,
} from "./logical.ts"
export { readSetOf, readSetTouched, type ReadSet } from "./readset.ts"
export {
  ChangeRing,
  type ChangeRingOptions,
  parsePosition,
  positionOf,
  type RingPosition,
} from "./ring.ts"

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
  /**
   * P9: this database is a replica, so its feed is driven by `afterApply` rather than by the
   * hooks. It changes one thing besides: a change subscription that asks for rows is refused
   * `LOGICAL_UNAVAILABLE` until a record proves the primary is recording them, because an empty
   * `changes` array is indistinguishable from "nothing changed".
   */
  replica?: boolean
  /**
   * P9: "this replica's primary records row changes", asked afresh each time a subscription is
   * about to be refused. A predicate rather than a flag because the two things that answer it
   * both arrive after the engine is built: the primary announces it on `SUBSCRIBED`, and the
   * replica's own log holds the version of the last record it applied.
   */
  logicalSeen?: () => boolean
  /**
   * P9: how much of each row to put in the transaction record, when
   * `[replication] logicalChanges` is on. Absent records nothing, which is the default.
   */
  logicalChanges?: IncludeLevel | null
  onError?: (id: string, error: unknown) => void
}

export interface ChangesSubscribeOptions {
  /** Only these tables; every table when absent. */
  tables?: string[]
  /**
   * Replay from this position. A bare number is a txid and means "the whole of that transaction
   * has been seen", which is what it meant before L8; `{ txid, seq }` resumes mid-transaction.
   */
  since?: number | RingPosition
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

export class TenantRealtime {
  readonly name: string
  readonly db: Database
  readonly hub: AuthorizerHub
  readonly capture: ChangeCapture
  readonly ring: ChangeRing
  readonly bus: RealtimeBus
  readonly live: LiveQueryRegistry

  /** P9: a replica publishes from records, not hooks. */
  readonly replica: boolean

  #defaultInclude: IncludeLevel
  #autoDisable: boolean
  #changeSubs = new Map<string, ChangeSub>()
  #liveSubs = new Map<string, () => void>()
  #nextId = 1
  #txid = 0
  #closed = false
  /** P9: the level `[replication] logicalChanges` asked for, or null when it is off. */
  #logicalChanges: IncludeLevel | null
  /**
   * P9: transactions `recordLogical` drained on the record path, waiting for the `afterCommit`
   * that follows a few statements later in `Tenant.#file`. Whoever drains the capture first wins,
   * so exactly one of the two paths drains and the other reads what it left — otherwise feeding
   * the replica would empty the primary's own feed.
   */
  #staged = new Map<number, TxnChanges>()
  /** P9: a version-2 record has arrived on this engine, which settles it whatever anyone says. */
  #logicalSeen = false
  /** P9: what the replication link and the local log say; see `TenantRealtimeOptions.logicalSeen`. */
  #logicalAsk: (() => boolean) | null

  constructor(options: TenantRealtimeOptions) {
    this.name = options.name
    this.db = options.db
    this.hub = options.hub ?? new AuthorizerHub(options.db)
    this.#defaultInclude = options.includeRows ?? "row"
    this.#autoDisable = options.autoDisable !== false
    this.replica = options.replica === true
    this.#logicalChanges = options.logicalChanges ?? null
    this.#logicalAsk = options.logicalSeen ?? null
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
   * P9: whether this database's change feed can carry rows. Always true on a primary, which
   * captures them itself; on a replica, true once a version-2 record has arrived.
   */
  get logicalAvailable(): boolean {
    if (!this.replica || this.#logicalSeen) return true
    return this.#logicalAsk?.() === true
  }

  /** P9: the level this primary puts in its transaction records, or null when it records none. */
  get logicalLevel(): IncludeLevel | null {
    return this.#logicalChanges
  }

  /**
   * Publishes everything the hooks buffered, stamped with `txid`. Call it once the transaction is
   * durable — never from inside a hook. Any transaction the owner did not drain earlier is folded
   * into this one, so the feed stays ordered and lossless.
   */
  /**
   * L8: "a statement inside the open transaction just finished." The request layer calls it after
   * each statement it runs on the writer, and `afterCommit` turns the boundaries into one event
   * per statement. A transaction nobody marks publishes exactly as it did before L8.
   */
  markStatement(): void {
    this.capture.mark()
  }

  /**
   * P9: the record path's half of the deal. `Tenant.#file` calls this once per batch of records it
   * is about to append, with their txids in order, and gets back the bytes to put in each record's
   * logical section.
   *
   * **It drains the capture, and that is the point.** The record is encoded *before* the change
   * feed publishes — `log.append(record)` then `#publish(event)` then `afterCommit` — so at this
   * moment the captured rows are still buffered and whichever path drains first wins. If this one
   * drained and said nothing, feeding the replica would silently empty the primary's own feed. So
   * it drains once, stages what it drained under each txid, and `afterCommit` publishes from the
   * stage instead of draining again: one materialisation, two feeds, and `seq` computed from the
   * same `marks` on both sides by construction rather than by agreement.
   *
   * Returns null rather than guessing when the capture's transactions cannot be lined up with
   * these records — a WAL transaction that changed no rows leaves no buffered entry, and
   * `maxBufferedTxns` can drop the oldest. Nothing is drained in that case, the batch is recorded
   * as version 1, and a replica sees `LOGICAL_UNAVAILABLE` rather than rows filed under the wrong
   * txid. A wrong row under a right key is the failure this milestone exists to prevent.
   */
  recordLogical(txids: readonly bigint[]): (Uint8Array | null)[] | null {
    const level = this.#logicalChanges
    if (level === null || this.#closed || txids.length === 0) return null
    if (this.capture.buffered !== txids.length) return null
    const drained = this.capture.takeAllCommitted()
    const out: (Uint8Array | null)[] = new Array(txids.length)
    for (let i = 0; i < txids.length; i++) {
      const txn = drained[i] as TxnChanges
      this.#stage(Number(txids[i]), txn)
      out[i] = encodeLogical(txn.rows, txn.marks, level, txn.rowsTruncated)
    }
    return out
  }

  #stage(txid: number, txn: TxnChanges): void {
    // The `afterCommit` that consumes this is three statements away in `Tenant.#file`, so the map
    // holds one entry for the length of one synchronous call. The bound is for the path where
    // `log.append` throws partway through a batch: the records were never published, so their
    // events are lost either way, and an unbounded map would be the worse of the two.
    if (this.#staged.size >= 256) {
      const oldest = this.#staged.keys().next()
      if (!oldest.done) this.#staged.delete(oldest.value)
    }
    this.#staged.set(txid, txn)
  }

  afterCommit(txid: number): CommitReport {
    this.setTxid(txid)
    const staged = this.#staged.get(txid)
    if (staged) this.#staged.delete(txid)
    const drained = staged ? [staged] : this.capture.takeAllCommitted()
    const report: CommitReport = { txid, change: null, schema: null, affected: 0, tables: [] }
    if (drained.length === 0) return report
    const merged = drained.length === 1 ? (drained[0] as TxnChanges) : mergeChanges(drained)
    report.tables = [...merged.tables.keys()]

    if (merged.rows.length > 0) {
      const changes: RowChange[] = new Array(merged.rows.length)
      for (let i = 0; i < merged.rows.length; i++) {
        changes[i] = toRowChange(merged.rows[i] as CapturedRow)
      }
      // L8: one event per statement, keyed `(txid, seq)`. Group commit folds concurrent writes
      // into one transaction, so one event per transaction meant a client could not tell fifty
      // writers apart and a durable consumer had no key to dedupe on across a replay. The slices
      // come from `marks`, which the request layer recorded as each statement finished; a
      // transaction nobody marked is one slice, which is exactly what it was before.
      const all = changesTopic(this.name)
      const single = merged.tables.size === 1 ? (report.tables[0] as string) : null
      let seq = 0
      let from = 0
      for (const to of sliceEnds(merged.marks, changes.length)) {
        if (to <= from) continue
        const slice = from === 0 && to === changes.length ? changes : changes.slice(from, to)
        from = to
        const event: ChangeEvent = { txid, seq: seq++, changes: slice }
        // The report carries the *first* event, which is what a single-statement write has and
        // what every caller of `CommitReport.change` already expects.
        report.change ??= event
        this.ring.push(txid, event)
        if (this.bus.hasAudience(all)) this.bus.publish(all, event)
        if (single !== null) {
          const topic = tableTopic(this.name, single)
          if (this.bus.hasAudience(topic)) this.bus.publish(topic, event)
          continue
        }
        for (const table of merged.tables.keys()) {
          const topic = tableTopic(this.name, table)
          if (!this.bus.hasAudience(topic)) continue
          const rows = slice.filter((c) => c.table === table)
          if (rows.length > 0) this.bus.publish(topic, { txid, seq: event.seq, changes: rows })
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
   * buffer to drain — everything it can say about the rows has to have come from the primary.
   *
   * **P9.** `logical` is the record's logical section when the primary recorded one, and the
   * replica then publishes the same events under the same `(txid, seq)` the primary published:
   * the statements were sliced once, on the primary, from the capture both feeds descend from.
   * Without it the feed is what it was before — a `txid`-only event with an empty `changes` array
   * — but a subscriber that asked for rows no longer gets that silently: see `subscribeChanges`.
   *
   * Live queries are re-run either way. Rows in hand do not make the replica's own re-execution
   * unnecessary: a live query's result depends on the whole database, not on the rows one
   * transaction moved.
   */
  afterApply(txid: number, logical?: Uint8Array | null): CommitReport {
    this.setTxid(txid)
    const report: CommitReport = { txid, change: null, schema: null, affected: 0, tables: [] }
    if (this.#closed) return report
    const decoded: LogicalChanges | null =
      logical && logical.byteLength > 0 ? decodeLogical(logical) : null
    if (decoded) this.#logicalSeen = true
    if (decoded && decoded.statements.length > 0) {
      const tables = new Set<string>()
      for (const statement of decoded.statements) {
        for (const change of statement) tables.add(change.table)
      }
      report.tables = [...tables]
      const all = changesTopic(this.name)
      let seq = 0
      for (const changes of decoded.statements) {
        const event: ChangeEvent = { txid, seq: seq++, changes }
        report.change ??= event
        this.ring.push(txid, event)
        if (this.bus.hasAudience(all)) this.bus.publish(all, event)
        for (const table of tables) {
          const topic = tableTopic(this.name, table)
          if (!this.bus.hasAudience(topic)) continue
          const rows = tables.size === 1 ? changes : changes.filter((c) => c.table === table)
          if (rows.length > 0) this.bus.publish(topic, { txid, seq: event.seq, changes: rows })
        }
      }
    } else {
      const event: ChangeEvent = { txid, changes: [] }
      report.change = event
      this.ring.push(txid, event)
      const topic = changesTopic(this.name)
      if (this.bus.hasAudience(topic)) this.bus.publish(topic, event)
    }
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
    const include = options.include ?? this.#defaultInclude
    // P9. A replica can only publish the rows its primary recorded. Before this milestone it
    // published `changes: []` for every transaction, which a subscriber cannot tell from "that
    // transaction changed nothing" — so a consumer built on a replica's feed was silently wrong
    // and had no way to find out. Refusing the subscription is the answer: a feed that cannot
    // carry what was asked of it says so once, at subscribe time, rather than every event.
    //
    // `include: "none"` asks for no rows, so it is served: a live-query client or a "something
    // changed, re-read" consumer works on a replica exactly as it always did.
    if (this.replica && include !== "none" && !this.logicalAvailable) {
      throw new BqlError(
        "LOGICAL_UNAVAILABLE",
        `${this.name} is a replica whose primary does not record row changes; ` +
          'subscribe with include="none", or set [replication] logicalChanges on the primary',
      )
    }
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
      include,
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
    this.#staged.clear()
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
    // P9: `[replication] logicalChanges` is a subscriber in everything but name. The rows go on
    // the wire whether or not anything on this node is watching, so the capture level is floored
    // at what the record is going to carry — otherwise a primary with no local subscriber would
    // record `pk` while the config asked for `row`.
    const logical = this.#logicalChanges
    if (logical !== null && LEVEL_RANK[logical] > LEVEL_RANK[level]) level = logical
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
    marks: [],
    rowsTruncated: false,
    schemaChanged: false,
    ddl: [],
  }
  for (const one of list) {
    // L8: the marks are offsets into each transaction's own rows, so they shift by however many
    // rows are already merged. A transaction with no marks contributes one boundary at its end,
    // because it *is* one statement as far as anything downstream can tell.
    const base = merged.rows.length
    if (one.marks.length === 0) merged.marks.push(base + one.rows.length)
    else for (const at of one.marks) merged.marks.push(base + at)
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
