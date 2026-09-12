// End to end: one `TenantRealtime` over a real connection, driven the way the tenant owner will
// drive it — write, commit, `afterCommit(txid)` — plus the cost budget from plan M6.

import { afterAll, describe, expect, test } from "bun:test"
import type { ChangeEvent, LiveRowsEvent, SchemaEvent } from "../../src/client/protocol.ts"
import { TenantRealtime, schemaTopic, type LiveEvent } from "../../src/realtime/index.ts"
import { cleanupTempDirs } from "../sqlite/tmp.ts"
import { open, runner } from "./harness.ts"

afterAll(cleanupTempDirs)

function tenant(options: { schedule?: (run: () => void) => void } = {}) {
  const db = open(
    "create table todos(id integer primary key, title text, done int)",
    "create table notes(id integer primary key, body text)",
  )
  const realtime = new TenantRealtime({
    name: "acme",
    db,
    execute: runner(db),
    ...(options.schedule ? { schedule: options.schedule } : {}),
  })
  return { db, realtime }
}

describe("TenantRealtime", () => {
  test("a commit becomes one change event per topic, stamped with the txid", () => {
    const { db, realtime } = tenant()
    const all: ChangeEvent[] = []
    const onTodos: ChangeEvent[] = []
    realtime.subscribeChanges({}, (event) => all.push(event))
    realtime.subscribeChanges({ tables: ["todos"] }, (event) => onTodos.push(event))

    db.transaction(() => {
      db.run("insert into todos(title, done) values ('write it', 0)")
      db.run("insert into notes(body) values ('a note')")
    })()
    const report = realtime.afterCommit(41)

    expect(report.change?.txid).toBe(41)
    expect(report.tables.sort()).toEqual(["notes", "todos"])
    expect(all).toHaveLength(1)
    expect(all[0]?.changes).toHaveLength(2)
    expect(onTodos).toHaveLength(1)
    expect(onTodos[0]?.changes).toEqual([
      {
        table: "todos",
        op: "insert",
        rowid: 1,
        pk: { id: 1 },
        row: { id: 1, title: "write it", done: 0 },
      },
    ])
    realtime.close()
    db.close()
  })

  test("DDL becomes a schema event", () => {
    const { db, realtime } = tenant()
    const schema: SchemaEvent[] = []
    realtime.subscribeChanges({}, () => {})
    realtime.bus.subscribe(schemaTopic("acme"), (payload) => schema.push(payload as SchemaEvent))
    db.exec("create table extra(a int)")
    const report = realtime.afterCommit(42)
    expect(report.schema?.txid).toBe(42)
    expect(schema[0]?.changes).toContainEqual({ op: "create", object: "table", name: "extra" })
    realtime.close()
    db.close()
  })

  test("a live subscription starts with rows and then receives diffs", () => {
    const { db, realtime } = tenant()
    db.run("insert into todos(title, done) values ('one', 0)")
    const events: LiveEvent[] = []
    const { sub, initial } = realtime.subscribeLive(
      { sql: "select id, title from todos where done = 0 order by id", key: "id" },
      (event) => events.push(event),
    )
    expect((initial as LiveRowsEvent).rows).toEqual([[1, "one"]])
    expect(events).toHaveLength(1)

    db.run("insert into todos(title, done) values ('two', 0)")
    realtime.afterCommit(10)
    realtime.flush()
    expect(events[1]).toEqual({ txid: 10, added: [[2, "two"]], removed: [], updated: [] })

    // A write to a column the query does not read changes nothing.
    db.run("update notes set body = 'x'")
    realtime.afterCommit(11)
    realtime.flush()
    expect(events).toHaveLength(2)

    db.run("update todos set done = 1 where id = 1")
    realtime.afterCommit(12)
    realtime.flush()
    expect(events[2]).toEqual({ txid: 12, added: [], removed: [[1]], updated: [] })

    expect(realtime.unsubscribe(sub)).toBe(true)
    realtime.close()
    db.close()
  })

  test("a subscriber can replay from the ring, or is told to reset", () => {
    const { db, realtime } = tenant()
    realtime.subscribeChanges({}, () => {})
    for (let txid = 1; txid <= 3; txid++) {
      db.run("insert into todos(title, done) values (?, 0)", [`t${txid}`])
      realtime.afterCommit(txid)
    }
    const late = realtime.subscribeChanges({ since: 1 }, () => {})
    expect(late.reset).toBe(false)
    expect(late.backlog.map((e) => e.txid)).toEqual([2, 3])

    realtime.ring.clear()
    const tooLate = realtime.subscribeChanges({ since: 1 }, () => {})
    expect(tooLate.reset).toBe(true)
    realtime.close()
    db.close()
  })

  test("a tenant with no subscribers has no hooks installed", () => {
    const { db, realtime } = tenant()
    expect(realtime.capture.level).toBe("off")

    const live = realtime.subscribeLive({ sql: "select id from todos" }, () => {})
    expect(realtime.capture.level).toBe("none")

    const rows = realtime.subscribeChanges({ include: "row+old" }, () => {})
    expect(realtime.capture.level).toBe("row+old")

    realtime.unsubscribe(rows.sub)
    expect(realtime.capture.level).toBe("none")
    realtime.unsubscribe(live.sub)
    expect(realtime.capture.level).toBe("off")

    // Nothing is captured while the hooks are off.
    db.run("insert into todos(title, done) values ('quiet', 0)")
    expect(realtime.afterCommit(1).change).toBeNull()
    realtime.close()
    db.close()
  })
})

describe("cost", () => {
  test("1k live subscriptions on 10 tables: a commit touching one table stays under 2 ms", () => {
    const queued: (() => void)[] = []
    const db = open()
    for (let t = 0; t < 10; t++) {
      db.exec(`create table t${t}(id integer primary key, v text, n int)`)
      db.exec(`insert into t${t}(v, n) values ('a', 1), ('b', 2)`)
    }
    const realtime = new TenantRealtime({
      name: "bench",
      db,
      execute: runner(db),
      schedule: (run) => queued.push(run),
      maxLiveQueries: 2000,
    })
    let delivered = 0
    for (let t = 0; t < 10; t++) {
      for (let i = 0; i < 100; i++) {
        realtime.subscribeLive(
          { sql: `select id, v from t${t} where id > ${i} order by id` },
          () => delivered++,
        )
      }
    }
    expect(realtime.live.size).toBe(1000)
    delivered = 0

    // Warm up, then measure the commit-side work alone: the re-runs are queued, not run.
    let txid = 1
    for (let i = 0; i < 5; i++) {
      db.run("insert into t0(v, n) values ('warm', 0)")
      realtime.afterCommit(txid++)
      queued.length = 0
    }

    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      db.run("insert into t0(v, n) values ('x', 1)")
      const started = performance.now()
      const report = realtime.afterCommit(txid++)
      samples.push(performance.now() - started)
      expect(report.affected).toBe(100)
      queued.length = 0
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)] as number
    const worst = samples[samples.length - 1] as number

    db.run("insert into t0(v, n) values ('final', 1)")
    const finalId = Number(db.prepare("select max(id) as m from t0").get()?.m ?? 0)
    realtime.afterCommit(txid++)
    const runsBefore = realtime.live.runCount
    const flushStarted = performance.now()
    realtime.flush()
    const flushMs = performance.now() - flushStarted
    // Every subscription on the table re-ran, but only those whose result actually moved emitted:
    // the query is `id > i`, so a new row with id N changes the result of the subs with i < N.
    expect(realtime.live.runCount - runsBefore).toBe(100)

    console.log(
      `afterCommit with 1000 live subscriptions on 10 tables: median ${median.toFixed(3)} ms, ` +
        `worst ${worst.toFixed(3)} ms; flushing the 100 affected re-runs took ${flushMs.toFixed(2)} ms`,
    )
    expect(median).toBeLessThan(2)
    expect(worst).toBeLessThan(2)
    expect(delivered).toBe(Math.min(finalId, 100))

    realtime.close()
    db.close()
  })
})
