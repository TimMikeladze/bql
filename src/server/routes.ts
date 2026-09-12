// Invariant: every handler here resolves the principal before it touches a tenant, and the
// tenant before it reads the body. A request that is not allowed to see a database must not be
// able to tell whether it exists, and a request with a malformed body must not have opened a
// connection to find that out.
//
// Handlers return a `Response`; the four `BunQL-*` headers, CORS and the metrics tick are added
// once by the wrapper in `app.ts`, so nothing below repeats them.

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
  resolveOptions,
} from "./exec.ts"
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
  try {
    const { result } = executeStatement(ctx.runtime, tenant, principal, body, options)
    ctx.txid = result.txid
    return json(result)
  } catch (err) {
    throw mapTenantError(err)
  }
}

export const batch: Handler = async (ctx) => {
  const { principal, tenant } = await open(ctx, "ro")
  const body = await readJson<BatchRequest>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const options = resolveOptions(body, ctx.request.headers, ctx.runtime.config)
  await awaitTxid(tenant, options)
  try {
    const result = executeBatch(ctx.runtime, tenant, principal, body, options)
    ctx.txid = result.txid
    return json(result)
  } catch (err) {
    throw mapTenantError(err)
  }
}

export const txBegin: Handler = async (ctx) => {
  const { principal, tenant } = await open(ctx, "rw")
  const body = await readJson<TxBeginRequest>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  try {
    const session = ctx.runtime.beginTx(tenant, principal, {
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.rows ? { rows: body.rows } : {}),
    })
    return json({ tx: session.baton, expiresInMs: ctx.runtime.config.limits.txIdleTimeoutMs })
  } catch (err) {
    const mapped = mapTenantError(err)
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
  const session = ctx.runtime.txSession(ctx.params.tx as string)
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
    throw mapTenantError(err)
  }
}

function endTx(how: "commit" | "rollback"): Handler {
  return async (ctx) => {
    const principal = await principalOf(ctx)
    const session = ctx.runtime.txSession(ctx.params.tx as string)
    requireScope(principal, session.db, "rw")
    try {
      const txid = ctx.runtime.endTx(session, how)
      ctx.txid = Number(txid)
      return json({ txid: Number(txid) })
    } catch (err) {
      throw mapTenantError(err)
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
  from?: { db: string; at?: number }
  pageSize?: number
  quotaBytes?: number
}

export const createDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
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
              ...(body.from.at !== undefined ? { at: BigInt(Math.floor(body.from.at)) } : {}),
            },
          }
        : {}),
    })
    ctx.txid = Number(tenant.txid)
    return json(statsOf(ctx.runtime, tenant), 201)
  } catch (err) {
    throw mapTenantError(err)
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
        txid: Number(txid),
        open: isOpen,
      }
    }),
  })
}

function statsOf(runtime: ServerRuntime, tenant: Tenant): Record<string, unknown> {
  const stats = tenant.stats()
  const realtime = runtime.realtimeOf(tenant.name)
  return {
    name: stats.name,
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
    replicas: [],
  }
}

export const statDb: Handler = async (ctx) => {
  const { tenant } = await open(ctx, "ro")
  return json(statsOf(ctx.runtime, tenant))
}

export const deleteDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  if (!ctx.runtime.registry.has(name)) throw BunQLError.dbNotFound(name)
  ctx.runtime.evict(name)
  try {
    const trash = ctx.runtime.registry.delete(name)
    return json({ name, deleted: true, trash })
  } catch (err) {
    throw mapTenantError(err)
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
    throw mapTenantError(err)
  }
}

interface RestoreBody {
  at?: number
  into?: string
}

/**
 * Point-in-time restore. Always into a *new* database: the log and the snapshots behind this one
 * still describe the timeline it actually had, and rewinding a database in place would leave the
 * log holding records that no longer apply to it. Design §6.5's CLI example restores with
 * `--into` for the same reason.
 */
export const restoreDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
  const body = await readJson<RestoreBody>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const tenant = ctx.runtime.tenant(name)
  const at = body.at === undefined ? tenant.txid : BigInt(Math.floor(body.at))
  if (at <= 0n) throw BunQLError.badRequest("restore needs a positive txid in `at`")
  const into = body.into ?? `${name}-restore-${at}`.slice(0, 64)
  assertValidName(into)
  try {
    const created = await ctx.runtime.registry.create(into, { from: { db: name, at } })
    ctx.txid = Number(created.txid)
    return json({ name: into, txid: Number(created.txid), from: name, at: Number(at) }, 201)
  } catch (err) {
    throw mapTenantError(err)
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
    throw mapTenantError(err)
  }
}

/** Takes a raw SQLite file as the body and files it as a new database (design §6.5). */
export const importDb: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const name = dbName(ctx)
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
    ctx.txid = Number(tenant.txid)
    return json(statsOf(runtime, tenant), 201)
  } catch (err) {
    throw mapTenantError(err)
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
    throw mapTenantError(err)
  }
}

export const replication: Handler = async (ctx) => {
  const { tenant } = await open(ctx, "ro")
  const snapshots = listSnapshots(tenant.dir)
  const last = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  return json({
    db: tenant.name,
    txid: Number(tenant.txid),
    epoch: tenant.epoch,
    checksum: tenant.checksum.toString(),
    lastSnapshot: last ? { txid: Number(last.txid), bytes: last.bytes, at: last.createdAtMs } : null,
    role: "primary",
    replicas: [],
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

// ── operations ─────────────────────────────────────────────────────────────────────────────────

export const healthz: Handler = (ctx) => {
  return json({
    ok: !ctx.runtime.closed,
    node: ctx.runtime.node,
    role: "primary",
    uptimeMs: Date.now() - ctx.runtime.metrics.startedAt,
  })
}

/**
 * Ready means "this node can serve". On a standalone primary that is the catalog being open;
 * a replica will add "caught up with the primary" here (design §6.5).
 */
export const readyz: Handler = (ctx) => {
  const ready = !ctx.runtime.closed && !ctx.runtime.registry.closed
  return json({ ready, node: ctx.runtime.node, role: "primary" }, ready ? 200 : 503)
}

export const metrics: Handler = async (ctx) => {
  if (ctx.runtime.auth.hasAdminKey) requireAdmin(await principalOf(ctx))
  const stats = ctx.runtime.registry.stats()
  const body = ctx.runtime.metrics.render(stats, ctx.runtime.node)
  return new Response(body, {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  })
}

