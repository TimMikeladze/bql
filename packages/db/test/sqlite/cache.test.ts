// P7. Three claims `docs/p7-plan-cache.md` makes about the prepared-statement cache, none of which
// was pinned anywhere before: that a cached statement survives DDL on its own connection, that
// changing the authorizer expires one compiled under the old verdicts, and that the ceiling
// evicts by finalizing rather than by leaking.

import { afterAll, describe, expect, test } from "bun:test"
import { Database, SQLITE_DENY, SQLITE_OK, SQLITE_READ, SqliteError } from "../../src/sqlite/index.ts"
import { cleanupTempDirs, tempDb } from "./tmp.ts"

afterAll(cleanupTempDirs)

describe("statement cache and DDL", () => {
  // Since `prepare_v2`, `sqlite3_step` re-prepares transparently on `SQLITE_SCHEMA`: the handle
  // stays valid across a schema change and the caller never sees the code. The cache hands the
  // same object back, so if that were not true the second `.all()` would raise SQLITE_SCHEMA.
  test("a cached statement keeps answering across CREATE TABLE and ALTER TABLE", () => {
    const db = Database.open(tempDb())
    db.exec("create table t(id integer primary key, v text)")
    db.exec("insert into t(v) values ('a'), ('b')")

    const sql = "select id, v from t order by id"
    const first = db.prepare(sql)
    expect(first.all()).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ])

    // A new table on the same connection bumps the schema cookie.
    db.exec("create table other(id integer primary key)")
    expect(db.prepare(sql)).toBe(first)
    expect(first.all()).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ])

    // And so does a column added to the very table the statement reads.
    db.exec("alter table t add column n integer default 7")
    const again = db.prepare(sql)
    expect(again).toBe(first)
    expect(again.all()).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ])
    // `select *` recompiled after the ALTER sees the new column, which is the schema change
    // actually reaching the compiler rather than a cached plan answering from before it.
    expect(db.prepare("select * from t order by id").get()).toEqual({ id: 1, v: "a", n: 7 })
    db.close()
  })
})

describe("statement cache and the authorizer", () => {
  // `Database.authorizer()` re-arms `sqlite3_set_authorizer` on every change *specifically*
  // because that is what expires statements the cache compiled under the old verdicts. Remove the
  // re-arm — swap `#onAuth` without calling `sqlite3_set_authorizer` — and this test reads the
  // row it is no longer allowed to read.
  test("changing the authorizer invalidates a statement compiled under the old one", () => {
    const db = Database.open(tempDb())
    db.exec("create table t(id integer primary key, secret text)")
    db.exec("insert into t(secret) values ('shh')")

    db.authorizer(() => SQLITE_OK)
    const sql = "select secret from t"
    const stmt = db.prepare(sql)
    expect(stmt.get()).toEqual({ secret: "shh" })

    db.authorizer((action, arg1, arg2) =>
      action === SQLITE_READ && arg1 === "t" && arg2 === "secret" ? SQLITE_DENY : SQLITE_OK,
    )
    // The cache still holds the same object — this is not a re-prepare in disguise.
    expect(db.prepare(sql)).toBe(stmt)
    expect(() => stmt.get()).toThrow(SqliteError)
    try {
      stmt.get()
    } catch (err) {
      expect((err as SqliteError).message).toContain("access to t.secret is prohibited")
    }

    // And back: allowing it again re-authorises the same cached statement.
    db.authorizer(() => SQLITE_OK)
    expect(db.prepare(sql)).toBe(stmt)
    expect(stmt.get()).toEqual({ secret: "shh" })
    db.close()
  })
})

describe("statementCache bound", () => {
  test("a connection at 4 evicts the fifth text and finalizes the victim", () => {
    const db = Database.open(tempDb(), { statementCache: 4 })
    db.exec("create table t(id integer primary key, v text)")
    db.exec("insert into t(v) values ('a')")
    expect(db.statementCacheLimit).toBe(4)

    const texts = [0, 1, 2, 3, 4].map((i) => `select id, v from t where id >= ${i}`)
    const held = texts.slice(0, 4).map((sql) => db.prepare(sql))
    expect(db.statementCacheSize).toBe(4)
    expect(db.cacheCounters).toEqual({ hits: 0, misses: 4, evictions: 0 })
    for (const stmt of held) expect(stmt.finalized).toBe(false)

    // The fifth text is one past the ceiling: the oldest goes, and it goes finalized.
    db.prepare(texts[4] as string)
    expect(db.statementCacheSize).toBe(4)
    expect(db.cacheCounters).toEqual({ hits: 0, misses: 5, evictions: 1 })
    expect(held[0]?.finalized).toBe(true)
    expect(held[1]?.finalized).toBe(false)

    // A finalized statement is gone from the cache, so asking for its text compiles a new one.
    const back = db.prepare(texts[0] as string)
    expect(back).not.toBe(held[0])
    expect(db.cacheCounters).toEqual({ hits: 0, misses: 6, evictions: 2 })

    // And a repeat of a live text is a hit rather than a compile.
    db.prepare(texts[4] as string)
    expect(db.cacheCounters.hits).toBe(1)
    expect(db.cacheCounters.misses).toBe(6)

    db.close()
  })

  test("the default is 64 and the counters are per connection unless one is shared", () => {
    const shared = { hits: 0, misses: 0, evictions: 0 }
    const a = Database.open(tempDb(), { cacheCounters: shared })
    const b = Database.open(tempDb(), { cacheCounters: shared })
    expect(a.statementCacheLimit).toBe(64)
    a.exec("create table t(id integer primary key)")
    b.exec("create table t(id integer primary key)")
    a.prepare("select id from t")
    a.prepare("select id from t")
    b.prepare("select id from t")
    // One object, two connections: the registry's totals survive either of them closing.
    expect(shared).toEqual({ hits: 1, misses: 2, evictions: 0 })
    expect(a.cacheCounters).toBe(shared)
    a.close()
    b.close()
    expect(shared).toEqual({ hits: 1, misses: 2, evictions: 0 })
  })
})
