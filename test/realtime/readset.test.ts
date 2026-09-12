// Read-sets come from the authorizer, so these tests are really about what SQLite reports for
// joins, views, CTEs and aggregates — the shapes a live query is built out of.

import { afterAll, describe, expect, test } from "bun:test"
import { AuthorizerHub } from "../../src/realtime/authorizer.ts"
import { readSetOf, readSetTouched } from "../../src/realtime/readset.ts"
import { buildAuthorizer } from "../../src/server/auth.ts"
import { SqliteError } from "../../src/sqlite/index.ts"
import { cleanupTempDirs } from "../sqlite/tmp.ts"
import { open } from "./harness.ts"

afterAll(cleanupTempDirs)

function fixture() {
  return open(
    "create table t(id integer primary key, v text, n int)",
    "create table o(id integer primary key, t_id int, amount int)",
    "create view vt as select id, v from t",
    "insert into t(v, n) values ('a', 1), ('b', 2)",
    "insert into o(t_id, amount) values (1, 10)",
  )
}

/** Read-set as a plain object, so the expectations read like the SQL. */
function tablesOf(set: ReturnType<typeof readSetOf>): Record<string, string[] | "*"> {
  const out: Record<string, string[] | "*"> = {}
  for (const [table, columns] of set.tables) {
    out[table] = columns === "*" ? "*" : [...columns].sort()
  }
  return out
}

describe("readSetOf", () => {
  test("a plain select names the columns it reads", () => {
    const db = fixture()
    const set = readSetOf(db, "select id, v from t where n > 1")
    expect(tablesOf(set)).toEqual({ t: ["id", "n", "v"] })
    expect(set.columns).toEqual(["id", "v"])
    expect(set.writesDetected).toBe(false)
    db.close()
  })

  test("a join reports both sides", () => {
    const db = fixture()
    const set = readSetOf(db, "select t.v, o.amount from t join o on o.t_id = t.id")
    expect(tablesOf(set)).toEqual({ t: ["id", "v"], o: ["amount", "t_id"] })
    db.close()
  })

  test("a view reports the tables underneath it", () => {
    const db = fixture()
    const set = readSetOf(db, "select v from vt where id = 1")
    expect(set.tables.has("t")).toBe(true)
    expect(set.tables.has("vt")).toBe(true)
    db.close()
  })

  test("a CTE and a scalar subquery both report the real tables", () => {
    const db = fixture()
    const set = readSetOf(
      db,
      "with recent as (select id from t where n > 0) select recent.id, (select max(amount) from o) as m from recent",
    )
    expect(tablesOf(set)).toEqual({ t: ["id", "n"], o: ["amount"] })
    db.close()
  })

  test("count(*) reads the whole row, so the table is `*`", () => {
    const db = fixture()
    const set = readSetOf(db, "select count(*) as c from t")
    expect(tablesOf(set)).toEqual({ t: "*" })
    db.close()
  })

  test("sqlite_* tables are not part of a read-set", () => {
    const db = fixture()
    const set = readSetOf(db, "select name from sqlite_master")
    expect(set.tables.size).toBe(0)
    db.close()
  })

  test("writes are detected and never become live queries", () => {
    const db = fixture()
    expect(readSetOf(db, "insert into t(v) values ('x')").writesDetected).toBe(true)
    expect(readSetOf(db, "update t set v = 'x'").writesDetected).toBe(true)
    expect(readSetOf(db, "delete from t").writesDetected).toBe(true)
    const ddl = readSetOf(db, "create table q(a int)")
    expect(ddl.writesDetected).toBe(true)
    expect(ddl.ddl).toBe(true)
    db.close()
  })

  test("it composes with the token policy instead of clobbering it", () => {
    const db = fixture()
    const hub = new AuthorizerHub(db)
    hub.setBase(buildAuthorizer({ scope: "ro", tables: { t: "r" } }))

    const allowed = readSetOf(db, "select v from t", { hub })
    expect(tablesOf(allowed)).toEqual({ t: ["v"] })

    // The policy still denies what it denied before the recorder was added.
    expect(() => readSetOf(db, "select amount from o", { hub })).toThrow(SqliteError)
    expect(() => db.prepare("select amount from o where 1 = 1")).toThrow(SqliteError)
    hub.detach()
    db.close()
  })

  test("the connection keeps no authorizer of its own afterwards", () => {
    const db = fixture()
    readSetOf(db, "select v from t")
    // A statement the recorder would have seen prepares normally once it is gone.
    expect(db.prepare("select v from t where id = 1").get()).toEqual({ v: "a" })
    db.close()
  })

  test("a second read-set of the same SQL still sees everything", () => {
    const db = fixture()
    const first = readSetOf(db, "select id, v from t")
    const second = readSetOf(db, "select id, v from t")
    expect(tablesOf(second)).toEqual(tablesOf(first))
    db.close()
  })
})

describe("readSetTouched", () => {
  test("columns intersect only when both sides know them", () => {
    const db = fixture()
    const set = readSetOf(db, "select id, v from t")
    expect(readSetTouched(set, "t", new Set(["v"]))).toBe(true)
    expect(readSetTouched(set, "t", new Set(["n"]))).toBe(false)
    expect(readSetTouched(set, "t", "*")).toBe(true)
    expect(readSetTouched(set, "t", undefined)).toBe(true)
    expect(readSetTouched(set, "o", "*")).toBe(false)
    db.close()
  })

  test("a `*` read-set is touched by any column", () => {
    const db = fixture()
    const set = readSetOf(db, "select count(*) as c from t")
    expect(readSetTouched(set, "t", new Set(["n"]))).toBe(true)
    db.close()
  })
})
