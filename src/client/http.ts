// Invariant: every request this SDK makes over HTTP is built here, so the bearer token, the
// `BunQL-Min-Txid` header of design §5.4 and the error mapping of §6.6 happen in exactly one
// place. A caller that forgets one cannot exist.
//
// Only `fetch` is used, with a caller-supplied implementation when the runtime has none on the
// global object.

import { BunQLClientError, asClientError } from "./errors.ts"
import { HEADERS, type ErrorBody } from "./protocol.ts"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpConfig {
  /** Base URL of the server, without a trailing slash. */
  base: string
  token: string | null
  fetchImpl: FetchLike
  /** Headers added to every request, for a proxy or a tracing header. */
  headers: Readonly<Record<string, string>>
}

export interface RequestInitLike {
  method?: string
  body?: unknown
  /** Sent as `BunQL-Min-Txid`, which is what read-your-writes is (design §5.4). */
  minTxid?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Overrides the client's token for this one request. */
  token?: string | null
}

/** Trailing slashes make `${base}/v1/...` ambiguous, so they are removed once, here. */
export function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(trimmed) && !/^wss?:\/\//i.test(trimmed)) {
    throw BunQLClientError.client(`url must be http(s) or ws(s), got ${JSON.stringify(url)}`)
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
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value)
    return headers
  }

  /** One request, with the body serialised and the response left untouched. */
  async send(path: string, init: RequestInitLike = {}): Promise<Response> {
    const headers = this.headersFor(init)
    let body: string | undefined
    if (init.body !== undefined) {
      body = JSON.stringify(init.body)
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
    }
    try {
      return await this.#config.fetchImpl(this.url(path), {
        method: init.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        ...(body === undefined ? {} : { body }),
        ...(init.signal ? { signal: init.signal } : {}),
      })
    } catch (err) {
      throw asClientError(err, `${init.method ?? "GET"} ${path}`)
    }
  }

  /** One request whose body is JSON, with design §6.6's error shape turned into a throw. */
  async json<T>(path: string, init: RequestInitLike = {}): Promise<T> {
    const response = await this.send(path, init)
    return readJson<T>(response, path)
  }
}

/** A response body as JSON, or the error it describes. */
export async function readJson<T>(response: Response, what: string): Promise<T> {
  const text = await response.text().catch(() => "")
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (!response.ok) {
    throw BunQLClientError.fromBody(
      parsed as ErrorBody | null,
      response.status,
      `${what} failed with ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    )
  }
  return parsed as T
}
