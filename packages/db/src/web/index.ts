// `bql.sh/web` (docs/plan-web.md): what a static page imports to get a database with no server of
// its own. `connect()` trades the app's public `pk_` key and a visitor id for a session
// (`POST /v1/session`) and hands back the visitor's private database as `table()` and `sql`.
//
// Session tokens expire (`session.ttlMs`, an hour by default), and a client's token is fixed when
// it is built. So a refresh builds new clients and moves every live query onto them, rather than
// changing a token underneath an open socket. A refresh runs at 80% of the token's life, and
// again whenever a request comes back `UNAUTHENTICATED`, which is what a tab that slept through
// its timer sees first.

import { createClient, type Client, type Db } from "../client/index.ts"
import type { JsRow } from "../client/values.ts"
import { type Doc, type LiveDiff, type Statement, Table, createTableSql } from "./table.ts"

export { Table, View, uuidv7 } from "./table.ts"
export type { Direction, Doc, Filter, Json, Row } from "./table.ts"

export interface ConnectOptions {
  /** The bql.sh server. Default: the page's own origin. */
  url?: string
  /**
   * The visitor id, 22 to 128 characters of `[A-Za-z0-9_-]`. Default: one generated once and
   * kept in `localStorage`, so the same browser gets the same database. Anyone holding it gets
   * that visitor's data, so treat it like a password if you pass your own.
   */
  visitor?: string
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
}

/** Runs one statement on a database the session can reach; returns the rows. */
export interface SqlRunner {
  <T = JsRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
}

export interface WebDb {
  /** The id this browser is known by. */
  readonly visitor: string
  /** The visitor's own database, `app-<id>-u-<hash>`. */
  readonly db: string
  /** A table in the visitor's database, created on first use. */
  table<T extends Doc = Doc>(name: string): Table<T>
  /** Raw SQL on the visitor's database. */
  readonly sql: SqlRunner
  /** The app's shared database, or null when the app declares no tables visitors can see. */
  readonly shared: { readonly db: string; readonly sql: SqlRunner } | null
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

/** The stored visitor id for this server, or a new one, stored when storage allows it. */
function visitorFor(url: string): string {
  const key = `bql:visitor:${url}`
  const store = storage()
  try {
    const stored = store?.getItem(key)
    if (stored && VISITOR.test(stored)) return stored
  } catch {
    // unreadable storage: fall through to a new id for this page load
  }
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

interface LiveHandle {
  statement: Statement
  db: "private" | "shared"
  onRows: (rows: JsRow[]) => void
  onDiff: (diff: LiveDiff) => void
  onError: (err: unknown) => void
  stop: (() => void) | null
}

class Connection implements WebDb {
  readonly visitor: string
  readonly #key: string
  readonly #url: string
  readonly #options: ConnectOptions
  #session!: SessionInfo
  #private!: Client
  #sharedClient: Client | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #refreshing: Promise<void> | null = null
  #closed = false
  readonly #live = new Set<LiveHandle>()
  readonly #ensured = new Map<string, Promise<void>>()
  readonly sql: SqlRunner
  readonly #sharedSql: SqlRunner

  constructor(key: string, url: string, visitor: string, options: ConnectOptions) {
    this.#key = key
    this.#url = url
    this.visitor = visitor
    this.#options = options
    this.sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      this.#run("private", { strings: [...strings], values })) as SqlRunner
    this.#sharedSql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      this.#run("shared", { strings: [...strings], values })) as SqlRunner
  }

  get db(): string {
    return this.#session.private.db
  }

  get shared(): WebDb["shared"] {
    const shared = this.#session.shared
    return shared ? { db: shared.db, sql: this.#sharedSql } : null
  }

  table<T extends Doc = Doc>(name: string): Table<T> {
    return new Table<T>(
      {
        run: (statement) => this.#run("private", statement),
        live: (statement, onRows, onDiff, onError) => this.#subscribe({ statement, db: "private", onRows, onDiff, onError, stop: null }),
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

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    for (const handle of this.#live) handle.stop?.()
    this.#live.clear()
    this.#private?.close()
    this.#sharedClient?.close()
  }

  async #fetchSession(): Promise<SessionInfo> {
    const doFetch = this.#options.fetch ?? fetch
    // `text/plain` keeps this a simple request: no CORS preflight before the first byte.
    const response = await doFetch(`${this.#url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ key: this.#key, visitor: this.visitor }),
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
    const old = [this.#private, this.#sharedClient]
    this.#session = session
    this.#private = this.#client(session.private.token)
    this.#sharedClient = session.shared ? this.#client(session.shared.token) : null
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

  #dbOf(which: "private" | "shared"): Db {
    if (which === "private") return this.#private.db(this.#session.private.db)
    const shared = this.#session.shared
    if (!shared || !this.#sharedClient) throw new Error("this app has no shared tables")
    return this.#sharedClient.db(shared.db)
  }

  async #run(which: "private" | "shared", statement: Statement): Promise<JsRow[]> {
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

  #open(handle: LiveHandle): () => void {
    const query = this.#dbOf(handle.db)
      .live(handle.statement.strings as unknown as TemplateStringsArray, ...handle.statement.values)
      .key("id")
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
 * Opens a session for this browser on the app the `pk_` key names. Rejects with the server's
 * error (`code` is `NOT_AUTHORIZED` for an origin the app does not list, `TOO_MANY_REQUESTS` past
 * the new-visitor limit).
 */
export async function connect(key: string, options: ConnectOptions = {}): Promise<WebDb> {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  const url = (options.url ?? origin ?? "").replace(/\/+$/, "")
  if (!url) throw new TypeError("connect() needs { url } outside a browser page")
  if (options.visitor !== undefined && !VISITOR.test(options.visitor)) {
    throw new TypeError("visitor must be 22 to 128 characters of [A-Za-z0-9_-]")
  }
  const connection = new Connection(key, url, options.visitor ?? visitorFor(url), options)
  await connection.open()
  return connection
}
