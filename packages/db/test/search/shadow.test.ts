// A virtual table's storage is not a table anyone made: it must not reach the change feed, live
// queries or the Data API. `src/sqlite/shadow.ts`.

import { afterAll, describe, expect, test } from "bun:test"
import { introspect } from "../../src/dataapi/index.ts"
import { ChangeCapture } from "../../src/realtime/capture.ts"
import { shadowOwner, virtualTables } from "../../src/sqlite/shadow.ts"
import { sqlite } from "../../src/sqlite/index.ts"
import { cleanupTempDirs } from "../sqlite/tmp.ts"
import { open } from "../realtime/harness.ts"

afterAll(cleanupTempDirs)

const features = sqlite().features

const SCHEMA = [
  "create table docs(id integer primary key, body text)",
  "create virtual table docs_fts using fts5(body, content='docs', content_rowid='id')",
  "create trigger docs_fts_ai after insert on docs begin insert into docs_fts(rowid, body) values (new.id, new.body); end",
  "create virtual table docs_vec using vec0(id integer primary key, embedding float[2])",
]

test("shadowOwner goes by what the module created for these options, not by the name", () => {
  const vtabs = virtualTables([
    { name: "Docs_Fts", sql: "CREATE VIRTUAL TABLE Docs_Fts USING fts5(body)" },
    { name: "ext", sql: "create virtual table ext using fts5(body, content='docs', content_rowid='id', columnsize=0)" },
    { name: "v", sql: "create virtual table v using vec0(id integer primary key, a float[2], b int8[4], kind text, n integer, +note text, chunk_size=8)" },
    { name: "plain_v", sql: "create virtual table plain_v using vec0(embedding float[2])" },
    { name: "plain", sql: "create table plain(x)" },
  ])
  expect([...vtabs.keys()]).toEqual(["Docs_Fts", "ext", "v", "plain_v"])
  expect(shadowOwner("docs_fts_data", vtabs)).toBe("Docs_Fts")
  expect(shadowOwner("docs_fts_content", vtabs)).toBe("Docs_Fts")
  // External content, no column sizes: FTS5 creates neither `_content` nor `_docsize`.
  expect(shadowOwner("ext_idx", vtabs)).toBe("ext")
  expect(shadowOwner("ext_content", vtabs)).toBeNull()
  expect(shadowOwner("ext_docsize", vtabs)).toBeNull()
  // vec0: one chunk table per vector column, per metadata column, text for text, one auxiliary.
  for (const name of ["v_vector_chunks00", "v_vector_chunks01", "v_metadatachunks00", "v_metadatatext00", "v_metadatachunks01", "v_auxiliary"]) {
    expect(shadowOwner(name, vtabs)).toBe("v")
  }
  for (const name of ["v_vector_chunks02", "v_metadatatext01", "plain_v_auxiliary", "plain_v_metadatachunks00"]) {
    expect(shadowOwner(name, vtabs)).toBeNull()
  }
  expect(shadowOwner("docs_fts_archive", vtabs)).toBeNull()
})

describe.if(features.preupdate && features.vec)("change capture", () => {
  test("shadow rows are dropped, marks re-based, and the virtual table stands in for them", () => {
    const db = open(...SCHEMA)
    const capture = new ChangeCapture(db, { includeRows: "row" })

    db.exec("begin")
    db.run("insert into docs(body) values ('hello')")
    capture.mark()
    db.prepare("insert into docs_vec(id, embedding) values (1, ?)").run(new Uint8Array(8))
    capture.mark()
    db.run("insert into docs(body) values ('again')")
    capture.mark()
    db.exec("commit")

    const txn = capture.takeCommitted()
    expect(txn?.rows.map((r) => r.table)).toEqual(["docs", "docs"])
    // Statement two wrote only shadow rows, so its slice is now empty and yields no event.
    expect(txn?.marks).toEqual([1, 1, 2])
    expect([...(txn?.tables.keys() ?? [])].sort()).toEqual(["docs", "docs_fts", "docs_vec"])
    expect(txn?.tables.get("docs_fts")?.columns).toBeUndefined()
    capture.close()
    db.close()
  })

  test("storage rows never count against maxRowsPerTxn", () => {
    const db = open(...SCHEMA)
    const capture = new ChangeCapture(db, { includeRows: "row", maxRowsPerTxn: 100 })
    db.exec("begin")
    for (let i = 0; i < 30; i++) db.run(`insert into docs(body) values ('row ${i} with some words')`)
    for (let i = 1; i <= 30; i++) db.prepare("insert into docs_vec(id, embedding) values (?, ?)").run(i, new Uint8Array(8))
    db.exec("commit")
    const txn = capture.takeCommitted()
    expect(txn?.rowsTruncated).toBe(false)
    expect(txn?.rows).toHaveLength(30)
    expect(txn?.tables.get("docs_vec")?.ops.insert).toBeGreaterThan(0)
    capture.close()
    db.close()
  })

  test("a real table named like storage the module did not create is reported as itself", () => {
    // External content has no `_content`; a vec0 table without `+aux` columns has no `_auxiliary`.
    const db = open(...SCHEMA, "create table docs_fts_content(x)", "create table docs_vec_auxiliary(x)")
    const capture = new ChangeCapture(db, { includeRows: "row" })
    db.run("insert into docs_fts_content(x) values (1)")
    db.run("insert into docs_vec_auxiliary(x) values (2)")
    const tables = capture.takeAllCommitted().flatMap((t) => t.rows.map((r) => r.table))
    expect(tables).toEqual(["docs_fts_content", "docs_vec_auxiliary"])
    capture.close()
    db.close()
  })

  test("with column tracking the virtual table reads as every column changed", () => {
    const db = open(...SCHEMA)
    const capture = new ChangeCapture(db, { includeRows: "none", trackColumns: true })
    db.run("insert into docs(body) values ('hello')")
    const txn = capture.takeCommitted()
    expect(txn?.tables.get("docs_fts")?.columns).toBe("*")
    capture.close()
    db.close()
  })
})

describe.if(features.vec)("Data API introspection", () => {
  test("lists the source table, not the virtual table or any of its storage", async () => {
    const db = open(...SCHEMA)
    const schema = await introspect("t", (statement) => {
      const stmt = db.prepare(statement.sql)
      return { columns: stmt.columnNames, rows: stmt.values(...(statement.args ?? [])), rowsAffected: 0, txid: 0 }
    })
    // `docs_vec_vector_chunks00` is the one `PRAGMA table_list` calls a plain table.
    expect(schema.tables.map((t) => t.name)).toEqual(["docs"])
    db.close()
  })

  test("keeps a real table that only looks like storage", async () => {
    const db = open(...SCHEMA, "create table docs_fts_content(x)", "create table docs_vec_auxiliary(x)")
    const schema = await introspect("t", (statement) => {
      const stmt = db.prepare(statement.sql)
      return { columns: stmt.columnNames, rows: stmt.values(...(statement.args ?? [])), rowsAffected: 0, txid: 0 }
    })
    // `PRAGMA table_list` calls both of these `shadow`; neither is.
    expect(schema.tables.map((t) => t.name)).toEqual(["docs", "docs_fts_content", "docs_vec_auxiliary"])
    db.close()
  })
})

describe.if(features.vec && features.fts5 && features.rtree)("the derived shadow set", () => {
  test("is exactly what each module created, across option combinations", () => {
    const statements = [
      "create virtual table f1 using fts5(a, b)",
      "create virtual table f2 using fts5(a, content='', columnsize=0)",
      "create virtual table f3 using fts5(a, content='t', content_rowid='id')",
      "create virtual table f4 using fts5(a, content='', contentless_unindexed=1, b unindexed)",
      "create virtual table f5 using fts4(a, matchinfo=fts3)",
      "create virtual table r1 using rtree(id, x0, x1)",
      "create virtual table v1 using vec0(embedding float[2])",
      "create virtual table v2 using vec0(id text primary key, a float[2] distance_metric=cosine, b bit[8], user_id integer partition key, kind text, n int, ok boolean, +note text)",
    ]
    const db = open("create table t(id integer primary key, a text)", ...statements)
    const vtabs = virtualTables(db.prepare("select name, sql from sqlite_schema").all() as never[])
    const tables = db.prepare("select name from sqlite_schema where type = 'table'").all() as { name: string }[]
    const derived = tables.filter((t) => shadowOwner(t.name, vtabs) !== null).map((t) => t.name).sort()
    const created = tables
      .map((t) => t.name)
      .filter((name) => name !== "t" && !vtabs.has(name) && !name.startsWith("sqlite_"))
      .sort()
    expect(derived).toEqual(created)
    db.close()
  })
})
