// The builders, read as the JSON Schema they emit: if one of these expectations changes, the
// OpenAPI document changes with it, because they are the same object.

import { describe, expect, test } from "bun:test"
import {
  collectNamed,
  isOptional,
  ref,
  s,
  toJsonSchema,
  type JsonSchemaNode,
  type Schema,
} from "../../src/core/index.ts"

describe("primitives", () => {
  test("each builder emits the keyword a reader expects", () => {
    expect(toJsonSchema(s.string().minLength(1).maxLength(8).format("email"))).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 8,
      format: "email",
    })
    expect(toJsonSchema(s.int().min(0).max(10))).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 10,
    })
    expect(toJsonSchema(s.number().multipleOf(0.5))).toEqual({ type: "number", multipleOf: 0.5 })
    expect(toJsonSchema(s.boolean())).toEqual({ type: "boolean" })
    expect(toJsonSchema(s.null())).toEqual({ type: "null" })
    expect(toJsonSchema(s.unknown())).toEqual({})
    expect(toJsonSchema(s.literal("go"))).toEqual({ const: "go" })
    expect(toJsonSchema(s.enum(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] })
    expect(toJsonSchema(s.record(s.int()))).toEqual({
      type: "object",
      additionalProperties: { type: "integer" },
    })
    expect(toJsonSchema(s.union([s.string(), s.int()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "integer" }],
    })
  })

  test("pattern takes a RegExp or its source", () => {
    expect(toJsonSchema(s.string().pattern(/^v\d+$/)).pattern).toBe("^v\\d+$")
    expect(toJsonSchema(s.string().pattern("^x$")).pattern).toBe("^x$")
  })

  test("chaining never mutates the node it started from", () => {
    const base = s.string()
    const longer = base.minLength(3)
    expect(toJsonSchema(base)).toEqual({ type: "string" })
    expect(toJsonSchema(longer)).toEqual({ type: "string", minLength: 3 })
    expect(Object.isFrozen(base)).toBe(true)
  })

  test("annotations land on the JSON Schema keywords", () => {
    const node = toJsonSchema(
      s.string().describe("a name").example("ann").example("bob").deprecated().default("ann"),
    )
    expect(node).toEqual({
      type: "string",
      description: "a name",
      examples: ["ann", "bob"],
      deprecated: true,
      default: "ann",
    })
  })
})

describe("optional and nullable", () => {
  test("optional lands in the parent's required, nullable widens the type", () => {
    const user = s.object({
      id: s.int(),
      email: s.string().optional(),
      nickname: s.string().nullable(),
      tags: s.array(s.string()).default([]),
    })
    const node = toJsonSchema(user)
    expect(node.required).toEqual(["id", "nickname"])
    expect(node.properties?.email).toEqual({ type: "string" })
    expect(node.properties?.nickname).toEqual({ type: ["string", "null"] })
  })

  test("optional survives a later annotation", () => {
    const node = s.string().optional().describe("maybe")
    expect(isOptional(node)).toBe(true)
    expect(toJsonSchema(s.object({ a: node })).required).toBeUndefined()
  })

  test("nullable widens an enum's members as well as its type", () => {
    expect(toJsonSchema(s.enum(["a", "b"]).nullable())).toEqual({
      type: ["string", "null"],
      enum: ["a", "b", null],
    })
    expect(toJsonSchema(s.literal(7).nullable())).toEqual({ enum: [7, null] })
  })

  test("nullable adds a branch to an anyOf rather than nesting one", () => {
    const node = toJsonSchema(s.union([s.string(), s.int()]).nullable())
    expect(node.anyOf).toEqual([{ type: "string" }, { type: "integer" }, { type: "null" }])
  })

  test("nullable wraps a node that has nothing to widen", () => {
    expect(toJsonSchema(ref("User").nullable())).toEqual({
      anyOf: [{ $ref: "User" }, { type: "null" }],
    })
  })
})

describe("objects", () => {
  const user = s.object({
    id: s.int(),
    name: s.string(),
    email: s.string().optional(),
  })

  test("strict and passthrough set and clear additionalProperties", () => {
    expect(toJsonSchema(user.strict()).additionalProperties).toBe(false)
    expect(Object.hasOwn(toJsonSchema(user.strict().passthrough()), "additionalProperties")).toBe(
      false,
    )
  })

  test("partial makes every property optional", () => {
    const node = toJsonSchema(user.partial())
    expect(node.required).toBeUndefined()
    expect(Object.keys(node.properties ?? {})).toEqual(["id", "name", "email"])
  })

  test("extend adds and overrides, and recomputes required", () => {
    const node = toJsonSchema(user.extend({ name: s.string().optional(), age: s.int() }))
    expect(node.required).toEqual(["id", "age"])
    expect(Object.keys(node.properties ?? {})).toEqual(["id", "name", "email", "age"])
  })

  test("pick and omit keep only what they name", () => {
    expect(toJsonSchema(user.pick(["id", "email"]))).toEqual({
      type: "object",
      properties: { id: { type: "integer" }, email: { type: "string" } },
      required: ["id"],
    })
    expect(Object.keys(toJsonSchema(user.omit(["email"])).properties ?? {})).toEqual(["id", "name"])
  })
})

describe("the encodings of design §6.1", () => {
  test("int64 publishes both wire forms", () => {
    const node = toJsonSchema(s.int64())
    expect(node.anyOf?.[0]).toEqual({ type: "integer" })
    expect(node.anyOf?.[1]).toEqual({
      type: "object",
      properties: { $i: { type: "string", pattern: "^[+-]?[0-9]+$" } },
      required: ["$i"],
      additionalProperties: false,
    })
  })

  test("blob publishes the tagged object", () => {
    const node = toJsonSchema(s.blob())
    expect(node.type).toBe("object")
    expect(node.required).toEqual(["$b"])
    expect(node.properties?.$b).toEqual({ type: "string", contentEncoding: "base64" })
  })

  test("sqliteValue is the union the wire carries", () => {
    const branches = toJsonSchema(s.sqliteValue()).anyOf ?? []
    expect(branches.map((b) => (Array.isArray(b.type) ? b.type.join("|") : b.type))).toEqual([
      "null",
      "number",
      "string",
      "boolean",
      "object",
      "object",
      "object",
    ])
  })
})

describe("named schemas", () => {
  test("collectNamed finds nested ids", () => {
    const address = s.object({ city: s.string() }).id("Address")
    const user = s
      .object({ name: s.string(), addresses: s.array(address), tags: s.record(s.string()) })
      .id("User")
    const named = collectNamed(user)
    expect([...named.keys()].sort()).toEqual(["Address", "User"])
    expect(toJsonSchema(named.get("Address") as Schema).properties?.city).toEqual({
      type: "string",
    })
  })

  test("a self-referencing schema terminates", () => {
    const tree = s
      .object({ name: s.string(), children: s.array(ref("Tree")) })
      .id("Tree")
    expect([...collectNamed(tree).keys()]).toEqual(["Tree"])
  })

  test("a cyclic node graph terminates", () => {
    const cyclic: JsonSchemaNode = { $id: "Loop", type: "object", properties: {} }
    ;(cyclic.properties as Record<string, JsonSchemaNode>).self = cyclic
    expect([...collectNamed(cyclic as Schema).keys()]).toEqual(["Loop"])
  })
})

describe("the node is the document", () => {
  test("JSON.stringify emits the keywords and nothing else", () => {
    const node = s.object({ id: s.int(), name: s.string().optional() })
    expect(JSON.parse(JSON.stringify(node))).toEqual({
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string" } },
      required: ["id"],
    })
  })
})
