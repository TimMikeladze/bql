// Invariant: the ring answers a `since` only while every event after it is still retained. The
// moment one is dropped — by size or by age — every position at or before it is unservable and
// the answer is `"reset"`, which the SSE and WebSocket layers turn into `event: reset` and the
// long-poll route into 409 RESET_REQUIRED (design §6.4).
//
// Second invariant, from L8: a position is `(txid, seq)`, not a txid. One transaction now holds one
// event per statement, so a client that received `(5, 0)` and dropped before `(5, 1)` must be able
// to say so — and a bare txid still means "everything in that transaction", which is what every
// position issued before L8 meant and what a client that has seen a whole transaction wants.

import type { ChangeEvent } from "../client/protocol.ts"

export interface ChangeRingOptions {
  /** Approximate JSON bytes retained. Default 10 MB (design §4.6). */
  maxBytes?: number
  /** Age of the oldest retained event. Default 60 s. */
  maxAgeMs?: number
  /** Injectable clock, for tests. */
  now?: () => number
}

interface Entry {
  txid: number
  /** Which statement of `txid` this is; 0 for a transaction that ran one. */
  seq: number
  event: ChangeEvent
  bytes: number
  at: number
}

/**
 * Where a subscriber has got to. `seq` omitted means "the whole of `txid`", which is what a bare
 * `Last-Event-ID` of `5` or `?since=5` has always meant and still does.
 */
export interface RingPosition {
  txid: number
  seq?: number
}

/** Parses `"5"` or `"5.2"`. Returns null for anything else, including a negative txid. */
export function parsePosition(raw: string): RingPosition | null {
  const dot = raw.indexOf(".")
  const txid = Number(dot < 0 ? raw : raw.slice(0, dot))
  if (!Number.isFinite(txid) || txid < 0) return null
  if (dot < 0) return { txid: Math.floor(txid) }
  const seq = Number(raw.slice(dot + 1))
  if (!Number.isFinite(seq) || seq < 0) return null
  return { txid: Math.floor(txid), seq: Math.floor(seq) }
}

/** The id a client sends back to resume from this event. */
export function positionOf(event: ChangeEvent): string {
  return event.seq === undefined ? String(event.txid) : `${event.txid}.${event.seq}`
}

/** True when `(txid, seq)` is strictly after `pos`. */
function isAfter(txid: number, seq: number, pos: RingPosition): boolean {
  if (txid !== pos.txid) return txid > pos.txid
  // No `seq` in the position means the whole transaction has been seen.
  return pos.seq === undefined ? false : seq > pos.seq
}

export class ChangeRing {
  readonly maxBytes: number
  readonly maxAgeMs: number
  readonly #now: () => number
  #entries: Entry[] = []
  #bytes = 0
  #latestTxid = 0
  /**
   * The newest position this ring has dropped, or null while it has dropped nothing. A position a
   * subscriber is *at or after* is still servable; one the dropped event came after is not.
   *
   * L8 made this a position rather than a txid: a transaction now holds several events, so a ring
   * that dropped `(5, 0)` while keeping `(5, 1)` can still serve a client that already had
   * `(5, 0)` — and must still refuse one that had only `(4, …)`.
   */
  #evicted: Required<RingPosition> | null = null

  constructor(options: ChangeRingOptions = {}) {
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024
    this.maxAgeMs = options.maxAgeMs ?? 60_000
    this.#now = options.now ?? Date.now
  }

  get latestTxid(): number {
    return this.#latestTxid
  }

  get bytes(): number {
    return this.#bytes
  }

  get size(): number {
    return this.#entries.length
  }

  /** Lowest txid still retained, or 0 when the ring is empty. */
  get earliestTxid(): number {
    return this.#entries[0]?.txid ?? 0
  }

  push(txid: number, event: ChangeEvent): void {
    const bytes = JSON.stringify(event).length
    this.#entries.push({ txid, seq: event.seq ?? 0, event, bytes, at: this.#now() })
    this.#bytes += bytes
    if (txid > this.#latestTxid) this.#latestTxid = txid
    this.#prune()
  }

  /**
   * Events after `txid`, or `"reset"` when the ring can no longer prove it holds all of them.
   * A caller already at the head gets an empty array.
   */
  since(from: number | RingPosition): ChangeEvent[] | "reset" {
    const pos: RingPosition = typeof from === "number" ? { txid: from } : from
    this.#prune()
    const gone = this.#evicted
    if (gone !== null && isAfter(gone.txid, gone.seq, pos)) return "reset"
    const out: ChangeEvent[] = []
    for (const entry of this.#entries) {
      if (isAfter(entry.txid, entry.seq, pos)) out.push(entry.event)
    }
    return out
  }

  clear(): void {
    this.#dropped(this.#latestTxid, Number.POSITIVE_INFINITY)
    this.#entries = []
    this.#bytes = 0
  }

  /**
   * Declares that everything up to `txid` happened before this ring existed. A ring created for a
   * database that already has a history must answer `"reset"` for those positions rather than an
   * empty backlog — an empty backlog reads as "you are up to date", which would silently lose
   * every event between the client's position and now.
   */
  seal(txid: number): void {
    // Everything *in* that transaction is gone too, so the sealed position is its last statement,
    // whatever that was — which is what `Infinity` says without having to know.
    this.#dropped(txid, Number.POSITIVE_INFINITY)
    if (txid > this.#latestTxid) this.#latestTxid = txid
  }

  #dropped(txid: number, seq: number): void {
    const gone = this.#evicted
    if (gone === null || txid > gone.txid || (txid === gone.txid && seq > gone.seq)) {
      this.#evicted = { txid, seq }
    }
  }

  #prune(): void {
    const deadline = this.#now() - this.maxAgeMs
    while (this.#entries.length > 0) {
      const head = this.#entries[0] as Entry
      if (this.#bytes <= this.maxBytes && head.at > deadline) break
      this.#entries.shift()
      this.#bytes -= head.bytes
      this.#dropped(head.txid, head.seq)
    }
  }
}
