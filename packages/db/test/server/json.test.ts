// The wire codec: what JSON can carry unchanged stays plain, and the three things it cannot are
// tagged. Round trips go through a real connection, because the only definition of "unchanged"
// that matters is what SQLite gives back.

import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "../../src/sqlite/index.ts"
import {
  decodeArg,
  decodeArgs,
  encodeInteger,
  encodeRows,
  encodeValue,
  fromBase64,
  toBase64,
  toBase64Url,
} from "../../src/server/json.ts"
import { BqlError } from "../../src/server/errors.ts"
import type { ObjectRow, Value } from "../../src/client/protocol.ts"
import { cleanupTempDirs, tempDb } from "../sqlite/tmp.ts"

afterAll(cleanupTempDirs)

function fresh(): Database {
  const db = Database.open(tempDb())
  db.exec("create table t(id integer primary key, v text, n integer, r real, b blob)")
  return db
}

describe("encodeValue", () => {
  test("passes plain values through untouched", () => {
    expect(encodeValue("hello")).toBe("hello")
    expect(encodeValue("")).toBe("")
    expect(encodeValue(42)).toBe(42)
    expect(encodeValue(-1.5)).toBe(-1.5)
    expect(encodeValue(null)).toBe(null)
  })

  test("tags integers only once a JSON number would lose them", () => {
    expect(encodeValue(9007199254740991n)).toBe(9007199254740991) // 2^53 - 1
    expect(encodeValue(9007199254740992n)).toEqual({ $i: "9007199254740992" }) // 2^53
    expect(encodeValue(9007199254740993n)).toEqual({ $i: "9007199254740993" }) // 2^53 + 1
    expect(encodeValue(-9007199254740991n)).toBe(-9007199254740991)
    expect(encodeValue(-9007199254740993n)).toEqual({ $i: "-9007199254740993" })
    expect(encodeValue(0n)).toBe(0)
  })

  test("tags non-finite doubles", () => {
    expect(encodeValue(Number.POSITIVE_INFINITY)).toEqual({ $f: "inf" })
    expect(encodeValue(Number.NEGATIVE_INFINITY)).toEqual({ $f: "-inf" })
    expect(encodeValue(Number.NaN)).toEqual({ $f: "nan" })
  })

  test("tags blobs as base64", () => {
    expect(encodeValue(new Uint8Array([0, 1, 251, 255]))).toEqual({ $b: "AAH7/w==" })
    expect(encodeValue(new Uint8Array(0))).toEqual({ $b: "" })
  })

  test("encodeInteger narrows a rowid only when it is safe", () => {
    expect(encodeInteger(7)).toBe(7)
    expect(encodeInteger(7n)).toBe(7)
    expect(encodeInteger(2n ** 62n)).toEqual({ $i: "4611686018427387904" })
  })
})

describe("decodeArg", () => {
  test("inverts encodeValue", () => {
    expect(decodeArg("hello")).toBe("hello")
    expect(decodeArg(42)).toBe(42)
    expect(decodeArg(true)).toBe(true)
    expect(decodeArg(null)).toBe(null)
    expect(decodeArg({ $i: "9007199254740993" })).toBe(9007199254740993n)
    expect(decodeArg({ $i: "-9007199254740993" })).toBe(-9007199254740993n)
    expect(decodeArg({ $b: "AAH7/w==" })).toEqual(new Uint8Array([0, 1, 251, 255]))
    expect(decodeArg({ $f: "inf" })).toBe(Number.POSITIVE_INFINITY)
    expect(decodeArg({ $f: "-inf" })).toBe(Number.NEGATIVE_INFINITY)
    expect(decodeArg({ $f: "nan" })).toBeNaN()
  })

  test("accepts Hrana's typed values, so the compat layer can share this decoder", () => {
    expect(decodeArg({ type: "null" })).toBe(null)
    expect(decodeArg({ type: "integer", value: "42" })).toBe(42)
    expect(decodeArg({ type: "integer", value: "9007199254740993" })).toBe(9007199254740993n)
    expect(decodeArg({ type: "float", value: 1.5 })).toBe(1.5)
    expect(decodeArg({ type: "text", value: "hi" })).toBe("hi")
    expect(decodeArg({ type: "blob", base64: "AAE=" })).toEqual(new Uint8Array([0, 1]))
  })

  test("rejects what it cannot bind, as a 400", () => {
    expect(() => decodeArg({ $i: "12.5" })).toThrow(BqlError)
    expect(() => decodeArg({ $f: "huge" })).toThrow(BqlError)
    expect(() => decodeArg({ nope: 1 })).toThrow(BqlError)
    try {
      decodeArg({ nope: 1 })
    } catch (err) {
      expect((err as BqlError).status).toBe(400)
      expect((err as BqlError).code).toBe("BAD_REQUEST")
    }
  })

  test("base64 helpers round trip both alphabets", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
    expect(fromBase64(toBase64Url(bytes))).toEqual(bytes)
    expect(toBase64Url(bytes)).not.toContain("=")
    expect(() => fromBase64("!!!!")).toThrow(BqlError)
  })
})

describe("decodeArgs", () => {
  test("positional arguments keep their order", () => {
    expect(decodeArgs([1, "a", null])).toEqual([1, "a", null])
    expect(decodeArgs(undefined)).toEqual([])
  })

  test("named arguments become the driver's single-object form", () => {
    expect(decodeArgs({ id: 10, name: "ann" })).toEqual([{ id: 10, name: "ann" }])
    expect(decodeArgs({ ":id": { $i: "9007199254740993" } })).toEqual([
      { ":id": 9007199254740993n },
    ])
  })
})

describe("round trip through SQLite", () => {
  test("every storage class comes back as the value that went in", () => {
    const db = fresh()
    const blob = new Uint8Array([0, 1, 251, 255])
    const wire: Value[] = [
      1,
      "ann",
      { $i: "9007199254740993" },
      -1.5,
      { $b: toBase64(blob) },
    ]
    const args = decodeArgs(wire)
    db.run("insert into t(id, v, n, r, b) values (?, ?, ?, ?, ?)", args as never[])

    const stmt = db.prepare("select id, v, n, r, b from t")
    const encoded = encodeRows(stmt, stmt.values())
    expect(encoded.columns).toEqual(["id", "v", "n", "r", "b"])
    expect(encoded.types).toEqual(["INTEGER", "TEXT", "INTEGER", "REAL", "BLOB"])
    expect(encoded.rows).toEqual([wire])
    db.close()
  })

  test("an integer at the safe boundary stays a plain JSON number", () => {
    const db = fresh()
    db.run("insert into t(id, n) values (1, ?)", [9007199254740991n])
    db.run("insert into t(id, n) values (2, ?)", [9007199254740992n])
    const stmt = db.prepare("select n from t order by id")
    expect(encodeRows(stmt, stmt.values()).rows).toEqual([
      [9007199254740991],
      [{ $i: "9007199254740992" }],
    ])
    db.close()
  })

  test("an overflowing double comes back tagged", () => {
    const db = fresh()
    const stmt = db.prepare("select 1e308 * 10 as big")
    expect(encodeRows(stmt, stmt.values()).rows).toEqual([[{ $f: "inf" }]])
    db.close()
  })

  test("named parameters bind through decodeArgs", () => {
    const db = fresh()
    db.run("insert into t(id, v) values (1, 'ann'), (2, 'bob')")
    const stmt = db.prepare("select v from t where id = :id")
    const params = decodeArgs({ id: 2 })
    expect(encodeRows(stmt, stmt.values(...(params as never[]))).rows).toEqual([["bob"]])
    db.close()
  })
})

describe("encodeRows", () => {
  test("object mode keys every row by column name", () => {
    const db = fresh()
    db.run("insert into t(id, v) values (1, 'ann')")
    const stmt = db.prepare("select id, v from t")
    const encoded = encodeRows(stmt, stmt.values(), "object")
    expect(encoded.rows).toEqual([{ id: 1, v: "ann" }])
    expect((encoded.rows as ObjectRow[])[0]).toHaveProperty("v", "ann")
    db.close()
  })

  test("falls back to the storage class when a column has no declared type", () => {
    const db = fresh()
    const stmt = db.prepare("select 1 as a, 'x' as b, 1.5 as c, null as d, x'00ff' as e")
    const encoded = encodeRows(stmt, stmt.values())
    expect(encoded.types).toEqual(["INTEGER", "TEXT", "REAL", "NULL", "BLOB"])
    db.close()
  })

  test("an empty result still reports its columns", () => {
    const db = fresh()
    const stmt = db.prepare("select id, v from t where id = -1")
    const encoded = encodeRows(stmt, stmt.values())
    expect(encoded.columns).toEqual(["id", "v"])
    expect(encoded.types).toEqual(["INTEGER", "TEXT"])
    expect(encoded.rows).toEqual([])
    db.close()
  })

  test("the whole result survives JSON.stringify unchanged", () => {
    const db = fresh()
    db.run("insert into t(id, n, b) values (1, ?, ?)", [
      9007199254740993n,
      new Uint8Array([1, 2, 3]),
    ])
    const stmt = db.prepare("select n, b from t")
    const encoded = encodeRows(stmt, stmt.values())
    expect(JSON.parse(JSON.stringify(encoded)).rows).toEqual([
      [{ $i: "9007199254740993" }, { $b: "AQID" }],
    ])
    db.close()
  })
})
