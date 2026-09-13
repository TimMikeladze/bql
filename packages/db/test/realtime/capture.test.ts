// Change capture against a real connection: what each level buffers, what the two engines can
// see, and the transaction boundaries a change feed depends on.

import { afterAll, describe, expect, test } from "bun:test"
import { ChangeCapture } from "../../src/realtime/capture.ts"
import { sqlite } from "../../src/sqlite/index.ts"
import { cleanupTempDirs } from "../sqlite/tmp.ts"
import { open } from "./harness.ts"

afterAll(cleanupTempDirs)

const features = sqlite().features

function fresh() {
  return open("create table t(id integer primary key, v text, n int)")
}

describe.if(features.preupdate)("preupdate capture", () => {
  test("insert, update and delete carry pk, row and old at row+old", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "row+old", trackColumns: true })

    db.run("insert into t(v, n) values ('a', 1)")
    const inserted = capture.takeCommitted()
    expect(inserted?.rows).toEqual([
      { table: "t", op: "insert", rowid: 1n, pk: { id: 1 }, row: { id: 1, v: "a", n: 1 } },
    ])
    expect(inserted?.tables.get("t")).toEqual({
      ops: { insert: 1, update: 0, delete: 0 },
      columns: "*",
    })

    db.run("update t set v = 'b' where id = 1")
    const updated = capture.takeCommitted()
    expect(updated?.rows).toEqual([
      {
        table: "t",
        op: "update",
        rowid: 1n,
        pk: { id: 1 },
        row: { id: 1, v: "b", n: 1 },
        old: { id: 1, v: "a", n: 1 },
      },
    ])
    expect(updated?.tables.get("t")?.columns).toEqual(new Set(["v"]))

    db.run("delete from t where id = 1")
    const deleted = capture.takeCommitted()
    expect(deleted?.rows).toEqual([
      { table: "t", op: "delete", rowid: 1n, pk: { id: 1 }, old: { id: 1, v: "b", n: 1 } },
    ])

    expect(capture.takeCommitted()).toBeNull()
    capture.close()
    db.close()
  })

  test("levels decide how much of the row is buffered", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "none" })
    db.run("insert into t(v, n) values ('a', 1)")
    expect(capture.takeCommitted()?.rows).toEqual([
      { table: "t", op: "insert", rowid: 1n },
    ])

    capture.setLevel("pk")
    db.run("insert into t(v, n) values ('b', 2)")
    expect(capture.takeCommitted()?.rows).toEqual([
      { table: "t", op: "insert", rowid: 2n, pk: { id: 2 } },
    ])

    capture.setLevel("row")
    db.run("update t set n = 9 where id = 2")
    expect(capture.takeCommitted()?.rows).toEqual([
      { table: "t", op: "update", rowid: 2n, pk: { id: 2 }, row: { id: 2, v: "b", n: 9 } },
    ])
    // `row` gives a delete its key but not the row that went away; that is `row+old`.
    db.run("delete from t where id = 2")
    expect(capture.takeCommitted()?.rows).toEqual([
      { table: "t", op: "delete", rowid: 2n, pk: { id: 2 } },
    ])

    capture.close()
    db.close()
  })

  test("a WITHOUT ROWID table reports pk and a null rowid", () => {
    const db = open("create table wr(k text primary key, v text) without rowid")
    const capture = new ChangeCapture(db, { includeRows: "row+old" })
    db.run("insert into wr values ('x', '1')")
    db.run("update wr set v = '2' where k = 'x'")
    const first = capture.takeCommitted()
    const second = capture.takeCommitted()
    expect(first?.rows).toEqual([
      { table: "wr", op: "insert", rowid: null, pk: { k: "x" }, row: { k: "x", v: "1" } },
    ])
    expect(second?.rows[0]?.old).toEqual({ k: "x", v: "1" })
    expect(second?.rows[0]?.rowid).toBeNull()
    capture.close()
    db.close()
  })

  test("a composite primary key is reported in full", () => {
    const db = open("create table c(a int, b int, v text, primary key(a, b))")
    const capture = new ChangeCapture(db, { includeRows: "pk" })
    db.run("insert into c values (1, 2, 'x')")
    expect(capture.takeCommitted()?.rows[0]?.pk).toEqual({ a: 1, b: 2 })
    capture.close()
    db.close()
  })

  test("DELETE FROM t reports every row without an authorizer trick", () => {
    const db = fresh()
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    const capture = new ChangeCapture(db, { includeRows: "pk" })
    db.exec("delete from t")
    const txn = capture.takeCommitted()
    expect(txn?.rows).toHaveLength(3)
    expect(txn?.tables.get("t")?.ops).toEqual({ insert: 0, update: 0, delete: 3 })
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(0)
    capture.close()
    db.close()
  })

  test("one transaction is one buffer, and a rollback empties it", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "pk" })
    db.transaction(() => {
      db.run("insert into t(v) values ('a')")
      db.run("insert into t(v) values ('b')")
    })()
    expect(capture.takeCommitted()?.rows).toHaveLength(2)

    db.exec("begin")
    db.run("insert into t(v) values ('c')")
    db.exec("rollback")
    expect(capture.takeCommitted()).toBeNull()
    capture.close()
    db.close()
  })

  test("rows beyond maxRowsPerTxn are dropped and flagged", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "pk", maxRowsPerTxn: 2 })
    db.exec("insert into t(v) values ('a'), ('b'), ('c'), ('d')")
    const txn = capture.takeCommitted()
    expect(txn?.rows).toHaveLength(2)
    expect(txn?.rowsTruncated).toBe(true)
    expect(txn?.tables.get("t")?.ops.insert).toBe(4)
    capture.close()
    db.close()
  })

  test("off uninstalls the hooks and costs nothing", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "row" })
    capture.setLevel("off")
    db.run("insert into t(v) values ('a')")
    expect(capture.takeCommitted()).toBeNull()
    capture.setLevel("row")
    db.run("insert into t(v) values ('b')")
    expect(capture.takeCommitted()?.rows).toHaveLength(1)
    capture.close()
    db.close()
  })
})

describe("update-hook fallback", () => {
  test("reports every row of a DELETE through the authorizer, with the rowid alias as pk", () => {
    const db = fresh()
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    const capture = new ChangeCapture(db, { includeRows: "pk", engine: "update" })
    expect(capture.engine).toBe("update")
    db.exec("delete from t")
    const txn = capture.takeCommitted()
    expect(txn?.rows).toHaveLength(3)
    expect(txn?.rows[0]).toEqual({ table: "t", op: "delete", rowid: 1n, pk: { id: 1 } })
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(0)
    capture.close()
    db.close()
  })

  test("it cannot see a WITHOUT ROWID table, which is why preupdate is the default", () => {
    const db = open("create table wr(k text primary key, v text) without rowid")
    const capture = new ChangeCapture(db, { includeRows: "pk", engine: "update" })
    db.run("insert into wr values ('x', '1')")
    expect(capture.takeCommitted()).toBeNull()
    capture.close()
    db.close()
  })
})

describe("schema changes", () => {
  test("DDL becomes a schema change list once the schema cookie confirms it", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "pk" })
    db.exec("create table zz(a int)")
    const created = capture.takeCommitted()
    expect(created?.schemaChanged).toBe(true)
    expect(created?.ddl).toContainEqual({ op: "create", object: "table", name: "zz" })

    db.exec("create index zz_a on zz(a)")
    expect(capture.takeCommitted()?.ddl).toContainEqual({
      op: "create",
      object: "index",
      name: "zz_a",
    })

    db.exec("alter table zz add column b int")
    expect(capture.takeCommitted()?.ddl).toContainEqual({
      op: "alter",
      object: "table",
      name: "zz",
    })

    db.exec("drop table zz")
    expect(capture.takeCommitted()?.ddl).toContainEqual({
      op: "drop",
      object: "table",
      name: "zz",
    })
    capture.close()
    db.close()
  })

  test("DDL that was prepared but never run does not fabricate a schema event", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "pk" })
    db.prepare("create table never_ran(a int)")
    db.run("insert into t(v) values ('a')")
    const txn = capture.takeCommitted()
    expect(txn?.schemaChanged).toBe(false)
    expect(txn?.ddl).toEqual([])
    capture.close()
    db.close()
  })

  test("column metadata survives a schema change", () => {
    const db = fresh()
    const capture = new ChangeCapture(db, { includeRows: "row" })
    db.run("insert into t(v, n) values ('a', 1)")
    expect(capture.takeCommitted()?.rows[0]?.row).toEqual({ id: 1, v: "a", n: 1 })
    db.exec("alter table t add column extra text")
    capture.takeCommitted()
    db.run("insert into t(v, n, extra) values ('b', 2, 'e')")
    expect(capture.takeCommitted()?.rows[0]?.row).toEqual({
      id: 2,
      v: "b",
      n: 2,
      extra: "e",
    })
    capture.close()
    db.close()
  })
})
