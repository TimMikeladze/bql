// The app the coordinator will ship, composed here rather than in `src/server/app.ts`: the native
// route table merged with `hranaRoutes`, the native `fetch` behind `isHranaUpgrade`, and the four
// socket handlers branching on `isHranaSocket`. If this file works, the three-line wiring in
// `app.ts` works, because it is the same three lines.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createApp, createRuntime } from "../../src/server/app.ts"
import { loadConfig, type ServerConfigInput } from "../../src/server/config.ts"
import {
  closeHranaService,
  hranaRoutes,
  hranaUpgrade,
  hranaWsClose,
  hranaWsMessage,
  hranaWsOpen,
  isHranaSocket,
  isHranaUpgrade,
} from "../../src/server/hrana/index.ts"
import type { ServerRuntime } from "../../src/server/runtime.ts"
import type {
  CursorEntry,
  HranaValue,
  PipelineReqBody,
  PipelineRespBody,
  ServerMsg,
  StreamRequest,
} from "../../src/server/hrana/proto.ts"
import { removeTempDir } from "../tmpdir.ts"

const dirs: string[] = []
const running: TestHrana[] = []

export interface TestHrana {
  url: string
  port: number
  runtime: ServerRuntime
  adminKey: string
  /** A raw pipeline POST. `route` defaults to the root `v2` mount. */
  pipeline(
    body: PipelineReqBody,
    init?: { route?: string; token?: string | null; headers?: Record<string, string> },
  ): Promise<{ status: number; body: PipelineRespBody & { message?: string; code?: string } }>
  /** A cursor POST, parsed out of its newline-delimited body. */
  cursor(
    body: { baton?: string | null; batch: unknown },
    init?: { route?: string; token?: string | null },
  ): Promise<{ status: number; head: { baton: string | null }; entries: CursorEntry[] }>
  fetch(route: string, init?: RequestInit & { token?: string | null }): Promise<Response>
  createDb(name: string, schema?: string): Promise<void>
  wsUrl(path?: string): string
  close(): Promise<void>
}

export async function startHrana(overrides: ServerConfigInput = {}): Promise<TestHrana> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-hrana-"))
  dirs.push(dir)
  const config = loadConfig({
    env: {},
    overrides: {
      ...overrides,
      server: { port: 0, host: "127.0.0.1", node: "hrana-test", ...overrides.server },
      data: { dir, ...overrides.data },
      limits: { txIdleTimeoutMs: 2000, ...overrides.limits },
    },
  })
  const { runtime, adminKey } = await createRuntime(config)
  const app = await createApp(runtime)

  // ── the wiring under test ──────────────────────────────────────────────────────────────────
  const routes = { ...(app.routes as Record<string, unknown>), ...hranaRoutes(runtime) }
  const base = app.websocket as unknown as Record<string, (...args: never[]) => unknown>
  const websocket = {
    ...base,
    open(ws: { data: unknown }): unknown {
      if (isHranaSocket(ws.data)) return hranaWsOpen(ws as never)
      return base.open?.(ws as never)
    },
    message(ws: { data: unknown }, message: string | Buffer): unknown {
      if (isHranaSocket(ws.data)) return hranaWsMessage(ws as never, message)
      return (base.message as (a: unknown, b: unknown) => unknown)?.(ws, message)
    },
    drain(ws: { data: unknown }): unknown {
      if (isHranaSocket(ws.data)) return undefined
      return base.drain?.(ws as never)
    },
    close(ws: { data: unknown }): unknown {
      if (isHranaSocket(ws.data)) return hranaWsClose(ws as never)
      return base.close?.(ws as never)
    },
  }
  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.host,
    routes: routes as never,
    fetch(request: Request, host: unknown) {
      const url = new URL(request.url)
      if (isHranaUpgrade(request, url)) return hranaUpgrade(runtime, request, host, url)
      return (app.fetch as (r: Request, s: unknown) => Response | undefined)(request, host)
    },
    websocket: websocket as never,
    development: false,
  })
  // ───────────────────────────────────────────────────────────────────────────────────────────

  const url = `http://127.0.0.1:${server.port}`
  const call = (route: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token, ...rest } = init
    const headers = new Headers(rest.headers)
    const bearer = token === undefined ? (adminKey as string) : token
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`)
    if (rest.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }
    return fetch(`${url}${route}`, { ...rest, headers })
  }

  const handle: TestHrana = {
    url,
    port: server.port as number,
    runtime,
    adminKey: adminKey as string,
    fetch: call,
    async pipeline(body, init = {}) {
      const response = await call(init.route ?? "/v2/pipeline", {
        method: "POST",
        body: JSON.stringify(body),
        ...(init.token !== undefined ? { token: init.token } : {}),
        ...(init.headers ? { headers: init.headers } : {}),
      })
      const text = await response.text()
      return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} }
    },
    async cursor(body, init = {}) {
      const response = await call(init.route ?? "/v3/cursor", {
        method: "POST",
        body: JSON.stringify(body),
        ...(init.token !== undefined ? { token: init.token } : {}),
      })
      const text = await response.text()
      if (response.status !== 200) {
        return { status: response.status, head: { baton: null }, entries: [] }
      }
      const lines = text.split("\n").filter((line) => line.length > 0)
      return {
        status: response.status,
        head: JSON.parse(lines[0] as string),
        entries: lines.slice(1).map((line) => JSON.parse(line) as CursorEntry),
      }
    },
    async createDb(name, schema) {
      const created = await call("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
      if (created.status !== 201) throw new Error(`create ${name}: ${await created.text()}`)
      if (schema) {
        const statements = schema
          .split(";")
          .map((sql) => sql.trim())
          .filter((sql) => sql.length > 0)
          .map((sql) => ({ sql }))
        const done = await call(`/v1/db/${name}/batch`, {
          method: "POST",
          body: JSON.stringify({ statements }),
        })
        if (!done.ok) throw new Error(`schema for ${name}: ${await done.text()}`)
      }
    },
    wsUrl(route = "/") {
      return `ws://127.0.0.1:${server.port}${route}`
    },
    async close() {
      const at = running.indexOf(handle)
      if (at >= 0) running.splice(at, 1)
      closeHranaService(runtime)
      await server.stop(true)
      runtime.close()
    },
  }
  running.push(handle)
  return handle
}

export async function stopAllHrana(): Promise<void> {
  while (running.length > 0) {
    const handle = running.pop()
    if (handle) await handle.close()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
}

/** One `execute` request, since almost every test wants exactly that. */
export function exec(sql: string, args?: unknown[], extra: Record<string, unknown> = {}): StreamRequest {
  return {
    type: "execute",
    stmt: { sql, ...(args ? { args } : {}), ...extra },
  } as StreamRequest
}

/** Hrana value literals, so the tests read as the wire does. */
export const V = {
  int: (n: number | bigint | string): HranaValue => ({ type: "integer", value: String(n) }),
  float: (n: number): HranaValue => ({ type: "float", value: n }),
  text: (value: string): HranaValue => ({ type: "text", value }),
  blob: (base64: string): HranaValue => ({ type: "blob", base64 }),
  null: { type: "null" } as HranaValue,
}

// ── a Hrana WebSocket client ───────────────────────────────────────────────────────────────────

export interface TestHranaSocket {
  socket: WebSocket
  protocol: string
  send(message: unknown): void
  next<T = ServerMsg>(predicate?: (message: ServerMsg) => boolean, timeoutMs?: number): Promise<T>
  request(request: unknown, timeoutMs?: number): Promise<ServerMsg>
  close(): void
}

export function openHranaSocket(
  url: string,
  protocols: string[] = ["hrana3-protobuf", "hrana3", "hrana2"],
): Promise<TestHranaSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols)
    const seen: ServerMsg[] = []
    const waiting: { predicate: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
    let nextId = 1

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerMsg
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
      const api: TestHranaSocket = {
        socket,
        protocol: socket.protocol,
        send(message) {
          socket.send(JSON.stringify(message))
        },
        next<T>(predicate: (m: ServerMsg) => boolean = () => true, timeoutMs = 4000): Promise<T> {
          for (let i = 0; i < seen.length; i++) {
            if (predicate(seen[i] as ServerMsg)) return Promise.resolve(seen.splice(i, 1)[0] as T)
          }
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(() => {
              const at = waiting.indexOf(waiter)
              if (at >= 0) waiting.splice(at, 1)
              rej(new Error(`timed out; saw ${JSON.stringify(seen)}`))
            }, timeoutMs)
            const waiter = {
              predicate,
              resolve: (message: ServerMsg) => {
                clearTimeout(timer)
                res(message as T)
              },
            }
            waiting.push(waiter)
          })
        },
        request(request, timeoutMs = 4000) {
          const id = nextId++
          socket.send(JSON.stringify({ type: "request", request_id: id, request }))
          return api.next(
            (m) =>
              (m.type === "response_ok" || m.type === "response_error") && m.request_id === id,
            timeoutMs,
          )
        },
        close() {
          socket.close()
        },
      }
      resolve(api)
    })
  })
}
