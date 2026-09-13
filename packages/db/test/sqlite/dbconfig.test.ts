// `SQLITE_DBCONFIG_DEFENSIVE` through the vendored build's non-variadic shim
// (`docs/p1-pragmas.md`). It has no pragma, `sqlite3_db_config` is variadic, and bun:ffi cannot
// call a variadic function — so this is the one capability that exists only in the artefact
// `bun run sqlite:build` produces.
//
// The previous attempt declared the variadic function as fixed-arity and failed three ways: the
// value ignored, the out-parameter never written, and SIGKILL on the second call. Each of those is
// asserted against here, which is why the loop at the end is not decoration.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "../../src/sqlite/index.ts"
import { sqlite } from "../../src/sqlite/lib.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
})

function open(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-dbconfig-"))
  dirs.push(dir)
  const db = Database.open(path.join(dir, "t.db"))
  db.exec("create table t (a integer)")
  return db
}

/** Does this build carry the shim? A system libsqlite3 does not, and then there is nothing to test. */
const available = sqlite().walsum !== null

describe.if(available)("SQLITE_DBCONFIG_DEFENSIVE", () => {
  test("sets, reads back, and the value is not ignored", () => {
    const db = open()
    try {
      // -1 reads without changing, which is how the setting as it stands is learned at all.
      expect(db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", -1)).toBe(0)
      expect(db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", 1)).toBe(1)
      expect(db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", -1)).toBe(1)
      expect(db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", 0)).toBe(0)
    } finally {
      db.close()
    }
  })

  test("actually refuses what it exists to refuse", () => {
    const db = open()
    try {
      db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", 1)
      expect(() => {
        db.exec("pragma writable_schema = on")
        db.exec("update sqlite_schema set name = 'z' where name = 't'")
      }).toThrow(/sqlite_master may not be modified/)

      // …and stops refusing when it is turned off, which is what proves the first half was the
      // setting rather than something else about the connection.
      db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", 0)
      db.exec("pragma writable_schema = on")
      db.exec("update sqlite_schema set name = 'z' where name = 't'")
    } finally {
      db.close()
    }
  })

  test("survives being called repeatedly", () => {
    // The fixed-arity mis-declaration died with SIGKILL on the *second* call, so one call proving
    // nothing is exactly the trap this avoids.
    const db = open()
    try {
      for (let i = 0; i < 100; i++) db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", i % 2)
      expect(db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", -1)).toBe(1)
    } finally {
      db.close()
    }
  })

  test("an unknown op name is a RangeError rather than a call into the library", () => {
    const db = open()
    try {
      expect(() => db.dbConfig("NOT_AN_OP" as never, 1)).toThrow(RangeError)
    } finally {
      db.close()
    }
  })
})
