// Invariant: this dispatcher and a real `Bun.serve` over the same registry answer the same request
// the same way. Milestone H5 hands `createDispatcher` to `openapi-x-graphql` as its
// `ExecutorOptions.fetch`, so a GraphQL field costs an in-process call rather than a TCP
// connection (proven in `experiments/graphql-inproc.ts`, and tabulated in
// `docs/plan-surfaces.md`). If the two ever disagreed, GraphQL and REST would disagree, which is
// the one failure that whole design exists to prevent — so the pipeline is literally the same
// compiled function (`compileRegistry`), and only the matcher is this module's own.
//
// It has to be its own, because there is no `Bun.serve` to ask: `Server.prototype.fetch` exists but
// does not consult the `routes` table — it goes straight to the `fetch` fallback — so it cannot
// stand in for one. The matcher therefore copies Bun's observed rules exactly, and
// `test/http/dispatch.test.ts` pins them against a listening server:
//
//   * a static segment beats a `:param`, which beats a trailing `*`, decided per segment with
//     backtracking — `/y/:a/lit` wins over `/y/:a/:b` for `/y/1/lit`
//   * `:param` values are percent-decoded, so `/a/a%2Fb` binds `a/b`; `+` is not a space
//   * a trailing slash does not match: `/a/x/` is not `/a/:x`
//   * a path that matches with a method that does not is *not* retried against a less specific
//     route; it falls through, as it does under Bun
//   * `HEAD` is answered from the `GET` route with the body dropped and the length still reported,
//     which is what Bun does and what a client counts on
//
// The returned function is `fetch`-shaped — `(input, init)` — because that is what H5 passes it
// as. It also resolves a relative URL against `origin`, since `docs/plan-surfaces.md` configures
// the generator with `baseUrl: "/v1/db/acme/api"` and `new Request("/v1/…")` throws.

import type { Registry } from "../core/index.ts"
import type { ContextFactory, HttpOptions, Invoke } from "./handler.ts"
import { type CompiledOperation, compileRegistry } from "./routes.ts"

/** Close enough to `typeof globalThis.fetch` to be passed as one. */
export type Dispatcher = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

export interface DispatchOptions extends HttpOptions {
  /**
   * Base for a relative URL. Never reaches a handler as anything but `request.url`'s origin, so
   * it only has to be a valid one.
   */
  origin?: string
  /** Answers a request no operation matches. Default: the 404 body `src/server/app.ts` writes. */
  fallback?: (request: Request) => Response | Promise<Response>
}

interface Node {
  readonly statics: Map<string, Node>
  param?: { name: string; node: Node }
  wildcard?: Node
  methods?: Map<string, Invoke>
}

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function node(): Node {
  return { statics: new Map() }
}

function build<Ctx>(compiled: CompiledOperation<Ctx>[]): Node {
  const root = node()
  for (const { operation, invoke } of compiled) {
    let at = root
    for (const segment of segmentsOf(operation.path)) {
      if (segment === "*") {
        at.wildcard ??= node()
        at = at.wildcard
        break
      }
      if (segment.startsWith(":")) {
        const name = segment.slice(1)
        at.param ??= { name, node: node() }
        at = at.param.node
        continue
      }
      let next = at.statics.get(segment)
      if (!next) {
        next = node()
        at.statics.set(segment, next)
      }
      at = next
    }
    at.methods ??= new Map()
    at.methods.set(operation.method.toUpperCase(), invoke)
  }
  return root
}

/** `"/v1/db/:db"` → `["v1", "db", ":db"]`. A trailing slash leaves an empty segment, on purpose. */
function segmentsOf(path: string): string[] {
  const parts = path.split("/")
  return parts[0] === "" ? parts.slice(1) : parts
}

function walk(at: Node, segments: string[], i: number, captured: [string, string][]): Node | undefined {
  if (i === segments.length) return at.methods ? at : undefined
  const segment = segments[i] as string
  const literal = at.statics.get(segment)
  if (literal) {
    const hit = walk(literal, segments, i + 1, captured)
    if (hit) return hit
  }
  const parameter = at.param
  if (parameter) {
    captured.push([parameter.name, decodeSegment(segment)])
    const hit = walk(parameter.node, segments, i + 1, captured)
    if (hit) return hit
    captured.pop()
  }
  return at.wildcard?.methods ? at.wildcard : undefined
}

/** Bun hands a handler decoded `:param` values; a segment it cannot decode is passed through. */
function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function notFound(request: Request): Response {
  const pathname = new URL(request.url).pathname
  return new Response(
    JSON.stringify({
      error: { code: "BAD_REQUEST", message: `no route for ${pathname}`, status: 404 },
    }),
    { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/**
 * Routes a `Request` through the registry in this process — no socket, no port, no listener.
 * Errors are mapped exactly as the served route maps them, so a caller never has to distinguish
 * "the operation refused" from "the dispatch failed".
 */
export function createDispatcher<Ctx>(
  registry: Registry<Ctx>,
  contextFor: ContextFactory<Ctx>,
  options: DispatchOptions = {},
): Dispatcher {
  const root = build(compileRegistry(registry, contextFor, options))
  const origin = options.origin ?? "http://bunql.internal"
  const fallback = options.fallback ?? notFound

  return async function dispatch(input, init): Promise<Response> {
    const request = toRequest(input, init, origin)
    const captured: [string, string][] = []
    const url = new URL(request.url)
    const matched = walk(root, segmentsOf(url.pathname), 0, captured)
    const method = request.method.toUpperCase()
    let invoke = matched?.methods?.get(method)
    const head = invoke === undefined && method === "HEAD"
    if (head) invoke = matched?.methods?.get("GET")
    if (!invoke) return fallback(request)

    const response = await invoke(request, Object.fromEntries(captured))
    if (!head) return response
    // Bun answers HEAD from the GET route: the body is dropped, the length is still reported.
    const body = await response.arrayBuffer()
    const headers = new Headers(response.headers)
    headers.set("content-length", String(body.byteLength))
    return new Response(null, { status: response.status, statusText: response.statusText, headers })
  }
}

function toRequest(input: Request | string | URL, init: RequestInit | undefined, origin: string): Request {
  if (input instanceof Request) return init === undefined ? input : new Request(input, init)
  const href = typeof input === "string" ? input : input.href
  return new Request(HAS_SCHEME.test(href) ? href : new URL(href, origin).href, init)
}
