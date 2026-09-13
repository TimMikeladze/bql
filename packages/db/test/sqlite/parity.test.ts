// Parity against bun:sqlite on the same file. bun:sqlite is the reference implementation for
// what a value should decode to; the one place the two are expected to disagree (integers
// outside the safe range, which bun:sqlite silently rounds by default) is asserted explicitly.

import { afterAll, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { Database } from "../../src/sqlite/index.ts"
import { cleanupTempDirs, tempDb } from "./tmp.ts"

afterAll(cleanupTempDirs)

interface Case {
  name: string
  sql: string
  value: unknown
}

const CASES: Case[] = [
  { name: "small int", sql: "integer", value: 42 },
  { name: "negative int", sql: "integer", value: -7 },
  { name: "int32 min", sql: "integer", value: -2147483648 },
  { name: "int32 max + 1", sql: "integer", value: 2147483648 },
  { name: "max safe int", sql: "integer", value: 9007199254740991 },
  { name: "min safe int", sql: "integer", value: -9007199254740991 },
  { name: "zero", sql: "integer", value: 0 },
  { name: "float", sql: "real", value: 1.5 },
  { name: "negative float", sql: "real", value: -0.000123 },
  { name: "float that looks integral", sql: "real", value: 3.0 },
  { name: "ascii text", sql: "text", value: "hello" },
  { name: "empty text", sql: "text", value: "" },
  { name: "unicode text", sql: "text", value: "héllo wörld ĄĆĘ" },
  { name: "emoji text", sql: "text", value: "🌍 emoji 😀 mix" },
  { name: "long text", sql: "text", value: "x".repeat(10000) },
  { name: "text with nul-ish escapes", sql: "text", value: "a\tb\nc\\d'e\"f" },
  { name: "blob", sql: "blob", value: new Uint8Array([0, 1, 2, 254, 255]) },
  { name: "empty blob", sql: "blob", value: new Uint8Array(0) },
  { name: "large blob", sql: "blob", value: new Uint8Array(5000).fill(7) },
  { name: "null", sql: "blob", value: null },
]

/** bun:sqlite hands blobs back as Uint8Array; normalize so expect() compares contents. */
function normalize(v: unknown): unknown {
  if (v instanceof Uint8Array) return { blob: [...v] }
  return v
}

describe("value parity with bun:sqlite", () => {
  const file = tempDb("parity.db")
  const ours = Database.open(file)
  ours.exec("create table t(id integer primary key, v)")
  for (const c of CASES) ours.run("insert into t(v) values (?)", [c.value as never])
  // Booleans bind as 0/1 integers.
  ours.run("insert into t(v) values (?)", [true])
  ours.run("insert into t(v) values (?)", [false])
  // undefined binds as NULL.
  ours.run("insert into t(v) values (?)", [undefined])
  const theirs = new BunDatabase(file, { readonly: true })

  test("every row decodes identically", () => {
    const mine = ours.prepare("select id, v from t order by id").all()
    const reference = theirs.query("select id, v from t order by id").all() as Record<
      string,
      unknown
    >[]
    expect(mine.length).toBe(reference.length)
    for (let i = 0; i < mine.length; i++) {
      expect(normalize(mine[i]?.v)).toEqual(normalize(reference[i]?.v))
    }
  })

  test("values() rows match bun:sqlite values()", () => {
    const mine = ours.prepare("select id, v from t order by id").values()
    const reference = theirs.query("select id, v from t order by id").values() as unknown[][]
    expect(mine.map((r) => r.map(normalize))).toEqual(reference.map((r) => r.map(normalize)))
  })

  test("booleans round-trip as 0 and 1", () => {
    const rows = ours.prepare("select v from t order by id").values().map((r) => r[0])
    expect(rows[CASES.length]).toBe(1)
    expect(rows[CASES.length + 1]).toBe(0)
    expect(rows[CASES.length + 2]).toBe(null)
  })

  test("column types match the storage class bun:sqlite reports", () => {
    const mine = ours.prepare("select typeof(v) t from t order by id").all()
    const reference = theirs.query("select typeof(v) t from t order by id").all() as {
      t: string
    }[]
    expect(mine.map((r) => r.t)).toEqual(reference.map((r) => r.t))
  })
})

describe("integers outside the safe range", () => {
  const file = tempDb("bigint.db")
  const ours = Database.open(file)
  ours.exec("create table t(id integer primary key, v integer)")
  const BIG = 9007199254740993n // 2^53 + 1
  const NEG = -9007199254740993n
  ours.run("insert into t(v) values (?)", [BIG])
  ours.run("insert into t(v) values (?)", [NEG])
  ours.run("insert into t(v) values (?)", [9223372036854775807n])

  test("default mode widens to bigint only when a number would lose precision", () => {
    const rows = ours.prepare("select v from t order by id").values().map((r) => r[0])
    expect(rows).toEqual([BIG, NEG, 9223372036854775807n])
    const small = ours.prepare("select 5 v").get()
    expect(small?.v).toBe(5)
    expect(typeof small?.v).toBe("number")
  })

  test("bun:sqlite rounds the same value by default, and agrees in safeIntegers mode", () => {
    const theirs = new BunDatabase(file, { readonly: true })
    const lossy = theirs.query("select v from t order by id limit 1").values()[0]?.[0]
    expect(lossy).toBe(9007199254740992)

    const safe = theirs.query("select v from t order by id")
    ;(safe as unknown as { safeIntegers(on: boolean): void }).safeIntegers(true)
    const reference = safe.values().map((r) => String(r[0]))
    expect(
      ours.prepare("select v from t order by id").values().map((r) => String(r[0])),
    ).toEqual(reference)
    theirs.close()
  })

  test("safeIntegers returns every integer as a bigint", () => {
    const safeDb = Database.open(file, { safeIntegers: true, readonly: true })
    const row = safeDb.prepare("select 5 a, v b from t order by id limit 1").get()
    expect(row?.a).toBe(5n)
    expect(row?.b).toBe(BIG)
    expect(safeDb.prepare("select 1").run().changes).toBe(0n)
    safeDb.close()
  })
})

describe("parameter binding parity", () => {
  const file = tempDb("params.db")
  const ours = Database.open(file)
  const theirs = new BunDatabase(file)
  ours.exec("create table t(a, b, c)")

  test("positional parameters", () => {
    ours.run("insert into t values (?, ?, ?)", [1, "two", new Uint8Array([3])])
    const mine = ours.prepare("select * from t where a = ?").get(1)
    const reference = theirs.query("select * from t where a = ?").get(1) as Record<string, unknown>
    expect(normalize(mine?.c)).toEqual(normalize(reference.c))
    expect(mine?.b).toBe("two")
  })

  test("named parameters accept :name, @name and $name", () => {
    expect(ours.prepare("select :x + 1 v").get({ x: 1 })?.v).toBe(2)
    expect(ours.prepare("select @x + 1 v").get({ x: 2 })?.v).toBe(3)
    expect(ours.prepare("select $x + 1 v").get({ x: 3 })?.v).toBe(4)
    expect(ours.prepare("select :y + 1 v").get({ ":y": 9 })?.v).toBe(10)
    expect(
      ours.prepare("select :a || '-' || @b || '-' || $c v").get({ a: "1", b: "2", c: "3" })?.v,
    ).toBe("1-2-3")
  })

  test("an unknown named parameter is rejected", () => {
    expect(() => ours.prepare("select :x v").get({ nope: 1 })).toThrow(/no parameter named "nope"/)
  })

  test("re-binding with fewer parameters clears the stale ones", () => {
    const stmt = ours.prepare("select coalesce(?, 'none') a, coalesce(?, 'none') b")
    expect(stmt.get("x", "y")).toEqual({ a: "x", b: "y" })
    expect(stmt.get("x")).toEqual({ a: "x", b: "none" })
  })

  test("a subarray binds only its own bytes", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
    const slice = backing.subarray(2, 5)
    const row = ours.prepare("select ? b").get(slice)
    expect([...(row?.b as Uint8Array)]).toEqual([1, 2, 3])
  })
})
