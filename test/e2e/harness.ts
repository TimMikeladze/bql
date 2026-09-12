// Fixtures for the end-to-end scenario. Unlike `test/server/harness.ts`, the server here is
// restarted on the same data directory and the same port, so both are owned by the test rather
// than handed out per call: a client that reconnects has to find the server where it left it.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "../../src/sqlite/index.ts"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { loadConfig } from "../../src/server/config.ts"

const dirs: string[] = []

export function tempDir(prefix = "bunql-e2e-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Starts the server on `dir`. `port` 0 picks one; passing the port back on a later call is what
 * makes a restart invisible to a client that is holding a URL.
 */
export async function serve(dir: string, port = 0): Promise<ServerHandle> {
  const config = loadConfig({
    env: {},
    overrides: {
      server: { port, host: "127.0.0.1", node: "e2e" },
      data: { dir },
      limits: { txIdleTimeoutMs: 2000 },
      // A short retain keeps the scenario's teardown quick; the resume tests set their own pace.
      realtime: { idleRetainMs: 5000 },
    },
  })
  return startServer(config, { log: () => {} })
}

// ── SSE ────────────────────────────────────────────────────────────────────────────────────────

export interface SseEvent {
  id?: string
  event: string
  data: Record<string, unknown>
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
    data: body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {},
  }
}

/**
 * A change or live feed read in the background for as long as the test wants it. The collector
 * resolves once the response headers are in, which — for `/changes` and `/live` — is after the
 * route has already registered the subscription, so a write that follows cannot be missed.
 */
export interface SseCollector {
  readonly events: SseEvent[]
  readonly errors: unknown[]
  /** `Last-Event-ID` for a reconnect: the id of the newest event delivered. */
  readonly lastId: string | null
  /** Events of one kind, in arrival order. */
  of(event: string): SseEvent[]
  waitFor(check: () => boolean, timeoutMs?: number, what?: string): Promise<void>
  close(): void
}

export async function openSse(
  url: string,
  init: { token?: string | null; lastEventId?: string } = {},
): Promise<SseCollector> {
  const headers = new Headers({ accept: "text/event-stream" })
  if (init.token) headers.set("authorization", `Bearer ${init.token}`)
  if (init.lastEventId) headers.set("last-event-id", init.lastEventId)
  const controller = new AbortController()
  const response = await fetch(url, { headers, signal: controller.signal })
  if (!response.ok || !response.body) {
    throw new Error(`SSE ${url} answered ${response.status}: ${await response.text()}`)
  }

  const events: SseEvent[] = []
  const errors: unknown[] = []
  let lastId: string | null = null
  let closed = false

  const reader = response.body.getReader()
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let split = buffer.indexOf("\n\n")
        while (split >= 0) {
          const parsed = parseFrame(buffer.slice(0, split))
          buffer = buffer.slice(split + 2)
          if (parsed) {
            events.push(parsed)
            if (parsed.id !== undefined) lastId = parsed.id
          }
          split = buffer.indexOf("\n\n")
        }
      }
    } catch (err) {
      if (!closed) errors.push(err)
    }
  })()

  return {
    events,
    errors,
    get lastId() {
      return lastId
    },
    of(event: string) {
      return events.filter((e) => e.event === event)
    },
    waitFor(check, timeoutMs = 10_000, what = "a condition on the feed") {
      return until(check, timeoutMs, () => `${what}; saw ${events.length} events`)
    },
    close() {
      closed = true
      controller.abort()
      void reader.cancel().catch(() => {})
    },
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────────────────────

export interface Frame {
  id?: number
  ok?: boolean
  sub?: string
  event?: string
  data?: Record<string, unknown>
  error?: { code: string; message: string; status: number }
  [key: string]: unknown
}

export interface TestSocket {
  socket: WebSocket
  /** Sends a frame with a fresh id and resolves with its reply. */
  ask(frame: Record<string, unknown>): Promise<Frame>
  /** Server-initiated frames, in arrival order. */
  readonly pushes: Frame[]
  waitFor(check: () => boolean, timeoutMs?: number, what?: string): Promise<void>
  close(): void
}

export function openSocket(url: string, protocol = "bunql.v1"): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol)
    const waiters = new Map<number, (frame: Frame) => void>()
    const pushes: Frame[] = []
    let nextId = 1

    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame
      if (typeof frame.id === "number") {
        const waiter = waiters.get(frame.id)
        if (waiter) {
          waiters.delete(frame.id)
          waiter(frame)
          return
        }
      }
      pushes.push(frame)
    })
    socket.addEventListener("error", () => reject(new Error(`could not open ${url}`)))
    socket.addEventListener("open", () => {
      resolve({
        socket,
        pushes,
        ask(frame) {
          const id = nextId++
          socket.send(JSON.stringify({ ...frame, id }))
          return new Promise<Frame>((res, rej) => {
            const timer = setTimeout(() => {
              waiters.delete(id)
              rej(new Error(`no reply to ${JSON.stringify(frame)} in 10 s`))
            }, 10_000)
            waiters.set(id, (reply) => {
              clearTimeout(timer)
              res(reply)
            })
          })
        },
        waitFor(check, timeoutMs = 10_000, what = "a condition on the socket") {
          return until(check, timeoutMs, () => `${what}; saw ${pushes.length} pushes`)
        },
        close() {
          socket.close()
        },
      })
    })
  })
}

// ── waiting ────────────────────────────────────────────────────────────────────────────────────

/** Polls until `check` is true. Every wait in this suite is a condition, never a sleep. */
export async function until(
  check: () => boolean,
  timeoutMs = 10_000,
  describe: () => string = () => "a condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe()}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ── dumps ──────────────────────────────────────────────────────────────────────────────────────

/** Every user table and its rows, ordered, as one comparable string. */
export function dumpDatabase(dbPath: string): string {
  const db = Database.open(dbPath, { readonly: true })
  try {
    const tables = db
      .prepare(
        "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all()
    const parts: string[] = []
    for (const row of tables) {
      const name = row.name as string
      const rows = db.prepare(`select * from "${name}" order by rowid`).values()
      parts.push(`## ${name}\n${rows.map((r) => JSON.stringify(r)).join("\n")}`)
    }
    return parts.join("\n")
  } finally {
    db.close()
  }
}

/** Saves a `GET /v1/db/{db}/dump` body to a file and returns its path. */
export async function saveDump(response: Response, into: string): Promise<string> {
  if (!response.ok) throw new Error(`dump answered ${response.status}: ${await response.text()}`)
  await Bun.write(into, await response.arrayBuffer())
  return into
}
