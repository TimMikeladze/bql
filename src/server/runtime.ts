// Invariant: one `AuthorizerHub` per connection and one `TenantRealtime` per open tenant, both
// owned here and nowhere else. The hub is created from the tenant's `onConnection` seam, before
// any request can borrow the connection, because a pooled reader outlives the request that first
// opened it and a second hub on the same connection would fight the first for SQLite's single
// authorizer slot.
//
// Second invariant: a tenant that somebody is subscribed to is pinned in the registry. The
// capture hooks live on its writer connection, so an LRU eviction would end the feed without
// anyone noticing.
//
// Third invariant: readers are borrowed through `withReader` and nowhere else, because a pooled
// reader keeps the last request's authorizer until the next one re-scopes it — that is what makes
// re-scoping free, and it is only safe while every borrow goes through the same door.

import type { Args } from "../client/protocol.ts"
import {
  AuthorizerHub,
  type IncludeLevel,
  type LiveExecute,
  TenantRealtime,
} from "../realtime/index.ts"
import type { Publisher } from "../realtime/index.ts"
import type { Database } from "../sqlite/index.ts"
import {
  type ReaderLease,
  type Tenant,
  TenantError,
  TenantRegistry,
} from "../tenant/index.ts"
import {
  applyPolicy,
  type Authenticator,
  pinQueryOnly,
  type Principal,
} from "./auth.ts"
import type { ServerConfig } from "./config.ts"
import { BunQLError } from "./errors.ts"
import { decodeArgs, encodeRows, type EncodedRows } from "./json.ts"
import { Metrics } from "./metrics.ts"

/** An interactive transaction held open across requests or WebSocket messages (design §6.3). */
export interface TxSession {
  /** 128 random bits, hex. The only thing a client presents to reach the open writer. */
  baton: string
  db: string
  tenant: Tenant
  principal: Principal
  /** Set for a transaction begun over a WebSocket, so closing the socket rolls it back. */
  owner: object | null
  startedAt: number
  rowsMode: "array" | "object"
}

export interface RuntimeOptions {
  config: ServerConfig
  auth: Authenticator
  registry?: TenantRegistry
  metrics?: Metrics
  onError?: (err: unknown) => void
  /** Called for every tenant the registry opens; the embedded API's `on("commit")` needs it. */
  onTenantOpen?: (tenant: Tenant) => void
}

export class ServerRuntime {
  readonly config: ServerConfig
  readonly auth: Authenticator
  readonly registry: TenantRegistry
  readonly metrics: Metrics
  readonly node: string

  #hubs = new WeakMap<Database, AuthorizerHub>()
  #realtime = new Map<string, TenantRealtime>()
  #unhook = new Map<string, () => void>()
  #subscribers = new Map<string, number>()
  /** Databases whose engine is being kept alive for a reconnect; see `releaseSubscription`. */
  #retiring = new Map<string, ReturnType<typeof setTimeout>>()
  #tx = new Map<string, TxSession>()
  #txByDb = new Map<string, TxSession>()
  #publisher: Publisher | null = null
  #onError: (err: unknown) => void
  #closed = false

  constructor(options: RuntimeOptions) {
    this.config = options.config
    this.auth = options.auth
    this.metrics = options.metrics ?? new Metrics()
    this.node = options.config.server.node
    this.#onError =
      options.onError ?? ((err: unknown) => console.error("bunql: server runtime", err))
    this.registry =
      options.registry ??
      TenantRegistry.open({
        dir: options.config.data.dir,
        maxOpen: options.config.data.maxOpen,
        readers: options.config.data.readers,
        pageSize: options.config.data.pageSize,
        quotaBytes: options.config.data.quotaBytes,
        checkpointWalBytes: options.config.durability.checkpointWalBytes,
        defaultAck: options.config.durability.defaultAck,
        onError: this.#onError,
        onConnection: (db, role) => this.#adopt(db, role),
        ...(options.onTenantOpen ? { onOpen: options.onTenantOpen } : {}),
      })
  }

  /**
   * Where an unexpected failure goes. Clients only ever see "internal error" (design §6.6), so
   * this is the only place a 500 leaves a trace at all.
   */
  report(err: unknown): void {
    this.#onError(err)
  }

  /** Where the socket layer plugs `server.publish` in, so change fan-out is Bun's, not ours. */
  setPublisher(publisher: Publisher | null): void {
    this.#publisher = publisher
    for (const realtime of this.#realtime.values()) realtime.bus.setPublisher(publisher)
  }

  /** The tenant, or 404. Also refreshes its place in the LRU. */
  tenant(name: string): Tenant {
    if (this.#closed) throw new BunQLError("INTERNAL", "server is closing", 503)
    return this.registry.open(name)
  }

  /** The authorizer hub for a connection this runtime opened. */
  hubFor(db: Database): AuthorizerHub {
    let hub = this.#hubs.get(db)
    if (!hub) {
      hub = new AuthorizerHub(db)
      this.#hubs.set(db, hub)
    }
    return hub
  }

  /**
   * Borrows a reader, scopes it to `principal` and runs `fn`. The policy is deliberately left
   * installed when the lease goes back: the next borrower re-scopes, and skipping the teardown is
   * what makes a repeat request on the same connection cost no SQLite call at all.
   */
  withReader<T>(tenant: Tenant, principal: Principal, fn: (db: Database) => T): T {
    const lease: ReaderLease = tenant.acquireReader()
    try {
      applyPolicy(lease.db, this.hubFor(lease.db), principal, tenant.name, { queryOnly: true })
      return fn(lease.db)
    } finally {
      tenant.releaseReader(lease)
    }
  }

  // ── realtime (design §4.6) ───────────────────────────────────────────────────────────────────

  /**
   * The realtime engine for a tenant, created on the first subscription. `include` raises the
   * capture level when a later subscriber wants more than the current one does; the engine itself
   * keeps the highest level any live subscription asked for.
   */
  realtimeFor(tenant: Tenant): TenantRealtime {
    const existing = this.#realtime.get(tenant.name)
    if (existing) return existing
    const realtime = new TenantRealtime({
      name: tenant.name,
      db: tenant.writer,
      hub: this.hubFor(tenant.writer),
      execute: this.#defaultExecute(tenant),
      ring: {
        maxBytes: this.config.realtime.ringBytes,
        maxAgeMs: this.config.realtime.ringMaxAgeMs,
      },
      maxLiveQueries: this.config.realtime.maxLiveQueries,
      maxRows: this.config.realtime.maxRowsPerLive,
      // The engine keeps capturing at `pk` even with nobody subscribed, for as long as it is
      // retained: a ring that stops filling would answer a reconnect with "nothing happened"
      // when the truth is "I stopped looking".
      autoDisable: false,
      includeRows: "pk",
      publisher: this.#publisher,
      onError: (id, error) => this.#onError(new Error(`live query ${id}: ${String(error)}`)),
    })
    realtime.setTxid(Number(tenant.txid))
    // This ring starts empty on a database that already has a history, so every position before
    // now is unservable rather than "nothing happened".
    realtime.ring.seal(Number(tenant.txid))
    this.#realtime.set(tenant.name, realtime)
    this.#unhook.set(
      tenant.name,
      tenant.onCommit((event) => {
        try {
          realtime.afterCommit(Number(event.txid))
        } catch (err) {
          this.#onError(err)
        }
      }),
    )
    return realtime
  }

  /** A runner for a live query, already carrying its subscriber's policy and row mode. */
  liveRunner(tenant: Tenant, principal: Principal, rows: "array" | "object"): LiveExecute {
    return (sql: string, args: Args | undefined): EncodedRows =>
      this.withReader(tenant, principal, (db) => {
        const stmt = db.prepare(sql)
        return encodeRows(stmt, stmt.values(...decodeArgs(args)), rows)
      })
  }

  /** Counts a subscription against a tenant and pins it open while any remain. */
  retain(name: string): void {
    const retiring = this.#retiring.get(name)
    if (retiring) {
      clearTimeout(retiring)
      this.#retiring.delete(name)
    }
    this.#subscribers.set(name, (this.#subscribers.get(name) ?? 0) + 1)
    this.registry.pin(name)
  }

  /**
   * Drops a subscription. The last one out does not close the engine straight away: the ring is
   * what serves a `Last-Event-ID` reconnect, and a client that drops and comes back a second
   * later would otherwise always be told to re-query. The engine is closed once the retain window
   * passes with nobody having come back.
   */
  releaseSubscription(name: string): void {
    const next = (this.#subscribers.get(name) ?? 1) - 1
    if (next > 0) {
      this.#subscribers.set(name, next)
      return
    }
    this.#subscribers.delete(name)
    const retainMs = this.config.realtime.idleRetainMs
    if (retainMs <= 0 || this.#closed) {
      this.registry.unpin(name)
      this.closeRealtime(name)
      return
    }
    if (this.#retiring.has(name)) return
    const timer = setTimeout(() => {
      this.#retiring.delete(name)
      if (this.#subscribers.has(name)) return
      this.registry.unpin(name)
      this.closeRealtime(name)
    }, retainMs)
    timer.unref?.()
    this.#retiring.set(name, timer)
  }

  closeRealtime(name: string): void {
    const retiring = this.#retiring.get(name)
    if (retiring) {
      clearTimeout(retiring)
      this.#retiring.delete(name)
    }
    const realtime = this.#realtime.get(name)
    if (!realtime) return
    this.#realtime.delete(name)
    this.#unhook.get(name)?.()
    this.#unhook.delete(name)
    try {
      realtime.close()
    } catch (err) {
      this.#onError(err)
    }
  }

  realtimeOf(name: string): TenantRealtime | undefined {
    return this.#realtime.get(name)
  }

  // ── interactive transactions (design §6.3) ───────────────────────────────────────────────────

  /**
   * Takes the tenant's writer and files a baton for it. A second transaction on the same database
   * is refused with 409 `TX_BUSY` rather than queued: the writer is the scarce thing, and a queue
   * would let one stalled client hold every other one's latency hostage.
   */
  beginTx(
    tenant: Tenant,
    principal: Principal,
    options: {
      mode?: "deferred" | "immediate" | "exclusive"
      owner?: object | null
      rows?: "array" | "object"
    } = {},
  ): TxSession {
    if (this.#txByDb.has(tenant.name) || tenant.txOpen) {
      throw new BunQLError("TX_BUSY", `${tenant.name} already has an open transaction`, 409)
    }
    const baton = randomBaton()
    const session: TxSession = {
      baton,
      db: tenant.name,
      tenant,
      principal,
      owner: options.owner ?? null,
      startedAt: Date.now(),
      rowsMode: options.rows ?? "array",
    }
    tenant.txBegin({
      ...(options.mode ? { mode: options.mode } : {}),
      idleTimeoutMs: this.config.limits.txIdleTimeoutMs,
      onExpire: () => this.#forgetTx(session),
      ack: this.config.durability.defaultAck,
    })
    this.#tx.set(baton, session)
    this.#txByDb.set(tenant.name, session)
    this.registry.pin(tenant.name)
    this.metrics.transaction()
    return session
  }

  /** The session behind a baton, or 404. */
  txSession(baton: string): TxSession {
    const session = this.#tx.get(baton)
    if (!session) {
      throw new BunQLError("TX_NOT_FOUND", "no such transaction, or it has already ended", 404)
    }
    return session
  }

  endTx(session: TxSession, how: "commit" | "rollback"): bigint {
    try {
      if (how === "commit") return session.tenant.txCommit()
      session.tenant.txRollback()
      return session.tenant.txid
    } finally {
      this.#forgetTx(session)
    }
  }

  /** Rolls back every transaction a WebSocket left behind when it closed. */
  rollbackOwned(owner: object): void {
    for (const session of [...this.#tx.values()]) {
      if (session.owner !== owner) continue
      try {
        this.endTx(session, "rollback")
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  get openTxCount(): number {
    return this.#tx.size
  }

  #forgetTx(session: TxSession): void {
    this.#tx.delete(session.baton)
    if (this.#txByDb.get(session.db) === session) this.#txByDb.delete(session.db)
    if (!this.#subscribers.has(session.db)) this.registry.unpin(session.db)
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  /** Closes a tenant's subscriptions, transactions and connections — used by delete and restore. */
  evict(name: string): void {
    for (const session of [...this.#tx.values()]) {
      if (session.db !== name) continue
      try {
        session.tenant.txRollback()
      } catch (err) {
        this.#onError(err)
      }
      this.#forgetTx(session)
    }
    this.closeRealtime(name)
    this.#subscribers.delete(name)
    this.registry.unpin(name)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const session of [...this.#tx.values()]) {
      try {
        session.tenant.txRollback()
      } catch {
        // Shutting down: an uncommitted transaction leaves nothing behind anyway.
      }
    }
    this.#tx.clear()
    this.#txByDb.clear()
    for (const name of [...this.#realtime.keys()]) this.closeRealtime(name)
    this.#subscribers.clear()
    this.registry.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  // -------------------------------------------------------------------------

  /**
   * Every connection the registry opens passes through here before anything uses it: it gets its
   * hub, and `query_only` is pinned to what its role will always want, so the request path never
   * pays for the pragma.
   */
  #adopt(db: Database, role: "writer" | "reader"): void {
    this.#hubs.set(db, new AuthorizerHub(db))
    try {
      pinQueryOnly(db, role === "reader")
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * The registry's fallback runner. Every subscription this server makes carries its own
   * `principalRunner`, so this is only reached by a caller that did not ask for one.
   */
  #defaultExecute(tenant: Tenant): LiveExecute {
    return (sql: string, args: Args | undefined): EncodedRows =>
      tenant.readSync((db) => {
        const stmt = db.prepare(sql)
        return encodeRows(stmt, stmt.values(...decodeArgs(args)))
      })
  }
}

/** 128 random bits as hex: a baton nobody can guess and nothing else in the process reuses. */
export function randomBaton(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

/** Turns a tenant failure into the HTTP shape of design §6.6. */
export function mapTenantError(err: unknown): unknown {
  if (!(err instanceof TenantError)) return err
  switch (err.code) {
    case "DB_EXISTS":
      return new BunQLError("CONFLICT", err.message, 409)
    case "WRITE_IN_PROGRESS":
    case "BUSY":
      return BunQLError.busy(err.message)
    case "CLOSED":
      return new BunQLError("BUSY", err.message, 503)
    case "NO_SNAPSHOT":
      return BunQLError.badRequest(err.message)
    default:
      return new BunQLError(err.code, err.message, 500)
  }
}

export type { IncludeLevel }
