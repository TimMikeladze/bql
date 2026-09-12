// Hooks, the authorizer, deadlines, limits, checkpointing and session changesets: everything
// the driver exists for that bun:sqlite cannot do.

import { afterAll, describe, expect, test } from "bun:test"
import {
  Database,
  FeatureUnavailableError,
  SqliteError,
  sqlite,
  candidatePaths,
  loadFrom,
  SQLITE_DELETE,
  SQLITE_DENY,
  SQLITE_IGNORE,
  SQLITE_INSERT,
  SQLITE_READ,
  SQLITE_UPDATE,
} from "../../src/sqlite/index.ts"
import { cleanupTempDirs, tempDb } from "./tmp.ts"

afterAll(cleanupTempDirs)

const features = sqlite().features

function fresh(): Database {
  const db = Database.open(tempDb())
  db.exec("create table t(id integer primary key, v text)")
  return db
}

describe("update hook", () => {
  test("reports every insert, update and delete with its rowid", () => {
    const db = fresh()
    const events: [number, string, string, bigint][] = []
    db.onUpdate((op, dbName, table, rowid) => events.push([op, dbName, table, rowid]))
    db.run("insert into t(v) values ('a')")
    db.run("update t set v = 'b' where id = 1")
    db.run("delete from t where id = 1")
    expect(events).toEqual([
      [SQLITE_INSERT, "main", "t", 1n],
      [SQLITE_UPDATE, "main", "t", 1n],
      [SQLITE_DELETE, "main", "t", 1n],
    ])
    db.close()
  })

  test("removing the hook stops the callbacks", () => {
    const db = fresh()
    let count = 0
    db.onUpdate(() => count++)
    db.run("insert into t(v) values ('a')")
    db.onUpdate(null)
    db.run("insert into t(v) values ('b')")
    expect(count).toBe(1)
    db.close()
  })

  test("multi-row statements fire once per row", () => {
    const db = fresh()
    let count = 0
    db.onUpdate(() => count++)
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    db.exec("delete from t where id > 0")
    expect(count).toBe(6)
    db.close()
  })

  test("a bare DELETE FROM is truncated: the update hook alone does not see the rows", () => {
    const db = fresh()
    let count = 0
    db.onUpdate(() => count++)
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    count = 0
    db.exec("delete from t")
    // SQLite drops the whole table without visiting rows, and the update hook never fires.
    expect(count).toBe(0)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(0)

    // A WHERE clause defeats the optimization.
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    count = 0
    db.exec("delete from t where 1")
    expect(count).toBe(3)
    db.close()
  })

  test("an authorizer returning SQLITE_IGNORE for DELETE recovers every deleted row", () => {
    const db = fresh()
    let count = 0
    db.onUpdate(() => count++)
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    db.authorizer((action) => (action === SQLITE_DELETE ? SQLITE_IGNORE : 0))
    count = 0
    db.exec("delete from t")
    db.authorizer(null)
    expect(count).toBe(3)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(0)
    db.close()
  })

})

describe.if(features.preupdate)("preupdate hook", () => {
  test("exposes OLD and NEW column values", () => {
    const db = fresh()
    const seen: { op: number; old: unknown[]; next: unknown[] }[] = []
    db.onPreupdate((op, _dbName, _table, _oldRowid, _newRowid, acc) => {
      const n = acc.count()
      const oldValues: unknown[] = []
      const newValues: unknown[] = []
      for (let i = 0; i < n; i++) {
        if (op !== SQLITE_INSERT) oldValues.push(acc.old(i))
        if (op !== SQLITE_DELETE) newValues.push(acc.new(i))
      }
      seen.push({ op, old: oldValues, next: newValues })
    })
    db.run("insert into t(v) values ('a')")
    db.run("update t set v = 'b' where id = 1")
    db.run("delete from t where id = 1")
    expect(seen).toEqual([
      { op: SQLITE_INSERT, old: [], next: [1, "a"] },
      { op: SQLITE_UPDATE, old: [1, "a"], next: [1, "b"] },
      { op: SQLITE_DELETE, old: [1, "b"], next: [] },
    ])
    db.close()
  })

  test("fires for a WITHOUT ROWID table, which the update hook cannot see", () => {
    const db = fresh()
    db.exec("create table wr(k text primary key, v text) without rowid")
    const pre: unknown[][] = []
    let updateHookCalls = 0
    db.onUpdate(() => updateHookCalls++)
    db.onPreupdate((op, _d, table, _o, _n, acc) => {
      if (table !== "wr") return
      const row: unknown[] = []
      for (let i = 0; i < acc.count(); i++) {
        row.push(op === SQLITE_DELETE ? acc.old(i) : acc.new(i))
      }
      pre.push(row)
    })
    db.run("insert into wr values ('k1', 'v1')")
    db.run("update wr set v = 'v2' where k = 'k1'")
    db.run("delete from wr where k = 'k1'")
    expect(pre).toEqual([
      ["k1", "v1"],
      ["k1", "v2"],
      ["k1", "v2"],
    ])
    expect(updateHookCalls).toBe(0)
    db.close()
  })

  test("it defeats the truncate optimization, so a bare DELETE FROM reports every row", () => {
    // This is why change capture prefers the preupdate hook: no authorizer trick is needed.
    const db = fresh()
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    let count = 0
    db.onPreupdate(() => count++)
    db.exec("delete from t")
    expect(count).toBe(3)
    db.close()
  })

  test("rowids are reported for rowid tables", () => {
    const db = fresh()
    const keys: [bigint, bigint][] = []
    db.onPreupdate((_op, _d, _t, oldRowid, newRowid) => keys.push([oldRowid, newRowid]))
    db.run("insert into t(v) values ('a')")
    db.run("update t set id = 5 where id = 1")
    expect(keys).toEqual([
      [1n, 1n],
      [1n, 5n],
    ])
    db.close()
  })
})

describe.if(!features.preupdate)("preupdate hook when the library lacks it", () => {
  test("installing one reports the missing build flag", () => {
    const db = fresh()
    expect(() => db.onPreupdate(() => {})).toThrow(FeatureUnavailableError)
    db.close()
  })
})

describe("commit, rollback and wal hooks", () => {
  test("commit fires once per transaction and can veto it", () => {
    const db = fresh()
    let commits = 0
    db.onCommit(() => {
      commits++
    })
    db.transaction(() => {
      db.run("insert into t(v) values ('a')")
      db.run("insert into t(v) values ('b')")
    })()
    expect(commits).toBe(1)

    db.onCommit(() => false)
    expect(() => db.run("insert into t(v) values ('c')")).toThrow(SqliteError)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(2)
    db.onCommit(null)
    db.run("insert into t(v) values ('d')")
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(3)
    db.close()
  })

  test("rollback fires when a transaction is undone", () => {
    const db = fresh()
    let rollbacks = 0
    db.onRollback(() => rollbacks++)
    db.exec("begin")
    db.run("insert into t(v) values ('a')")
    db.exec("rollback")
    expect(rollbacks).toBe(1)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(0)
    db.close()
  })

  test("wal hook reports the frame count after each commit", () => {
    const db = fresh()
    const frames: [string, number][] = []
    db.onWal((dbName, n) => frames.push([dbName, n]))
    db.run("insert into t(v) values ('a')")
    db.run("insert into t(v) values ('b')")
    expect(frames.length).toBe(2)
    expect(frames[0]?.[0]).toBe("main")
    expect(frames[0]?.[1]).toBeGreaterThan(0)
    expect(frames[1]?.[1]).toBeGreaterThan(frames[0]?.[1] as number)
    db.close()
  })
})

describe("authorizer", () => {
  test("denying an action fails the statement with SQLITE_AUTH", () => {
    const db = fresh()
    db.run("insert into t(v) values ('a')")
    db.authorizer((action) => (action === SQLITE_INSERT ? SQLITE_DENY : 0))
    try {
      db.prepare("insert into t(v) values ('b')")
      throw new Error("expected the insert to be denied")
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteError)
      expect((err as SqliteError).code).toBe("SQLITE_AUTH")
      expect((err as SqliteError).message).toBe("not authorized")
    }
    db.authorizer(null)
    db.run("insert into t(v) values ('b')")
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(2)
    db.close()
  })

  test("it sees the table and column of every read", () => {
    const db = fresh()
    const reads: string[] = []
    db.authorizer((action, arg1, arg2) => {
      if (action === SQLITE_READ) reads.push(`${arg1}.${arg2}`)
      return 0
    })
    db.prepare("select id, v from t").all()
    db.authorizer(null)
    expect(reads).toEqual(["t.id", "t.v"])
    db.close()
  })

  test("SQLITE_IGNORE turns a denied column read into NULL", () => {
    const db = fresh()
    db.run("insert into t(v) values ('secret')")
    db.authorizer((action, _arg1, arg2) =>
      action === SQLITE_READ && arg2 === "v" ? SQLITE_IGNORE : 0,
    )
    const row = db.prepare("select id, v from t").get()
    db.authorizer(null)
    expect(row).toEqual({ id: 1, v: null })
    db.close()
  })

  test("a throwing authorizer denies rather than unwinding through C", () => {
    const db = fresh()
    db.authorizer(() => {
      throw new Error("boom")
    })
    expect(() => db.prepare("select 1")).toThrow(SqliteError)
    db.authorizer(null)
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 })
    db.close()
  })
})

describe("deadline", () => {
  test("it interrupts a runaway query", () => {
    const db = fresh()
    db.deadline(25)
    const started = performance.now()
    try {
      db.prepare(
        "with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c",
      ).get()
      throw new Error("expected the query to be interrupted")
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteError)
      expect((err as SqliteError).code).toBe("SQLITE_INTERRUPT")
    }
    expect(performance.now() - started).toBeLessThan(2000)
    db.deadline(null)
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 })
    db.close()
  })

  test("a query that finishes inside the deadline is untouched", () => {
    const db = fresh()
    db.exec("insert into t(v) values ('a'), ('b')")
    db.deadline(5000)
    expect(db.prepare("select count(*) c from t").get()?.c).toBe(2)
    db.deadline(null)
    db.close()
  })
})

describe("limits", () => {
  test("sqlite3_limit returns the previous value and is enforced", () => {
    const db = fresh()
    const previous = db.limit("SQLITE_LIMIT_SQL_LENGTH", 60)
    expect(previous).toBeGreaterThan(60)
    expect(() => db.prepare(`select '${"x".repeat(200)}'`)).toThrow(SqliteError)
    db.limit("SQLITE_LIMIT_SQL_LENGTH", previous)
    expect(db.prepare(`select '${"x".repeat(200)}' as v`).get()?.v).toHaveLength(200)

    const before = db.limit("SQLITE_LIMIT_COMPOUND_SELECT", 1)
    expect(() => db.prepare("select 1 union select 2 union select 3")).toThrow(SqliteError)
    db.limit("SQLITE_LIMIT_COMPOUND_SELECT", before)
    db.close()
  })

  test("an unknown limit name is rejected", () => {
    const db = fresh()
    expect(() => db.limit("NOPE" as never, 1)).toThrow(RangeError)
    db.close()
  })
})

describe("wal checkpoint and file control", () => {
  test("checkpoint reports the log and checkpointed frame counts", () => {
    const db = fresh()
    db.exec("insert into t(v) values ('a'), ('b'), ('c')")
    const passive = db.walCheckpoint("PASSIVE")
    expect(passive.busy).toBe(false)
    expect(passive.log).toBeGreaterThan(0)
    expect(passive.checkpointed).toBe(passive.log)

    db.exec("insert into t(v) values ('d')")
    const truncate = db.walCheckpoint("TRUNCATE")
    expect(truncate).toEqual({ busy: false, log: 0, checkpointed: 0 })
    expect(() => db.walCheckpoint("NOPE" as never)).toThrow(RangeError)
    db.close()
  })

  test("file control reaches the VFS", () => {
    const db = fresh()
    const out = new Int32Array(1)
    expect(db.fileControl("SQLITE_FCNTL_HAS_MOVED", out)).toBe(0)
    expect(out[0]).toBe(0)
    // Unimplemented opcodes come back as SQLITE_NOTFOUND rather than throwing.
    expect(db.fileControl(999999)).toBe(12)
    db.close()
  })

  test("busyTimeout is accepted", () => {
    const db = fresh()
    db.busyTimeout(1234)
    expect(db.prepare("pragma busy_timeout").get()?.timeout).toBe(1234)
    db.close()
  })
})

describe.if(features.session)("session changesets", () => {
  test("a changeset generated on one database applies to another", () => {
    const source = fresh()
    const target = fresh()
    source.run("insert into t(v) values ('before')")

    const session = source.session()
    source.transaction(() => {
      source.run("insert into t(v) values ('one')")
      source.run("insert into t(v) values ('two')")
      source.run("update t set v = 'ONE' where v = 'one'")
    })()
    const changeset = session.changeset()
    const patchset = session.patchset()
    session.close()

    expect(changeset.byteLength).toBeGreaterThan(0)
    expect(patchset.byteLength).toBeGreaterThan(0)
    expect(patchset.byteLength).toBeLessThanOrEqual(changeset.byteLength)

    target.applyChangeset(changeset)
    expect(target.prepare("select v from t order by id").values().flat()).toEqual(["ONE", "two"])

    source.close()
    target.close()
  })

  test("enable(false) stops recording", () => {
    const db = fresh()
    const session = db.session()
    db.run("insert into t(v) values ('recorded')")
    session.enable(false)
    db.run("insert into t(v) values ('ignored')")
    session.enable(true)
    const applied = fresh()
    applied.applyChangeset(session.changeset())
    session.close()
    expect(applied.prepare("select v from t").values().flat()).toEqual(["recorded"])
    db.close()
    applied.close()
  })

  test("using a closed session throws", () => {
    const db = fresh()
    const session = db.session()
    session.close()
    expect(() => session.changeset()).toThrow(/closed/)
    session.close() // idempotent
    db.close()
  })
})

describe.if(!features.session)("session extension when the library lacks it", () => {
  test("session() reports the missing build flag", () => {
    const db = fresh()
    expect(() => db.session()).toThrow(FeatureUnavailableError)
    db.close()
  })
})

describe("library and feature detection", () => {
  test("the loaded library is described", () => {
    const lib = sqlite()
    expect(lib.path.length).toBeGreaterThan(0)
    expect(lib.version).toMatch(/^3\.\d+\.\d+/)
    expect(lib.versionNumber).toBeGreaterThanOrEqual(3_035_000)
    expect(lib.compileOptions.length).toBeGreaterThan(0)
  })

  test("optional features are reported from compile options and symbol presence", () => {
    const lib = sqlite()
    const declaresSession = lib.compileOptions.includes("ENABLE_SESSION")
    expect(lib.features.session).toBe(declaresSession && lib.session !== null)
    const declaresPreupdate = lib.compileOptions.includes("ENABLE_PREUPDATE_HOOK")
    expect(lib.features.preupdate).toBe(declaresPreupdate && lib.preupdate !== null)
    expect(typeof lib.features.fts5).toBe("boolean")
  })

  test("sqlite() returns the same handle every time", () => {
    expect(sqlite()).toBe(sqlite())
  })

  test("BUNQL_SQLITE_LIB is tried first", () => {
    const before = process.env.BUNQL_SQLITE_LIB
    process.env.BUNQL_SQLITE_LIB = "/custom/libsqlite3.dylib"
    try {
      expect(candidatePaths()[0]).toBe("/custom/libsqlite3.dylib")
    } finally {
      if (before === undefined) delete process.env.BUNQL_SQLITE_LIB
      else process.env.BUNQL_SQLITE_LIB = before
    }
    delete process.env.BUNQL_SQLITE_LIB
    expect(candidatePaths()[0]).not.toBe("/custom/libsqlite3.dylib")
  })

  test("when nothing loads, the error names the environment variable and what was tried", () => {
    try {
      loadFrom(["/nope/libsqlite3.so", "/also-nope/libsqlite3.dylib"])
      throw new Error("expected the load to fail")
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain("BUNQL_SQLITE_LIB")
      expect(message).toContain("/nope/libsqlite3.so")
      expect(message).toContain("/also-nope/libsqlite3.dylib")
    }
  })
})

describe("hook lifetime", () => {
  test("closing a database with every hook installed is safe", () => {
    const db = fresh()
    db.onUpdate(() => {})
    db.onCommit(() => {})
    db.onRollback(() => {})
    db.onWal(() => {})
    db.authorizer(() => 0)
    db.deadline(1000)
    if (features.preupdate) db.onPreupdate(() => {})
    db.run("insert into t(v) values ('a')")
    db.close()
    expect(db.closed).toBe(true)
  })
})
