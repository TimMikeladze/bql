// Web track (`docs/plan-web.md`): an app is what a static page connects to with its public `pk_`
// key. `/v1/session` trades that key and a visitor id for two short-lived tokens: one `rw` on the
// visitor's own database with no table ACL, so the page can create its tables there, and one on
// the app's shared database carrying the table modes from the app's config. The ACL is per token,
// not per database, which is why there are two.
//
// Invariant: a `pk_` key grants exactly what an anonymous visitor gets. It is in every page that
// connects, and `Origin` is checked but forgeable by anything that is not a browser, so nothing
// here may hand out more than one visitor's database and the shared tables' declared modes.

import { createHash } from "node:crypto"
import type { AppRow } from "../tenant/catalog.ts"
import type { TableScope, TokenGrant } from "./auth.ts"
import { BqlError } from "./errors.ts"
import { toBase64Url } from "./json.ts"
import {
  json,
  principalOf,
  readJson,
  requireAdmin,
  requirePrimary,
  type Handler,
  type RouteContext,
} from "./routes.ts"
import { mapTenantError } from "./runtime.ts"

// ── config ─────────────────────────────────────────────────────────────────────────────────────

export interface AppTable {
  mode: TableScope
  /** False keeps the table out of visitor tokens entirely; only the owner reads or writes it. */
  read: boolean
}

export interface AppConfig {
  /** `https://acme.app`, `https://*.acme.app`, `http://localhost:*`, or `*` for any origin. */
  origins: string[]
  tables: Record<string, AppTable>
  session: {
    ttlMs: number
    /** New visitor databases one IP may create per minute. */
    newVisitorsPerMinute: number
  }
}

const DEFAULT_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*"]
const DEFAULT_TTL_MS = 3_600_000
const DEFAULT_NEW_VISITORS_PER_MINUTE = 10
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const VISITOR = /^[A-Za-z0-9_-]{22,128}$/
const ORIGIN_PATTERN = /^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:(\d{1,5}|\*))?$/
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** A visitor database nothing has written to is deleted once it is this old. */
export const UNUSED_VISITOR_MS = 24 * 3_600_000
const SWEEP_EVERY_MS = 3_600_000
const SWEEP_BATCH = 100

function refuse(message: string): never {
  throw BqlError.badRequest(`app config: ${message}`)
}

function keysOf(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(`${where} must be an object`)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      // `actions` and `form` are in the plan and not built; saying so beats a silent no-op.
      refuse(`${where}.${key} is not supported${key === "actions" || key === "form" ? " yet" : ""}`)
    }
  }
  return record
}

function intIn(value: unknown, where: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    refuse(`${where} must be an integer from ${min} to ${max}`)
  }
  return value
}

/** Validates a `bql.json` and fills in its defaults. Unknown keys are refused, not ignored. */
export function parseAppConfig(input: unknown = {}): AppConfig {
  const root = keysOf(input, "config", ["origins", "tables", "session"])
  let origins = DEFAULT_ORIGINS
  if (root.origins !== undefined) {
    if (!Array.isArray(root.origins) || root.origins.length === 0) {
      refuse("origins must be a non-empty array")
    }
    for (const origin of root.origins) {
      if (typeof origin !== "string" || (origin !== "*" && !ORIGIN_PATTERN.test(origin))) {
        refuse(`origin ${JSON.stringify(origin)} must look like https://host, https://*.host or http://host:*`)
      }
    }
    origins = [...(root.origins as string[])]
  }
  const tables: Record<string, AppTable> = {}
  if (root.tables !== undefined) {
    const raw = keysOf(root.tables, "tables", Object.keys(root.tables as object))
    for (const [name, value] of Object.entries(raw)) {
      if (!TABLE.test(name)) refuse(`table name ${JSON.stringify(name)} is not a plain identifier`)
      const table = keysOf(value, `tables.${name}`, ["mode", "read"])
      if (table.mode !== "r" && table.mode !== "a" && table.mode !== "rw") {
        refuse(`tables.${name}.mode must be "r", "a" or "rw"`)
      }
      if (table.read !== undefined && typeof table.read !== "boolean") {
        refuse(`tables.${name}.read must be a boolean`)
      }
      tables[name] = { mode: table.mode, read: table.read !== false }
    }
  }
  const session = keysOf(root.session ?? {}, "session", ["ttlMs", "newVisitorsPerMinute"])
  return {
    origins,
    tables,
    session: {
      ttlMs: intIn(session.ttlMs, "session.ttlMs", 60_000, 86_400_000, DEFAULT_TTL_MS),
      newVisitorsPerMinute: intIn(
        session.newVisitorsPerMinute,
        "session.newVisitorsPerMinute",
        1,
        10_000,
        DEFAULT_NEW_VISITORS_PER_MINUTE,
      ),
    },
  }
}

/** Whether a request's `Origin` header is one the app allows. A missing `Origin` never is. */
export function originAllowed(patterns: readonly string[], origin: string | null): boolean {
  if (origin === null) return false
  const lower = origin.toLowerCase()
  for (const pattern of patterns) {
    if (pattern === "*") return true
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace("://*\\.", "://(?:[a-z0-9-]+\\.)+")
      .replace(/:\*$/, "(?::\\d{1,5})?")
    if (new RegExp(`^${source}$`).test(lower)) return true
  }
  return false
}

// ── names ──────────────────────────────────────────────────────────────────────────────────────

export function assertValidAppId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !APP_ID.test(id)) {
    throw BqlError.badRequest(`invalid app id ${JSON.stringify(id)}: expected [a-z0-9][a-z0-9-]{0,39}`)
  }
}

export function sharedDbOf(appId: string): string {
  return `app-${appId}-shared`
}

/**
 * The visitor's database. The visitor id works as a bearer secret for it, so only a hash goes in
 * the name: the catalog, the directory tree and the logs never hold the value itself.
 */
export function visitorDbOf(appId: string, visitor: string): { db: string; sub: string } {
  const sub = createHash("sha256").update(visitor).digest("hex").slice(0, 16)
  return { db: `app-${appId}-u-${sub}`, sub }
}

function newKey(): string {
  return `pk_${toBase64Url(crypto.getRandomValues(new Uint8Array(24)))}`
}

// ── rate limit ─────────────────────────────────────────────────────────────────────────────────

/**
 * New visitor databases per app and IP, in fixed one-minute windows, in memory. Only creating a
 * database counts: a returning visitor is never refused. Per node, and reset by a restart.
 */
export class NewVisitorLimiter {
  readonly #windows = new Map<string, { startMs: number; count: number }>()

  /** Returns 0 when allowed, or the seconds until the window ends. */
  take(key: string, limit: number, nowMs = Date.now()): number {
    if (this.#windows.size > 10_000) this.#prune(nowMs)
    const window = this.#windows.get(key)
    if (!window || nowMs - window.startMs >= 60_000) {
      this.#windows.set(key, { startMs: nowMs, count: 1 })
      return 0
    }
    if (window.count >= limit) return Math.max(1, Math.ceil((window.startMs + 60_000 - nowMs) / 1000))
    window.count++
    return 0
  }

  #prune(nowMs: number): void {
    for (const [key, window] of this.#windows) {
      if (nowMs - window.startMs >= 60_000) this.#windows.delete(key)
    }
  }
}

const limiters = new WeakMap<object, NewVisitorLimiter>()

function limiterFor(ctx: RouteContext): NewVisitorLimiter {
  let limiter = limiters.get(ctx.runtime)
  if (!limiter) {
    limiter = new NewVisitorLimiter()
    limiters.set(ctx.runtime, limiter)
  }
  return limiter
}

/**
 * The client's address: the first entry of `[server] clientIpHeader` when it is set (behind a
 * proxy, every request otherwise comes from the proxy), else the socket's peer.
 */
function clientIp(ctx: RouteContext): string {
  const header = ctx.runtime.config.server.clientIpHeader
  if (header) {
    const value = ctx.request.headers.get(header)?.split(",")[0]?.trim()
    if (value) return value
  }
  const server = ctx.server as unknown as { requestIP?: (r: Request) => { address: string } | null }
  return server.requestIP?.(ctx.request)?.address ?? "unknown"
}

// ── apps ───────────────────────────────────────────────────────────────────────────────────────

function appView(row: AppRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    sharedDb: sharedDbOf(row.id),
    config: row.config,
    createdAtMs: row.createdAtMs,
  }
}

function appOf(ctx: RouteContext): AppRow {
  const id = ctx.params.id
  assertValidAppId(id)
  const row = ctx.runtime.registry.catalog.getApp(id)
  if (!row) throw new BqlError("NOT_FOUND", `no app ${id}`, 404)
  return row
}

export const createApp: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  requirePrimary(ctx)
  const body = await readJson<{ id?: unknown; config?: unknown }>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  assertValidAppId(body.id)
  const config = parseAppConfig(body.config)
  const catalog = ctx.runtime.registry.catalog
  if (catalog.getApp(body.id)) throw new BqlError("CONFLICT", `app ${body.id} already exists`, 409)
  const shared = sharedDbOf(body.id)
  if (!ctx.runtime.registry.has(shared)) {
    try {
      await ctx.runtime.createDatabase(shared)
    } catch (err) {
      throw mapTenantError(err, ctx.runtime.primaryUrl ?? undefined)
    }
  }
  return json(appView(catalog.createApp({ id: body.id, key: newKey(), config })), 201)
}

export const listApps: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  return json({ apps: ctx.runtime.registry.catalog.listApps().map(appView) })
}

export const getApp: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  return json(appView(appOf(ctx)))
}

export const updateApp: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const row = appOf(ctx)
  const body = await readJson<{ config?: unknown }>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  const config = parseAppConfig(body.config)
  ctx.runtime.registry.catalog.setAppConfig(row.id, config)
  return json(appView({ ...row, config }))
}

export const rotateAppKey: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const row = appOf(ctx)
  const key = newKey()
  ctx.runtime.registry.catalog.setAppKey(row.id, key)
  return json(appView({ ...row, key }))
}

export const deleteApp: Handler = async (ctx) => {
  requireAdmin(await principalOf(ctx))
  const row = appOf(ctx)
  ctx.runtime.registry.catalog.deleteApp(row.id)
  return json({ id: row.id, deleted: true })
}

// ── sessions ───────────────────────────────────────────────────────────────────────────────────

function expOf(token: string): number {
  const payload = (token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/")
  return (JSON.parse(atob(payload)) as { exp: number }).exp
}

export const createSession: Handler = async (ctx) => {
  const body = await readJson<{ key?: unknown; visitor?: unknown }>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  if (typeof body.key !== "string" || !body.key.startsWith("pk_")) {
    throw BqlError.unauthenticated("a session needs an app key (pk_…)")
  }
  const catalog = ctx.runtime.registry.catalog
  const app = catalog.getAppByKey(body.key)
  if (!app) throw BqlError.unauthenticated("unknown app key")
  const config = parseAppConfig(app.config)
  if (!originAllowed(config.origins, ctx.request.headers.get("origin"))) {
    throw BqlError.notAuthorized("this origin is not in the app's origins")
  }
  if (typeof body.visitor !== "string" || !VISITOR.test(body.visitor)) {
    throw BqlError.badRequest("visitor must be 22 to 128 characters of [A-Za-z0-9_-]")
  }
  requirePrimary(ctx)

  const { db, sub } = visitorDbOf(app.id, body.visitor)
  if (!ctx.runtime.registry.has(db)) {
    const wait = limiterFor(ctx).take(`${app.id}|${clientIp(ctx)}`, config.session.newVisitorsPerMinute)
    if (wait > 0) {
      throw new BqlError("TOO_MANY_REQUESTS", "too many new visitors from this address", 429, {
        retryAfterSec: wait,
      })
    }
    try {
      await ctx.runtime.createDatabase(db)
    } catch (err) {
      throw mapTenantError(err, ctx.runtime.primaryUrl ?? undefined)
    }
  }

  // Session tokens are not written to the catalog: one row per visit would grow it without bound,
  // and they expire within `session.ttlMs`. Rotating the app key stops new sessions only.
  const nowMs = Date.now()
  const base: TokenGrant = { sub, ttlMs: config.session.ttlMs, now: nowMs }
  const privateToken = await ctx.runtime.auth.mint({ ...base, rw: [db] })

  const tables: Record<string, TableScope> = {}
  for (const [name, table] of Object.entries(config.tables)) {
    if (table.read) tables[name] = table.mode
  }
  let shared: { db: string; token: string } | null = null
  // An empty ACL would mint a token for the whole shared database, so no tables means no token.
  if (Object.keys(tables).length > 0) {
    const writes = Object.values(tables).some((mode) => mode !== "r")
    const sharedDb = sharedDbOf(app.id)
    shared = {
      db: sharedDb,
      token: await ctx.runtime.auth.mint({ ...base, ...(writes ? { rw: [sharedDb] } : { ro: [sharedDb] }), tables }),
    }
  }

  if (nowMs - app.sweptAtMs >= SWEEP_EVERY_MS) {
    catalog.setAppSwept(app.id, nowMs)
    sweepUnusedVisitors(ctx, app.id, nowMs)
  }
  return json({ private: { db, token: privateToken }, shared, exp: expOf(privateToken) }, 201)
}

/**
 * Deletes this app's visitor databases that are older than a day and were never written. Run from
 * a session request at most hourly per app rather than on a timer, so a node with no web apps
 * does nothing. Bounded per run; what is left waits for the next.
 */
export function sweepUnusedVisitors(ctx: RouteContext, appId: string, nowMs: number): number {
  const prefix = `app-${appId}-u-`
  let deleted = 0
  let looked = 0
  for (const row of ctx.runtime.registry.list()) {
    if (looked >= SWEEP_BATCH) break
    if (!row.name.startsWith(prefix) || nowMs - row.createdAtMs < UNUSED_VISITOR_MS) continue
    // The catalog's txid can trail the live one but never lead it, so a written row is skipped
    // without opening it; a zero is confirmed against the open tenant below.
    if (row.txid !== 0n) continue
    looked++
    try {
      if (ctx.runtime.tenant(row.name).txid !== 0n) continue
      ctx.runtime.evict(row.name)
      ctx.runtime.registry.delete(row.name)
      deleted++
    } catch {
      // Deleted underneath the sweep, or not openable: the next sweep looks again.
    }
  }
  return deleted
}
