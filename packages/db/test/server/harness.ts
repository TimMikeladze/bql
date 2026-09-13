// A whole server on a temp directory and an ephemeral port, plus the small client the route tests
// use. Every test gets its own data root and its own keys, so nothing leaks between them and a
// failing test leaves no listener behind.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { loadConfig, type ServerConfigInput } from "../../src/server/config.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []
const running: ServerHandle[] = []

export function tempDataDir(prefix = "bunql-server-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export interface TestServer {
  handle: ServerHandle
  url: string
  adminKey: string
  /** A fetch that prefixes the base URL and carries the admin key unless told otherwise. */
  fetch(path: string, init?: RequestInit & { token?: string | null }): Promise<Response>
  json<T = unknown>(path: string, init?: RequestInit & { token?: string | null }): Promise<T>
  /** Mints a token through the admin route, which is also what records it for revocation. */
  token(body: Record<string, unknown>): Promise<{ token: string; jti: string; exp: number | null }>
  wsUrl(query?: string): string
  close(): Promise<void>
}

/** Starts a server on port 0 with the given overrides merged into the defaults. */
export async function startTestServer(overrides: ServerConfigInput = {}): Promise<TestServer> {
  const dir = tempDataDir()
  const config = loadConfig({
    env: {},
    overrides: {
      ...overrides,
      server: { port: 0, host: "127.0.0.1", node: "test-node", ...overrides.server },
      data: { dir, ...overrides.data },
      // Tests must not be kept waiting by the idle checkpoint sweep or a long transaction leash.
      // `txWaitMs` is the R2 queue: short enough that a test which *wants* `TX_BUSY` gets it
      // quickly, long enough that two honest concurrent transactions still take their turn.
      limits: { txIdleTimeoutMs: 1000, txWaitMs: 500, ...overrides.limits },
    },
  })
  const handle = await startServer(config, { log: () => {} })
  running.push(handle)
  const base = `http://127.0.0.1:${handle.server.port}`
  const adminKey = handle.adminKey as string

  const call = (
    route: string,
    init: RequestInit & { token?: string | null } = {},
  ): Promise<Response> => {
    const { token, ...rest } = init
    const headers = new Headers(rest.headers)
    const bearer = token === undefined ? adminKey : token
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`)
    if (rest.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }
    return fetch(`${base}${route}`, { ...rest, headers })
  }

  return {
    handle,
    url: base,
    adminKey,
    fetch: call,
    async json<T>(route: string, init?: RequestInit & { token?: string | null }): Promise<T> {
      const response = await call(route, init)
      return (await response.json()) as T
    },
    async token(body: Record<string, unknown>) {
      const response = await call("/v1/tokens", { method: "POST", body: JSON.stringify(body) })
      if (response.status !== 201) throw new Error(`mint failed: ${await response.text()}`)
      return (await response.json()) as { token: string; jti: string; exp: number | null }
    },
    wsUrl(query = "") {
      return `ws://127.0.0.1:${handle.server.port}/v1/ws${query}`
    },
    async close() {
      const at = running.indexOf(handle)
      if (at >= 0) running.splice(at, 1)
      await handle.close()
    },
  }
}

export async function stopAll(): Promise<void> {
  while (running.length > 0) {
    const handle = running.pop()
    if (handle) await handle.close()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
}

/** Creates a database through the admin route and returns its name. */
export async function createDb(server: TestServer, name: string, schema?: string): Promise<string> {
  const created = await server.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
  if (created.status !== 201) throw new Error(`create ${name} failed: ${await created.text()}`)
  if (schema) {
    // One statement per request is the contract, so a multi-statement schema goes as a batch.
    const statements = schema
      .split(";")
      .map((sql) => sql.trim())
      .filter((sql) => sql.length > 0)
      .map((sql) => ({ sql }))
    const response = await server.fetch(`/v1/db/${name}/batch`, {
      method: "POST",
      body: JSON.stringify({ statements }),
    })
    if (!response.ok) throw new Error(`schema for ${name} failed: ${await response.text()}`)
  }
  return name
}

// ── SSE ────────────────────────────────────────────────────────────────────────────────────────

export interface SseEvent {
  id?: string
  event: string
  data: unknown
}

function parseFrame(frame: string): SseEvent | null {
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue
    if (line.startsWith("id:")) id = line.slice(3).trim()
    else if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trim())
  }
  if (!event) return null
  const body = data.join("\n")
  return {
    ...(id !== undefined ? { id } : {}),
    event,
    data: body.length > 0 ? JSON.parse(body) : null,
  }
}

/**
 * Reads an SSE body until `count` events have arrived or `timeoutMs` passes, then cancels the
 * stream. The reader is never left with a pending read: an abandoned one rejects when the body is
 * cancelled, and an unhandled rejection takes the whole test process down with it.
 */
export async function collectSse(
  response: Response,
  count: number,
  timeoutMs = 4000,
): Promise<SseEvent[]> {
  const body = response.body
  if (!body) throw new Error(`the SSE response had no body (status ${response.status})`)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buffer = ""
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs)
  try {
    while (events.length < count) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf("\n\n")
      while (split >= 0) {
        const parsed = parseFrame(buffer.slice(0, split))
        buffer = buffer.slice(split + 2)
        if (parsed) events.push(parsed)
        split = buffer.indexOf("\n\n")
      }
    }
  } catch {
    // The deadline cancelled the body mid-read; whatever arrived is what the caller gets.
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  if (events.length < count) {
    throw new Error(`expected ${count} SSE events, got ${events.length}: ${JSON.stringify(events)}`)
  }
  return events
}

/** Every event that arrives within `timeoutMs`, however many that is. */
export async function drainSse(response: Response, timeoutMs = 400): Promise<SseEvent[]> {
  try {
    return await collectSse(response, Number.POSITIVE_INFINITY, timeoutMs)
  } catch (err) {
    const message = String(err)
    const match = message.match(/got \d+: (\[.*\])$/s)
    return match ? (JSON.parse(match[1] as string) as SseEvent[]) : []
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────────────────────

export interface TestSocket {
  socket: WebSocket
  send(message: unknown): void
  /** The next message matching `predicate`, or a rejection after `timeoutMs`. */
  next<T>(predicate?: (message: T) => boolean, timeoutMs?: number): Promise<T>
  /** Every message received so far. */
  readonly seen: unknown[]
  close(): void
}

export function openSocket(url: string, protocol = "bunql.v1"): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol)
    const seen: unknown[] = []
    const waiting: { predicate: (m: never) => boolean; resolve: (m: never) => void }[] = []
    type Waiter = (typeof waiting)[number]

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as never
      // A message handed to a waiter is consumed by it; leaving it in `seen` as well would let
      // the next `next()` match the same frame a second time.
      for (let i = 0; i < waiting.length; i++) {
        const waiter = waiting[i]
        if (waiter && waiter.predicate(message)) {
          waiting.splice(i, 1)
          waiter.resolve(message)
          return
        }
      }
      seen.push(message)
    })
    socket.addEventListener("error", () => reject(new Error(`could not open ${url}`)))
    socket.addEventListener("open", () => {
      resolve({
        socket,
        seen,
        send(message: unknown): void {
          socket.send(JSON.stringify(message))
        },
        next<T>(predicate: (message: T) => boolean = () => true, timeoutMs = 4000): Promise<T> {
          const matches = predicate as unknown as (m: never) => boolean
          for (let i = 0; i < seen.length; i++) {
            if (matches(seen[i] as never)) return Promise.resolve(seen.splice(i, 1)[0] as T)
          }
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(() => {
              const at = waiting.indexOf(waiter)
              if (at >= 0) waiting.splice(at, 1)
              rej(new Error(`timed out waiting for a message; saw ${JSON.stringify(seen)}`))
            }, timeoutMs)
            const waiter: Waiter = {
              predicate: matches,
              resolve: (message) => {
                clearTimeout(timer)
                res(message as T)
              },
            }
            waiting.push(waiter)
          })
        },
        close(): void {
          socket.close()
        },
      })
    })
  })
}

/** Waits until `check` is true, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
