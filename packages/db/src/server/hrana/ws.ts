// Invariant: a socket answers nothing until it has a principal. The first message must be
// `hello`, and a `hello` that does not authenticate is answered with `hello_error` and the socket
// is closed — never left open in a state where the next message might slip through.
//
// Second invariant: requests are answered in the order they arrived. Hrana lets a client pipeline
// freely and says requests within one stream are processed in order; this socket keeps one chain
// for all of its streams, which is stricter than required and is the only ordering that is
// obviously correct when `BEGIN` on one stream and a statement on another share a tenant's single
// writer.
//
// Cursors here are materialised, exactly as they are over HTTP (see `./http.ts`): `open_cursor`
// runs the whole batch and `fetch_cursor` hands out slices of the entries it produced.

import type { Principal } from "../auth.ts"
import { BunQLError } from "../errors.ts"
import type { ServerRuntime } from "../runtime.ts"
import { cursorEntries, describe, executeStmt, runBatch, runSequence } from "./execute.ts"
import { hranaStatus, toHranaError } from "./errors.ts"
import type {
  ClientMsg,
  CursorEntry,
  ServerMsg,
  WsRequest,
  WsResponse,
  WsSubprotocol,
} from "./proto.ts"
import { SUBPROTOCOL_VERSION } from "./proto.ts"
import { hranaService, type HranaService, type HranaStream } from "./service.ts"

/** Open cursors one socket may hold. */
const MAX_CURSORS = 64
/** Streams one socket may hold. The service's own ceiling still applies across all sockets. */
const MAX_SOCKET_STREAMS = 256

interface OpenCursor {
  entries: CursorEntry[]
  at: number
}

export interface HranaSocketData {
  /** Marker the app's shared socket handlers branch on. */
  hrana: true
  runtime: ServerRuntime
  version: number
  /** The database every stream on this socket belongs to, resolved at upgrade. */
  db: string
  /** From the upgrade request's `Authorization`, when it had one; `hello` may replace it. */
  principal: Principal | null
  /** `store_sql` is connection-scoped over WebSocket, unlike HTTP where a stream owns it. */
  sql: Map<number, string>
  streams: Map<number, HranaStream>
  cursors: Map<number, OpenCursor>
  owner: object
  queue: Promise<unknown>
  helloSeen: boolean
}

export interface HranaSocket {
  data: HranaSocketData
  readyState: number
  send(data: string): number
  close(code?: number, reason?: string): void
}

export function newHranaSocketData(options: {
  runtime: ServerRuntime
  subprotocol: WsSubprotocol
  db: string
  principal: Principal | null
}): HranaSocketData {
  return {
    hrana: true,
    runtime: options.runtime,
    version: SUBPROTOCOL_VERSION[options.subprotocol],
    db: options.db,
    principal: options.principal,
    sql: new Map(),
    streams: new Map(),
    cursors: new Map(),
    owner: {},
    queue: Promise.resolve(),
    helloSeen: false,
  }
}

export function isHranaSocket(data: unknown): data is HranaSocketData {
  return (data as HranaSocketData | null)?.hrana === true
}

function send(ws: HranaSocket, message: ServerMsg): void {
  ws.send(JSON.stringify(message))
}

export function hranaWsOpen(_ws: HranaSocket): void {
  // Hrana is client-first: the server says nothing until it has been greeted.
}

export function hranaWsClose(ws: HranaSocket): void {
  const data = ws.data
  hranaService(data.runtime).closeOwned(data.owner)
  data.streams.clear()
  data.cursors.clear()
}

/** Every message is queued behind the previous one, so ordering is the socket's, not the loop's. */
export function hranaWsMessage(ws: HranaSocket, raw: string | Buffer | Uint8Array): void {
  ws.data.queue = ws.data.queue.then(
    () => dispatch(ws, raw),
    () => dispatch(ws, raw),
  )
}

async function dispatch(ws: HranaSocket, raw: string | Buffer | Uint8Array): Promise<void> {
  const data = ws.data
  let message: ClientMsg
  try {
    message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientMsg
  } catch {
    // Nothing to answer to: a frame this broken has no request_id to hang an error on.
    ws.close(1008, "the message is not valid JSON")
    return
  }

  if (message?.type === "hello") {
    await greet(ws, message.jwt)
    return
  }
  if (message?.type !== "request" || typeof message.request_id !== "number") {
    ws.close(1008, "expected a hello or request message")
    return
  }
  if (!data.principal) {
    send(ws, {
      type: "response_error",
      request_id: message.request_id,
      error: { message: "send a hello message with a token first", code: "UNAUTHENTICATED" },
    })
    return
  }
  try {
    const response = await handle(ws, message.request)
    send(ws, { type: "response_ok", request_id: message.request_id, response })
  } catch (err) {
    if (hranaStatus(err) >= 500) data.runtime.report(err)
    send(ws, { type: "response_error", request_id: message.request_id, error: toHranaError(err) })
  }
}

async function greet(ws: HranaSocket, jwt: string | null | undefined): Promise<void> {
  const data = ws.data
  if (data.helloSeen && data.principal) {
    // Hrana allows a second hello to re-authenticate; the streams it already opened stay.
    try {
      if (jwt) data.principal = await data.runtime.auth.authenticateToken(jwt)
      send(ws, { type: "hello_ok" })
    } catch (err) {
      send(ws, { type: "hello_error", error: toHranaError(err) })
      ws.close(1008, "unauthorized")
    }
    return
  }
  data.helloSeen = true
  try {
    if (jwt) {
      data.principal = await data.runtime.auth.authenticateToken(jwt)
    } else if (!data.principal) {
      throw BunQLError.unauthenticated("this socket needs a token in its hello")
    }
    send(ws, { type: "hello_ok" })
  } catch (err) {
    send(ws, { type: "hello_error", error: toHranaError(err) })
    ws.close(1008, "unauthorized")
  }
}

function streamOf(data: HranaSocketData, id: unknown): HranaStream {
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw BunQLError.badRequest("stream_id must be an integer")
  }
  const stream = data.streams.get(id)
  if (!stream || stream.closed) throw BunQLError.badRequest(`no stream ${id} is open`)
  stream.lastUsedMs = Date.now()
  return stream
}

function needsV3(data: HranaSocketData, what: string): void {
  if (data.version < 3) {
    throw BunQLError.badRequest(`${what} needs the hrana3 subprotocol, and this socket is hrana2`)
  }
}

async function handle(ws: HranaSocket, request: WsRequest): Promise<WsResponse> {
  const data = ws.data
  const service: HranaService = hranaService(data.runtime)
  const principal = data.principal as Principal

  switch (request?.type) {
    case "open_stream": {
      const id = request.stream_id
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw BunQLError.badRequest("stream_id must be an integer")
      }
      if (data.streams.has(id)) throw BunQLError.badRequest(`stream ${id} is already open`)
      if (data.streams.size >= MAX_SOCKET_STREAMS) {
        throw new BunQLError("TOO_MANY_REQUESTS", "this socket holds all the streams it will", 429)
      }
      // `false`: this socket answers in arrival order, so a `BEGIN` that waited for the writer
      // would stall the statements that release it. See `HranaStream.waitsForWriter`.
      data.streams.set(id, service.openStream(data.db, principal, data.owner, data.sql, false))
      return { type: "open_stream" }
    }
    case "close_stream": {
      const stream = data.streams.get(request.stream_id)
      if (stream) {
        service.closeStream(stream)
        data.streams.delete(request.stream_id)
      }
      // Closing a stream that is not there is not an error: the client is asking for a state it
      // already has.
      return { type: "close_stream" }
    }
    case "execute":
      return { type: "execute", result: await executeStmt(service, streamOf(data, request.stream_id), request.stmt) }
    case "batch":
      return { type: "batch", result: await runBatch(service, streamOf(data, request.stream_id), request.batch) }
    case "sequence": {
      const stream = streamOf(data, request.stream_id)
      await runSequence(service, stream, stream.sqlOf(request))
      return { type: "sequence" }
    }
    case "describe": {
      const stream = streamOf(data, request.stream_id)
      return { type: "describe", result: describe(service, stream, stream.sqlOf(request)) }
    }
    case "store_sql": {
      // Connection-scoped: any stream on this socket shares the map, so storing through the first
      // one is storing for all of them.
      storeOwner(data).storeSql(request.sql_id, request.sql)
      return { type: "store_sql" }
    }
    case "close_sql": {
      storeOwner(data).closeSql(request.sql_id)
      return { type: "close_sql" }
    }
    case "get_autocommit":
      return { type: "get_autocommit", is_autocommit: streamOf(data, request.stream_id).tx === null }
    case "open_cursor": {
      needsV3(data, "open_cursor")
      const id = request.cursor_id
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw BunQLError.badRequest("cursor_id must be an integer")
      }
      if (data.cursors.has(id)) throw BunQLError.badRequest(`cursor ${id} is already open`)
      if (data.cursors.size >= MAX_CURSORS) {
        throw new BunQLError("TOO_MANY_REQUESTS", "this socket holds all the cursors it will", 429)
      }
      const stream = streamOf(data, request.stream_id)
      data.cursors.set(id, { entries: await cursorEntries(service, stream, request.batch), at: 0 })
      return { type: "open_cursor" }
    }
    case "fetch_cursor": {
      needsV3(data, "fetch_cursor")
      const cursor = data.cursors.get(request.cursor_id)
      if (!cursor) throw BunQLError.badRequest(`no cursor ${request.cursor_id} is open`)
      const max = Number.isInteger(request.max_count) && request.max_count > 0 ? request.max_count : 1
      const entries = cursor.entries.slice(cursor.at, cursor.at + max)
      cursor.at += entries.length
      return { type: "fetch_cursor", entries, done: cursor.at >= cursor.entries.length }
    }
    case "close_cursor":
      needsV3(data, "close_cursor")
      data.cursors.delete(request.cursor_id)
      return { type: "close_cursor" }
    default:
      throw BunQLError.badRequest(
        `unknown Hrana request type ${JSON.stringify((request as { type?: unknown })?.type)}`,
      )
  }
}

/**
 * A stream to hang connection-scoped SQL storage on. Every stream of a socket shares one map, so
 * any of them will do; a socket with none yet gets a throwaway holder over the same map.
 */
function storeOwner(data: HranaSocketData): HranaStream {
  const first = data.streams.values().next()
  if (!first.done) return first.value
  return {
    sql: data.sql,
    storeSql(id: number, sql: string): void {
      if (data.sql.has(id)) throw BunQLError.badRequest(`sql_id ${id} is already stored`)
      data.sql.set(id, sql)
    },
    closeSql(id: number): void {
      if (!data.sql.delete(id)) throw BunQLError.badRequest(`no SQL is stored under id ${id}`)
    },
  } as unknown as HranaStream
}
