// The registry's job is to refuse, at startup, everything that could only be a mistake in the
// source — above all a path parameter nothing binds, which would otherwise reach a handler as
// `undefined`.

import { describe, expect, test } from "bun:test"
import { Registry, pathParameters, s, type Operation } from "../../src/core/index.ts"

interface Ctx {
  db: string
}

const response = { schema: s.object({ ok: s.boolean() }) }

function op(overrides: Partial<Operation<any, any, Ctx>> = {}): Operation<any, any, Ctx> {
  return {
    id: "queryDb",
    method: "post",
    path: "/v1/db/:db/query",
    params: { path: s.object({ db: s.string() }) },
    body: { schema: s.object({ sql: s.string() }) },
    response,
    handler: () => ({ ok: true }),
    ...overrides,
  }
}

function registry(): Registry<Ctx> {
  return new Registry<Ctx>({ title: "BunQL", version: "0.0.0" })
}

describe("pathParameters", () => {
  test("reads Bun.serve's own syntax", () => {
    expect(pathParameters("/v1/db/:db/api/:table/:id")).toEqual(["db", "table", "id"])
    expect(pathParameters("/v1/health")).toEqual([])
  })
})

describe("Registry", () => {
  test("accepts a well-formed operation and keeps registration order", () => {
    const r = registry()
    r.add(op())
    r.add(op({ id: "listDbs", method: "get", path: "/v1/db", params: {}, body: undefined }))
    expect(r.size).toBe(2)
    expect(r.operations().map((o) => o.id)).toEqual(["queryDb", "listDbs"])
    expect(r.get("queryDb")?.method).toBe("post")
    expect(r.get("nope")).toBeUndefined()
  })

  test("merge folds another registry in", () => {
    const server = registry().add(op())
    const tenant = registry().add(
      op({ id: "listRows", method: "get", path: "/v1/db/:db/api/:table", body: undefined, params: { path: s.object({ db: s.string(), table: s.string() }) } }),
    )
    expect(server.merge(tenant).operations().map((o) => o.id)).toEqual(["queryDb", "listRows"])
  })

  test("refuses a duplicate id", () => {
    const r = registry().add(op())
    expect(() => r.add(op({ path: "/v1/db/:db/other" }))).toThrow(
      /operation "queryDb": an operation with that id is already registered/,
    )
  })

  test("refuses an id GraphQL could not use as a field name", () => {
    expect(() => registry().add(op({ id: "query-db" }))).toThrow(
      /operation "query-db": the id is the GraphQL field name/,
    )
  })

  test("refuses a path parameter nothing declares", () => {
    expect(() => registry().add(op({ path: "/v1/db/:db/api/:table" }))).toThrow(
      /operation "queryDb": the path binds :table, which params.path does not declare/,
    )
    expect(() => registry().add(op({ params: {} }))).toThrow(
      /the path binds :db, which params.path does not declare/,
    )
  })

  test("refuses a declared parameter the path does not contain", () => {
    expect(() =>
      registry().add(op({ params: { path: s.object({ db: s.string(), id: s.string() }) } })),
    ).toThrow(/params.path declares "id", which the path "\/v1\/db\/:db\/query" does not contain/)
  })

  test("refuses an optional path parameter", () => {
    expect(() =>
      registry().add(op({ params: { path: s.object({ db: s.string().optional() }) } })),
    ).toThrow(/params.path.db is optional, and a path parameter cannot be absent/)
  })

  test("refuses a params.path that is not an object schema", () => {
    expect(() => registry().add(op({ params: { path: s.string() } }))).toThrow(
      /params.path must be an object schema/,
    )
  })

  test("refuses a body on a GET or a DELETE", () => {
    expect(() => registry().add(op({ method: "get" }))).toThrow(
      /operation "queryDb": a get operation cannot have a body/,
    )
    expect(() => registry().add(op({ method: "delete" }))).toThrow(
      /a delete operation cannot have a body/,
    )
  })

  test("refuses two operations on the same route", () => {
    const r = registry().add(op())
    expect(() => r.add(op({ id: "queryDbAgain" }))).toThrow(
      /post \/v1\/db\/:db\/query is already served by "queryDb"/,
    )
  })

  test("refuses a path that is not a path, and a method that is not one", () => {
    expect(() => registry().add(op({ path: "v1/db/:db/query" }))).toThrow(/must start with "\/"/)
    expect(() => registry().add(op({ method: "options" as "get" }))).toThrow(
      /"options" is not one of get, post, put, patch, delete/,
    )
  })
})
