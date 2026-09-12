// Invariant: a Hrana stream is a BunQL principal, a database, and — while one is open — the
// tenant's single writer. Nothing else. It holds no connection of its own and prepares no
// statement of its own, so every safety property of `../exec.ts` (the authorizer the token signed
// for, the deadline, the row cap, the single-writer serialisation) applies to the compat surface
// unchanged, and a bug fixed there is fixed here.
//
// Second invariant: exactly one service per `ServerRuntime`. The stream table is what a baton
// points into, so two services over one runtime would issue batons that cannot see each other's
// streams. The `WeakMap` below is what makes `hranaRoutes(runtime)` and `hranaUpgrade(runtime, …)`
// compose into one thing without `app.ts` having to hold the state.
//
// Third invariant: a stream that stops being used goes away, and takes its transaction with it.
// The sweep below drops the stream; the tenant's own `txIdleTimeoutMs` is what actually rolls the
// transaction back, so a client that vanished mid-transaction cannot pin the writer.

import { requireScope, type Principal } from "../auth.ts"
import { BunQLError } from "../errors.ts"
import { resolveOptions, type ResolvedOptions } from "../exec.ts"
import type { ServerRuntime, TxSession } from "../runtime.ts"
import type { RemoteTx } from "../forward.ts"
import { BatonSigner } from "./baton.ts"

/** Streams a node keeps at once, across every socket and every baton. */
const MAX_STREAMS = 4096
/** How long a stream survives with nothing arriving for it. */
const STREAM_IDLE_MS = 60_000
/** How long a baton stays valid. Longer than the idle window, so expiry has one cause. */
const BATON_TTL_MS = 120_000
/** SQL texts one `store_sql` owner may hold. */
const MAX_STORED_SQL = 256

export class HranaStream {
  readonly id: number
  readonly db: string
  readonly principal: Principal
  /** `store_sql` texts. A socket shares one map across its streams; an HTTP stream owns its own. */
  readonly sql: Map<number, string>
  /** Identity for `runtime.rollbackOwned`, so closing a socket ends what it began. */
  readonly owner: object
  /**
   * Whether a `BEGIN` on this stream may *wait* for the tenant's writer instead of being refused
   * at once. True for an HTTP stream, whose requests arrive as independent requests, so a wait
   * blocks nothing but itself. False for a socket stream: `../hrana/ws.ts` answers a socket's
   * requests in arrival order, so a stream that waited would hold up the very statements that
   * would release the writer — a deadlock down to `limits.txWaitMs` rather than a queue.
   */
  readonly waitsForWriter: boolean
  /** Responses issued so far. A baton naming any other number is stale. */
  seq = 0
  tx: TxSession | null = null
  /**
   * R4b: the transaction this stream opened **on the primary**, when it is a writable one on a
   * replica. Exactly one of `tx` and `remoteTx` is ever set. `docs/r4b-hrana-forward.md` §2.
   */
  remoteTx: RemoteTx | null = null
  /** Set when the open transaction began as `BEGIN TRANSACTION READONLY`, so writes are refused. */
  txReadonly = false
  closed = false
  lastUsedMs = Date.now()

  constructor(options: {
    id: number
    db: string
    principal: Principal
    sql: Map<number, string>
    owner: object
    waitsForWriter: boolean
  }) {
    this.id = options.id
    this.db = options.db
    this.principal = options.principal
    this.sql = options.sql
    this.owner = options.owner
    this.waitsForWriter = options.waitsForWriter
  }

  /** The SQL a statement means: its own text, or the one `store_sql` filed under `sql_id`. */
  sqlOf(stmt: { sql?: string | null; sql_id?: number | null }): string {
    const inline = stmt.sql
    const id = stmt.sql_id
    if (typeof inline === "string" && inline.length > 0) {
      if (typeof id === "number") {
        throw BunQLError.badRequest("a statement may carry sql or sql_id, not both")
      }
      return inline
    }
    if (typeof id === "number") {
      const stored = this.sql.get(id)
      if (stored === undefined) throw BunQLError.badRequest(`no SQL is stored under id ${id}`)
      return stored
    }
    throw BunQLError.badRequest("a statement needs sql or sql_id")
  }

  storeSql(id: number, sql: string): void {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw BunQLError.badRequest("store_sql needs an integer sql_id")
    }
    if (typeof sql !== "string") throw BunQLError.badRequest("store_sql needs a sql string")
    if (this.sql.has(id)) throw BunQLError.badRequest(`sql_id ${id} is already stored`)
    if (this.sql.size >= MAX_STORED_SQL) {
      throw new BunQLError("TOO_MANY_REQUESTS", `a stream may store ${MAX_STORED_SQL} SQL texts`, 429)
    }
    this.sql.set(id, sql)
  }

  closeSql(id: number): void {
    if (!this.sql.delete(id)) throw BunQLError.badRequest(`no SQL is stored under id ${id}`)
  }
}

export class HranaService {
  readonly runtime: ServerRuntime
  readonly batons: BatonSigner
  #streams = new Map<number, HranaStream>()
  #nextId = 1
  #sweeper: ReturnType<typeof setInterval> | null = null

  constructor(runtime: ServerRuntime) {
    this.runtime = runtime
    this.batons = new BatonSigner(BATON_TTL_MS)
  }

  get openStreams(): number {
    return this.#streams.size
  }

  /**
   * The per-statement limits `../exec.ts` enforces. Hrana carries no request options of its own,
   * so every statement runs at the node's configured ceilings; `rows: "array"` is what the value
   * encoder wants and is the default anyway.
   */
  options(): ResolvedOptions {
    return resolveOptions(undefined, null, this.runtime.config)
  }

  /**
   * Opens a stream on `db` for `principal`. The scope check happens here and not per statement,
   * for the same reason `routes.ts` does it in `open()`: a token with no access to a database must
   * not be able to learn whether it exists.
   */
  openStream(
    db: string,
    principal: Principal,
    owner: object,
    sql?: Map<number, string>,
    waitsForWriter = true,
  ): HranaStream {
    this.sweep()
    if (this.#streams.size >= MAX_STREAMS) {
      throw new BunQLError("TOO_MANY_REQUESTS", "this node holds all the streams it will", 429)
    }
    requireScope(principal, db, "ro")
    // Fails with 404 here rather than on the first statement, which is what a client expects from
    // "open a stream on a database that is not there".
    this.runtime.tenant(db)
    const id = this.#nextId++
    const stream = new HranaStream({
      id,
      db,
      principal,
      sql: sql ?? new Map(),
      owner,
      waitsForWriter,
    })
    this.#streams.set(id, stream)
    this.#arm()
    return stream
  }

  /** The stream a baton names, with its sequence checked. Raises 400 for anything else. */
  resume(baton: string, db: string): HranaStream {
    const claim = this.batons.verify(baton)
    const stream = this.#streams.get(claim.streamId)
    if (!stream || stream.closed) {
      throw new BunQLError("BAD_REQUEST", "the stream this baton names has ended", 400)
    }
    if (stream.seq !== claim.seq) {
      throw new BunQLError("BAD_REQUEST", "this baton has been superseded", 400)
    }
    if (stream.db !== db) {
      throw new BunQLError("BAD_REQUEST", "this baton belongs to a different database", 400)
    }
    stream.lastUsedMs = Date.now()
    return stream
  }

  /** The baton for the next request of `stream`, which invalidates the one just used. */
  rotate(stream: HranaStream): string {
    stream.seq++
    stream.lastUsedMs = Date.now()
    return this.batons.sign(stream.id, stream.seq)
  }

  /** Ends a stream: rolls back anything it left open and forgets it. */
  closeStream(stream: HranaStream): void {
    if (stream.closed) return
    stream.closed = true
    this.#streams.delete(stream.id)
    const tx = stream.tx
    stream.tx = null
    if (tx) {
      try {
        this.runtime.endTx(tx, "rollback")
      } catch (err) {
        this.runtime.report(err)
      }
    }
    // R4b: a stream that idled out holding a transaction on the *primary* rolls it back there too,
    // rather than leaving the primary's writer pinned until its own idle timer notices.
    const remote = stream.remoteTx
    stream.remoteTx = null
    if (remote) {
      void this.runtime.forwarder
        .txEnd(remote, stream.principal, "rollback")
        .catch((err: unknown) => this.runtime.report(err))
    }
  }

  /** Everything a socket opened, when the socket goes. */
  closeOwned(owner: object): void {
    for (const stream of [...this.#streams.values()]) {
      if (stream.owner === owner) this.closeStream(stream)
    }
  }

  /** Drops streams nothing has touched for `STREAM_IDLE_MS`. */
  sweep(now = Date.now()): void {
    for (const stream of [...this.#streams.values()]) {
      if (now - stream.lastUsedMs > STREAM_IDLE_MS) this.closeStream(stream)
    }
    if (this.#streams.size === 0 && this.#sweeper) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
  }

  close(): void {
    for (const stream of [...this.#streams.values()]) this.closeStream(stream)
    if (this.#sweeper) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
  }

  #arm(): void {
    if (this.#sweeper) return
    this.#sweeper = setInterval(() => this.sweep(), STREAM_IDLE_MS / 2)
    // Never a reason to keep a process alive; the sweep is bookkeeping, not work.
    this.#sweeper.unref?.()
  }
}

const services = new WeakMap<ServerRuntime, HranaService>()

/** The one service for a runtime, created on first use. */
export function hranaService(runtime: ServerRuntime): HranaService {
  let service = services.get(runtime)
  if (!service) {
    service = new HranaService(runtime)
    services.set(runtime, service)
  }
  return service
}

/** Drops a runtime's service, for a test or a shutdown that wants the timers gone now. */
export function closeHranaService(runtime: ServerRuntime): void {
  const service = services.get(runtime)
  if (!service) return
  service.close()
  services.delete(runtime)
}

export { MAX_STORED_SQL, STREAM_IDLE_MS }
