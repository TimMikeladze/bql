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
//
// The trash sweep lives here because it is node-wide rather than per-database: `<dataDir>/trash/`
// is swept once in the constructor and then every `[durability] trashSweepIntervalMs` (one hour by
// default). A configured interval beats a derived one — an operator who shortens `retention` to an
// hour for a test wants to say so once, not to reason about what a divisor made of it — and the
// timer is `unref`'d and cleared in `close`, so maintenance is never why a process is still alive.

import type { Args } from "../client/protocol.ts"
import {
  AckTimeout,
  AckTracker,
  NoReplicas,
  ReplicaClient,
  ReplicaOffline,
  ReplicationServer,
} from "../replication/index.ts"
import {
  AuthorizerHub,
  type IncludeLevel,
  type LiveExecute,
  TenantRealtime,
} from "../realtime/index.ts"
import type { Publisher } from "../realtime/index.ts"
import type { Database } from "../sqlite/index.ts"
import { parseRetentionMs, S3Store, ShipperPool } from "../storage/index.ts"
import {
  type AckLevel,
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
import { Forwarder, runForward } from "./forward.ts"
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
  /** The replica node that forwarded this transaction, when it came from one (R2). */
  origin?: string
  startedAt: number
  rowsMode: "array" | "object"
}

/** What `beginTx` and `beginTxQueued` accept. */
export interface BeginTxOptions {
  mode?: "deferred" | "immediate" | "exclusive"
  owner?: object | null
  rows?: "array" | "object"
  /** The replica node that forwarded this transaction (R2). */
  origin?: string
}

/** One transaction waiting for a database's writer. */
interface TxWaiter {
  resolve: () => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
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
  /** What this node reports in `BunQL-Role` and answers writes with. */
  readonly role: "primary" | "replica"
  /**
   * The primary's `/v1/replication` endpoint, or null when `[replication] secret` is empty —
   * which is what `403 REPLICATION_DISABLED` is answered from.
   */
  readonly replication: ReplicationServer | null
  /** The replica's client, or null on a primary. Started by `startServer`, stopped by `close`. */
  replica: ReplicaClient | null = null
  /** R2: the waiter behind `ack: "replica" | "quorum"`. */
  readonly acks: AckTracker
  /** R2: the path a write takes off a replica. `enabled` is false everywhere else. */
  readonly forwarder: Forwarder
  /**
   * R3: the S3 shipper, one per database, or null when `[s3] bucket` is unset. It attaches through
   * the registry's `onOpen`, so every database this node opens starts shipping without anything on
   * a request path knowing it exists.
   */
  readonly storage: ShipperPool | null

  #hubs = new WeakMap<Database, AuthorizerHub>()
  #realtime = new Map<string, TenantRealtime>()
  #unhook = new Map<string, () => void>()
  #subscribers = new Map<string, number>()
  /** Databases whose engine is being kept alive for a reconnect; see `releaseSubscription`. */
  #retiring = new Map<string, ReturnType<typeof setTimeout>>()
  #tx = new Map<string, TxSession>()
  #txByDb = new Map<string, TxSession>()
  /** Transactions waiting for the writer, per database, in arrival order (R5's finding). */
  #txQueue = new Map<string, TxWaiter[]>()
  #publisher: Publisher | null = null
  #onTenantOpen: ((tenant: Tenant) => void) | null = null
  #onError: (err: unknown) => void
  #closed = false
  /** The `<dataDir>/trash/` sweep. Null when `retention` or the interval turns it off. */
  #trashSweeper: ReturnType<typeof setInterval> | null = null

  constructor(options: RuntimeOptions) {
    this.config = options.config
    this.auth = options.auth
    this.metrics = options.metrics ?? new Metrics()
    this.node = options.config.server.node
    this.role = options.config.replication.role
    this.#onError =
      options.onError ??
      ((err: unknown) =>
        // A replica reporting that it cannot reach its primary is operational news, not a fault
        // in this process; printing its stack would bury the faults that do have one.
        err instanceof ReplicaOffline
          ? console.error(`bunql: ${err.message}`)
          : console.error("bunql: server runtime", err))
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
        segmentBytes: options.config.durability.segmentBytes,
        onError: this.#onError,
        onConnection: (db, role) => this.#adopt(db, role),
        onChange: (event) => this.#databasesChanged(event),
        onOpen: (tenant) => this.#tenantOpened(tenant),
      })
    this.#onTenantOpen = options.onTenantOpen ?? null
    this.storage = buildShipperPool(options.config, this.registry, this.#onError)
    this.replication = options.config.replication.secret
      ? new ReplicationServer({
          registry: this.registry,
          node: this.node,
          secret: options.config.replication.secret,
          heartbeatMs: options.config.replication.heartbeatMs,
          slowReplicaMs: options.config.replication.slowReplicaMs,
          onForward: (request, node) => runForward(this, request, node),
          onDisconnect: (node) => this.rollbackOrigin(node),
          onError: this.#onError,
        })
      : null
    this.acks = new AckTracker({
      server: this.replication,
      timeoutMs: options.config.replication.ackTimeoutMs,
      withoutReplicas: options.config.replication.ackWithoutReplicas,
    })
    this.forwarder = new Forwarder(this)
    this.#startTrashSweep()
  }

  /**
   * Sweeps `<dataDir>/trash/` now and on the configured interval. Deleting a database moves its
   * directory aside and removes nothing, so this is what keeps a node that churns databases from
   * growing a trash directory for ever. The first sweep is synchronous: it is a `readdir` of a
   * directory that is usually empty, and doing it at start is what makes a node that has been
   * down past its retention come back clean.
   */
  #startTrashSweep(): void {
    const retentionMs = parseRetentionMs(this.config.durability.retention)
    if (retentionMs <= 0) return
    const sweep = (): void => {
      try {
        this.registry.sweepTrash(retentionMs)
      } catch (err) {
        this.#onError(err)
      }
    }
    sweep()
    const every = this.config.durability.trashSweepIntervalMs
    if (!(every > 0)) return
    this.#trashSweeper = setInterval(sweep, every)
    this.#trashSweeper.unref?.()
  }

  /**
   * `plan-phase1.md` finding 1: a database created here must reach a `follow: ["*"]` replica now,
   * not at the next heartbeat. The registry calls this; the announcement is one frame per
   * attached replica.
   */
  #databasesChanged(event: { kind: "create" | "delete"; name: string }): void {
    if (event.kind === "delete") {
      this.acks.forget(event.name)
      // A deleted database keeps whatever is already in the bucket — design §6.5 says the log and
      // the snapshots are retained per `retention` — but nothing more is shipped for it.
      void this.storage?.forget(event.name).catch((err) => this.#onError(err))
    }
    this.replication?.announce()
  }

  /**
   * Every tenant the registry opens passes through here: the embedded API's process-wide commit
   * listener, and the shipper that backs the database up. Both are "for every database this node
   * has open", which is exactly what `onOpen` is.
   */
  #tenantOpened(tenant: Tenant): void {
    try {
      this.#onTenantOpen?.(tenant)
    } catch (err) {
      this.#onError(err)
    }
    try {
      this.storage?.attach(tenant)
    } catch (err) {
      this.#onError(err)
    }
  }

  /** Starts the shipper sweep. Called by `startServer`, beside `startReplication`. */
  startStorage(): void {
    if (!this.storage) return
    this.storage.start()
    // The registry may already hold tenants — a runtime the embedded API built, or a registry
    // handed in by a test — and they opened before the pool existed.
    for (const name of this.registry.openNames) {
      try {
        this.storage.attach(this.registry.open(name))
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  /** Ships everything outstanding and stops the shippers. Awaited by the server handle's close. */
  async closeStorage(): Promise<void> {
    if (!this.storage) return
    try {
      await this.storage.close()
    } catch (err) {
      this.#onError(err)
    }
  }

  // ── durability levels (design §5.4) ──────────────────────────────────────────────────────────

  /**
   * Raises `NO_REPLICAS` when this node could not possibly answer the requested level. Called
   * before the statement runs, so the common misconfiguration costs no write at all.
   */
  assertAckAvailable(db: string, ack: AckLevel): void {
    try {
      this.acks.assertAvailable(db, ack)
    } catch (err) {
      throw this.#ackError(err)
    }
  }

  /**
   * Holds the answer until the requested durability level is met. A no-op for `local` and
   * `fsync`, which `Tenant.write` already satisfied before returning.
   */
  async awaitDurable(db: string, txid: bigint, ack: AckLevel): Promise<void> {
    if (ack !== "replica" && ack !== "quorum") return
    try {
      await this.acks.wait(db, txid, ack)
    } catch (err) {
      if (err instanceof AckTimeout) this.metrics.ackTimeout()
      throw this.#ackError(err)
    }
  }

  #ackError(err: unknown): unknown {
    if (err instanceof AckTimeout) {
      return BunQLError.ackTimeout(err.message, {
        txid: Number(err.txid),
        acks: err.outcome.acks,
        needed: err.outcome.needed,
      })
    }
    if (err instanceof NoReplicas) {
      return BunQLError.noReplicas(
        err.message,
        err.txid === null ? undefined : { txid: Number(err.txid) },
      )
    }
    return err
  }

  /**
   * Starts following the primary. Called by `startServer` on a replica node; separate from the
   * constructor so the embedded API can build a runtime without opening a socket.
   */
  startReplication(): void {
    if (this.replica || this.role !== "replica") return
    const section = this.config.replication
    this.replica = new ReplicaClient({
      registry: this.registry,
      primary: section.primary,
      secret: section.secret,
      node: this.node,
      follow: section.follow,
      reconnectMs: section.reconnectMs,
      heartbeatMs: section.heartbeatMs,
      forwardTimeoutMs: section.forwardTimeoutMs,
      maxForwards: section.maxForwards,
      onError: this.#onError,
    })
    this.replica.start()
  }

  /** Where a client should send a write this node cannot take. */
  get primaryUrl(): string | null {
    return this.role === "replica" && this.config.replication.primary
      ? this.config.replication.primary
      : null
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
    // A replica has no preupdate hooks to drain — its transactions arrive as WAL frames through
    // `applyRecord` — so its realtime is driven by `afterApply`, which re-runs every live query
    // and emits a txid-only change event (`plan-phase1.md` finding 3).
    const replicaMode = tenant.isReplica
    this.#unhook.set(
      tenant.name,
      tenant.onCommit((event) => {
        try {
          if (replicaMode) realtime.afterApply(Number(event.txid))
          else realtime.afterCommit(Number(event.txid))
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
   * Takes the tenant's writer and files a baton for it, or refuses `409 TX_BUSY` at once. This is
   * the immediate form; `beginTxQueued` is what the routes use.
   */
  beginTx(
    tenant: Tenant,
    principal: Principal,
    options: BeginTxOptions = {},
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
      ...(options.origin ? { origin: options.origin } : {}),
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

  /**
   * The same thing, but a database whose writer is busy is *waited* for, up to `limits.txWaitMs`,
   * instead of refused at once.
   *
   * A tenant has one writer, so `limits.maxOpenTx` is 1 and the phase-0 behaviour was an immediate
   * `409 TX_BUSY`. R5 found that this breaks any client with two concurrent request handlers and
   * worked around it with a queue in the Drizzle shim; the queue belongs here, where every client
   * gets it. `TX_BUSY` now means "the writer was busy for the whole wait", which is a real
   * overload rather than a race between two of one client's own handlers.
   */
  async beginTxQueued(
    tenant: Tenant,
    principal: Principal,
    options: BeginTxOptions = {},
  ): Promise<TxSession> {
    const deadline = Date.now() + this.config.limits.txWaitMs
    for (;;) {
      try {
        return this.beginTx(tenant, principal, options)
      } catch (err) {
        if (!(err instanceof BunQLError) || err.code !== "TX_BUSY") throw err
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) throw err
        this.metrics.txQueued()
        // Waits its turn in arrival order, and re-tries `beginTx` on the way out: the slot it was
        // handed can be taken by a plain `write()` in between, and the loop is what makes that a
        // second wait rather than a lost error. The deadline is the *total* wait, not one per
        // round, so a database that keeps being taken still answers inside `txWaitMs`.
        await this.#waitForWriter(tenant.name, remainingMs)
      }
    }
  }

  /** Resolves when the database's writer is handed on, or rejects `TX_BUSY` after `waitMs`. */
  #waitForWriter(db: string, waitMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queue = this.#txQueue.get(db) ?? []
      const waiter: TxWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#dropWaiter(db, waiter)
          reject(
            new BunQLError(
              "TX_BUSY",
              `${db} still had an open transaction after ${waitMs}ms`,
              409,
            ),
          )
        }, waitMs),
      }
      waiter.timer.unref?.()
      queue.push(waiter)
      this.#txQueue.set(db, queue)
    })
  }

  /** Hands the writer to the next transaction waiting for it, if there is one. */
  #wakeNextTx(db: string): void {
    const queue = this.#txQueue.get(db)
    if (!queue || queue.length === 0) return
    const waiter = queue.shift() as TxWaiter
    if (queue.length === 0) this.#txQueue.delete(db)
    clearTimeout(waiter.timer)
    waiter.resolve()
  }

  #dropWaiter(db: string, waiter: TxWaiter): void {
    const queue = this.#txQueue.get(db)
    if (!queue) return
    const at = queue.indexOf(waiter)
    if (at >= 0) queue.splice(at, 1)
    if (queue.length === 0) this.#txQueue.delete(db)
  }

  /** Transactions queued for a writer right now, across every database. */
  get queuedTxCount(): number {
    let total = 0
    for (const queue of this.#txQueue.values()) total += queue.length
    return total
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

  /** Rolls back every transaction a WebSocket left behind when it closed, here or on the primary. */
  rollbackOwned(owner: object): void {
    this.forwarder.rollbackOwned(owner)
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
    this.#wakeNextTx(session.db)
  }

  /** Rolls back every transaction a replica node forwarded, because its socket is gone. */
  rollbackOrigin(node: string): void {
    for (const session of [...this.#tx.values()]) {
      if (session.origin !== node) continue
      try {
        this.endTx(session, "rollback")
      } catch (err) {
        this.#onError(err)
      }
    }
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
    for (const [db, queue] of this.#txQueue) {
      for (const waiter of queue) {
        clearTimeout(waiter.timer)
        waiter.reject(new BunQLError("BUSY", `${db} is closing`, 503))
      }
    }
    this.#txQueue.clear()
    if (this.#trashSweeper !== null) {
      clearInterval(this.#trashSweeper)
      this.#trashSweeper = null
    }
    this.acks.close()
    // The awaitable form is `closeStorage()`, which `startServer`'s handle calls first; this is
    // the backstop for a caller that closes the runtime directly.
    void this.storage?.close().catch(() => {})
    for (const name of [...this.#realtime.keys()]) this.closeRealtime(name)
    this.#subscribers.clear()
    this.replica?.stop()
    this.replica = null
    this.replication?.stop()
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

/**
 * The shipper pool for a node with `[s3] bucket` set, or null. Credentials go straight into the
 * store and are never read back out: `S3Store` keeps them private and reports only the bucket,
 * the region and the endpoint.
 */
function buildShipperPool(
  config: ServerConfig,
  registry: TenantRegistry,
  onError: (err: unknown) => void,
): ShipperPool | null {
  const s3 = config.s3
  if (!s3.enabled || !s3.bucket) return null
  const store = new S3Store({
    bucket: s3.bucket,
    ...(s3.region ? { region: s3.region } : {}),
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    ...(s3.accessKeyId ? { accessKeyId: s3.accessKeyId } : {}),
    ...(s3.secretAccessKey ? { secretAccessKey: s3.secretAccessKey } : {}),
    ...(s3.sessionToken ? { sessionToken: s3.sessionToken } : {}),
    ...(s3.virtualHostedStyle ? { virtualHostedStyle: true } : {}),
    concurrency: s3.concurrency,
    retries: s3.retries,
  })
  return new ShipperPool({
    registry,
    store,
    prefix: s3.prefix,
    shipIntervalMs: s3.shipIntervalMs,
    snapshotIntervalMs: s3.snapshotIntervalMs,
    snapshotEveryBytes: s3.snapshotEveryBytes,
    maxPendingBytes: s3.maxPendingBytes,
    maxBatchBytes: config.durability.segmentBytes,
    retentionMs: parseRetentionMs(s3.retention),
    onError,
  })
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
export function mapTenantError(err: unknown, primary?: string | null): unknown {
  if (!(err instanceof TenantError)) return err
  switch (err.code) {
    case "NOT_PRIMARY":
      // What is left once R2's forwarding has declined to act: `forwardWrites = false`, or a
      // replica that cannot reach its primary. The code and the `BunQL-Primary` header are the
      // ones phase 0 documented, so a client that already follows them keeps working.
      return BunQLError.notPrimary(primary ?? undefined)
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
