// Invariant: one socket per client, opened the first time something needs it and shared by every
// database on it (design §7: one socket, many databases). Every request carries an `id` and every
// reply echoes it, so replies are matched by id rather than by order.
//
// Second invariant: the token travels in a `hello` message, never in the URL. Only Bun's
// `WebSocket` accepts headers, and a token in a query string is a token in every proxy log between
// here and the server.
//
// Third invariant: a subscription is an intent, not a socket state. A dropped socket re-opens and
// every intent is replayed, so a live query survives a restart of the server it was talking to.

import { BunQLClientError, asClientError } from "./errors.ts"
import { WS_PROTOCOL, type ErrorInfo, type WsPush } from "./protocol.ts"

export type WebSocketLike = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: never) => void): void
}

export type WebSocketFactory = (url: string, protocol: string) => WebSocketLike

export interface SocketConfig {
  url: string
  token: string | null
  factory: WebSocketFactory | null
  /** Delay before a dropped socket with live intents is re-opened. */
  retryMs?: number
  onError?: (err: unknown) => void
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: unknown) => void
}

type PushHandler = (push: WsPush) => void

/** Replayed after a reconnect; returns the subscription id the new socket assigned. */
export type Intent = () => Promise<void>

export class SocketClient {
  #config: SocketConfig
  #socket: WebSocketLike | null = null
  #ready: Promise<void> | null = null
  #nextId = 1
  #pending = new Map<number, Pending>()
  #pushes = new Map<string, PushHandler>()
  #intents = new Set<Intent>()
  #retry: ReturnType<typeof setTimeout> | null = null
  #closed = false

  constructor(config: SocketConfig) {
    this.#config = config
  }

  /** False when the runtime has no `WebSocket` and the caller supplied none. */
  get available(): boolean {
    return this.#config.factory !== null
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === 1
  }

  /** Opens the socket, or joins the open attempt already running. */
  connect(): Promise<void> {
    if (this.#closed) return Promise.reject(BunQLClientError.client("the client is closed"))
    const factory = this.#config.factory
    if (!factory) {
      return Promise.reject(
        BunQLClientError.client(
          "this runtime has no WebSocket; pass one as `WebSocket` to createClient",
        ),
      )
    }
    if (this.#ready) return this.#ready
    this.#ready = new Promise<void>((resolve, reject) => {
      let socket: WebSocketLike
      try {
        socket = factory(this.#config.url, WS_PROTOCOL)
      } catch (err) {
        reject(asClientError(err, `opening ${this.#config.url}`))
        return
      }
      this.#socket = socket
      let settled = false
      const fail = (err: unknown): void => {
        if (settled) return
        settled = true
        this.#ready = null
        reject(asClientError(err, `opening ${this.#config.url}`))
      }
      socket.addEventListener("message", ((event: { data: unknown }) => {
        this.#receive(String(event.data))
      }) as (event: never) => void)
      socket.addEventListener("error", (() => {
        fail(new Error("the WebSocket reported an error"))
      }) as (event: never) => void)
      socket.addEventListener("close", (() => {
        this.#onClose(socket)
        fail(new Error("the WebSocket closed before it was ready"))
      }) as (event: never) => void)
      socket.addEventListener("open", (() => {
        void (async () => {
          try {
            if (this.#config.token) {
              await this.#send({ op: "hello", token: this.#config.token })
            }
            settled = true
            resolve()
          } catch (err) {
            try {
              socket.close()
            } catch {
              // Already gone; the close handler does the rest.
            }
            fail(err)
          }
        })()
      }) as (event: never) => void)
    })
    return this.#ready
  }

  /** Sends a request and resolves with its reply (design §7: every reply echoes the `id`). */
  async request<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T> {
    await this.connect()
    return (await this.#send(message)) as T
  }

  /** Routes `{sub, event, data}` frames for one subscription id. */
  listen(sub: string, handler: PushHandler): void {
    this.#pushes.set(sub, handler)
  }

  unlisten(sub: string): void {
    this.#pushes.delete(sub)
  }

  /**
   * Registers work that re-establishes a subscription after a reconnect. While any intent is
   * registered, a dropped socket is re-opened on its own.
   */
  addIntent(intent: Intent): () => void {
    this.#intents.add(intent)
    return () => {
      this.#intents.delete(intent)
    }
  }

  close(): void {
    this.#closed = true
    if (this.#retry !== null) {
      clearTimeout(this.#retry)
      this.#retry = null
    }
    this.#intents.clear()
    this.#pushes.clear()
    const socket = this.#socket
    this.#socket = null
    this.#ready = null
    this.#rejectPending(BunQLClientError.network("the client was closed"))
    try {
      socket?.close()
    } catch {
      // Closing a socket that is already gone is not a failure.
    }
  }

  // -------------------------------------------------------------------------

  #send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.#socket
    if (!socket || socket.readyState > 1) {
      return Promise.reject(BunQLClientError.network("the socket is not open"))
    }
    const id = this.#nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        socket.send(JSON.stringify({ ...message, id }))
      } catch (err) {
        this.#pending.delete(id)
        reject(asClientError(err, "sending on the socket"))
      }
    })
  }

  #receive(text: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      this.#config.onError?.(BunQLClientError.network("the server sent a frame that is not JSON"))
      return
    }
    const id = message.id
    if (typeof id === "number") {
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      if (message.ok === false) {
        pending.reject(BunQLClientError.fromInfo(message.error as ErrorInfo))
      } else {
        pending.resolve(message)
      }
      return
    }
    const sub = message.sub
    if (typeof sub === "string") {
      this.#pushes.get(sub)?.(message as unknown as WsPush)
      return
    }
    // `hello`, `pong` and `moved` carry no id and no sub; only `moved` means anything to a caller,
    // and phase 0 has no failover to produce it.
    if (message.event === "moved") {
      this.#config.onError?.(
        BunQLClientError.fromInfo({
          code: "NOT_PRIMARY",
          message: `database ${String(message.db)} moved to ${String(message.primary)}`,
          status: 503,
          primary: String(message.primary),
        }),
      )
    }
  }

  #onClose(socket: WebSocketLike): void {
    if (this.#socket !== socket) return
    this.#socket = null
    this.#ready = null
    this.#rejectPending(BunQLClientError.network("the socket closed"))
    if (this.#closed || this.#intents.size === 0) return
    this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    if (this.#retry !== null || this.#closed) return
    const delay = this.#config.retryMs ?? 1000
    this.#retry = setTimeout(() => {
      this.#retry = null
      if (this.#closed || this.#intents.size === 0) return
      void this.connect()
        .then(async () => {
          for (const intent of [...this.#intents]) {
            try {
              await intent()
            } catch (err) {
              this.#config.onError?.(err)
            }
          }
        })
        .catch((err) => {
          this.#config.onError?.(err)
          this.#scheduleReconnect()
        })
    }, delay)
    this.#retry.unref?.()
  }

  #rejectPending(err: unknown): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const one of pending) one.reject(err)
  }
}

/** The default factory: the runtime's own `WebSocket`, when it has one. */
export function defaultWebSocketFactory(
  impl: unknown = (globalThis as { WebSocket?: unknown }).WebSocket,
): WebSocketFactory | null {
  if (typeof impl !== "function") return null
  const Ctor = impl as new (url: string, protocols?: string | string[]) => WebSocketLike
  return (url, protocol) => new Ctor(url, protocol)
}
