// Invariant: the ring answers a `since` only while every event after it is still retained. The
// moment one is dropped — by size or by age — every position at or before it is unservable and
// the answer is `"reset"`, which the SSE and WebSocket layers turn into `event: reset` and the
// long-poll route into 409 RESET_REQUIRED (design §6.4).

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
  event: ChangeEvent
  bytes: number
  at: number
}

export class ChangeRing {
  readonly maxBytes: number
  readonly maxAgeMs: number
  readonly #now: () => number
  #entries: Entry[] = []
  #bytes = 0
  #latestTxid = 0
  /** Highest txid this ring has dropped; positions at or below it can no longer be served. */
  #evictedUpTo = 0

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
    this.#entries.push({ txid, event, bytes, at: this.#now() })
    this.#bytes += bytes
    if (txid > this.#latestTxid) this.#latestTxid = txid
    this.#prune()
  }

  /**
   * Events after `txid`, or `"reset"` when the ring can no longer prove it holds all of them.
   * A caller already at the head gets an empty array.
   */
  since(txid: number): ChangeEvent[] | "reset" {
    this.#prune()
    if (txid < this.#evictedUpTo) return "reset"
    const out: ChangeEvent[] = []
    for (const entry of this.#entries) if (entry.txid > txid) out.push(entry.event)
    return out
  }

  clear(): void {
    this.#evictedUpTo = this.#latestTxid
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
    if (txid > this.#evictedUpTo) this.#evictedUpTo = txid
    if (txid > this.#latestTxid) this.#latestTxid = txid
  }

  #prune(): void {
    const deadline = this.#now() - this.maxAgeMs
    while (this.#entries.length > 0) {
      const head = this.#entries[0] as Entry
      if (this.#bytes <= this.maxBytes && head.at > deadline) break
      this.#entries.shift()
      this.#bytes -= head.bytes
      if (head.txid > this.#evictedUpTo) this.#evictedUpTo = head.txid
    }
  }
}
