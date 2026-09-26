// Write forwarding (design §5.2: "replicas serve reads, forward writes to the primary,
// transparent to clients"). Both halves live here: the replica's outbound path and the primary's
// handler for what arrives.
//
// Invariant: a forwarded write executes exactly once, on the primary, under the caller's own
// principal. The replica classifies the statement with `sqlite3_stmt_readonly` exactly as the
// local path does — a read never leaves the node — and hands anything else over whole, so the
// primary runs the client's request rather than a re-derivation of it.
//
// Second invariant: the principal crosses the wire as its claims, not as its token. Two nodes in
// a cluster share a cluster secret, not JWT key material, so the *socket* is the trust boundary:
// the primary rebuilds the principal with `tokenPrincipal` and applies the same table ACLs it
// would have applied locally. A node that lets an untrusted peer complete the `HELLO` handshake
// has already lost, with or without this.

import type {
  BatchRequest,
  BatchResult,
  QueryRequest,
  QueryResult,
  RequestOptions,
  StatementRequest,
} from "../client/protocol.ts"
import { ForwardError, type ForwardBody } from "../replication/index.ts"
import type { Tenant } from "../tenant/index.ts"
import { ADMIN, type Principal, requireScope, type TokenClaims, tokenPrincipal } from "./auth.ts"
import { BqlError, mapError } from "./errors.ts"
import {
  assertStatement,
  executeBatch,
  executeInTx,
  executeStatement,
  failedIndexOf,
  markFailedIndex,
  resolveOptions,
  type ResolvedOptions,
} from "./exec.ts"
import type { ServerRuntime } from "./runtime.ts"

/** The ops a replica forwards. Anything else is a protocol error on the primary. */
export type ForwardOp = "query" | "batch" | "tx.begin" | "tx.exec" | "tx.commit" | "tx.rollback"

/** A principal as it travels between nodes: the claims, never the token they were signed into. */
export type WirePrincipal = { kind: "admin" } | { kind: "token"; claims: TokenClaims }

/** `ForwardBody.body` for every op. */
export interface ForwardPayload {
  principal: WirePrincipal
  /** The request body the client sent, unmodified. */
  body: unknown
  /** The primary's own baton, for the three `tx.*` ops that continue one. */
  tx?: string
}

/** A transaction a client opened on this replica that actually lives on the primary. */
export interface RemoteTx {
  /** The baton the client holds — the primary's, handed straight through. */
  baton: string
  db: string
  principal: Principal
  /** The WebSocket that opened it, so closing the socket rolls it back. */
  owner: object | null
  startedAtMs: number
}

export function wirePrincipal(principal: Principal): WirePrincipal {
  return principal.kind === "admin" ? { kind: "admin" } : { kind: "token", claims: principal.claims }
}

function principalFrom(wire: WirePrincipal | undefined): Principal {
  if (wire?.kind === "admin") return ADMIN
  if (wire?.kind === "token" && wire.claims && typeof wire.claims === "object") {
    return tokenPrincipal(wire.claims)
  }
  throw BqlError.unauthenticated("the forwarded write carried no usable principal")
}

// ── the replica's side ─────────────────────────────────────────────────────────────────────────

/**
 * Turns a write this node cannot take into a round trip over the replication socket. One per
 * runtime; `enabled` is false on a primary and on a replica with `forwardWrites = false`, and the
 * caller then falls back to `503 NOT_PRIMARY` exactly as it did before R2.
 */
export class Forwarder {
  readonly runtime: ServerRuntime

  #remote = new Map<string, RemoteTx>()

  constructor(runtime: ServerRuntime) {
    this.runtime = runtime
  }

  /**
   * Whether *any* database on this node forwards. Kept for the callers that ask before they know
   * which database is involved; `enabledFor` is the per-database answer, and C2 made that
   * distinction matter — a node promoted for `acme` still forwards writes for `beta`.
   */
  get enabled(): boolean {
    return this.runtime.config.replication.forwardWrites && this.runtime.replica !== null
  }

  enabledFor(db: string): boolean {
    return this.enabled && this.runtime.roleFor(db) === "replica"
  }

  /**
   * Whether these statements have to go to the primary. Classification is SQLite's own
   * `sqlite3_stmt_readonly` on a pooled reader — the same call `executeStatement` makes — so a
   * read on a replica is served locally and nothing else is guessed at.
   */
  needsPrimary(tenant: Tenant, principal: Principal, sql: string[]): boolean {
    if (!this.enabledFor(tenant.name)) return false
    return this.runtime.withReader(tenant, principal, (db) => {
      for (const one of sql) {
        if (!db.prepare(one).readonly) return true
      }
      return false
    })
  }

  /** Transactions this node opened on the primary. */
  get openRemoteTx(): number {
    return this.#remote.size
  }

  remoteTx(baton: string): RemoteTx | undefined {
    const found = this.#remote.get(baton)
    if (!found) return undefined
    if (this.#expired(found)) {
      this.#remote.delete(baton)
      return undefined
    }
    return found
  }

  /**
   * A baton the primary has certainly dropped. The primary rolls an idle transaction back on its
   * own timer, and a client that walks away would otherwise leave its mapping here for the life of
   * the process — so the mapping expires a few idle periods after the transaction it names.
   */
  #expired(session: RemoteTx): boolean {
    const idleMs = this.runtime.config.limits.txIdleTimeoutMs
    if (idleMs <= 0) return false
    return Date.now() - session.startedAtMs > idleMs * 4
  }

  #prune(): void {
    for (const [baton, session] of this.#remote) {
      if (this.#expired(session)) this.#remote.delete(baton)
    }
  }

  async query(
    tenant: Tenant,
    principal: Principal,
    body: QueryRequest,
    options: ResolvedOptions,
  ): Promise<QueryResult> {
    requireScope(principal, tenant.name, "rw")
    const result = (await this.#send(tenant.name, "query", {
      principal: wirePrincipal(principal),
      body: withAck(body, options),
    })) as QueryResult
    await this.#settle(tenant, result?.txid)
    return result
  }

  async batch(
    tenant: Tenant,
    principal: Principal,
    body: BatchRequest,
    options: ResolvedOptions,
  ): Promise<BatchResult> {
    requireScope(principal, tenant.name, "rw")
    const result = (await this.#send(tenant.name, "batch", {
      principal: wirePrincipal(principal),
      body: withAck(body, options),
    })) as BatchResult
    await this.#settle(tenant, result?.txid)
    return result
  }

  /** Opens a transaction on the primary and files its baton here. */
  async txBegin(
    tenant: Tenant,
    principal: Principal,
    body: unknown,
    owner: object | null,
  ): Promise<{ tx: string; expiresInMs: number }> {
    requireScope(principal, tenant.name, "rw")
    this.#prune()
    const answer = (await this.#send(tenant.name, "tx.begin", {
      principal: wirePrincipal(principal),
      body,
    })) as { tx?: string; expiresInMs?: number }
    if (typeof answer?.tx !== "string") {
      throw new BqlError("INTERNAL", "the primary opened a transaction without a baton", 500)
    }
    this.#remote.set(answer.tx, {
      baton: answer.tx,
      db: tenant.name,
      principal,
      owner,
      startedAtMs: Date.now(),
    })
    return { tx: answer.tx, expiresInMs: answer.expiresInMs ?? 0 }
  }

  async txExec(session: RemoteTx, principal: Principal, body: unknown): Promise<QueryResult> {
    requireScope(principal, session.db, "rw")
    return (await this.#send(session.db, "tx.exec", {
      principal: wirePrincipal(principal),
      body,
      tx: session.baton,
    })) as QueryResult
  }

  /** Commits or rolls back on the primary and drops the baton whatever the answer is. */
  async txEnd(
    session: RemoteTx,
    principal: Principal,
    how: "commit" | "rollback",
  ): Promise<{ txid: number }> {
    requireScope(principal, session.db, "rw")
    this.#remote.delete(session.baton)
    const answer = (await this.#send(session.db, `tx.${how}`, {
      principal: wirePrincipal(principal),
      body: {},
      tx: session.baton,
    })) as { txid?: number }
    const txid = Number(answer?.txid ?? 0)
    if (how === "commit") {
      const tenant = this.#tenantOrNull(session.db)
      if (tenant) await this.#settle(tenant, txid)
    }
    return { txid }
  }

  /** Rolls back, on the primary, every forwarded transaction a closed socket left behind. */
  rollbackOwned(owner: object): void {
    for (const session of [...this.#remote.values()]) {
      if (session.owner !== owner) continue
      void this.txEnd(session, session.principal, "rollback").catch(() => {
        // The primary's idle timer is the backstop; a socket that is already gone cannot be told.
      })
    }
  }

  #tenantOrNull(db: string): Tenant | null {
    try {
      return this.runtime.tenant(db)
    } catch {
      return null
    }
  }

  /**
   * Read-your-writes on the node the client is actually talking to: the write committed on the
   * primary, so this node waits for its own applier to reach that txid before answering. A wait
   * that expires is not a failed write — the transaction is committed and its txid is in the
   * answer — so the result goes back regardless and the client can still read it elsewhere.
   */
  async #settle(tenant: Tenant, txid: number | undefined): Promise<void> {
    if (!txid || !Number.isFinite(txid)) return
    const want = BigInt(Math.floor(txid))
    if (want <= tenant.txid) return
    try {
      await tenant.waitFor(want, this.runtime.config.replication.ackTimeoutMs)
    } catch {
      // Streaming is behind, or the stream is down. The write happened; say so.
    }
  }

  async #send(db: string, op: string, payload: ForwardPayload): Promise<unknown> {
    const replica = this.runtime.replica
    if (!replica) throw BqlError.notPrimary(this.runtime.primaryUrlFor(db) ?? undefined)
    this.runtime.metrics.forwarded()
    try {
      return await replica.forward({ db, op, body: payload })
    } catch (err) {
      throw this.#raise(err, db)
    }
  }

  /** The primary's failure, re-raised here as if this node had produced it. */
  #raise(err: unknown, db: string): unknown {
    if (!(err instanceof ForwardError)) return err
    const details = err.details ?? {}
    const primary = this.runtime.primaryUrlFor(db)
    // A `NOT_PRIMARY` from the primary is itself a pre-execution refusal — it was fenced, or it
    // never owned this database — so it stays a `NOT_PRIMARY` and stays safe to retry. A
    // `FORWARD_TIMEOUT` never becomes one, because that one means "may or may not have committed".
    if (err.code === "NOT_PRIMARY") return BqlError.notPrimary(primary ?? undefined)
    const mapped = new BqlError(err.code, err.message, err.status, {
      ...(details.txid !== undefined ? { txid: details.txid } : {}),
      ...(primary ? { primary } : {}),
    })
    if (details.failedIndex !== undefined) markFailedIndex(mapped, details.failedIndex)
    return mapped
  }
}

/** Carries the resolved `ack` into the forwarded body, so the primary waits for the level asked. */
function withAck<T extends RequestOptions>(body: T, options: ResolvedOptions): T {
  return { ...body, ack: options.ack }
}

// ── the primary's side ─────────────────────────────────────────────────────────────────────────

/**
 * Runs one forwarded request. Every op goes through the same `exec.ts` entry point an HTTP
 * request would, so a forwarded write is subject to the same policy, deadlines, row caps and ack
 * levels — the only thing it skips is the node's own HTTP parsing.
 */
export async function runForward(
  runtime: ServerRuntime,
  request: ForwardBody,
  node: string,
): Promise<unknown> {
  const payload = (request.body ?? {}) as ForwardPayload
  const principal = principalFrom(payload.principal)
  const db = String(request.db ?? "")
  try {
    switch (request.op as ForwardOp) {
      case "query":
        return await forwardedQuery(runtime, db, principal, payload)
      case "batch":
        return await forwardedBatch(runtime, db, principal, payload)
      case "tx.begin":
        return await forwardedTxBegin(runtime, db, principal, payload, node)
      case "tx.exec":
        return forwardedTxExec(runtime, principal, payload)
      case "tx.commit":
      case "tx.rollback":
        return await forwardedTxEnd(runtime, principal, payload, request.op === "tx.commit")
      default:
        throw BqlError.badRequest(`a replica forwarded an unknown op ${JSON.stringify(request.op)}`)
    }
  } catch (err) {
    throw asWireError(err)
  }
}

async function forwardedQuery(
  runtime: ServerRuntime,
  db: string,
  principal: Principal,
  payload: ForwardPayload,
): Promise<QueryResult> {
  requireScope(principal, db, "rw")
  const tenant = runtime.tenant(db)
  const body = payload.body as QueryRequest
  assertStatement(body, "request")
  const options = resolveOptions(body, null, runtime.config)
  const { result } = executeStatement(runtime, tenant, principal, body, options)
  await runtime.awaitDurable(db, BigInt(result.txid), options.ack)
  return result
}

async function forwardedBatch(
  runtime: ServerRuntime,
  db: string,
  principal: Principal,
  payload: ForwardPayload,
): Promise<BatchResult> {
  requireScope(principal, db, "rw")
  const tenant = runtime.tenant(db)
  const body = payload.body as BatchRequest
  const options = resolveOptions(body, null, runtime.config)
  const result = executeBatch(runtime, tenant, principal, body, options)
  await runtime.awaitDurable(db, BigInt(result.txid), options.ack)
  return result
}

async function forwardedTxBegin(
  runtime: ServerRuntime,
  db: string,
  principal: Principal,
  payload: ForwardPayload,
  node: string,
): Promise<{ tx: string; expiresInMs: number }> {
  requireScope(principal, db, "rw")
  const tenant = runtime.tenant(db)
  const body = (payload.body ?? {}) as { mode?: "deferred" | "immediate" | "exclusive"; rows?: "array" | "object" }
  const session = await runtime.beginTxQueued(tenant, principal, {
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.rows ? { rows: body.rows } : {}),
    // The replica that opened it owns it: if its socket drops, the transaction goes with it
    // rather than holding this node's only writer until the idle timer notices.
    origin: node,
  })
  return { tx: session.baton, expiresInMs: runtime.config.limits.txIdleTimeoutMs }
}

function forwardedTxExec(
  runtime: ServerRuntime,
  principal: Principal,
  payload: ForwardPayload,
): QueryResult {
  const session = runtime.txSession(String(payload.tx ?? ""))
  requireScope(principal, session.db, "rw")
  const body = payload.body as StatementRequest
  assertStatement(body, "query")
  const options = resolveOptions(
    { rows: session.rowsMode, ...(body as RequestOptions) },
    null,
    runtime.config,
  )
  return executeInTx(runtime, session.tenant, principal, body, options)
}

async function forwardedTxEnd(
  runtime: ServerRuntime,
  principal: Principal,
  payload: ForwardPayload,
  commit: boolean,
): Promise<{ txid: number }> {
  const session = runtime.txSession(String(payload.tx ?? ""))
  requireScope(principal, session.db, "rw")
  const txid = runtime.endTx(session, commit ? "commit" : "rollback")
  if (commit) {
    await runtime.awaitDurable(session.db, txid, runtime.config.durability.defaultAck)
  }
  return { txid: Number(txid) }
}

/**
 * The error a `RESULT` frame carries. It is mapped here, on the primary, so the code and status
 * the client eventually sees are the ones this node decided on — a `SQLITE_CONSTRAINT` stays a
 * `SQLITE_CONSTRAINT` with its 409, rather than becoming somebody's idea of a transport failure.
 */
function asWireError(err: unknown): BqlError {
  const { status, body } = mapError(err, {
    ...(failedIndexOf(err) !== undefined ? { failedIndex: failedIndexOf(err) } : {}),
  })
  const wire = new BqlError(body.error.code, body.error.message, status, {
    ...(body.error.txid !== undefined ? { txid: body.error.txid } : {}),
    ...(body.error.failedIndex !== undefined ? { failedIndex: body.error.failedIndex } : {}),
  })
  return wire
}
