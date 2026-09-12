// Statement verbs, the prepared-statement cache, transactions and error mapping.

import { afterAll, describe, expect, test } from "bun:test"
import { Database, SqliteError } from "../../src/sqlite/index.ts"
import { cleanupTempDirs, tempDb } from "./tmp.ts"

afterAll(cleanupTempDirs)

function fresh(): Database {
  const db = Database.open(tempDb())
  db.exec("create table t(id integer primary key, v text not null)")
  return db
}

describe("statement verbs", () => {
  const db = fresh()
  db.exec("insert into t(v) values ('a'), ('b'), ('c')")

  test("get returns the first row, or null", () => {
    expect(db.prepare("select v from t order by id").get()).toEqual({ v: "a" })
    expect(db.prepare("select v from t where id = ?").get(999)).toBe(null)
  })

  test("all returns objects, values returns arrays", () => {
    expect(db.prepare("select id, v from t order by id").all()).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
      { id: 3, v: "c" },
    ])
    expect(db.prepare("select id, v from t order by id").values()).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ])
  })

  test("run reports changes and the last rowid", () => {
    const result = db.prepare("insert into t(v) values (?)").run("d")
    expect(result.changes).toBe(1)
    expect(result.lastInsertRowid).toBe(4)
    expect(db.prepare("update t set v = v where id <= 2").run().changes).toBe(2)
  })

  test("iterate yields lazily and resets when exhausted", () => {
    const stmt = db.prepare("select v from t order by id")
    expect([...stmt.iterate()].map((r) => r.v)).toEqual(["a", "b", "c", "d"])
    // The statement is reset, so a second full pass works.
    expect([...stmt.iterate()].map((r) => r.v)).toEqual(["a", "b", "c", "d"])
  })

  test("iterate resets on an early break, leaving no open read", () => {
    const stmt = db.prepare("select v from t order by id")
    const seen: string[] = []
    for (const row of stmt.iterate()) {
      seen.push(row.v as string)
      if (seen.length === 2) break
    }
    expect(seen).toEqual(["a", "b"])
    expect(db.inTransaction).toBe(false)
    expect(stmt.get()).toEqual({ v: "a" })
  })

  test("a statement is iterable directly", () => {
    expect([...db.prepare("select id from t order by id")].length).toBe(4)
  })

  test("metadata", () => {
    const stmt = db.prepare("select id, v, id + 1 as next from t")
    expect(stmt.columnNames).toEqual(["id", "v", "next"])
    expect(stmt.declaredTypes).toEqual(["INTEGER", "TEXT", null])
    expect(stmt.readonly).toBe(true)
    expect(db.prepare("insert into t(v) values (?)").readonly).toBe(false)
    expect(db.prepare("select ?, ?, ?").paramsCount).toBe(3)
  })

  test("finalize makes further use throw and drops the cache entry", () => {
    const sql = "select 1 as one"
    const stmt = db.prepare(sql)
    expect(db.prepare(sql)).toBe(stmt)
    stmt.finalize()
    expect(() => stmt.get()).toThrow(/finalized/)
    expect(db.prepare(sql)).not.toBe(stmt)
    expect(db.prepare(sql).get()).toEqual({ one: 1 })
  })
})

describe("prepared statement cache", () => {
  test("the same SQL text returns the same statement", () => {
    const db = fresh()
    expect(db.prepare("select 1")).toBe(db.prepare("select 1"))
    expect(db.prepare("select 1")).not.toBe(db.prepare("select 2"))
    db.close()
  })

  test("it evicts least-recently-used past 64 entries and stays correct", () => {
    const db = fresh()
    const first = db.prepare("select 0 as n")
    for (let i = 1; i <= 64; i++) db.prepare(`select ${i} as n`)
    // `first` has been evicted and finalized; asking again re-prepares it.
    const again = db.prepare("select 0 as n")
    expect(again).not.toBe(first)
    expect(again.get()).toEqual({ n: 0 })
    // The most recent 64 are still live.
    expect(db.prepare("select 64 as n").get()).toEqual({ n: 64 })
    db.close()
  })
})

describe("transactions", () => {
  test("commit and rollback", () => {
    const db = fresh()
    const insert = db.transaction((vals: string[]) => {
      for (const v of vals) db.run("insert into t(v) values (?)", [v])
      return vals.length
    })
    expect(insert(["a", "b"])).toBe(2)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(2)

    expect(() => insert(["c", null as unknown as string])).toThrow(SqliteError)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(2)
    expect(db.inTransaction).toBe(false)
    db.close()
  })

  test("immediate and exclusive modes both commit", () => {
    const db = fresh()
    db.transaction(() => db.run("insert into t(v) values ('i')"), "immediate")()
    db.transaction(() => db.run("insert into t(v) values ('e')"), "exclusive")()
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(2)
    db.close()
  })

  test("a nested transaction rolls back to its savepoint, not the whole outer one", () => {
    const db = fresh()
    const inner = db.transaction((v: string) => {
      db.run("insert into t(v) values (?)", [v])
      if (v === "bad") throw new Error("inner failed")
    })
    const outer = db.transaction(() => {
      db.run("insert into t(v) values ('outer')")
      try {
        inner("bad")
      } catch {
        // swallowed: the savepoint rolled back, the outer transaction continues
      }
      inner("good")
    })
    outer()
    expect(db.prepare("select v from t order by id").values().flat()).toEqual(["outer", "good"])
    expect(db.inTransaction).toBe(false)
    db.close()
  })

  test("a throw inside the outermost transaction rolls the nested work back too", () => {
    const db = fresh()
    const inner = db.transaction(() => db.run("insert into t(v) values ('x')"))
    const outer = db.transaction(() => {
      inner()
      inner()
      throw new Error("outer failed")
    })
    expect(() => outer()).toThrow("outer failed")
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(0)
    db.close()
  })
})

describe("errors", () => {
  test("a unique violation carries the extended result code", () => {
    const db = fresh()
    db.exec("create table u(k text unique)")
    db.exec("insert into u values ('a')")
    try {
      db.exec("insert into u values ('a')")
      throw new Error("expected a constraint failure")
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteError)
      const e = err as SqliteError
      expect(e.code).toBe("SQLITE_CONSTRAINT_UNIQUE")
      expect(e.rc).toBe(2067)
      expect(e.message).toContain("UNIQUE constraint failed")
    }
    db.close()
  })

  test("other extended codes", () => {
    const db = fresh()
    const notNull = () => db.run("insert into t(v) values (?)", [null])
    expect(notNull).toThrow(SqliteError)
    try {
      notNull()
    } catch (err) {
      expect((err as SqliteError).code).toBe("SQLITE_CONSTRAINT_NOTNULL")
    }
    try {
      db.prepare("select * from nope")
    } catch (err) {
      expect((err as SqliteError).code).toBe("SQLITE_ERROR")
      expect((err as SqliteError).message).toContain("no such table")
    }
    db.close()
  })

  test("prepare rejects SQL holding more than one statement", () => {
    const db = fresh()
    expect(() => db.prepare("insert into t(v) values ('a'); insert into t(v) values ('b')")).toThrow(
      /single statement/,
    )
    // A single statement with a trailing semicolon is fine, and exec still runs scripts.
    expect(db.prepare("select 1 as one;").get()).toEqual({ one: 1 })
    db.exec("insert into t(v) values ('a'); insert into t(v) values ('b')")
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(2)
    db.close()
  })

  test("a read-only database refuses writes", () => {
    const path = tempDb()
    const writable = Database.open(path)
    writable.exec("create table t(v)")
    writable.close()
    const db = Database.open(path, { readonly: true })
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(0)
    try {
      db.exec("insert into t values (1)")
      throw new Error("expected a readonly failure")
    } catch (err) {
      expect((err as SqliteError).code).toContain("SQLITE_READONLY")
    }
    db.close()
  })

  test("using a closed database throws", () => {
    const db = fresh()
    db.close()
    expect(() => db.exec("select 1")).toThrow(/closed/)
    expect(db.closed).toBe(true)
    db.close() // idempotent
  })
})

describe("connection state", () => {
  test("filename, changes and totalChanges", () => {
    const path = tempDb()
    const db = Database.open(path)
    expect(db.filename).toBe(path)
    db.exec("create table t(v)")
    db.exec("insert into t values (1), (2), (3)")
    expect(db.changes).toBe(3)
    db.exec("insert into t values (4)")
    expect(db.changes).toBe(1)
    expect(db.totalChanges).toBe(4)
    expect(db.handle).toBeGreaterThan(0)
    db.close()
  })

  test("wal is the default journal mode and can be turned off", () => {
    const walDb = Database.open(tempDb())
    expect(walDb.prepare("pragma journal_mode").get()?.journal_mode).toBe("wal")
    walDb.close()
    const plain = Database.open(tempDb(), { wal: false })
    expect(plain.prepare("pragma journal_mode").get()?.journal_mode).toBe("delete")
    plain.close()
  })

  test("create: false refuses to make a new file", () => {
    expect(() => Database.open(tempDb("missing.db"), { create: false })).toThrow(SqliteError)
  })
})
