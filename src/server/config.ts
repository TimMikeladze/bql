// Invariant: every knob has exactly three sources, in this order — a default in this file, a key
// in `bunql.toml`, an environment override named `BUNQL_*` — and the resolved config is frozen
// before anything reads it. Nothing downstream consults `process.env` or re-parses the file.
//
// Secrets are the one place with state: a node with no configured admin key or signing key
// generates them once, persists them to `<dataDir>/keys.json` with owner-only permissions, and
// prints the admin key exactly once, on the run that generated it. A JWT private key is never
// printed at all.

import fs from "node:fs"
import path from "node:path"
import { AuthKeys, type Ed25519Jwk, KeyRing } from "./auth.ts"
import { BunQLError } from "./errors.ts"

/**
 * Durability a write is answered at when the request does not say (design §5.4). `"replica"` and
 * `"quorum"` are answered by `src/replication/ack.ts` and need replicas attached; a node with
 * none answers them per `[replication] ackWithoutReplicas`.
 */
export type DefaultAck = "local" | "fsync" | "replica" | "quorum"

export interface ServerSection {
  port: number
  host: string
  /** Name this node reports in `BunQL-Node`. Defaults to the hostname. */
  node: string
  /** Also accept `{db}.host` addressing, libsql-style (design §6). */
  tenantFromHost: boolean
  /** Answer CORS preflights and echo the origin, so browser tokens work from anywhere. */
  cors: boolean
  /**
   * Worker threads to shard databases over (`docs/c4-workers.md`). 1, the default, is a single
   * thread and exactly the process this has always been — no worker is spawned and no channel
   * exists. 0 means one per core, capped at 8.
   */
  workers: number
}

export interface DataSection {
  dir: string
  maxOpen: number
  readers: number
  pageSize: number
  /** Default storage quota for new databases, in bytes. 0 is unlimited. */
  quotaBytes: number
}

/**
 * SQLite settings BunQL states rather than inherits (`docs/p1-pragmas.md`). Everything here is a
 * pragma applied per connection, so the values a connection carries do not depend on which
 * libsqlite3 was found — Apple's defaults `cache_size` to pages where upstream defaults it to KiB,
 * which is four times the cache and a different moment for dirty pages to reach the `-wal`.
 *
 * Only `writerCacheBytes` moves a default, and it moves a performance one: a 20 000-row
 * transaction goes from 41 ms to 23 ms and a single-row write does not change. Every setting that
 * changes what a statement *means* — `foreignKeys`, `trustedSchema` — defaults to today's
 * behaviour, per the rule in `docs/c6-packaging.md`.
 */
export interface SqliteSection {
  /** `PRAGMA cache_size` on the writer, in bytes. Allocated lazily, so an idle tenant pays none. */
  writerCacheBytes: number
  /** The same on each pooled reader. Reads barely move past 2 MiB; `readerMmapBytes` is the lever. */
  readerCacheBytes: number
  /**
   * `PRAGMA mmap_size` on readers, in bytes. `0` is off. A cold point read is 5.47 µs without it
   * and 3.30 µs with it — and a read error on a mapped page is a **SIGBUS that kills the process**
   * rather than an `SQLITE_IOERR` a request can answer. Reliable storage only.
   */
  readerMmapBytes: number
  /**
   * `PRAGMA foreign_keys`. Off, as SQLite has it: turning it on changes the meaning of existing
   * schemas, since a write that succeeds today can start failing `SQLITE_CONSTRAINT_FOREIGNKEY`.
   * A foreign key declared by a tenant is enforced by nothing until this is on.
   */
  foreignKeys: boolean
  /**
   * `PRAGMA trusted_schema`. SQLite defaults it on; its own hardening advice is off, which stops
   * a schema from reaching functions flagged unsafe. Relevant because `POST /v1/db/{db}/import`
   * opens a database file this server did not write.
   */
  trustedSchema: boolean
  /** `PRAGMA cell_size_check`. Catches a corrupt page at read time, for a cost on every write. */
  cellSizeCheck: boolean
}

export interface DurabilitySection {
  defaultAck: DefaultAck
  checkpointWalBytes: number
  /**
   * How long a deleted database is kept in `<dataDir>/trash/` before the sweep removes it.
   * `"0"` (or an empty string) keeps it for ever, which is what phase 0 and phase 1 did.
   */
  retention: string
  /**
   * How often the retention sweep runs: `<dataDir>/trash/`, then every open database's snapshots
   * and log segments. Five minutes by default, because a log grows far faster than the trash does;
   * `0` turns the interval off and leaves only the sweep at start.
   */
  sweepIntervalMs: number
  /**
   * Bound one database's log by size as well as by age, in bytes. `0` (the default) is unlimited.
   * It is still subject to the retention floor: a size cap never drops a segment a snapshot, a
   * connected replica or the S3 shipper can still need, because a full disk is recoverable and a
   * deleted record is not.
   */
  maxLogBytes: number
  /** Roll to a new log segment past this many bytes. Design §4.4 says 16 MB. */
  segmentBytes: number
  /**
   * Take a local snapshot of a database whose newest one is older than this, in milliseconds.
   * One hour by default; `0` turns it off.
   *
   * It closes the hole `docs/r6-retention.md` left open: the log's retention floor is derived from
   * the **oldest snapshot kept**, and only the S3 shipper and a replica bootstrap ever took one.
   * A plain node with no bucket and no replica therefore took none, ever, had no floor at all, and
   * once its oldest segment aged out it stopped being restorable to any point before it — with
   * nothing reporting that. A node that already snapshots for another reason rarely reaches this
   * interval, so it costs such a node nothing; a reflink makes it nearly free where the filesystem
   * has one.
   */
  snapshotIntervalMs: number
  /**
   * Compress transaction records with zstd. On, as every record has been since phase 0: it is
   * 4.3x on disk, on every replica's socket and in the bucket, for ~9.5 µs a record — a third of
   * a single-row write (`docs/performance.md` §1). A node with local storage, no replicas and no
   * bucket is the case for turning it off. The flag is per record, so changing it leaves
   * everything already written readable and a replica reads either kind.
   */
  compress: boolean
}

export interface RealtimeSection {
  ringBytes: number
  ringMaxAgeMs: number
  maxLiveQueries: number
  maxRowsPerLive: number
  /**
   * How long a database's realtime engine is kept after its last subscriber leaves, so a client
   * that reconnects with `Last-Event-ID` can still be served from the ring. 0 closes it at once,
   * which makes every reconnect a `reset`.
   */
  idleRetainMs: number
}

export interface LimitsSection {
  queryTimeoutMs: number
  writeTimeoutMs: number
  txIdleTimeoutMs: number
  maxRows: number
  /** Interactive transactions open at once, per database. The tenant has one writer, so: 1. */
  maxOpenTx: number
  /**
   * How long a second interactive transaction waits for the writer before it is refused
   * `409 TX_BUSY`. R5 found that failing at once breaks any client with two concurrent request
   * handlers, so the queue lives here rather than in every client.
   */
  txWaitMs: number
  /** Largest request body accepted, in bytes. `import` gets its own, larger, cap. */
  maxBodyBytes: number
  /** Largest SQLite file `POST /v1/db/{db}/import` accepts, in bytes. */
  maxImportBytes: number
  /**
   * Fold writes that arrive together into one transaction (`docs/p2-group-commit.md`). Every fixed
   * cost of the write path is per transaction, so this turns concurrency into batch size: measured
   * 4.7x at 64 concurrent clients, 2.2x at four, and 15% *slower* for a single client with nobody
   * to fold with.
   *
   * **Off by default, because it changes what a client sees**: folded writes share one txid and
   * the change feed emits one event for the fold. Each statement still gets its own result and its
   * own failure. Per the rule in `docs/c6-packaging.md`, a setting that changes meaning does not
   * take a new default.
   */
  groupCommit: boolean
  /** Most statements one group commit folds. Default 64. */
  groupCommitMax: number
}

/** Which half of a primary/replica pair this node is (design §5.2). */
export type NodeRole = "primary" | "replica"

export interface ReplicationSection {
  role: NodeRole
  /** `wss://host/v1/replication`. Required when `role = "replica"`. */
  primary: string
  /** The cluster secret. Empty disables `/v1/replication` entirely. */
  secret: string
  /** Databases a replica follows. `["*"]` is every database the primary announces. */
  follow: string[]
  /** R2: how long a write waits for replica acks before it gives up. */
  ackTimeoutMs: number
  /**
   * R2: what `ack: "replica" | "quorum"` means on a node with no replicas attached. `"error"`
   * refuses with `503 NO_REPLICAS`, because silently answering locally would be a durability
   * promise this node cannot keep; `"allow"` opts into exactly that.
   */
  ackWithoutReplicas: "error" | "allow"
  heartbeatMs: number
  /** Close a replica socket that has been backpressured this long. */
  slowReplicaMs: number
  /** First reconnect backoff step; doubles with jitter to 10 s. */
  reconnectMs: number
  /** R2: forward a write that arrives on a replica to the primary instead of refusing it. */
  forwardWrites: boolean
  /** R2: how long a forwarded write waits for the primary's `RESULT` before `504 FORWARD_TIMEOUT`. */
  forwardTimeoutMs: number
  /** R2: forwarded writes in flight at once, per replica node. Past this, `503 BUSY`. */
  maxForwards: number
}

/**
 * The built-in Raft control plane (design §5.3, `docs/plan-phase2.md` C1/C2). Off by default:
 * standalone and the static topology of §5.2 have no Raft in them at all, and a node that does not
 * enable it pays one null check on the write path.
 *
 * The cluster shares `[replication] secret` rather than having a secret of its own — the two
 * sockets are between the same nodes and a second secret would be a second thing to rotate.
 */
export interface ClusterSection {
  enabled: boolean
  /** This node's id in the Raft group. Defaults to `[server] node`. */
  id: string
  /** `ws://host:port` other nodes reach this one at; also the HTTP base clients are sent to. */
  advertise: string
  /** Rack or AZ label. C3's placement reads it; C2 only records it. */
  zone: string
  /** `id=ws://host:port`, or a bare `ws://host:port` whose host:port is then the id. */
  peers: string[]
  /** Form a new cluster from `peers` instead of waiting to be added to one. */
  bootstrap: boolean
  /** Replica factor. C3; recorded here so a config written today does not have to move. */
  rf: number
  leaseTtlMs: number
  leaseRenewMs: number
  /**
   * How long before a lease expires its holder stops accepting writes. It is the margin that makes
   * two primaries impossible, so it is the one key here that must not be tuned down casually —
   * `docs/c2-promotion.md` sets out what it covers.
   */
  leaseGuardMs: number
  /** Randomised 1x–2x per Raft. */
  electionTimeoutMs: number
  heartbeatMs: number
}

/**
 * Continuous backup to an S3-compatible bucket (design §4.4, `docs/r3-storage.md`). Everything a
 * credential falls back to Bun's own `S3_*` / `AWS_*` resolution when it is left empty, so a node
 * running with an instance role configures nothing but the bucket.
 */
export interface S3Section {
  /** Off by default. Setting `bucket` turns it on; setting this false keeps the bucket for a
   * restore target without shipping to it. */
  enabled: boolean
  bucket: string
  region: string
  /** Required for R2, Tigris and MinIO; AWS infers it from the region. */
  endpoint: string
  /** Key prefix inside the bucket. `db/<name>/…` hangs off it. */
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  virtualHostedStyle: boolean
  /** Ship an accumulated batch after this long. Design §9.4 says 1000 ms. */
  shipIntervalMs: number
  /** Take and ship a snapshot this often. 0 disables the timer. */
  snapshotIntervalMs: number
  /** Take and ship a snapshot after this many record bytes. 0 disables it. */
  snapshotEveryBytes: number
  /** Delete bucket objects older than this, never one a retained snapshot replays from. */
  retention: string
  /** Requests in flight at once, per node. */
  concurrency: number
  /** Queue ceiling before the shipper drops its buffer and reads from the log instead. */
  maxPendingBytes: number
  /** Attempts past the first for a retryable bucket failure. */
  retries: number
}

export interface AuthSection {
  /** Bearer token for the lifecycle routes. Generated and persisted when absent. */
  adminKey: string | null
  /** Ed25519 signing key as base64 PKCS#8. Generated and persisted when absent. */
  jwtKey: string | null
  /** Extra verify-only public keys, base64 raw (32 bytes), for rotation. */
  jwtPublicKeys: string[]
  /** Where generated secrets live. Defaults to `<data.dir>/keys.json`. */
  keysFile: string | null
  clockToleranceSec: number
  /** Default lifetime of a minted token when the request does not say, in ms. */
  defaultTokenTtlMs: number
  /**
   * Verified token signatures held in memory, so a client sending one token per request pays its
   * EdDSA verification once instead of 28 µs on every request (`docs/p1-pragmas.md`). Expiry and
   * revocation are re-checked per request regardless; `0` turns the cache off.
   */
  verifyCacheSize: number
}

/**
 * The generated data API of `docs/plan-surfaces.md`: a database's own tables as REST, under
 * `/v1/db/{db}/api`. On by default, and that is not a widening of anyone's authority — a principal
 * that can reach `/v1/db/{db}/api/users` can already run `SELECT * FROM users` through
 * `POST /v1/db/{db}/query`, and both end in the same `src/server/exec.ts` with the same authorizer
 * (`docs/h6-mount.md` decision 6).
 */
export interface ApiSection {
  enabled: boolean
  /** The segment after `/v1/db/{db}`. */
  prefix: string
  /** Rows a list returns when the request does not say. */
  defaultLimit: number
  /** The most a request may ask for; asking for more is a 400. */
  maxLimit: number
}

/**
 * The generated GraphQL surface, at `POST /v1/db/{db}/graphql`. `graphql` and `openapi-x-graphql`
 * are optional peers, so this section is ignored entirely when they do not resolve: the route is
 * absent rather than answering a 500 about a missing package (`docs/h6-mount.md` decision 4).
 */
export interface GraphqlSection {
  enabled: boolean
  /** GraphiQL on a browser's `GET`. */
  graphiql: boolean
  /** The segment after `/v1/db/{db}`. */
  path: string
  maxDepth: number
  maxComplexity: number
}

export interface ServerConfig {
  server: ServerSection
  data: DataSection
  sqlite: SqliteSection
  durability: DurabilitySection
  realtime: RealtimeSection
  limits: LimitsSection
  auth: AuthSection
  replication: ReplicationSection
  cluster: ClusterSection
  s3: S3Section
  api: ApiSection
  graphql: GraphqlSection
}

/** The same shape with every field optional, which is what a TOML file or a caller supplies. */
export type ServerConfigInput = {
  [K in keyof ServerConfig]?: Partial<ServerConfig[K]>
}

export const DEFAULT_CONFIG: ServerConfig = {
  server: {
    port: 4321,
    host: "0.0.0.0",
    node: "bunql",
    tenantFromHost: false,
    cors: true,
    workers: 1,
  },
  data: { dir: "./data", maxOpen: 1024, readers: 2, pageSize: 4096, quotaBytes: 0 },
  sqlite: {
    writerCacheBytes: 8_388_608,
    readerCacheBytes: 2_097_152,
    readerMmapBytes: 0,
    foreignKeys: false,
    trustedSchema: true,
    cellSizeCheck: false,
  },
  durability: {
    defaultAck: "local",
    checkpointWalBytes: 4_000_000,
    retention: "7d",
    sweepIntervalMs: 300_000,
    maxLogBytes: 0,
    segmentBytes: 16 * 1024 * 1024,
    compress: true,
    snapshotIntervalMs: 60 * 60 * 1000,
  },
  realtime: {
    ringBytes: 10_000_000,
    ringMaxAgeMs: 60_000,
    maxLiveQueries: 1000,
    maxRowsPerLive: 1000,
    idleRetainMs: 15_000,
  },
  limits: {
    queryTimeoutMs: 10_000,
    writeTimeoutMs: 30_000,
    txIdleTimeoutMs: 5_000,
    maxRows: 10_000,
    maxOpenTx: 1,
    txWaitMs: 5000,
    maxBodyBytes: 8 * 1024 * 1024,
    maxImportBytes: 1024 * 1024 * 1024,
    groupCommit: false,
    groupCommitMax: 64,
  },
  auth: {
    adminKey: null,
    jwtKey: null,
    jwtPublicKeys: [],
    keysFile: null,
    clockToleranceSec: 30,
    defaultTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    verifyCacheSize: 1024,
  },
  replication: {
    role: "primary",
    primary: "",
    secret: "",
    follow: ["*"],
    ackTimeoutMs: 2000,
    ackWithoutReplicas: "error",
    heartbeatMs: 5000,
    slowReplicaMs: 30_000,
    reconnectMs: 250,
    forwardWrites: true,
    forwardTimeoutMs: 10_000,
    maxForwards: 256,
  },
  cluster: {
    enabled: false,
    id: "",
    advertise: "",
    zone: "",
    peers: [],
    bootstrap: false,
    rf: 2,
    leaseTtlMs: 3000,
    leaseRenewMs: 1000,
    leaseGuardMs: 500,
    electionTimeoutMs: 1500,
    heartbeatMs: 300,
  },
  s3: {
    enabled: false,
    bucket: "",
    region: "",
    endpoint: "",
    prefix: "bunql/",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    virtualHostedStyle: false,
    shipIntervalMs: 1000,
    snapshotIntervalMs: 3_600_000,
    snapshotEveryBytes: 64 * 1024 * 1024,
    retention: "30d",
    concurrency: 4,
    maxPendingBytes: 64 * 1024 * 1024,
    retries: 4,
  },
  api: {
    enabled: true,
    prefix: "api",
    defaultLimit: 100,
    maxLimit: 1000,
  },
  graphql: {
    enabled: true,
    graphiql: true,
    path: "graphql",
    maxDepth: 12,
    maxComplexity: 10_000,
  },
}

/**
 * The short `BUNQL_*` names, kept because they are what earlier milestones documented. The
 * canonical name of a key is `BUNQL_<SECTION>_<KEY>`, generated below from the defaults, and it
 * wins when both are set.
 */
const ENV_ALIASES: Readonly<Record<string, string>> = {
  BUNQL_PORT: "server.port",
  BUNQL_HOST: "server.host",
  BUNQL_NODE: "server.node",
  BUNQL_TENANT_FROM_HOST: "server.tenantFromHost",
  BUNQL_CORS: "server.cors",
  BUNQL_DIR: "data.dir",
  BUNQL_MAX_OPEN: "data.maxOpen",
  BUNQL_READERS: "data.readers",
  BUNQL_PAGE_SIZE: "data.pageSize",
  BUNQL_QUOTA_BYTES: "data.quotaBytes",
  BUNQL_DEFAULT_ACK: "durability.defaultAck",
  BUNQL_CHECKPOINT_WAL_BYTES: "durability.checkpointWalBytes",
  BUNQL_RETENTION: "durability.retention",
  BUNQL_RING_BYTES: "realtime.ringBytes",
  BUNQL_RING_MAX_AGE_MS: "realtime.ringMaxAgeMs",
  BUNQL_MAX_LIVE_QUERIES: "realtime.maxLiveQueries",
  BUNQL_MAX_ROWS_PER_LIVE: "realtime.maxRowsPerLive",
  BUNQL_IDLE_RETAIN_MS: "realtime.idleRetainMs",
  BUNQL_QUERY_TIMEOUT_MS: "limits.queryTimeoutMs",
  BUNQL_WRITE_TIMEOUT_MS: "limits.writeTimeoutMs",
  BUNQL_TX_IDLE_TIMEOUT_MS: "limits.txIdleTimeoutMs",
  BUNQL_MAX_ROWS: "limits.maxRows",
  BUNQL_MAX_OPEN_TX: "limits.maxOpenTx",
  BUNQL_TX_WAIT_MS: "limits.txWaitMs",
  BUNQL_MAX_BODY_BYTES: "limits.maxBodyBytes",
  BUNQL_MAX_IMPORT_BYTES: "limits.maxImportBytes",
  BUNQL_ADMIN_KEY: "auth.adminKey",
  BUNQL_JWT_ED25519: "auth.jwtKey",
  BUNQL_KEYS_FILE: "auth.keysFile",
  BUNQL_CLOCK_TOLERANCE_SEC: "auth.clockToleranceSec",
  BUNQL_TOKEN_TTL_MS: "auth.defaultTokenTtlMs",
  // The three an operator types by hand often enough to want a short name.
  BUNQL_REPLICA_OF: "replication.primary",
  BUNQL_CLUSTER_PEERS: "cluster.peers",
  BUNQL_CLUSTER_SECRET: "replication.secret",
  BUNQL_FOLLOW: "replication.follow",
  // The bucket is typed by hand often enough, and `AWS_*` / `S3_*` are Bun's own fallbacks rather
  // than ours, so only the bucket itself gets a short name.
  BUNQL_S3_URL: "s3.bucket",
}

/** `data` + `dir` → `BUNQL_DATA_DIR`; `limits` + `queryTimeoutMs` → `BUNQL_LIMITS_QUERY_TIMEOUT_MS`. */
export function envNameFor(section: string, key: string): string {
  const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
  return `BUNQL_${section.toUpperCase()}_${snake}`
}

/** One override per key of the resolved config, named by its section and its key. */
function canonicalEnvKeys(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const section of Object.keys(DEFAULT_CONFIG) as (keyof ServerConfig)[]) {
    for (const key of Object.keys(DEFAULT_CONFIG[section])) {
      out[envNameFor(section, key)] = `${section}.${key}`
    }
  }
  return out
}

/** Every environment override this node understands, canonical names last so they win. */
export const ENV_KEYS: Readonly<Record<string, string>> = {
  ...ENV_ALIASES,
  ...canonicalEnvKeys(),
}

type Env = Record<string, string | undefined>

/** Expands `${NAME}` against the environment, which is how design §9.4 writes secrets in TOML. */
function expand(value: string, env: Env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "")
}

function coerce(target: unknown, raw: string): unknown {
  // A list-valued key (the verify-only public keys) is comma-separated in the environment.
  if (Array.isArray(target)) {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  }
  if (typeof target === "number") {
    const n = Number(raw.replaceAll("_", ""))
    if (!Number.isFinite(n)) throw BunQLError.badRequest(`${JSON.stringify(raw)} is not a number`)
    return n
  }
  if (typeof target === "boolean") return raw === "1" || raw.toLowerCase() === "true"
  return raw
}

function setPath(config: ServerConfig, dotted: string, raw: string): void {
  const [section, key] = dotted.split(".") as [keyof ServerConfig, string]
  const target = config[section] as unknown as Record<string, unknown>
  target[key] = coerce(target[key], raw)
}

function mergeSection<T extends object>(base: T, patch: Partial<T> | undefined, env: Env): T {
  if (!patch) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    // Every string from a file goes through `${…}` expansion, whatever the default's type is:
    // `adminKey` defaults to null and is exactly the key design §9.4 writes as `${BUNQL_ADMIN_KEY}`.
    ;(out as Record<string, unknown>)[key] = typeof value === "string" ? expand(value, env) : value
  }
  return out
}

export interface LoadConfigOptions {
  /** TOML file to read. Missing files are not an error unless `required`. */
  file?: string | null
  required?: boolean
  /** Applied after the file and before the environment. */
  overrides?: ServerConfigInput
  env?: Env
}

/**
 * Resolves the configuration: defaults, then the TOML file, then `overrides`, then `BUNQL_*`.
 * An empty string in the environment or after `${…}` expansion counts as "not set", so an unset
 * `${BUNQL_ADMIN_KEY}` in the file leaves the key to be generated rather than making it "".
 */
export function loadConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? (process.env as Env)
  let fromFile: ServerConfigInput = {}
  const file = options.file
  if (file) {
    if (fs.existsSync(file)) {
      fromFile = Bun.TOML.parse(fs.readFileSync(file, "utf8")) as ServerConfigInput
    } else if (options.required) {
      throw BunQLError.badRequest(`no config file at ${file}`)
    }
  }

  let config: ServerConfig = {
    server: { ...DEFAULT_CONFIG.server },
    data: { ...DEFAULT_CONFIG.data },
    sqlite: { ...DEFAULT_CONFIG.sqlite },
    durability: { ...DEFAULT_CONFIG.durability },
    realtime: { ...DEFAULT_CONFIG.realtime },
    limits: { ...DEFAULT_CONFIG.limits },
    auth: { ...DEFAULT_CONFIG.auth, jwtPublicKeys: [...DEFAULT_CONFIG.auth.jwtPublicKeys] },
    replication: {
      ...DEFAULT_CONFIG.replication,
      follow: [...DEFAULT_CONFIG.replication.follow],
    },
    cluster: { ...DEFAULT_CONFIG.cluster, peers: [...DEFAULT_CONFIG.cluster.peers] },
    s3: { ...DEFAULT_CONFIG.s3 },
    api: { ...DEFAULT_CONFIG.api },
    graphql: { ...DEFAULT_CONFIG.graphql },
  }

  for (const patch of [fromFile, options.overrides]) {
    if (!patch) continue
    config = {
      server: mergeSection(config.server, patch.server, env),
      data: mergeSection(config.data, patch.data, env),
      sqlite: mergeSection(config.sqlite, patch.sqlite, env),
      durability: mergeSection(config.durability, patch.durability, env),
      realtime: mergeSection(config.realtime, patch.realtime, env),
      limits: mergeSection(config.limits, patch.limits, env),
      auth: mergeSection(config.auth, patch.auth, env),
      replication: mergeSection(config.replication, patch.replication, env),
      cluster: mergeSection(config.cluster, patch.cluster, env),
      s3: mergeSection(config.s3, patch.s3, env),
      api: mergeSection(config.api, patch.api, env),
      graphql: mergeSection(config.graphql, patch.graphql, env),
    }
  }

  for (const [name, dotted] of Object.entries(ENV_KEYS)) {
    const raw = env[name]
    if (raw === undefined || raw === "") continue
    setPath(config, dotted, raw)
  }

  // An expansion that found nothing leaves "", which must not be mistaken for a configured secret.
  if (config.auth.adminKey === "") config.auth.adminKey = null
  if (config.auth.jwtKey === "") config.auth.jwtKey = null
  if (config.server.node === DEFAULT_CONFIG.server.node) {
    config.server.node = env.BUNQL_NODE || defaultNodeId()
  }
  config.data.dir = path.resolve(config.data.dir)
  if (config.auth.keysFile === null) config.auth.keysFile = path.join(config.data.dir, "keys.json")

  const ack = config.durability.defaultAck
  if (ack !== "local" && ack !== "fsync" && ack !== "replica" && ack !== "quorum") {
    throw BunQLError.badRequest(
      `[durability] defaultAck must be "local", "fsync", "replica" or "quorum", got ${JSON.stringify(ack)}`,
    )
  }
  const without = config.replication.ackWithoutReplicas
  if (without !== "error" && without !== "allow") {
    throw BunQLError.badRequest(
      `[replication] ackWithoutReplicas must be "error" or "allow", got ${JSON.stringify(without)}`,
    )
  }
  // Validate before deriving, or a typo in `role` would be silently corrected by `primary`.
  if (config.replication.role !== "primary" && config.replication.role !== "replica") {
    throw BunQLError.badRequest(
      `[replication] role must be "primary" or "replica", got ${JSON.stringify(config.replication.role)}`,
    )
  }
  // `--replica-of` is the whole decision: a node that is told where its primary is, is a replica.
  if (config.replication.primary) config.replication.role = "replica"
  if (config.replication.role === "replica" && !config.replication.primary) {
    throw BunQLError.badRequest(
      'a node with [replication] role = "replica" needs [replication] primary set to the ' +
        "primary's wss:// URL",
    )
  }
  if (config.replication.follow.length === 0) config.replication.follow = ["*"]

  // `[cluster] peers` is the whole decision, as `--replica-of` is: a node told who its peers are
  // is in a cluster. `enabled = false` in the file is still honoured, so a config can keep the
  // peer list while a node runs standalone.
  if (config.cluster.peers.length > 0 && clusterEnabledIn(fromFile, options.overrides, env) !== false) {
    config.cluster.enabled = true
  }
  if (!config.cluster.id) config.cluster.id = config.server.node
  if (config.cluster.enabled && !config.replication.secret) {
    throw BunQLError.badRequest(
      "[cluster] enabled needs [replication] secret: the raft socket proves the same cluster " +
        "secret the replication socket does",
    )
  }
  if (config.cluster.enabled && config.cluster.leaseGuardMs >= config.cluster.leaseTtlMs) {
    throw BunQLError.badRequest(
      `[cluster] leaseGuardMs (${config.cluster.leaseGuardMs}) must be below leaseTtlMs ` +
        `(${config.cluster.leaseTtlMs}): the guard is the part of the lease a holder does not use`,
    )
  }
  if (config.cluster.enabled && config.cluster.leaseRenewMs >= config.cluster.leaseTtlMs - config.cluster.leaseGuardMs) {
    throw BunQLError.badRequest(
      `[cluster] leaseRenewMs (${config.cluster.leaseRenewMs}) must leave room inside ` +
        `leaseTtlMs - leaseGuardMs (${config.cluster.leaseTtlMs - config.cluster.leaseGuardMs}), ` +
        "or a lease expires before its holder has asked to keep it",
    )
  }

  assertWorkers(config)

  // `s3://bucket/prefix` in one variable, because that is how an operator writes a bucket.
  if (config.s3.bucket.startsWith("s3://")) {
    const rest = config.s3.bucket.slice("s3://".length)
    const slash = rest.indexOf("/")
    config.s3.bucket = slash < 0 ? rest : rest.slice(0, slash)
    if (slash >= 0 && slash + 1 < rest.length) config.s3.prefix = rest.slice(slash + 1)
  }
  // A bucket is the whole decision, the same way `--replica-of` is: a node told where its bucket
  // is, ships to it. `enabled = false` in the file is still honoured, so a configured bucket can
  // be kept as a restore target without shipping.
  if (config.s3.bucket && patchSetsEnabled(fromFile, options.overrides, env) === false) {
    config.s3.enabled = false
  } else if (config.s3.bucket) {
    config.s3.enabled = true
  } else {
    config.s3.enabled = false
  }
  if (config.s3.concurrency < 1) config.s3.concurrency = 1
  parseRetentionOrThrow(config.s3.retention, "s3")
  // The trash sweep is the one thing that reads it, and a typo there would quietly keep every
  // deleted database for ever — the failure this key exists to prevent.
  parseRetentionOrThrow(config.durability.retention, "durability")

  // A prefix is one path segment, and it is concatenated into a route pattern rather than escaped,
  // so a `/` in it would silently mount the data API somewhere nobody asked for. The same for the
  // GraphQL path, which has to stay distinguishable from a table name under the API prefix.
  assertSegment(config.api.prefix, "[api] prefix")
  assertSegment(config.graphql.path, "[graphql] path")
  if (config.api.defaultLimit < 1) config.api.defaultLimit = 1
  if (config.api.maxLimit < config.api.defaultLimit) config.api.maxLimit = config.api.defaultLimit
  return config
}

/**
 * What `[server] workers` may be combined with. More than one worker shards databases across
 * threads, and a database's replication stream is served from the `Tenant` itself —
 * `tenant.onCommit`, `tenant.log`, `tenant.snapshot()`, `registry.pin` — which lives on the thread
 * that owns it, not on the router thread that holds the socket. Rather than serve a replica half
 * a log, a node configured for both refuses to start and says which one to drop.
 * `docs/c4-workers.md` §5; C4b is the milestone that lifts this.
 */
function assertWorkers(config: ServerConfig): void {
  const n = config.server.workers
  if (!Number.isFinite(n) || n < 0) {
    throw BunQLError.badRequest(
      `[server] workers must be 0 (one per core) or a positive count, got ${JSON.stringify(n)}`,
    )
  }
  if (n === 1) return
  const why =
    config.cluster.enabled
      ? "[cluster] enabled"
      : config.replication.primary
        ? "[replication] primary (this node follows an upstream)"
        : config.replication.secret
          ? "[replication] secret (this node serves /v1/replication)"
          : null
  if (!why) return
  throw new BunQLError(
    "WORKERS_UNSUPPORTED",
    `[server] workers = ${n} cannot be combined with ${why}: a database's replication stream is ` +
      "served from the thread that owns its writer, and with more than one worker that is not the " +
      "thread holding the socket. Run this node with workers = 1, or without replication. " +
      "See docs/c4-workers.md §5.",
    400,
  )
}

/** One path segment: no slash, no `:` (which is Bun's parameter marker), and not empty. */
function assertSegment(value: string, what: string): void {
  if (value.length > 0 && !/[/:*?#]/.test(value)) return
  throw BunQLError.badRequest(
    `${what} must be a single path segment with no "/", ":", "*", "?" or "#", got ${JSON.stringify(value)}`,
  )
}

/** True/false when something actually set `[cluster] enabled`, null when nothing did. */
function clusterEnabledIn(
  fromFile: ServerConfigInput,
  overrides: ServerConfigInput | undefined,
  env: Env,
): boolean | null {
  const raw = env.BUNQL_CLUSTER_ENABLED
  if (raw !== undefined && raw !== "") return raw === "1" || raw.toLowerCase() === "true"
  if (overrides?.cluster?.enabled !== undefined) return overrides.cluster.enabled
  if (fromFile.cluster?.enabled !== undefined) return fromFile.cluster.enabled
  return null
}

/** True/false when something actually set `[s3] enabled`, null when nothing did. */
function patchSetsEnabled(
  fromFile: ServerConfigInput,
  overrides: ServerConfigInput | undefined,
  env: Env,
): boolean | null {
  const raw = env.BUNQL_S3_ENABLED
  if (raw !== undefined && raw !== "") return raw === "1" || raw.toLowerCase() === "true"
  if (overrides?.s3?.enabled !== undefined) return overrides.s3.enabled
  if (fromFile.s3?.enabled !== undefined) return fromFile.s3.enabled
  return null
}

/** A `retention` has to be a duration this node understands, and a typo must not be silent. */
function parseRetentionOrThrow(text: string, section: "s3" | "durability"): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  if (!/^\d+(?:\.\d+)?\s*(ms|s|m|h|d|w)?$/i.test(trimmed)) {
    throw BunQLError.badRequest(
      `[${section}] retention must look like 30d, 12h or 3600, got ${JSON.stringify(text)}`,
    )
  }
}

/**
 * A node id that is stable for a machine without naming it. `BunQL-Node` travels on every
 * response and into whatever a client logs, so the default is a hash of the hostname rather than
 * the hostname itself; an operator who wants a readable name sets `[server] node` or `BUNQL_NODE`.
 */
function defaultNodeId(): string {
  try {
    const host = Bun.spawnSync(["hostname"]).stdout.toString().trim()
    if (!host) return "bunql"
    return `bunql-${Bun.hash.xxHash3(host).toString(16).padStart(16, "0").slice(0, 8)}`
  } catch {
    return "bunql"
  }
}

// ── Key material ───────────────────────────────────────────────────────────────────────────────

interface KeyFile {
  version: 1
  adminKey?: string
  /** The signing key, private half included. */
  signing?: Ed25519Jwk
  /** Public halves of retired keys, still trusted for verification. */
  verify?: Ed25519Jwk[]
}

export interface ResolvedAuth {
  keys: KeyRing
  adminKey: string | null
  /** True when this run had to generate the admin key, which is the only time it is printed. */
  adminKeyGenerated: boolean
  jwtKeyGenerated: boolean
  /** Where generated material was written, or null when nothing was written. */
  keysFile: string | null
}

function readKeyFile(file: string): KeyFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as KeyFile
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function writeKeyFile(file: string, contents: KeyFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // A filesystem without POSIX modes is not a reason to refuse to start.
  }
}

/** 32 bytes of randomness as base64url: what an admin key is when nobody configured one. */
export function generateAdminKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

/**
 * Builds the key ring for a node: the configured signing key if there is one, otherwise the one
 * in `keys.json`, otherwise a freshly generated pair that is written there. Extra public keys
 * from the config join the ring as verify-only, which is how a rotation keeps old tokens working.
 */
export async function resolveAuth(config: ServerConfig): Promise<ResolvedAuth> {
  const file = config.auth.keysFile
  const stored = file ? readKeyFile(file) : null
  let adminKey = config.auth.adminKey
  let adminKeyGenerated = false
  let jwtKeyGenerated = false
  let signing: AuthKeys
  let storedSigning: Ed25519Jwk | undefined

  if (config.auth.jwtKey) {
    signing = await AuthKeys.fromPkcs8(config.auth.jwtKey)
  } else if (stored?.signing) {
    signing = await AuthKeys.fromJwk(stored.signing)
  } else {
    signing = await AuthKeys.generate()
    jwtKeyGenerated = true
    storedSigning = await signing.exportJwk("private")
  }

  if (adminKey === null) {
    if (stored?.adminKey) {
      adminKey = stored.adminKey
    } else {
      adminKey = generateAdminKey()
      adminKeyGenerated = true
    }
  }

  const ring = new KeyRing([signing])
  for (const jwk of stored?.verify ?? []) {
    try {
      ring.add(await AuthKeys.fromJwk(jwk))
    } catch {
      // A key the ring cannot load is one nobody can present a token for; it is not fatal.
    }
  }
  for (const raw of config.auth.jwtPublicKeys) {
    if (!raw) continue
    ring.add(await AuthKeys.fromRawPublic(raw))
  }
  ring.setSigning(signing.kid)

  if (file && (adminKeyGenerated || jwtKeyGenerated)) {
    const next: KeyFile = { version: 1 }
    next.adminKey = adminKey
    next.signing = storedSigning ?? stored?.signing ?? (await signing.exportJwk("private"))
    if (stored?.verify?.length) next.verify = stored.verify
    writeKeyFile(file, next)
  }

  return {
    keys: ring,
    adminKey,
    adminKeyGenerated,
    jwtKeyGenerated,
    keysFile: adminKeyGenerated || jwtKeyGenerated ? file : null,
  }
}
