// The envelopes that cross the `postMessage` channel between the router (the main thread, which
// owns the listener) and a worker (which owns a shard of databases). `docs/c4-workers.md` §4.
//
// Invariant: every message carries a `kind` and, when it expects an answer, an `id` minted by the
// router. Ids are per pool, not per worker, so a reply can be correlated without knowing which
// worker sent it.
//
// Second invariant: nothing here is a class and nothing here holds a function. Structured clone
// is what moves these, so a field that cannot survive it — a `Response`, a socket, an object
// identity used as a key — is represented by a string id instead. That is why a transaction's
// owner and a socket are strings here and objects in `src/server/ws.ts`.
//
// A body crosses as `Uint8Array`, which structured clone copies; the alternative, a transferable
// `ArrayBuffer`, would detach the router's copy and is not worth the sharp edge for bodies that
// are almost always a few hundred bytes.

import type { MetricsState } from "../metrics.ts"

/** One HTTP request, on its way to the worker that owns the database its path names. */
export interface HttpHop {
  kind: "http"
  id: number
  method: string
  url: string
  headers: [string, string][]
  body: Uint8Array | null
}

/** A whole response, for a handler that returned a buffered body. */
export interface HttpReply {
  kind: "http.reply"
  id: number
  status: number
  headers: [string, string][]
  body: Uint8Array | null
}

/** The head of a streamed response — the SSE change feed, `GET /v1/db/{db}/dump`. */
export interface HttpOpen {
  kind: "http.open"
  id: number
  status: number
  headers: [string, string][]
}

export interface HttpChunk {
  kind: "http.chunk"
  id: number
  bytes: Uint8Array
}

/** The router's client went away, so the worker's own request signal must abort. */
export interface HttpAbort {
  kind: "http.abort"
  id: number
}

export interface HttpEnd {
  kind: "http.end"
  id: number
  /** Set when the worker's stream failed part way; the router aborts its own stream with it. */
  error?: string
}

// ── WebSocket relay ────────────────────────────────────────────────────────────────────────────
//
// A socket cannot cross a thread, so the worker holds a *virtual* socket per (client socket,
// worker) pair with the `SocketData` `src/server/ws.ts` expects, and everything that module does
// to a socket — `send`, `subscribe`, `unsubscribe`, `close` — comes back here as a message the
// router applies to the real one. `handleMessage` itself is unchanged.

/**
 * The router adopting a client socket on this worker, or re-stating its identity after a `hello`
 * gave the socket a new token. The credential crosses as the bearer token itself rather than as a
 * `Principal`, because a `Principal` carries `scopeFor` — a function, which structured clone
 * cannot move — and because re-authenticating on the worker is the same code path, revocation
 * check included, instead of a second one that has to be kept in step with it.
 */
export interface WsHello {
  kind: "ws.hello"
  socket: string
  token: string | null
  /**
   * Set for a libsql/Hrana socket, whose database is fixed at upgrade (`hranaUpgrade` resolves it
   * from the path, `x-namespace` or the `Host` label) — so the whole socket belongs to one shard
   * and no frame of it ever has to be routed.
   */
  hrana?: { db: string; version: number }
}

/** One client frame, verbatim, for `handleMessage` to run against the virtual socket. */
export interface WsMessage {
  kind: "ws.msg"
  socket: string
  text: string
}

/** The client socket closed; the worker runs `closeSocket` on its virtual one. */
export interface WsClose {
  kind: "ws.close"
  socket: string
}

/** Bun told the router the socket has room again. */
export interface WsDrain {
  kind: "ws.drain"
  socket: string
}

/** A frame the virtual socket produced, for the router to write to the real one. */
export interface WsSend {
  kind: "ws.send"
  socket: string
  text: string
  /**
   * Routing keys learned from this frame, so the router can send a later frame that names only a
   * baton or a subscription id to the worker that minted it. Present only on the rare frames that
   * mint one — a `tx.begin` reply and a `subscribe` reply.
   */
  bind?: { tx?: string; sub?: string }
}

export interface WsTopic {
  kind: "ws.subscribe" | "ws.unsubscribe"
  socket: string
  topic: string
}

export interface WsShut {
  kind: "ws.shut"
  socket: string
  code?: number
  reason?: string
}

// ── worker → router, unsolicited ───────────────────────────────────────────────────────────────

/**
 * A realtime payload, already serialised, for `server.publish`. This is the whole cross-worker
 * change-feed story: a worker has no subscribers, so its `RealtimeBus` publisher posts here and
 * the router fans out over Bun's own pub/sub.
 */
export interface PublishEvent {
  kind: "publish"
  topic: string
  data: string
}

/** Design §5.3's `moved`, raised by a worker's promoter and published by the router. */
export interface MovedEvent {
  kind: "moved"
  db: string
  primary: string
}

/** Something the worker's runtime reported; the router logs it with the worker's index. */
export interface ErrorEvent {
  kind: "error"
  message: string
}

/** The worker is up and its runtime is built. */
export interface ReadyEvent {
  kind: "ready"
  /** Set when the worker failed to start; the router rejects the whole `startServer`. */
  error?: string
}

// ── control ────────────────────────────────────────────────────────────────────────────────────

export interface MetricsAsk {
  kind: "metrics"
  id: number
}

export interface MetricsReply {
  kind: "metrics.reply"
  id: number
  /** This worker's counters, for the router to add to the other workers'. */
  metrics: MetricsState
  /** Its share of the LRU, since `open` and `evictions` are per thread. */
  registry: { open: number; tenants: number; evictions: number }
}

export interface Shutdown {
  kind: "shutdown"
  id: number
}

export interface ShutdownReply {
  kind: "shutdown.reply"
  id: number
}

/** Everything the router sends. */
export type ToWorker =
  /**
   * The resolved configuration, verbatim. Key material is not carried: the router resolved it
   * first, so `<dataDir>/keys.json` exists by the time a worker calls `resolveAuth`, and every
   * worker reads the same admin key and the same signing key from it rather than generating one.
   */
  | { kind: "init"; index: number; workers: number; config: unknown }
  | HttpHop
  | HttpAbort
  | WsHello
  | WsMessage
  | WsClose
  | WsDrain
  | MetricsAsk
  | Shutdown

/** Everything a worker sends. */
export type FromWorker =
  | ReadyEvent
  | HttpReply
  | HttpOpen
  | HttpChunk
  | HttpEnd
  | WsSend
  | WsTopic
  | WsShut
  | PublishEvent
  | MovedEvent
  | ErrorEvent
  | MetricsReply
  | ShutdownReply

/** Headers as a list of pairs, which is what structured clone takes. */
export function headerPairs(headers: Headers): [string, string][] {
  const out: [string, string][] = []
  headers.forEach((value, key) => out.push([key, value]))
  return out
}

/**
 * The two frames that mint a routing key, found without parsing every frame. A `tx.begin` reply
 * carries `"tx":"…"` and a `subscribe` reply carries `"sub":"…"` beside `"ok":true`; a change or
 * live event carries `"sub"` too, but never `"ok"`, so the guard is exact rather than merely
 * cheap.
 */
export function bindingsOf(text: string): { tx?: string; sub?: string } | undefined {
  if (!text.includes('"ok":true')) return undefined
  const tx = /"tx":"([^"]+)"/.exec(text)
  const sub = /"sub":"([^"]+)"/.exec(text)
  if (!tx && !sub) return undefined
  return { ...(tx ? { tx: tx[1] as string } : {}), ...(sub ? { sub: sub[1] as string } : {}) }
}
