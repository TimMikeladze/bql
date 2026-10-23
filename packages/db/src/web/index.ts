// `bql.sh/web` (docs/plan-web.md): what a static page imports to get a database with no server of
// its own. `connect()` trades the app's public `pk_` key and a visitor id for a session
// (`POST /v1/session`) and hands back the visitor's private database as `table()` and `sql`.
//
// Session tokens expire (`session.ttlMs`, an hour by default), and a client's token is fixed when
// it is built. So a refresh builds new clients and moves every live query onto them, rather than
// changing a token underneath an open socket. A refresh runs at 80% of the token's life, and
// again whenever a request comes back `UNAUTHENTICATED`, which is what a tab that slept through
// its timer sees first.
//
// With `jwt` (an app with `auth` in its config) the session is the signed-in account's instead of
// this browser's, so the same person gets the same database on every device. Every session request
// asks the `jwt` function again, so a renewal carries the provider's current token.

import { createClient, type Client, type Db } from "../client/index.ts"
import type { JsRow } from "../client/values.ts"
import { type State, StateStore } from "./state.ts"
import { type Doc, type LiveDiff, type Statement, Table, createTableSql } from "./table.ts"

export { Table, View, uuidv7 } from "./table.ts"
export type { Direction, Doc, Filter, Json, Row, SharedRow } from "./table.ts"
export type { State, StateApi } from "./state.ts"

export interface ConnectOptions {
  /** The bql.sh server. Default: the page's own origin. */
  url?: string
  /**
   * The visitor id, 22 to 128 characters of `[A-Za-z0-9_-]`. Default: one generated once and
   * kept in `localStorage`, so the same browser gets the same database. Anyone holding it gets
   * that visitor's data, so treat it like a password if you pass your own.
   */
  visitor?: string
  /**
   * The signed-in user's JWT from the app's provider (Clerk, Supabase, Better-Auth), or a function
   * returning the current one. A function is called for every session request, renewals included.
   * The connection stays that account's: on sign-in or sign-out, `close()` and `connect()` again.
   */
  jwt?: string | (() => string | null | undefined | Promise<string | null | undefined>)
  fetch?: typeof fetch
  /** A `WebSocket` for runtimes without one on the global object. */
  WebSocket?: unknown
  /** Where a failure with nowhere else to go is reported. Default `console.error`. */
  onError?: (err: unknown) => void
}

export interface SessionInfo {
  private: { db: string; token: string }
  shared: { db: string; token: string } | null
  exp: number
  /** With `jwt`: this browser's anonymous database, when it holds data. */
  anonymous?: { db: string; token: string } | null
}

/** Runs one statement on a database the session can reach; returns the rows. */
export interface SqlRunner {
  <T = JsRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
}

/**
 * A live query on raw SQL. Without `key()` every change delivers the whole result as `rows`; with
 * one, the first event is `rows` and each change after it a `diff` keyed on that column. A
 * session renewal re-subscribes on the new tokens, which delivers `rows` again: treat every
 * `rows` as the full list.
 */
export interface LiveSql<T = JsRow> {
  /** The column that identifies a row, which switches the feed to diffs. Call before the first tick. */
  key(column: string): this
  on(event: "rows", listener: (rows: T[]) => void): this
  on(event: "diff", listener: (diff: { added: T[]; removed: T[]; updated: T[] }) => void): this
  on(event: "error", listener: (err: unknown) => void): this
  close(): void
}

export interface LiveRunner {
  <T = JsRow>(strings: TemplateStringsArray, ...values: unknown[]): LiveSql<T>
}

/** The app's shared database: the tables its config lists, in the mode each is given. */
export interface SharedDb {
  readonly db: string
  readonly sql: SqlRunner
  readonly live: LiveRunner
  /**
   * A table the owner created with `bql app table`; the page never creates one here. Rows carry
   * `author` (`SharedRow`), which the server fills in and checks, and only a row's author can
   * update or delete it.
   */
  table<T extends Doc = Doc>(name: string): Table<T>
}

/** This browser's anonymous database, offered once the visitor signs in. */
export interface AnonymousDb {
  readonly db: string
  readonly sql: SqlRunner
  /**
   * Moves the anonymous data into the account's database: every table is created there if missing
   * and its rows copied with `insert or ignore`, so the account's rows win on a key clash and a
   * second run is harmless. The copied tables are then dropped from the anonymous database and
   * this browser's visitor id forgotten, so the next signed-out visit starts empty.
   */
  adopt(): Promise<{ tables: string[]; rows: number }>
}

export interface ActionResult<T = JsRow> {
  /** A SQL action: one entry per statement in its `run`, in order. */
  results?: { rows: T[]; rowsAffected: number }[]
  txid?: number
  /** A `url` action: the function's JSON answer. */
  result?: unknown
}

export interface WebDb {
  /** The id this browser is known by; null for a signed-in session. */
  readonly visitor: string | null
  /** True when the session is a signed-in account's (`jwt`), the same database on every device. */
  readonly signedIn: boolean
  /**
   * With `jwt`: the database this browser used before signing in, when it holds data, for the page
   * to copy from or `adopt()`. Null otherwise. Left alone, it is there again after sign-out.
   */
  readonly anonymous: AnonymousDb | null
  /** The visitor's own database, `app-<id>-u-<hash>`. */
  readonly db: string
  /**
   * The page's state as one object to mutate in place, loaded from the visitor's database and kept
   * there and in step across tabs. `defaults` fills keys never written. Assigning a field, `push`
   * and `delete` each become one JSON operation on the server; `$on("change")` fires after local
   * and remote changes alike.
   */
  state<T extends Record<string, import("./state.ts").Json>>(defaults: T): Promise<State<T>>
  /** A table in the visitor's database, created on first use. */
  table<T extends Doc = Doc>(name: string): Table<T>
  /** Raw SQL on the visitor's database. */
  readonly sql: SqlRunner
  /** A live query on the visitor's database. */
  readonly live: LiveRunner
  /** The app's shared database, or null when the app declares no tables visitors can see. */
  readonly shared: SharedDb | null
  /**
   * The id this visitor's rows carry in a shared table's `author` column: a hash of the visitor
   * id, safe to show. Compare a row's `author` with it to tell your rows from others'.
   */
  readonly author: string
  /**
   * Runs one of the app's actions: SQL from the app's config, run by the server with its own
   * rights, given `input` checked against the action's schema. Resolves with each statement's rows;
   * rejects with the server's `code` (`CONFLICT` and the action's `error` when an `expect` fails).
   */
  action<T = JsRow>(name: string, input?: Record<string, unknown>): Promise<ActionResult<T>>
  /** Fetches a new session now. Live queries carry on over the new tokens. */
  refresh(): Promise<void>
  /** Stops refreshing and closes every connection and live query. */
  close(): void
}

const VISITOR = /^[A-Za-z0-9_-]{22,128}$/
const REFRESH_AT = 0.8
const MIN_REFRESH_MS = 30_000

function base64url(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function storage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null // storage blocked: a private window, a sandboxed iframe
  }
}

function storedVisitor(url: string): string | null {
  try {
    const stored = storage()?.getItem(`bql:visitor:${url}`)
    if (stored && VISITOR.test(stored)) return stored
  } catch {
    // unreadable storage
  }
  return null
}

function forgetVisitor(url: string, visitor: string): void {
  try {
    const store = storage() as Storage | null
    if (store?.getItem(`bql:visitor:${url}`) === visitor) store.removeItem(`bql:visitor:${url}`)
  } catch {
    // nothing stored, or storage blocked
  }
}

/** The stored visitor id for this server, or a new one, stored when storage allows it. */
function visitorFor(url: string): string {
  const key = `bql:visitor:${url}`
  const store = storage()
  const stored = storedVisitor(url)
  if (stored) return stored
  const fresh = base64url(crypto.getRandomValues(new Uint8Array(16)))
  try {
    store?.setItem(key, fresh)
  } catch {
    // the id lasts this page load only
  }
  return fresh
}

function codeOf(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : null
}

function errorFrom(status: number, body: unknown): Error {
  const error = (body as { error?: { code?: string; message?: string } })?.error
  return Object.assign(new Error(error?.message ?? `session request failed with ${status}`), {
    code: error?.code ?? "SESSION_FAILED",
    status,
  })
}

type Which = "private" | "shared" | "anonymous"

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** A statement with no values: `Statement` is template parts, so a literal is one part. */
function text(sql: string): Statement {
  return { strings: [sql], values: [] }
}

const ADOPT_PAGE = 500
const ADOPT_CHUNK = 100

interface LiveHandle {
  statement: Statement
  db: "private" | "shared"
  key: string | null
  onRows: (rows: JsRow[]) => void
  onDiff: (diff: LiveDiff) => void
  onError: (err: unknown) => void
  stop: (() => void) | null
}

class Connection implements WebDb {
  /** Sent with every session request; with `jwt` it only names the anonymous database to offer. */
  #visitor: string | null
  readonly #key: string
  readonly #url: string
  readonly #options: ConnectOptions
  #session!: SessionInfo
  #private!: Client
  #sharedClient: Client | null = null
  #anonymousClient: Client | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #refreshing: Promise<void> | null = null
  #closed = false
  readonly #live = new Set<LiveHandle>()
  readonly #ensured = new Map<string, Promise<void>>()
  readonly sql: SqlRunner
  readonly live: LiveRunner
  readonly #sharedSql: SqlRunner
  readonly #sharedLive: LiveRunner

  constructor(key: string, url: string, visitor: string | null, options: ConnectOptions) {
    this.#key = key
    this.#url = url
    this.#visitor = visitor
    this.#options = options
    this.sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      this.#run("private", { strings: [...strings], values })) as SqlRunner
    this.#sharedSql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      this.#run("shared", { strings: [...strings], values })) as SqlRunner
    this.live = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      this.#liveSql("private", { strings: [...strings], values })) as LiveRunner
    this.#sharedLive = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      this.#liveSql("shared", { strings: [...strings], values })) as LiveRunner
  }

  get db(): string {
    return this.#session.private.db
  }

  get visitor(): string | null {
    return this.signedIn ? null : this.#visitor
  }

  get signedIn(): boolean {
    return this.#options.jwt !== undefined
  }

  get anonymous(): AnonymousDb | null {
    const anonymous = this.#session.anonymous
    if (!anonymous) return null
    return {
      db: anonymous.db,
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) =>
        this.#run("anonymous", { strings: [...strings], values })) as SqlRunner,
      adopt: () => this.#adopt(),
    }
  }

  get shared(): WebDb["shared"] {
    const shared = this.#session.shared
    if (!shared) return null
    return {
      db: shared.db,
      sql: this.#sharedSql,
      live: this.#sharedLive,
      table: <T extends Doc = Doc>(name: string) =>
        new Table<T>(
          {
            shared: true,
            run: (statement) => this.#run("shared", statement),
            live: (statement, onRows, onDiff, onError) =>
              this.#subscribe({ statement, db: "shared", key: "id", onRows, onDiff, onError, stop: null }),
            ensure: async () => {},
          },
          name,
        ),
    }
  }

  get author(): string {
    const payload = (this.#session.private.token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/")
    return String((JSON.parse(atob(payload)) as { sub?: string }).sub ?? "")
  }

  async state<T extends Record<string, import("./state.ts").Json>>(defaults: T): Promise<State<T>> {
    const store = new StateStore<T>(
      {
        run: (statement) => this.#run("private", statement),
        live: (statement, onRows, onDiff, onError) =>
          this.#subscribe({ statement, db: "private", key: "key", onRows, onDiff, onError, stop: null }),
        report: (err) => this.#report(err),
      },
      defaults,
    )
    await store.open()
    return store.root
  }

  table<T extends Doc = Doc>(name: string): Table<T> {
    return new Table<T>(
      {
        shared: false,
        run: (statement) => this.#run("private", statement),
        live: (statement, onRows, onDiff, onError) => this.#subscribe({ statement, db: "private", key: "id", onRows, onDiff, onError, stop: null }),
        ensure: (table) => this.#ensure(table),
      },
      name,
    )
  }

  async open(): Promise<void> {
    await this.#swap(await this.#fetchSession())
  }

  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#refreshing ??= this.#fetchSession()
      .then((session) => this.#swap(session))
      .finally(() => {
        this.#refreshing = null
      })
    return this.#refreshing
  }

  async action<T = JsRow>(name: string, input: Record<string, unknown> = {}): Promise<ActionResult<T>> {
    const once = async (): Promise<ActionResult<T>> => {
      const doFetch = this.#options.fetch ?? fetch
      const response = await doFetch(`${this.#url}/v1/session/action`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#session.private.token}`, "content-type": "application/json" },
        body: JSON.stringify({ key: this.#key, name, input }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw errorFrom(response.status, body)
      return body as ActionResult<T>
    }
    try {
      return await once()
    } catch (err) {
      if (codeOf(err) !== "UNAUTHENTICATED" || this.#closed) throw err
      await this.refresh()
      return once()
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    for (const handle of this.#live) handle.stop?.()
    this.#live.clear()
    this.#private?.close()
    this.#sharedClient?.close()
    this.#anonymousClient?.close()
  }

  async #fetchSession(): Promise<SessionInfo> {
    const doFetch = this.#options.fetch ?? fetch
    const request: { key: string; visitor?: string; jwt?: string } = { key: this.#key }
    if (this.#visitor !== null) request.visitor = this.#visitor
    if (this.#options.jwt !== undefined) {
      const jwt = typeof this.#options.jwt === "function" ? await this.#options.jwt() : this.#options.jwt
      if (!jwt) {
        throw Object.assign(new Error("jwt() returned no token: signed out? close() and connect() again"), { code: "SIGNED_OUT" })
      }
      request.jwt = jwt
    }
    // `text/plain` keeps this a simple request: no CORS preflight before the first byte.
    const response = await doFetch(`${this.#url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(request),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw errorFrom(response.status, body)
    return body as SessionInfo
  }

  #client(token: string): Client {
    return createClient({
      url: this.#url,
      token,
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.WebSocket !== undefined ? { WebSocket: this.#options.WebSocket } : {}),
      onError: (err) => this.#report(err),
    })
  }

  async #swap(session: SessionInfo): Promise<void> {
    const old = [this.#private, this.#sharedClient, this.#anonymousClient]
    this.#session = session
    this.#private = this.#client(session.private.token)
    this.#sharedClient = session.shared ? this.#client(session.shared.token) : null
    this.#anonymousClient = session.anonymous ? this.#client(session.anonymous.token) : null
    // New subscriptions first, then the old ones go: the first `rows` on the new client replaces
    // the list wholesale, so a commit between the two is not lost.
    for (const handle of this.#live) {
      const previous = handle.stop
      handle.stop = this.#open(handle)
      previous?.()
    }
    for (const client of old) client?.close()
    this.#schedule()
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer)
    if (this.#closed) return
    const leftMs = this.#session.exp * 1000 - Date.now()
    const waitMs = Math.max(MIN_REFRESH_MS, leftMs * REFRESH_AT)
    this.#timer = setTimeout(() => {
      this.refresh().catch((err) => this.#report(err))
    }, waitMs)
    ;(this.#timer as { unref?: () => void }).unref?.()
  }

  #dbOf(which: Which): Db {
    if (which === "private") return this.#private.db(this.#session.private.db)
    if (which === "anonymous") {
      const anonymous = this.#session.anonymous
      if (!anonymous || !this.#anonymousClient) throw new Error("there is no anonymous database to read")
      return this.#anonymousClient.db(anonymous.db)
    }
    const shared = this.#session.shared
    if (!shared || !this.#sharedClient) throw new Error("this app has no shared tables")
    return this.#sharedClient.db(shared.db)
  }

  async #run(which: Which, statement: Statement): Promise<JsRow[]> {
    const once = async () =>
      [...(await this.#dbOf(which).sql(statement.strings as unknown as TemplateStringsArray, ...statement.values))] as JsRow[]
    try {
      return await once()
    } catch (err) {
      if (codeOf(err) !== "UNAUTHENTICATED" || this.#closed) throw err
      await this.refresh()
      return once()
    }
  }

  async #adopt(): Promise<{ tables: string[]; rows: number }> {
    const from = (statement: Statement) => this.#run("anonymous", statement)
    const to = (statement: Statement) => this.#run("private", statement)
    // `pragma_table_list` tells shadow tables (FTS5's `_data`, `_idx`) and virtual tables apart
    // from plain ones; copying either would be wrong, and the virtual table's own DDL is not copied.
    const tables = (await from(
      text(`select l.name, s.sql from pragma_table_list as l join sqlite_schema as s on s.name = l.name
            where l.schema = 'main' and l.type = 'table' and substr(l.name, 1, 7) <> 'sqlite_'`),
    )) as { name: string; sql: string }[]
    const columns = async (run: typeof from, table: string) =>
      ((await run({ strings: ["select name from pragma_table_info(", ")"], values: [table] })) as { name: string }[]).map((c) => c.name)
    let rows = 0
    for (const { name, sql } of tables) {
      // The stored DDL always starts `CREATE TABLE `, with any `IF NOT EXISTS` already removed.
      await to(text(sql.replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ")))
      const theirs = new Set(await columns(to, name))
      const shared = (await columns(from, name)).filter((column) => theirs.has(column))
      if (shared.length === 0) continue
      const list = shared.map(ident).join(", ")
      for (let offset = 0; ; offset += ADOPT_PAGE) {
        const page = await from({ strings: [`select ${list} from ${ident(name)} limit ${ADOPT_PAGE} offset ${offset}`], values: [] })
        for (let i = 0; i < page.length; i += ADOPT_CHUNK) {
          const chunk = page.slice(i, i + ADOPT_CHUNK)
          const strings = [`insert or ignore into ${ident(name)} (${list}) values (`]
          const values: unknown[] = []
          chunk.forEach((row, r) => {
            shared.forEach((column, c) => {
              values.push(row[column])
              strings.push(c < shared.length - 1 ? ", " : r < chunk.length - 1 ? "), (" : ")")
            })
          })
          await to({ strings, values })
        }
        rows += page.length
        if (page.length < ADOPT_PAGE) break
      }
    }
    for (const { name } of tables) await from(text(`drop table if exists ${ident(name)}`))
    if (this.#visitor !== null) forgetVisitor(this.#url, this.#visitor)
    this.#visitor = null
    this.#session = { ...this.#session, anonymous: null }
    this.#anonymousClient?.close()
    this.#anonymousClient = null
    return { tables: tables.map((one) => one.name), rows }
  }

  #ensure(table: string): Promise<void> {
    let ready = this.#ensured.get(table)
    if (!ready) {
      ready = this.#run("private", { strings: [createTableSql(table)], values: [] }).then(() => {})
      ready.catch(() => this.#ensured.delete(table))
      this.#ensured.set(table, ready)
    }
    return ready
  }

  #subscribe(handle: LiveHandle): () => void {
    this.#live.add(handle)
    handle.stop = this.#open(handle)
    return () => {
      this.#live.delete(handle)
      handle.stop?.()
      handle.stop = null
    }
  }

  /** `db.live`: listeners attach synchronously, the subscription starts on the next microtask. */
  #liveSql<T>(db: "private" | "shared", statement: Statement): LiveSql<T> {
    const listeners = { rows: new Set<(rows: T[]) => void>(), diff: new Set<(diff: LiveDiff) => void>(), error: new Set<(err: unknown) => void>() }
    let stop: (() => void) | null = null
    let started = false
    let closed = false
    const handle: LiveHandle = {
      statement,
      db,
      key: null,
      onRows: (rows) => listeners.rows.forEach((fn) => fn(rows as T[])),
      onDiff: (diff) => listeners.diff.forEach((fn) => fn(diff)),
      onError: (err) => {
        if (listeners.error.size === 0) this.#report(err)
        listeners.error.forEach((fn) => fn(err))
      },
      stop: null,
    }
    queueMicrotask(() => {
      started = true
      if (closed) return
      try {
        stop = this.#subscribe(handle)
      } catch (err) {
        handle.onError(err)
      }
    })
    const live: LiveSql<T> = {
      key(column) {
        if (started) throw new Error("key() must be called before the subscription starts")
        handle.key = column
        return live
      },
      on(event: "rows" | "diff" | "error", listener: (payload: never) => void) {
        ;(listeners[event] as Set<unknown>).add(listener)
        return live
      },
      close() {
        closed = true
        stop?.()
      },
    } as LiveSql<T>
    return live
  }

  #open(handle: LiveHandle): () => void {
    const query = this.#dbOf(handle.db).live(
      handle.statement.strings as unknown as TemplateStringsArray,
      ...handle.statement.values,
    )
    if (handle.key !== null) query.key(handle.key)
    query.on("rows", (event) => handle.onRows(event.rows))
    query.on("diff", (event) => handle.onDiff(event))
    query.on("error", (err) => {
      if (codeOf(err) === "UNAUTHENTICATED" && !this.#closed) {
        this.refresh().catch((refreshErr) => handle.onError(refreshErr))
      } else handle.onError(err)
    })
    return () => query.close()
  }

  #report(err: unknown): void {
    if (this.#options.onError) this.#options.onError(err)
    else console.error("bql:", err)
  }
}

/**
 * Opens a session for this browser, or with `jwt` for the signed-in account, on the app the `pk_`
 * key names. Rejects with the server's error (`code` is `NOT_AUTHORIZED` for an origin the app does
 * not list, `TOO_MANY_REQUESTS` past the new-visitor limit, `UNAUTHENTICATED` for a JWT the app's
 * provider did not sign or an app that requires sign-in).
 */
export async function connect(key: string, options: ConnectOptions = {}): Promise<WebDb> {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  const url = (options.url ?? origin ?? "").replace(/\/+$/, "")
  if (!url) throw new TypeError("connect() needs { url } outside a browser page")
  if (options.visitor !== undefined && !VISITOR.test(options.visitor)) {
    throw new TypeError("visitor must be 22 to 128 characters of [A-Za-z0-9_-]")
  }
  // Signed in, the stored id is sent only to find the anonymous database, and none is made up.
  const visitor = options.visitor ?? (options.jwt !== undefined ? storedVisitor(url) : visitorFor(url))
  const connection = new Connection(key, url, visitor, options)
  await connection.open()
  return connection
}
