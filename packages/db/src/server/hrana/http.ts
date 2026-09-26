// Invariant: a pipeline answers with a 200 and a `results` array whenever it understood the
// request at all. A statement that failed is an entry in that array, not an HTTP status — that is
// what lets `@libsql/client` raise a `LibsqlError` per statement instead of tearing down the
// stream. Only a request that could not be read as a pipeline (bad JSON, bad or missing
// credentials, a baton this server did not issue) leaves as a non-2xx, and then in the bare
// `{message, code}` shape `./errors.ts` describes.
//
// Second invariant: the response's baton always names the stream's *next* sequence number, so the
// baton the client just used is dead the moment the response is written. A stream that was closed
// answers `baton: null`, which is Hrana's way of saying "do not come back".

import { BqlError } from "../errors.ts"
import type { Principal } from "../auth.ts"
import type { ServerRuntime } from "../runtime.ts"
import { cursorEntries, runStreamRequest } from "./execute.ts"
import { hranaErrorResponse, hranaStatus, toHranaError } from "./errors.ts"
import type {
  CursorEntry,
  CursorReqBody,
  PipelineReqBody,
  PipelineRespBody,
  StreamResult,
} from "./proto.ts"
import { hranaService, type HranaService, type HranaStream } from "./service.ts"

/** Hosts whose first label is not a database name. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * libsql-server's namespace rule, verbatim: the `x-namespace` header, else the first label of
 * `Host`, else the database called `default`. Applied unconditionally on this surface — unlike
 * `routes.ts`, which gates host addressing behind `server.tenantFromHost` — because
 * `libsql://{db}.sql.example.com` is the reason the compat layer exists.
 */
export function namespaceOf(request: Request, url: URL, params: Record<string, string>): string {
  const fromPath = params.db
  if (fromPath) return fromPath
  const header = request.headers.get("x-namespace")
  if (header) return header
  const host = url.hostname
  if (!IPV4.test(host) && !host.startsWith("[")) {
    const dot = host.indexOf(".")
    if (dot > 0) return host.slice(0, dot)
  }
  return "default"
}

async function readJson<T>(request: Request, max: number): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > max) {
    throw new BqlError("PAYLOAD_TOO_LARGE", `body is larger than ${max} bytes`, 413)
  }
  const text = await request.text()
  if (text.length > max) {
    throw new BqlError("PAYLOAD_TOO_LARGE", `body is larger than ${max} bytes`, 413)
  }
  if (text.length === 0) throw BqlError.badRequest("the request body is empty")
  try {
    return JSON.parse(text) as T
  } catch {
    throw BqlError.badRequest("request body is not valid JSON")
  }
}

/** A Hrana request's principal. Hrana carries our own tokens, so this is the ordinary path. */
function principalOf(runtime: ServerRuntime, request: Request): Promise<Principal> {
  return runtime.auth.authenticate(request)
}

/** The stream a request addresses: the one its baton names, or a new one. */
function streamFor(
  service: HranaService,
  baton: string | null | undefined,
  db: string,
  principal: Principal,
  owner: object,
): HranaStream {
  if (typeof baton === "string" && baton.length > 0) return service.resume(baton, db)
  if (baton !== null && baton !== undefined) throw BqlError.badRequest("baton must be a string or null")
  return service.openStream(db, principal, owner)
}

/** Every HTTP stream is its own owner: nothing else can end it, and closing it ends everything. */
const httpOwner = (): object => ({})

export async function handlePipeline(
  runtime: ServerRuntime,
  request: Request,
  url: URL,
  params: Record<string, string>,
): Promise<Response> {
  const service = hranaService(runtime)
  let stream: HranaStream | null = null
  try {
    const principal = await principalOf(runtime, request)
    const db = namespaceOf(request, url, params)
    const body = await readJson<PipelineReqBody>(request, runtime.config.limits.maxBodyBytes)
    if (!Array.isArray(body.requests)) {
      throw BqlError.badRequest("a pipeline needs a requests array")
    }
    stream = streamFor(service, body.baton, db, principal, httpOwner())

    const results: StreamResult[] = []
    let closed = false
    for (const one of body.requests) {
      if (closed) {
        results.push({
          type: "error",
          error: { message: "the stream has been closed", code: "BAD_REQUEST" },
        })
        continue
      }
      try {
        const response = await runStreamRequest(service, stream, one)
        if (response.type === "close") {
          closed = true
          service.closeStream(stream)
        }
        results.push({ type: "ok", response })
      } catch (err) {
        results.push({ type: "error", error: toHranaError(err) })
      }
    }

    const payload: PipelineRespBody = {
      baton: closed ? null : service.rotate(stream),
      base_url: null,
      results,
    }
    return json(payload)
  } catch (err) {
    // A failure this far out means the stream cannot be resumed, so it is ended rather than left
    // holding the tenant's writer until the idle sweep notices.
    if (stream) service.closeStream(stream)
    if (isServerFault(err)) runtime.report(err)
    return hranaErrorResponse(err)
  }
}

/**
 * The same batch as a cursor: newline-delimited JSON, the response body's own header first and one
 * entry per line after it. Entries are produced before the body is written, because `../exec.ts`
 * materialises a result set anyway — a streaming body would buy latency, not memory.
 */
export async function handleCursor(
  runtime: ServerRuntime,
  request: Request,
  url: URL,
  params: Record<string, string>,
): Promise<Response> {
  const service = hranaService(runtime)
  let stream: HranaStream | null = null
  try {
    const principal = await principalOf(runtime, request)
    const db = namespaceOf(request, url, params)
    const body = await readJson<CursorReqBody>(request, runtime.config.limits.maxBodyBytes)
    stream = streamFor(service, body.baton, db, principal, httpOwner())

    let entries: CursorEntry[]
    try {
      entries = await cursorEntries(service, stream, body.batch)
    } catch (err) {
      // A failure of the cursor as a whole is an `error` entry, not an HTTP status: the client has
      // already been handed a stream and expects to read it.
      entries = [{ type: "error", error: toHranaError(err) }]
    }
    const lines = [
      JSON.stringify({ baton: service.rotate(stream), base_url: null }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ]
    return new Response(`${lines.join("\n")}\n`, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  } catch (err) {
    if (stream) service.closeStream(stream)
    if (isServerFault(err)) runtime.report(err)
    return hranaErrorResponse(err)
  }
}

/** `GET /vN`: the version probe `hrana-client` runs before it will use v3. */
export function handleVersion(version: number): Response {
  return new Response(String(version), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function isServerFault(err: unknown): boolean {
  return hranaStatus(err) >= 500
}
