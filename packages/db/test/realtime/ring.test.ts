// The ring buffer and the bus: the two pieces with no SQLite in them.

import { describe, expect, test } from "bun:test"
import { RealtimeBus, changesTopic, liveTopic, schemaTopic, tableTopic } from "../../src/realtime/bus.ts"
import { ChangeRing } from "../../src/realtime/ring.ts"
import type { ChangeEvent } from "../../src/client/protocol.ts"

function event(txid: number, table = "t"): ChangeEvent {
  return { txid, changes: [{ table, op: "insert", rowid: txid, row: { id: txid } }] }
}

describe("ChangeRing", () => {
  test("since returns everything after a position", () => {
    const ring = new ChangeRing()
    for (let txid = 1; txid <= 5; txid++) ring.push(txid, event(txid))
    expect(ring.latestTxid).toBe(5)
    expect((ring.since(3) as ChangeEvent[]).map((e) => e.txid)).toEqual([4, 5])
    expect(ring.since(5)).toEqual([])
    expect(ring.since(0)).toHaveLength(5)
  })

  test("a position the ring has dropped is a reset", () => {
    const ring = new ChangeRing({ maxBytes: 200 })
    for (let txid = 1; txid <= 20; txid++) ring.push(txid, event(txid))
    expect(ring.bytes).toBeLessThanOrEqual(200)
    expect(ring.since(1)).toBe("reset")
    expect(ring.since(ring.latestTxid)).toEqual([])
    const kept = ring.since(ring.earliestTxid) as ChangeEvent[]
    expect(Array.isArray(kept)).toBe(true)
    expect(kept[0]?.txid).toBe(ring.earliestTxid + 1)
  })

  test("events older than maxAgeMs are dropped", () => {
    let now = 1000
    const ring = new ChangeRing({ maxAgeMs: 100, now: () => now })
    ring.push(1, event(1))
    now = 1050
    ring.push(2, event(2))
    expect(ring.since(0)).toHaveLength(2)
    now = 1200
    expect(ring.since(0)).toBe("reset")
    expect(ring.since(2)).toEqual([])
  })

  test("bytes are accounted once per event", () => {
    const ring = new ChangeRing()
    const one = event(1)
    ring.push(1, one)
    expect(ring.bytes).toBe(JSON.stringify(one).length)
    ring.clear()
    expect(ring.bytes).toBe(0)
    expect(ring.since(0)).toBe("reset")
  })
})

describe("RealtimeBus", () => {
  test("topics are the ones the socket layer will publish on", () => {
    expect(changesTopic("acme")).toBe("db:acme:changes")
    expect(tableTopic("acme", "users")).toBe("db:acme:changes:users")
    expect(schemaTopic("acme")).toBe("db:acme:schema")
    expect(liveTopic("acme", "s1")).toBe("db:acme:live:s1")
  })

  test("subscribers receive payloads and can unsubscribe", () => {
    const bus = new RealtimeBus()
    const seen: ChangeEvent[] = []
    const off = bus.subscribe("db:a:changes", (payload) => seen.push(payload as ChangeEvent))
    expect(bus.publish("db:a:changes", event(1))).toBe(1)
    off()
    expect(bus.publish("db:a:changes", event(2))).toBe(0)
    expect(seen.map((e) => e.txid)).toEqual([1])
    expect(bus.topicCount).toBe(0)
  })

  test("an attached publisher gets the JSON the socket layer would send", () => {
    const sent: [string, string][] = []
    const bus = new RealtimeBus({ publish: (topic, data) => sent.push([topic, data]) })
    expect(bus.hasAudience("db:a:changes")).toBe(true)
    bus.publish("db:a:changes", event(7))
    expect(sent[0]?.[0]).toBe("db:a:changes")
    expect(JSON.parse(sent[0]?.[1] as string).txid).toBe(7)
  })

  test("nothing is published to a topic nobody listens to", () => {
    const bus = new RealtimeBus()
    expect(bus.hasAudience("db:a:changes:t")).toBe(false)
    bus.subscribe("db:a:changes:t", () => {})
    expect(bus.hasAudience("db:a:changes:t")).toBe(true)
  })
})
