// Invariant: topics here are spelled exactly as Bun's own pub/sub will spell them, so moving
// fan-out from this in-process bus to `server.publish` is a matter of handing the bus a
// `Publisher` — no topic rewriting, no second naming scheme (design §4.6).

import type {
  ChangeEvent,
  LiveDiffEvent,
  LiveRowsEvent,
  ResetEvent,
  SchemaEvent,
} from "../client/protocol.ts"

export type RealtimePayload =
  | ChangeEvent
  | SchemaEvent
  | LiveRowsEvent
  | LiveDiffEvent
  | ResetEvent

export type TopicListener = (payload: RealtimePayload, topic: string) => void

/** What `Bun.serve`'s `server.publish` looks like from here. */
export interface Publisher {
  publish(topic: string, data: string): unknown
}

/** Every change in one database, whatever the table. */
export function changesTopic(db: string): string {
  return `db:${db}:changes`
}

export function tableTopic(db: string, table: string): string {
  return `db:${db}:changes:${table}`
}

export function schemaTopic(db: string): string {
  return `db:${db}:schema`
}

export function liveTopic(db: string, subId: string): string {
  return `db:${db}:live:${subId}`
}

export class RealtimeBus {
  #topics = new Map<string, Set<TopicListener>>()
  #publisher: Publisher | null

  constructor(publisher: Publisher | null = null) {
    this.#publisher = publisher
  }

  /** Number of topics with at least one local listener. */
  get topicCount(): number {
    return this.#topics.size
  }

  /** Attaches the socket layer's publisher, or removes it with null. */
  setPublisher(publisher: Publisher | null): void {
    this.#publisher = publisher
  }

  listenerCount(topic: string): number {
    return this.#topics.get(topic)?.size ?? 0
  }

  /** True when publishing to this topic can reach anybody, locally or through the socket layer. */
  hasAudience(topic: string): boolean {
    return this.#publisher !== null || (this.#topics.get(topic)?.size ?? 0) > 0
  }

  subscribe(topic: string, listener: TopicListener): () => void {
    let set = this.#topics.get(topic)
    if (!set) {
      set = new Set()
      this.#topics.set(topic, set)
    }
    set.add(listener)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const current = this.#topics.get(topic)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.#topics.delete(topic)
    }
  }

  /**
   * Delivers to local listeners and, when one is attached, to the socket publisher. The payload
   * is serialised at most once and only when there is a publisher to serialise it for.
   */
  publish(topic: string, payload: RealtimePayload): number {
    const set = this.#topics.get(topic)
    if (set) {
      for (const listener of [...set]) listener(payload, topic)
    }
    this.#publisher?.publish(topic, JSON.stringify(payload))
    return set?.size ?? 0
  }

  clear(): void {
    this.#topics.clear()
  }
}
