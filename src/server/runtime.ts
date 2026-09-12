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
// The retention sweep lives here because it is the only place that can see every consumer of a
// database's log at once: the snapshots on disk, the replicas this node is streaming to, and the
// S3 shipper. It runs once in the constructor and then every `[durability] sweepIntervalMs` (five
// minutes by default), doing `<dataDir>/trash/` and then each open tenant. A configured interval
// beats a derived one — an operator who shortens `retention` to an hour for a test wants to say so
// once, not to reason about what a divisor made of it — and the timer is `unref`'d and cleared in
// `close`, so maintenance is never why a process is still alive.

import type { Args } from "../client/protocol.ts"
import path from "node:path"
import { ClusterNode, raftUrl } from "../cluster/index.ts"
import {
  AckTimeout,
  AckTracker,
  generationId,
  NoReplicas,
  ReplicaClient,
  ReplicaNotice,
  type ReplicaView,
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
import { FencedNotice, httpBase, type NodeRole, Promoter } from "./promote.ts"
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
  /**
   * What `[replication]` was configured as. It is **not** the live role: a node promoted at
   * runtime keeps this value and changes `role`, which is what `docs/next.md` said C2 had to fix.
   */
  readonly configuredRole: "primary" | "replica"
  /**
   * The control plane, or null when `[cluster] enabled` is false. The data path touches it in
   * exactly one place — `assertWritable` — and never awaits it.
   */
  readonly cluster: ClusterNode | null
  /** Which databases this node is the primary for, and the only thing that changes that. */
  readonly promoter: Promoter
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
  #onMoved: ((db: string, primary: string) => void) | null = null
  #onTenantOpen: ((tenant: Tenant) => void) | null = null
  #onError: (err: unknown) => void
  #closed = false
  /** The trash and per-database retention sweep. Null when `retention` or the interval turns it off. */
  #sweeper: ReturnType<typeof setInterval> | null = null
  /** `[durability] retention` in milliseconds, parsed once. 0 or less keeps everything for ever. */
  readonly #retentionMs: number

  constructor(options: RuntimeOptions) {
    this.config = options.config
    this.#retentionMs = parseRetentionMs(options.config.durability.retention)
    this.auth = options.auth
    this.metrics = options.metrics ?? new Metrics()
    this.node = options.config.server.node
    this.configuredRole = options.config.replication.role
    this.#onError =
      options.onError ??
      ((err: unknown) =>
        // A replica reporting that it cannot reach its primary, or that it has let a database go,
        // is operational news, not a fault in this process; printing its stack would bury the
        // faults that do have one. `ReplicaNotice` is the base of every such notice.
        err instanceof ReplicaNotice || err instanceof FencedNotice
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
        sqlite: options.config.sqlite,
        checkpointWalBytes: options.config.durability.checkpointWalBytes,
        defaultAck: options.config.durability.defaultAck,
        segmentBytes: options.config.durability.segmentBytes,
        compressLog: options.config.durability.compress,
        maxGroupCommit: options.config.limits.groupCommitMax,
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
          // C2's fencing signal: a peer subscribed claiming an epoch this node does not hold, so
          // the control plane granted the database elsewhere after granting it here.
          onEpochAhead: (event) =>
            this.promoter.demote(
              event.db,
              `${event.node} subscribed at epoch ${event.epoch} while this node holds ` +
                `${event.held}; this node has been fenced and is now a replica of it`,
              { node: event.node },
            ),
          // A database this node holds as a replica copy — or was promoted for — keeps the
          // identity it was bootstrapped under rather than one derived from a catalog row this
          // node wrote itself. Without this, promoting a node re-mints the database's identity and
          // every other replica trashes its copy and bootstraps again.
          generationOf: (db) => this.replica?.generationOf(db) ?? null,
          onError: this.#onError,
        })
      : null
    this.acks = new AckTracker({
      server: this.replication,
      timeoutMs: options.config.replication.ackTimeoutMs,
      withoutReplicas: options.config.replication.ackWithoutReplicas,
    })
    this.forwarder = new Forwarder(this)
    this.cluster = buildClusterNode(options.config, this.#onError)
    this.promoter = new Promoter(this)
    this.cluster?.onChange(() => this.promoter.onClusterChange())
    this.#startSweep()
  }

  // ── role (C2) ────────────────────────────────────────────────────────────────────────────────

  /**
   * What this node reports in `BunQL-Role` when the request names no database, and what the
   * `POST /v1/db` gate reads. Live: a promotion changes it without a restart.
   */
  get role(): NodeRole {
    return this.promoter.nodeRole
  }

  /** The live role for one database. Every per-database gate reads this rather than `role`. */
  roleFor(db: string): NodeRole {
    return this.promoter.roleFor(db)
  }

  /**
   * A database's identity as this node should state it: the id its copy was bootstrapped under
   * when it received one, and only otherwise one derived from its own catalog row.
   *
   * The order matters and is the same everywhere it is asked. `generationId` hashes the row's
   * `created_at`, and a replica's row was created *here* — so a node that has been promoted would
   * otherwise mint a fresh identity for a database that has not changed, and every other replica
   * of it would see a generation change, run R7's unfollow, and trash a perfectly good copy.
   */
  generationOf(db: string): string | null {
    const held = this.replica?.generationOf(db)
    if (held) return held
    const row = this.registry.list().find((one) => one.name === db)
    return row ? generationId(row) : null
  }

  /**
   * The lease check, on the write path. One `Map.get` and one `performance.now()` on a clustered
   * node; one null check on every other node.
   */
  assertWritable(db: string): void {
    if (this.cluster === null) return
    this.promoter.assertWritable(db)
  }

  /** Starts the control plane. Called by `startServer` beside `startReplication`. */
  async startCluster(): Promise<void> {
    if (!this.cluster) return
    await this.cluster.start()
    this.promoter.start()
  }

  /**
   * Points this node's replication client at `url`, starting one if it had none. This is how a
   * demoted primary converges on the node that took its database over without an operator.
   */
  followPrimary(url: string): void {
    if (!url) return
    if (this.replica) {
      this.replica.retarget(url)
      return
    }
    if (!this.config.replication.secret) return
    this.config.replication.primary = url
    this.startReplicationClient()
  }

  /** Tells every socket subscribed to `db` that it has moved (design §5.3's `moved` frame). */
  movedFrom(db: string): void {
    const where = this.promoter.primaryFor(db)
    this.#onMoved?.(db, where.url ?? where.node ?? "")
  }

  /** Where `ws.ts` plugs the `moved` fan-out in, so this module never imports the socket layer. */
  setMovedHandler(handler: ((db: string, primary: string) => void) | null): void {
    this.#onMoved = handler
  }

  /**
   * Sweeps now and on the configured interval: `<dataDir>/trash/`, then every open database's
   * snapshots and log segments. Deleting a database moves its directory aside and removes nothing,
   * and a committed transaction appends a log record that nothing else ever removes, so this is
   * what keeps a node that churns databases — or simply one that is busy — from filling its disk.
   *
   * The first sweep is synchronous, and doing it at start is what makes a node that has been down
   * past its retention come back clean rather than waiting out an interval first.
   */
  #startSweep(): void {
    const retentionMs = this.#retentionMs
    if (retentionMs <= 0) return
    const sweep = (): void => {
      try {
        this.registry.sweepTrash(retentionMs)
      } catch (err) {
        this.#onError(err)
      }
      // Only what is open. A closed tenant's log is not growing, and opening every database on the
      // node to look at one would evict the ones actually serving traffic — so a tenant gets its
      // pass when it is opened instead (`#tenantOpened`). Iterating `openNames` in order and
      // touching each through `open` leaves the LRU's recency order exactly as it found it.
      for (const name of this.registry.openNames) {
        try {
          this.retainTenant(this.registry.open(name), retentionMs)
        } catch (err) {
          // A database deleted underneath the sweep, or one that failed to open. Neither is a
          // reason to leave the rest of the node's logs unswept.
          this.#onError(err)
        }
      }
    }
    sweep()
    const every = this.config.durability.sweepIntervalMs
    if (!(every > 0)) return
    this.#sweeper = setInterval(sweep, every)
    this.#sweeper.unref?.()
  }

  /**
   * One retention pass over one open database. This is the only place that knows where all three
   * consumers of its log stand, which is why the floor is computed from here rather than inside
   * the tenant: the replicas come from this node's replication server, the bucket position from
   * its shipper, and the snapshots the tenant reads for itself.
   *
   * A failure is reported and swallowed. One tenant whose directory is unreadable must not stop
   * every other tenant on the node from being swept.
   */
  retainTenant(tenant: Tenant, retentionMs: number): void {
    try {
      // A shipper exists for every non-replica tenant this pool has seen open, so "no shipper"
      // means nothing ships this database — a replica, or a node with no `[s3] bucket` — and the
      // bucket therefore imposes no floor.
      const shipper = this.storage?.shipperFor(tenant.name)
      tenant.retain({
        retentionMs,
        maxLogBytes: this.config.durability.maxLogBytes,
        replicaTxid: slowestReplicaTxid(this.replication?.replicasOf(tenant.name) ?? []),
        shippedTxid: shipper ? shipper.shippedTxid : null,
      })
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * `plan-phase1.md` finding 1: a database created here must reach a `follow: ["*"]` replica now,
   * not at the next heartbeat. The registry calls this; the announcement is one frame per
   * attached replica.
   */
  #databasesChanged(event: { kind: "create" | "delete"; name: string }): void {
    // The per-database role cache is derived from the catalog, so it is refreshed wherever the
    // catalog's database set moves — including a bootstrap, which creates replica-role rows.
    this.promoter?.refresh()
    if (event.kind === "create") {
      void this.promoter?.claim(event.name).catch((err) => this.#onError(err))
    }
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
    // One pass at open, after the shipper is attached so its position counts. Without it a
    // database that was written to and then evicted from the LRU would keep its log until
    // something opened it again, which on a node with ten thousand tenants may be never.
    if (this.#retentionMs > 0) this.retainTenant(tenant, this.#retentionMs)
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
    if (this.replica || this.configuredRole !== "replica") return
    this.startReplicationClient()
  }

  /** The client itself, separated so `followPrimary` can start one on a node that had none. */
  startReplicationClient(): void {
    if (this.replica) return
    const section = this.config.replication
    if (!section.primary) return
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

  /**
   * Where a client should send a write this node cannot take, when the request names no database.
   * `primaryUrlFor` is the per-database answer and is what every gate that knows a database uses.
   */
  get primaryUrl(): string | null {
    return this.role === "replica" && this.config.replication.primary
      ? this.config.replication.primary
      : null
  }

  /** Where a write for one database should go: the control plane's answer, then the config's. */
  primaryUrlFor(db: string): string | null {
    return this.promoter.primaryFor(db).url
  }

  /** An HTTP base the request can be replayed against, when one is knowable. `307` uses it. */
  primaryHttpFor(db: string): string | null {
    return this.promoter.primaryFor(db).http
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
    this.assertWritable(tenant.name)
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
      if (how === "commit") {
        // An interactive transaction can be held longer than a lease lives — `txIdleTimeoutMs` is
        // 5 s and a lease is 3 s — so the lease is checked again here, at the moment the writer
        // actually commits. A lease that lapsed under an open transaction rolls it back rather
        // than committing on a node the cluster has already moved on from.
        try {
          this.assertWritable(session.db)
        } catch (err) {
          session.tenant.txRollback()
          throw err
        }
        return session.tenant.txCommit()
      }
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
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
    this.acks.close()
    // The awaitable form is `closeStorage()`, which `startServer`'s handle calls first; this is
    // the backstop for a caller that closes the runtime directly.
    void this.storage?.close().catch(() => {})
    for (const name of [...this.#realtime.keys()]) this.closeRealtime(name)
    this.#subscribers.clear()
    this.promoter.close()
    void this.cluster?.close().catch(() => {})
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
 * The lowest txid acked by a replica currently streaming a database, or null when none is.
 *
 * Only the replicas on the wire count. A replica that has gone imposes no floor: it is told
 * `RETENTION` and handed a snapshot when it comes back (`docs/r1-replication.md` deviation 4),
 * which is what stops a follower that never returns pinning the log for ever. A replica that is
 * connected but not acking does hold the log, and `[replication] slowReplicaMs` is what eventually
 * closes its socket — deleting records a live follower is about to ask for would be the silent,
 * unrecoverable failure the floor exists to prevent.
 */
export function slowestReplicaTxid(replicas: ReplicaView[]): bigint | null {
  let lowest: bigint | null = null
  for (const replica of replicas) {
    const at = BigInt(replica.txid)
    if (lowest === null || at < lowest) lowest = at
  }
  return lowest
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

/**
 * The control plane for a node with `[cluster] enabled`, or null. It is built but not started: a
 * `ClusterNode` opens its own log and dials its peers, and `startServer` does that beside the
 * replication client so nothing opens a socket before this node can answer one.
 */
function buildClusterNode(config: ServerConfig, onError: (err: unknown) => void): ClusterNode | null {
  const section = config.cluster
  if (!section.enabled) return null
  const peers: Record<string, string> = {}
  for (const entry of section.peers) {
    const [id, url] = splitPeer(entry)
    if (id && url) peers[id] = url
  }
  return new ClusterNode({
    id: section.id || config.server.node,
    dir: path.join(config.data.dir, "cluster"),
    advertise: section.advertise,
    zone: section.zone,
    peers,
    bootstrap: section.bootstrap,
    secret: config.replication.secret,
    leaseTtlMs: section.leaseTtlMs,
    leaseRenewMs: section.leaseRenewMs,
    leaseGuardMs: section.leaseGuardMs,
    electionTimeoutMs: section.electionTimeoutMs,
    heartbeatMs: section.heartbeatMs,
    onError,
  })
}

/**
 * `[cluster] peers` entries are `id=ws://host:port` or a bare `ws://host:port`, whose host:port is
 * then the id. The explicit form is what a node whose `[cluster] id` is not its host needs.
 */
export function splitPeer(entry: string): [string, string] {
  const at = entry.indexOf("=")
  if (at > 0) return [entry.slice(0, at).trim(), raftUrl(entry.slice(at + 1).trim())]
  const url = raftUrl(entry.trim())
  try {
    return [new URL(url).host, url]
  } catch {
    return ["", ""]
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
