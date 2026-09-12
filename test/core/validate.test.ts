// The validator, read as the answer the HTTP layer turns into a 400: which paths are named, how
// many problems come back at once, and what coercion will and will not guess.

import { describe, expect, test } from "bun:test"
import {
  keyword,
  ref,
  s,
  toJsonSchema,
  validate,
  type JsonSchemaNode,
  type Problem,
  type Schema,
} from "../../src/core/index.ts"

function problems(result: { ok: boolean; problems?: Problem[] }): string[] {
  return (result.problems ?? []).map((p) => `${p.path}: ${p.message}`)
}

const User = s.object({
  id: s.int(),
  name: s.string().minLength(1),
  email: s.string().optional(),
  tags: s.array(s.string()).default([]),
})

describe("checking", () => {
  test("a valid value comes back typed", () => {
    const result = validate(User, { id: 7, name: "ann", email: "ann@example.com" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const name: string = result.value.name
    expect(name).toBe("ann")
    expect(result.value.tags).toEqual([])
  })

  test("every failure names its path", () => {
    const result = validate(s.object({ user: User }), {
      user: { id: "seven", name: "", tags: ["ok", 3] },
    })
    expect(problems(result)).toEqual([
      "user.id: expected an integer, got a string",
      "user.name: must be at least 1 character",
      "user.tags.1: expected a string, got a number",
    ])
  })

  test("problems are collected, not thrown at the first one", () => {
    const result = validate(User, { name: "" })
    expect(problems(result)).toEqual(["id: is required", "name: must be at least 1 character"])
  })

  test("maxProblems caps the list", () => {
    const many = s.object({ a: s.int(), b: s.int(), c: s.int() })
    const result = validate(many, {}, { maxProblems: 2 })
    expect(result.ok).toBe(false)
    expect(problems(result)).toHaveLength(2)
  })

  test("strict refuses an unknown property by name", () => {
    expect(problems(validate(User.strict(), { id: 1, name: "a", nope: 1 }))).toEqual([
      "nope: is not allowed here",
    ])
  })

  test("constraints on numbers, arrays and enums report the bound", () => {
    expect(problems(validate(s.int().min(1).max(3), 9))).toEqual([": must be at most 3"])
    expect(problems(validate(s.array(s.int()).minItems(2), [1]))).toEqual([
      ": must have at least 2 items",
    ])
    expect(problems(validate(s.array(s.int()).uniqueItems(), [1, 1]))).toEqual([
      ": must not repeat an item",
    ])
    expect(problems(validate(s.enum(["a", "b"]), "c"))).toEqual([': must be one of "a", "b"'])
  })

  test("a union reports one problem for the whole value", () => {
    const either = s.union([s.int(), s.string()])
    expect(validate(either, 3)).toEqual({ ok: true, value: 3 })
    expect(validate(either, "x")).toEqual({ ok: true, value: "x" })
    expect(problems(validate(either, true))).toEqual([
      ": does not match any of the 2 accepted shapes",
    ])
  })

  test("nullable accepts null where optional accepts absence", () => {
    const node = s.object({ a: s.string().nullable(), b: s.string().optional() })
    expect(validate(node, { a: null })).toEqual({ ok: true, value: { a: null } })
    expect(problems(validate(node, { b: "x" }))).toEqual(["a: is required"])
  })

  test("a $ref resolves against the named schemas of the tree", () => {
    const Tree = s.object({ name: s.string(), children: s.array(ref("Tree")).default([]) }).id("Tree")
    const result = validate(Tree, { name: "root", children: [{ name: "leaf" }] })
    expect(result).toEqual({
      ok: true,
      value: { name: "root", children: [{ name: "leaf", children: [] }] },
    })
    expect(problems(validate(s.object({ x: ref("Nope") }), { x: 1 }))).toEqual([
      "x: refers to the unknown schema \"Nope\"",
    ])
  })
})

describe("defaults", () => {
  test("a default is applied without mutating the caller's input", () => {
    const input = { id: 1, name: "ann" }
    const result = validate(User, input)
    expect(result.ok && result.value.tags).toEqual([])
    expect(input).toEqual({ id: 1, name: "ann" })
  })

  test("the default itself is copied, so two calls cannot share one array", () => {
    const first = validate(User, { id: 1, name: "a" })
    const second = validate(User, { id: 2, name: "b" })
    if (!first.ok || !second.ok) throw new Error("expected both to validate")
    first.value.tags.push("mine")
    expect(second.value.tags).toEqual([])
  })
})

describe("coercion", () => {
  const params = s.object({
    limit: s.int().min(1),
    verbose: s.boolean(),
    name: s.string(),
  })

  test("query strings become numbers and booleans", () => {
    const result = validate(params, { limit: "20", verbose: "true", name: "42" }, { coerce: true })
    expect(result).toEqual({ ok: true, value: { limit: 20, verbose: true, name: "42" } })
    expect(validate(params, { limit: "1", verbose: "0", name: "x" }, { coerce: true })).toEqual({
      ok: true,
      value: { limit: 1, verbose: false, name: "x" },
    })
  })

  test("coercion never guesses", () => {
    expect(problems(validate(s.int(), "banana", { coerce: true }))).toEqual([
      ": expected an integer, got a string",
    ])
    expect(problems(validate(s.boolean(), "yes", { coerce: true }))).toEqual([
      ": expected a boolean, got a string",
    ])
    expect(problems(validate(s.int(), "1.5", { coerce: true }))).toEqual([
      ": expected an integer, got a string",
    ])
  })

  test("without coerce a string stays a string", () => {
    expect(problems(validate(s.int(), "20"))).toEqual([": expected an integer, got a string"])
  })
})

describe("the encodings of design §6.1", () => {
  test("$i decodes to a number when it fits and a bigint when it does not", () => {
    expect(validate(s.int64(), 7)).toEqual({ ok: true, value: 7 })
    expect(validate(s.int64(), { $i: "42" })).toEqual({ ok: true, value: 42 })
    expect(validate(s.int64(), { $i: "9007199254740993" })).toEqual({
      ok: true,
      value: 9007199254740993n,
    })
    expect(problems(validate(s.int64(), { $i: "ten" }))).toEqual([': "ten" is not an integer'])
    expect(problems(validate(s.int64(), "12"))).toEqual([
      ': expected an integer or {"$i": "<decimal>"}, got a string',
    ])
    expect(validate(s.int64(), "12", { coerce: true })).toEqual({ ok: true, value: 12 })
  })

  test("$b decodes to bytes", () => {
    const result = validate(s.blob(), { $b: "aGk=" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.value]).toEqual([104, 105])
    expect(problems(validate(s.blob(), "aGk="))).toEqual([
      ': expected {"$b": "<base64>"}, got a string',
    ])
  })

  test("sqliteValue takes every form the wire carries", () => {
    const node = s.sqliteValue()
    expect(validate(node, null)).toEqual({ ok: true, value: null })
    expect(validate(node, "text")).toEqual({ ok: true, value: "text" })
    expect(validate(node, 1.5)).toEqual({ ok: true, value: 1.5 })
    expect(validate(node, true)).toEqual({ ok: true, value: 1 })
    expect(validate(node, { $i: "9007199254740993" })).toEqual({
      ok: true,
      value: 9007199254740993n,
    })
    expect(validate(node, { $f: "-inf" })).toEqual({ ok: true, value: -Infinity })
    expect(problems(validate(node, { nope: 1 }))).toEqual([": is not a SQLite value: an object"])
  })
})

// A codec node decodes its own tagged form and knows nothing else, so it used to be handed the
// `null` that `.nullable()` had already published and refuse it — the document and the validator
// disagreeing about what the API accepts. A nullable INTEGER or BLOB column is ordinary, so the
// data API met this on the first NULL row.

/** Does the *published* document admit `null`? Read the way a client would read it. */
function publishedAdmitsNull(schema: JsonSchemaNode): boolean {
  const type = keyword<string | string[]>(schema, "type")
  if (type === "null") return true
  if (Array.isArray(type) && type.includes("null")) return true
  const members = keyword<unknown[]>(schema, "enum")
  if (Array.isArray(members) && members.includes(null)) return true
  const branches =
    keyword<JsonSchemaNode[]>(schema, "anyOf") ?? keyword<JsonSchemaNode[]>(schema, "oneOf")
  return Array.isArray(branches) && branches.some(publishedAdmitsNull)
}

/** Is the node constrained by a type at all? `s.any()` accepts null without saying so. */
function constrained(schema: JsonSchemaNode): boolean {
  return keyword(schema, "type") !== undefined || keyword(schema, "anyOf") !== undefined
}

/** One node per builder on `s`, so a codec added later is covered by the loop below. */
const BUILDERS: Record<string, Schema<any>> = {
  string: s.string(),
  int: s.int(),
  number: s.number(),
  boolean: s.boolean(),
  null: s.null(),
  any: s.any(),
  unknown: s.unknown(),
  literal: s.literal("x"),
  enum: s.enum(["a", "b"]),
  array: s.array(s.string()),
  object: s.object({ a: s.string() }),
  record: s.record(s.string()),
  union: s.union([s.string(), s.int()]),
  int64: s.int64(),
  blob: s.blob(),
  sqliteValue: s.sqliteValue(),
}

describe("null, as published and as validated", () => {
  test("the loop below covers every builder", () => {
    expect(Object.keys(BUILDERS).sort()).toEqual(Object.keys(s).sort())
  })

  test("toJsonSchema and validate agree about null, for every builder", () => {
    for (const [name, base] of Object.entries(BUILDERS)) {
      for (const [suffix, node] of [
        ["", base],
        [".nullable()", (base as { nullable(): Schema<any> }).nullable()],
      ] as const) {
        const published = toJsonSchema(node)
        const accepts = validate(node, null).ok
        if (publishedAdmitsNull(published)) {
          // The bug: the document said null was fine and the validator refused it.
          expect(`${name}${suffix} accepts null: ${accepts}`).toBe(
            `${name}${suffix} accepts null: true`,
          )
        } else if (constrained(published)) {
          expect(`${name}${suffix} accepts null: ${accepts}`).toBe(
            `${name}${suffix} accepts null: false`,
          )
        }
      }
    }
  })

  test("a nullable codec node takes null and still refuses a wrong type", () => {
    expect(validate(s.int64().nullable(), null)).toEqual({ ok: true, value: null })
    expect(validate(s.int64().nullable(), { $i: "9007199254740993" })).toEqual({
      ok: true,
      value: 9007199254740993n,
    })
    expect(validate(s.int64().nullable(), true).ok).toBe(false)

    expect(validate(s.blob().nullable(), null)).toEqual({ ok: true, value: null })
    expect(validate(s.blob().nullable(), 5).ok).toBe(false)
    const bytes = validate(s.blob().nullable(), { $b: "aGk=" })
    expect(bytes.ok && [...(bytes.value as Uint8Array)]).toEqual([104, 105])

    expect(validate(s.sqliteValue().nullable(), null)).toEqual({ ok: true, value: null })
    expect(validate(s.sqliteValue().nullable(), { nope: 1 }).ok).toBe(false)
  })

  test("a codec node that is not nullable still refuses null", () => {
    expect(problems(validate(s.int64(), null))).toEqual([
      ': expected an integer or {"$i": "<decimal>"}, got null',
    ])
    expect(problems(validate(s.blob(), null))).toEqual([
      ': expected {"$b": "<base64>"}, got null',
    ])
  })

  test("nullability is settled before the codec in both modes", () => {
    for (const coerce of [false, true]) {
      expect(validate(s.int64().nullable(), null, { coerce })).toEqual({ ok: true, value: null })
      expect(validate(s.blob().nullable(), null, { coerce })).toEqual({ ok: true, value: null })
    }
    // Coercion still reaches the decoder for a value that is not null.
    expect(validate(s.int64().nullable(), "12", { coerce: true })).toEqual({ ok: true, value: 12 })
    expect(validate(s.int64().nullable(), "12").ok).toBe(false)
  })

  test("optional on a codec node is absence, not null", () => {
    const row = s.object({ rowid: s.int64().optional(), data: s.blob().nullable().optional() })
    expect(validate(row, {})).toEqual({ ok: true, value: {} })
    expect(validate(row, { rowid: { $i: "7" }, data: null })).toEqual({
      ok: true,
      value: { rowid: 7, data: null },
    })
    expect(problems(validate(row, { rowid: null }))).toEqual([
      'rowid: expected an integer or {"$i": "<decimal>"}, got null',
    ])
  })
})
