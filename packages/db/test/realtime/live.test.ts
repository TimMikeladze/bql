// Live queries: what a commit invalidates, what actually gets re-run, and what comes out.

import { afterAll, describe, expect, test } from "bun:test"
import { AuthorizerHub } from "../../src/realtime/authorizer.ts"
import { ChangeCapture } from "../../src/realtime/capture.ts"
import { LiveQueryRegistry, type LiveEvent, type Scheduler } from "../../src/realtime/live.ts"
import { BqlError } from "../../src/server/errors.ts"
import type { Database } from "../../src/sqlite/index.ts"
import { cleanupTempDirs } from "../sqlite/tmp.ts"
import { open, runner, tick } from "./harness.ts"

afterAll(cleanupTempDirs)

interface Fixture {
  db: Database
  capture: ChangeCapture
  live: LiveQueryRegistry
  events: { id: string; event: LiveEvent }[]
  /** Runs writes, then invalidates and queues whatever they affected. Returns the affected ids. */
  commit(write: () => void): Set<string>
  close(): void
}

function setup(options: { schedule?: Scheduler; maxRows?: number } = {}): Fixture {
  const db = open(
    "create table t(id integer primary key, v text, n int)",
    "create table o(id integer primary key, amount int)",
  )
  const hub = new AuthorizerHub(db)
  const capture = new ChangeCapture(db, { hub, includeRows: "none", trackColumns: true })
  const events: { id: string; event: LiveEvent }[] = []
  const live = new LiveQueryRegistry({
    db,
    hub,
    execute: runner(db),
    onEvent: (id, event) => events.push({ id, event }),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
  })
  let txid = 0
  return {
    db,
    capture,
    live,
    events,
    commit(write) {
      write()
      txid++
      const txn = capture.takeCommitted()
      if (!txn) return new Set<string>()
      const affected = live.invalidate(txn, txid)
      live.scheduleRuns(affected, txid)
      return affected
    },
    close() {
      live.clear()
      capture.close()
      db.close()
    },
  }
}

describe("invalidation", () => {
  test("only the subscriptions reading the written table are affected", () => {
    const f = setup()
    const onT = f.live.subscribe({ sql: "select id, v from t" })
    const onO = f.live.subscribe({ sql: "select id, amount from o" })
    expect(f.commit(() => f.db.run("insert into t(v, n) values ('a', 1)"))).toEqual(new Set([onT]))
    expect(f.commit(() => f.db.run("insert into o(amount) values (5)"))).toEqual(new Set([onO]))
    f.close()
  })

  test("a column nobody reads does not invalidate anything", () => {
    const f = setup()
    f.db.run("insert into t(v, n) values ('a', 1)")
    f.capture.takeCommitted()
    const sub = f.live.subscribe({ sql: "select id, v from t" })
    expect(f.commit(() => f.db.run("update t set n = 7 where id = 1"))).toEqual(new Set())
    expect(f.commit(() => f.db.run("update t set v = 'b' where id = 1"))).toEqual(new Set([sub]))
    f.close()
  })

  test("an update that changes nothing invalidates nothing", () => {
    const f = setup()
    f.db.run("insert into t(v, n) values ('a', 1)")
    f.capture.takeCommitted()
    f.live.subscribe({ sql: "select id, v from t" })
    expect(f.commit(() => f.db.run("update t set v = 'a' where id = 1"))).toEqual(new Set())
    f.close()
  })

  test("a schema change invalidates every subscription", () => {
    const f = setup()
    const a = f.live.subscribe({ sql: "select id, v from t" })
    const b = f.live.subscribe({ sql: "select id, amount from o" })
    expect(f.commit(() => f.db.exec("create table later(x int)"))).toEqual(new Set([a, b]))
    f.close()
  })
})

describe("results", () => {
  test("the first run is a full result and an unchanged rerun emits nothing", () => {
    const f = setup()
    f.db.run("insert into t(v, n) values ('a', 1)")
    const sub = f.live.subscribe({ sql: "select id, v from t order by id" })
    const first = f.live.run(sub, 1)
    expect(first).toEqual({ txid: 1, columns: ["id", "v"], types: ["INTEGER", "TEXT"], rows: [[1, "a"]] })
    expect(f.live.run(sub, 2)).toBeNull()
    f.close()
  })

  test("a keyed subscription sends rows first, then diffs", () => {
    const f = setup()
    f.db.run("insert into t(v, n) values ('a', 1)")
    f.capture.takeCommitted()
    const sub = f.live.subscribe({ sql: "select id, v from t order by id", key: "id" })
    expect(f.live.run(sub, 1)).toEqual({
      txid: 1,
      columns: ["id", "v"],
      types: ["INTEGER", "TEXT"],
      rows: [[1, "a"]],
    })

    f.db.run("insert into t(v, n) values ('b', 2)")
    f.capture.takeCommitted()
    expect(f.live.run(sub, 2)).toEqual({ txid: 2, added: [[2, "b"]], removed: [], updated: [] })

    f.db.run("update t set v = 'B' where id = 2")
    f.capture.takeCommitted()
    expect(f.live.run(sub, 3)).toEqual({ txid: 3, added: [], removed: [], updated: [[2, "B"]] })

    f.db.run("delete from t where id = 1")
    f.capture.takeCommitted()
    expect(f.live.run(sub, 4)).toEqual({ txid: 4, added: [], removed: [[1]], updated: [] })
    f.close()
  })

  test("maxRows truncates the result and says so", () => {
    const f = setup({ maxRows: 2 })
    f.db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    const sub = f.live.subscribe({ sql: "select id, v from t order by id" })
    const event = f.live.run(sub, 1)
    expect(event?.truncated).toBe(true)
    expect((event as { rows: unknown[] }).rows).toHaveLength(2)
    f.close()
  })
})

describe("subscribe", () => {
  test("a statement that writes is refused", () => {
    const f = setup()
    expect(() => f.live.subscribe({ sql: "delete from t" })).toThrow(BqlError)
    expect(() => f.live.subscribe({ sql: "insert into t(v) values ('x')" })).toThrow(
      "a live query must be read-only",
    )
    f.close()
  })

  test("a key that is not a result column is refused", () => {
    const f = setup()
    expect(() => f.live.subscribe({ sql: "select v from t", key: "id" })).toThrow(BqlError)
    f.close()
  })

  test("the registry is bounded", () => {
    const f = setup()
    const live = new LiveQueryRegistry({ db: f.db, execute: runner(f.db), maxLiveQueries: 2 })
    live.subscribe({ sql: "select id from t" })
    live.subscribe({ sql: "select id from o" })
    expect(() => live.subscribe({ sql: "select v from t" })).toThrow(BqlError)
    f.close()
  })

  test("unsubscribing stops invalidation", () => {
    const f = setup()
    const sub = f.live.subscribe({ sql: "select id, v from t" })
    expect(f.live.unsubscribe(sub)).toBe(true)
    expect(f.commit(() => f.db.run("insert into t(v) values ('a')"))).toEqual(new Set())
    expect(f.live.unsubscribe(sub)).toBe(false)
    f.close()
  })
})

describe("coalescing", () => {
  test("several commits in one tick cost one run per subscription", async () => {
    const f = setup()
    const sub = f.live.subscribe({ sql: "select id, v from t order by id" })
    f.live.run(sub, 0)
    const before = f.live.runCount

    for (let i = 0; i < 5; i++) {
      f.commit(() => f.db.run("insert into t(v) values (?)", [`v${i}`]))
    }
    expect(f.live.runCount).toBe(before)
    await tick()
    expect(f.live.runCount).toBe(before + 1)
    expect(f.events).toHaveLength(1)
    expect(f.events[0]?.event.txid).toBe(5)
    expect((f.events[0]?.event as { rows: unknown[] }).rows).toHaveLength(5)
    f.close()
  })

  test("an injected scheduler decides when the runs happen", () => {
    const queued: (() => void)[] = []
    const f = setup({ schedule: (run) => queued.push(run) })
    const sub = f.live.subscribe({ sql: "select id, v from t" })
    f.live.run(sub, 0)
    f.commit(() => f.db.run("insert into t(v) values ('a')"))
    f.commit(() => f.db.run("insert into t(v) values ('b')"))
    expect(queued).toHaveLength(1)
    expect(f.events).toHaveLength(0)
    queued[0]?.()
    expect(f.events).toHaveLength(1)
    f.close()
  })
})
