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
import { type ClusterLink, ClusterNode, raftUrl } from "../cluster/index.ts"
import {
  AckTimeout,
  AckTracker,
  generationId,
  NoReplicas,
  ReplicaClient,
  type ReplicaMode,
  ReplicaNotice,
  type ReplicaView,
  ReplicationServer,
  type ShardHost,
} from "../replication/index.ts"
import {
  AuthorizerHub,
  type IncludeLevel,
  type LiveExecute,
  TenantRealtime,
} from "../realtime/index.ts"
import type { Publisher } from "../realtime/index.ts"
import type { Database } from "../sqlite/index.ts"
import { RECORD_VERSION_LOGICAL } from "../wal/index.ts"
import { parseRetentionMs, S3Store, ShipperPool } from "../storage/index.ts"
import {
  type AckLevel,
  type ReaderLease,
  type ReadTx,
  type Tenant,
  TenantError,
  TenantRegistry,
} from "../tenant/index.ts"
import {
  applyPolicy,
  type Authenticator,
  INTERNAL_HOLDER,
  type PinHolder,
  pinOwner,
  pinQueryOnly,
  type Principal,
} from "./auth.ts"
import type { ServerConfig } from "./config.ts"
import { BqlError } from "./errors.ts"
import { Forwarder, runForward } from "./forward.ts"
import { FencedNotice, httpBase, type NodeRole, Promoter } from "./promote.ts"
import { decodeArgs, encodeRows, type EncodedRows } from "./json.ts"
import { FollowPlanner } from "./follow.ts"
import { Metrics } from "./metrics.ts"
import { shardOf } from "./workers/shard.ts"

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

/**
 * An open read transaction and its baton (`docs/r10-read-transactions.md`).
 *
 * Deliberately not a `TxSession` with a flag on it: that type is the writer — one per database, a
 * queue in front of it, a lease check at commit, a txid out of it — and a read transaction has
 * none of those, so a shared type would be half meaningless whichever kind it held.
 */
export interface ReadTxSession {
  baton: string
  db: string
  tenant: Tenant
  principal: Principal
  /** Set for one begun over a WebSocket, so closing the socket ends it. */
  owner: object | null
  startedAt: number
  rowsMode: "array" | "object"
  tx: ReadTx
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
  /**
   * C4b: which half of `/v1/replication` this runtime holds.
   *
   * - `"own"` (default) — a single-threaded node: one `ReplicationServer` that owns its sockets.
   * - `"none"` — the router thread of a `workers > 1` node. It owns the sockets but no tenant, so
   *   the server itself lives on the workers and `src/server/workers/replication.ts` is what it
   *   holds instead.
   * - `"hosted"` — a worker thread: a `ReplicationServer` whose connections are adopted from that
   *   router. `docs/c4b-replication-workers.md`.
   */
  replicationMode?: "own" | "none" | "hosted"
  /**
   * C4d: which half of the control plane this runtime holds.
   *
   * - `"own"` (default) — a single-threaded node: a real `ClusterNode` and a `Promoter` that does
   *   everything.
   * - `"routed"` — the router thread of a `workers > 1` node: a real `ClusterNode`, and a
   *   `Promoter` whose control-plane half is off, because a claim, an ack and a promotion request
   *   are all made of tenant facts and every tenant is on a worker.
   * - `"hosted"` — a worker thread: a `HostedCluster` over the router's pushed view, and a
   *   `Promoter` doing everything over its own shard. `docs/c4d-cluster-workers.md`.
   */
  clusterMode?: "own" | "routed" | "hosted"
  /**
   * C4d: the shard this runtime is, when it is a worker. `owns(db)` is what keeps the claim loops
   * — which read the node-level catalog — from claiming every database from every thread.
   */
  shard?: { index: number; workers: number }
  /** C4d: the worker's `HostedCluster`. Only read when `clusterMode` is `"hosted"`. */
  clusterLink?: ClusterLink | null
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
  readonly cluster: ClusterLink | null
  /** Which databases this node is the primary for, and the only thing that changes that. */
  readonly promoter: Promoter
  /** C3b: which upstreams this node follows, as placement decides them. */
  readonly follows: FollowPlanner
  /**
   * The primary's `/v1/replication` endpoint, or null when `[replication] secret` is empty —
   * which is what `403 REPLICATION_DISABLED` is answered from.
   */
  readonly replication: ReplicationServer | null
  /** C4b: `"own"` on a single-threaded node, `"none"` on a router, `"hosted"` in a worker. */
  readonly replicationMode: "own" | "none" | "hosted"
  /** C4d: `"own"` on a single-threaded node, `"routed"` on a router, `"hosted"` in a worker. */
  readonly clusterMode: "own" | "routed" | "hosted"
  /**
   * The replica's client, or null on a primary. Started by `startServer`, stopped by `close`.
   *
   * C3b: on a node whose upstreams are chosen by placement there may be **several** — one per
   * upstream *node*, not per database — and this is the statically configured one, or the first
   * when there is no static one. Everything that asks about a particular database asks
   * `replicaFor(db)`; everything that asks about the node asks `replicaClients`.
   */
  replica: ReplicaClient | null = null
  /**
   * C3b: every upstream this node follows, by its `/v1/replication` URL. A node with
   * `[replication] primary` and no cluster has exactly one entry and behaves as it always did.
   */
  readonly #clients = new Map<string, ReplicaClient>()
  /** C4c/C3b: how a `"routed"` client's per-database work is reached, one host per upstream. */
  #shards: ((url: string) => ShardHost) | null = null
  /** C4c: where a worker sends `followPrimary`, since the one client is on the router. */
  #onFollowPrimary: ((url: string) => void) | null = null
  /** C4d: this worker's shard, or null on a thread that owns every database it is asked about. */
  #shard: { index: number; workers: number } | null = null
  /** C4d: where a worker reports a role flip, since the router's catalog read cannot see it. */
  #onRoleChanged: ((db: string, role: NodeRole) => void) | null = null
  /** C4e: how the router asks the workers which databases are open. Null on every other thread. */
  #openStates: (() => Promise<Map<string, bigint>>) | null = null
  /** C3b: told when an upstream client is created, so a router can wire its `FollowHost`. */
  #onUpstream: ((url: string, client: ReplicaClient) => void) | null = null
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
  #retiring = new Map<string, { timer: ReturnType<typeof setTimeout>; owner: PinHolder }>()
  #tx = new Map<string, TxSession>()
  #txByDb = new Map<string, TxSession>()
  /** Open read transactions by baton. A separate space: these hold readers, not the writer. */
  #readTx = new Map<string, ReadTxSession>()
  /** Transactions waiting for the writer, per database, in arrival order (R5's finding). */
  #txQueue = new Map<string, TxWaiter[]>()
  #publisher: Publisher | null = null
  #onMoved: ((db: string, primary: string) => void) | null = null
  #onTenantOpen: ((tenant: Tenant) => void) | null = null
  /** Told when a database leaves this node; see `onEvict`. */
  #onEvict: ((name: string) => void)[] = []
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
          ? console.error(`bql: ${err.message}`)
          : console.error("bql: server runtime", err))
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
        deferAppend: options.config.durability.deferAppend,
        maxGroupCommit: options.config.limits.groupCommitMax,
        maxQueuedWrites: options.config.limits.maxQueuedWrites,
        maxQueuedWriteBytes: options.config.limits.maxQueuedWriteBytes,
        queueWaitMs: options.config.limits.queueWaitMs,
        maxPinnedPerPrincipal: options.config.limits.maxPinnedPerPrincipal,
        fsyncSweep: options.config.durability.fsyncSweep,
        applyMechanism: options.config.replication.apply,
        applyBusyMs: options.config.replication.applyBusyMs,
        // L3: on a worker, `maxOpen` here is this shard's *share* of the node's budget and the
        // descriptor table is shared with every other shard, so the check belongs to the router,
        // which knows the node's number and performs it once.
        ...(options.shard ? ({ fdBudget: false } as const) : {}),
        onError: this.#onError,
        onConnection: (db, role) => this.#adopt(db, role),
        onChange: (event) => this.#databasesChanged(event),
        onOpen: (tenant) => this.#tenantOpened(tenant),
      })
    this.#onTenantOpen = options.onTenantOpen ?? null
    this.storage = buildShipperPool(options.config, this.registry, this.#onError)
    this.replicationMode = options.replicationMode ?? "own"
    this.replication =
      options.config.replication.secret && this.replicationMode !== "none"
        ? new ReplicationServer({
            registry: this.registry,
            node: this.node,
            secret: options.config.replication.secret,
            heartbeatMs: options.config.replication.heartbeatMs,
            slowReplicaMs: options.config.replication.slowReplicaMs,
            hosted: this.replicationMode === "hosted",
            // P9: every `SUBSCRIBED` tells the replica whether this node's records carry rows.
            recordsLogical: options.config.replication.logicalChanges !== false,
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
      // R8: a database may answer differently from the node it is on, so the node's setting is the
      // fallback rather than the rule. Memoised in the registry; `docs/r8-per-db-ack.md`.
      withoutReplicasOf: (db) => this.registry.ackWithoutReplicasOf(db),
    })
    this.forwarder = new Forwarder(this)
    this.clusterMode = options.clusterMode ?? "own"
    this.#shard = options.shard ?? null
    // C4d: a worker holds no Raft log, no socket and no timer — the router holds one of each for
    // the node — so its link to the control plane is a `HostedCluster` over the table the router
    // pushes it, handed in by `entry.ts` rather than built here, which keeps this module from
    // importing the worker channel it knows nothing else about.
    this.cluster =
      this.clusterMode === "hosted"
        ? (options.clusterLink ?? null)
        : buildClusterNode(options.config, this.#onError)
    this.promoter = new Promoter(this)
    this.cluster?.onChange(() => this.promoter.onClusterChange())
    // C3b: placement decides which node subscribes to which, and both a placement and a node's
    // advertise can move — so the planner also sweeps on a tick of its own.
    this.follows = new FollowPlanner(this)
    this.cluster?.onChange(() => this.follows.plan())
    this.#startSweep()
  }

  // ── role (C2) ────────────────────────────────────────────────────────────────────────────────

  /**
   * What this node reports in `BQL-Role` when the request names no database, and what the
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
   * May this node write to this database at all? On the write path, and the only thing on it that
   * asks anything outside the tenant.
   *
   * Two questions, in cost order: is this a replica copy (one `Set.has`), and does this node hold
   * the database's lease (one `Map.get` and one `performance.now()` on a clustered node, one null
   * check everywhere else).
   */
  assertWritable(db: string): void {
    this.promoter.assertWritable(db)
  }

  /** Starts the control plane. Called by `startServer` beside `startReplication`. */
  async startCluster(): Promise<void> {
    if (!this.cluster) return
    await this.cluster.start()
    // C4d: the router's `Promoter` claims nothing, acks nothing and promotes nothing — a claim, an
    // ack and a promotion request are all made of tenant facts, and every tenant is on a worker.
    // It keeps `roleFor` and `primaryFor`, which the node-level routes read.
    if (this.clusterMode !== "routed") this.promoter.start()
    // Never on a worker: the upstream connections are the router's, and a worker's hosted clients
    // are created by the `follow.start` the router sends (C3b).
    if (this.replicationMode !== "hosted") this.follows.start()
  }

  /**
   * Whether this thread owns `db`. True everywhere except on a worker, where it is the shard
   * function — so the claim loops, which read the node-level catalog, do not claim every database
   * from every thread. The same rule `entry.ts` asserts on a hopped request, applied to a loop.
   */
  owns(db: string): boolean {
    const shard = this.#shard
    return shard === null || shardOf(db, shard.workers) === shard.index
  }

  /**
   * Points this node's replication client at `url`, starting one if it had none. This is how a
   * demoted primary converges on the node that took its database over without an operator.
   */
  followPrimary(url: string): void {
    if (!url) return
    if (this.#clients.size === 1 && this.replica) {
      // One upstream and it moved: retarget rather than opening a second socket to the same node.
      this.replica.retarget(url)
      return
    }
    if (this.#clients.size > 1) {
      // C3b: several upstreams, so this is one more rather than a move of the only one.
      this.ensureUpstream(url)
      return
    }
    if (!this.config.replication.secret) return
    if (this.replicationMode === "hosted") {
      // C4c closes C4b §6's gap: the upstream socket, the reconnect and the ledger are node-level
      // and the router holds exactly one of each, so a worker reports the URL rather than opening
      // a socket of its own. The safety half of the demotion already happened on this thread — the
      // database is a replica copy now and refuses writes with `NOT_PRIMARY`.
      this.#onFollowPrimary?.(url)
      return
    }
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
          const tenant = this.registry.open(name)
          // Before retention, not after: the floor the sweep is about to apply is derived from the
          // oldest snapshot kept, so a database with none has no floor to protect it.
          void this.maybeSnapshot(tenant).catch((err) => this.#onError(err))
          this.retainTenant(tenant, retentionMs)
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
   * Takes a local snapshot when the newest one is older than `[durability] snapshotIntervalMs`,
   * which is what gives a node with no bucket and no replicas a retention floor at all
   * (`docs/r6-retention.md`'s open finding). A node that snapshots for another reason — the S3
   * shipper, a replica bootstrap — rarely reaches the interval, so it does nothing there.
   *
   * Skipped for a replica (it has no write path to snapshot), for a database nothing has written
   * since its last snapshot (the snapshot would be the same file at the same txid), and while
   * anything else holds the tenant exclusively.
   */
  async maybeSnapshot(tenant: Tenant, now = Date.now()): Promise<boolean> {
    const every = this.config.durability.snapshotIntervalMs
    if (!(every > 0) || tenant.role !== "primary" || tenant.closed) return false
    // The sweep's timer and a shutdown race: this is `await`ed from a `setInterval`, so a snapshot
    // that started before `close()` finishes after it and files its ref into a catalog that is
    // gone. It was only ever a logged error — the snapshot itself is on disk and the next open
    // finds it — but a shutdown that logs an error is a shutdown people learn to ignore.
    if (this.registry.closed) return false
    const stats = tenant.stats()
    if (stats.txid === 0n) return false
    const newest = tenant.snapshots().at(-1)
    if (newest) {
      if (BigInt(newest.txid) >= stats.txid) return false
      if (now - newest.createdAtMs < every) return false
    }
    await tenant.snapshot()
    return true
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
    // C4b: in a worker this asks the router to announce, because the announcement is one fact
    // about the whole node and only the router can assemble it. Every other caller of `announce()`
    // — C2's promotion among them — is carried across the same way, without a second hook.
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
    // P9: with `[replication] logicalChanges` on, every database this node owns must capture rows
    // from its first write, whether or not anything local is watching — the record is the
    // subscriber, and a database whose engine is created lazily on the first HTTP subscription
    // would ship empty records until someone happened to subscribe.
    if (this.config.replication.logicalChanges !== false && !tenant.isReplica) {
      try {
        this.realtimeFor(tenant)
      } catch (err) {
        this.#onError(err)
      }
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
      return BqlError.ackTimeout(err.message, {
        txid: Number(err.txid),
        acks: err.outcome.acks,
        needed: err.outcome.needed,
      })
    }
    if (err instanceof NoReplicas) {
      return BqlError.noReplicas(
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
    this.ensureUpstream(section.primary, section.follow)
  }

  /** One client for one upstream, in whichever of C4c's three modes this thread is. */
  #buildReplica(url: string, follow: string[]): ReplicaClient | null {
    const section = this.config.replication
    if (!section.secret && this.replicationMode !== "hosted") return null
    // C4c: `"routed"` on a router that has shards to hand streams to, `"hosted"` in a worker, and
    // `"own"` on a single-threaded node. One class, three modes, one copy of every decision —
    // `docs/c4c-replication-follow.md` §5.
    const mode: ReplicaMode =
      this.replicationMode === "hosted" ? "hosted" : this.#shards ? "routed" : "own"
    return new ReplicaClient({
      registry: this.registry,
      primary: url,
      secret: section.secret,
      node: this.node,
      follow,
      reconnectMs: section.reconnectMs,
      heartbeatMs: section.heartbeatMs,
      forwardTimeoutMs: section.forwardTimeoutMs,
      maxForwards: section.maxForwards,
      onError: this.#onError,
      mode,
      ...(this.#shards && mode === "routed" ? { host: this.#shards(url) } : {}),
    })
  }

  /**
   * C4c: where a `"routed"` client's per-database work happens. Set by `startServer` after the pool
   * exists and before `startReplication`, so the client is built knowing which mode it is in.
   *
   * C3b: a **factory**, because a node whose upstreams are chosen by placement holds one client
   * per upstream and each needs its own host — the stream table on the worker side is keyed by the
   * upstream a stream belongs to.
   */
  setShardHost(host: ((url: string) => ShardHost) | null): void {
    this.#shards = host
  }

  /** C3b: where a router learns that an upstream client now exists. */
  setUpstreamHandler(handler: ((url: string, client: ReplicaClient) => void) | null): void {
    this.#onUpstream = handler
  }

  /** C3b: every upstream this node follows. One entry on a statically configured replica. */
  get replicaClients(): ReplicaClient[] {
    return [...this.#clients.values()]
  }

  /**
   * The client that follows `db`, or null when nothing does.
   *
   * Asked by everything that is about one database — the forwarder, the promotion request, the
   * per-database replication route — because with placement the answer differs per database.
   */
  replicaFor(db: string): ReplicaClient | null {
    if (this.#clients.size <= 1) return this.replica
    for (const client of this.#clients.values()) {
      if (client.status().streams.some((one) => one.db === db)) return client
    }
    return this.replica
  }

  /**
   * Follows `url`, with `follow` as the database list, starting a client if there is none for it.
   * Returns the client. C3b's entry point, and `followPrimary`'s.
   */
  ensureUpstream(url: string, follow?: string[]): ReplicaClient | null {
    // A hosted client opens no socket and proves nothing — the router did both — so it needs no
    // secret, and its `url` is a key rather than an address.
    if (!url) return null
    if (this.replicationMode !== "hosted" && !this.config.replication.secret) return null
    const existing = this.#clients.get(url)
    if (existing) {
      if (follow) existing.setFollow(follow)
      return existing
    }
    const client = this.#buildReplica(url, follow ?? this.config.replication.follow)
    if (!client) return null
    this.#clients.set(url, client)
    this.replica ??= client
    // C3b: a router has to wire this client's `FollowHost` before it can answer anything, and the
    // client is built here rather than by `startServer`, so the wiring is told.
    this.#onUpstream?.(url, client)
    client.start()
    return client
  }

  /** The client for one upstream key, or null. C3b's worker side looks its hosted clients up here. */
  upstreamClient(url: string): ReplicaClient | null {
    return this.#clients.get(url) ?? null
  }

  /**
   * P9: whether the primary this node follows `db` from announced that its records carry row
   * changes. Every upstream is asked, not just `replica`, because C4c lets one node follow several
   * and only one of them holds any given database.
   */
  recordsLogicalUpstream(db: string): boolean {
    for (const client of this.#clients.values()) {
      if (client.recordsLogical(db)) return true
    }
    return false
  }

  /** Stops following `url` and forgets its client. The copies it bootstrapped are left alone. */
  dropUpstream(url: string): void {
    const client = this.#clients.get(url)
    if (!client) return
    this.#clients.delete(url)
    client.stop()
    if (this.replica === client) {
      this.replica = this.#clients.values().next().value ?? null
    }
  }

  /** C4b §6's gap: where a worker sends a demotion's convergence, since the router holds the client. */
  setFollowPrimaryHandler(handler: ((url: string) => void) | null): void {
    this.#onFollowPrimary = handler
  }

  /**
   * C4d: where a worker reports a role flip. The router reads the catalog for `BQL-Role` and for
   * the `requirePrimary` gate, and a row another thread rewrote fires no `onChange` here.
   */
  setRoleHandler(handler: ((db: string, role: NodeRole) => void) | null): void {
    this.#onRoleChanged = handler
  }

  /** Called by `Promoter.#flip`, the one place a database's role changes. */
  roleChanged(db: string, role: NodeRole): void {
    this.#onRoleChanged?.(db, role)
  }

  /** C4e: where the router learns which databases its workers hold open. */
  setOpenStates(source: (() => Promise<Map<string, bigint>>) | null): void {
    this.#openStates = source
  }

  /**
   * Which databases are open on this node and how far each has got, or **null** when this thread
   * is the one that holds them — in which case the caller reads `registry.openNames` directly and
   * pays nothing. Only a router has to ask, and only `GET /v1/db` asks.
   */
  openStates(): Promise<Map<string, bigint>> | null {
    return this.#openStates?.() ?? null
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
    if (this.#closed) throw new BqlError("INTERNAL", "server is closing", 503)
    try {
      return this.registry.open(name)
    } catch (err) {
      // C3: a database this node holds no copy of, that the cluster *does* know and places
      // elsewhere, is a direction rather than a `404` — the `NOT_PRIMARY` + `BQL-Primary` C2
      // already built, which `wrap()` turns into a same-origin `307`.
      //
      // On the miss path only, so the happy path is untouched: this costs nothing at all until a
      // request has already failed to find its database.
      if (err instanceof BqlError && err.code === "DB_NOT_FOUND") this.promoter.assertPlacedHere(name)
      throw err
    }
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
    const configured = this.config.replication.logicalChanges
    const logicalLevel: IncludeLevel | null = configured === false ? null : configured
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
      replica: tenant.isReplica,
      // P9: two things can answer "can this feed carry rows" before a record arrives on it. The
      // link is the better one — the primary says what it records, per database, on `SUBSCRIBED` —
      // and the local log covers a replica that is up but not currently connected: the version of
      // the last record it applied is what its primary was recording when it last spoke.
      logicalSeen: () =>
        this.recordsLogicalUpstream(tenant.name) ||
        tenant.lastRecordVersion >= RECORD_VERSION_LOGICAL,
      // P9: a replica records nothing — it publishes what it is sent. `logicalChanges` says what a
      // node records for the databases it *owns*.
      logicalChanges: tenant.isReplica ? null : logicalLevel,
      publisher: this.#publisher,
      onError: (id, error) => this.#onError(new Error(`live query ${id}: ${String(error)}`)),
    })
    realtime.setTxid(Number(tenant.txid))
    // This ring starts empty on a database that already has a history, so every position before
    // now is unservable rather than "nothing happened".
    realtime.ring.seal(Number(tenant.txid))
    this.#realtime.set(tenant.name, realtime)
    // P9: the record is the subscriber. The recorder drains the capture on the write path and
    // stages what it drained for `afterCommit`, so the primary's own feed is untouched.
    if (logicalLevel !== null && !tenant.isReplica) {
      tenant.setLogicalRecorder((txids) => realtime.recordLogical(txids))
    }
    // A replica has no preupdate hooks to drain — its transactions arrive as WAL frames through
    // `applyRecord` — so its realtime is driven by `afterApply`, which re-runs every live query
    // and emits a txid-only change event (`plan-phase1.md` finding 3).
    const replicaMode = tenant.isReplica
    this.#unhook.set(
      tenant.name,
      tenant.onCommit((event) => {
        try {
          // P9: `event.record.logical` is the row changes the primary recorded, when it did.
          if (replicaMode) realtime.afterApply(Number(event.txid), event.record.logical ?? null)
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

  /**
   * Counts a subscription against a tenant and pins it open while any remain.
   *
   * L4: `owner` is the **principal**, not a single anonymous holder, because a pin lasts as long as
   * a client keeps its subscription open. `[limits] maxPinnedPerPrincipal` is what stops one client
   * pinning two thousand databases past `maxOpen`; it throws `PIN_LIMIT` before the subscriber
   * count moves, so a refused subscription leaves nothing behind.
   */
  retain(name: string, owner: PinHolder = INTERNAL_HOLDER): void {
    this.registry.pin(name, owner.owner, { capped: owner.capped })
    const retiring = this.#retiring.get(name)
    if (retiring) {
      // The window's own pin goes back here, having been replaced by this subscription's.
      clearTimeout(retiring.timer)
      this.#retiring.delete(name)
      this.registry.unpin(name, retiring.owner.owner)
    }
    this.#subscribers.set(name, (this.#subscribers.get(name) ?? 0) + 1)
  }

  /**
   * Drops a subscription. The last one out does not close the engine straight away: the ring is
   * what serves a `Last-Event-ID` reconnect, and a client that drops and comes back a second
   * later would otherwise always be told to re-query. The engine is closed once the retain window
   * passes with nobody having come back.
   */
  releaseSubscription(name: string, owner: PinHolder = INTERNAL_HOLDER): void {
    const next = (this.#subscribers.get(name) ?? 1) - 1
    if (next > 0) {
      // Somebody else is still subscribed, so only this holder's claim goes back. The tenant stays
      // pinned by theirs, which is exactly what per-owner pins are for.
      this.#subscribers.set(name, next)
      this.registry.unpin(name, owner.owner)
      return
    }
    this.#subscribers.delete(name)
    const retainMs = this.config.realtime.idleRetainMs
    if (retainMs <= 0 || this.#closed) {
      this.registry.unpin(name, owner.owner)
      this.closeRealtime(name)
      return
    }
    if (this.#retiring.has(name)) {
      this.registry.unpin(name, owner.owner)
      return
    }
    // The last subscriber out keeps its pin for the retain window, because the window exists to
    // keep the *ring* alive for a client that reconnects with `Last-Event-ID`, and an evicted
    // tenant takes the ring with it. It is charged to that principal until the window closes,
    // which is bounded by `[realtime] idleRetainMs` rather than by how long a client feels like
    // staying — the distinction L4 is about.
    const timer = setTimeout(() => {
      this.#retiring.delete(name)
      this.registry.unpin(name, owner.owner)
      if (this.#subscribers.has(name)) return
      this.closeRealtime(name)
    }, retainMs)
    timer.unref?.()
    this.#retiring.set(name, { timer, owner })
  }

  closeRealtime(name: string): void {
    const retiring = this.#retiring.get(name)
    if (retiring) {
      clearTimeout(retiring.timer)
      this.#retiring.delete(name)
      this.registry.unpin(name, retiring.owner.owner)
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

  /**
   * L8: records that one statement of the open transaction has finished, so a group commit of
   * fifty writes reaches the change feed as fifty events keyed `(txid, seq)` rather than one.
   *
   * A `Map.get` and, when somebody is actually subscribed, one `push`. A database with no realtime
   * engine — which is every database nobody is watching — costs the `Map.get` and nothing else.
   */
  markStatement(db: string): void {
    this.#realtime.get(db)?.markStatement()
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
      throw new BqlError("TX_BUSY", `${tenant.name} already has an open transaction`, 409)
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
    // A baton pin is keyed by the principal too, so `pinnedBy` is a true account of what one
    // client is holding — but it is not *capped*: a transaction is already leashed by
    // `[limits] txIdleTimeoutMs`, and `maxOpenTx` is 1 per database, so it cannot accumulate.
    this.registry.pin(tenant.name, pinOwner(principal).owner)
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
        if (!(err instanceof BqlError) || err.code !== "TX_BUSY") throw err
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
            new BqlError(
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

  // ── read transactions (docs/r10-read-transactions.md) ────────────────────────────────────────

  /**
   * Opens a read transaction on a leased reader. Unlike `beginTx` there is no queue and no lease
   * check, because no writer is taken — which is why it works on a replica, where the writer
   * belongs to the applier, and why it does not block writes on a primary.
   */
  beginReadTx(
    tenant: Tenant,
    principal: Principal,
    options: { owner?: object | null; rows?: "array" | "object" } = {},
  ): ReadTxSession {
    if (tenant.openReadTx >= this.config.limits.maxReadTx) {
      throw new BqlError(
        "TX_BUSY",
        `${tenant.name} already has ${tenant.openReadTx} read transactions open`,
        409,
      )
    }
    const baton = randomBaton()
    const tx = tenant.readTxBegin({
      idleTimeoutMs: this.config.limits.txIdleTimeoutMs,
      maxMs: this.config.limits.readTxTimeoutMs,
      onExpire: () => this.#forgetReadTx(baton),
    })
    const session: ReadTxSession = {
      baton,
      db: tenant.name,
      tenant,
      principal,
      owner: options.owner ?? null,
      startedAt: Date.now(),
      rowsMode: options.rows ?? "array",
      tx,
    }
    this.#readTx.set(baton, session)
    // Bounded by `[limits] maxReadTx` and `readTxTimeoutMs`, so pinned by the principal and
    // uncapped for the same reason a baton transaction is.
    this.registry.pin(tenant.name, pinOwner(principal).owner)
    this.metrics.transaction()
    return session
  }

  /** The read session behind a baton, or 404. */
  readTxSession(baton: string): ReadTxSession {
    const session = this.#readTx.get(baton)
    if (!session) {
      throw new BqlError("TX_NOT_FOUND", "no such transaction, or it has already ended", 404)
    }
    return session
  }

  /**
   * Ends a read transaction. `commit` and `rollback` do the same thing, because a read transaction
   * has nothing to commit — the distinction only exists because the client says one or the other.
   */
  endReadTx(session: ReadTxSession): void {
    try {
      if (session.tx.open) session.tenant.readTxEnd(session.tx)
    } finally {
      this.#forgetReadTx(session.baton)
    }
  }

  get openReadTxCount(): number {
    return this.#readTx.size
  }

  #forgetReadTx(baton: string): void {
    const session = this.#readTx.get(baton)
    if (!session) return
    this.#readTx.delete(baton)
    this.registry.unpin(session.db, pinOwner(session.principal).owner)
  }

  /** The session behind a baton, or 404. */
  txSession(baton: string): TxSession {
    const session = this.#tx.get(baton)
    if (!session) {
      throw new BqlError("TX_NOT_FOUND", "no such transaction, or it has already ended", 404)
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
    for (const session of [...this.#readTx.values()]) {
      if (session.owner !== owner) continue
      try {
        this.endReadTx(session)
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
    // Per-owner counts, so this releases exactly this transaction's claim: a subscription the same
    // principal holds on the same database keeps its own, and another principal's is untouched.
    this.registry.unpin(session.db, pinOwner(session.principal).owner)
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

  /**
   * Called whenever a database leaves this node. `src/server/surfaces.ts` registers here to drop
   * its introspection and GraphQL schema caches: those invalidate themselves on `PRAGMA
   * schema_version`, which a re-created database of the same name resets to 1 — so deletion is the
   * one case the version counter cannot cover (`docs/h6-mount.md`).
   *
   * A list rather than a single callback, and an import direction of `surfaces.ts → runtime.ts`
   * only, so the runtime owes the surfaces nothing.
   */
  onEvict(listener: (name: string) => void): () => void {
    this.#onEvict.push(listener)
    return () => {
      const at = this.#onEvict.indexOf(listener)
      if (at >= 0) this.#onEvict.splice(at, 1)
    }
  }

  /** Closes a tenant's subscriptions, transactions and connections — used by delete and restore. */
  evict(name: string): void {
    for (const listener of this.#onEvict) {
      try {
        listener(name)
      } catch (err) {
        this.#onError(err)
      }
    }
    for (const session of [...this.#tx.values()]) {
      if (session.db !== name) continue
      try {
        session.tenant.txRollback()
      } catch (err) {
        this.#onError(err)
      }
      this.#forgetTx(session)
    }
    for (const session of [...this.#readTx.values()]) {
      if (session.db !== name) continue
      try {
        this.endReadTx(session)
      } catch (err) {
        this.#onError(err)
      }
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
    for (const session of [...this.#readTx.values()]) {
      try {
        if (session.tx.open) session.tenant.readTxEnd(session.tx)
      } catch {
        // Same: a read transaction has nothing to lose.
      }
    }
    this.#readTx.clear()
    this.#tx.clear()
    this.#txByDb.clear()
    for (const [db, queue] of this.#txQueue) {
      for (const waiter of queue) {
        clearTimeout(waiter.timer)
        waiter.reject(new BqlError("BUSY", `${db} is closing`, 503))
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
    this.follows.close()
    for (const client of this.#clients.values()) client.stop()
    this.#clients.clear()
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
    // L6: 0 means "follow `[s3] concurrency`", which is the honest default — the store's own gate
    // is the node's real ceiling on requests and a larger budget here would only move the queueing
    // into it, where the priority ordering is lost.
    maxConcurrentUploads: s3.maxConcurrentUploads || s3.concurrency,
    uploadWaitMs: s3.uploadWaitMs,
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
      // replica that cannot reach its primary. The code and the `BQL-Primary` header are the
      // ones phase 0 documented, so a client that already follows them keeps working.
      return BqlError.notPrimary(primary ?? undefined)
    case "DB_EXISTS":
      return new BqlError("CONFLICT", err.message, 409)
    case "WRITE_IN_PROGRESS":
    case "BUSY":
      return BqlError.busy(err.message)
    case "CLOSED":
      return new BqlError("BUSY", err.message, 503)
    case "NO_SNAPSHOT":
      return BqlError.badRequest(err.message)
    default:
      return new BqlError(err.code, err.message, 500)
  }
}

export type { IncludeLevel }
