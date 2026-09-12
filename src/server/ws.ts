// Invariant: requests naming one database are answered in the order they arrived, and requests
// naming different databases may interleave. Each database gets a promise chain on the socket;
// almost everything on it resolves synchronously, so the chain only actually delays the one case
// that has to wait — a `minTxid` that has not landed yet.
//
// Second invariant: a change event is never dropped. Change fan-out goes through Bun's own
// pub/sub (`ws.subscribe` / `server.publish`), where the payload is identical for every
// subscriber and Bun owns the buffering; live-query results are per-subscription, sent directly,
// and *are* dropped under backpressure — the latest result is kept and sent on `drain`, because a
// superseded result is worth nothing (design §7).
//
// Every subscription id on this socket is the topic it came from. That is what makes the
// published frame identical for every subscriber: `{"sub":"db:acme:changes:users",…}` is the same
// bytes for everyone, so Bun can fan it out without touching JavaScript per socket.

import {
  WS_PROTOCOL,
  type Args,
  type BatchRequest,
  type QueryRequest,
  type StatementRequest,
  type WsRequest,
} from "../client/protocol.ts"
import {
  changesTopic,
  liveTopic,
  schemaTopic,
  tableTopic,
  type LiveEvent,
  type Publisher,
} from "../realtime/index.ts"
import type { Principal } from "./auth.ts"
import { requireScope } from "./auth.ts"
import { BunQLError, mapError } from "./errors.ts"
import {
  assertStatement,
  awaitTxid,
  executeBatch,
  executeInTx,
  executeStatement,
  failedIndexOf,
  resolveOptions,
} from "./exec.ts"
import { mapTenantError, type ServerRuntime, type TxSession } from "./runtime.ts"

interface Subscription {
  kind: "changes" | "live"
  db: string
  /** Topics this subscription put the socket on; all of them answer to its id. */
  topics: string[]
  /** The id the tenant's realtime engine knows it by. */
  engineSub: string
}

export interface SocketData {
  runtime: ServerRuntime
  principal: Principal | null
  /** Identity for the transactions this socket opened, so closing rolls them back. */
  owner: object
  subs: Map<string, Subscription>
  queues: Map<string, Promise<unknown>>
  /** Latest undelivered live result per subscription, kept while the socket is backpressured. */
  pendingLive: Map<string, string>
}

/** What this module needs from `Bun.serve`'s socket. */
export interface Socket {
  data: SocketData
  readyState: number
  send(data: string): number
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  close(code?: number, reason?: string): void
}

/**
 * Wraps `server.publish` so a realtime payload reaches the wire already inside its envelope. The
 * payload arrives as JSON text, so the envelope is built by concatenation rather than by parsing
 * it back into an object and re-serialising it.
 *
 * Live topics are skipped: those results are per-subscription and go out with `ws.send`, so
 * publishing them would be a second copy nobody is subscribed to.
 */
export function busPublisher(server: { publish(topic: string, data: string): unknown }): Publisher {
  return {
    publish(topic: string, data: string): unknown {
      if (topic.includes(":live:")) return 0
      const event = topic.endsWith(":schema") ? "schema" : "change"
      return server.publish(
        topic,
        `{"sub":${JSON.stringify(topic)},"event":"${event}","data":${data}}`,
      )
    },
  }
}

export function newSocketData(runtime: ServerRuntime, principal: Principal | null): SocketData {
  return {
    runtime,
    principal,
    owner: {},
    subs: new Map(),
    queues: new Map(),
    pendingLive: new Map(),
  }
}

function send(ws: Socket, value: unknown): number {
  return ws.send(JSON.stringify(value))
}

function replyError(ws: Socket, id: number | undefined, err: unknown): void {
  const { body } = mapError(err, { failedIndex: failedIndexOf(err) })
  send(ws, id === undefined ? { ok: false, error: body.error } : { id, ok: false, error: body.error })
}

function principalOf(ws: Socket): Principal {
  const principal = ws.data.principal
  if (!principal) {
    throw BunQLError.unauthenticated("send a hello message with a token before anything else")
  }
  return principal
}

/**
 * Runs `fn` after everything already queued for `db`. The chain is dropped once it drains, so a
 * socket that talks to a thousand databases does not keep a thousand settled promises alive.
 */
function enqueue(ws: Socket, db: string, id: number | undefined, fn: () => unknown): void {
  const queues = ws.data.queues
  const previous = queues.get(db) ?? Promise.resolve()
  const next = previous.then(
    async () => {
      try {
        await fn()
      } catch (err) {
        replyError(ws, id, err)
      }
    },
    () => {},
  )
  queues.set(db, next)
  void next.then(() => {
    if (queues.get(db) === next) queues.delete(db)
  })
}

export function greet(ws: Socket, node: string): void {
  send(ws, { event: "hello", protocol: WS_PROTOCOL, node, role: "primary" })
}

/** Entry point for one client frame. */
export async function handleMessage(ws: Socket, raw: string | Buffer): Promise<void> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  let message: WsRequest
  try {
    message = JSON.parse(text) as WsRequest
  } catch {
    replyError(ws, undefined, BunQLError.badRequest("frame is not valid JSON"))
    return
  }
  if (!message || typeof message !== "object" || typeof message.op !== "string") {
    replyError(ws, undefined, BunQLError.badRequest("every frame needs an op"))
    return
  }
  ws.data.runtime.metrics.wsMessage()
  const id = (message as { id?: number }).id

  try {
    switch (message.op) {
      case "hello":
        await hello(ws, message)
        return
      case "ping":
        send(ws, id === undefined ? { event: "pong" } : { id, ok: true })
        return
      case "query":
      case "batch": {
        const db = databaseOf(ws, message)
        enqueue(ws, db, id, () => statement(ws, message as QueryRequest & WsAny, db))
        return
      }
      case "tx.begin": {
        const db = (message as { db?: string }).db
        if (!db) throw BunQLError.badRequest("tx.begin needs a db")
        enqueue(ws, db, id, () => txBegin(ws, message as WsAny, db))
        return
      }
      case "tx.commit":
      case "tx.rollback": {
        const session = sessionOf(ws, message as WsAny)
        enqueue(ws, session.db, id, () =>
          txEnd(ws, message as WsAny, session, message.op === "tx.commit" ? "commit" : "rollback"),
        )
        return
      }
      case "subscribe": {
        const db = (message as { db?: string }).db
        if (!db) throw BunQLError.badRequest("subscribe needs a db")
        enqueue(ws, db, id, () => subscribe(ws, message as WsAny, db))
        return
      }
      case "unsubscribe":
        unsubscribe(ws, message as WsAny)
        return
      default:
        throw BunQLError.badRequest(`unknown op ${JSON.stringify((message as WsAny).op)}`)
    }
  } catch (err) {
    replyError(ws, id, err)
  }
}

/** Loose view of a client frame; each handler validates the fields it needs. */
interface WsAny {
  id?: number
  op: string
  db?: string
  tx?: string
  sub?: string
  token?: string
  sql?: string
  args?: Args
  atomic?: boolean
  statements?: StatementRequest[]
  mode?: "deferred" | "immediate" | "exclusive"
  kind?: "changes" | "live"
  tables?: string[]
  since?: number
  include?: "none" | "pk" | "row" | "row+old"
  key?: string
  rows?: "array" | "object"
  maxRows?: number
}

async function hello(ws: Socket, message: WsAny): Promise<void> {
  const runtime = ws.data.runtime
  if (message.token) {
    ws.data.principal = await runtime.auth.authenticateToken(message.token)
  } else if (!ws.data.principal) {
    throw BunQLError.unauthenticated("hello needs a token on a socket that had none")
  }
  if (message.id !== undefined) send(ws, { id: message.id, ok: true })
  greet(ws, runtime.node)
}

function databaseOf(ws: Socket, message: WsRequest): string {
  const any = message as WsAny
  if (any.tx) return sessionOf(ws, any).db
  if (any.db) return any.db
  throw BunQLError.badRequest(`${any.op} needs a db or a tx`)
}

function sessionOf(ws: Socket, message: WsAny): TxSession {
  if (!message.tx) throw BunQLError.badRequest(`${message.op} needs a tx`)
  const session = ws.data.runtime.txSession(message.tx)
  if (session.owner !== null && session.owner !== ws.data.owner) {
    throw BunQLError.notAuthorized("that transaction belongs to another connection")
  }
  return session
}

async function statement(ws: Socket, message: WsAny, db: string): Promise<void> {
  const runtime = ws.data.runtime
  const principal = principalOf(ws)
  const id = message.id as number

  if (message.tx) {
    const session = sessionOf(ws, message)
    requireScope(principal, session.db, "rw")
    const options = resolveOptions(message as QueryRequest, null, runtime.config)
    if (message.op === "batch") {
      const result = runBatch(runtime, session.tenant, principal, message, options, true)
      send(ws, { id, ok: true, result })
      return
    }
    assertStatement(message, "query")
    const result = executeInTx(
      runtime,
      session.tenant,
      principal,
      message as StatementRequest,
      options,
    )
    send(ws, { id, ok: true, result })
    return
  }

  requireScope(principal, db, "ro")
  const tenant = runtime.tenant(db)
  const options = resolveOptions(message as QueryRequest, null, runtime.config)
  await awaitTxid(tenant, options)
  try {
    if (message.op === "batch") {
      const result = executeBatch(runtime, tenant, principal, message as BatchRequest, options)
      send(ws, { id, ok: true, result })
      return
    }
    assertStatement(message, "query")
    const { result } = executeStatement(
      runtime,
      tenant,
      principal,
      message as StatementRequest,
      options,
    )
    send(ws, { id, ok: true, result })
  } catch (err) {
    throw mapTenantError(err)
  }
}

/** A batch inside an open transaction: each statement runs on the writer the baton already holds. */
function runBatch(
  runtime: ServerRuntime,
  tenant: TxSession["tenant"],
  principal: Principal,
  message: WsAny,
  options: ReturnType<typeof resolveOptions>,
  inTx: boolean,
): { results: unknown[]; txid: number } {
  if (!inTx) throw BunQLError.badRequest("batch outside a transaction takes the normal path")
  const statements = message.statements
  if (!Array.isArray(statements) || statements.length === 0) {
    throw BunQLError.badRequest("batch needs a non-empty statements array")
  }
  const results = statements.map((statement, index) => {
    try {
      return executeInTx(runtime, tenant, principal, assertStatement(statement, `statements[${index}]`), options)
    } catch (err) {
      throw mapTenantError(err)
    }
  })
  return { results, txid: Number(tenant.txid) }
}

function txBegin(ws: Socket, message: WsAny, db: string): void {
  const runtime = ws.data.runtime
  const principal = principalOf(ws)
  requireScope(principal, db, "rw")
  const tenant = runtime.tenant(db)
  try {
    const session = runtime.beginTx(tenant, principal, {
      ...(message.mode ? { mode: message.mode } : {}),
      ...(message.rows ? { rows: message.rows } : {}),
      owner: ws.data.owner,
    })
    send(ws, {
      id: message.id,
      ok: true,
      tx: session.baton,
      expiresInMs: runtime.config.limits.txIdleTimeoutMs,
    })
  } catch (err) {
    throw mapTenantError(err)
  }
}

function txEnd(ws: Socket, message: WsAny, session: TxSession, how: "commit" | "rollback"): void {
  const principal = principalOf(ws)
  requireScope(principal, session.db, "rw")
  try {
    const txid = ws.data.runtime.endTx(session, how)
    send(ws, { id: message.id, ok: true, txid: Number(txid) })
  } catch (err) {
    throw mapTenantError(err)
  }
}

// ── subscriptions (design §7) ──────────────────────────────────────────────────────────────────

function subscribe(ws: Socket, message: WsAny, db: string): void {
  const runtime = ws.data.runtime
  const principal = principalOf(ws)
  requireScope(principal, db, "ro")
  const tenant = runtime.tenant(db)
  if (message.kind === "live") {
    subscribeLive(ws, message, tenant)
    return
  }
  if (message.kind !== undefined && message.kind !== "changes") {
    throw BunQLError.badRequest(`subscribe kind must be "changes" or "live"`)
  }
  subscribeChanges(ws, message, tenant)
}

function subscribeChanges(ws: Socket, message: WsAny, tenant: TxSession["tenant"]): void {
  const runtime = ws.data.runtime
  const db = tenant.name
  runtime.retain(db)
  let realtime: ReturnType<ServerRuntime["realtimeFor"]>
  let engineSub: string
  let backlog: ReturnType<
    ReturnType<ServerRuntime["realtimeFor"]>["subscribeChanges"]
  >
  try {
    realtime = runtime.realtimeFor(tenant)
    // The listener is deliberately empty: this socket is fed by `server.publish` on the topics
    // below. Subscribing here is what keeps the capture level and the ring backlog correct.
    backlog = realtime.subscribeChanges(
      {
        ...(message.tables?.length ? { tables: message.tables } : {}),
        ...(message.since !== undefined ? { since: message.since } : {}),
        include: message.include ?? "pk",
      },
      () => {},
    )
    engineSub = backlog.sub
  } catch (err) {
    runtime.releaseSubscription(db)
    throw err
  }

  const topics = message.tables?.length
    ? message.tables.map((table) => tableTopic(db, table))
    : [changesTopic(db), schemaTopic(db)]
  for (const topic of topics) ws.subscribe(topic)
  const id = topics[0] as string
  ws.data.subs.set(id, { kind: "changes", db, topics, engineSub })
  runtime.metrics.subscribed("changes")

  send(ws, { id: message.id, ok: true, sub: id, subs: topics })
  if (backlog.reset) {
    send(ws, {
      sub: id,
      event: "reset",
      data: { txid: Number(tenant.txid), reason: "the change ring no longer holds that position" },
    })
  }
  for (const event of backlog.backlog) send(ws, { sub: id, event: "change", data: event })
}

function subscribeLive(ws: Socket, message: WsAny, tenant: TxSession["tenant"]): void {
  const runtime = ws.data.runtime
  const principal = principalOf(ws)
  const db = tenant.name
  if (!message.sql) throw BunQLError.badRequest("a live subscription needs sql")
  const rows = message.rows === "object" ? "object" : "array"
  runtime.retain(db)
  // The engine publishes the first result from inside `subscribeLive`, before the subscription id
  // exists, so early events are held until there is an id to stamp them with — and until the
  // `ok` reply has gone out, which is the order a client is entitled to see.
  const early: LiveEvent[] = []
  let id = ""
  try {
    const realtime = runtime.realtimeFor(tenant)
    const subscription = realtime.subscribeLive(
      {
        sql: message.sql,
        ...(message.args !== undefined ? { args: message.args } : {}),
        ...(message.key !== undefined ? { key: message.key } : {}),
        ...(message.maxRows !== undefined ? { maxRows: message.maxRows } : {}),
        principalRunner: runtime.liveRunner(tenant, principal, rows),
      },
      (event) => {
        if (id === "") early.push(event)
        else pushLive(ws, id, event)
      },
    )
    id = liveTopic(db, subscription.sub)
    ws.data.subs.set(id, { kind: "live", db, topics: [], engineSub: subscription.sub })
    runtime.metrics.subscribed("live")
    send(ws, { id: message.id, ok: true, sub: id })
    for (const event of early) pushLive(ws, id, event)
    early.length = 0
  } catch (err) {
    if (id) ws.data.subs.delete(id)
    runtime.releaseSubscription(db)
    throw err
  }
}

/**
 * A live result, dropped when the socket is behind. Design §7: intermediate results are dropped
 * and the latest is kept, because a result the client has not read yet is already stale.
 */
function pushLive(ws: Socket, id: string, event: LiveEvent): void {
  const frame = JSON.stringify({
    sub: id,
    event: "columns" in event ? "rows" : "diff",
    data: event,
  })
  if (ws.data.pendingLive.size > 0) {
    ws.data.pendingLive.set(id, frame)
    return
  }
  const sent = ws.send(frame)
  if (sent > 0) return
  ws.data.pendingLive.set(id, frame)
  ws.data.runtime.metrics.droppedLiveResult()
}

/** Bun calls this when the socket's buffer has room again. */
export function drain(ws: Socket): void {
  const pending = ws.data.pendingLive
  if (pending.size === 0) return
  for (const [id, frame] of [...pending]) {
    const sent = ws.send(frame)
    if (sent <= 0) return
    pending.delete(id)
  }
}

function unsubscribe(ws: Socket, message: WsAny): void {
  const id = message.sub
  if (!id) throw BunQLError.badRequest("unsubscribe needs a sub")
  const removed = dropSubscription(ws, id)
  if (!removed) throw BunQLError.badRequest(`no such subscription ${JSON.stringify(id)}`)
  if (message.id !== undefined) send(ws, { id: message.id, ok: true })
}

function dropSubscription(ws: Socket, id: string): boolean {
  const subscription = ws.data.subs.get(id)
  if (!subscription) return false
  ws.data.subs.delete(id)
  ws.data.pendingLive.delete(id)
  for (const topic of subscription.topics) ws.unsubscribe(topic)
  const runtime = ws.data.runtime
  runtime.realtimeOf(subscription.db)?.unsubscribe(subscription.engineSub)
  runtime.metrics.unsubscribed(subscription.kind)
  runtime.releaseSubscription(subscription.db)
  return true
}

/** Everything a closed socket leaves behind: subscriptions, and any transaction it still holds. */
export function closeSocket(ws: Socket): void {
  for (const id of [...ws.data.subs.keys()]) dropSubscription(ws, id)
  ws.data.pendingLive.clear()
  ws.data.queues.clear()
  ws.data.runtime.rollbackOwned(ws.data.owner)
  ws.data.runtime.metrics.wsClosed()
}
