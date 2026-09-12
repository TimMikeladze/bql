// Invariant: every handler here resolves the principal before it touches a tenant, and the
// tenant before it reads the body. A request that is not allowed to see a database must not be
// able to tell whether it exists, and a request with a malformed body must not have opened a
// connection to find that out.
//
// Handlers return a `Response`; the four `BunQL-*` headers, CORS and the metrics tick are added
// once by the wrapper in `app.ts`, so nothing below repeats them.
//
// Second invariant: a route that mutates the database set or the bytes of a database runs on a
// primary only. `requirePrimary` is that gate, and it sits after the admin check so a request
// without the key learns nothing about the node's role. Reads, token minting and the node-local
// maintenance routes (`snapshot`, `checkpoint`) deliberately stay open on a replica.
//
// Third invariant (C2): the gate reads the **live** role for the database in the request, not a
// field copied out of the config at startup. A node promoted at runtime serves its own lifecycle
// routes; a node fenced at runtime stops serving them, in the same request. `runtime.roleFor(db)`
// is the only answer, and `POST /v1/db` — which names no database — is the one case that asks the
// node-level `runtime.role` instead.

import path from "node:path"
import {
  HEADERS,
  type Args,
  type BatchRequest,
  type ChangeEvent,
  type LiveDiffEvent,
  type LiveRowsEvent,
  type QueryRequest,
  type RequestOptions,
  type StatementRequest,
  type TxBeginRequest,
} from "../client/protocol.ts"
import type { IncludeLevel, LiveEvent } from "../realtime/index.ts"
import {
  listGenerations,
  readManifest,
  RestoreError,
  type RestoreTarget,
  restoreIntoCatalog,
  S3Store,
  type ShipperState,
  verifyBucket,
} from "../storage/index.ts"
import { assertValidName, type Tenant } from "../tenant/index.ts"
import { listSnapshots } from "../wal/index.ts"
import {
  type Principal,
  type Scope,
  requireScope,
  type TableScope,
  type TokenGrant,
} from "./auth.ts"
import { BunQLError } from "./errors.ts"
import {
  assertStatement,
  awaitTxid,
  executeBatch,
  executeInTx,
  executeStatement,
  executeStatementQueued,
  resolveOptions,
} from "./exec.ts"
import { type ReplicationMetrics, type StorageMetrics } from "./metrics.ts"
import { mapTenantError, type ServerRuntime } from "./runtime.ts"
import { openSse, resumeFrom, type TimeoutHost } from "./sse.ts"

/** What a route handler is handed. `txid` is filled in so the wrapper can stamp the header. */
export interface RouteContext {
  runtime: ServerRuntime
  request: Request
  server: TimeoutHost
  url: URL
  params: Record<string, string>
  txid?: number
  /** Set on an SSE response so the wrapper leaves it unbuffered and uncompressed. */
  streaming?: boolean
}

export type Handler = (ctx: RouteContext) => Response | Promise<Response>

/** The four bytes every SQLite file starts with, which is all `import` can cheaply verify. */
const SQLITE_MAGIC = "SQLite format 3\0"

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

async function readJson<T>(ctx: RouteContext, max: number): Promise<T> {
  const declared = Number(ctx.request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > max) {
    throw new BunQLError("PAYLOAD_TOO_LARGE", `body is larger than ${max} bytes`, 413)
  }
  const text = await ctx.request.text()
  if (text.length > max) {
    throw new BunQLError("PAYLOAD_TOO_LARGE", `body is larger than ${max} bytes`, 413)
  }
  if (text.length === 0) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw BunQLError.badRequest("request body is not valid JSON")
  }
}

/** The principal behind the request, from `Authorization` or `?token=` (design §6.4). */
function principalOf(ctx: RouteContext): Promise<Principal> {
  return ctx.runtime.auth.authenticate(ctx.request)
}

function requireAdmin(principal: Principal): void {
  if (principal.kind !== "admin") {
    throw BunQLError.notAuthorized("this route needs the admin key")
  }
}

/**
 * Refuses an admin write on a replica. The lifecycle routes act on this node's own files, and on
 * a replica those files are a copy the primary owns: a create here is a database the cluster
 * never hears about, and a delete here removes the copy the applier needs — the replica then
 * stops following that database for good, because it does not re-bootstrap and later commits on
 * the primary have nowhere to land.
 *
 * Refusing rather than forwarding is deliberate. A forwarded create would still have to come back
 * over the replication stream to exist here, so the round trip buys nothing the operator cannot
 * get by addressing the primary; and a delete has no safe forwarding story at all while promotion
 * does not exist. The shape is the one statement writes already answer with when forwarding is
 * off — `503 NOT_PRIMARY` plus `BunQL-Primary` — so a client that follows that header already
 * knows what to do with this.
 *
 * Node-local maintenance (`snapshot`, `checkpoint`) and every read route stay open: they act on
 * the replica's copy on purpose.
 */
function requirePrimary(ctx: RouteContext): void {
  if (ctx.runtime.role !== "replica") return
  throw BunQLError.notPrimary(ctx.runtime.primaryUrl ?? undefined)
}

/** The same gate for a route that names a database, against that database's live role. */
function requirePrimaryFor(ctx: RouteContext, db: string): void {
  if (ctx.runtime.roleFor(db) !== "replica") return
  throw BunQLError.notPrimary(ctx.runtime.primaryUrlFor(db) ?? undefined)
}

/**
 * Where a write this node will not take should go, for whichever database the request names. A
 * request that names none — `POST /v1/db` — gets the node's own answer.
 */
function primaryOf(ctx: RouteContext): string | null {
  let db: string
  try {
    db = dbName(ctx)
  } catch {
    return ctx.runtime.primaryUrl
  }
  return ctx.runtime.primaryUrlFor(db)
}

/** Database name from the path, or from the first `Host` label when `tenantFromHost` is on. */
export function dbName(ctx: RouteContext): string {
  const fromPath = ctx.params.db
  if (fromPath) return fromPath
  if (ctx.runtime.config.server.tenantFromHost) {
    const namespace = ctx.request.headers.get("x-namespace")
    if (namespace) return namespace
    const host = ctx.url.hostname
    const label = host.split(".")[0]
    if (label && label !== host) return label
  }
  throw BunQLError.badRequest("no database in the request")
}

/** Resolves the principal, checks its scope on the database, and opens the tenant. */
async function open(
  ctx: RouteContext,
  need: Scope,
): Promise<{ principal: Principal; tenant: Tenant; name: string }> {
  const principal = await principalOf(ctx)
  const name = dbName(ctx)
  requireScope(principal, name, need)
  const tenant = ctx.runtime.tenant(name)
  ctx.txid = Number(tenant.txid)
  return { principal, tenant, name }
}

// ── statements (design §6.1, §6.2, §6.3) ───────────────────────────────────────────────────────

export const query: Handler = async (ctx) => {
  const { principal, tenant } = await open(ctx, "ro")
  const body = await readJson<QueryRequest>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  assertStatement(body, "request")
  const options = resolveOptions(body, ctx.request.headers, ctx.runtime.config)
  await awaitTxid(tenant, options)
  const runtime = ctx.runtime
  try {
    // On a replica, a statement SQLite calls a write goes to the primary and comes back with its
    // result; a read never leaves this node (R2, design §5.2).
    if (runtime.forwarder.needsPrimary(tenant, principal, [body.sql])) {
      const forwarded = await runtime.forwarder.query(tenant, principal, body, options)
      ctx.txid = forwarded.txid
      return json(forwarded)
    }
    const { result, kind } = await executeStatementQueued(runtime, tenant, principal, body, options)
    ctx.txid = result.txid
    if (kind === "write") await runtime.awaitDurable(tenant.name, BigInt(result.txid), options.ack)
    return json(result)
  } catch (err) {
    throw mapTenantError(err, runtime.primaryUrlFor(tenant.name))
  }
}

export const batch: Handler = async (ctx) => {
  const { principal, tenant } = await open(ctx, "ro")
  const body = await readJson<BatchRequest>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const options = resolveOptions(body, ctx.request.headers, ctx.runtime.config)
  await awaitTxid(tenant, options)
  const runtime = ctx.runtime
  try {
    if (runtime.forwarder.enabledFor(tenant.name) && batchNeedsPrimary(runtime, tenant, principal, body)) {
      const forwarded = await runtime.forwarder.batch(tenant, principal, body, options)
      ctx.txid = forwarded.txid
      return json(forwarded)
    }
    const result = executeBatch(runtime, tenant, principal, body, options)
    ctx.txid = result.txid
    await runtime.awaitDurable(tenant.name, BigInt(result.txid), options.ack)
    return json(result)
  } catch (err) {
    throw mapTenantError(err, runtime.primaryUrlFor(tenant.name))
  }
}

/**
 * Whether a batch has to go to the primary. An `atomic` batch is one `BEGIN IMMEDIATE` whatever
 * it contains, so it always does; a non-atomic one only when a statement in it writes.
 */
function batchNeedsPrimary(
  runtime: ServerRuntime,
  tenant: Tenant,
  principal: Principal,
  body: BatchRequest,
): boolean {
  const statements = body.statements
  if (!Array.isArray(statements) || statements.length === 0) return false
  for (let i = 0; i < statements.length; i++) assertStatement(statements[i], `statements[${i}]`)
  if (body.atomic !== false) return true
  return runtime.forwarder.needsPrimary(
    tenant,
    principal,
    statements.map((one) => (one as StatementRequest).sql),
  )
}

export const txBegin: Handler = async (ctx) => {
  const { principal, tenant } = await open(ctx, "rw")
  const body = await readJson<TxBeginRequest>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  try {
    // An interactive transaction is a write that arrives in parts, so on a replica the whole
    // baton lifecycle lives on the primary and this node only holds the mapping.
    if (ctx.runtime.forwarder.enabledFor(tenant.name)) {
      const remote = await ctx.runtime.forwarder.txBegin(tenant, principal, body, null)
      return json(remote)
    }
    const session = await ctx.runtime.beginTxQueued(tenant, principal, {
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.rows ? { rows: body.rows } : {}),
    })
    return json({ tx: session.baton, expiresInMs: ctx.runtime.config.limits.txIdleTimeoutMs })
  } catch (err) {
    const mapped = mapTenantError(err, ctx.runtime.primaryUrlFor(tenant.name))
    if (mapped instanceof BunQLError && mapped.code === "TX_BUSY") {
      return json(
        {
          error: {
            code: "TX_BUSY",
            message: mapped.message,
            status: 409,
            txid: Number(tenant.txid),
          },
        },
        409,
        { "retry-after": "1" },
      )
    }
    throw mapped
  }
}

/** A statement inside a baton transaction. The baton alone identifies the database. */
export const txQuery: Handler = async (ctx) => {
  const principal = await principalOf(ctx)
  const baton = ctx.params.tx as string
  const remote = ctx.runtime.forwarder.remoteTx(baton)
  if (remote) {
    const body = await readJson<QueryRequest>(ctx, ctx.runtime.config.limits.maxBodyBytes)
    assertStatement(body, "request")
    const result = await ctx.runtime.forwarder.txExec(remote, principal, body)
    ctx.txid = result.txid
    return json(result)
  }
  const session = ctx.runtime.txSession(baton)
  requireScope(principal, session.db, "rw")
  ctx.txid = Number(session.tenant.txid)
  const body = await readJson<QueryRequest>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  assertStatement(body, "request")
  const options = resolveOptions(
    { rows: session.rowsMode, ...body },
    ctx.request.headers,
    ctx.runtime.config,
  )
  try {
    const result = executeInTx(ctx.runtime, session.tenant, principal, body, options)
    ctx.txid = result.txid
    return json(result)
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

function endTx(how: "commit" | "rollback"): Handler {
  return async (ctx) => {
    const principal = await principalOf(ctx)
    const baton = ctx.params.tx as string
    const remote = ctx.runtime.forwarder.remoteTx(baton)
    if (remote) {
      const answer = await ctx.runtime.forwarder.txEnd(remote, principal, how)
      ctx.txid = answer.txid
      return json(answer)
    }
    const session = ctx.runtime.txSession(baton)
    requireScope(principal, session.db, "rw")
    try {
      const txid = ctx.runtime.endTx(session, how)
      ctx.txid = Number(txid)
      if (how === "commit") {
        await ctx.runtime.awaitDurable(session.db, txid, ctx.runtime.config.durability.defaultAck)
      }
      return json({ txid: Number(txid) })
    } catch (err) {
      throw mapTenantError(err, primaryOf(ctx))
    }
  }
}

export const txCommit = endTx("commit")
export const txRollback = endTx("rollback")

// ── realtime (design §6.4) ─────────────────────────────────────────────────────────────────────

function tablesParam(url: URL): string[] | undefined {
  const raw = url.searchParams.get("tables")
  if (!raw) return undefined
  const tables = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return tables.length > 0 ? tables : undefined
}

function includeParam(url: URL): IncludeLevel {
  const raw = url.searchParams.get("include")
  if (raw === "row" || raw === "row+old" || raw === "pk" || raw === "none") return raw
  return "pk"
}

/**
 * The change feed. SSE by default; a `wait` parameter turns it into the ElectricSQL-style long
 * poll of design §6.4, which is what an HTTP-only client or a CDN in front of one gets.
 */
export const changes: Handler = async (ctx) => {
  const { tenant, name } = await open(ctx, "ro")
  const since = resumeFrom(ctx.request, ctx.url)
  const tables = tablesParam(ctx.url)
  const include = includeParam(ctx.url)
  const wait = ctx.url.searchParams.get("wait")
  // `wait` is the switch (design §6.4: "the same feed without SSE"). `Accept` only decides the
  // case where the client asked for JSON and nothing else — a plain `*/*`, which is what every
  // command-line client sends, still gets the stream.
  const accept = ctx.request.headers.get("accept") ?? ""
  const wantsJson = accept.includes("application/json") && !accept.includes("text/event-stream")
  const wantsSse = wait === null && !wantsJson

  const runtime = ctx.runtime
  runtime.retain(name)
  let realtime: ReturnType<ServerRuntime["realtimeFor"]>
  try {
    realtime = runtime.realtimeFor(tenant)
  } catch (err) {
    runtime.releaseSubscription(name)
    throw err
  }

  if (!wantsSse) {
    // Long poll: an immutable, cacheable answer for a `since` in the past, and a wait on the tail.
    try {
      const waitMs = Math.max(0, Math.min(Number(wait) || 0, 60_000))
      const events = await longPoll(realtime, since ?? Number(tenant.txid), tables, waitMs)
      ctx.txid = Number(tenant.txid)
      const historical = events.length > 0
      return json(events, 200, {
        [HEADERS.txid]: String(tenant.txid),
        "cache-control": historical ? "public, max-age=31536000, immutable" : "no-store",
      })
    } finally {
      runtime.releaseSubscription(name)
    }
  }

  // The stream is opened before the subscription, because the engine can call the listener while
  // `subscribeChanges` is still running and because an abort can fire the moment it exists.
  let engineSub: string | null = null
  const stream = openSse(ctx.server, {
    request: ctx.request,
    onClose: () => {
      if (engineSub) realtime.unsubscribe(engineSub)
      runtime.metrics.unsubscribed("changes")
      runtime.metrics.sseClosed()
      runtime.releaseSubscription(name)
    },
  })
  runtime.metrics.subscribed("changes")
  runtime.metrics.sseOpened()

  let subscription: ReturnType<typeof realtime.subscribeChanges>
  try {
    subscription = realtime.subscribeChanges(
      {
        ...(tables ? { tables } : {}),
        ...(since !== undefined ? { since } : {}),
        include,
      },
      (event) => {
        stream.send("change", event, event.txid)
      },
    )
  } catch (err) {
    stream.close()
    throw err
  }
  engineSub = subscription.sub

  if (subscription.reset) {
    stream.send("reset", {
      txid: Number(tenant.txid),
      reason: "the change ring no longer holds that position",
    })
  }
  for (const event of subscription.backlog) stream.send("change", event, event.txid)
  ctx.streaming = true
  ctx.txid = Number(tenant.txid)
  return stream.response({ [HEADERS.txid]: String(tenant.txid) })
}

/** Resolves with the events after `since`, waiting up to `waitMs` for the first one. */
function longPoll(
  realtime: ReturnType<ServerRuntime["realtimeFor"]>,
  since: number,
  tables: string[] | undefined,
  waitMs: number,
): Promise<ChangeEvent[]> {
  const replay = realtime.ring.since(since)
  if (replay === "reset") {
    throw BunQLError.resetRequired(`the change ring no longer holds txid ${since}`)
  }
  const filtered = tables ? filterTables(replay, tables) : replay
  if (filtered.length > 0 || waitMs === 0) return Promise.resolve(filtered)

  return new Promise<ChangeEvent[]>((resolve) => {
    const collected: ChangeEvent[] = []
    const subscription = realtime.subscribeChanges(
      { ...(tables ? { tables } : {}), include: "pk" },
      (event) => {
        collected.push(event)
        finish()
      },
    )
    const timer = setTimeout(finish, waitMs)
    timer.unref?.()
    let done = false
    function finish(): void {
      if (done) return
      done = true
      clearTimeout(timer)
      realtime.unsubscribe(subscription.sub)
      resolve(collected)
    }
  })
}

function filterTables(events: ChangeEvent[], tables: string[]): ChangeEvent[] {
  const wanted = new Set(tables)
  const out: ChangeEvent[] = []
  for (const event of events) {
    const changes = event.changes.filter((c) => wanted.has(c.table))
    if (changes.length > 0) out.push({ txid: event.txid, changes })
  }
  return out
}

function liveEventName(event: LiveEvent): "rows" | "diff" {
  return "columns" in (event as LiveRowsEvent) ? "rows" : "diff"
}

export const live: Handler = async (ctx) => {
  const { principal, tenant, name } = await open(ctx, "ro")
  const sql = ctx.url.searchParams.get("sql")
  if (!sql) throw BunQLError.badRequest("live needs a sql parameter")
  const argsRaw = ctx.url.searchParams.get("args")
  let args: Args | undefined
  if (argsRaw) {
    try {
      args = JSON.parse(argsRaw) as Args
    } catch {
      throw BunQLError.badRequest("args must be a JSON array or object")
    }
  }
  const key = ctx.url.searchParams.get("key") ?? undefined
  const rows = ctx.url.searchParams.get("rows") === "object" ? "object" : "array"
  const maxRowsRaw = Number(ctx.url.searchParams.get("maxRows") ?? "")
  const maxRows = Number.isFinite(maxRowsRaw) && maxRowsRaw > 0 ? Math.floor(maxRowsRaw) : undefined

  const runtime = ctx.runtime
  runtime.retain(name)
  let realtime: ReturnType<ServerRuntime["realtimeFor"]>
  try {
    realtime = runtime.realtimeFor(tenant)
  } catch (err) {
    runtime.releaseSubscription(name)
    throw err
  }

  // The engine publishes the first result from inside `subscribeLive`, so the stream has to exist
  // before the subscription does.
  let engineSub: string | null = null
  const stream = openSse(ctx.server, {
    request: ctx.request,
    onClose: () => {
      if (engineSub) realtime.unsubscribe(engineSub)
      runtime.metrics.unsubscribed("live")
      runtime.metrics.sseClosed()
      runtime.releaseSubscription(name)
    },
  })
  runtime.metrics.subscribed("live")
  runtime.metrics.sseOpened()

  try {
    const subscription = realtime.subscribeLive(
      {
        sql,
        ...(args !== undefined ? { args } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(maxRows !== undefined ? { maxRows } : {}),
        principalRunner: runtime.liveRunner(tenant, principal, rows),
      },
      (event) => {
        stream.send(liveEventName(event), event, event.txid)
      },
    )
    engineSub = subscription.sub
  } catch (err) {
    stream.close()
    throw err
  }
  ctx.streaming = true
  ctx.txid = Number(tenant.txid)
  return stream.response({ [HEADERS.txid]: String(tenant.txid) })
}

// ── lifecycle and admin (design §6.5) ──────────────────────────────────────────────────────────

interface CreateBody {
  name?: string
  from?: { db: string; at?: number | string }
  pageSize?: number
  quotaBytes?: number
}

/** Anything at or after this as a number is a wall clock in milliseconds, not a txid (2001-09-09). */
const TIMESTAMP_FLOOR = 1_000_000_000_000

/**
 * `at` as a txid. Design §6.5 and §9.3 both write it as `txid|timestamp`, so an ISO-8601 string or
 * an epoch-millisecond number is resolved against the tenant's log, whose records each carry a
 * microsecond timestamp. The search is a binary one over dense txids, so it costs a handful of
 * record reads rather than a scan.
 */
function resolveAt(tenant: Tenant, at: number | string): bigint {
  if (typeof at === "number" && Number.isFinite(at) && at < TIMESTAMP_FLOOR) {
    return BigInt(Math.floor(at))
  }
  if (typeof at === "string" && /^\d+$/.test(at.trim())) {
    const value = BigInt(at.trim())
    if (value < BigInt(TIMESTAMP_FLOOR)) return value
    return txidAtTime(tenant, Number(value))
  }
  const ms = typeof at === "number" ? at : Date.parse(at)
  if (!Number.isFinite(ms)) {
    throw BunQLError.badRequest(`at must be a txid or a timestamp, got ${JSON.stringify(at)}`)
  }
  return txidAtTime(tenant, ms)
}

/** The newest txid committed at or before `ms`, or a 400 naming what the log still holds. */
function txidAtTime(tenant: Tenant, ms: number): bigint {
  const targetUs = BigInt(Math.floor(ms)) * 1000n
  let low = tenant.log.firstTxid ?? 1n
  let high = tenant.log.lastTxid
  let best: bigint | null = null
  while (low <= high) {
    const mid = low + (high - low) / 2n
    const record = tenant.log.read(mid)
    if (!record) break
    if (record.timestampUs <= targetUs) {
      best = mid
      low = mid + 1n
    } else {
      high = mid - 1n
    }
  }
  if (best === null) {
    throw BunQLError.badRequest(
      `no transaction at or before ${new Date(ms).toISOString()} is still in the log for ` +
        `${tenant.name}; the oldest it holds is txid ${tenant.log.firstTxid ?? 0n}`,
    )
  }
  return best
}

export const createDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  requirePrimary(ctx)
  const body = await readJson<CreateBody>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  if (typeof body.name !== "string") throw BunQLError.badRequest("create needs a name")
  assertValidName(body.name)
  try {
    const tenant = await ctx.runtime.registry.create(body.name, {
      ...(body.pageSize !== undefined ? { pageSize: body.pageSize } : {}),
      ...(body.quotaBytes !== undefined ? { quotaBytes: body.quotaBytes } : {}),
      ...(body.from
        ? {
            from: {
              db: body.from.db,
              ...(body.from.at !== undefined
                ? { at: resolveAt(ctx.runtime.tenant(body.from.db), body.from.at) }
                : {}),
            },
          }
        : {}),
    })
    // In a cluster the database is not writable until this node holds its lease, and the claim is
    // what makes the cluster *know* the database at all — so a create that returned before the
    // grant committed would be followed by a `503 NOT_PRIMARY` on the caller's very next
    // statement. Bounded by the control plane's own propose timeout.
    await ctx.runtime.promoter.ensureLease(tenant.name)
    ctx.txid = Number(tenant.txid)
    return json(statsOf(ctx.runtime, tenant), 201)
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

export const listDbs: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const rows = ctx.runtime.registry.list()
  const openNames = new Set(ctx.runtime.registry.openNames)
  return json({
    databases: rows.map((row) => {
      // The catalog position is throttled (docs/m4-tenant.md), so an open tenant is asked
      // directly rather than reported as of the last save.
      const isOpen = openNames.has(row.name)
      const txid = isOpen ? ctx.runtime.tenant(row.name).txid : row.txid
      return {
        name: row.name,
        createdAtMs: row.createdAtMs,
        pageSize: row.pageSize,
        quotaBytes: row.quotaBytes,
        epoch: row.epoch,
        role: row.role,
        txid: Number(txid),
        open: isOpen,
      }
    }),
  })
}

/** The stats body of design §6.5, also what the embedded API's `stat` returns. */
export function statsOf(runtime: ServerRuntime, tenant: Tenant): Record<string, unknown> {
  const stats = tenant.stats()
  const realtime = runtime.realtimeOf(tenant.name)
  return {
    name: stats.name,
    role: stats.role,
    sizeBytes: stats.sizeBytes,
    walBytes: stats.walBytes,
    logBytes: stats.logBytes,
    txid: Number(stats.txid),
    epoch: stats.epoch,
    checksum: stats.checksum.toString(),
    openConns: stats.openReaders + 1,
    liveQueries: realtime?.live.size ?? 0,
    subscribers: realtime?.subscriberCount ?? 0,
    lastSnapshotTxid: stats.lastSnapshotTxid === null ? null : Number(stats.lastSnapshotTxid),
    // `GET /v1/db/:db/replication` is where a replica list belongs; this stays for compatibility.
    replicas: (runtime.replication?.replicasOf(tenant.name) ?? []).map((replica) => ({
      node: replica.node,
      txid: replica.txid,
      lag: replica.lag,
    })),
  }
}

export const statDb: Handler = async (ctx) => {
  const { tenant } = await open(ctx, "ro")
  return json(statsOf(ctx.runtime, tenant))
}

export const deleteDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  requirePrimaryFor(ctx, name)
  if (!ctx.runtime.registry.has(name)) throw BunQLError.dbNotFound(name)
  ctx.runtime.evict(name)
  try {
    const trash = ctx.runtime.registry.delete(name)
    return json({ name, deleted: true, trash })
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

export const snapshotDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const tenant = ctx.runtime.tenant(dbName(ctx))
  try {
    const ref = await tenant.snapshot()
    ctx.txid = Number(tenant.txid)
    return json({
      snapshotId: path.basename(ref.path),
      txid: Number(ref.txid),
      bytes: ref.bytes,
      checksum: ref.checksum,
      createdAtMs: ref.createdAtMs,
    })
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

interface RestoreBody {
  at?: number | string
  into?: string
  /** `"s3"` restores from the bucket; anything else (or absent) restores from the local log. */
  from?: string
  /** Override the configured bucket and prefix, so one node can restore another node's backup. */
  bucket?: string
  prefix?: string
  generation?: string
}

/**
 * Point-in-time restore, from the local log or from the bucket. Always into a *new* database: the
 * log and the snapshots behind this one still describe the timeline it actually had, and rewinding
 * a database in place would leave the log holding records that no longer apply to it. Design
 * §6.5's CLI example restores with `--into` for the same reason.
 */
export const restoreDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  requirePrimaryFor(ctx, name)
  const body = await readJson<RestoreBody>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  if (body.from === "s3") return await restoreFromS3(ctx, name, body)

  const tenant = ctx.runtime.tenant(name)
  const at = body.at === undefined ? tenant.txid : resolveAt(tenant, body.at)
  if (at <= 0n) throw BunQLError.badRequest("restore needs a positive txid in `at`")
  const into = body.into ?? `${name}-restore-${at}`.slice(0, 64)
  assertValidName(into)
  try {
    const created = await ctx.runtime.registry.create(into, { from: { db: name, at } })
    await ctx.runtime.promoter.ensureLease(created.name)
    ctx.txid = Number(created.txid)
    return json({ name: into, txid: Number(created.txid), from: name, at: Number(at) }, 201)
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

// ── S3 backup and restore (design §4.4, docs/r3-storage.md) ────────────────────────────────────

/**
 * The store a backup route talks to: the node's own, or one built for the bucket and prefix the
 * request named. The credentials are always the node's — a request never carries any — which is
 * what lets an operator restore a bucket this node does not ship to without handing keys over the
 * wire.
 */
function storeFor(
  ctx: RouteContext,
  body: { bucket?: string; prefix?: string },
): { store: S3Store; prefix: string } {
  const s3 = ctx.runtime.config.s3
  const bucket = body.bucket ?? s3.bucket
  if (!bucket) {
    throw new BunQLError(
      "S3_DISABLED",
      "this node has no [s3] bucket configured, so it has no backups to read",
      503,
    )
  }
  const existing = ctx.runtime.storage
  if (existing && bucket === s3.bucket && (body.prefix === undefined || body.prefix === s3.prefix)) {
    return { store: existing.store, prefix: existing.prefix }
  }
  return {
    store: new S3Store({
      bucket,
      ...(s3.region ? { region: s3.region } : {}),
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      ...(s3.accessKeyId ? { accessKeyId: s3.accessKeyId } : {}),
      ...(s3.secretAccessKey ? { secretAccessKey: s3.secretAccessKey } : {}),
      ...(s3.sessionToken ? { sessionToken: s3.sessionToken } : {}),
      ...(s3.virtualHostedStyle ? { virtualHostedStyle: true } : {}),
      concurrency: s3.concurrency,
      retries: s3.retries,
    }),
    prefix: body.prefix ?? s3.prefix,
  }
}

/** `4812`, `"4812"` or an ISO timestamp — the same spellings the local restore takes. */
function bucketTarget(at: number | string | undefined): RestoreTarget | undefined {
  if (at === undefined) return undefined
  if (typeof at === "number") {
    return Number.isFinite(at) && at < TIMESTAMP_FLOOR
      ? { txid: BigInt(Math.floor(at)) }
      : { timestamp: at }
  }
  const trimmed = at.trim()
  if (/^\d+$/.test(trimmed)) {
    const value = BigInt(trimmed)
    return value < BigInt(TIMESTAMP_FLOOR) ? { txid: value } : { timestamp: Number(value) }
  }
  const ms = Date.parse(trimmed)
  if (!Number.isFinite(ms)) {
    throw BunQLError.badRequest(`at must be a txid or a timestamp, got ${JSON.stringify(at)}`)
  }
  return { timestamp: ms }
}

/** Turns a storage failure into the HTTP shape of design §6.6. */
function mapRestoreError(err: unknown): unknown {
  if (!(err instanceof RestoreError)) return err
  switch (err.code) {
    case "BAD_REQUEST":
      return BunQLError.badRequest(err.message)
    case "CONFLICT":
      return new BunQLError("CONFLICT", err.message, 409)
    case "S3_NO_MANIFEST":
      return new BunQLError("S3_NO_MANIFEST", err.message, 404)
    case "S3_UNREACHABLE":
      return new BunQLError("S3_UNREACHABLE", err.message, 503)
    case "BUSY":
      return BunQLError.busy(err.message)
    default:
      // `S3_INCOMPLETE` and `S3_CORRUPT`: the bucket is not restorable to what was asked for, and
      // the request is what named it, so 400 rather than 500.
      return new BunQLError(err.code, err.message, 400)
  }
}

async function restoreFromS3(
  ctx: RouteContext,
  name: string,
  body: RestoreBody,
): Promise<Response> {
  const { store, prefix } = storeFor(ctx, body)
  const target = bucketTarget(body.at)
  const into = body.into ?? `${name}-restore`.slice(0, 64)
  assertValidName(into)
  try {
    const result = await restoreIntoCatalog({
      store,
      prefix,
      db: name,
      ...(target ? { at: target } : {}),
      ...(body.generation ? { generation: body.generation } : {}),
      dataDir: ctx.runtime.config.data.dir,
      catalog: ctx.runtime.registry.catalog,
      into,
      quotaBytes: ctx.runtime.config.data.quotaBytes,
    })
    const tenant = ctx.runtime.registry.open(into)
    ctx.txid = Number(tenant.txid)
    return json(
      {
        name: into,
        from: name,
        source: "s3",
        bucket: store.describe().bucket,
        prefix,
        generation: result.generation,
        txid: Number(result.txid),
        fromTxid: Number(result.fromTxid),
        applied: result.applied,
        objects: result.objects,
        bytes: result.bytes,
      },
      201,
    )
  } catch (err) {
    throw mapRestoreError(err)
  }
}

/** Shipper state plus what the bucket actually holds. `GET /v1/db/:db/backup`. */
export const backupStatus: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  const s3 = ctx.runtime.config.s3
  const shipper = ctx.runtime.storage?.shipperFor(name) ?? null
  const state = shipper?.state() ?? null
  if (!s3.bucket) {
    return json({ db: name, enabled: false, bucket: null, prefix: null, shipper: null })
  }
  const { store, prefix } = storeFor(ctx, {})
  let manifest: Record<string, unknown> | null = null
  let error: string | null = null
  try {
    const read = await readManifest(store, prefix, name)
    manifest = {
      generation: read.generation,
      shippedTxid: Number(read.shippedTxid),
      updatedAtMs: read.updatedAtMs,
      pageSize: read.pageSize,
      snapshots: read.snapshots.length,
      segments: read.segments.length,
      oldestTxid: Number(read.snapshots[0]?.txid ?? read.segments[0]?.startTxid ?? 0),
      generations: [...read.generations].reverse(),
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  return json({
    db: name,
    enabled: s3.enabled,
    bucket: store.describe().bucket,
    prefix,
    endpoint: store.describe().endpoint,
    retention: s3.retention,
    shipper: state,
    manifest,
    error,
  })
}

/** `POST /v1/db/:db/backup/verify` — is the bucket restorable to `at`? Writes nothing. */
export const backupVerify: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  const body = await readJson<RestoreBody>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const { store, prefix } = storeFor(ctx, body)
  const target = bucketTarget(body.at)
  try {
    const result = await verifyBucket({
      store,
      prefix,
      db: name,
      ...(target ? { at: target } : {}),
      ...(body.generation ? { generation: body.generation } : {}),
    })
    return json(result, result.ok ? 200 : 409)
  } catch (err) {
    throw mapRestoreError(err)
  }
}

/** `GET /v1/db/:db/backup/generations` — the timelines the bucket holds, newest first. */
export const backupGenerations: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  const { store, prefix } = storeFor(ctx, {})
  try {
    return json({ db: name, bucket: store.describe().bucket, prefix, generations: await listGenerations(store, prefix, name) })
  } catch (err) {
    throw mapRestoreError(err)
  }
}

/** Streams the database file out, as of a snapshot taken now (design §6.5). */
export const dumpDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  const tenant = ctx.runtime.tenant(name)
  try {
    const ref = await tenant.snapshot()
    ctx.txid = Number(ref.txid)
    return new Response(Bun.file(ref.path), {
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-length": String(ref.bytes),
        "content-disposition": `attachment; filename="${name}-${ref.txid}.db"`,
        [HEADERS.txid]: String(ref.txid),
      },
    })
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

/** Takes a raw SQLite file as the body and files it as a new database (design §6.5). */
export const importDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  requirePrimaryFor(ctx, name)
  assertValidName(name)
  const runtime = ctx.runtime
  if (runtime.registry.has(name)) {
    throw new BunQLError("CONFLICT", `database ${name} already exists`, 409)
  }
  const max = runtime.config.limits.maxImportBytes
  const declared = Number(ctx.request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > max) {
    throw new BunQLError("PAYLOAD_TOO_LARGE", `a database larger than ${max} bytes`, 413)
  }
  const bytes = new Uint8Array(await ctx.request.arrayBuffer())
  if (bytes.byteLength > max) {
    throw new BunQLError("PAYLOAD_TOO_LARGE", `a database larger than ${max} bytes`, 413)
  }
  if (bytes.byteLength < 512 || !startsWithMagic(bytes)) {
    throw BunQLError.badRequest("the body does not begin with the SQLite file header")
  }
  try {
    const tenant = await runtime.registry.importDatabase(name, bytes)
    await runtime.promoter.ensureLease(tenant.name)
    ctx.txid = Number(tenant.txid)
    return json(statsOf(runtime, tenant), 201)
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

function startsWithMagic(bytes: Uint8Array): boolean {
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false
  }
  return true
}

export const checkpointDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const tenant = ctx.runtime.tenant(dbName(ctx))
  const body = await readJson<{ mode?: string }>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const mode = (body.mode ?? "PASSIVE").toUpperCase()
  if (mode !== "PASSIVE" && mode !== "FULL" && mode !== "RESTART" && mode !== "TRUNCATE") {
    throw BunQLError.badRequest(`unknown checkpoint mode ${JSON.stringify(body.mode)}`)
  }
  try {
    const result = tenant.checkpoint(mode)
    ctx.txid = Number(tenant.txid)
    return json({ mode, ...result, walBytes: tenant.walBytes, txid: Number(tenant.txid) })
  } catch (err) {
    throw mapTenantError(err, primaryOf(ctx))
  }
}

/**
 * Design §6.5 and `plan-phase1.md`'s observability section. The shape differs by role: a primary
 * lists the replicas attached to it, a replica reports where it is following from and how far
 * behind it is.
 */
/** The shipper's own view, without touching the bucket. Null on a node that ships nothing. */
function s3StateOf(runtime: ServerRuntime, db: string): ShipperState | null {
  return runtime.storage?.shipperFor(db)?.state() ?? null
}

export const replication: Handler = async (ctx) => {
  const { tenant } = await open(ctx, "ro")
  const snapshots = listSnapshots(tenant.dir)
  const last = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const common = {
    db: tenant.name,
    txid: Number(tenant.txid),
    epoch: tenant.epoch,
    checksum: tenant.checksum.toString(),
    lastSnapshot: last
      ? { txid: Number(last.txid), bytes: last.bytes, at: last.createdAtMs }
      : null,
    // Design §6.5 lists "S3 position" beside the replica positions: the bucket is another
    // follower, and how far behind it is belongs in the same place.
    s3: s3StateOf(ctx.runtime, tenant.name),
  }

  if (tenant.isReplica) {
    const status = ctx.runtime.replica?.status() ?? null
    const stream = status?.streams.find((one) => one.db === tenant.name) ?? null
    return json({
      ...common,
      role: "replica",
      primary: ctx.runtime.config.replication.primary,
      connected: status?.connected ?? false,
      applied: Number(tenant.txid),
      lagTxid: stream?.lagTxid ?? 0,
      bootstrapping: stream?.bootstrapping ?? false,
      lastError: status?.lastError ?? null,
    })
  }

  return json({
    ...common,
    role: "primary",
    replicas: (ctx.runtime.replication?.replicasOf(tenant.name) ?? []).map((replica) => ({
      node: replica.node,
      stream: replica.stream,
      txid: replica.txid,
      lag: replica.lag,
      ackedAt: replica.ackedAtMs,
      fsynced: replica.fsynced,
    })),
  })
}

// ── tokens (design §6, §6.5) ───────────────────────────────────────────────────────────────────

interface TokenBody {
  dbs?: string[]
  db?: string
  scope?: "ro" | "rw"
  tables?: Record<string, TableScope>
  ttl?: number
  ttlMs?: number
  sub?: string
}

export const mintToken: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const body = await readJson<TokenBody>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const dbs = body.dbs ?? (body.db ? [body.db] : [])
  if (dbs.length === 0) throw BunQLError.badRequest("a token needs at least one database glob")
  for (const glob of dbs) {
    if (typeof glob !== "string" || glob.length === 0) {
      throw BunQLError.badRequest("every entry of dbs must be a non-empty string")
    }
  }
  const scope = body.scope ?? "ro"
  if (scope !== "ro" && scope !== "rw") {
    throw BunQLError.badRequest(`scope must be "ro" or "rw", got ${JSON.stringify(body.scope)}`)
  }
  const ttlMs = body.ttlMs ?? (body.ttl !== undefined ? body.ttl * 1000 : undefined)
  const grant: TokenGrant = {
    ...(scope === "rw" ? { rw: dbs } : { ro: dbs }),
    ...(body.tables ? { tables: body.tables } : {}),
    ...(body.sub !== undefined ? { sub: body.sub } : {}),
    ttlMs: ttlMs ?? ctx.runtime.config.auth.defaultTokenTtlMs,
  }
  const token = await ctx.runtime.auth.mint(grant)
  const claims = JSON.parse(atob(toStandardBase64(token.split(".")[1] as string))) as {
    jti: string
    exp?: number
  }
  ctx.runtime.registry.catalog.putToken({
    jti: claims.jti,
    claims,
    expiresAtSec: claims.exp ?? null,
  })
  return json({ token, jti: claims.jti, exp: claims.exp ?? null }, 201)
}

function toStandardBase64(segment: string): string {
  const normalized = segment.replaceAll("-", "+").replaceAll("_", "/")
  const pad = normalized.length % 4
  return pad === 0 ? normalized : normalized + "=".repeat(4 - pad)
}

export const revokeToken: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const jti = ctx.params.jti
  if (!jti) throw BunQLError.badRequest("no token id in the path")
  ctx.runtime.registry.catalog.revokeToken(jti)
  return json({ jti, revoked: true })
}

// ── promotion and the control plane (C2, design §5.3) ──────────────────────────────────────────

/** The HTTP status each refusal deserves. A refusal is never a 500: it is a considered answer. */
const PROMOTION_STATUS: Readonly<Record<string, number>> = {
  NO_COPY: 404,
  GENERATION_MISMATCH: 409,
  STREAM_LIVE: 409,
  ALREADY_PRIMARY: 409,
  BEHIND: 409,
  LEASE_HELD: 503,
  NO_LEADER: 503,
  NOT_COMMITTED: 503,
}

/**
 * Makes this node the primary for one database (design §5.3, `docs/c2-promotion.md`).
 *
 * Admin only, and a refusal changes nothing: the decision is taken by the control plane — on the
 * Raft leader, against the leader's own clock — before anything local is touched. `force` overrides
 * exactly three refusals and is how an operator says "the old primary is gone, I have checked".
 */
export const promoteDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  const body = await readJson<{ force?: boolean }>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const outcome = await ctx.runtime.promoter.promote(name, { force: body.force === true })
  if (!outcome.ok) {
    throw new BunQLError(outcome.code, outcome.why, PROMOTION_STATUS[outcome.code] ?? 409, {
      ...(ctx.runtime.primaryUrlFor(name) ? { primary: ctx.runtime.primaryUrlFor(name) as string } : {}),
    })
  }
  const tenant = ctx.runtime.tenant(name)
  ctx.txid = Number(tenant.txid)
  return json({
    db: name,
    promoted: true,
    role: ctx.runtime.roleFor(name),
    epoch: tenant.epoch,
    txid: Number(tenant.txid),
    why: outcome.why,
  })
}

/** The control plane's observable surface (`docs/plan-phase2.md` C1). */
export const cluster: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const node = ctx.runtime.cluster
  if (!node) {
    throw new BunQLError(
      "CLUSTER_DISABLED",
      "this node has no [cluster] section enabled, so it is not in a raft group",
      503,
    )
  }
  const view = node.observe()
  return json({
    ...view,
    // The lease is the one thing in the view a reader cannot interpret without knowing whose clock
    // `until` is in, so the node's own wall clock goes beside it.
    nowMs: Date.now(),
    dbs: view.dbs.map((db) => ({ ...db, leaseHeldHere: node.holdsLease(db.db) })),
  })
}

// ── operations ─────────────────────────────────────────────────────────────────────────────────

/** The four series of `plan-phase1.md`, from whichever half of replication this node runs. */
function replicationMetrics(runtime: ServerRuntime): ReplicationMetrics | null {
  const replica = runtime.replica
  if (replica) {
    return {
      connected: replica.connected ? 1 : 0,
      lagTxid: replica.maxLagTxid,
      bytes: replica.bytesReceived,
      records: replica.recordsApplied,
    }
  }
  const server = runtime.replication
  if (!server) return null
  return {
    connected: server.connections,
    lagTxid: server.maxLagTxid,
    bytes: server.bytesSent,
    records: server.recordsSent,
  }
}

/** The four `bunql_s3_*` series, or null on a node with no bucket configured. */
function storageMetrics(runtime: ServerRuntime): StorageMetrics | null {
  const pool = runtime.storage
  if (!pool) return null
  const totals = pool.totals()
  return {
    shippedTxid: totals.shippedTxid,
    pendingRecords: totals.pendingRecords,
    errors: totals.errors,
    bytes: totals.bytes,
    behind: [...pool.shippers.values()].filter((one) => one.behind).length,
  }
}

export const healthz: Handler = (ctx) => {
  return json({
    ok: !ctx.runtime.closed,
    node: ctx.runtime.node,
    role: ctx.runtime.role,
    uptimeMs: Date.now() - ctx.runtime.metrics.startedAt,
  })
}

/**
 * Ready means "this node can serve". On a primary that is the catalog being open; on a replica it
 * also means the stream is up, because a replica that cannot reach its primary is serving data
 * that only gets staler (design §6.5).
 */
export const readyz: Handler = (ctx) => {
  const live = !ctx.runtime.closed && !ctx.runtime.registry.closed
  const replica = ctx.runtime.replica
  const connected = replica ? replica.connected : true
  const ready = live && connected
  return json(
    {
      ready,
      node: ctx.runtime.node,
      role: ctx.runtime.role,
      ...(replica ? { connected, primary: ctx.runtime.config.replication.primary } : {}),
    },
    ready ? 200 : 503,
  )
}

export const metrics: Handler = async (ctx) => {
  if (ctx.runtime.auth.hasAdminKey) requireAdmin(await principalOf(ctx))
  const stats = ctx.runtime.registry.stats()
  const body = ctx.runtime.metrics.render(
    stats,
    ctx.runtime.node,
    replicationMetrics(ctx.runtime),
    storageMetrics(ctx.runtime),
  )
  return new Response(body, {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  })
}

