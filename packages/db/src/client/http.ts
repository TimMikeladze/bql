// Invariant: every request this SDK makes over HTTP is built here, so the bearer token, the
// `BQL-Min-Txid` header of design §5.4 and the error mapping of §6.6 happen in exactly one
// place. A caller that forgets one cannot exist.
//
// Second invariant (C2): a request is replayed against another node **only** on `NOT_PRIMARY`,
// **only** once, and **only** when the caller asked for it. `NOT_PRIMARY` is the one failure this
// server produces strictly *before* a statement runs — `requirePrimary` before the body is read,
// `assertWritable` before the writer is taken, the forwarder before a frame goes out — so
// replaying it cannot double-apply a write. `FORWARD_TIMEOUT` and a dropped socket mean "may or
// may not have committed" (`docs/next.md`) and are never retried; nor is anything inside an
// interactive transaction, whose baton belongs to one node. See `docs/c2-promotion.md`.
//
// Only `fetch` is used, with a caller-supplied implementation when the runtime has none on the
// global object.

import { BqlClientError, asClientError } from "./errors.ts"
import { HEADERS, type ErrorBody } from "./protocol.ts"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Whatever this runtime's `fetch` accepts as a body, without naming a DOM-only type. */
export type RawBody = NonNullable<RequestInit["body"]>

export interface HttpConfig {
  /** Base URL of the server, without a trailing slash. */
  base: string
  token: string | null
  fetchImpl: FetchLike
  /** Headers added to every request, for a proxy or a tracing header. */
  headers: Readonly<Record<string, string>>
}

export interface RequestInitLike {
  idempotencyKey?: string
  minGeneration?: string
  onResponse?: (headers: Headers) => void
  method?: string
  body?: unknown
  /** Sent as `BQL-Min-Txid`, which is what read-your-writes is (design §5.4). */
  minTxid?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Overrides the client's token for this one request. */
  token?: string | null
  /**
   * Replay this request once against the node a `NOT_PRIMARY` names. Set by the one-shot statement
   * paths and by nothing else — see the invariant at the top of this file.
   */
  retryOnMoved?: boolean
  /**
   * A body sent as-is rather than as JSON, for the two admin routes that carry a raw SQLite file.
   * The caller sets `content-type` in `headers`; nothing here guesses one.
   */
  raw?: RawBody
}

/** Trailing slashes make `${base}/v1/...` ambiguous, so they are removed once, here. */
export function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(trimmed) && !/^wss?:\/\//i.test(trimmed)) {
    throw BqlClientError.client(`url must be http(s) or ws(s), got ${JSON.stringify(url)}`)
  }
  return trimmed.replace(/^ws/i, "http")
}

/** The `/v1/ws` endpoint for a base URL, on the matching WebSocket scheme. */
export function socketUrl(base: string): string {
  return `${base.replace(/^http/i, "ws")}/v1/ws`
}

export class HttpClient {
  readonly base: string

  #config: HttpConfig

  constructor(config: HttpConfig) {
    this.#config = config
    this.base = config.base
  }

  get token(): string | null {
    return this.#config.token
  }

  /** Absolute URL for a path that already starts with a slash. */
  url(path: string): string {
    return `${this.base}${path}`
  }

  headersFor(init: RequestInitLike = {}): Headers {
    const headers = new Headers(this.#config.headers as Record<string, string>)
    const token = init.token === undefined ? this.#config.token : init.token
    if (token) headers.set("authorization", `Bearer ${token}`)
    if (init.minTxid !== undefined && init.minTxid > 0) {
      headers.set(HEADERS.minTxid, String(init.minTxid))
    }
    if (init.idempotencyKey !== undefined) headers.set("Idempotency-Key", init.idempotencyKey)
    if (init.minGeneration !== undefined) headers.set("BQL-Min-Generation", init.minGeneration)
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value)
    return headers
  }

  /** One request, with the body serialised and the response left untouched. */
  send(path: string, init: RequestInitLike = {}): Promise<Response> {
    return this.#sendTo(this.base, path, init)
  }

  async #sendTo(base: string, path: string, init: RequestInitLike): Promise<Response> {
    const headers = this.headersFor(init)
    let body: RawBody | undefined
    if (init.raw !== undefined) {
      body = init.raw
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body)
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
    }
    try {
      return await this.#config.fetchImpl(`${base}${path}`, {
        method: init.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        ...(body === undefined ? {} : { body }),
        // A stream body is a half-duplex request; fetch refuses one without this.
        ...(init.raw instanceof ReadableStream ? { duplex: "half" } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      } as RequestInit)
    } catch (err) {
      throw asClientError(err, `${init.method ?? "GET"} ${path}`)
    }
  }

  /**
   * One request whose body is JSON, with design §6.6's error shape turned into a throw — and, when
   * the caller opted in, one replay against the node a `NOT_PRIMARY` names.
   *
   * The replay carries this client's own headers and token rather than following the redirect: a
   * cross-origin redirect strips `Authorization` per the Fetch standard, which is exactly why the
   * server answers `503` rather than `307` when the new primary is on another origin.
   */
  async json<T>(path: string, init: RequestInitLike = {}): Promise<T> {
    const response = await this.send(path, init)
    const text = await response.text().catch(() => "")
    if (init.retryOnMoved) {
      const elsewhere = movedTo(response, text, this.base)
      if (elsewhere) {
        const retried = await this.#sendTo(elsewhere, path, init)
        init.onResponse?.(retried.headers)
        return parseBody<T>(await retried.text().catch(() => ""), retried.status, retried.ok, path)
      }
    }
    init.onResponse?.(response.headers)
    return parseBody<T>(text, response.status, response.ok, path)
  }
}

/**
 * The base URL a `NOT_PRIMARY` points at, or null when this response is not one, names nowhere, or
 * names the node that just answered.
 *
 * The status is checked *and* the body's code, because every response from a replica carries
 * `BQL-Primary` — including a `503 BUSY`, which is a different failure and is not replayed here.
 */
function movedTo(response: Response, text: string, from: string): string | null {
  if (response.ok) return null
  let code: string | undefined
  try {
    code = (JSON.parse(text) as ErrorBody | null)?.error?.code
  } catch {
    return null
  }
  if (code !== "NOT_PRIMARY") return null
  const named = response.headers.get(HEADERS.primary)
  if (!named) return null
  const base = httpBaseOf(named)
  return base && base !== from ? base : null
}

/**
 * `BQL-Primary` is a `ws://host/v1/replication` in a static topology and an HTTP base in a
 * cluster. Either way what a client needs is the origin, so both collapse to the same thing.
 */
export function httpBaseOf(value: string): string | null {
  try {
    const url = new URL(value)
    const scheme = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol
    return `${scheme}//${url.host}`
  } catch {
    return null
  }
}

/** A response body as JSON, or the error it describes. */
export async function readJson<T>(response: Response, what: string): Promise<T> {
  const text = await response.text().catch(() => "")
  return parseBody<T>(text, response.status, response.ok, what)
}

function parseBody<T>(text: string, status: number, ok: boolean, what: string): T {
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (!ok) {
    throw BqlClientError.fromBody(
      parsed as ErrorBody | null,
      status,
      `${what} failed with ${status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    )
  }
  return parsed as T
}
