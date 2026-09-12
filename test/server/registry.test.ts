// H6's invariant, held to: one list of operations is both the route table and the published
// document. These tests are what makes that more than a comment — a route added by hand to
// `createApp`, or a response schema that does not describe what the handler actually returns,
// fails here rather than shipping a document that lies (`docs/h6-mount.md`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { validate, type Schema } from "../../src/core/index.ts"
import { createApp } from "../../src/server/app.ts"
import { serverRegistry } from "../../src/server/registry.ts"
import { statusForCode } from "../../src/openapi/index.ts"
import { createDb, startTestServer, type TestServer } from "./harness.ts"

const server = await startTestServer()
afterAll(() => server.close())

const app = await createApp(server.handle.runtime)
const registry = serverRegistry(app.surfaces, { api: true, graphql: true })

/** Every `METHOD path` the table serves, minus what is deliberately outside the registry. */
function servedRoutes(routes: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const [path, table] of Object.entries(routes)) {
    for (const [method, handler] of Object.entries(table as Record<string, unknown>)) {
      if (method === "OPTIONS" || handler === undefined) continue
      out.add(`${method} ${path}`)
    }
  }
  return out
}

/** Hrana is libsql's wire protocol, not BunQL's API, and is mounted beside the registry. */
const HRANA = /^\/v[23](\/|$)|^\/v1\/db\/:db\/(hrana|v[23])(\/|$)/

describe("the registry and the route table", () => {
  test("every served route comes from the registry", () => {
    const described = new Set(
      registry.operations().map((o) => `${o.method.toUpperCase()} ${o.path}`),
    )
    const undescribed = [...servedRoutes(app.routes)].filter(
      (route) => !described.has(route) && !HRANA.test(route.split(" ")[1] as string),
    )
    expect(undescribed).toEqual([])
  })

  test("every registry operation is in the route table", () => {
    const served = servedRoutes(app.routes)
    const missing = registry
      .operations()
      .map((o) => `${o.method.toUpperCase()} ${o.path}`)
      .filter((route) => !served.has(route))
    expect(missing).toEqual([])
  })

  test("every path the registry claims answers the CORS preflight", () => {
    for (const operation of registry.operations()) {
      const table = app.routes[operation.path] as Record<string, unknown> | undefined
      expect(table?.OPTIONS).toBeFunction()
    }
  })

  test("every declared error code has a status this server can answer", () => {
    // `statusForCode` returns undefined for a code `src/server/errors.ts` has never heard of, and
    // the document build throws on one — so a typo here is caught before it reaches a build.
    for (const operation of registry.operations()) {
      for (const code of operation.errors ?? []) {
        expect({ id: operation.id, code, status: statusForCode(code) }).toEqual({
          id: operation.id,
          code,
          status: expect.any(Number),
        })
      }
    }
  })

  test("a surface that is off leaves its routes out entirely", () => {
    const off = serverRegistry(app.surfaces, { api: false, graphql: false })
    const paths = off.operations().map((o) => o.path)
    expect(paths.some((p) => p.includes("/api/"))).toBe(false)
    expect(paths).not.toContain("/v1/db/:db/graphql")
    expect(paths).not.toContain("/v1/db/:db/openapi.json")
    // The server's own document is not a generated surface and stays.
    expect(paths).toContain("/v1/openapi.json")
  })
})

describe("the document", () => {
  test("describes the whole server, with the error statuses it really answers", async () => {
    const document = (await server.json("/v1/openapi.json", { token: null })) as {
      openapi: string
      info: { title: string }
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, unknown> }
    }
    expect(document.openapi).toBe("3.1.0")
    expect(document.info.title).toBe("BunQL")
    expect(Object.keys(document.paths)).toContain("/v1/db/{db}/query")
    expect(Object.keys(document.paths)).toContain("/v1/openapi.json")
    // `:db` became `{db}`, and only that: the emitter converts one way and nobody converts back.
    expect(Object.keys(document.paths).some((p) => p.includes(":"))).toBe(false)
    expect(Object.keys(document.components.schemas)).toContain("QueryResult")

    const query = document.paths["/v1/db/{db}/query"]?.post as {
      responses: Record<string, unknown>
      security: unknown
    }
    // `NOT_PRIMARY` is a 503 in `src/server/errors.ts`, and the document has to say so rather
    // than shrug at `default`.
    expect(Object.keys(query.responses)).toContain("503")
    expect(Object.keys(query.responses)).toContain("409")
  })

  test("says which bodies are required, and which the handler defaults", async () => {
    const document = (await server.json("/v1/openapi.json", { token: null })) as {
      paths: Record<string, Record<string, { requestBody?: { required?: boolean } }>>
    }
    const required = (path: string, method: string) =>
      document.paths[path]?.[method]?.requestBody?.required ?? false
    // `sql` and `name` are not optional, and a document that shrugged at that would generate a
    // client that lets you send nothing.
    expect(required("/v1/db/{db}/query", "post")).toBe(true)
    expect(required("/v1/db", "post")).toBe(true)
    expect(required("/v1/tokens", "post")).toBe(true)
    // These read an all-optional body and default it, so an empty one is a real request.
    expect(required("/v1/db/{db}/checkpoint", "post")).toBe(false)
    expect(required("/v1/db/{db}/promote", "post")).toBe(false)
    expect(required("/v1/db/{db}/tx", "post")).toBe(false)
  })

  test("is open, because it names no database", async () => {
    const response = await server.fetch("/v1/openapi.json", { token: null })
    expect(response.status).toBe(200)
  })
})

/**
 * The other half, added by H8: the published *request* schemas are enforced, and enforcing them
 * did not disturb the two things `src/server/app.ts` mounts these operations itself for — the
 * ordering invariant at the top of `src/server/routes.ts`, and C2's `307`.
 */
describe("the published request schemas are enforced", () => {
  const db = "valdb"
  // A real database, because the handler resolves the tenant before it reads the body: without
  // one every case below would be the 404 that ordering produces rather than the answer under test.
  beforeAll(async () => {
    if (!(await exists(server, db))) await createDb(server, db, "CREATE TABLE t (id INTEGER)")
  })

  test("a body the schema rejects is a 400 naming every problem", async () => {
    const response = await server.fetch(`/v1/db/${db}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: 42, timeoutMs: "soon" }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { code: string; problems?: { path: string; message: string }[] }
    }
    expect(body.error.code).toBe("BAD_REQUEST")
    // Every mistake, not only the first: a client fixing two should be told about two.
    expect((body.error.problems ?? []).map((p) => p.path).sort()).toEqual([
      "body.sql",
      "body.timeoutMs",
    ])
  })

  test("a required body that is absent is a 400, and an optional one is not", async () => {
    const missing = await server.fetch(`/v1/db/${db}/query`, { method: "POST" })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain(
      "is required",
    )
    // `checkpoint` reads an all-optional body and defaults it, so no body is a real request.
    const empty = await server.fetch(`/v1/db/${db}/checkpoint`, { method: "POST" })
    expect(empty.status).toBe(200)
  })

  test("a request that may not be here is refused before its body is judged", async () => {
    // `src/server/routes.ts`'s first invariant: the principal, then the tenant, then the body.
    // Validating up front would answer 400 here and tell an anonymous caller what the route takes.
    const response = await server.fetch(`/v1/db/${db}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: 42 }),
      token: null,
    })
    expect(response.status).toBe(401)
  })

  test("a body over the limit is still a 413, not a 400", async () => {
    const max = server.handle.runtime.config.limits.maxBodyBytes
    const response = await server.fetch(`/v1/db/${db}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: `SELECT '${"x".repeat(max)}'` }),
    })
    expect(response.status).toBe(413)
  })
})

/** The check that keeps the published response schemas honest: run them against real answers. */
describe("the published response schemas describe the real answers", () => {
  const db = "regdb"

  test.each([
    ["healthz", "GET", "/healthz"],
    ["readyz", "GET", "/readyz"],
    ["listDatabases", "GET", "/v1/db"],
    ["statDatabase", "GET", `/v1/db/${db}`],
  ])("%s", async (id, method, route) => {
    if (!(await exists(server, db))) await createDb(server, db, "CREATE TABLE t (id INTEGER PRIMARY KEY)")
    const operation = registry.get(id)
    expect(operation).toBeDefined()
    const response = await server.fetch(route, { method })
    expect(response.status).toBe(operation?.response.status ?? 200)
    const body = await response.json()
    const got = validate(operation?.response.schema as Schema, body, {})
    expect(got.ok ? [] : got.problems).toEqual([])
  })
})

async function exists(host: TestServer, db: string): Promise<boolean> {
  const response = await host.fetch(`/v1/db/${db}`)
  return response.status === 200
}
