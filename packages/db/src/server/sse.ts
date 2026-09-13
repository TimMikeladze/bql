// Invariant: an SSE response never relies on the server's idle timeout to stay open. Bun caps
// `idleTimeout` at 255 s, so every stream calls `server.timeout(request, 0)` to opt out of it
// entirely and keeps its own `: ping` comment on a 15 s timer (design §6.4). A stream also always
// cleans up through exactly one path — `close()` — whether the client went away, the subscription
// ended, or the server is shutting down.

/** Headers design §6.4 asks for: never cached, never transformed, never buffered by a proxy. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
}

export interface SseOptions {
  request: Request
  /** Comment interval in milliseconds. Default 15 000 (design §6.4). */
  pingMs?: number
  /** How long a disconnected `EventSource` should wait before reconnecting. Default 1000 ms. */
  retryMs?: number
  /** Called once, when the stream ends for any reason. */
  onClose?: () => void
}

/** What `Bun.serve` offers a route handler; only the timeout escape hatch is needed here. */
export interface TimeoutHost {
  timeout(request: Request, seconds: number): void
}

const encoder = new TextEncoder()

export class SseStream {
  readonly stream: ReadableStream<Uint8Array>

  #controller: ReadableStreamDefaultController<Uint8Array> | null = null
  #ping: ReturnType<typeof setInterval> | null = null
  #onClose: (() => void) | undefined
  #closed = false
  #queued: Uint8Array[] = []

  constructor(options: SseOptions) {
    this.#onClose = options.onClose
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller
        for (const chunk of this.#queued) controller.enqueue(chunk)
        this.#queued = []
      },
      cancel: () => {
        this.close()
      },
    })
    const pingMs = options.pingMs ?? 15_000
    if (pingMs > 0) {
      this.#ping = setInterval(() => this.comment("ping"), pingMs)
      this.#ping.unref?.()
    }
    options.request.signal.addEventListener("abort", () => this.close(), { once: true })
  }

  get closed(): boolean {
    return this.#closed
  }

  /** The response body plus the headers of design §6.4, with `extra` merged in. */
  response(extra?: Record<string, string>): Response {
    return new Response(this.stream, { headers: { ...SSE_HEADERS, ...extra } })
  }

  /** One `event:`/`data:` frame, with an optional `id:` for `Last-Event-ID` resume. */
  send(event: string, data: unknown, id?: number | string): boolean {
    let frame = ""
    if (id !== undefined) frame += `id: ${id}\n`
    frame += `event: ${event}\n`
    frame += `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
    return this.write(frame)
  }

  /** A `: text` comment line, which is what the keep-alive ping is. */
  comment(text: string): boolean {
    return this.write(`: ${text}\n\n`)
  }

  write(text: string): boolean {
    if (this.#closed) return false
    const chunk = encoder.encode(text)
    const controller = this.#controller
    if (!controller) {
      this.#queued.push(chunk)
      return true
    }
    try {
      controller.enqueue(chunk)
      return true
    } catch {
      // The client hung up between the abort event and this write.
      this.close()
      return false
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#ping !== null) {
      clearInterval(this.#ping)
      this.#ping = null
    }
    try {
      this.#controller?.close()
    } catch {
      // Already closed by the runtime; nothing left to do.
    }
    this.#controller = null
    const onClose = this.#onClose
    this.#onClose = undefined
    onClose?.()
  }
}

/**
 * Opens a stream and takes the request out of the idle-timeout budget. Bun's cap is 255 s and an
 * SSE subscription is expected to outlive that by hours.
 *
 * The stream opens with a comment and a `retry:` directive rather than with nothing. A subscriber
 * that is up to date has no event to send yet, and a response whose body stays empty is one that
 * intermediaries — and some HTTP clients — hold on to instead of delivering the headers. The first
 * bytes are what turn it into a live stream.
 */
export function openSse(host: TimeoutHost, options: SseOptions): SseStream {
  try {
    host.timeout(options.request, 0)
  } catch {
    // A host without the escape hatch (a test harness, say) still gets a working stream.
  }
  const stream = new SseStream(options)
  stream.write(`retry: ${options.retryMs ?? 1000}\n: open\n\n`)
  return stream
}

/** `Last-Event-ID`, or the `since` query parameter, as the position to resume from. */
export function resumeFrom(request: Request, url: URL): number | undefined {
  const header = request.headers.get("last-event-id")
  const raw = header ?? url.searchParams.get("since")
  if (raw === null || raw === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}
