// Invariant: one compiled pipeline per operation, and both surfaces that can run an operation —
// the `Bun.serve` routes table and the in-process dispatcher — run *this* function. They differ
// only in where the matched `:param` values come from. If they each had a pipeline, a GraphQL
// field and the REST call it stands for would diverge on the first coercion rule that changed in
// one and not the other, which is the single failure `docs/plan-surfaces.md` exists to prevent.
//
// Around a handler, in order: gather the raw inputs, validate and coerce them, read and validate
// the body, call the handler, serialise. The context is built first, before any of that, because
// a context factory is where a caller authenticates and a request that will be refused should not
// first be charged for parsing its own body.
//
// Everything text-shaped arrives as a string — a path segment, a query value, a header — so those
// three are validated with `coerce: true` and the body without it. That is the whole reason
// `validate` has the option.
//
// A validation failure is the `400` of `src/server/errors.ts` and nothing new: the code is
// `BAD_REQUEST`, the body is `{error: {code, message, status}}`, and the only addition is a
// `problems` array, because core reports every mistake in a request and a client fixing three of
// them should be told about three. There is no second error vocabulary here.
//
// **A handler may return a `Response`, and it is passed through untouched.** That is the contract,
// not an accident: `dump` streams a database file out and `import` streams one in, and neither has
// a JSON body this module could usefully build. An operation whose handler does that still
// declares a `response.schema` for the document's sake, and this module does not check it.
//
// Response validation runs only when `NODE_ENV !== "production"`. A published document that lies
// about its own responses is a bug worth catching in tests and not worth paying for per request.
// It is a *check*, never a transform: the body serialised is always the handler's own return
// value, so development and production cannot put different bytes on the wire.

import { keyword, type Operation, type Problem, type Schema, validate } from "../core/index.ts"
import { BunQLError, errorResponse, mapError } from "../server/errors.ts"
import { encode } from "./encode.ts"

/** What a compiled operation is given about the request it is serving. */
export interface Invocation {
  readonly request: Request
  /** The matched `:param` values, already percent-decoded, exactly as Bun hands them over. */
  readonly params: Record<string, string>
  /** Parsed once, lazily: an operation with no query schema never pays for it. */
  readonly url: URL
  /** The `Bun.Server` when a real listener is serving; `undefined` for an in-process dispatch. */
  readonly server?: unknown
}

/** Builds the caller's per-request context. `Registry<Ctx>` is generic and so is this. */
export type ContextFactory<Ctx> = (invocation: Invocation) => Ctx | Promise<Ctx>

/**
 * What a handler is called with: the validated pieces of the request, each typed by its own
 * schema. A piece the operation does not declare is `undefined` rather than an empty object, so
 * reading one that was never declared is a type error rather than a silent `{}`.
 */
export interface OperationInput<P = undefined, Q = undefined, H = undefined, B = undefined> {
  path: P
  query: Q
  headers: H
  body: B
}

export interface HttpOptions {
  /**
   * Largest request body read, in bytes. Default 8 MiB, which is `[limits] maxBodyBytes`, so a
   * mounted registry refuses the same bodies the rest of the server does.
   */
  maxBodyBytes?: number
  /** Default `process.env.NODE_ENV !== "production"`. */
  validateResponses?: boolean
  /**
   * Reports a failure the client was told nothing about — a 500, including a response that failed
   * its own schema. Default `console.error`; pass `() => {}` where something upstream already
   * reports (`src/server/app.ts` does) or in a test that provokes one on purpose.
   */
  onError?: (err: unknown, operation: Operation<any, any, any>) => void
}

/** A compiled operation. `params` are the route's matched values; `server` is Bun's, if any. */
export type Invoke = (
  request: Request,
  params: Record<string, string>,
  server?: unknown,
) => Promise<Response>

const DEFAULT_MAX_BODY = 8 * 1024 * 1024
const JSON_TYPE = "application/json; charset=utf-8"

/** A request core refused, carrying every problem it found rather than only the first. */
export class RequestInvalid extends BunQLError {
  readonly problems: Problem[]

  constructor(problems: Problem[]) {
    super("BAD_REQUEST", summarise(problems), 400)
    this.name = "RequestInvalid"
    this.problems = problems
  }
}

/** A response that did not match the schema the document publishes for it. A server bug. */
export class ResponseInvalid extends Error {
  readonly problems: Problem[]

  constructor(operationId: string, problems: Problem[]) {
    super(`operation "${operationId}" returned a response its own schema rejects: ${summarise(problems)}`)
    this.name = "ResponseInvalid"
    this.problems = problems
  }
}

function summarise(problems: Problem[]): string {
  const first = problems[0]
  if (!first) return "the request is not valid"
  const head = first.path === "" ? first.message : `${first.path} ${first.message}`
  const rest = problems.length - 1
  return rest === 0 ? head : `${head} (and ${rest} more problem${rest === 1 ? "" : "s"})`
}

class RequestInvocation implements Invocation {
  #url: URL | undefined

  constructor(
    readonly request: Request,
    readonly params: Record<string, string>,
    readonly server?: unknown,
  ) {}

  get url(): URL {
    this.#url ??= new URL(this.request.url)
    return this.#url
  }
}

/** Collects the problems from one section under a prefix, so `problems[].path` is unambiguous. */
function prefixed(problems: Problem[], section: string): Problem[] {
  return problems.map((p) => ({
    path: p.path === "" ? section : `${section}.${p.path}`,
    message: p.message,
  }))
}

function isJsonType(contentType: string): boolean {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase()
  return base === "application/json" || base.endsWith("+json")
}

/** Query keys whose schema says "array", so a single `?tag=a` still arrives as `["a"]`. */
function arrayKeys(schema: Schema | undefined): Set<string> {
  const out = new Set<string>()
  if (!schema) return out
  const properties = keyword<Record<string, Schema>>(schema, "properties")
  if (!properties) return out
  for (const [name, child] of Object.entries(properties)) {
    const type = keyword<string | string[]>(child, "type")
    if (type === "array" || (Array.isArray(type) && type.includes("array"))) out.add(name)
  }
  return out
}

/** Header names the operation declares, as written in the schema; `Headers.get` is case-blind. */
function headerNames(schema: Schema | undefined): string[] {
  if (!schema) return []
  return Object.keys(keyword<Record<string, Schema>>(schema, "properties") ?? {})
}

/**
 * Reads the body, refusing one larger than `max` **before** it is parsed. `content-length` is
 * checked first so an oversized body costs nothing at all, and the stream is counted as well,
 * because the header is absent on a chunked request and a lie on a hostile one.
 */
async function readBody(request: Request, max: number): Promise<string> {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > max) throw tooLarge(max)
  }
  const stream = request.body
  if (!stream) return ""
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) throw tooLarge(max)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0])
  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

function tooLarge(max: number): BunQLError {
  return new BunQLError("PAYLOAD_TOO_LARGE", `body is larger than ${max} bytes`, 413)
}

/** The `400` shape of `src/server/errors.ts`, with core's problem list alongside the message. */
function invalidResponse(err: RequestInvalid): Response {
  const { status, body } = mapError(err)
  ;(body.error as unknown as Record<string, unknown>).problems = err.problems
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_TYPE },
  })
}

/**
 * Compiles one operation into the function both the routes table and the dispatcher call. Every
 * decision that can be made once — which headers to read, which query keys are arrays, whether the
 * body is JSON, whether responses are checked — is made here rather than per request.
 */
export function compileOperation<Ctx>(
  operation: Operation<any, any, Ctx>,
  contextFor: ContextFactory<Ctx>,
  options: HttpOptions = {},
): Invoke {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY
  const checkResponse =
    options.validateResponses ?? process.env.NODE_ENV !== "production"
  const report = options.onError ?? ((err: unknown) => console.error(err))

  const pathSchema = operation.params?.path
  const querySchema = operation.params?.query
  const headerSchema = operation.params?.headers
  const queryArrays = arrayKeys(querySchema)
  const headers = headerNames(headerSchema)

  const bodySchema = operation.body?.schema
  const bodyIsJson = isJsonType(operation.body?.contentType ?? "application/json")
  // A declared body is required unless the operation says otherwise: an operation that names a
  // body schema and then reads `undefined` is the mistake, not the common case.
  const bodyRequired = operation.body ? operation.body.required !== false : false

  const status = operation.response.status ?? 200
  const responseType = operation.response.contentType ?? JSON_TYPE
  const responseIsJson = isJsonType(responseType)
  const responseSchema = operation.response.schema

  return async function invoke(request, params, server): Promise<Response> {
    try {
      const invocation = new RequestInvocation(request, params, server)
      const ctx = await contextFor(invocation)

      const problems: Problem[] = []
      let path: unknown
      let query: unknown
      let head: unknown

      if (pathSchema) {
        const got = validate(pathSchema, params, { coerce: true })
        if (got.ok) path = got.value
        else problems.push(...prefixed(got.problems, "path"))
      }
      if (querySchema) {
        const got = validate(querySchema, readQuery(invocation.url, queryArrays), { coerce: true })
        if (got.ok) query = got.value
        else problems.push(...prefixed(got.problems, "query"))
      }
      if (headerSchema) {
        const got = validate(headerSchema, readHeaders(request, headers), { coerce: true })
        if (got.ok) head = got.value
        else problems.push(...prefixed(got.problems, "headers"))
      }
      // The body is read only once the cheap sections are known to be right, so a request that is
      // wrong about its own URL never pays to have its body parsed.
      if (problems.length > 0) throw new RequestInvalid(problems)

      let body: unknown
      if (bodySchema) {
        const text = await readBody(request, maxBody)
        if (text.length === 0) {
          if (bodyRequired) {
            throw new RequestInvalid([{ path: "body", message: "is required" }])
          }
        } else {
          const parsed = bodyIsJson ? parseJson(text) : text
          const got = validate(bodySchema, parsed, {})
          if (!got.ok) throw new RequestInvalid(prefixed(got.problems, "body"))
          body = got.value
        }
      }

      const result = await operation.handler({ path, query, headers: head, body }, ctx)
      // The escape hatch, and the reason streaming works at all: a handler that built its own
      // response knows something this module does not.
      if (result instanceof Response) return result

      if (checkResponse) {
        const got = validate(responseSchema, result, {})
        if (!got.ok) throw new ResponseInvalid(operation.id, got.problems)
      }
      return serialise(result, status, responseType, responseIsJson)
    } catch (err) {
      if (err instanceof RequestInvalid) return invalidResponse(err)
      const response = errorResponse(err)
      // Mirrors `src/server/app.ts`: a `BunQLError` other than `INTERNAL` is a refusal this server
      // wrote on purpose, several of which are 5xx. Only the rest is a bug worth reporting.
      const deliberate = err instanceof BunQLError && err.code !== "INTERNAL"
      if (response.status >= 500 && !deliberate) report(err, operation)
      return response
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new RequestInvalid([
      { path: "body", message: `is not valid JSON: ${(err as Error).message}` },
    ])
  }
}

function readQuery(url: URL, arrays: Set<string>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    out[key] = arrays.has(key) || values.length > 1 ? values : (values[0] as string)
  }
  return out
}

function readHeaders(request: Request, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = request.headers.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

function serialise(
  result: unknown,
  status: number,
  contentType: string,
  isJson: boolean,
): Response {
  if (status === 204 || status === 304) return new Response(null, { status })
  if (isJson) {
    return new Response(JSON.stringify(encode(result)) ?? "null", {
      status,
      headers: { "content-type": contentType },
    })
  }
  // A declared non-JSON content type with a body this module can hand over as it is. Anything
  // else falls back to JSON rather than stringifying an object into "[object Object]".
  if (typeof result === "string" || result instanceof Uint8Array) {
    return new Response(result, { status, headers: { "content-type": contentType } })
  }
  return new Response(JSON.stringify(encode(result)) ?? "null", {
    status,
    headers: { "content-type": contentType },
  })
}
