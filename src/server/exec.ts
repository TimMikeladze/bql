// Invariant: no statement steps until three things are true — a policy the token signed for is on
// its connection, a deadline is armed, and a row cap is known. That order is the whole safety
// story of the request path, and it is written once here so HTTP, WebSocket and the baton routes
// cannot each get it subtly wrong.
//
// Statement classification is `sqlite3_stmt_readonly`, not a regular expression over the SQL. A
// read-only statement runs on a pooled reader; anything else goes to the tenant's single writer
// through `tenant.write`, which is what turns it into a txid, a log record and a change event.
// `lastInsertRowid` comes from the same place: SQLite's own account of the statement, never a
// guess from the SQL text or from a number that happened to move.

import {
  HEADERS,
  type Args,
  type BatchRequest,
  type BatchResult,
  type Consistency,
  type IntValue,
  type QueryResult,
  type RequestOptions,
  type RowsMode,
  type StatementRequest,
} from "../client/protocol.ts"
import type { Database, Statement } from "../sqlite/index.ts"
import type { SqliteValue } from "../sqlite/values.ts"
import type { AckLevel, Tenant } from "../tenant/index.ts"
import { applyPolicy, type Principal, requireScope } from "./auth.ts"
import type { ServerConfig } from "./config.ts"
import { BunQLError } from "./errors.ts"
import { decodeArgs, encodeInteger, encodeRows } from "./json.ts"
import type { ServerRuntime } from "./runtime.ts"

export interface ResolvedOptions {
  rows: RowsMode
  maxRows: number
  /** Deadline for a statement that turns out to be read-only. */
  readTimeoutMs: number
  /** Deadline for a statement that writes, and for a transaction as a whole. */
  writeTimeoutMs: number
  ack: AckLevel
  minTxid: bigint | null
  consistency: Consistency
  waitMs: number
}

function asNumber(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "string" ? Number(value) : value
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw BunQLError.badRequest(`${what} must be a number`)
  }
  return n
}

function asAck(value: unknown): AckLevel | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (value === "local" || value === "fsync" || value === "replica" || value === "quorum") {
    return value
  }
  throw BunQLError.badRequest(
    `ack must be "local", "fsync", "replica" or "quorum", got ${JSON.stringify(value)}`,
  )
}

/**
 * The common request options of design §6, from the body and from the `BunQL-*` headers. A body
 * field wins over a header, since a client that set both meant the one it wrote out in full.
 * Every limit is a floor-and-ceiling: a request may ask for less than the node allows, never more.
 */
export function resolveOptions(
  body: RequestOptions | undefined,
  headers: Headers | null,
  config: ServerConfig,
): ResolvedOptions {
  const limits = config.limits
  const rows = body?.rows ?? "array"
  if (rows !== "array" && rows !== "object") {
    throw BunQLError.badRequest(`rows must be "array" or "object", got ${JSON.stringify(rows)}`)
  }
  const maxRows = asNumber(body?.maxRows, "maxRows") ?? limits.maxRows
  if (maxRows <= 0) throw BunQLError.badRequest("maxRows must be positive")

  const timeoutMs = asNumber(body?.timeoutMs, "timeoutMs")
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw BunQLError.badRequest("timeoutMs must be positive")
  }
  const ack =
    asAck(body?.ack ?? headers?.get(HEADERS.ack) ?? undefined) ?? config.durability.defaultAck
  const minTxid = asNumber(body?.minTxid ?? headers?.get(HEADERS.minTxid), "minTxid")
  const consistency = (body?.consistency ?? "ryw") as Consistency
  if (consistency !== "primary" && consistency !== "any" && consistency !== "ryw") {
    throw BunQLError.badRequest(`unknown consistency ${JSON.stringify(consistency)}`)
  }

  return {
    rows,
    maxRows: Math.min(maxRows, limits.maxRows),
    readTimeoutMs: Math.min(timeoutMs ?? limits.queryTimeoutMs, limits.queryTimeoutMs),
    writeTimeoutMs: Math.min(timeoutMs ?? limits.writeTimeoutMs, limits.writeTimeoutMs),
    ack,
    minTxid: minTxid === undefined || minTxid <= 0 ? null : BigInt(Math.floor(minTxid)),
    consistency,
    waitMs: 2000,
  }
}

export function assertStatement(value: unknown, where: string): StatementRequest {
  if (!value || typeof value !== "object") {
    throw BunQLError.badRequest(`${where} must be an object with a sql field`)
  }
  const sql = (value as StatementRequest).sql
  if (typeof sql !== "string" || sql.length === 0) {
    throw BunQLError.badRequest(`${where} needs a non-empty sql string`)
  }
  return value as StatementRequest
}

interface Stepped {
  rows: SqliteValue[][]
  stmt: Statement
  writes: boolean
  vmSteps: number
  rowsAffected: number
  lastInsertRowid: number | bigint | null
}

const isZero = (v: number | bigint): boolean => v === 0 || v === 0n

/**
 * Binds, arms the deadline and steps. `values()` materialises the result, so `maxRows` is checked
 * once it is known; the deadline and the per-connection `sqlite3_limit` set are what bound the
 * work before that point.
 *
 * `lastInsertRowid` is the connection's counter, not the statement's, so the counter alone cannot
 * say whether *this* statement set it. The statement says whether it could: `stmt.inserts` is
 * what SQLite's authorizer reported at prepare time, cached on the prepared statement. For a
 * statement that could insert, the counter is zeroed before the step and read after it, so a
 * non-zero value is proof SQLite set it during this step — true even when the new rowid repeats
 * the connection's previous one, and false for the statements that merely look like inserts (a
 * `WITHOUT ROWID` table, an upsert that took the UPDATE branch, DDL writing `sqlite_master`, an
 * insert a trigger performed, all of which SQLite deliberately leaves the counter alone for).
 * The old value goes back when nothing set it, so the next statement in the same transaction
 * still reads it. A statement that calls `last_insert_rowid()` itself takes the counter as an
 * input and is never zeroed under it; there the older "did the number move" test is all there is.
 */
function step(db: Database, request: StatementRequest, timeoutMs: number, maxRows: number): Stepped {
  const stmt = db.prepare(request.sql)
  const params = decodeArgs(request.args as Args | undefined)
  const writes = !stmt.readonly
  const mayInsert = writes && stmt.inserts
  const marking = mayInsert && !stmt.readsLastInsertRowid
  const rowidBefore = mayInsert ? db.lastInsertRowid : 0
  if (marking && !isZero(rowidBefore)) db.setLastInsertRowid(0)
  stmt.vmSteps(true)
  db.deadline(timeoutMs)
  let rows: SqliteValue[][]
  try {
    rows = stmt.values(...params)
  } catch (err) {
    if (marking && !isZero(rowidBefore) && isZero(db.lastInsertRowid)) {
      db.setLastInsertRowid(rowidBefore)
    }
    throw err
  } finally {
    db.deadline(null)
  }
  if (rows.length > maxRows) throw BunQLError.tooManyRows(maxRows)
  const rowsAffected = writes ? Number(db.changes) : 0
  let lastInsertRowid: number | bigint | null = null
  if (mayInsert) {
    const rowidAfter = db.lastInsertRowid
    if (marking) {
      if (isZero(rowidAfter)) {
        if (!isZero(rowidBefore)) db.setLastInsertRowid(rowidBefore)
      } else {
        lastInsertRowid = rowidAfter
      }
    } else if (rowsAffected > 0 && !isZero(rowidAfter)) {
      lastInsertRowid = rowidAfter
    }
  }
  return {
    rows,
    stmt,
    writes,
    vmSteps: stmt.vmSteps(),
    rowsAffected,
    lastInsertRowid,
  }
}

function toResult(stepped: Stepped, mode: RowsMode, txid: bigint, startedNs: number): QueryResult {
  const encoded = encodeRows(stepped.stmt, stepped.rows, mode)
  const rowid = stepped.lastInsertRowid
  return {
    columns: encoded.columns,
    types: encoded.types,
    rows: encoded.rows,
    rowsAffected: stepped.rowsAffected,
    lastInsertRowid:
      rowid === null || rowid === 0 || rowid === 0n
        ? null
        : (encodeInteger(rowid) as number | IntValue),
    txid: Number(txid),
    durationUs: Math.round((Bun.nanoseconds() - startedNs) / 1000),
    vmSteps: stepped.vmSteps,
  }
}

/** Waits for read-your-writes, or raises 425 (design §5.4, §6.6). */
export async function awaitTxid(tenant: Tenant, options: ResolvedOptions): Promise<void> {
  if (options.minTxid === null || options.minTxid <= tenant.txid) return
  await tenant.waitFor(options.minTxid, options.waitMs)
}

export interface Executed {
  result: QueryResult
  kind: "read" | "write"
}

/**
 * One statement against a tenant. It is prepared on a pooled reader first: a read-only statement
 * runs there, and anything else is re-prepared on the writer inside `tenant.write`. The second
 * prepare is a cached `sqlite3_prepare_v3` on a path that already costs 27 µs, and it buys
 * classification from SQLite itself rather than from a guess about the SQL.
 */
export function executeStatement(
  runtime: ServerRuntime,
  tenant: Tenant,
  principal: Principal,
  request: StatementRequest,
  options: ResolvedOptions,
): Executed {
  const startedNs = Bun.nanoseconds()
  const read = runtime.withReader(tenant, principal, (db) => {
    if (!db.prepare(request.sql).readonly) return null
    return step(db, request, options.readTimeoutMs, options.maxRows)
  })
  if (read) {
    const result = toResult(read, options.rows, tenant.txid, startedNs)
    runtime.metrics.statement("read", result.vmSteps)
    return { result, kind: "read" }
  }

  requireScope(principal, tenant.name, "rw")
  // A durability level this node cannot answer is refused before anything is written, so the
  // common misconfiguration leaves no committed transaction behind to explain (design §5.4).
  // C2: the lease. One `Map.get` and one `performance.now()` on a clustered node, one null check
  // everywhere else — and the only thing the write path asks the control plane, ever. A node whose
  // lease has lapsed stops writing `leaseGuardMs` before the leader could grant it elsewhere,
  // which is what makes two primaries impossible (`docs/c2-promotion.md`).
  runtime.assertWritable(tenant.name)
  runtime.assertAckAvailable(tenant.name, options.ack)
  const written = tenant.write(
    (db) => {
      const handle = applyPolicy(db, runtime.hubFor(db), principal, tenant.name)
      try {
        return step(db, request, options.writeTimeoutMs, options.maxRows)
      } finally {
        handle.release()
      }
    },
    { ack: options.ack },
  )
  const result = toResult(written.result, options.rows, written.txid, startedNs)
  runtime.metrics.statement("write", result.vmSteps)
  return { result, kind: "write" }
}

/**
 * `executeStatement`, with the write folded into the tenant's group commit (`[limits] groupCommit`).
 *
 * A read takes exactly the path it always did and returns without awaiting anything — reads are
 * most of the traffic and none of the contention. A write is queued instead of run, so writes that
 * arrive in the same turn become one transaction and pay the WAL tail, the checksums, the encode
 * and the segment append once between them rather than each (`docs/performance.md` §4B).
 *
 * The synchronous `executeStatement` stays: `db.sync` in the embedded API promises no promise, and
 * a forwarded write is already inside the primary's own turn.
 */
export async function executeStatementQueued(
  runtime: ServerRuntime,
  tenant: Tenant,
  principal: Principal,
  request: StatementRequest,
  options: ResolvedOptions,
): Promise<Executed> {
  if (!runtime.config.limits.groupCommit) {
    return executeStatement(runtime, tenant, principal, request, options)
  }
  const startedNs = Bun.nanoseconds()
  const read = runtime.withReader(tenant, principal, (db) => {
    if (!db.prepare(request.sql).readonly) return null
    return step(db, request, options.readTimeoutMs, options.maxRows)
  })
  if (read) {
    const result = toResult(read, options.rows, tenant.txid, startedNs)
    runtime.metrics.statement("read", result.vmSteps)
    return { result, kind: "read" }
  }

  requireScope(principal, tenant.name, "rw")
  runtime.assertWritable(tenant.name)
  runtime.assertAckAvailable(tenant.name, options.ack)
  const written = await tenant.writeQueued(
    (db) => {
      // Per statement, inside the shared transaction: each folded write is authorised as its own
      // caller, so two principals in one transaction never borrow each other's rights.
      const handle = applyPolicy(db, runtime.hubFor(db), principal, tenant.name)
      try {
        return step(db, request, options.writeTimeoutMs, options.maxRows)
      } finally {
        handle.release()
      }
    },
    { ack: options.ack },
  )
  const result = toResult(written.result, options.rows, written.txid, startedNs)
  runtime.metrics.statement("write", result.vmSteps)
  return { result, kind: "write" }
}

/**
 * Design §6.2. `atomic` (the default) is one `tenant.write`, so any failure rolls the whole batch
 * back and one txid covers all of it; a non-atomic batch runs each statement on its own and stops
 * at the first failure. Either way `failedIndex` names the statement that failed.
 */
export function executeBatch(
  runtime: ServerRuntime,
  tenant: Tenant,
  principal: Principal,
  request: BatchRequest,
  options: ResolvedOptions,
): BatchResult {
  const statements = request.statements
  if (!Array.isArray(statements) || statements.length === 0) {
    throw BunQLError.badRequest("batch needs a non-empty statements array")
  }
  for (let i = 0; i < statements.length; i++) assertStatement(statements[i], `statements[${i}]`)
  runtime.metrics.batch()

  if (request.atomic === false) {
    const results: QueryResult[] = []
    for (let i = 0; i < statements.length; i++) {
      try {
        const one = executeStatement(
          runtime,
          tenant,
          principal,
          statements[i] as StatementRequest,
          options,
        )
        results.push(one.result)
      } catch (err) {
        throw markFailedIndex(err, i)
      }
    }
    return { results, txid: Number(tenant.txid) }
  }

  // Atomic is one transaction on the writer whatever the statements turn out to be. A batch of
  // pure reads pays a `BEGIN IMMEDIATE` it did not need, which is the price of `atomic` meaning
  // exactly one thing.
  requireScope(principal, tenant.name, "rw")
  // C2: the lease. One `Map.get` and one `performance.now()` on a clustered node, one null check
  // everywhere else — and the only thing the write path asks the control plane, ever. A node whose
  // lease has lapsed stops writing `leaseGuardMs` before the leader could grant it elsewhere,
  // which is what makes two primaries impossible (`docs/c2-promotion.md`).
  runtime.assertWritable(tenant.name)
  runtime.assertAckAvailable(tenant.name, options.ack)
  const startedNs = Bun.nanoseconds()
  const written = tenant.write(
    (db) => {
      const handle = applyPolicy(db, runtime.hubFor(db), principal, tenant.name)
      try {
        const stepped: Stepped[] = []
        for (let i = 0; i < statements.length; i++) {
          try {
            stepped.push(
              step(db, statements[i] as StatementRequest, options.writeTimeoutMs, options.maxRows),
            )
          } catch (err) {
            throw markFailedIndex(err, i)
          }
        }
        return stepped
      } finally {
        handle.release()
      }
    },
    { ack: options.ack },
  )

  const results = written.result.map((one) => {
    const result = toResult(one, options.rows, written.txid, startedNs)
    runtime.metrics.statement(one.writes ? "write" : "read", result.vmSteps)
    return result
  })
  return { results, txid: Number(written.txid) }
}

/** One statement inside an open baton transaction (design §6.3). */
export function executeInTx(
  runtime: ServerRuntime,
  tenant: Tenant,
  principal: Principal,
  request: StatementRequest,
  options: ResolvedOptions,
): QueryResult {
  const startedNs = Bun.nanoseconds()
  const stepped = tenant.txExec((db) => {
    const handle = applyPolicy(db, runtime.hubFor(db), principal, tenant.name)
    try {
      const timeoutMs = db.prepare(request.sql).readonly
        ? options.readTimeoutMs
        : options.writeTimeoutMs
      return step(db, request, timeoutMs, options.maxRows)
    } finally {
      handle.release()
    }
  })
  const result = toResult(stepped, options.rows, tenant.txid, startedNs)
  runtime.metrics.statement(stepped.writes ? "write" : "read", result.vmSteps)
  return result
}

/**
 * Records which statement of a batch failed, without touching the error itself: a `SqliteError`
 * carries a result code the mapper needs, and wrapping it would lose that.
 */
const failedIndexes = new WeakMap<object, number>()

export function markFailedIndex(err: unknown, index: number): unknown {
  if (err !== null && typeof err === "object") failedIndexes.set(err, index)
  return err
}

export function failedIndexOf(err: unknown): number | undefined {
  return err !== null && typeof err === "object" ? failedIndexes.get(err) : undefined
}
