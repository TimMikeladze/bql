// Invariant: every statement on this surface goes through `../exec.ts`, and the only thing this
// module adds is translation. No connection is borrowed here except by `describe`, which has to
// prepare a statement to have anything to describe and borrows through `runtime.withReader` like
// everything else. That is what makes the compat layer inherit the authorizer, the deadline, the
// row cap, the single-writer serialisation and the txid rather than re-deriving any of them.
//
// Second invariant: the stream's transaction state and the tenant's agree at every await point.
// `BEGIN`, `COMMIT`, `ROLLBACK` and `END` are intercepted (see `./sql.ts`) and turned into
// `runtime.beginTxQueued` / `runtime.endTx`; nothing else is allowed to move that state.
//
// Every call is `async` and every call into `../exec.ts` is awaited. Those functions are
// synchronous today and may not stay that way once a write can wait on a replica ack, and a
// missing `await` there would be a silently torn transaction rather than a type error.

import type { QueryResult, Value } from "../../client/protocol.ts"
import { applyPolicy, requireScope } from "../auth.ts"
import { BunQLError } from "../errors.ts"
import { executeInReadTx, executeInTx, executeStatement } from "../exec.ts"
import type { Database } from "../../sqlite/index.ts"
import { cstr } from "../../sqlite/lib.ts"
import { mapTenantError } from "../runtime.ts"
import { toHranaError } from "./errors.ts"
import type {
  CursorEntry,
  HranaBatch,
  HranaBatchCond,
  HranaBatchResult,
  HranaCol,
  HranaDescribeResult,
  HranaStmt,
  HranaStmtResult,
  HranaValue,
  StreamRequest,
  StreamResponse,
} from "./proto.ts"
import type { HranaService, HranaStream } from "./service.ts"
import { isExplain, splitStatements, txVerb } from "./sql.ts"
import { argsOf, isFloatColumn, toDecimalString, toHranaValue } from "./values.ts"

/** A result for a statement that produced no columns and no rows, such as `BEGIN`. */
function emptyResult(txid: bigint, startedNs: number): HranaStmtResult {
  return {
    cols: [],
    rows: [],
    affected_row_count: 0,
    last_insert_rowid: null,
    rows_read: 0,
    rows_written: 0,
    query_duration_ms: (Bun.nanoseconds() - startedNs) / 1e6,
    replication_index: txid.toString(),
  }
}

/**
 * A BunQL result as a Hrana one. `decltype` is `../json.ts`'s column type, which is the declared
 * type when there is one and the storage class of the first non-null cell otherwise — so an
 * expression column reports a type where libsql-server reports null. `"NULL"`, which is what that
 * encoder emits for a column it could not type at all, becomes null here.
 */
function toStmtResult(result: QueryResult, wantRows: boolean): HranaStmtResult {
  const types = result.types
  const cols: HranaCol[] = result.columns.map((name, i) => ({
    name,
    decltype: types[i] && types[i] !== "NULL" ? (types[i] as string) : null,
  }))
  const floats = types.map((t) => isFloatColumn(t))
  const source = result.rows as Value[][]
  const rows: HranaValue[][] = wantRows
    ? source.map((row) => row.map((cell, i) => toHranaValue(cell, floats[i] === true)))
    : []
  return {
    cols,
    rows,
    affected_row_count: result.rowsAffected,
    last_insert_rowid: toDecimalString(result.lastInsertRowid),
    rows_read: source.length,
    rows_written: result.rowsAffected,
    query_duration_ms: result.durationUs / 1000,
    replication_index: String(result.txid),
  }
}

/** SQLite's own wording, so a client that matches on the message sees what it expects. */
function noTransaction(what: string): BunQLError {
  return new BunQLError("BAD_REQUEST", `cannot ${what} - no transaction is active`, 400)
}

/**
 * Refuses a write inside a transaction opened as `BEGIN TRANSACTION READONLY` — which is what
 * `@libsql/client` emits for `transaction("read")` and `batch(…, "read")`, and the only thing
 * that makes those modes mean anything. Classification is `sqlite3_stmt_readonly`, not a guess
 * about the SQL, so it is the same test `../exec.ts` uses to route a statement.
 *
 * The prepare happens under the principal's own policy, exactly as `executeInTx` does it: a
 * statement compiled with a different authorizer installed would be the wrong statement to cache,
 * and releasing the policy expires the driver's cache anyway. That costs a second
 * `sqlite3_set_authorizer` cycle per statement, which is the price of the read mode meaning
 * something and is paid only inside a read transaction.
 */
function assertReadOnly(service: HranaService, stream: HranaStream, sql: string): void {
  const runtime = service.runtime
  const tenant = runtime.tenant(stream.db)
  const inspect = (db: Database): boolean => {
    const handle = applyPolicy(db, runtime.hubFor(db), stream.principal, stream.db)
    try {
      return db.prepare(sql).readonly
    } finally {
      handle.release()
    }
  }
  // R10: the read transaction lives on a leased reader, so the statement is compiled on that
  // reader — the writer may be busy with somebody else's write, which is the point of the move.
  const readTx = stream.readTx
  const readonly = readTx
    ? tenant.readTxExec(readTx.tx, inspect)
    : tenant.txExec(inspect)
  if (!readonly) {
    throw new BunQLError(
      "SQLITE_READONLY",
      "attempt to write in a read-only transaction",
      403,
    )
  }
}

/**
 * One Hrana statement. Transaction control moves the stream's state; everything else runs inside
 * the stream's transaction when it has one and as its own statement when it does not.
 */
export async function executeStmt(
  service: HranaService,
  stream: HranaStream,
  stmt: HranaStmt,
): Promise<HranaStmtResult> {
  if (!stmt || typeof stmt !== "object") throw BunQLError.badRequest("a stmt object is required")
  const sql = stream.sqlOf(stmt)
  const wantRows = stmt.want_rows !== false
  const runtime = service.runtime
  const tenant = runtime.tenant(stream.db)
  const startedNs = Bun.nanoseconds()
  const verb = txVerb(sql)

  try {
    if (verb?.kind === "begin") {
      if (stream.tx || stream.remoteTx || stream.readTx) {
        throw new BunQLError("BAD_REQUEST", "cannot start a transaction within a transaction", 400)
      }
      requireScope(stream.principal, stream.db, verb.readonly ? "ro" : "rw")
      // R4b: a writable transaction on a replica lives on the *primary*, and the stream holds a
      // `RemoteTx` where it would otherwise hold a `TxSession`. The baton is unchanged — it still
      // names this local stream — because what changes is what hangs off the stream, not what the
      // baton means. `docs/r4b-hrana-forward.md` §2.
      //
      // A read-only transaction is **not** forwarded, and on a replica it is refused rather than
      // served: `Tenant.txBegin` takes the tenant's *writer* whatever the mode, and a replica's
      // writer belongs to the applier — a client holding it would stall the replication stream for
      // as long as the transaction lasted. §2.2 says what a consistent multi-statement read on a
      // replica uses instead.
      // R10: a read transaction lives on a leased *reader*, on either role — so it works on a
      // replica, where the writer belongs to the applier, and on a primary it no longer blocks
      // writes for as long as it is held. `docs/r10-read-transactions.md`.
      if (verb.readonly) {
        stream.readTx = runtime.beginReadTx(tenant, stream.principal, { owner: stream.owner })
        stream.txReadonly = true
        return emptyResult(tenant.txid, startedNs)
      }
      if (runtime.forwarder.enabledFor(stream.db)) {
        const opened = await runtime.forwarder.txBegin(tenant, stream.principal, {}, stream.owner)
        stream.remoteTx = runtime.forwarder.remoteTx(opened.tx) ?? null
        return emptyResult(tenant.txid, startedNs)
      }
      // `beginTxQueued` on an HTTP stream, not `beginTx`: `@libsql/client` has a concurrency
      // window of 20 and any ORM over it runs request handlers in parallel, so two
      // `client.transaction()` calls overlap routinely. R5 found the same thing on the native
      // path and put the queue in the runtime; taking it here is what stops the second of two
      // concurrent transactions from failing `TX_BUSY` the instant it is opened. A socket stream
      // must not wait — see `HranaStream.waitsForWriter`.
      const begin = { mode: verb.mode, owner: stream.owner }
      stream.tx = stream.waitsForWriter
        ? await runtime.beginTxQueued(tenant, stream.principal, begin)
        : runtime.beginTx(tenant, stream.principal, begin)
      stream.txReadonly = verb.readonly
      return emptyResult(tenant.txid, startedNs)
    }
    if (verb?.kind === "commit" || verb?.kind === "rollback") {
      const readTx = stream.readTx
      if (readTx) {
        stream.readTx = null
        stream.txReadonly = false
        // Both endings do the same thing: a read transaction has nothing to commit. One a timer
        // already ended ends silently — the client asked for exactly the state it is now in.
        if (readTx.tx.open) runtime.endReadTx(readTx)
        return emptyResult(tenant.txid, startedNs)
      }
      const remote = stream.remoteTx
      if (remote) {
        stream.remoteTx = null
        const ended = await runtime.forwarder.txEnd(remote, stream.principal, verb.kind)
        return emptyResult(BigInt(ended.txid), startedNs)
      }
      const tx = stream.tx
      if (!tx) throw noTransaction(verb.kind)
      stream.tx = null
      stream.txReadonly = false
      const txid = await runtime.endTx(tx, verb.kind)
      return emptyResult(txid, startedNs)
    }

    // R10: an idle or long-lived read transaction is ended by a timer, so a stream can be holding
    // one that is already over. The client is told rather than quietly served outside a
    // transaction it still believes it is in — and the stream is cleared, so it recovers.
    if (stream.readTx && !stream.readTx.tx.open) {
      stream.readTx = null
      stream.txReadonly = false
      throw new BunQLError("TX_NOT_FOUND", `${stream.db}: the read transaction has ended`, 404)
    }
    if (stream.txReadonly && (stream.tx || stream.readTx)) assertReadOnly(service, stream, sql)
    const args = argsOf(stmt)
    const request = { sql, ...(args !== undefined ? { args } : {}) }
    const options = service.options()
    // R4b §2.1: once a transaction is remote, *every* statement in it is remote, reads included.
    // A transaction that read locally and wrote remotely would not show a client its own
    // uncommitted writes — the local file is a snapshot that does not contain them.
    if (stream.remoteTx) {
      const result = await runtime.forwarder.txExec(stream.remoteTx, stream.principal, request)
      return toStmtResult(result, wantRows)
    }
    if (stream.readTx) {
      return toStmtResult(
        executeInReadTx(runtime, tenant, stream.readTx.tx, stream.principal, request, options),
        wantRows,
      )
    }
    const result: QueryResult = stream.tx
      ? await executeInTx(runtime, tenant, stream.principal, request, options)
      : // R4b §2.3: outside a transaction a write is one round trip and a read never leaves this
        // node, classified by `sqlite3_stmt_readonly` exactly as `routes.query` classifies it.
        runtime.forwarder.needsPrimary(tenant, stream.principal, [sql])
        ? await runtime.forwarder.query(tenant, stream.principal, request, options)
        : (await executeStatement(runtime, tenant, stream.principal, request, options)).result
    return toStmtResult(result, wantRows)
  } catch (err) {
    throw mapTenantError(err, runtime.primaryUrl)
  }
}

// ── batches (design §6.7: how `@libsql/client` builds a transaction) ────────────────────────────

function evalCond(
  cond: HranaBatchCond,
  results: readonly (HranaStmtResult | null)[],
  errors: readonly (unknown | null)[],
  at: number,
  stream: HranaStream,
): boolean {
  switch (cond?.type) {
    case "ok":
    case "error": {
      const step = cond.step
      if (!Number.isInteger(step) || step < 0 || step >= at) {
        throw BunQLError.badRequest(`a batch condition may only name an earlier step, got ${step}`)
      }
      return cond.type === "ok" ? results[step] !== null : errors[step] !== null
    }
    case "not":
      return !evalCond(cond.cond, results, errors, at, stream)
    case "and":
      return cond.conds.every((c) => evalCond(c, results, errors, at, stream))
    case "or":
      return cond.conds.some((c) => evalCond(c, results, errors, at, stream))
    case "is_autocommit":
      return stream.tx === null
    default:
      throw BunQLError.badRequest(`unknown batch condition ${JSON.stringify(cond)}`)
  }
}

function steps(batch: HranaBatch): HranaBatch["steps"] {
  if (!batch || !Array.isArray(batch.steps)) {
    throw BunQLError.badRequest("a batch needs a steps array")
  }
  return batch.steps
}

/**
 * Runs a conditional batch. A step whose condition is false is skipped and reports neither a
 * result nor an error, which is exactly what makes `@libsql/client`'s `ROLLBACK` step — guarded by
 * `not(ok(commitStep))` — fire only when the commit did not happen.
 */
export async function runBatch(
  service: HranaService,
  stream: HranaStream,
  batch: HranaBatch,
): Promise<HranaBatchResult> {
  const list = steps(batch)
  const results: (HranaStmtResult | null)[] = new Array(list.length).fill(null)
  const errors: (HranaBatchResult["step_errors"][number] | null)[] = new Array(list.length).fill(null)
  for (let i = 0; i < list.length; i++) {
    const step = list[i]
    if (!step || typeof step !== "object") throw BunQLError.badRequest(`steps[${i}] must be an object`)
    if (step.condition != null && !evalCond(step.condition, results, errors, i, stream)) continue
    try {
      results[i] = await executeStmt(service, stream, step.stmt)
    } catch (err) {
      errors[i] = toHranaError(err)
    }
  }
  return { step_results: results, step_errors: errors }
}

/**
 * The same batch as a cursor's entries. A skipped step contributes nothing at all, which is how a
 * reader tells "did not run" from "ran and failed".
 */
export async function cursorEntries(
  service: HranaService,
  stream: HranaStream,
  batch: HranaBatch,
): Promise<CursorEntry[]> {
  const list = steps(batch)
  const out: CursorEntry[] = []
  const results: (HranaStmtResult | null)[] = new Array(list.length).fill(null)
  const errors: (unknown | null)[] = new Array(list.length).fill(null)
  for (let i = 0; i < list.length; i++) {
    const step = list[i]
    if (!step || typeof step !== "object") throw BunQLError.badRequest(`steps[${i}] must be an object`)
    if (step.condition != null && !evalCond(step.condition, results, errors, i, stream)) continue
    let result: HranaStmtResult
    try {
      result = await executeStmt(service, stream, step.stmt)
    } catch (err) {
      errors[i] = err
      out.push({ type: "step_error", step: i, error: toHranaError(err) })
      continue
    }
    results[i] = result
    out.push({ type: "step_begin", step: i, cols: result.cols })
    for (const row of result.rows) out.push({ type: "row", row })
    out.push({
      type: "step_end",
      affected_row_count: result.affected_row_count,
      last_insert_rowid: result.last_insert_rowid,
    })
  }
  return out
}

// ── sequence and describe ──────────────────────────────────────────────────────────────────────

/**
 * `;`-separated SQL, rows ignored. The script is split before it runs (see `./sql.ts`) rather than
 * handed to one `sqlite3_exec`, because each statement has to take the ordinary stream path: that
 * is what gives a migration script its txids, its change events, and a working `BEGIN` … `COMMIT`
 * in the middle of it.
 */
export async function runSequence(
  service: HranaService,
  stream: HranaStream,
  sql: string,
): Promise<void> {
  for (const one of splitStatements(sql)) {
    await executeStmt(service, stream, { sql: one, want_rows: false })
  }
}

/**
 * Prepares without stepping. Parameter names come from SQLite itself, so `?` reports null and
 * `:id` reports `":id"` exactly as the client expects. `is_explain` is a prefix test on the SQL
 * because `sqlite3_stmt_isexplain` is not in the driver's symbol table.
 */
export function describe(
  service: HranaService,
  stream: HranaStream,
  sql: string,
): HranaDescribeResult {
  const runtime = service.runtime
  const tenant = runtime.tenant(stream.db)
  return runtime.withReader(tenant, stream.principal, (db) => {
    const stmt = db.prepare(sql)
    const params: { name: string | null }[] = []
    for (let i = 1; i <= stmt.paramsCount; i++) {
      params.push({ name: cstr(db.lib.symbols.sqlite3_bind_parameter_name(stmt.handle, i)) })
    }
    const declared = stmt.declaredTypes
    const cols = stmt.columnNames.map((name, i) => ({ name, decltype: declared[i] ?? null }))
    return { params, cols, is_explain: isExplain(sql), is_readonly: stmt.readonly }
  })
}

// ── the request dispatcher shared by the pipeline and the socket ────────────────────────────────

/**
 * One stream request. `close` is handled by the caller, which owns the stream table; everything
 * else is here so the pipeline and the WebSocket cannot answer the same request differently.
 */
export async function runStreamRequest(
  service: HranaService,
  stream: HranaStream,
  request: StreamRequest,
): Promise<StreamResponse> {
  switch (request?.type) {
    case "execute":
      return { type: "execute", result: await executeStmt(service, stream, request.stmt) }
    case "batch":
      return { type: "batch", result: await runBatch(service, stream, request.batch) }
    case "sequence":
      await runSequence(service, stream, stream.sqlOf(request))
      return { type: "sequence" }
    case "describe":
      return { type: "describe", result: describe(service, stream, stream.sqlOf(request)) }
    case "store_sql":
      stream.storeSql(request.sql_id, request.sql)
      return { type: "store_sql" }
    case "close_sql":
      stream.closeSql(request.sql_id)
      return { type: "close_sql" }
    case "get_autocommit":
      return { type: "get_autocommit", is_autocommit: stream.tx === null }
    case "close":
      return { type: "close" }
    default:
      throw BunQLError.badRequest(
        `unknown Hrana request type ${JSON.stringify((request as { type?: unknown })?.type)}`,
      )
  }
}
