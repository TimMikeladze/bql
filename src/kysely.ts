// A Kysely dialect over BunQL (plan-phase1.md R5). Kysely owns the SQL, BunQL owns the transport:
// the adapter, compiler and introspector are Kysely's own `Sqlite*` ones, so a statement this
// dialect sends is the same statement the better-sqlite3 dialect would have sent.
//
// Invariant: a Kysely transaction is one BunQL transaction, never a `begin`/`commit` pair of
// one-shot statements. `beginTransaction` opens `db.transaction()` and parks its callback on a
// promise; every statement on that connection then runs through the `Tx` the callback was handed,
// and commit or rollback is what releases the park. A one-shot `begin` over HTTP would commit
// nothing, because each statement on the tenant's writer is its own transaction.
//
// Second invariant: `kysely` is a peer, not a dependency. Nothing under `src/` imports it except
// this module, so a BunQL install with no Kysely in it still resolves.

import {
  IdentifierNode,
  RawNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  createQueryId,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely"
import {
  createClient,
  type Client,
  type ClientOptions,
  type Db,
  type StatementOptions,
  type TransactionOptions,
  type Tx,
} from "./client/index.ts"

/** A client this dialect builds and owns, rather than a `Db` the caller already has. */
export interface BunQLDialectClientConfig
  extends Omit<ClientOptions, "db" | "url" | "intMode"> {
  /** Base URL of the server, `https://sql.example.com`. */
  url: string
  /** Database name on that server. */
  db: string
  token?: string
  /**
   * What an integer beyond 2^53 becomes. Defaults to `"bigint"` here rather than the client's own
   * `"number"`: an ORM that throws on a large rowid is worse than one that hands back a bigint.
   */
  intMode?: ClientOptions["intMode"]
}

export interface BunQLDialectConfig {
  /** An open database handle: `createClient(…).db(name)` or `(await BunQL.open(…)).db(name)`. */
  db: Db
  /** Options applied to every statement: `timeoutMs`, `maxRows`, `ack`, `consistency`. */
  statement?: StatementOptions
  /** Options for every transaction Kysely opens: `mode`, `via`, `ack`. */
  transaction?: TransactionOptions
}

/** Everything `BunQLDialect` accepts: a `Db`, a `Db` with options, or a client to build. */
export type BunQLDialectOptions =
  | Db
  | BunQLDialectConfig
  | (BunQLDialectClientConfig & {
      statement?: StatementOptions
      transaction?: TransactionOptions
    })

interface Resolved {
  db: Db
  statement: StatementOptions | undefined
  transaction: TransactionOptions | undefined
  /** Closed by `destroy()` only when this dialect opened it. */
  owned: Client | null
}

function isDb(value: unknown): value is Db {
  const candidate = value as Partial<Db> | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.name === "string" &&
    typeof candidate.execute === "function" &&
    typeof candidate.transaction === "function"
  )
}

function resolve(options: BunQLDialectOptions): Resolved {
  if (isDb(options)) {
    return { db: options, statement: undefined, transaction: undefined, owned: null }
  }
  const { statement, transaction } = options as BunQLDialectConfig
  if (isDb((options as BunQLDialectConfig).db)) {
    return { db: (options as BunQLDialectConfig).db, statement, transaction, owned: null }
  }
  const config = options as BunQLDialectClientConfig
  if (typeof config.url !== "string" || typeof config.db !== "string") {
    throw new TypeError(
      "bunql/kysely: pass a BunQL Db, {db}, or {url, db} — got " + JSON.stringify(Object.keys(options)),
    )
  }
  const { db: name, statement: _s, transaction: _t, ...rest } = options as BunQLDialectClientConfig & {
    statement?: StatementOptions
    transaction?: TransactionOptions
  }
  const client = createClient({ intMode: "bigint", ...rest, db: name })
  return { db: client.db(name), statement, transaction, owned: client }
}

/** `lastInsertRowid` as Kysely wants it: a bigint, or nothing at all. */
function toInsertId(value: number | bigint | string | null): bigint | undefined {
  if (value === null) return undefined
  if (typeof value === "bigint") return value
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(value) : undefined
  const text = value.trim()
  return text.length > 0 ? BigInt(text) : undefined
}

/**
 * One connection. It holds no socket of its own — the `Db` behind it is already multiplexed — but
 * it does hold the open transaction, which is what makes a `Kysely.transaction()` block route its
 * statements through the right place.
 */
class BunQLConnection implements DatabaseConnection {
  readonly #db: Db
  readonly #statement: StatementOptions | undefined
  readonly #transaction: TransactionOptions | undefined

  #tx: Tx | null = null
  #release: ((how: "commit" | "rollback") => void) | null = null
  #done: Promise<void> | null = null

  constructor(
    db: Db,
    statement: StatementOptions | undefined,
    transaction: TransactionOptions | undefined,
  ) {
    this.#db = db
    this.#statement = statement
    this.#transaction = transaction
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const runner: Db | Tx = this.#tx ?? this.#db
    const result = await runner.execute(
      compiled.sql,
      compiled.parameters as readonly unknown[],
      this.#statement,
    )
    const insertId = toInsertId(result.lastInsertRowid)
    return {
      rows: result as unknown as R[],
      ...(insertId === undefined ? {} : { insertId }),
      numAffectedRows: BigInt(result.affectedRows),
    }
  }

  /**
   * BunQL answers a statement with its whole result set (design §6.1); there is no cursor route to
   * back a chunked reader with, so this fails loudly rather than pretending to stream.
   */
  streamQuery<R>(_compiled: CompiledQuery, _chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(
      "bunql/kysely does not support streamQuery: BunQL returns whole result sets. Page with " +
        "limit/offset, or cap a statement with maxRows.",
    )
  }

  // ── the transaction park ─────────────────────────────────────────────────────────────────────

  /** Opens `db.transaction()` and keeps its callback alive until commit or rollback. */
  async begin(settings: TransactionSettings): Promise<void> {
    if (this.#tx) throw new Error("bunql/kysely: this connection already has an open transaction")
    if (settings.isolationLevel !== undefined) {
      throw new Error(
        `bunql/kysely: SQLite has no isolation levels; drop ${JSON.stringify(settings.isolationLevel)}`,
      )
    }
    const options: TransactionOptions = {
      ...(settings.accessMode === "read only" ? { mode: "deferred" as const } : {}),
      ...this.#transaction,
    }

    let handOver!: (tx: Tx) => void
    let handFail!: (err: unknown) => void
    const opened = new Promise<Tx>((ok, fail) => {
      handOver = ok
      handFail = fail
    })
    const done = this.#db
      .transaction<void>(
        (tx) =>
          new Promise<void>((resolve, reject) => {
            this.#release = (how) => (how === "commit" ? resolve() : reject(ROLLBACK))
            handOver(tx)
          }),
        options,
      )
      .then(
        () => undefined,
        (err: unknown) => {
          // A rollback is this adapter asking for one, not a failure to report.
          if (err !== ROLLBACK) throw err
        },
      )
    // A transaction the server refused never reaches the callback, so `opened` would hang on it.
    done.catch(handFail)
    this.#done = done
    this.#tx = await opened
  }

  async end(how: "commit" | "rollback"): Promise<void> {
    const release = this.#release
    const done = this.#done
    if (!release || !done) throw new Error("bunql/kysely: no transaction is open on this connection")
    this.#tx = null
    this.#release = null
    this.#done = null
    release(how)
    await done
  }

  get inTransaction(): boolean {
    return this.#tx !== null
  }
}

/** Rejecting the parked callback with this is how a rollback is asked for, not an error. */
const ROLLBACK = Symbol("bunql.kysely.rollback")

/** A savepoint command as Kysely builds it, so the name is an identifier rather than text. */
function savepoint(command: "savepoint" | "rollback to" | "release", name: string) {
  return RawNode.createWithChildren([RawNode.createWithSql(`${command} `), IdentifierNode.create(name)])
}

class BunQLDriver implements Driver {
  readonly #resolved: Resolved

  constructor(resolved: Resolved) {
    this.#resolved = resolved
  }

  async init(): Promise<void> {
    // The `Db` is already open, or is a lazy handle on a client that opens on first use.
  }

  /**
   * A connection per acquire, over the one multiplexed `Db`. Kysely binds an open transaction to
   * the connection it began on, so a shared connection object would leak a transaction into every
   * other query running beside it.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    return new BunQLConnection(
      this.#resolved.db,
      this.#resolved.statement,
      this.#resolved.transaction,
    )
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    await (connection as BunQLConnection).begin(settings)
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as BunQLConnection).end("commit")
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as BunQLConnection).end("rollback")
  }

  async savepoint(
    connection: DatabaseConnection,
    name: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(compileQuery(savepoint("savepoint", name), createQueryId()))
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    name: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(compileQuery(savepoint("rollback to", name), createQueryId()))
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    name: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(compileQuery(savepoint("release", name), createQueryId()))
  }

  async releaseConnection(): Promise<void> {
    // Nothing is pooled: a connection is a wrapper over the `Db`, and the transaction it may have
    // held was already ended by commit or rollback.
  }

  async destroy(): Promise<void> {
    this.#resolved.owned?.close()
  }
}

/**
 * Kysely over BunQL.
 *
 * ```ts
 * const kysely = new Kysely<DB>({ dialect: new BunQLDialect({ url, token, db: "acme" }) })
 * ```
 */
export class BunQLDialect implements Dialect {
  readonly #resolved: Resolved

  constructor(options: BunQLDialectOptions) {
    this.#resolved = resolve(options)
  }

  /** The database this dialect talks to, for code that wants the BunQL handle back. */
  get db(): Db {
    return this.#resolved.db
  }

  createDriver(): Driver {
    return new BunQLDriver(this.#resolved)
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter()
  }

  // `Kysely<any>` is Kysely's own signature here: the introspector is handed a plugin-less
  // instance whose schema type it neither knows nor needs.
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}

/** `new BunQLDialect(options)`, for callers who prefer a function. */
export function bunqlDialect(options: BunQLDialectOptions): BunQLDialect {
  return new BunQLDialect(options)
}

export type { Db, StatementOptions, TransactionOptions } from "./client/index.ts"
