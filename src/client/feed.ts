// The two subscription objects of design §9.1, and the decoders that turn a wire event into one
// carrying JavaScript values.
//
// Invariant: a feed is both an emitter and an async iterable, and an event reaches both. A
// consumer that uses `for await` and one that uses `.on("change")` see the same sequence, because
// the delivery point is one method.
//
// Second invariant: a live query starts on the microtask after it is created, not in its
// constructor. That is what makes ``db.live`…`.key("id").on("rows", …)`` one expression: `key`
// and the first listener are in place before the subscription goes out.

import { asClientError } from "./errors.ts"
import type {
  ChangeEvent,
  ChangeOp,
  IntValue,
  LiveDiffEvent,
  LiveRowsEvent,
  ObjectRow,
  ResetEvent,
  ResultRows,
  RowChange,
} from "./protocol.ts"
import { decodeObjectRow, decodeRowid, decodeRows, type IntMode, type JsRow } from "./values.ts"

export interface DecodedRowChange {
  table: string
  op: ChangeOp
  rowid: number | bigint | string | null
  pk?: JsRow
  row?: JsRow
  old?: JsRow
}

export interface DecodedChangeEvent {
  txid: number
  changes: DecodedRowChange[]
}

export type DecodedResetEvent = ResetEvent

export interface DecodedLiveRowsEvent<T> {
  txid: number
  columns: string[]
  types: string[]
  rows: T[]
  truncated?: boolean
}

export interface DecodedLiveDiffEvent<T> {
  txid: number
  added: T[]
  /** The key of each row that left the result, in the shape of the feed's rows. */
  removed: T[]
  updated: T[]
  truncated?: boolean
}

export function decodeChangeEvent(event: ChangeEvent, intMode: IntMode): DecodedChangeEvent {
  const changes: DecodedRowChange[] = new Array(event.changes.length)
  for (let i = 0; i < event.changes.length; i++) {
    const change = event.changes[i] as RowChange
    const out: DecodedRowChange = {
      table: change.table,
      op: change.op,
      rowid: decodeRowid(change.rowid as number | IntValue | null, intMode),
    }
    if (change.pk) out.pk = decodeObjectRow(change.pk as ObjectRow, intMode)
    if (change.row) out.row = decodeObjectRow(change.row as ObjectRow, intMode)
    if (change.old) out.old = decodeObjectRow(change.old as ObjectRow, intMode)
    changes[i] = out
  }
  return { txid: event.txid, changes }
}

export function decodeLiveRows<T>(
  event: LiveRowsEvent,
  intMode: IntMode,
): DecodedLiveRowsEvent<T> {
  return {
    txid: event.txid,
    columns: event.columns,
    types: event.types,
    rows: decodeRows(event.rows, intMode) as T[],
    ...(event.truncated ? { truncated: true } : {}),
  }
}

export function decodeLiveDiff<T>(event: LiveDiffEvent, intMode: IntMode): DecodedLiveDiffEvent<T> {
  const rows = (list: ResultRows): T[] => decodeRows(list, intMode) as T[]
  return {
    txid: event.txid,
    added: rows(event.added),
    removed: rows(event.removed),
    updated: rows(event.updated),
    ...(event.truncated ? { truncated: true } : {}),
  }
}

// ── the emitter and iterator both feeds are built on ───────────────────────────────────────────

type Listener = (payload: never) => void

class Emitter {
  #listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): void {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener)
  }

  off(event: string, listener: Listener): void {
    this.#listeners.get(event)?.delete(listener)
  }

  /** True when somebody is listening, which is how an unhandled `error` is noticed. */
  has(event: string): boolean {
    return (this.#listeners.get(event)?.size ?? 0) > 0
  }

  emit(event: string, payload: unknown): void {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        ;(listener as (p: unknown) => void)(payload)
      } catch {
        // A listener that throws is the caller's problem, never the feed's.
      }
    }
  }

  clear(): void {
    this.#listeners.clear()
  }
}

/**
 * The hand-off between the delivery point and a `for await` consumer. Nothing is buffered until
 * somebody asks for an iterator: a feed used only as an emitter would otherwise grow a queue
 * nobody ever reads, for as long as it is open.
 */
class Queue<T> {
  #items: T[] = []
  #waiting: ((result: IteratorResult<T>) => void)[] = []
  #done = false
  #wanted = false

  /** Called when an iterator is created; from then on events are kept for it. */
  want(): void {
    this.#wanted = true
  }

  push(item: T): void {
    if (this.#done || !this.#wanted) return
    const waiter = this.#waiting.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.#items.push(item)
  }

  end(): void {
    if (this.#done) return
    this.#done = true
    const waiting = this.#waiting
    this.#waiting = []
    for (const waiter of waiting) waiter({ value: undefined as never, done: true })
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift()
    if (item !== undefined) return Promise.resolve({ value: item, done: false })
    if (this.#done) return Promise.resolve({ value: undefined as never, done: true })
    return new Promise((resolve) => this.#waiting.push(resolve))
  }
}

/** What a source pushes into. */
export interface ChangeSink {
  change(event: DecodedChangeEvent): void
  reset(event: DecodedResetEvent): void
  error(err: unknown): void
}

/** Starts the underlying subscription and returns the function that stops it. */
export type ChangeSource = (sink: ChangeSink) => () => void

export type ChangeFeedEvent = "change" | "reset" | "error"

/**
 * `db.changes(…)` (design §9.1): an `AsyncIterable` of change events that is also an emitter, so
 * `for await (const ev of feed)` and `feed.on("change", …)` are both first-class.
 */
export class ChangeFeed implements AsyncIterable<DecodedChangeEvent> {
  #emitter = new Emitter()
  #queue = new Queue<DecodedChangeEvent>()
  #stop: (() => void) | null = null
  #closed = false

  constructor(source: ChangeSource) {
    const sink: ChangeSink = {
      change: (event) => {
        if (this.#closed) return
        this.#emitter.emit("change", event)
        this.#queue.push(event)
      },
      reset: (event) => {
        if (!this.#closed) this.#emitter.emit("reset", event)
      },
      error: (err) => {
        if (!this.#closed) this.#emitter.emit("error", asClientError(err, "change feed"))
      },
    }
    this.#stop = source(sink)
  }

  on(event: "change", listener: (event: DecodedChangeEvent) => void): this
  on(event: "reset", listener: (event: DecodedResetEvent) => void): this
  on(event: "error", listener: (error: unknown) => void): this
  on(event: ChangeFeedEvent, listener: (payload: never) => void): this {
    this.#emitter.on(event, listener)
    return this
  }

  off(event: ChangeFeedEvent, listener: (payload: never) => void): this {
    this.#emitter.off(event, listener)
    return this
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const stop = this.#stop
    this.#stop = null
    stop?.()
    this.#queue.end()
    this.#emitter.clear()
  }

  [Symbol.asyncIterator](): AsyncIterator<DecodedChangeEvent> {
    this.#queue.want()
    return {
      next: () => this.#queue.next(),
      return: async () => {
        this.close()
        return { value: undefined as never, done: true }
      },
    }
  }
}

export interface LiveSink<T> {
  rows(event: DecodedLiveRowsEvent<T>): void
  diff(event: DecodedLiveDiffEvent<T>): void
  error(err: unknown): void
}

export type LiveSource<T> = (sink: LiveSink<T>, options: { key: string | null }) => () => void

export type LiveQueryEvent = "rows" | "diff" | "error"

/**
 * ``db.live`…` `` (design §9.1). Without a `key` every change sends the whole result as `rows`;
 * with one, the first event is still `rows` and everything after it is a `diff`.
 */
export class LiveQuery<T = JsRow> implements AsyncIterable<
  DecodedLiveRowsEvent<T> | DecodedLiveDiffEvent<T>
> {
  #emitter = new Emitter()
  #queue = new Queue<DecodedLiveRowsEvent<T> | DecodedLiveDiffEvent<T>>()
  #source: LiveSource<T>
  #stop: (() => void) | null = null
  #key: string | null = null
  #started = false
  #closed = false

  constructor(source: LiveSource<T>) {
    this.#source = source
    queueMicrotask(() => this.#start())
  }

  /** The column that identifies a row, which switches the feed to diffs. */
  key(column: string): this {
    if (this.#started) {
      throw asClientError(new Error("key() must be called before the subscription starts"), "live")
    }
    this.#key = column
    return this
  }

  on(event: "rows", listener: (event: DecodedLiveRowsEvent<T>) => void): this
  on(event: "diff", listener: (event: DecodedLiveDiffEvent<T>) => void): this
  on(event: "error", listener: (error: unknown) => void): this
  on(event: LiveQueryEvent, listener: (payload: never) => void): this {
    this.#emitter.on(event, listener)
    return this
  }

  off(event: LiveQueryEvent, listener: (payload: never) => void): this {
    this.#emitter.off(event, listener)
    return this
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const stop = this.#stop
    this.#stop = null
    stop?.()
    this.#queue.end()
    this.#emitter.clear()
  }

  [Symbol.asyncIterator](): AsyncIterator<DecodedLiveRowsEvent<T> | DecodedLiveDiffEvent<T>> {
    this.#queue.want()
    return {
      next: () => this.#queue.next(),
      return: async () => {
        this.close()
        return { value: undefined as never, done: true }
      },
    }
  }

  #start(): void {
    if (this.#started || this.#closed) return
    this.#started = true
    const sink: LiveSink<T> = {
      rows: (event) => {
        if (this.#closed) return
        this.#emitter.emit("rows", event)
        this.#queue.push(event)
      },
      diff: (event) => {
        if (this.#closed) return
        this.#emitter.emit("diff", event)
        this.#queue.push(event)
      },
      error: (err) => {
        if (!this.#closed) this.#emitter.emit("error", asClientError(err, "live query"))
      },
    }
    try {
      this.#stop = this.#source(sink, { key: this.#key })
    } catch (err) {
      sink.error(err)
    }
  }
}
