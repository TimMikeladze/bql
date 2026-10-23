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
import { setSubject } from "../tenant/subject.ts"
import { ADMIN, applyPolicy, type TableScope, type TokenGrant } from "./auth.ts"
import { resolveOptions, step, toResult } from "./exec.ts"
import { uuidv7 } from "../web/table.ts"
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
  /** Takes HTML form posts (`POST /v1/forms/:app/:table`). Only an `a` table can. */
  form?: AppForm
}

export interface AppForm {
  /** Declared fields are checked and kept; others are dropped. Absent: any text field is kept. */
  fields?: Record<string, ActionInput>
  /** Posts one IP may make to this table per minute. */
  perMinute: number
}

export type InputType = "int" | "number" | "text" | "bool" | "email"

export interface ActionInput {
  type: InputType
  /** Numbers: inclusive bounds. */
  min?: number
  max?: number
  /** Text: inclusive bounds on its length. */
  minLength?: number
  maxLength?: number
  /** Absent from the request binds NULL. Default false: absent is a 400. */
  optional: boolean
}

export interface ActionStatement {
  sql: string
  /** The rows the statement must change; any other count rolls the action back with `error`. */
  expect?: number
  error?: string
}

export interface AppAction {
  /** Where it runs: the shared database (default) or the calling visitor's own. */
  db: "shared" | "private"
  input: Record<string, ActionInput>
  run: ActionStatement[]
}

export interface AppConfig {
  /** `https://acme.app`, `https://*.acme.app`, `http://localhost:*`, or `*` for any origin. */
  origins: string[]
  tables: Record<string, AppTable>
  /** Named SQL a visitor can run with the server's rights (`POST /v1/session/action`). */
  actions: Record<string, AppAction>
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
      refuse(`${where}.${key} is not supported`)
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
  const root = keysOf(input, "config", ["origins", "tables", "actions", "session"])
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
      const table = keysOf(value, `tables.${name}`, ["mode", "read", "form"])
      if (table.mode !== "r" && table.mode !== "a" && table.mode !== "rw") {
        refuse(`tables.${name}.mode must be "r", "a" or "rw"`)
      }
      if (table.read !== undefined && typeof table.read !== "boolean") {
        refuse(`tables.${name}.read must be a boolean`)
      }
      const form = table.form === undefined || table.form === false ? undefined : parseForm(table.form, `tables.${name}.form`)
      if (form && table.mode !== "a") refuse(`tables.${name}: a form table must be mode "a"`)
      // A form table usually holds what strangers typed in (emails), so it stays out of visitor
      // tokens unless the config says otherwise.
      const read = table.read === undefined ? !form : table.read
      tables[name] = { mode: table.mode, read, ...(form ? { form } : {}) }
    }
  }
  const actions: Record<string, AppAction> = {}
  if (root.actions !== undefined) {
    const raw = keysOf(root.actions, "actions", Object.keys(root.actions as object))
    for (const [name, value] of Object.entries(raw)) {
      if (!TABLE.test(name)) refuse(`action name ${JSON.stringify(name)} is not a plain identifier`)
      actions[name] = parseAction(value, `actions.${name}`)
    }
  }
  const session = keysOf(root.session ?? {}, "session", ["ttlMs", "newVisitorsPerMinute"])
  return {
    origins,
    tables,
    actions,
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

const DEFAULT_FORM_PER_MINUTE = 10

function parseForm(value: unknown, where: string): AppForm {
  if (value === true) return { perMinute: DEFAULT_FORM_PER_MINUTE }
  const form = keysOf(value, where, ["fields", "perMinute"])
  const fields =
    form.fields === undefined ? undefined : parseInputs(form.fields, `${where}.fields`)
  return {
    ...(fields ? { fields } : {}),
    perMinute: intIn(form.perMinute, `${where}.perMinute`, 1, 10_000, DEFAULT_FORM_PER_MINUTE),
  }
}

function parseInputs(value: unknown, where: string): Record<string, ActionInput> {
  const raw = keysOf(value, where, Object.keys(value as object))
  if (Object.keys(raw).length > MAX_ACTION_INPUTS) refuse(`${where} has more than ${MAX_ACTION_INPUTS} fields`)
  const input: Record<string, ActionInput> = {}
  for (const [field, spec] of Object.entries(raw)) {
    if (!TABLE.test(field)) refuse(`${where}.${field} is not a plain identifier`)
    // `:user` is the caller's sub, bound by the server; an input must not be able to set it.
    if (field === "user") refuse(`${where}.user is reserved: :user is the caller`)
    const one = keysOf(spec, `${where}.${field}`, ["type", "min", "max", "minLength", "maxLength", "optional"])
    if (!["int", "number", "text", "bool", "email"].includes(one.type as string)) {
      refuse(`${where}.${field}.type must be "int", "number", "text", "bool" or "email"`)
    }
    for (const bound of ["min", "max", "minLength", "maxLength"] as const) {
      if (one[bound] !== undefined && typeof one[bound] !== "number") refuse(`${where}.${field}.${bound} must be a number`)
    }
    if (one.optional !== undefined && typeof one.optional !== "boolean") refuse(`${where}.${field}.optional must be a boolean`)
    input[field] = {
      type: one.type as InputType,
      ...(one.min !== undefined ? { min: one.min as number } : {}),
      ...(one.max !== undefined ? { max: one.max as number } : {}),
      ...(one.minLength !== undefined ? { minLength: one.minLength as number } : {}),
      ...(one.maxLength !== undefined ? { maxLength: one.maxLength as number } : {}),
      optional: one.optional === true,
    }
  }
  return input
}

/** What a statement in an action may start with: data, never schema, `ATTACH` or `PRAGMA`. */
const ACTION_SQL = /^\s*(?:--[^\n]*\n\s*)*(insert|update|delete|select|with|replace)\b/i
const MAX_ACTION_STATEMENTS = 20
/** Enough to catch a typo, not a proof the address exists: one @, something on each side, a dot after. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ACTION_INPUTS = 32

function parseAction(value: unknown, where: string): AppAction {
  const action = keysOf(value, where, ["db", "input", "run"])
  if (action.db !== undefined && action.db !== "shared" && action.db !== "private") {
    refuse(`${where}.db must be "shared" or "private"`)
  }
  const input = action.input === undefined ? {} : parseInputs(action.input, `${where}.input`)
  if (!Array.isArray(action.run) || action.run.length === 0 || action.run.length > MAX_ACTION_STATEMENTS) {
    refuse(`${where}.run must be 1 to ${MAX_ACTION_STATEMENTS} statements`)
  }
  const run = (action.run as unknown[]).map((raw, i) => {
    const statement = keysOf(raw, `${where}.run[${i}]`, ["sql", "expect", "error"])
    if (typeof statement.sql !== "string" || !ACTION_SQL.test(statement.sql)) {
      refuse(`${where}.run[${i}].sql must be one insert, update, delete, select, with or replace statement`)
    }
    if (statement.expect !== undefined && (!Number.isInteger(statement.expect) || (statement.expect as number) < 0)) {
      refuse(`${where}.run[${i}].expect must be a non-negative integer`)
    }
    if (statement.error !== undefined && typeof statement.error !== "string") refuse(`${where}.run[${i}].error must be a string`)
    return {
      sql: statement.sql,
      ...(statement.expect !== undefined ? { expect: statement.expect as number } : {}),
      ...(statement.error !== undefined ? { error: statement.error as string } : {}),
    }
  })
  return { db: action.db === "private" ? "private" : "shared", input, run }
}

/** Checks a request's input against the action's schema; returns the values to bind by name. */
export function bindInput(action: AppAction, input: unknown): Record<string, string | number | null> {
  const raw = input === undefined ? {} : input
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw BqlError.badRequest("input must be an object")
  const given = raw as Record<string, unknown>
  for (const key of Object.keys(given)) {
    if (!(key in action.input)) throw BqlError.badRequest(`input.${key} is not an input of this action`)
  }
  const out: Record<string, string | number | null> = {}
  for (const [field, spec] of Object.entries(action.input)) {
    const value = given[field]
    if (value === undefined || value === null) {
      if (!spec.optional) throw BqlError.badRequest(`input.${field} is required`)
      out[field] = null
      continue
    }
    const fail = (what: string): never => {
      throw BqlError.badRequest(`input.${field} ${what}`)
    }
    if (spec.type === "bool") {
      if (typeof value !== "boolean") fail("must be true or false")
      out[field] = value ? 1 : 0
    } else if (spec.type === "text" || spec.type === "email") {
      if (typeof value !== "string") fail("must be text")
      if (spec.type === "email" && !EMAIL.test(value as string)) fail("must be an email address")
      const text = value as string
      if (spec.minLength !== undefined && text.length < spec.minLength) fail(`must be at least ${spec.minLength} characters`)
      if (spec.maxLength !== undefined && text.length > spec.maxLength) fail(`must be at most ${spec.maxLength} characters`)
      out[field] = text
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) fail("must be a number")
      if (spec.type === "int" && !Number.isSafeInteger(value)) fail("must be an integer")
      const n = value as number
      if (spec.min !== undefined && n < spec.min) fail(`must be at least ${spec.min}`)
      if (spec.max !== undefined && n > spec.max) fail(`must be at most ${spec.max}`)
      out[field] = n
    }
  }
  return out
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

// ── actions ────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /v1/session/action`: runs one of the app's actions for the visitor whose session token
 * comes with it. The statements are the owner's, from the config, and run in one transaction
 * with the server's rights: no table ACL, so an action can write a table the visitor can only
 * read. The visitor supplies only `input`, which is checked against the action's schema and bound
 * by name; `:user` is bound to the caller's sub, and `bql_sub()` returns it too, so author columns
 * and their triggers hold inside an action as they do outside it.
 */
export const runAction: Handler = async (ctx) => {
  const body = await readJson<{ key?: unknown; name?: unknown; input?: unknown }>(ctx, ctx.runtime.config.limits.maxBodyBytes)
  if (typeof body.key !== "string" || !body.key.startsWith("pk_")) {
    throw BqlError.unauthenticated("an action needs the app key (pk_…)")
  }
  const app = ctx.runtime.registry.catalog.getAppByKey(body.key)
  if (!app) throw BqlError.unauthenticated("unknown app key")
  const config = parseAppConfig(app.config)
  if (!originAllowed(config.origins, ctx.request.headers.get("origin"))) {
    throw BqlError.notAuthorized("this origin is not in the app's origins")
  }
  // The session's own token proves which visitor is asking: it is `rw` on exactly the database
  // named after its sub, and no other app's session can be.
  const principal = await principalOf(ctx)
  const sub = principal.kind === "token" ? principal.claims.sub : undefined
  if (principal.kind !== "token" || !sub) throw BqlError.unauthenticated("an action needs a session token")
  const visitorDb = `app-${app.id}-u-${sub}`
  if (principal.scopeFor(visitorDb) !== "rw") throw BqlError.notAuthorized("this token is not a session of this app")
  if (typeof body.name !== "string") throw BqlError.badRequest("an action needs a name")
  const action = config.actions[body.name]
  if (!action) throw new BqlError("NOT_FOUND", `no action ${body.name}`, 404)
  const values = bindInput(action, body.input)
  requirePrimary(ctx)

  const dbName = action.db === "private" ? visitorDb : sharedDbOf(app.id)
  const tenant = ctx.runtime.tenant(dbName)
  ctx.runtime.assertWritable(dbName)
  const options = resolveOptions(undefined, null, ctx.runtime.config)
  const startedNs = Bun.nanoseconds()
  const written = tenant.write((db) => {
    const handle = applyPolicy(db, ctx.runtime.hubFor(db), ADMIN, dbName)
    // After the policy, which clears it for the admin.
    setSubject(db, sub)
    try {
      return action.run.map((statement, i) => {
        const names = db.prepare(statement.sql).paramNames
        const args: Record<string, string | number | null> = {}
        for (const name of names) {
          const bare = name.slice(1)
          if (bare === "user") args[name] = sub
          else if (bare in values) args[name] = values[bare] ?? null
          else throw BqlError.badRequest(`action ${body.name}: ${name} in run[${i}] is neither an input nor :user`)
        }
        const stepped = step(ctx.runtime, db, { sql: statement.sql, args }, options.writeTimeoutMs, options)
        if (statement.expect !== undefined && stepped.rowsAffected !== statement.expect) {
          throw new BqlError(
            "CONFLICT",
            statement.error ?? `action ${body.name}: run[${i}] changed ${stepped.rowsAffected} rows, expected ${statement.expect}`,
            409,
          )
        }
        return stepped
      })
    } finally {
      handle.release()
    }
  })
  ctx.txid = Number(written.txid)
  return json({
    results: written.result.map((one) => {
      const result = toResult(one, "object", written.txid, startedNs)
      return { rows: result.rows, rowsAffected: result.rowsAffected }
    }),
    txid: Number(written.txid),
  })
}

// ── forms ──────────────────────────────────────────────────────────────────────────────────────

const MAX_FORM_FIELDS = 32

/** The part of a parsed form this reads; Bun's and undici's `FormData` types disagree on values. */
interface Form {
  get(name: string): unknown
  entries(): Iterable<[string, unknown]>
  values(): Iterable<unknown>
}
const MAX_FORM_TEXT = 2000

/** Form values are strings; this turns each declared field into what `bindInput` checks. */
function coerceForm(fields: Record<string, ActionInput>, form: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, spec] of Object.entries(fields)) {
    const raw = form.get(field)
    if (typeof raw !== "string") {
      // An unchecked checkbox is not sent at all.
      if (spec.type === "bool") out[field] = false
      continue
    }
    if (spec.type === "bool") out[field] = ["on", "true", "1", "yes"].includes(raw.toLowerCase())
    else if (spec.type === "int" || spec.type === "number") {
      if (raw.trim() !== "") out[field] = /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw
    } else if (raw !== "") out[field] = raw
  }
  return out
}

/** The document a post becomes: declared fields checked, or every plain text field kept. */
function formDocument(config: AppForm, form: Form): Record<string, unknown> {
  for (const value of form.values()) {
    if (typeof value !== "string") throw BqlError.badRequest("file uploads are not accepted")
  }
  if (config.fields) {
    const values = bindInput({ db: "shared", input: config.fields, run: [] }, coerceForm(config.fields, form))
    const doc: Record<string, unknown> = {}
    for (const [field, spec] of Object.entries(config.fields)) {
      const value = values[field]
      if (value === null || value === undefined) continue
      doc[field] = spec.type === "bool" ? value === 1 : value
    }
    return doc
  }
  const doc: Record<string, string> = {}
  for (const [field, value] of form.entries()) {
    // `_next`, `_gotcha` and anything else starting with `_` is for this endpoint, not the row.
    if (field.startsWith("_") || typeof value !== "string") continue
    if (!TABLE.test(field)) throw BqlError.badRequest(`input.${field} is not a plain field name`)
    if (value.length > MAX_FORM_TEXT) throw BqlError.badRequest(`input.${field} must be at most ${MAX_FORM_TEXT} characters`)
    doc[field] = value
  }
  if (Object.keys(doc).length > MAX_FORM_FIELDS) throw BqlError.badRequest(`a form may send at most ${MAX_FORM_FIELDS} fields`)
  return doc
}

/** `_next`, else the `Referer`, but only on an origin the app allows: never an open redirect. */
function redirectTarget(origins: readonly string[], form: Form | null, referer: string | null): URL | null {
  const next = form?.get("_next")
  for (const candidate of [typeof next === "string" ? next : null, referer]) {
    if (!candidate) continue
    try {
      const url = new URL(candidate)
      if (originAllowed(origins, url.origin)) return url
    } catch {
      // not an absolute URL: try the next one
    }
  }
  return null
}

function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : ""
  const field = /^input\.([A-Za-z_][A-Za-z0-9_]*)/.exec(message)?.[1]
  if (field) return field
  const code = (err as { code?: unknown })?.code
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return "check"
  if (code === "TOO_MANY_REQUESTS") return "rate"
  return "error"
}

/**
 * `POST /v1/forms/:app/:table`: an HTML `<form>` with no JavaScript writes one row. The answer is
 * a `303` back to the page (`_next`, else the `Referer`) with `?bql=ok` or
 * `?bql=error&reason=<field|check|rate|error>`, or JSON when the request asks for it. A filled
 * `_gotcha` field (a honeypot hidden from people) is answered `ok` and stored nowhere.
 */
export const submitForm: Handler = async (ctx) => {
  const wantsJson = (ctx.request.headers.get("accept") ?? "").includes("application/json")
  const appId = ctx.params.app
  assertValidAppId(appId)
  const app = ctx.runtime.registry.catalog.getApp(appId)
  if (!app) throw new BqlError("NOT_FOUND", `no app ${appId}`, 404)
  const config = parseAppConfig(app.config)
  const tableName = ctx.params.table ?? ""
  const table = config.tables[tableName]
  if (!table?.form) throw new BqlError("NOT_FOUND", `${tableName} takes no form posts`, 404)
  // Browsers send Origin on every cross-site form POST; without an allowed one, there is nowhere
  // safe to send the visitor back to, so this one is always a plain refusal.
  if (!originAllowed(config.origins, ctx.request.headers.get("origin"))) {
    throw BqlError.notAuthorized("this origin is not in the app's origins")
  }

  let form: Form | null = null
  const answer = async (): Promise<string | null> => {
    const wait = limiterFor(ctx).take(`form|${app.id}|${tableName}|${clientIp(ctx)}`, table.form!.perMinute)
    if (wait > 0) {
      throw new BqlError("TOO_MANY_REQUESTS", "too many posts from this address", 429, { retryAfterSec: wait })
    }
    if (Number(ctx.request.headers.get("content-length") ?? 0) > ctx.runtime.config.limits.maxBodyBytes) {
      throw new BqlError("PAYLOAD_TOO_LARGE", "form is too large", 413)
    }
    let parsed: Form
    try {
      parsed = (await ctx.request.formData()) as unknown as Form
    } catch {
      throw BqlError.badRequest("the body is not a form (application/x-www-form-urlencoded or multipart/form-data)")
    }
    form = parsed
    const honeypot = parsed.get("_gotcha")
    if (typeof honeypot === "string" && honeypot !== "") return null
    const doc = formDocument(table.form!, parsed)
    requirePrimary(ctx)
    const dbName = sharedDbOf(app.id)
    ctx.runtime.assertWritable(dbName)
    const id = uuidv7()
    const written = ctx.runtime.tenant(dbName).write((db) => {
      const handle = applyPolicy(db, ctx.runtime.hubFor(db), ADMIN, dbName)
      try {
        db.run(`insert into "${tableName}" (id, data) values (?, ?)`, [id, JSON.stringify(doc)])
      } finally {
        handle.release()
      }
    })
    ctx.txid = Number(written.txid)
    return id
  }

  let id: string | null
  try {
    id = await answer()
  } catch (err) {
    const target = wantsJson ? null : redirectTarget(config.origins, form, ctx.request.headers.get("referer"))
    if (!target) throw err
    target.searchParams.set("bql", "error")
    target.searchParams.set("reason", reasonOf(err))
    return new Response(null, { status: 303, headers: { location: target.toString() } })
  }
  if (wantsJson) return json({ ok: true, id }, 201)
  const target = redirectTarget(config.origins, form, ctx.request.headers.get("referer"))
  if (!target) {
    return new Response("<!doctype html><title>Sent</title><p>Thanks, that was sent.</p>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }
  target.searchParams.set("bql", "ok")
  return new Response(null, { status: 303, headers: { location: target.toString() } })
}
