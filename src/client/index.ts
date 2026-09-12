// The client SDK of design §9.1. Runs in browsers, Bun, Node and Workers: nothing below imports
// anything from Bun or Node, and the only globals used are `fetch`, `WebSocket`, `ReadableStream`,
// `TextDecoder`, `AbortController` and the base64 pair.
//
// Invariant: one-shot statements go over HTTP and the socket is opened lazily, for subscriptions
// and interactive transactions (design §9.1). A client that never subscribes never opens one.
//
// Second invariant: `consistency: "ryw"` is bookkeeping, not a request option. The highest txid
// this client has seen for a database — from a result, a change event or a live result — travels
// as `BunQL-Min-Txid` on the next request to it, which is exactly what design §5.4 asks a client
// to do.

import { BunQLClientError, asClientError } from "./errors.ts"
import {
  ChangeFeed,
  LiveQuery,
  decodeChangeEvent,
  decodeLiveDiff,
  decodeLiveRows,
  type ChangeSink,
  type LiveSink,
} from "./feed.ts"
import {
  HttpClient,
  normalizeBase,
  socketUrl,
  type FetchLike,
} from "./http.ts"
import type {
  Ack,
  BatchResult,
  ChangeEvent,
  Consistency,
  IncludeLevel,
  LiveDiffEvent,
  LiveRowsEvent,
  QueryResult,
  RequestOptions,
  ResetEvent,
  RowsMode,
  StatementRequest,
  TxBeginResult,
  TxMode,
  TxResult,
} from "./protocol.ts"
import { HEADERS } from "./protocol.ts"
import { SocketClient, defaultWebSocketFactory, type WebSocketFactory } from "./socket.ts"
import { SseSubscription } from "./stream.ts"
import {
  Query,
  fromArgs,
  fromTemplate,
  toResult,
  type QueryArgs,
  type Result,
  type Runner,
} from "./sql.ts"
import type { IntMode, JsRow } from "./values.ts"

export interface ClientOptions {
  /** Base URL of the server, `https://sql.example.com`. `ws(s)://` is accepted and rewritten. */
  url: string
  /** Bearer token, or the admin key. Omit for a server with no auth configured. */
  token?: string
  /** Database `client.db()` returns when called with no name. */
  db?: string
  /** `"ryw"` (default) tracks txids per database; `"primary"` and `"any"` travel per request. */
  consistency?: Consistency
  fetch?: FetchLike
  /** A `WebSocket` implementation for runtimes without one on the global object. */
  WebSocket?: unknown
  /** What an integer beyond 2^53 becomes. `"number"` (default) throws rather than round. */
  intMode?: IntMode
  /** Headers added to every HTTP request. */
  headers?: Record<string, string>
  /** Delay before a dropped subscription or socket is re-opened. Default 1000 ms. */
  retryMs?: number
  /** Where a failure with nowhere else to go is reported. */
  onError?: (err: unknown) => void
}

/** The template tag of design §9.1: the values become bound parameters, never SQL. */
export interface SqlTag {
  <T = JsRow>(strings: TemplateStringsArray, ...values: unknown[]): Query<T>
}

export interface StmtTag {
  (strings: TemplateStringsArray, ...values: unknown[]): StatementRequest
}

export interface LiveTag {
  <T = JsRow>(strings: TemplateStringsArray, ...values: unknown[]): LiveQuery<T>
}

/** Options a single statement may carry (design §6, "common request options"). */
export interface StatementOptions {
  ack?: Ack
  timeoutMs?: number
  maxRows?: number
  minTxid?: number
  consistency?: Consistency
}

export interface BatchOptions extends StatementOptions {
  /** One transaction that rolls back as a whole. Default true (design §6.2). */
  atomic?: boolean
  rows?: RowsMode
}

export type BatchItem = StatementRequest | Query<unknown> | { toJSON(): StatementRequest }

export interface ChangesOptions {
  tables?: string[]
  /** Replay from this txid. Defaults to the database's txid when the feed opens. */
  since?: number
  include?: IncludeLevel
  retryMs?: number
}

export interface TransactionOptions {
  mode?: TxMode
  /** `"ws"` uses the socket's `tx.*` (design §7); `"http"` uses the baton of §6.3. */
  via?: "ws" | "http"
  ack?: Ack
}

/** A statement runner inside an open transaction. */
export interface Tx {
  readonly db: string
  readonly sql: SqlTag
  readonly stmt: StmtTag
  execute(sql: string, args?: QueryArgs, options?: StatementOptions): Query
  unsafe(sql: string, args?: QueryArgs, options?: StatementOptions): Query
}

/** One database, over whichever transport the operation needs (design §9.1). */
export interface Db {
  readonly name: string
  /** Highest txid this client has seen for this database. */
  readonly txid: number
  readonly sql: SqlTag
  readonly stmt: StmtTag
  readonly live: LiveTag
  execute(sql: string, args?: QueryArgs, options?: StatementOptions): Query
  unsafe(sql: string, args?: QueryArgs, options?: StatementOptions): Query
  batch(items: BatchItem[], options?: BatchOptions): Promise<Result<JsRow>[]>
  transaction<T>(fn: (tx: Tx) => Promise<T> | T, options?: TransactionOptions): Promise<T>
  changes(options?: ChangesOptions): ChangeFeed
}

export interface Client {
  readonly url: string
  db(name?: string): Db
  /** Last txid this client observed for `db`; what `consistency: "ryw"` sends. */
  txid(db: string): number
  close(): void
}

/** Shared state: the transports, the options and the per-database txid table. */
interface Core {
  http: HttpClient
  socket: SocketClient
  options: Required<Pick<ClientOptions, "consistency" | "intMode" | "retryMs">> & ClientOptions
  txids: Map<string, number>
  observe(db: string, txid: number | undefined): void
  minTxidFor(db: string, options?: StatementOptions): number | undefined
  headers(): Record<string, string>
  report(err: unknown): void
}

function statementBody(
  request: StatementRequest,
  rows: RowsMode,
  options: StatementOptions | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { sql: request.sql, rows }
  if (request.args !== undefined) body.args = request.args
  if (options?.ack !== undefined) body.ack = options.ack
  if (options?.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs
  if (options?.maxRows !== undefined) body.maxRows = options.maxRows
  if (options?.consistency !== undefined && options.consistency !== "ryw") {
    body.consistency = options.consistency
  }
  return body
}

function asStatement(item: BatchItem): StatementRequest {
  const candidate = item as { toJSON?: () => StatementRequest; sql?: unknown }
  const statement = typeof candidate.toJSON === "function" ? candidate.toJSON() : item
  const sql = (statement as StatementRequest).sql
  if (typeof sql !== "string" || sql.length === 0) {
    throw BunQLClientError.client("every batch item needs a non-empty sql string")
  }
  return statement as StatementRequest
}

class RemoteDb implements Db {
  readonly name: string
  readonly sql: SqlTag
  readonly stmt: StmtTag
  readonly live: LiveTag

  #core: Core

  constructor(core: Core, name: string) {
    this.#core = core
    this.name = name
    this.sql = ((strings, ...values) =>
      new Query(this.#httpRunner(), fromTemplate(strings, values), core.options.intMode)) as SqlTag
    this.stmt = ((strings, ...values) => fromTemplate(strings, values)) as StmtTag
    this.live = ((strings, ...values) => {
      const request = fromTemplate(strings, values)
      return new LiveQuery((sink, options) => this.#startLive(sink, request, options.key))
    }) as LiveTag
  }

  get txid(): number {
    return this.#core.txids.get(this.name) ?? 0
  }

  execute(sql: string, args?: QueryArgs, options?: StatementOptions): Query {
    return new Query(
      this.#httpRunner(),
      fromArgs(sql, args),
      this.#core.options.intMode,
      options as RequestOptions,
    )
  }

  unsafe(sql: string, args?: QueryArgs, options?: StatementOptions): Query {
    return this.execute(sql, args, options)
  }

  async batch(items: BatchItem[], options: BatchOptions = {}): Promise<Result<JsRow>[]> {
    const statements = items.map(asStatement)
    if (statements.length === 0) {
      throw BunQLClientError.client("batch needs at least one statement")
    }
    const body: Record<string, unknown> = {
      statements,
      rows: options.rows ?? "object",
      ...(options.atomic === false ? { atomic: false } : {}),
      ...(options.ack !== undefined ? { ack: options.ack } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
    }
    const result = await this.#core.http.json<BatchResult>(`/v1/db/${this.name}/batch`, {
      method: "POST",
      body,
      ...(this.#minTxid(options) !== undefined ? { minTxid: this.#minTxid(options) } : {}),
    })
    this.#core.observe(this.name, result.txid)
    return result.results.map((wire, index) =>
      toResult<JsRow>(wire, statements[index]?.sql ?? "", this.#core.options.intMode),
    )
  }

  /**
   * Design §9.1: the socket's `tx.*` when there is one to be had, the HTTP baton of §6.3 when
   * there is not. Either way the callback's throw rolls the transaction back.
   */
  async transaction<T>(
    fn: (tx: Tx) => Promise<T> | T,
    options: TransactionOptions = {},
  ): Promise<T> {
    const via = options.via ?? (this.#core.socket.available ? "ws" : "http")
    if (via === "ws") {
      try {
        return await this.#wsTransaction(fn, options)
      } catch (err) {
        // A socket that cannot be opened is a transport problem, not the caller's: fall back to
        // the baton rather than failing a transaction the server would have accepted.
        if (err instanceof BunQLClientError && err.code === "CLIENT" && !options.via) {
          return await this.#httpTransaction(fn, options)
        }
        throw err
      }
    }
    return this.#httpTransaction(fn, options)
  }

  changes(options: ChangesOptions = {}): ChangeFeed {
    const core = this.#core
    return new ChangeFeed((sink: ChangeSink) => {
      let since = options.since
      const subscription = new SseSubscription({
        fetchImpl: core.options.fetch ?? fetch,
        what: `changes on ${this.name}`,
        retryMs: options.retryMs ?? core.options.retryMs,
        url: () => {
          const params = new URLSearchParams()
          if (options.tables?.length) params.set("tables", options.tables.join(","))
          if (options.include) params.set("include", options.include)
          if (since !== undefined) params.set("since", String(since))
          const query = params.toString()
          return core.http.url(`/v1/db/${this.name}/changes${query ? `?${query}` : ""}`)
        },
        headers: () => core.headers(),
        onOpen: (response) => {
          // Without a `since` of its own, the feed takes the database's current position from the
          // response header, so a reconnect resumes from there rather than from "now".
          if (since !== undefined) return
          const header = Number(response.headers.get(HEADERS.txid) ?? "")
          if (Number.isFinite(header) && header >= 0) since = header
        },
        onFrame: (frame) => {
          if (frame.data.length === 0) return
          let payload: unknown
          try {
            payload = JSON.parse(frame.data)
          } catch (err) {
            sink.error(asClientError(err, "a change event that is not JSON"))
            return
          }
          if (frame.event === "change") {
            const event = payload as ChangeEvent
            since = Math.max(since ?? 0, event.txid)
            core.observe(this.name, event.txid)
            sink.change(decodeChangeEvent(event, core.options.intMode))
            return
          }
          if (frame.event === "reset") {
            const event = payload as ResetEvent
            since = Math.max(since ?? 0, event.txid)
            sink.reset(event)
          }
        },
        onError: (err) => sink.error(err),
      })
      subscription.start()
      return () => subscription.close()
    })
  }

  // -------------------------------------------------------------------------

  #minTxid(options?: StatementOptions): number | undefined {
    return this.#core.minTxidFor(this.name, options)
  }

  /** One statement over HTTP (design §6.1), with the txid bookkeeping around it. */
  #httpRunner(): Runner {
    return async (request, rows, options) => {
      const statement = options as StatementOptions | undefined
      const minTxid = this.#minTxid(statement)
      const wire = await this.#core.http.json<QueryResult>(`/v1/db/${this.name}/query`, {
        method: "POST",
        body: statementBody(request, rows, statement),
        ...(minTxid !== undefined ? { minTxid } : {}),
      })
      this.#core.observe(this.name, wire.txid)
      return wire
    }
  }

  async #wsTransaction<T>(
    fn: (tx: Tx) => Promise<T> | T,
    options: TransactionOptions,
  ): Promise<T> {
    const socket = this.#core.socket
    const begun = await socket.request<{ tx: string }>({
      op: "tx.begin",
      db: this.name,
      ...(options.mode ? { mode: options.mode } : {}),
    })
    const baton = begun.tx
    const runner: Runner = async (request, rows, statementOptions) => {
      const reply = await socket.request<{ result: QueryResult }>({
        op: "query",
        tx: baton,
        ...statementBody(request, rows, statementOptions as StatementOptions | undefined),
      })
      return reply.result
    }
    try {
      const value = await fn(this.#tx(runner))
      const done = await socket.request<{ txid: number }>({ op: "tx.commit", tx: baton })
      this.#core.observe(this.name, done.txid)
      return value
    } catch (err) {
      await socket.request({ op: "tx.rollback", tx: baton }).catch(() => {})
      throw err
    }
  }

  async #httpTransaction<T>(
    fn: (tx: Tx) => Promise<T> | T,
    options: TransactionOptions,
  ): Promise<T> {
    const http = this.#core.http
    const begun = await http.json<TxBeginResult>(`/v1/db/${this.name}/tx`, {
      method: "POST",
      body: { ...(options.mode ? { mode: options.mode } : {}) },
    })
    const baton = begun.tx
    const runner: Runner = async (request, rows, statementOptions) =>
      http.json<QueryResult>(`/v1/db/${this.name}/tx/${baton}`, {
        method: "POST",
        body: statementBody(request, rows, statementOptions as StatementOptions | undefined),
      })
    try {
      const value = await fn(this.#tx(runner))
      const done = await http.json<TxResult>(`/v1/db/${this.name}/tx/${baton}/commit`, {
        method: "POST",
      })
      this.#core.observe(this.name, done.txid)
      return value
    } catch (err) {
      await http
        .json(`/v1/db/${this.name}/tx/${baton}/rollback`, { method: "POST" })
        .catch(() => {})
      throw err
    }
  }

  #tx(runner: Runner): Tx {
    const intMode = this.#core.options.intMode
    return {
      db: this.name,
      sql: ((strings, ...values) =>
        new Query(runner, fromTemplate(strings, values), intMode)) as SqlTag,
      stmt: ((strings, ...values) => fromTemplate(strings, values)) as StmtTag,
      execute: (sql, args, statementOptions) =>
        new Query(runner, fromArgs(sql, args), intMode, statementOptions as RequestOptions),
      unsafe: (sql, args, statementOptions) =>
        new Query(runner, fromArgs(sql, args), intMode, statementOptions as RequestOptions),
    }
  }

  /**
   * A live query over the socket, falling back to the SSE route of design §6.4 when this runtime
   * has no `WebSocket`. The socket path re-subscribes after a reconnect; the SSE path re-runs the
   * whole subscription, which is the same thing one layer down.
   */
  #startLive<T>(sink: LiveSink<T>, request: StatementRequest, key: string | null): () => void {
    const core = this.#core
    const intMode = core.options.intMode
    const deliver = (event: LiveRowsEvent | LiveDiffEvent): void => {
      core.observe(this.name, event.txid)
      if ("columns" in event) sink.rows(decodeLiveRows<T>(event, intMode))
      else sink.diff(decodeLiveDiff<T>(event, intMode))
    }

    if (!core.socket.available) {
      const params = new URLSearchParams({ sql: request.sql, rows: "object" })
      if (request.args !== undefined) params.set("args", JSON.stringify(request.args))
      if (key) params.set("key", key)
      const subscription = new SseSubscription({
        fetchImpl: core.options.fetch ?? fetch,
        what: `live query on ${this.name}`,
        retryMs: core.options.retryMs,
        url: () => core.http.url(`/v1/db/${this.name}/live?${params.toString()}`),
        headers: () => core.headers(),
        onFrame: (frame) => {
          if (frame.event !== "rows" && frame.event !== "diff") return
          try {
            deliver(JSON.parse(frame.data) as LiveRowsEvent | LiveDiffEvent)
          } catch (err) {
            sink.error(asClientError(err, "a live result that is not JSON"))
          }
        },
        onError: (err) => sink.error(err),
      })
      subscription.start()
      return () => subscription.close()
    }

    let stopped = false
    let current: string | null = null
    const socket = core.socket
    const subscribe = async (): Promise<void> => {
      const reply = await socket.request<{ sub: string }>({
        op: "subscribe",
        db: this.name,
        kind: "live",
        sql: request.sql,
        ...(request.args !== undefined ? { args: request.args } : {}),
        ...(key ? { key } : {}),
        rows: "object",
      })
      if (stopped) {
        await socket.request({ op: "unsubscribe", sub: reply.sub }).catch(() => {})
        return
      }
      current = reply.sub
      socket.listen(reply.sub, (push) => {
        if (push.event === "rows" || push.event === "diff") {
          deliver(push.data as LiveRowsEvent | LiveDiffEvent)
        }
      })
    }
    const dropIntent = socket.addIntent(async () => {
      // The new socket assigns a new subscription id, so the old handler is dropped rather than
      // left in the router for an id nothing will ever publish to again.
      if (current) socket.unlisten(current)
      current = null
      await subscribe()
    })
    void subscribe().catch((err) => {
      if (!stopped) sink.error(err)
    })

    return () => {
      stopped = true
      dropIntent()
      if (current) {
        socket.unlisten(current)
        void socket.request({ op: "unsubscribe", sub: current }).catch(() => {})
        current = null
      }
    }
  }
}

/** Design §9.1. The client is cheap: nothing is opened until something is asked of it. */
export function createClient(options: ClientOptions): Client {
  const base = normalizeBase(options.url)
  const fetchImpl =
    options.fetch ??
    ((globalThis as { fetch?: FetchLike }).fetch as FetchLike | undefined)
  if (!fetchImpl) {
    throw BunQLClientError.client("this runtime has no fetch; pass one as `fetch` to createClient")
  }
  const consistency = options.consistency ?? "ryw"
  const intMode = options.intMode ?? "number"
  const retryMs = options.retryMs ?? 1000
  const token = options.token ?? null
  const headers = { ...(options.headers ?? {}) }
  const report = (err: unknown): void => {
    options.onError?.(err)
  }

  const factory: WebSocketFactory | null =
    options.WebSocket === undefined
      ? defaultWebSocketFactory()
      : defaultWebSocketFactory(options.WebSocket)

  const core: Core = {
    http: new HttpClient({ base, token, fetchImpl, headers }),
    socket: new SocketClient({
      url: socketUrl(base),
      token,
      factory,
      retryMs,
      onError: report,
    }),
    options: { ...options, consistency, intMode, retryMs, fetch: fetchImpl },
    txids: new Map(),
    observe(db, txid) {
      if (txid === undefined || !Number.isFinite(txid)) return
      const seen = this.txids.get(db) ?? 0
      if (txid > seen) this.txids.set(db, txid)
    },
    minTxidFor(db, statementOptions) {
      if (statementOptions?.minTxid !== undefined) return statementOptions.minTxid
      const mode = statementOptions?.consistency ?? consistency
      if (mode !== "ryw") return undefined
      const seen = this.txids.get(db) ?? 0
      return seen > 0 ? seen : undefined
    },
    headers() {
      const out: Record<string, string> = { ...headers }
      if (token) out.authorization = `Bearer ${token}`
      return out
    },
    report,
  }

  const dbs = new Map<string, Db>()
  return {
    url: base,
    db(name?: string): Db {
      const target = name ?? options.db
      if (!target) {
        throw BunQLClientError.client(
          "no database: pass a name to client.db() or `db` to createClient",
        )
      }
      const hit = dbs.get(target)
      if (hit) return hit
      const made = new RemoteDb(core, target)
      dbs.set(target, made)
      return made
    },
    txid(name: string): number {
      return core.txids.get(name) ?? 0
    },
    close(): void {
      core.socket.close()
    },
  }
}

export { BunQLClientError } from "./errors.ts"
export {
  ChangeFeed,
  LiveQuery,
  type DecodedChangeEvent,
  type DecodedLiveDiffEvent,
  type DecodedLiveRowsEvent,
  type DecodedResetEvent,
  type DecodedRowChange,
} from "./feed.ts"
export { Query, type QueryArgs, type Result, type ResultMeta } from "./sql.ts"
export type { IntMode, JsRow, JsValue } from "./values.ts"
export * from "./protocol.ts"
