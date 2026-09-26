// The equivalence milestone H5 rests on: the in-process dispatcher and a real `Bun.serve` over the
// same registry answer the same request identically. Everything here drives both and compares
// them, because a rule this module got right on its own and Bun gets differently is exactly how
// GraphQL and REST would drift apart.

import { afterAll, describe, expect, test } from "bun:test"
import { Registry, s } from "../../src/core/index.ts"
import { compileRoutes, createDispatcher } from "../../src/http/index.ts"
import { contextFor, type Ctx, fixtureRegistry } from "./fixture.ts"

/** The 404 both sides answer with, so "no route" is one shape and not two. */
function notFound(request: Request): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "BAD_REQUEST",
        message: `no route for ${new URL(request.url).pathname}`,
        status: 404,
      },
    }),
    { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/** Serves a registry on a free port — port 0, so nothing already listening is disturbed. */
function listen(registry: Registry<Ctx>) {
  const server = Bun.serve({
    port: 0,
    routes: compileRoutes(registry, contextFor) as never,
    fetch: notFound as never,
    development: false,
  })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

interface Seen {
  status: number
  body: string
  contentType: string | null
  contentLength: string | null
  extra: string | null
}

async function read(response: Response): Promise<Seen> {
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    extra: response.headers.get("x-dump"),
  }
}

// ── the fixture registry, over a socket and in this process ────────────────────────────────────

const servedCalls: string[] = []
const served = listen(fixtureRegistry(servedCalls))
const dispatchedCalls: string[] = []
const dispatch = createDispatcher(fixtureRegistry(dispatchedCalls), contextFor, {
  fallback: notFound,
})

afterAll(async () => {
  await served.server.stop(true)
  await precedence.server.stop(true)
})

interface Case {
  name: string
  path: string
  init?: RequestInit
}

const cases: Case[] = [
  { name: "a coerced query with a repeated key", path: "/v1/db/acme/rows?limit=7&tag=red&tag=blue" },
  { name: "a default applied", path: "/v1/db/acme/rows" },
  { name: "a query out of range", path: "/v1/db/acme/rows?limit=500" },
  { name: "a percent-encoded path parameter", path: "/v1/db/a%2Fb/rows" },
  {
    name: "a body carrying an int64",
    path: "/v1/db/acme/rows",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: { $i: "1152921504606846976" }, name: "cy" }),
    },
  },
  {
    name: "a body that is not valid JSON",
    path: "/v1/db/acme/rows",
    init: { method: "POST", body: "{" },
  },
  {
    name: "a handler that returns a Response",
    path: "/v1/db/acme/dump",
    init: { headers: { "x-caller": "ann" } },
  },
  { name: "a path no operation serves", path: "/v1/db/acme/nope" },
  { name: "a method the path does not serve", path: "/v1/db/acme/rows", init: { method: "DELETE" } },
  { name: "HEAD, answered from GET", path: "/v1/db/acme/rows", init: { method: "HEAD" } },
  { name: "a trailing slash", path: "/v1/db/acme/rows/" },
]

describe("the dispatcher and a real Bun.serve", () => {
  for (const { name, path, init } of cases) {
    test(`agree on ${name}`, async () => {
      const overSocket = await read(await fetch(served.base + path, init))
      const inProcess = await read(await dispatch(`http://bql.test${path}`, init))
      expect(inProcess.status).toBe(overSocket.status)
      expect(inProcess.body).toBe(overSocket.body)
      expect(inProcess.contentType).toBe(overSocket.contentType)
      expect(inProcess.extra).toBe(overSocket.extra)
      // HEAD is the one where the length matters on its own: the body is gone and the number is
      // all a client has.
      if (init?.method === "HEAD") expect(inProcess.contentLength).toBe(overSocket.contentLength)
    })
  }

  test("both reached the same handlers, in the same order", () => {
    expect(dispatchedCalls).toEqual(servedCalls)
    // The trailing `listRows` is the HEAD case: both sides answer it from the GET handler.
    expect(servedCalls).toEqual([
      "listRows",
      "listRows",
      "listRows",
      "createRow",
      "dumpRows",
      "listRows",
    ])
  })
})

// ── the matching rules themselves ──────────────────────────────────────────────────────────────

function precedenceRegistry(): Registry<Ctx> {
  const registry = new Registry<Ctx>({ title: "precedence", version: "1" })
  const one = s.object({ a: s.string() })
  const two = s.object({ a: s.string(), b: s.string() })
  const echo = (id: string, method: "get" | "post", path: string, params?: unknown) =>
    registry.add({
      id,
      method,
      path,
      ...(params ? { params: { path: params as never } } : {}),
      response: { schema: s.object({ hit: s.string(), params: s.record(s.string()) }) },
      handler: (input: { path?: Record<string, string> }) => ({
        hit: id,
        params: input.path ?? {},
      }),
    })
  echo("xLit", "get", "/x/lit")
  echo("xParam", "get", "/x/:a", one)
  echo("xLitPost", "post", "/x/lit")
  echo("yTwo", "get", "/y/:a/:b", two)
  echo("yLit", "get", "/y/:a/lit", one)
  return registry
}

const precedence = listen(precedenceRegistry())
const precedenceDispatch = createDispatcher(precedenceRegistry(), contextFor, { fallback: notFound })

const rules: [string, string, string][] = [
  ["a static segment beats a parameter", "GET", "/x/lit"],
  ["a parameter takes what the static did not", "GET", "/x/other"],
  ["a later static beats a parameter after backtracking", "GET", "/y/1/lit"],
  ["two parameters bind in order", "GET", "/y/1/2"],
  ["%2F decodes into one parameter", "GET", "/x/a%2Fb"],
  ["a plus is not a space", "GET", "/x/a+b"],
  ["a multibyte escape decodes", "GET", "/x/%E2%9C%93"],
  ["a trailing slash does not match", "GET", "/x/lit/"],
  ["a method the path does not serve falls through", "DELETE", "/x/lit"],
  ["a method served only on a sibling path falls through", "POST", "/x/other"],
]

describe("the matcher copies Bun's rules", () => {
  for (const [name, method, path] of rules) {
    test(name, async () => {
      const overSocket = await read(await fetch(precedence.base + path, { method }))
      const inProcess = await read(await precedenceDispatch(`http://bql.test${path}`, { method }))
      expect([inProcess.status, inProcess.body]).toEqual([overSocket.status, overSocket.body])
    })
  }
})

describe("createDispatcher", () => {
  test("takes a relative URL, which is how H5 configures the generator's baseUrl", async () => {
    const response = await precedenceDispatch("/x/lit")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ hit: "xLit", params: {} })
  })

  test("is shaped like fetch, so it can be passed as one", async () => {
    // No cast on the call signature: everything `fetch` accepts, the dispatcher accepts, and it
    // answers with the same thing. (`typeof globalThis.fetch` itself also carries a `preconnect`
    // property, which no executor calls.)
    const asFetch: (
      ...args: Parameters<typeof globalThis.fetch>
    ) => ReturnType<typeof globalThis.fetch> = precedenceDispatch
    const response = await asFetch(new Request("http://bql.test/y/7/lit"))
    expect(await response.json()).toEqual({ hit: "yLit", params: { a: "7" } })
  })
})
