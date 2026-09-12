// What the pipeline around a handler owes the caller: typed and coerced input, one `400` shape
// that reports every mistake, a body limit that bites before anything is parsed, the encodings of
// design §6.1 on the way out, and a `Response` from a handler left alone.

import { describe, expect, test } from "bun:test"
import { Registry, s } from "../../src/core/index.ts"
import {
  compileOperation,
  compileRoutes,
  type ContextFactory,
  mountRegistry,
  type RouteTable,
} from "../../src/http/index.ts"
import { contextFor, type Ctx, fixtureRegistry } from "./fixture.ts"

const BASE = "http://bunql.test"

/** Calls a compiled route table the way Bun would, with the `:param` values already matched. */
function serve(calls: string[], options = {}) {
  const table = compileRoutes(fixtureRegistry(calls), contextFor, options) as Record<
    string,
    Record<string, (request: Request, server: unknown) => Promise<Response>>
  >
  return (
    path: string,
    method: string,
    params: Record<string, string>,
    init: RequestInit = {},
  ): Promise<Response> => {
    const handler = table[path]?.[method]
    if (!handler) throw new Error(`no ${method} ${path} in the table`)
    const request = new Request(BASE + path, { method, ...init })
    Object.assign(request, { params })
    return handler(request, undefined)
  }
}

describe("a well-formed request", () => {
  test("reaches the handler with coerced input and the schema's defaults", async () => {
    const calls: string[] = []
    const call = serve(calls)
    const response = await call("/v1/db/:db/rows", "GET", { db: "acme" }, {})
    expect(response.status).toBe(200)
    const body = (await response.json()) as { db: string; limit: number; caller: string }
    // `limit` was never sent, so the schema's default is what the handler saw.
    expect(body).toMatchObject({ db: "acme", limit: 25, caller: "anon" })
    expect(calls).toEqual(["listRows"])
  })

  test('reads "25" out of the query string as the number 25', async () => {
    const calls: string[] = []
    const table = compileRoutes(fixtureRegistry(calls), contextFor) as Record<string, any>
    const request = new Request(`${BASE}/v1/db/acme/rows?limit=25&tag=red`, { method: "GET" })
    Object.assign(request, { params: { db: "acme" } })
    const response = await table["/v1/db/:db/rows"].GET(request, undefined)
    const body = (await response.json()) as { limit: unknown; tags: string[] }
    expect(body.limit).toBe(25)
    // A single `?tag=red` still arrives as an array, because the schema says the key is one.
    expect(body.tags).toEqual(["red"])
  })
})

describe("a malformed request", () => {
  test("is a 400 in BunQL's error shape, reporting every problem, before the handler", async () => {
    const calls: string[] = []
    const table = compileRoutes(fixtureRegistry(calls), contextFor) as Record<string, any>
    const request = new Request(`${BASE}/v1/db/acme/rows?limit=500`, { method: "GET" })
    Object.assign(request, { params: {} })
    const response = await table["/v1/db/:db/rows"].GET(request, undefined)
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    const body = (await response.json()) as {
      error: {
        code: string
        status: number
        message: string
        problems: { path: string; message: string }[]
      }
    }
    expect(body.error.code).toBe("BAD_REQUEST")
    expect(body.error.status).toBe(400)
    // Two sections were wrong at once — a missing path parameter and an out-of-range limit — and
    // both are named, with the section in the path so they cannot be confused.
    expect(body.error.problems).toEqual([
      { path: "path.db", message: "is required" },
      { path: "query.limit", message: "must be at most 100" },
    ])
    expect(body.error.message).toContain("path.db is required")
    expect(body.error.message).toContain("1 more problem")
    expect(calls).toEqual([])
  })

  test("reports three body problems as three", async () => {
    const calls: string[] = []
    const registry = new Registry<Ctx>({ title: "t", version: "1" })
    registry.add({
      id: "three",
      method: "post",
      path: "/three",
      body: {
        schema: s.object({ a: s.string(), b: s.int().min(0), c: s.array(s.string()).minItems(2) }),
      },
      response: { schema: s.object({ ok: s.boolean() }) },
      handler: () => {
        calls.push("three")
        return { ok: true }
      },
    })
    const table = compileRoutes(registry, contextFor) as Record<string, any>
    const request = new Request(`${BASE}/three`, {
      method: "POST",
      body: JSON.stringify({ b: -1, c: ["x"] }),
    })
    const response = await table["/three"].POST(request, undefined)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: { path: string }[] } }
    expect(body.error.problems.map((problem) => problem.path)).toEqual(["body.a", "body.b", "body.c"])
    expect(calls).toEqual([])
  })

  test("says so when a required body is missing entirely", async () => {
    const calls: string[] = []
    const table = compileRoutes(fixtureRegistry(calls), contextFor) as Record<string, any>
    const request = new Request(`${BASE}/v1/db/acme/rows`, { method: "POST" })
    Object.assign(request, { params: { db: "acme" } })
    const response = await table["/v1/db/:db/rows"].POST(request, undefined)
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { problems: { path: string; message: string }[] }
    }
    expect(body.error.problems).toEqual([{ path: "body", message: "is required" }])
    expect(calls).toEqual([])
  })
})

describe("the body limit", () => {
  test("refuses an oversized body before it is parsed", async () => {
    const calls: string[] = []
    const table = compileRoutes(fixtureRegistry(calls), contextFor, {
      maxBodyBytes: 64,
    }) as Record<string, any>
    // Deliberately not JSON: a 413 rather than a "not valid JSON" 400 is how we know nothing
    // tried to parse it.
    const request = new Request(`${BASE}/v1/db/acme/rows`, {
      method: "POST",
      body: "x".repeat(500),
    })
    Object.assign(request, { params: { db: "acme" } })
    const response = await table["/v1/db/:db/rows"].POST(request, undefined)
    expect(response.status).toBe(413)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE")
    expect(body.error.message).toBe("body is larger than 64 bytes")
    expect(calls).toEqual([])
  })

  test("counts a streamed body, which has no content-length to check", async () => {
    const calls: string[] = []
    const table = compileRoutes(fixtureRegistry(calls), contextFor, {
      maxBodyBytes: 64,
    }) as Record<string, any>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(16))
        controller.close()
      },
    })
    const request = new Request(`${BASE}/v1/db/acme/rows`, {
      method: "POST",
      body: stream,
      duplex: "half",
    })
    Object.assign(request, { params: { db: "acme" } })
    expect(request.headers.get("content-length")).toBeNull()
    const response = await table["/v1/db/:db/rows"].POST(request, undefined)
    expect(response.status).toBe(413)
    expect(calls).toEqual([])
  })
})

describe("the encodings of design §6.1", () => {
  test("int64 and blob round-trip through a response", async () => {
    const calls: string[] = []
    const call = serve(calls)
    const response = await call("/v1/db/:db/rows", "GET", { db: "acme" })
    const body = (await response.json()) as { rows: { id: unknown; avatar: unknown }[] }
    // 2^60 is beyond what a JSON number holds, so it leaves tagged; the blob always does.
    expect(body.rows[0]?.id).toEqual({ $i: "1152921504606846976" })
    expect(body.rows[0]?.avatar).toEqual({ $b: "AQL6" })
  })

  test("a request carrying them arrives as a bigint and bytes", async () => {
    const calls: string[] = []
    const table = compileRoutes(fixtureRegistry(calls), contextFor) as Record<string, any>
    const request = new Request(`${BASE}/v1/db/acme/rows`, {
      method: "POST",
      body: JSON.stringify({ id: { $i: "1152921504606846976" }, name: "cy" }),
    })
    Object.assign(request, { params: { db: "acme" } })
    const response = await table["/v1/db/:db/rows"].POST(request, undefined)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: { $i: "1152921504606846976" }, name: "cy" })
    expect(calls).toEqual(["createRow"])
  })
})

describe("a handler that returns a Response", () => {
  test("has it passed through untouched", async () => {
    const calls: string[] = []
    const call = serve(calls)
    const response = await call("/v1/db/:db/dump", "GET", { db: "acme" }, {
      headers: { "x-caller": "ann" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("x-dump")).toBe("ann")
    expect(await response.text()).toBe("SQLite format 3 ")
    expect(calls).toEqual(["dumpRows"])
  })
})

describe("response validation", () => {
  const liar = (calls: string[]) => {
    const registry = new Registry<Ctx>({ title: "t", version: "1" })
    registry.add({
      id: "liar",
      method: "get",
      path: "/liar",
      response: { schema: s.object({ count: s.int() }) },
      handler: () => {
        calls.push("liar")
        return { count: "not a number" }
      },
    })
    return registry
  }

  test("catches a wrong shape in development, as a 500 the client learns nothing from", async () => {
    const calls: string[] = []
    const reported: unknown[] = []
    const table = compileRoutes(liar(calls), contextFor, {
      validateResponses: true,
      onError: (err) => reported.push(err),
    }) as Record<string, any>
    const response = await table["/liar"].GET(new Request(`${BASE}/liar`), undefined)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL", message: "internal error", status: 500 },
    })
    // The handler ran; it is the server that is wrong, and the server is the one told why.
    expect(calls).toEqual(["liar"])
    expect((reported[0] as Error).name).toBe("ResponseInvalid")
    expect((reported[0] as Error).message).toContain('operation "liar"')
    expect((reported[0] as Error).message).toContain("count expected an integer")
  })

  test("does not run in production", async () => {
    const calls: string[] = []
    const table = compileRoutes(liar(calls), contextFor, {
      validateResponses: false,
    }) as Record<string, any>
    const response = await table["/liar"].GET(new Request(`${BASE}/liar`), undefined)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ count: "not a number" })
  })

  test("follows NODE_ENV when nothing is passed", async () => {
    const before = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = "production"
      const production = compileOperation(
        liar([]).operations()[0] as never,
        contextFor as ContextFactory<Ctx>,
      )
      expect((await production(new Request(`${BASE}/liar`), {})).status).toBe(200)

      process.env.NODE_ENV = "test"
      const development = compileOperation(
        liar([]).operations()[0] as never,
        contextFor as ContextFactory<Ctx>,
        { onError: () => {} },
      )
      expect((await development(new Request(`${BASE}/liar`), {})).status).toBe(500)
    } finally {
      process.env.NODE_ENV = before
    }
  })
})

describe("mountRegistry", () => {
  test("composes with an existing table instead of replacing it", () => {
    const preflight = () => new Response(null, { status: 204 })
    const table: RouteTable = {
      "/v1/db/:db/rows": { OPTIONS: preflight },
      "/healthz": { GET: () => new Response("ok") },
    }
    mountRegistry(table, fixtureRegistry([]), contextFor)
    const rows = table["/v1/db/:db/rows"] as Record<string, unknown>
    // The preflight survived and the operations landed beside it. No HEAD key: Bun answers that
    // from GET by itself.
    expect(Object.keys(rows).sort()).toEqual(["GET", "OPTIONS", "POST"])
    expect(rows.OPTIONS).toBe(preflight)
    expect(Object.keys(table).sort()).toEqual([
      "/healthz",
      "/v1/db/:db/dump",
      "/v1/db/:db/rows",
    ])
  })

  test("refuses to shadow a method the table already serves", () => {
    const table: RouteTable = { "/v1/db/:db/rows": { GET: () => new Response("mine") } }
    expect(() => mountRegistry(table, fixtureRegistry([]), contextFor)).toThrow(
      /GET \/v1\/db\/:db\/rows is already in the route table/,
    )
  })
})
