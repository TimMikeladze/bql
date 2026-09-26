// The emitter's job is to be *consumable*: H5 hands this document to a code generator, so an
// `operationId`, a component name or a `$ref` that is off by one is a wrong field on a generated
// type rather than a typo in prose. These tests hold the shape of the four things that decide
// that — paths, components, error responses and the value encoding — and then check the whole
// document against the structural rules a generator trips over.

import { describe, expect, test } from "bun:test"
import { Registry, ref, s, type Operation } from "../../src/core/index.ts"
import {
  buildDocument,
  statusForCode,
  templatePath,
  type OpenApiDocument,
} from "../../src/openapi/index.ts"
import { checkDocument } from "./structure.ts"

const Profile = s
  .object({
    bio: s.string().optional().describe("free text"),
    seats: s.int().default(1),
  })
  .describe("A user's profile.")
  .id("Profile")

const User = s
  .object({
    // The two encodings design §6.1 insists on: neither may be flattened on the way out.
    id: s.int64(),
    name: s.string().describe("display name").example("ann"),
    avatar: s.blob().optional(),
    profile: Profile,
    manager: ref<unknown>("User").optional(),
  })
  .describe("One row of the users table.")
  .id("User")

const NewUser = s
  .object({ name: s.string(), profile: Profile.optional() })
  .describe("A row to insert.")
  .id("NewUser")

function ok(): any {
  return { ok: true }
}

/** The whole server API; `only` narrows it to a tenant's generated data API. */
function registry(only?: string[]): Registry {
  const r = new Registry({
    title: "bql.sh",
    version: "0.0.0",
    description: "SQLite as a multi-tenant database server.",
    servers: [{ url: "https://sql.example.com" }],
  })
  const add = (operation: Operation<any, any, unknown>) => {
    if (!only || only.includes(operation.id)) r.add(operation)
  }
  add({
    id: "listUsers",
    method: "get",
    path: "/v1/db/:db/api/users",
    summary: "List rows of users",
    description: "PostgREST's URL grammar; every identifier comes from introspection.",
    tags: ["data"],
    params: {
      path: s.object({ db: s.string().describe("database name") }),
      query: s.object({
        limit: s.int().min(1).max(1000).default(100),
        order: s.string().optional().describe("`name.asc`"),
        deleted: s.boolean().optional().deprecated(),
      }),
      headers: s.object({
        "BQL-Min-Txid": s.int().optional().describe("read-your-writes floor"),
        Authorization: s.string().optional(),
      }),
    },
    response: {
      schema: s.array(User).describe("The rows, in order."),
      headers: s.object({ "BQL-Txid": s.int().describe("txid as served") }),
    },
    errors: ["DB_NOT_FOUND", "NOT_AUTHORIZED", "QUERY_TIMEOUT", "TXID_NOT_AVAILABLE"],
    security: "bearer",
    handler: ok,
  })
  add({
    id: "createUser",
    method: "post",
    path: "/v1/db/:db/api/users",
    summary: "Insert a row into users",
    tags: ["data"],
    params: { path: s.object({ db: s.string() }) },
    body: { schema: NewUser },
    response: { status: 201, schema: User },
    // Three codes on 409, one each on 503 and 507: the grouping rule and the SQLite half of the
    // status mapping in one operation.
    errors: [
      "SQLITE_CONSTRAINT_UNIQUE",
      "SQLITE_CONSTRAINT_FOREIGNKEY",
      "CONFLICT",
      "NOT_PRIMARY",
      "QUOTA_EXCEEDED",
    ],
    security: "bearer",
    handler: ok,
  })
  add({
    id: "createDatabase",
    method: "post",
    path: "/v1/db",
    summary: "Create or fork a database",
    tags: ["lifecycle"],
    body: { schema: s.object({ name: s.string() }), required: true },
    response: { status: 201, schema: s.object({ name: s.string() }) },
    errors: ["NOT_PRIMARY", "CONFLICT"],
    security: "admin",
    handler: ok,
  })
  add({
    id: "health",
    method: "get",
    path: "/healthz",
    summary: "Liveness",
    response: { schema: s.object({ ok: s.boolean() }) },
    security: "none",
    handler: ok,
  })
  return r
}

function build(): OpenApiDocument {
  return buildDocument(registry())
}

describe("templatePath", () => {
  test("rewrites Bun's :param to OpenAPI's {param}, and only that", () => {
    expect(templatePath("/v1/db/:db/api/:table/:id")).toBe("/v1/db/{db}/api/{table}/{id}")
    expect(templatePath("/healthz")).toBe("/healthz")
    // Not a whole segment, so not a parameter — the same rule `pathParameters` applies.
    expect(templatePath("/v1/a:b")).toBe("/v1/a:b")
  })
})

describe("buildDocument", () => {
  test("emits one path entry per operation, with {param} and the id verbatim", () => {
    const document = build()
    expect(document.openapi).toBe("3.1.0")
    expect(document.info).toMatchObject({ title: "bql.sh", version: "0.0.0" })
    expect(document.servers).toEqual([{ url: "https://sql.example.com" }])
    expect(Object.keys(document.paths)).toEqual(["/v1/db/{db}/api/users", "/v1/db", "/healthz"])

    const users = document.paths["/v1/db/{db}/api/users"]
    expect(users?.get?.operationId).toBe("listUsers")
    expect(users?.post?.operationId).toBe("createUser")
    expect(users?.get?.summary).toBe("List rows of users")
    expect(users?.get?.description).toContain("PostgREST")
    expect(users?.get?.tags).toEqual(["data"])
    expect(document.tags).toEqual([{ name: "data" }, { name: "lifecycle" }])
  })

  test("parameters land in the right place, and a path parameter is always required", () => {
    const get = build().paths["/v1/db/{db}/api/users"]?.get
    const parameters = get?.parameters ?? []
    expect(parameters.map((one) => `${one.in} ${one.name}`)).toEqual([
      "path db",
      "query limit",
      "query order",
      "query deleted",
      // `Authorization` is declared in params.headers and deliberately not emitted.
      "header BQL-Min-Txid",
    ])
    expect(parameters[0]).toMatchObject({ required: true, description: "database name" })
    // A default means the value need not be sent, so it is not required.
    expect(parameters[1]).toMatchObject({ required: false, schema: { type: "integer", default: 100 } })
    expect(parameters[3]?.deprecated).toBe(true)
    expect(get?.responses["200"]?.headers?.["BQL-Txid"]).toMatchObject({ required: true })
  })

  test("a body becomes a requestBody with its content type", () => {
    const post = build().paths["/v1/db/{db}/api/users"]?.post
    expect(post?.requestBody).toEqual({
      required: true,
      description: "A row to insert.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/NewUser" } } },
    })
    expect(post?.responses["201"]).toMatchObject({
      description: "One row of the users table.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
    })
  })

  test("basePath strips the prefix the server URL carries", () => {
    const document = buildDocument(registry(["listUsers", "createUser"]), {
      basePath: "/v1/db/{db}/api",
      servers: [{ url: "https://sql.example.com/v1/db/acme/api" }],
      info: { title: "acme", version: "7" },
    })
    expect(document.paths["/users"]?.get?.operationId).toBe("listUsers")
    expect(document.info.title).toBe("acme")
  })

  test("an operation outside basePath is refused", () => {
    expect(() => buildDocument(registry(), { basePath: "/v1/db/{db}/api" })).toThrow(
      /"\/v1\/db" does not start with the basePath/,
    )
  })
})

describe("components", () => {
  test("named schemas are hoisted and $ref'd, including a nested one", () => {
    const document = build()
    const schemas = document.components?.schemas ?? {}
    expect(Object.keys(schemas)).toEqual(["Error", "NewUser", "Profile", "User"])

    // Nested: `Profile` is a property of `User`, so it is its own component and User points at it.
    expect(schemas.User?.properties?.profile).toEqual({ $ref: "#/components/schemas/Profile" })
    expect(schemas.Profile?.properties?.bio).toMatchObject({ type: "string" })
    // Self-reference: core's bare-name `ref("User")` becomes the same pointer.
    expect(schemas.User?.properties?.manager).toEqual({ $ref: "#/components/schemas/User" })
    // The definition itself keeps no `$id` — the key is the name.
    expect(schemas.User?.$id).toBeUndefined()
    expect(schemas.User?.required).toEqual(["id", "name", "profile"])
    // `.example()` carries through as JSON Schema's own `examples`.
    expect(schemas.User?.properties?.name?.examples).toEqual(["ann"])
    // An array of a named schema refs its item.
    const list = document.paths["/v1/db/{db}/api/users"]?.get?.responses["200"]
    expect(list?.content?.["application/json"]?.schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
      description: "The rows, in order.",
    })
  })

  test("two different schemas under one name are refused, naming both origins", () => {
    const r = new Registry({ title: "t", version: "1" })
    r.add<any, any>({
      id: "one",
      method: "get",
      path: "/one",
      response: { schema: s.object({ a: s.string() }).id("Row") },
      handler: ok,
    })
    r.add<any, any>({
      id: "two",
      method: "get",
      path: "/two",
      response: { schema: s.object({ a: s.int() }).id("Row") },
      handler: ok,
    })
    expect(() => buildDocument(r)).toThrow(
      /both named "Row" — one reached from operation "one", one from operation "two"/,
    )
  })

  test("the same shape built twice under one name is not a conflict", () => {
    const r = new Registry({ title: "t", version: "1" })
    const row = () => s.object({ a: s.string() }).id("Row")
    r.add<any, any>({
      id: "one",
      method: "get",
      path: "/one",
      response: { schema: row() },
      handler: ok,
    })
    r.add<any, any>({
      id: "two",
      method: "get",
      path: "/two",
      response: { schema: row() },
      handler: ok,
    })
    expect(Object.keys(buildDocument(r).components?.schemas ?? {})).toEqual(["Row"])
  })

  test("a ref to a name nothing defines is refused", () => {
    const r = new Registry({ title: "t", version: "1" })
    r.add<any, any>({
      id: "one",
      method: "get",
      path: "/one",
      response: { schema: s.object({ a: ref("Missing") }) },
      handler: ok,
    })
    expect(() => buildDocument(r)).toThrow(/ref\("Missing"\) points at a schema no operation/)
  })
})

describe("the value encoding", () => {
  test("int64 and blob keep their tagged anyOf", () => {
    const user = build().components?.schemas?.User
    expect(user?.properties?.id).toEqual({
      anyOf: [
        { type: "integer" },
        {
          type: "object",
          properties: { $i: { type: "string", pattern: "^[+-]?[0-9]+$" } },
          required: ["$i"],
          additionalProperties: false,
        },
      ],
      description: 'A 64-bit integer; one outside ±2^53 travels as {"$i": "<decimal>"}.',
    })
    expect(user?.properties?.avatar).toEqual({
      type: "object",
      properties: { $b: { type: "string", contentEncoding: "base64" } },
      required: ["$b"],
      additionalProperties: false,
      description: 'A BLOB as {"$b": "<base64>"}.',
    })
  })
})

// Nine JSON Schema keywords are *builder methods* on a core node when absent and *values* when
// present, so `node.minLength !== undefined` and `"minLength" in node` are both always true, for
// every string schema. An emitter written that way puts a function under the keyword; JSON drops
// it, so it vanishes from the document and reappears as a missing constraint — and every
// happy-path assertion still passes. These are the tests that catch that class: they assert what
// a schema *without* a keyword does **not** emit.
describe("a keyword nothing set is not emitted", () => {
  const KEYWORDS = [
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "multipleOf",
    "deprecated",
  ] as const

  function shaped(): Registry {
    const r = new Registry({ title: "t", version: "1" })
    r.add<any, any>({
      id: "one",
      method: "get",
      path: "/one",
      params: {
        query: s.object({
          quiet: s.boolean().optional(),
          flagged: s.boolean().optional().deprecated(),
        }),
      },
      response: {
        schema: s
          .object({
            plain: s.string(),
            constrained: s.string().minLength(2).maxLength(8).pattern("^a").format("email"),
            bare: s.array(s.string()),
            bounded: s.array(s.string()).minItems(1).maxItems(3).uniqueItems(),
          })
          .id("Shaped"),
      },
      handler: ok,
    })
    return r
  }

  test("an unconstrained string emits exactly {type: string}", () => {
    const properties = buildDocument(shaped()).components?.schemas?.Shaped?.properties ?? {}
    expect(Object.keys(properties.plain ?? {})).toEqual(["type"])
    expect(Object.keys(properties.bare ?? {})).toEqual(["type", "items"])
    for (const name of KEYWORDS) {
      expect(Object.hasOwn(properties.plain ?? {}, name)).toBe(false)
      expect(Object.hasOwn(properties.bare ?? {}, name)).toBe(false)
    }
  })

  test("a constrained one emits every keyword it really carries", () => {
    const properties = buildDocument(shaped()).components?.schemas?.Shaped?.properties ?? {}
    expect(properties.constrained).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 8,
      pattern: "^a",
      format: "email",
    })
    expect(properties.bounded).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    })
  })

  test("deprecated reaches a parameter only when the schema set it", () => {
    const parameters = buildDocument(shaped()).paths["/one"]?.get?.parameters ?? []
    const quiet = parameters.find((one) => one.name === "quiet") as Record<string, unknown>
    const flagged = parameters.find((one) => one.name === "flagged")
    // The trap's worst case: a bare `schema.deprecated` read would stamp this on every parameter.
    expect(Object.hasOwn(quiet, "deprecated")).toBe(false)
    expect(flagged?.deprecated).toBe(true)
  })

  test("no value anywhere in the document is a function", () => {
    const offenders: string[] = []
    const walk = (value: unknown, at: string): void => {
      if (typeof value === "function") {
        offenders.push(at)
        return
      }
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) walk(item, `${at}/${index}`)
        return
      }
      if (typeof value !== "object" || value === null) return
      // Own keys only: probing by name is the very thing under test.
      for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key], `${at}/${key}`)
    }
    walk(build(), "")
    walk(buildDocument(shaped()), "")
    expect(offenders).toEqual([])
  })
})

describe("errors", () => {
  test("statusForCode asks src/server/errors.ts, including its SQLite half", () => {
    expect(statusForCode("NOT_PRIMARY")).toBe(503)
    expect(statusForCode("QUOTA_EXCEEDED")).toBe(507)
    expect(statusForCode("TXID_NOT_AVAILABLE")).toBe(425)
    // Not in ERROR_STATUS at all — `fromSqlite`'s prefix rules answer these.
    expect(statusForCode("SQLITE_CONSTRAINT_UNIQUE")).toBe(409)
    expect(statusForCode("SQLITE_BUSY_SNAPSHOT")).toBe(503)
    expect(statusForCode("SQLITE_FULL")).toBe(507)
    expect(statusForCode("NOT_A_CODE")).toBeUndefined()
  })

  test("codes become responses under their real status, sharing one per status", () => {
    const post = build().paths["/v1/db/{db}/api/users"]?.post
    expect(Object.keys(post?.responses ?? {})).toEqual(["201", "409", "503", "507"])
    expect(post?.responses["409"]?.description).toBe(
      "Conflict. `error.code` is one of `SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT_FOREIGNKEY`, `CONFLICT`.",
    )
    expect(post?.responses["503"]?.description).toBe(
      "Service unavailable. `error.code` is `NOT_PRIMARY`.",
    )
    expect(post?.responses["507"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/Error",
    })

    const get = build().paths["/v1/db/{db}/api/users"]?.get
    expect(Object.keys(get?.responses ?? {})).toEqual(["200", "403", "404", "408", "425"])
  })

  test("the error body is the shape src/server/errors.ts writes", () => {
    const error = build().components?.schemas?.Error
    expect(error?.properties?.error?.required).toEqual(["code", "message", "status"])
    expect(Object.keys(error?.properties?.error?.properties ?? {})).toEqual([
      "code",
      "message",
      "status",
      "txid",
      "failedIndex",
      "primary",
      "acks",
      "needed",
      "problems",
    ])
  })

  test("an unknown error code is refused rather than documented as a 500", () => {
    const r = new Registry({ title: "t", version: "1" })
    r.add<any, any>({
      id: "one",
      method: "get",
      path: "/one",
      response: { schema: s.object({ a: s.string() }) },
      errors: ["NOT_PRMARY"],
      handler: ok,
    })
    expect(() => buildDocument(r)).toThrow(/"NOT_PRMARY" is neither a bql.sh error code/)
  })

  test("a registry with no errors carries no Error component", () => {
    const r = new Registry({ title: "t", version: "1" })
    r.add<any, any>({
      id: "one",
      method: "get",
      path: "/one",
      response: { schema: s.object({ a: s.string() }) },
      handler: ok,
    })
    expect(r && buildDocument(r).components?.schemas).toBeUndefined()
  })
})

describe("security", () => {
  test("only the referenced schemes are defined, and both are bearer", () => {
    const schemes = build().components?.securitySchemes ?? {}
    expect(Object.keys(schemes)).toEqual(["bearerAuth", "adminKey"])
    expect(schemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
    expect(schemes.adminKey?.description).toContain("admin key")
  })

  test('"none" is an empty requirement, and saying nothing is an omission', () => {
    const document = build()
    expect(document.paths["/healthz"]?.get?.security).toEqual([])
    expect(document.paths["/v1/db/{db}/api/users"]?.get?.security).toEqual([{ bearerAuth: [] }])
    expect(document.paths["/v1/db"]?.post?.security).toEqual([{ adminKey: [] }])
    expect(document.security).toBeUndefined()

    const quiet = new Registry({ title: "t", version: "1" })
    quiet.add<any, any>({
      id: "one",
      method: "get",
      path: "/one",
      response: { schema: s.object({ a: s.string() }) },
      handler: ok,
    })
    const only = buildDocument(quiet).paths["/one"]?.get as Record<string, unknown>
    expect(Object.hasOwn(only, "security")).toBe(false)
  })
})

describe("the document is consumable", () => {
  test("every $ref resolves, every path parameter is declared, no id is used twice", () => {
    expect(checkDocument(build())).toEqual([])
  })

  test("it survives a JSON round trip unchanged — no prototype, no symbol, no undefined", () => {
    const document = build()
    expect(JSON.parse(JSON.stringify(document))).toEqual(document)
    // A builder method must never reach the document as a keyword.
    expect(JSON.stringify(document)).not.toContain("function")
  })

  test("the checker actually fails a broken document", () => {
    const broken = build()
    delete (broken.components?.schemas as Record<string, unknown>).User
    const problems = checkDocument(broken)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join("\n")).toContain("resolves to nothing")
  })
})

// Keeps the fixture honest: if core ever stops refusing a bad operation, the emitter's
// assumptions about path parameters stop holding and this is where it shows.
test("core still refuses an operation whose path binding is wrong", () => {
  const r = new Registry({ title: "t", version: "1" })
  const bad: Operation<any, any, unknown> = {
    id: "bad",
    method: "get",
    path: "/v1/db/:db",
    response: { schema: s.object({ a: s.string() }) },
    handler: ok,
  }
  expect(() => r.add(bad)).toThrow(/params.path does not declare/)
})
