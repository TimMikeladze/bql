// Invariant: an SSE subscription owns its own reconnect, and every attempt asks for the position
// it has actually delivered. `EventSource` is not used at all — it cannot set `Authorization`,
// which would force the token into the query string — so this is `fetch` plus a `ReadableStream`
// reader and a frame parser, which is all four target runtimes have in common.
//
// A 4xx is fatal: a bad token or a database that does not exist will not start working because we
// asked again. Anything else — a dropped connection, a restarted server, a 5xx — is retried.

import { BqlClientError, asClientError } from "./errors.ts"
import type { FetchLike } from "./http.ts"
import { readJson } from "./http.ts"

export interface SseFrame {
  id?: string
  event: string
  /** The `data:` lines, joined with newlines and not yet parsed. */
  data: string
}

/** Splits a byte stream into SSE frames. One instance per connection attempt. */
export class SseParser {
  #buffer = ""
  #decoder = new TextDecoder()

  push(chunk: Uint8Array): SseFrame[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true })
    const frames: SseFrame[] = []
    let split = this.#buffer.indexOf("\n\n")
    while (split >= 0) {
      const frame = parseFrame(this.#buffer.slice(0, split))
      this.#buffer = this.#buffer.slice(split + 2)
      if (frame) frames.push(frame)
      split = this.#buffer.indexOf("\n\n")
    }
    return frames
  }
}

function parseFrame(block: string): SseFrame | null {
  let id: string | undefined
  let event: string | undefined
  let retry: string | undefined
  const data: string[] = []
  for (const raw of block.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.length === 0 || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "id") id = value
    else if (field === "event") event = value
    else if (field === "data") data.push(value)
    else if (field === "retry") retry = value
  }
  if (retry !== undefined && event === undefined && data.length === 0) {
    return { event: "retry", data: retry }
  }
  if (event === undefined && data.length === 0) return null
  return {
    ...(id !== undefined ? { id } : {}),
    event: event ?? "message",
    data: data.join("\n"),
  }
}

export interface SseOptions {
  fetchImpl: FetchLike
  /** Recomputed per attempt, so a resume can move the `since` forward. */
  url: () => string
  headers: () => Record<string, string>
  onFrame: (frame: SseFrame) => void
  onError: (err: unknown) => void
  /** Called with every established connection's response, headers included. */
  onOpen?: (response: Response, attempt: number) => void
  /** Called when a connection is established, after the first one. */
  onReconnect?: () => void
  retryMs?: number
  /** What this stream is, for error messages. */
  what: string
}

export class SseSubscription {
  #options: SseOptions
  #controller = new AbortController()
  #closed = false
  #retryMs: number
  #started = false
  #attempts = 0

  constructor(options: SseOptions) {
    this.#options = options
    this.#retryMs = options.retryMs ?? 1000
  }

  get closed(): boolean {
    return this.#closed
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    void this.#loop()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#controller.abort()
  }

  async #loop(): Promise<void> {
    while (!this.#closed) {
      try {
        await this.#once()
      } catch (err) {
        if (this.#closed) return
        if (err instanceof BqlClientError && err.status >= 400 && err.status < 500) {
          this.#closed = true
          this.#options.onError(err)
          return
        }
        this.#options.onError(asClientError(err, this.#options.what))
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#retryMs)
        timer.unref?.()
      })
    }
  }

  async #once(): Promise<void> {
    const headers = new Headers(this.#options.headers())
    headers.set("accept", "text/event-stream")
    const response = await this.#options.fetchImpl(this.#options.url(), {
      headers,
      signal: this.#controller.signal,
    })
    if (!response.ok) {
      await readJson(response, this.#options.what)
      throw BqlClientError.network(`${this.#options.what}: ${response.status}`)
    }
    const body = response.body
    if (!body) throw BqlClientError.network(`${this.#options.what}: the response had no body`)
    this.#attempts += 1
    this.#options.onOpen?.(response, this.#attempts)
    if (this.#attempts > 1) this.#options.onReconnect?.()
    const reader = body.getReader()
    const parser = new SseParser()
    try {
      while (!this.#closed) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        for (const frame of parser.push(value)) {
          if (frame.event === "retry") {
            const ms = Number(frame.data)
            if (Number.isFinite(ms) && ms >= 0) this.#retryMs = ms
            continue
          }
          this.#options.onFrame(frame)
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
}
