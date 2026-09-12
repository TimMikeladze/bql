import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "../../src/sqlite/index.ts"
import { cleanupTempDirs, tempDb } from "./tmp.ts"

afterAll(cleanupTempDirs)

describe("statement counters", () => {
  test("counts virtual-machine steps, accumulating until reset", () => {
    const db = Database.open(tempDb())
    db.exec("create table t(id integer primary key, v text)")
    const insert = db.prepare("insert into t(v) values (?)")
    for (let i = 0; i < 100; i++) insert.run(`v${i}`)

    // A count over the whole table, not `count(*)`, which SQLite answers without stepping rows.
    const scan = db.prepare("select count(*) c from t where v like 'v1%'")
    expect(scan.vmSteps()).toBe(0)
    expect(scan.get()).toEqual({ c: 11 })

    const first = scan.vmSteps()
    expect(first).toBeGreaterThan(100)
    scan.get()
    // Counters accumulate over every run of the statement…
    expect(scan.vmSteps()).toBeGreaterThan(first)
    // …until they are read with reset, which zeroes them after returning the total.
    expect(scan.vmSteps(true)).toBeGreaterThan(first)
    expect(scan.vmSteps()).toBe(0)

    expect(scan.status("RUN")).toBe(2)
    db.close()
  })

  test("reports full scans, sorts and memory", () => {
    const db = Database.open(tempDb())
    db.exec("create table t(id integer primary key, v text)")
    const insert = db.prepare("insert into t(v) values (?)")
    for (let i = 0; i < 50; i++) insert.run(`v${i}`)

    const byKey = db.prepare("select v from t where id = ?")
    byKey.get(7)
    expect(byKey.status("FULLSCAN_STEP")).toBe(0)
    expect(byKey.status("SORT")).toBe(0)

    const sorted = db.prepare("select v from t order by v")
    sorted.all()
    expect(sorted.status("FULLSCAN_STEP")).toBeGreaterThan(0)
    expect(sorted.status("SORT")).toBe(1)
    expect(sorted.status("MEMUSED")).toBeGreaterThan(0)

    expect(() => sorted.status("NOPE" as never)).toThrow(/unknown statement counter/)
    sorted.finalize()
    expect(() => sorted.vmSteps()).toThrow(/finalized/)
    db.close()
  })
})
