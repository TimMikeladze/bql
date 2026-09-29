import { statfsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type {
  AckResult,
  AuditEntry,
  BlockedKey,
  CancelResult,
  ClusterState,
  CompatChange,
  CompatMode,
  Consumer,
  DeliverFrom,
  Delivery,
  DeliveryStatus,
  EffectClaim,
  EffectRecord,
  Envelope,
  ExtendResult,
  Headers,
  Json,
  Message,
  MessageMeta,
  PublishRequest,
  PublishResult,
  Quota,
  RegisterConsumer,
  Response,
  Schedule,
  ScheduleRequest,
  Stats,
  SchemaBinding,
  SchemaMode,
  SchemaVersion,
  SubscribeRequest,
  Subscription,
  SubscriptionStats,
  Violation,
} from "../shared/protocol";
import { DEFAULT_WORKSPACE, MAX_PRIORITY, MIN_PRIORITY } from "../shared/protocol";
import { type BlobStore, BlobMissingError } from "./blobs";
import { assertTimeZone, CronError, nextFire, parseCron } from "./cron";
import { fault } from "./faults";
import { type MetricsSink, noopMetrics } from "./metrics";
import {
  childOf,
  formatTraceparent,
  noopExporter,
  parseTraceparent,
  type SpanExporter,
} from "./trace";
import {
  breaking,
  compare,
  compile,
  SchemaError,
  type Validator,
} from "./schema";
import type { TraceContext } from "./trace";
import { assertPattern, assertSubject, matches, narrowingGlob } from "./subjects";

export class BusError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

const uuid = () => crypto.randomUUID();
const sha256Hex = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
const parse = <T>(text: string | null, fallback: T): T =>
  text === null ? fallback : (JSON.parse(text) as T);

export interface Migration {
  version: number;
  statements: string[];
}

interface SchemaRow {
  workspace: string;
  name: string;
  version: number;
  source: string;
  hash: string;
  compat: string;
  created_at: number;
}

function toSchemaVersion(row: SchemaRow): SchemaVersion {
  return {
    workspace: row.workspace,
    name: row.name,
    version: row.version,
    source: JSON.parse(row.source) as Json,
    hash: row.hash,
    compat: row.compat as CompatMode,
    createdAt: row.created_at,
  };
}

/** A publish with its I/O already done, waiting for a transaction to put it in. */
interface PreparedMessage {
  request: PublishRequest;
  inline: string | null;
  blob: string | null;
  sha256: string | null;
  bytes: number;
  correlation: string | null;
  headers: Headers;
  /** This publish's own span, in the trace the caller's `traceparent` named. */
  trace: TraceContext | null;
  parentSpanId: string | undefined;
}

/**
 * The schema, as an ordered list of migrations.
 *
 * Append only. A migration that has shipped is history: editing one changes
 * what a database at that version means, which is the whole failure mode the
 * version table exists to prevent.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        subject TEXT NOT NULL,
        key TEXT,
        headers TEXT NOT NULL,
        body TEXT,
        body_blob TEXT,
        published_at INTEGER NOT NULL,
        expires_at INTEGER,
        dedupe_key TEXT)`,
      "CREATE UNIQUE INDEX IF NOT EXISTS messages_dedupe ON messages(workspace, dedupe_key) WHERE dedupe_key IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS messages_log ON messages(workspace, seq)",
      `CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        name TEXT NOT NULL,
        pattern TEXT NOT NULL,
        cursor_seq INTEGER NOT NULL DEFAULT 0,
        ack_wait_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        ordered INTEGER NOT NULL DEFAULT 0,
        dlq_subject TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL)`,
      "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_name ON subscriptions(workspace, name)",
      `CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
        status TEXT NOT NULL,
        consumer_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        available_at INTEGER NOT NULL DEFAULT 0,
        key TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(subscription_id, message_seq))`,
      "CREATE INDEX IF NOT EXISTS deliveries_ready ON deliveries(subscription_id, status, available_at, message_seq)",
      "CREATE INDEX IF NOT EXISTS deliveries_lease ON deliveries(status, lease_until)",
      "CREATE INDEX IF NOT EXISTS deliveries_key ON deliveries(subscription_id, status, key)",
      `CREATE TABLE IF NOT EXISTS responses (
        workspace TEXT NOT NULL,
        correlation TEXT NOT NULL,
        message_seq INTEGER NOT NULL,
        headers TEXT NOT NULL,
        body TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace, correlation))`,
      `CREATE TABLE IF NOT EXISTS blobs (
        handle TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS consumers (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        data TEXT NOT NULL)`,
    ],
  },
  {
    version: 2,
    statements: [
      // Cancellation. `cancelled_at` on the message is what stops a
      // subscription whose cursor has not reached it yet from materializing a
      // delivery *after* the cancel; `publisher` is who may cancel it.
      "ALTER TABLE messages ADD COLUMN cancelled_at INTEGER",
      "ALTER TABLE messages ADD COLUMN publisher TEXT",
    ],
  },
  {
    version: 3,
    statements: [
      // Integrity for overflow bodies. `body_bytes` is the encoded length of
      // every body, inline or not — it is also what a per-workspace byte quota
      // has to count. `body_sha256` is only set for a body that left the
      // database: inside a SQLite row the checksum would be guarding against
      // SQLite, which has its own.
      "ALTER TABLE messages ADD COLUMN body_sha256 TEXT",
      "ALTER TABLE messages ADD COLUMN body_bytes INTEGER",
    ],
  },
  {
    version: 4,
    statements: [
      // The effect ledger. A key is claimed exactly once; the result recorded
      // against it is replayed to every later attempt instead of the effect
      // being repeated. `fence` records which attempt holds the claim, which
      // is what distinguishes "you already did this" from "an older attempt
      // claimed it and we never heard how it went".
      `CREATE TABLE IF NOT EXISTS effects (
        workspace TEXT NOT NULL,
        key TEXT NOT NULL,
        fence TEXT,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace, key))`,
      // What an ack produced, so a retried ack replays it rather than
      // publishing a second time. NULL for the overwhelming majority of acks,
      // which produce nothing.
      "ALTER TABLE deliveries ADD COLUMN ack_result TEXT",
    ],
  },
  {
    version: 5,
    statements: [
      // Retry backoff, per subscription. Full jitter rather than equal jitter:
      // the failure this is for is a fleet retrying in lockstep, and half a
      // fixed delay is still a lockstep.
      "ALTER TABLE subscriptions ADD COLUMN backoff_base_ms INTEGER NOT NULL DEFAULT 1000",
      "ALTER TABLE subscriptions ADD COLUMN backoff_max_ms INTEGER NOT NULL DEFAULT 60000",
      "ALTER TABLE subscriptions ADD COLUMN backoff_factor REAL NOT NULL DEFAULT 2.0",
      "ALTER TABLE subscriptions ADD COLUMN backoff_jitter TEXT NOT NULL DEFAULT 'full'",
      // What an ordered subscription does when a key's message dies.
      "ALTER TABLE subscriptions ADD COLUMN on_failure TEXT NOT NULL DEFAULT 'block'",
      // 0 means unbounded.
      "ALTER TABLE subscriptions ADD COLUMN max_in_flight INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE subscriptions ADD COLUMN quarantine_dead_rate REAL NOT NULL DEFAULT 0",
      "ALTER TABLE subscriptions ADD COLUMN quarantine_window_ms INTEGER NOT NULL DEFAULT 60000",
      "ALTER TABLE subscriptions ADD COLUMN quarantine_min_dead INTEGER NOT NULL DEFAULT 20",
      "ALTER TABLE subscriptions ADD COLUMN quarantined_at INTEGER",
      // Priority classes, and delayed delivery. Both live on the message and
      // are copied onto the delivery, because the candidate scan reads
      // deliveries and must not join to order or to filter.
      "ALTER TABLE messages ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE deliveries ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX IF NOT EXISTS deliveries_ready_priority ON deliveries(subscription_id, status, available_at, priority DESC, message_seq)",
      "CREATE INDEX IF NOT EXISTS deliveries_settled ON deliveries(subscription_id, status, updated_at)",
      // A key that may not move until an operator says so. `ordered: true` was
      // bought to stop a key's messages overtaking one another; letting the
      // next one through because its predecessor died is exactly the
      // reordering it was bought to prevent.
      `CREATE TABLE IF NOT EXISTS blocked_keys (
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        message_seq INTEGER NOT NULL,
        delivery_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (subscription_id, key))`,
    ],
  },
  {
    version: 6,
    statements: [
      // The schema registry. Versions are per name and monotonic; `hash` keys
      // the compiled-validator cache, so two subjects bound to the same schema
      // compile it once.
      `CREATE TABLE IF NOT EXISTS schemas (
        workspace TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        source TEXT NOT NULL,
        hash TEXT NOT NULL,
        compat TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace, name, version))`,
      // Bindings are to *patterns*, not concrete subjects — the same matcher
      // subscriptions use — so `orders.>` covers the family rather than
      // needing a row per subject nobody has published yet.
      `CREATE TABLE IF NOT EXISTS schema_bindings (
        workspace TEXT NOT NULL,
        subject_pattern TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace, subject_pattern))`,
    ],
  },
  {
    version: 7,
    statements: [
      // Operator actions without a trail are not operable, they are just
      // powerful. Append-only: there is no update or delete path anywhere.
      `CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        actor TEXT NOT NULL,
        scope TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        at INTEGER NOT NULL)`,
      "CREATE INDEX IF NOT EXISTS audit_recent ON audit(workspace, id DESC)",
      // Revocation for tokens that are otherwise verified statelessly. The
      // probe is a local index lookup, not a network round trip, so the
      // property that made stateless tokens worth having survives.
      `CREATE TABLE IF NOT EXISTS revocations (
        jti TEXT PRIMARY KEY,
        not_after INTEGER NOT NULL,
        revoked_at INTEGER NOT NULL)`,
      // Per-workspace ceilings. One tenant must not be able to fill the disk
      // every other tenant's durability depends on. 0 means unlimited.
      `CREATE TABLE IF NOT EXISTS quotas (
        workspace TEXT PRIMARY KEY,
        max_messages INTEGER NOT NULL DEFAULT 0,
        max_bytes INTEGER NOT NULL DEFAULT 0,
        max_subscriptions INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL)`,
    ],
  },
  {
    version: 8,
    statements: [
      // One row, by construction. Replication state is a property of the
      // database, not of a config file that can disagree with it — a follower
      // that forgets it is a follower is the failure this prevents.
      `CREATE TABLE IF NOT EXISTS cluster (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL,
        role TEXT NOT NULL,
        upstream TEXT,
        applied_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL)`,
      "INSERT OR IGNORE INTO cluster (id, epoch, role, upstream, applied_seq, updated_at) VALUES (1, 0, 'leader', NULL, 0, 0)",
    ],
  },
  {
    version: 9,
    statements: [
      // Cron on the bus. A fire is an ordinary publish whose dedupe key is the
      // schedule and the scheduled instant, so this table only has to say what
      // is due next — the log is what says what already happened.
      `CREATE TABLE IF NOT EXISTS schedules (
        workspace TEXT NOT NULL,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        tz TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        headers TEXT NOT NULL,
        next_at INTEGER,
        last_at INTEGER,
        catch_up TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        -- A failing fire backs off here instead of being retried every sweep.
        retry_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace, name))`,
      "CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_at) WHERE paused = 0",
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface StoreOptions {
  now?: () => number;
  /** Bodies larger than this are written to the blob store. */
  inlineMaxBytes?: number;
  blobs?: BlobStore;
  /** Messages and settled deliveries older than this are pruned. 0 disables. */
  retentionMs?: number;
  /** How many log rows one claim may examine while materializing deliveries. */
  scanBatch?: number;
  /**
   * Where counters go. The store rather than the server, because the
   * transitions that matter most — a lease reclaimed, a delivery
   * dead-lettered inside the sweep — never pass through an HTTP handler.
   */
  metrics?: MetricsSink;
  /**
   * `synchronous`. `FULL` is the default and is load-bearing: `NORMAL` under
   * WAL can lose the tail of the log on power loss or a kernel panic. It is
   * settable only so the soak can run `--sync normal` and *fail*, which is
   * what makes the default a proven choice rather than a cargo-culted one.
   */
  synchronous?: "FULL" | "NORMAL";
  /**
   * Below this much free space on the database's filesystem, publishes are
   * refused with 507 and `/ready` goes 503 — while claims, acks and nacks keep
   * working so consumers can drain. `SQLITE_FULL` is otherwise undefined
   * behaviour: it surfaces as a 500 and the bus goes on accepting writes it
   * cannot keep.
   */
  minFreeBytes?: number;
  /** WAL size above which the sweep truncates it. 0 disables checkpointing. */
  walCheckpointBytes?: number;
  /**
   * Where spans go. Without one, trace context is still propagated in headers
   * — the part a consumer needs — and nothing is exported.
   */
  tracer?: SpanExporter;
}

interface MessageRow {
  seq: number;
  id: string;
  workspace: string;
  subject: string;
  key: string | null;
  headers: string;
  body: string | null;
  body_blob: string | null;
  published_at: number;
  expires_at: number | null;
  dedupe_key: string | null;
  cancelled_at: number | null;
  publisher: string | null;
  body_sha256: string | null;
  body_bytes: number | null;
  priority: number;
  available_at: number;
}

interface SubscriptionRow {
  id: string;
  workspace: string;
  name: string;
  pattern: string;
  cursor_seq: number;
  ack_wait_ms: number;
  max_attempts: number;
  ordered: number;
  dlq_subject: string;
  paused: number;
  created_at: number;
  updated_at: number;
  backoff_base_ms: number;
  backoff_max_ms: number;
  backoff_factor: number;
  backoff_jitter: string;
  on_failure: string;
  max_in_flight: number;
  quarantine_dead_rate: number;
  quarantine_window_ms: number;
  quarantine_min_dead: number;
  quarantined_at: number | null;
}

interface ScheduleRow {
  workspace: string;
  name: string;
  cron: string;
  tz: string;
  subject: string;
  body: string;
  headers: string;
  next_at: number | null;
  last_at: number | null;
  catch_up: string;
  paused: number;
  last_error: string | null;
  retry_at: number | null;
  failures: number;
  created_at: number;
  updated_at: number;
}

const SCHEDULE_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
/**
 * How late a fire may be and still count as on time under `catchUp: "none"`.
 * The sweep runs every second, so anything later than this was missed rather
 * than merely delayed by a busy tick.
 */
const ON_TIME_MS = 60_000;
/** Retry pacing for a fire that failed to publish: 2 s doubling to 5 min. */
const retryDelayMs = (failures: number) =>
  Math.min(300_000, 1000 * 2 ** Math.min(failures, 20));

function toSchedule(row: ScheduleRow): Schedule {
  return {
    workspace: row.workspace,
    name: row.name,
    cron: row.cron,
    tz: row.tz,
    subject: row.subject,
    body: JSON.parse(row.body) as Json,
    headers: parse<Headers>(row.headers, {}),
    catchUp: row.catch_up === "none" ? "none" : "latest",
    paused: row.paused === 1,
    nextAt: row.next_at,
    lastAt: row.last_at,
    lastError: row.last_error,
    retryAt: row.retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DeliveryRow {
  id: string;
  subscription_id: string;
  message_seq: number;
  status: DeliveryStatus;
  consumer_id: string | null;
  generation: number;
  attempt: number;
  lease_until: number | null;
  available_at: number;
  key: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  ack_result: string | null;
  priority: number;
}

/**
 * The bus.
 *
 * One process owns one SQLite file in WAL mode; consumers never open it, they
 * hold leases over HTTP. Every claim, ack and nack is a conditional UPDATE that
 * only transitions *out of* the state it expects, so two consumers racing for
 * one delivery is safe rather than merely unlikely.
 *
 * Fan-out happens when a consumer pulls, not when a producer publishes: a
 * subscription holds a cursor into the log and materializes deliveries forward
 * from it. Publishing is therefore O(1) in the number of subscriptions, a
 * subscription created today can read last week's messages, and — the part that
 * matters most — the cursor advances past messages that do not match, so a run
 * of non-matching subjects can never hide a matching one behind it.
 */
export class BusStore {
  private db: Database;
  private now: () => number;
  private inlineMaxBytes: number;
  private blobs: BlobStore | undefined;
  private retentionMs: number;
  private scanBatch: number;
  private metrics: MetricsSink;
  private minFreeBytes: number;
  private walCheckpointBytes: number;
  /** Where the database file lives, for WAL size and free-space probes. */
  private readonly path: string;
  /** Free space, cached: a publish must not cost a `statfs` per call. */
  private freeSpace: { bytes: number; at: number } | null = null;
  /** Compiled validators, keyed by schema hash. */
  private validators = new Map<string, Validator>();
  /** Bumped on every binding write, which is what invalidates the cache. */
  private bindingGeneration = 0;
  private bindingCache: {
    generation: number;
    byWorkspace: Map<string, SchemaBinding[]>;
  } | null = null;
  /** Live revocations, rebuilt on write and on sweep. */
  private revoked: Set<string> | null = null;
  private quotaCache = new Map<string, Quota>();
  private tracer: SpanExporter;
  /** Set on a follower, and on a leader whose epoch has been fenced out. */
  private readOnly = false;
  private readOnlyReason = "read-only";
  /** The schedule pass in flight, so overlapping sweeps share one. */
  private firing: Promise<number> | null = null;

  constructor(path: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.inlineMaxBytes = options.inlineMaxBytes ?? 64 * 1024;
    this.blobs = options.blobs;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.scanBatch = options.scanBatch ?? 500;
    this.metrics = options.metrics ?? noopMetrics();
    this.minFreeBytes = options.minFreeBytes ?? 64 * 1024 * 1024;
    this.tracer = options.tracer ?? noopExporter();
    this.walCheckpointBytes = options.walCheckpointBytes ?? 8 * 1024 * 1024;
    this.path = path;
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`PRAGMA synchronous=${options.synchronous ?? "FULL"}`);
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run("PRAGMA foreign_keys=ON");
    // A ceiling on the WAL, in pages. Without one the only checkpoint is
    // SQLite's own 1000-page default — which a long-lived reader blocks
    // indefinitely, and the `-wal` file then grows without bound. The sweep
    // truncates it as well; this is the cheap automatic half.
    this.db.run("PRAGMA wal_autocheckpoint=1000");
    this.migrate();
    // A follower that forgets it is a follower after a restart would start
    // accepting writes that its upstream will overwrite.
    if (this.hasTable("cluster") && this.cluster().role === "follower")
      this.setReadOnly(true, "this replica is a follower");
  }

  /**
   * Bring the database up to `SCHEMA_VERSION`, or refuse to open it.
   *
   * The previous version of this was `CREATE TABLE IF NOT EXISTS` with no
   * version marker at all, which meant the first schema change to a deployed
   * bus would have been a silent corruption or a crash. Now every change is a
   * numbered migration, and a database written by a *newer* build is refused
   * rather than guessed at — a binary rolled back onto a schema it does not
   * know cannot say what the extra columns mean.
   */
  private migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL)`);

    const applied = (
      this.db.query("SELECT MAX(version) AS version FROM schema_version").get() as {
        version: number | null;
      }
    ).version;

    // A database from before this change has the version-1 tables and no
    // marker. Adopting it is a one-row write, not a rewrite.
    let current = applied ?? 0;
    if (applied === null && this.hasTable("messages")) {
      this.db.run(
        "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, ?)",
        [this.now()],
      );
      current = 1;
    }

    if (current > SCHEMA_VERSION) {
      // Close before throwing: the constructor has already opened the file, and
      // a caller that catches this — a CLI probing a directory of databases,
      // say — would otherwise leak a handle per attempt.
      this.db.close();
      throw new BusError(
        `this database is at schema version ${current}, and this build only knows ${SCHEMA_VERSION} — upgrade bql-bus rather than downgrading the data`,
        500,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      // IMMEDIATE, and the version re-read inside it: two processes opening
      // a new file at once (a follower creating its database while a tool
      // opens it) otherwise both apply a migration and one dies on the
      // version row's primary key.
      this.db.transaction(() => {
        const applied = (
          this.db.query("SELECT MAX(version) AS version FROM schema_version").get() as {
            version: number | null;
          }
        ).version;
        if ((applied ?? 0) >= migration.version) return;
        for (const statement of migration.statements) this.db.run(statement);
        this.db.run(
          "INSERT INTO schema_version (version, applied_at) VALUES (?,?)",
          [migration.version, this.now()],
        );
      }).immediate();
    }
  }

  private hasTable(name: string): boolean {
    return (
      this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name) !== null
    );
  }

  /** The schema version this database is actually at. */
  schemaVersion(): number {
    return (
      (
        this.db
          .query("SELECT MAX(version) AS version FROM schema_version")
          .get() as { version: number | null }
      ).version ?? 0
    );
  }

  /**
   * The underlying database.
   *
   * Exposed for embedded mode, where the whole point is that a handler's own
   * tables live in this file and commit in this transaction. Reach for it to
   * create and write *your* schema; reaching for the bus's own tables here is
   * writing around every invariant above.
   */
  raw(): Database {
    return this.db;
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------- messages

  /** Encoded body, and the two facts a row has to carry about it. */
  private async writeBody(body: Json): Promise<{
    inline: string | null;
    blob: string | null;
    sha256: string | null;
    bytes: number;
  }> {
    const text = JSON.stringify(body ?? null);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= this.inlineMaxBytes)
      return { inline: text, blob: null, sha256: null, bytes };
    if (!this.blobs)
      throw new BusError(
        `body is ${bytes} bytes and no blob store is configured`,
        413,
      );
    const sha256 = sha256Hex(text);
    // The blob is written — and fsynced — before the row that names it
    // commits, so the only crash outcome is an orphaned file.
    const handle = await this.blobs.put(uuid(), text);
    this.db.run(
      "INSERT INTO blobs (handle, created_at) VALUES (?,?) ON CONFLICT(handle) DO NOTHING",
      [handle, this.now()],
    );
    return { inline: null, blob: handle, sha256, bytes };
  }

  /**
   * Read a body back, and prove it is the one that was written.
   *
   * A truncated blob is the failure this guards: a short read parses as valid
   * JSON often enough to be dangerous, and handing a handler half a message is
   * worse than handing it an error. A mismatch names the handle so the operator
   * can go and look at the file.
   */
  private async readBody(row: MessageRow): Promise<Json> {
    if (row.body !== null) return JSON.parse(row.body) as Json;
    if (row.body_blob === null) return null;
    if (!this.blobs)
      throw new BusError("message body is in a blob store that is not configured");
    const text = await this.blobs.get(row.body_blob);
    if (row.body_bytes !== null && Buffer.byteLength(text, "utf8") !== row.body_bytes)
      throw new BusError(
        `blob '${row.body_blob}' is ${Buffer.byteLength(text, "utf8")} bytes, the message says ${row.body_bytes}`,
        500,
      );
    if (row.body_sha256 !== null && sha256Hex(text) !== row.body_sha256)
      throw new BusError(
        `blob '${row.body_blob}' does not match the checksum recorded with message ${row.seq}`,
        500,
      );
    return JSON.parse(text) as Json;
  }

  private async hydrate(row: MessageRow): Promise<Message> {
    return {
      seq: row.seq,
      id: row.id,
      workspace: row.workspace,
      subject: row.subject,
      key: row.key,
      headers: parse<Headers>(row.headers, {}),
      body: await this.readBody(row),
      publishedAt: row.published_at,
      expiresAt: row.expires_at,
      dedupeKey: row.dedupe_key,
      cancelledAt: row.cancelled_at,
      publisher: row.publisher,
      priority: row.priority,
      availableAt: row.available_at,
    };
  }

  /**
   * Publish.
   *
   * `publisher` is the token subject the bus saw, not something the caller put
   * in the payload: it is what `cancel` authorizes against, so a field a
   * publisher could choose for itself would authorize nothing.
   */
  async publish(
    workspace: string,
    request: PublishRequest,
    publisher: string | null = null,
  ): Promise<PublishResult> {
    this.assertWritable();
    const started = this.now();
    const prepared = await this.prepare(workspace, request);
    const result = this.db.transaction(() =>
      this.insert(workspace, prepared, publisher),
    )();
    const ended = this.now();
    this.metrics.histogram("bql-bus.publish.duration", ended - started, {
      workspace,
    });
    this.span({
      context: prepared.trace,
      parent: prepared.parentSpanId,
      name: `publish ${request.subject}`,
      kind: "producer",
      startMs: started,
      endMs: ended,
      attributes: {
        "messaging.system": "bql-bus",
        "messaging.destination.name": request.subject,
        "messaging.message.id": result.id,
        "bql-bus.workspace": workspace,
        "bql-bus.seq": result.seq,
      },
    });
    return result;
  }

  /**
   * Publish several messages in one transaction: all of them or none.
   *
   * What a relay wants — the db outbox publishes a batch of row changes and
   * advances its cursor only once the whole batch is in, so one request and one
   * commit per batch is the difference between keeping up and not. Dedupe
   * applies per message, including between two messages of the same batch.
   */
  async publishBatch(
    workspace: string,
    requests: PublishRequest[],
    publisher: string | null = null,
  ): Promise<PublishResult[]> {
    this.assertWritable();
    const started = this.now();
    const prepared: PreparedMessage[] = [];
    for (const request of requests)
      prepared.push(await this.prepare(workspace, request));
    const results = this.db.transaction(() =>
      prepared.map((one) => this.insert(workspace, one, publisher)),
    )();
    this.metrics.histogram(
      "bql-bus.publish.duration",
      this.now() - started,
      { workspace },
    );
    return results;
  }

  /** Record one span, if an exporter was configured. */
  private span(entry: {
    context: TraceContext | null;
    parent?: string | undefined;
    name: string;
    kind: "producer" | "consumer" | "internal";
    startMs: number;
    endMs: number;
    attributes: Record<string, string | number | boolean>;
  }): void {
    if (!entry.context) return;
    this.tracer.record({
      traceId: entry.context.traceId,
      spanId: entry.context.spanId,
      ...(entry.parent ? { parentSpanId: entry.parent } : {}),
      name: entry.name,
      kind: entry.kind,
      startMs: entry.startMs,
      endMs: entry.endMs,
      attributes: entry.attributes,
    });
  }

  /**
   * Everything about a publish that has to happen *before* the transaction.
   *
   * Writing a blob is I/O and a SQLite transaction may not await anything, so
   * the split is not a style choice: it is what lets an ack and the publishes
   * it produced commit together (Tier 2). The blob lands first, so the worst
   * case remains an orphaned file.
   */
  private async prepare(
    workspace: string,
    request: PublishRequest,
  ): Promise<PreparedMessage> {
    assertSubject(request.subject);
    // Validation happens before the body is written, so a rejected publish
    // costs no disk at all.
    const checked = this.validateAgainstSchema(
      workspace,
      request.subject,
      request.body ?? null,
    );
    if (checked && checked.violations.length > 0) {
      this.metrics.counter("bql-bus.schema.violations", 1, {
        schema: checked.schema,
        mode: checked.mode,
        workspace,
      });
      if (checked.mode === "enforce") {
        const first = checked.violations[0]!;
        throw new BusError(
          `does not match schema '${checked.schema}' version ${checked.version}: ${
            first.pointer || "/"
          } ${first.message}`,
          422,
        );
      }
    }
    const { inline, blob, sha256, bytes } = await this.writeBody(
      request.body ?? null,
    );
    const correlation =
      request.correlation ?? (request.replyTo ? uuid() : null);
    // Trace context travels in the message headers, because that is the only
    // channel that survives a queue. A publish with no incoming `traceparent`
    // starts a trace rather than dropping the idea — the point is that the
    // *message* is traceable end to end, not that the caller remembered.
    const incoming = parseTraceparent((request.headers ?? {}).traceparent);
    const trace = childOf(incoming);
    const headers: Headers = {
      ...(request.headers ?? {}),
      traceparent: formatTraceparent(trace),
      ...(request.replyTo ? { "reply-to": request.replyTo } : {}),
      ...(correlation ? { correlation } : {}),
      // A consumer can branch on the version rather than sniff the body.
      ...(checked
        ? {
            schema: checked.schema,
            "schema-version": String(checked.version),
            // `warn` exists so a schema can be introduced against live traffic
            // before it is enforced. The stamp is what makes that visible
            // downstream rather than only in a counter.
            ...(checked.violations.length > 0
              ? {
                  "schema-invalid": `${checked.violations[0]!.pointer || "/"} ${
                    checked.violations[0]!.message
                  }`.slice(0, 500),
                }
              : {}),
          }
        : {}),
    };
    return {
      request,
      inline,
      blob,
      sha256,
      bytes,
      correlation,
      headers,
      trace,
      parentSpanId: incoming?.spanId,
    };
  }

  /** The row half of a publish. Must run inside a transaction. */
  private insert(
    workspace: string,
    prepared: PreparedMessage,
    publisher: string | null,
  ): PublishResult {
    const { request, inline, blob, sha256, bytes, correlation, headers } =
      prepared;
    {
      this.assertWithinQuota(workspace, bytes);
      if (request.dedupeKey) {
        const existing = this.db
          .query(
            "SELECT seq, id, headers FROM messages WHERE workspace = ? AND dedupe_key = ?",
          )
          .get(workspace, request.dedupeKey) as
          | { seq: number; id: string; headers: string }
          | null;
        if (existing) {
          this.metrics.counter("bql-bus.messages.deduplicated", 1, { workspace });
          // The *original* correlation, not the one this call just generated:
          // a caller retrying an idempotent request has to be handed the
          // correlation the answer will actually arrive under, or it waits
          // forever on one nobody will ever reply to.
          return {
            seq: existing.seq,
            id: existing.id,
            duplicate: true,
            correlation:
              parse<Headers>(existing.headers, {}).correlation ?? correlation,
          };
        }
      }
      const id = uuid();
      const now = this.now();
      // Delayed publish. `available_at` already existed on deliveries but was
      // unreachable from a publish, so "run this in an hour" needed a second
      // system. The later of the two forms wins, so passing both is not a
      // silent race between them.
      const availableAt = Math.max(
        request.delayMs ? now + request.delayMs : 0,
        request.deliverAt ?? 0,
      );
      const priority = Math.max(
        MIN_PRIORITY,
        Math.min(MAX_PRIORITY, Math.trunc(request.priority ?? 0)),
      );
      this.db.run(
        `INSERT INTO messages (id, workspace, subject, key, headers, body, body_blob, published_at, expires_at, dedupe_key, publisher, body_sha256, body_bytes, priority, available_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          workspace,
          request.subject,
          request.key ?? null,
          JSON.stringify(headers),
          inline,
          blob,
          now,
          request.ttlMs ? now + request.ttlMs : null,
          request.dedupeKey ?? null,
          publisher,
          sha256,
          bytes,
          priority,
          availableAt,
        ],
      );
      const seq = Number(
        (this.db.query("SELECT last_insert_rowid() AS seq").get() as {
          seq: number;
        }).seq,
      );
      this.metrics.counter("bql-bus.messages.published", 1, { workspace });
      // Inside the transaction, after the row: a crash here must leave the log
      // exactly as it was, not with a message nobody was told about.
      fault("mid-txn");
      return { seq, id, duplicate: false, correlation };
    }
  }

  async message(workspace: string, seq: number): Promise<Message> {
    const row = this.db
      .query("SELECT * FROM messages WHERE seq = ? AND workspace = ?")
      .get(seq, workspace) as MessageRow | null;
    if (!row) throw new BusError("message not found", 404);
    return this.hydrate(row);
  }

  /**
   * Read the log.
   *
   * `subject` is a pattern, narrowed in SQL and decided in JavaScript — the
   * same two-step `materialize` uses, for the same reason: `GLOB` cannot
   * express "`*` is exactly one token". Because the glob over-matches, a
   * single bounded read could come back short of `limit` while matches were
   * still waiting behind it, so this walks forward in batches until it has a
   * full page or runs out of log.
   *
   * `newest` reverses the order, which is what an operator looking at a
   * dead-letter queue wants. Note that `after` is a floor on the sequence
   * number in both directions — it selects *which* messages, not where a page
   * resumes — so `newest` is "the newest N above `after`", not a cursor.
   */
  async log(
    workspace: string,
    after = 0,
    limit = 100,
    options: { subject?: string; newest?: boolean } = {},
  ): Promise<Message[]> {
    const capped = Math.min(1000, limit);
    const order = options.newest ? "DESC" : "ASC";
    if (options.subject === undefined) {
      const rows = this.db
        .query(
          `SELECT * FROM messages WHERE workspace = ? AND seq > ?
            ORDER BY seq ${order} LIMIT ?`,
        )
        .all(workspace, after, capped) as MessageRow[];
      return Promise.all(rows.map((row) => this.hydrate(row)));
    }

    const pattern = options.subject;
    assertPattern(pattern);
    const glob = narrowingGlob(pattern);
    const batch = Math.min(1000, Math.max(capped * 4, 64));
    const exact: MessageRow[] = [];
    // Walk from whichever end the order starts at, carrying the last sequence
    // number seen so each batch resumes where the previous one stopped.
    let edge = options.newest ? Number.MAX_SAFE_INTEGER : after;
    for (;;) {
      const rows = this.db
        .query(
          `SELECT * FROM messages
            WHERE workspace = ? AND seq > ? AND seq < ? AND subject GLOB ?
            ORDER BY seq ${order} LIMIT ?`,
        )
        .all(
          workspace,
          options.newest ? after : edge,
          options.newest ? edge : Number.MAX_SAFE_INTEGER,
          glob,
          batch,
        ) as MessageRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (matches(pattern, row.subject)) exact.push(row);
        if (exact.length >= capped) break;
      }
      if (exact.length >= capped || rows.length < batch) break;
      edge = rows[rows.length - 1]!.seq;
    }
    return Promise.all(exact.map((row) => this.hydrate(row)));
  }

  /**
   * Republish a dead letter onto the subject it originally failed on.
   *
   * A new message with its own sequence number, not a resurrection of the old
   * delivery: if it fails again it dead-letters again, which is the honest
   * outcome. The blob handle is shared rather than copied, which `collectBlobs`
   * already understands — "no message references it" is the only safe test.
   */
  requeue(workspace: string, seq: number): PublishResult {
    this.assertWritable();
    return this.db.transaction(() => {
      const row = this.db
        .query("SELECT * FROM messages WHERE seq=? AND workspace=?")
        .get(seq, workspace) as MessageRow | null;
      if (!row) throw new BusError("message not found", 404);
      const headers = parse<Headers>(row.headers, {});
      const original = headers["dlq-subject"];
      if (!original)
        throw new BusError(
          "that message is not a dead letter: it carries no 'dlq-subject'",
          409,
        );
      assertSubject(original);
      const carried: Headers = {};
      for (const [key, value] of Object.entries(headers))
        if (!key.startsWith("dlq-")) carried[key] = value;
      carried["requeued-from"] = String(seq);

      const id = uuid();
      const now = this.now();
      this.db.run(
        `INSERT INTO messages (id, workspace, subject, key, headers, body, body_blob, published_at, expires_at, dedupe_key, publisher, body_sha256, body_bytes, priority, available_at)
         VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,0)`,
        [
          id,
          workspace,
          original,
          row.key,
          JSON.stringify(carried),
          row.body,
          row.body_blob,
          now,
          row.publisher,
          row.body_sha256,
          row.body_bytes,
          row.priority,
        ],
      );
      const next = Number(
        (this.db.query("SELECT last_insert_rowid() AS seq").get() as {
          seq: number;
        }).seq,
      );
      // Requeueing is the operator saying what should happen to the failed
      // message, which is the answer a blocked key was waiting for. The new
      // message sorts after the block's, so unblocking here cannot let the key
      // overtake its own replacement.
      const from = headers["dlq-subscription"];
      if (from && row.key !== null) {
        const subscription = this.db
          .query("SELECT id FROM subscriptions WHERE workspace=? AND name=?")
          .get(workspace, from) as { id: string } | null;
        if (subscription)
          this.db.run(
            "DELETE FROM blocked_keys WHERE subscription_id=? AND key=?",
            [subscription.id, row.key],
          );
      }
      this.metrics.counter("bql-bus.messages.requeued", 1, { workspace });
      return {
        seq: next,
        id,
        duplicate: false,
        correlation: carried.correlation ?? null,
      };
    })();
  }

  lastSeq(): number {
    const row = this.db.query("SELECT MAX(seq) AS seq FROM messages").get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  // -------------------------------------------------------- subscriptions

  private toSubscription(row: SubscriptionRow): Subscription {
    return {
      id: row.id,
      workspace: row.workspace,
      name: row.name,
      pattern: row.pattern,
      cursorSeq: row.cursor_seq,
      ackWaitMs: row.ack_wait_ms,
      maxAttempts: row.max_attempts,
      ordered: row.ordered === 1,
      dlqSubject: row.dlq_subject,
      paused: row.paused === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      backoff: {
        baseMs: row.backoff_base_ms,
        maxMs: row.backoff_max_ms,
        factor: row.backoff_factor,
        jitter: row.backoff_jitter === "none" ? "none" : "full",
      },
      onFailure: row.on_failure === "skip" ? "skip" : "block",
      maxInFlight: row.max_in_flight,
      quarantine: {
        deadRate: row.quarantine_dead_rate,
        windowMs: row.quarantine_window_ms,
        minDead: row.quarantine_min_dead,
      },
      quarantinedAt: row.quarantined_at,
    };
  }

  private subscriptionRow(workspace: string, name: string): SubscriptionRow {
    const row = this.db
      .query("SELECT * FROM subscriptions WHERE workspace = ? AND name = ?")
      .get(workspace, name) as SubscriptionRow | null;
    if (!row) throw new BusError(`no subscription '${name}'`, 404);
    return row;
  }

  subscription(workspace: string, name: string): Subscription {
    return this.toSubscription(this.subscriptionRow(workspace, name));
  }

  /**
   * Create a subscription, or update the tunables of one that exists.
   *
   * The pattern is immutable: changing it would silently change which of the
   * messages already behind the cursor were ever considered, and a subscription
   * that quietly means something different is worse than an error.
   */
  subscribe(workspace: string, request: SubscribeRequest): Subscription {
    // A follower's subscriptions come from its upstream. One created here
    // would be silently overwritten by the next `applyCursors`, which is worse
    // than being refused.
    this.assertWritable();
    assertPattern(request.pattern);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.name))
      throw new BusError("invalid subscription name", 400);
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM subscriptions WHERE workspace = ? AND name = ?")
        .get(workspace, request.name) as SubscriptionRow | null;
      const now = this.now();
      if (existing) {
        if (existing.pattern !== request.pattern)
          throw new BusError(
            `subscription '${request.name}' already exists with pattern '${existing.pattern}'`,
          );
        this.db.run(
          `UPDATE subscriptions SET ack_wait_ms=?, max_attempts=?, ordered=?, dlq_subject=?,
             backoff_base_ms=?, backoff_max_ms=?, backoff_factor=?, backoff_jitter=?,
             on_failure=?, max_in_flight=?,
             quarantine_dead_rate=?, quarantine_window_ms=?, quarantine_min_dead=?,
             updated_at=?
           WHERE id=?`,
          [
            request.ackWaitMs ?? existing.ack_wait_ms,
            request.maxAttempts ?? existing.max_attempts,
            request.ordered === undefined
              ? existing.ordered
              : request.ordered
                ? 1
                : 0,
            request.dlqSubject ?? existing.dlq_subject,
            Math.max(0, request.backoff?.baseMs ?? existing.backoff_base_ms),
            Math.max(0, request.backoff?.maxMs ?? existing.backoff_max_ms),
            Math.max(1, request.backoff?.factor ?? existing.backoff_factor),
            request.backoff?.jitter ?? existing.backoff_jitter,
            request.onFailure ?? existing.on_failure,
            Math.max(0, request.maxInFlight ?? existing.max_in_flight),
            Math.min(
              1,
              Math.max(0, request.quarantine?.deadRate ?? existing.quarantine_dead_rate),
            ),
            Math.max(
              1000,
              request.quarantine?.windowMs ?? existing.quarantine_window_ms,
            ),
            Math.max(1, request.quarantine?.minDead ?? existing.quarantine_min_dead),
            now,
            existing.id,
          ],
        );
        return this.subscription(workspace, request.name);
      }
      const quota = this.quota(workspace);
      if (quota.maxSubscriptions > 0) {
        const used = this.usage(workspace).subscriptions;
        if (used >= quota.maxSubscriptions)
          throw new BusError(
            `workspace '${workspace}' is at its subscription quota (${quota.maxSubscriptions})`,
            429,
          );
      }
      const from = request.deliverFrom ?? "new";
      const cursor =
        from === "beginning" ? 0 : from === "new" ? this.lastSeq() : Number(from);
      const dlq =
        request.dlqSubject ?? `dlq.${request.name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
      assertSubject(dlq);
      const subscription: SubscriptionRow = {
        id: uuid(),
        workspace,
        name: request.name,
        pattern: request.pattern,
        cursor_seq: Math.max(0, cursor),
        ack_wait_ms: Math.max(1000, request.ackWaitMs ?? 30_000),
        max_attempts: Math.max(1, request.maxAttempts ?? 3),
        ordered: request.ordered ? 1 : 0,
        dlq_subject: dlq,
        paused: 0,
        created_at: now,
        updated_at: now,
        backoff_base_ms: Math.max(0, request.backoff?.baseMs ?? 1000),
        backoff_max_ms: Math.max(0, request.backoff?.maxMs ?? 60_000),
        backoff_factor: Math.max(1, request.backoff?.factor ?? 2),
        backoff_jitter: request.backoff?.jitter ?? "full",
        on_failure: request.onFailure ?? "block",
        max_in_flight: Math.max(0, request.maxInFlight ?? 0),
        quarantine_dead_rate: Math.min(
          1,
          Math.max(0, request.quarantine?.deadRate ?? 0),
        ),
        quarantine_window_ms: Math.max(
          1000,
          request.quarantine?.windowMs ?? 60_000,
        ),
        quarantine_min_dead: Math.max(1, request.quarantine?.minDead ?? 20),
        quarantined_at: null,
      };
      this.db.run(
        `INSERT INTO subscriptions (id, workspace, name, pattern, cursor_seq, ack_wait_ms, max_attempts, ordered, dlq_subject, paused, created_at, updated_at,
           backoff_base_ms, backoff_max_ms, backoff_factor, backoff_jitter, on_failure, max_in_flight,
           quarantine_dead_rate, quarantine_window_ms, quarantine_min_dead)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          subscription.id,
          workspace,
          subscription.name,
          subscription.pattern,
          subscription.cursor_seq,
          subscription.ack_wait_ms,
          subscription.max_attempts,
          subscription.ordered,
          subscription.dlq_subject,
          0,
          now,
          now,
          subscription.backoff_base_ms,
          subscription.backoff_max_ms,
          subscription.backoff_factor,
          subscription.backoff_jitter,
          subscription.on_failure,
          subscription.max_in_flight,
          subscription.quarantine_dead_rate,
          subscription.quarantine_window_ms,
          subscription.quarantine_min_dead,
        ],
      );
      return this.toSubscription(subscription);
    })();
  }

  subscriptions(workspace: string): Subscription[] {
    return (
      this.db
        .query("SELECT * FROM subscriptions WHERE workspace = ? ORDER BY name")
        .all(workspace) as SubscriptionRow[]
    ).map((row) => this.toSubscription(row));
  }

  unsubscribe(workspace: string, name: string) {
    const row = this.subscriptionRow(workspace, name);
    this.db.run("DELETE FROM subscriptions WHERE id = ?", [row.id]);
    return { ok: true };
  }

  pauseSubscription(workspace: string, name: string, paused: boolean) {
    const row = this.subscriptionRow(workspace, name);
    // Resuming clears the quarantine mark as well: an operator saying "run
    // again" has seen the storm, and leaving the mark set would make the next
    // one look like the same one.
    this.db.run(
      "UPDATE subscriptions SET paused=?, quarantined_at=?, updated_at=? WHERE id=?",
      [paused ? 1 : 0, paused ? row.quarantined_at : null, this.now(), row.id],
    );
    return this.subscription(workspace, name);
  }

  /** Rewind a cursor so already-seen messages are delivered again. */
  replay(workspace: string, name: string, fromSeq: number) {
    const row = this.subscriptionRow(workspace, name);
    this.db.run(
      "UPDATE subscriptions SET cursor_seq=?, updated_at=? WHERE id=?",
      [Math.max(0, fromSeq), this.now(), row.id],
    );
    // Settled deliveries are left in place: `UNIQUE(subscription_id,
    // message_seq)` means a replayed message is skipped rather than delivered
    // twice, so a replay picks up what was never acked. Deleting them is the
    // caller's choice, via `purge`.
    return this.subscription(workspace, name);
  }

  /** Drop settled deliveries so a replay redelivers everything in range. */
  purge(workspace: string, name: string, fromSeq = 0) {
    const row = this.subscriptionRow(workspace, name);
    const result = this.db.run(
      "DELETE FROM deliveries WHERE subscription_id=? AND message_seq>=? AND status IN ('acked','dead','cancelled')",
      [row.id, fromSeq],
    );
    return { removed: result.changes };
  }

  // ----------------------------------------------------------- deliveries

  private toDelivery(row: DeliveryRow, subscription: SubscriptionRow): Delivery {
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      subscription: subscription.name,
      messageSeq: row.message_seq,
      status: row.status,
      consumerId: row.consumer_id,
      generation: row.generation,
      attempt: row.attempt,
      maxAttempts: subscription.max_attempts,
      leaseUntil: row.lease_until,
      key: row.key,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      priority: row.priority,
      availableAt: row.available_at,
    };
  }

  /**
   * Read the log forward from the cursor, creating deliveries for matches.
   *
   * Bounded by `scanBatch`, and the cursor advances over *examined* messages
   * whether or not they matched — which is what keeps a wall of unrelated
   * subjects from starving a subscription.
   */
  private materialize(subscription: SubscriptionRow): number {
    const glob = narrowingGlob(subscription.pattern);
    const rows = this.db
      .query(
        // A cancelled message is skipped here rather than filtered at claim
        // time: a subscription whose cursor has not reached it yet would
        // otherwise materialize a delivery for it *after* it was cancelled.
        // The cursor still advances over it, because the ceiling below is
        // computed from the log, not from this result.
        `SELECT seq, subject, key, priority, available_at FROM messages
         WHERE workspace = ? AND seq > ? AND subject GLOB ? AND cancelled_at IS NULL
         ORDER BY seq LIMIT ?`,
      )
      .all(
        subscription.workspace,
        subscription.cursor_seq,
        glob,
        this.scanBatch,
      ) as {
      seq: number;
      subject: string;
      key: string | null;
      priority: number;
      available_at: number;
    }[];

    // The GLOB narrows but does not decide, so the cursor may only advance to
    // the last row we actually looked at — not past rows the GLOB skipped.
    const ceiling = this.db
      .query(
        `SELECT MAX(seq) AS seq FROM (
           SELECT seq FROM messages WHERE workspace = ? AND seq > ? ORDER BY seq LIMIT ?)`,
      )
      .get(subscription.workspace, subscription.cursor_seq, this.scanBatch) as {
      seq: number | null;
    };
    if (ceiling.seq === null) return 0;

    const now = this.now();
    let created = 0;
    for (const row of rows) {
      if (row.seq > ceiling.seq) break;
      if (!matches(subscription.pattern, row.subject)) continue;
      // Priority and availability are copied onto the delivery rather than
      // joined at claim time: the candidate scan runs on every claim and must
      // stay a single index read.
      this.db.run(
        `INSERT INTO deliveries (id, subscription_id, message_seq, status, generation, attempt, available_at, priority, key, created_at, updated_at)
         VALUES (?,?,?,'pending',0,0,?,?,?,?,?)
         ON CONFLICT(subscription_id, message_seq) DO NOTHING`,
        [
          uuid(),
          subscription.id,
          row.seq,
          row.available_at,
          row.priority,
          row.key,
          now,
          now,
        ],
      );
      created++;
    }
    this.db.run(
      "UPDATE subscriptions SET cursor_seq=?, updated_at=? WHERE id=?",
      [ceiling.seq, now, subscription.id],
    );
    subscription.cursor_seq = ceiling.seq;
    return created;
  }

  /**
   * How long a failed delivery waits before it can be claimed again.
   *
   * Exponential, capped, and jittered across the **whole** interval rather
   * than the usual half. The failure this is really about is a fleet of
   * consumers retrying in lockstep after a shared dependency blinked; equal
   * jitter keeps them in a narrower band and so keeps the thundering herd.
   */
  private backoffMs(subscription: SubscriptionRow, attempt: number): number {
    const base = subscription.backoff_base_ms;
    if (base <= 0) return 0;
    const raw =
      base * subscription.backoff_factor ** Math.max(0, attempt - 1);
    const capped = Math.min(subscription.backoff_max_ms, raw);
    if (subscription.backoff_jitter === "none") return Math.round(capped);
    return Math.round(Math.random() * capped);
  }

  /** Return expired leases on one subscription. Never a global scan. */
  reclaim(subscriptionId?: string): number {
    return this.db.transaction(() => {
      const now = this.now();
      const rows = (
        subscriptionId
          ? this.db
              .query(
                "SELECT * FROM deliveries WHERE subscription_id=? AND status='leased' AND lease_until <= ?",
              )
              .all(subscriptionId, now)
          : this.db
              .query(
                "SELECT * FROM deliveries WHERE status='leased' AND lease_until <= ?",
              )
              .all(now)
      ) as DeliveryRow[];
      for (const row of rows) {
        const subscription = this.db
          .query("SELECT * FROM subscriptions WHERE id=?")
          .get(row.subscription_id) as SubscriptionRow;
        if (row.attempt >= subscription.max_attempts)
          this.deadLetter(row, subscription, "lease expired and attempts exhausted");
        else
          // `available_at` was not set here at all, which is the bug this
          // whole mechanism exists for: a message whose consumer keeps dying
          // came straight back and was claimed again at whatever rate
          // consumers could ask, burning every attempt in milliseconds. A
          // reclaim is a failure like any other and is paced like one.
          this.db.run(
            `UPDATE deliveries SET status='pending', consumer_id=NULL, lease_until=NULL,
               available_at=?, error=?, updated_at=? WHERE id=? AND status='leased'`,
            [
              now + this.backoffMs(subscription, row.attempt),
              "lease expired",
              now,
              row.id,
            ],
          );
      }
      if (rows.length > 0)
        this.metrics.counter("bql-bus.deliveries.reclaimed", rows.length);
      return rows.length;
    })();
  }

  private deadLetter(
    row: DeliveryRow,
    subscription: SubscriptionRow,
    reason: string,
    options: { dropBody?: boolean; reasonTag?: string } = {},
  ) {
    const now = this.now();
    this.metrics.counter("bql-bus.deliveries.dead", 1, {
      subscription: subscription.name,
      workspace: subscription.workspace,
    });
    this.db.run(
      "UPDATE deliveries SET status='dead', consumer_id=NULL, lease_until=NULL, error=?, updated_at=? WHERE id=?",
      [reason, now, row.id],
    );
    // The dead letter is an ordinary message on an ordinary subject, so a DLQ
    // is just another subscription and a replay is just another publish.
    const original = this.db
      .query("SELECT * FROM messages WHERE seq=?")
      .get(row.message_seq) as MessageRow;
    const headers: Headers = {
      ...parse<Headers>(original.headers, {}),
      "dlq-reason": options.reasonTag ?? reason.slice(0, 500),
      ...(options.reasonTag ? { "dlq-detail": reason.slice(0, 500) } : {}),
      "dlq-subject": original.subject,
      "dlq-subscription": subscription.name,
      "dlq-attempts": String(row.attempt),
      // A body that could not be read cannot be carried. The dead letter still
      // has to exist — the headers are how an operator finds out *which*
      // message was lost — so it carries a null body and says why.
      ...(options.dropBody ? { "dlq-body": "missing" } : {}),
    };
    this.db.run(
      `INSERT INTO messages (id, workspace, subject, key, headers, body, body_blob, published_at, expires_at, dedupe_key, publisher, body_sha256, body_bytes, priority, available_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,0)`,
      [
        uuid(),
        subscription.workspace,
        subscription.dlq_subject,
        original.key,
        JSON.stringify(headers),
        options.dropBody ? "null" : original.body,
        options.dropBody ? null : original.body_blob,
        now,
        // The dead letter belongs to whoever published the original, so the
        // same party can still act on it.
        original.publisher,
        options.dropBody ? null : original.body_sha256,
        options.dropBody ? 4 : original.body_bytes,
        original.priority,
      ],
    );

    // An ordered subscription that lets the *next* message with this key
    // through is doing the one thing `ordered: true` was bought to prevent.
    // Block the key — and only this key — until an operator requeues the dead
    // letter or skips it deliberately.
    if (
      subscription.ordered === 1 &&
      subscription.on_failure !== "skip" &&
      row.key !== null
    ) {
      this.db.run(
        `INSERT INTO blocked_keys (subscription_id, key, message_seq, delivery_id, reason, created_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(subscription_id, key) DO NOTHING`,
        [
          subscription.id,
          row.key,
          row.message_seq,
          row.id,
          reason.slice(0, 500),
          now,
        ],
      );
      this.metrics.counter("bql-bus.keys.blocked", 1, {
        subscription: subscription.name,
        workspace: subscription.workspace,
      });
    }

    this.quarantineIfMelting(subscription);
  }

  /**
   * Pause a subscription that is dead-lettering at a rate nobody meant.
   *
   * A subscription melting into its DLQ at full speed should stop, not finish:
   * finishing means the whole backlog is in the dead-letter queue and the
   * operator finds out afterwards. Other subscriptions keep serving, because
   * the failure is almost never install-wide.
   */
  private quarantineIfMelting(subscription: SubscriptionRow): void {
    if (subscription.quarantine_dead_rate <= 0) return;
    if (subscription.quarantined_at !== null || subscription.paused === 1) return;
    const since = this.now() - subscription.quarantine_window_ms;
    const counts = this.db
      .query(
        `SELECT status, COUNT(*) AS n FROM deliveries
          WHERE subscription_id=? AND status IN ('dead','acked') AND updated_at >= ?
          GROUP BY status`,
      )
      .all(subscription.id, since) as { status: string; n: number }[];
    const dead = counts.find((row) => row.status === "dead")?.n ?? 0;
    const acked = counts.find((row) => row.status === "acked")?.n ?? 0;
    if (dead < subscription.quarantine_min_dead) return;
    if (dead / Math.max(1, dead + acked) < subscription.quarantine_dead_rate)
      return;
    const now = this.now();
    this.db.run(
      "UPDATE subscriptions SET paused=1, quarantined_at=?, updated_at=? WHERE id=?",
      [now, now, subscription.id],
    );
    subscription.paused = 1;
    subscription.quarantined_at = now;
    this.metrics.counter("bql-bus.subscriptions.quarantined", 1, {
      subscription: subscription.name,
      workspace: subscription.workspace,
    });
  }

  /** Keys an ordered subscription is stalled on, oldest first. */
  blockedKeys(workspace: string, name: string): BlockedKey[] {
    const subscription = this.subscriptionRow(workspace, name);
    return (
      this.db
        .query(
          "SELECT * FROM blocked_keys WHERE subscription_id=? ORDER BY created_at",
        )
        .all(subscription.id) as {
        key: string;
        message_seq: number;
        delivery_id: string;
        reason: string;
        created_at: number;
      }[]
    ).map((row) => ({
      subscription: name,
      key: row.key,
      messageSeq: row.message_seq,
      deliveryId: row.delivery_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  /**
   * Let a blocked key move again.
   *
   * Deliberately an operator action and not a timeout: the whole point of
   * blocking was that nobody had decided what to do about the failed message,
   * and a timeout is a decision to reorder taken by a clock.
   */
  unblockKey(workspace: string, name: string, key: string): { unblocked: boolean } {
    const subscription = this.subscriptionRow(workspace, name);
    const result = this.db.run(
      "DELETE FROM blocked_keys WHERE subscription_id=? AND key=?",
      [subscription.id, key],
    );
    return { unblocked: result.changes > 0 };
  }

  /**
   * Lease up to `max` deliveries to one consumer.
   *
   * The claim is a conditional update out of `pending`, so a row already taken
   * cannot be taken twice. On an ordered subscription a delivery is skipped
   * while another with the same key is in flight.
   */
  async claim(
    workspace: string,
    name: string,
    consumerId: string,
    max = 1,
  ): Promise<Envelope[]> {
    // A follower serves reads. Leasing is a write, and a lease handed out by a
    // replica is a promise the replica cannot keep.
    this.assertWritable();
    const started = this.now();
    const leased = this.db.transaction(() => {
      const subscription = this.subscriptionRow(workspace, name);
      if (subscription.paused === 1) return [] as DeliveryRow[];
      this.reclaim(subscription.id);
      this.materialize(subscription);

      const now = this.now();
      /**
       * For an ordered subscription, the oldest *unsettled* delivery per key.
       *
       * "Nothing leased for this key" is not enough, and the `--ordered
       * --poison` gate is what proved it: a message that was nacked or
       * reclaimed goes back to `pending` with a backoff delay, and during that
       * delay it is not leased — so the next message on its key was claimable
       * and ran first. Per-key FIFO means only the *head* of a key may be
       * claimed, whatever state the head happens to be in.
       */
      const headOf = (keys: string[]): Map<string, number> => {
        if (keys.length === 0) return new Map();
        // Restricted to the keys actually in the candidate window, so the
        // claim stays O(candidates) rather than O(backlog) — a `GROUP BY` over
        // every pending row would have made an ordered subscription slower the
        // more work it had waiting. No `available_at` filter: a head sitting
        // out its backoff is exactly the one that must keep the key closed.
        const placeholders = keys.map(() => "?").join(",");
        return new Map(
          (
            this.db
              .query(
                `SELECT key, MIN(message_seq) AS head FROM deliveries
                  WHERE subscription_id=? AND status IN ('pending','leased')
                    AND key IN (${placeholders})
                  GROUP BY key`,
              )
              .all(subscription.id, ...keys) as { key: string; head: number }[]
          ).map((row) => [row.key, row.head] as const),
        );
      };
      const inFlight = new Set<string>();

      // Keys stalled behind a dead letter. Read once per claim rather than
      // per candidate: an ordered subscription with nothing blocked — the
      // normal case — pays one empty query.
      const blocked = subscription.ordered
        ? new Set(
            (
              this.db
                .query("SELECT key FROM blocked_keys WHERE subscription_id=?")
                .all(subscription.id) as { key: string }[]
            ).map((row) => row.key),
          )
        : new Set<string>();

      // A ceiling on leased work, so one process with an ambitious `prefetch`
      // cannot lease the entire backlog moments before it dies.
      let budget = max;
      if (subscription.max_in_flight > 0) {
        const leasedNow = (
          this.db
            .query(
              "SELECT COUNT(*) AS n FROM deliveries WHERE subscription_id=? AND status='leased'",
            )
            .get(subscription.id) as { n: number }
        ).n;
        budget = Math.min(budget, subscription.max_in_flight - leasedNow);
      }
      if (budget <= 0) return [] as DeliveryRow[];

      const candidates = this.db
        .query(
          // Priority first, then the log order within a class. A bounded set
          // of classes, so this stays a tie-break on `message_seq` rather than
          // a scheduler nobody can reason about.
          `SELECT * FROM deliveries
           WHERE subscription_id=? AND status='pending' AND available_at<=?
           ORDER BY priority DESC, message_seq LIMIT ?`,
        )
        .all(subscription.id, now, Math.max(budget * 4, 32)) as DeliveryRow[];

      const head = subscription.ordered
        ? headOf([
            ...new Set(
              candidates
                .map((row) => row.key)
                .filter((key): key is string => key !== null),
            ),
          ])
        : new Map<string, number>();

      const taken: DeliveryRow[] = [];
      for (const row of candidates) {
        if (taken.length >= budget) break;
        if (subscription.ordered && row.key !== null) {
          if (blocked.has(row.key)) continue;
          // Only the head of a key moves, and only one at a time.
          if (head.get(row.key) !== row.message_seq) continue;
          if (inFlight.has(row.key)) continue;
          inFlight.add(row.key);
        }
        const result = this.db.run(
          `UPDATE deliveries SET status='leased', consumer_id=?, generation=generation+1,
             attempt=attempt+1, lease_until=?, updated_at=?
           WHERE id=? AND status='pending'`,
          [consumerId, now + subscription.ack_wait_ms, now, row.id],
        );
        if (result.changes !== 1) continue;
        taken.push(
          this.db.query("SELECT * FROM deliveries WHERE id=?").get(row.id) as
            DeliveryRow,
        );
      }
      this.touchConsumer(workspace, consumerId);
      return taken;
    })();

    const subscription = this.subscriptionRow(workspace, name);
    const hydrated = await Promise.all(
      leased.map(async (row) => {
        try {
          const message = await this.message(workspace, row.message_seq);
          // Delivery-time validation. A message already in the log cannot be
          // rejected — it was accepted, and the publisher is long gone — so a
          // body that no longer matches an enforced schema dead-letters
          // instead of being dropped or handed over anyway. This is what
          // catches messages published before the binding existed, or under
          // `warn`.
          if (this.hasBindings(workspace)) {
            const checked = this.validateAgainstSchema(
              workspace,
              message.subject,
              message.body,
            );
            if (
              checked &&
              checked.mode === "enforce" &&
              checked.violations.length > 0
            ) {
              const first = checked.violations[0]!;
              this.db.transaction(() =>
                this.deadLetter(
                  row,
                  subscription,
                  `schema: ${first.pointer || "/"} ${first.message}`,
                  { reasonTag: "schema" },
                ),
              )();
              this.metrics.counter("bql-bus.schema.violations", 1, {
                schema: checked.schema,
                mode: "delivery",
                workspace,
              });
              return null;
            }
          }
          return {
            delivery: this.toDelivery(row, subscription),
            message,
            idempotencyKey: `${name}:${row.message_seq}`,
            // The fence token identifies *this attempt*, not this message: a
            // destination that supports conditional writes can reject a writer
            // whose lease has already moved on. See `docs/exactly-once.md`.
            fence: `${row.id}:${row.generation}`,
          } satisfies Envelope;
        } catch (error) {
          // A body whose bytes are gone or corrupt can never be delivered, and
          // failing the claim would stall the whole subscription behind it
          // forever. Dead-letter this one delivery and carry on with the rest.
          if (!(error instanceof BlobMissingError) && !(error instanceof BusError))
            throw error;
          if (error instanceof BusError && error.status !== 500) throw error;
          this.db.transaction(() =>
            this.deadLetter(row, subscription, error.message, { dropBody: true }),
          )();
          this.metrics.counter("bql-bus.blobs.unreadable", 1, {
            subscription: name,
            workspace,
          });
          return null;
        }
      }),
    );
    const envelopes = hydrated.filter((entry): entry is Envelope => entry !== null);
    // Timed around the whole call, hydration included: a claim that spends its
    // time reading a blob is still a slow claim to the consumer waiting on it.
    this.metrics.histogram("bql-bus.claim.duration", this.now() - started, {
      subscription: name,
      workspace,
    });
    if (envelopes.length > 0)
      this.metrics.counter("bql-bus.deliveries.claimed", envelopes.length, {
        subscription: name,
        workspace,
      });
    for (const envelope of envelopes) {
      // Age at claim is the number that actually says the bus is behind: a
      // claim can be fast while every message it hands over is an hour old.
      this.metrics.histogram(
        "bql-bus.delivery.age",
        Math.max(0, this.now() - envelope.message.publishedAt),
        { subscription: name, workspace },
      );
      const parent = parseTraceparent(envelope.message.headers.traceparent);
      this.span({
        context: childOf(parent),
        parent: parent?.spanId,
        name: `deliver ${envelope.message.subject}`,
        kind: "consumer",
        startMs: started,
        endMs: this.now(),
        attributes: {
          "messaging.system": "bql-bus",
          "messaging.destination.name": envelope.message.subject,
          "messaging.consumer.group.name": name,
          "messaging.message.id": envelope.message.id,
          "bql-bus.attempt": envelope.delivery.attempt,
          "bql-bus.workspace": workspace,
        },
      });
    }
    return envelopes;
  }

  private owned(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
  ): { row: DeliveryRow; subscription: SubscriptionRow } {
    const row = this.db
      .query("SELECT * FROM deliveries WHERE id=?")
      .get(deliveryId) as DeliveryRow | null;
    if (!row) throw new BusError("delivery not found", 404);
    const subscription = this.db
      .query("SELECT * FROM subscriptions WHERE id=?")
      .get(row.subscription_id) as SubscriptionRow;
    if (subscription.workspace !== workspace)
      throw new BusError("delivery not found", 404);
    if (
      row.status !== "leased" ||
      row.consumer_id !== consumerId ||
      row.generation !== generation ||
      (row.lease_until ?? 0) <= this.now()
    )
      throw new BusError("stale lease");
    return { row, subscription };
  }

  /**
   * Ack — and, optionally, publish what the work produced in the same
   * transaction.
   *
   * **Tier 2, atomic read-process-write.** `publish` commits with the ack or
   * not at all, so a consumer that reads from one subject and writes to another
   * is exactly-once end to end for as long as the chain stays on the bus. This
   * is the Kafka-transactions story, and it is three lines here rather than a
   * subsystem because there is one writer and one transaction.
   *
   * **An ack is idempotent for its own consumer.** A consumer whose ack
   * succeeded but whose *response* was lost used to retry into a 409 and
   * record a success as a failure. Now a repeat from the same consumer and
   * generation replays the original outcome with `replayed: true` — which is a
   * different fact from "someone else owns this now", and the caller can tell
   * them apart.
   */
  async ack(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
    options: { publish?: PublishRequest[]; effects?: EffectRecord[] } = {},
  ): Promise<AckResult> {
    this.assertWritable();
    const started = this.now();
    // Bodies are written before the transaction opens, because a transaction
    // may not await. An ack that is only a replay still pays for this, which
    // is the price of finding out it was a replay only under the lock.
    const prepared: PreparedMessage[] = [];
    for (const request of options.publish ?? [])
      prepared.push(await this.prepare(workspace, request));

    return this.db.transaction(() => {
      const replay = this.ackReplay(workspace, deliveryId, consumerId, generation);
      if (replay) return replay;

      const { row, subscription } = this.owned(
        workspace,
        deliveryId,
        consumerId,
        generation,
      );
      const published = prepared.map((entry) => {
        const result = this.insert(workspace, entry, consumerId);
        // A reply is a publish that also records a response, so request/reply
        // becomes a special case of Tier 2 rather than a second path with its
        // own crash windows.
        if (entry.request.reply === true && entry.correlation)
          this.respond(
            workspace,
            entry.correlation,
            result.seq,
            entry.request.body ?? null,
            entry.headers,
          );
        return result;
      });
      for (const effect of options.effects ?? [])
        this.recordEffect(workspace, effect);

      this.db.run(
        `UPDATE deliveries SET status='acked', lease_until=NULL, error=NULL,
           ack_result=?, updated_at=? WHERE id=? AND status='leased'`,
        [
          published.length > 0 ? JSON.stringify(published) : null,
          this.now(),
          row.id,
        ],
      );
      this.metrics.counter("bql-bus.deliveries.acked", 1, {
        subscription: subscription.name,
        workspace,
      });
      this.metrics.histogram(
        "bql-bus.ack.duration",
        Math.max(0, this.now() - started),
        { subscription: subscription.name, workspace },
      );
      // End-to-end age: published to finished. The one number that answers
      // "how long does work actually take to get done here".
      const publishedAt = this.db
        .query("SELECT published_at FROM messages WHERE seq=?")
        .get(row.message_seq) as { published_at: number } | null;
      if (publishedAt)
        this.metrics.histogram(
          "bql-bus.message.age_at_ack",
          Math.max(0, this.now() - publishedAt.published_at),
          { subscription: subscription.name, workspace },
        );
      if (published.length > 0)
        this.metrics.counter(
          "bql-bus.deliveries.acked_with_publish",
          published.length,
          { subscription: subscription.name },
        );
      return {
        ...this.toDelivery(
          this.db.query("SELECT * FROM deliveries WHERE id=?").get(row.id) as
            DeliveryRow,
          subscription,
        ),
        published,
        replayed: false,
      };
    })();
  }

  /**
   * The original outcome of an ack this consumer already made, or null.
   *
   * Deliberately narrow: same delivery, same consumer, same generation. A
   * different generation means the lease was reclaimed and re-leased — possibly
   * to this same consumer — and that is a genuine conflict, not a retry.
   */
  private ackReplay(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
  ): AckResult | null {
    const row = this.db
      .query("SELECT * FROM deliveries WHERE id=?")
      .get(deliveryId) as DeliveryRow | null;
    if (!row || row.status !== "acked") return null;
    if (row.consumer_id !== consumerId || row.generation !== generation)
      return null;
    const subscription = this.db
      .query("SELECT * FROM subscriptions WHERE id=?")
      .get(row.subscription_id) as SubscriptionRow;
    if (subscription.workspace !== workspace) return null;
    this.metrics.counter("bql-bus.deliveries.ack_replayed", 1, {
      subscription: subscription.name,
      workspace,
    });
    return {
      ...this.toDelivery(row, subscription),
      published: parse<PublishResult[]>(row.ack_result, []),
      replayed: true,
    };
  }

  // -------------------------------------------------------- effect ledger

  /**
   * Claim the right to perform an external effect exactly once.
   *
   * Three answers, and the third is the honest one:
   *   · nobody has claimed this key → `fresh`, go and do it
   *   · a previous attempt recorded a result → `fresh: false` with that result,
   *     replayed instead of repeated
   *   · a previous attempt claimed it and never recorded anything → `fresh`
   *     *and* `retried`. The effect may have happened. The fence token is what
   *     lets the destination reject the older writer; nothing here can make the
   *     repeat impossible, and pretending otherwise would be the lie.
   */
  claimEffect(workspace: string, key: string, fence: string | null): EffectClaim {
    return this.db.transaction(() => {
      const now = this.now();
      const row = this.db
        .query("SELECT * FROM effects WHERE workspace=? AND key=?")
        .get(workspace, key) as
        | { status: string; result: string | null; fence: string | null }
        | null;
      if (row === null) {
        this.db.run(
          `INSERT INTO effects (workspace, key, fence, status, result, created_at, updated_at)
           VALUES (?,?,?, 'claimed', NULL, ?, ?)`,
          [workspace, key, fence, now, now],
        );
        this.metrics.counter("bql-bus.effects.claimed", 1);
        return { fresh: true, result: null, retried: false };
      }
      if (row.status === "recorded") {
        this.metrics.counter("bql-bus.effects.replayed", 1);
        return {
          fresh: false,
          result: parse<Json>(row.result, null),
          retried: false,
        };
      }
      this.db.run(
        "UPDATE effects SET fence=?, updated_at=? WHERE workspace=? AND key=?",
        [fence, now, workspace, key],
      );
      const retried = row.fence !== fence;
      if (retried) this.metrics.counter("bql-bus.effects.retried", 1);
      return { fresh: true, result: null, retried };
    })();
  }

  /** Record what an effect returned. Idempotent: the first result wins. */
  recordEffect(workspace: string, effect: EffectRecord): void {
    const now = this.now();
    this.db.run(
      `INSERT INTO effects (workspace, key, fence, status, result, created_at, updated_at)
       VALUES (?,?,NULL,'recorded',?,?,?)
       ON CONFLICT(workspace, key) DO UPDATE SET
         status='recorded',
         result=COALESCE(effects.result, excluded.result),
         updated_at=excluded.updated_at
       WHERE effects.status <> 'recorded'`,
      [workspace, effect.key, JSON.stringify(effect.result ?? null), now, now],
    );
    this.metrics.counter("bql-bus.effects.recorded", 1);
  }

  effect(workspace: string, key: string): EffectClaim | null {
    const row = this.db
      .query("SELECT status, result FROM effects WHERE workspace=? AND key=?")
      .get(workspace, key) as { status: string; result: string | null } | null;
    if (!row) return null;
    return {
      fresh: row.status !== "recorded",
      result: row.status === "recorded" ? parse<Json>(row.result, null) : null,
      retried: false,
    };
  }

  /**
   * Tier 1: run a handler's own SQLite writes and the ack in one transaction.
   *
   * Only reachable in embedded mode, where the handler runs in the bus's own
   * process against the same file — which is exactly why it works. There is no
   * two-phase commit, no idempotency key and nothing to reconcile: either the
   * handler's rows and the ack are both there, or neither is. This is the
   * strongest guarantee available anywhere, and the single-writer design is
   * what earns it rather than what it has to work around.
   *
   * `work` **must be synchronous.** An `await` inside a SQLite transaction
   * lets another statement interleave into it, which turns the one property
   * this method exists for into a coin flip. The type says so; so does this.
   */
  ackTransactional<T>(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
    work: (db: Database) => T,
  ): { value: T; delivery: Delivery } {
    return this.db.transaction(() => {
      const { row, subscription } = this.owned(
        workspace,
        deliveryId,
        consumerId,
        generation,
      );
      const value = work(this.db);
      this.db.run(
        "UPDATE deliveries SET status='acked', lease_until=NULL, error=NULL, updated_at=? WHERE id=? AND status='leased'",
        [this.now(), row.id],
      );
      this.metrics.counter("bql-bus.deliveries.acked", 1, {
        subscription: subscription.name,
        workspace,
      });
      this.metrics.counter("bql-bus.deliveries.acked_transactional", 1, {
        subscription: subscription.name,
        workspace,
      });
      return {
        value,
        delivery: this.toDelivery(
          this.db.query("SELECT * FROM deliveries WHERE id=?").get(row.id) as
            DeliveryRow,
          subscription,
        ),
      };
    })();
  }

  nack(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
    options: { error?: string; fatal?: boolean; delayMs?: number } = {},
  ): Delivery {
    return this.db.transaction(() => {
      const { row, subscription } = this.owned(
        workspace,
        deliveryId,
        consumerId,
        generation,
      );
      const reason = (options.error ?? "consumer nacked").slice(0, 4000);
      const exhausted =
        options.fatal === true || row.attempt >= subscription.max_attempts;
      this.metrics.counter("bql-bus.deliveries.nacked", 1, {
        subscription: subscription.name,
        workspace,
      });
      if (exhausted) this.deadLetter(row, subscription, reason);
      else
        // An explicit `delayMs` — including zero, which is what a consumer
        // shutting down sends to hand work straight back — wins. Otherwise the
        // subscription's backoff applies, because a nack with no delay at all
        // was the default and it is a hot loop.
        this.db.run(
          `UPDATE deliveries SET status='pending', consumer_id=NULL, lease_until=NULL,
             available_at=?, error=?, updated_at=? WHERE id=? AND status='leased'`,
          [
            this.now() +
              (options.delayMs ?? this.backoffMs(subscription, row.attempt)),
            reason,
            this.now(),
            row.id,
          ],
        );
      return this.toDelivery(
        this.db.query("SELECT * FROM deliveries WHERE id=?").get(row.id) as
          DeliveryRow,
        subscription,
      );
    })();
  }

  /**
   * Renew a lease — and tell the consumer if the work has been cancelled.
   *
   * The renewal is the cancellation channel. A consumer that is running a long
   * handler is already talking to the bus on a timer, so cancellation needs no
   * second mechanism and no push: the next `extend` answers
   * `{cancelled: true}` instead of failing as a stale lease, and the consumer
   * aborts its handler's signal.
   */
  extend(
    workspace: string,
    deliveryId: string,
    consumerId: string,
    generation: number,
  ): ExtendResult {
    const cancelled = this.db
      .query(
        `SELECT d.status FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id
          WHERE d.id=? AND s.workspace=? AND d.consumer_id=? AND d.status='cancelled'`,
      )
      .get(deliveryId, workspace, consumerId) as { status: string } | null;
    if (cancelled) return { leaseUntil: null, cancelled: true };

    const { row, subscription } = this.owned(
      workspace,
      deliveryId,
      consumerId,
      generation,
    );
    const leaseUntil = this.now() + subscription.ack_wait_ms;
    this.db.run(
      "UPDATE deliveries SET lease_until=?, updated_at=? WHERE id=? AND status='leased'",
      [leaseUntil, this.now(), row.id],
    );
    this.touchConsumer(workspace, consumerId);
    return { leaseUntil, cancelled: false };
  }

  // --------------------------------------------------------- cancellation

  /** Enough of a message to decide who may cancel it, without reading a blob. */
  messageMeta(workspace: string, seq: number): MessageMeta {
    const row = this.db
      .query(
        "SELECT seq, subject, publisher, cancelled_at FROM messages WHERE seq=? AND workspace=?",
      )
      .get(seq, workspace) as {
      seq: number;
      subject: string;
      publisher: string | null;
      cancelled_at: number | null;
    } | null;
    if (!row) throw new BusError("message not found", 404);
    return {
      seq: row.seq,
      subject: row.subject,
      publisher: row.publisher,
      cancelledAt: row.cancelled_at,
    };
  }

  /** One delivery, by id, within a workspace. */
  delivery(workspace: string, deliveryId: string): Delivery {
    const row = this.db
      .query("SELECT * FROM deliveries WHERE id=?")
      .get(deliveryId) as DeliveryRow | null;
    if (!row) throw new BusError("delivery not found", 404);
    const subscription = this.db
      .query("SELECT * FROM subscriptions WHERE id=?")
      .get(row.subscription_id) as SubscriptionRow;
    if (subscription.workspace !== workspace)
      throw new BusError("delivery not found", 404);
    return this.toDelivery(row, subscription);
  }

  /**
   * Cancel every unfinished delivery of a message, and stop new ones.
   *
   * `cancelled` is a fourth terminal status rather than a flag beside the
   * status, because a flag means every query that filters on status has to
   * remember to check it too — and the one that forgets re-delivers cancelled
   * work. As a status it is simply not leasable.
   */
  cancelMessage(workspace: string, seq: number): CancelResult {
    this.assertWritable();
    return this.db.transaction(() => {
      const meta = this.messageMeta(workspace, seq);
      const now = this.now();
      if (meta.cancelledAt === null)
        this.db.run("UPDATE messages SET cancelled_at=? WHERE seq=?", [
          now,
          seq,
        ]);
      const result = this.db.run(
        // `consumer_id` is kept, not cleared: it is how `extend` recognises
        // the consumer still running this work and answers it with
        // `{cancelled: true}` instead of a stale-lease error — and it is the
        // only record of who was holding it when the cancel landed.
        `UPDATE deliveries SET status='cancelled', lease_until=NULL,
           error='cancelled', updated_at=?
         WHERE message_seq=? AND status IN ('pending','leased')`,
        [now, seq],
      );
      this.metrics.counter("bql-bus.deliveries.cancelled", result.changes, {
        workspace,
      });
      return {
        cancelled: result.changes,
        alreadyCancelled: meta.cancelledAt !== null,
      };
    })();
  }

  /** Cancel one subscription's copy of a message, leaving the others alone. */
  cancelDelivery(workspace: string, deliveryId: string): CancelResult {
    this.assertWritable();
    return this.db.transaction(() => {
      const delivery = this.delivery(workspace, deliveryId);
      const result = this.db.run(
        `UPDATE deliveries SET status='cancelled', lease_until=NULL,
           error='cancelled', updated_at=?
         WHERE id=? AND status IN ('pending','leased')`,
        [this.now(), deliveryId],
      );
      this.metrics.counter("bql-bus.deliveries.cancelled", result.changes, {
        workspace,
      });
      return {
        cancelled: result.changes,
        alreadyCancelled: delivery.status === "cancelled",
      };
    })();
  }

  deliveries(workspace: string, limit = 200): Delivery[] {
    // The subscription's name and attempt cap come back on the join: this is
    // the dashboard's refresh path, and a lookup per row made it 200 queries a
    // second for a screen showing 200 rows.
    const rows = this.db
      .query(
        `SELECT d.*, s.name AS subscription_name, s.max_attempts AS subscription_max
           FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id
          WHERE s.workspace = ? ORDER BY d.updated_at DESC LIMIT ?`,
      )
      .all(workspace, limit) as (DeliveryRow & {
      subscription_name: string;
      subscription_max: number;
    })[];
    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      subscription: row.subscription_name,
      messageSeq: row.message_seq,
      status: row.status,
      consumerId: row.consumer_id,
      generation: row.generation,
      attempt: row.attempt,
      maxAttempts: row.subscription_max,
      leaseUntil: row.lease_until,
      key: row.key,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      priority: row.priority,
      availableAt: row.available_at,
    }));
  }

  // ------------------------------------------------------------ responses

  /** Record a reply against its correlation, for the caller to collect later. */
  respond(
    workspace: string,
    correlation: string,
    messageSeq: number,
    body: Json,
    headers: Headers,
  ) {
    this.db.run(
      `INSERT INTO responses (workspace, correlation, message_seq, headers, body, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(workspace, correlation) DO NOTHING`,
      [
        workspace,
        correlation,
        messageSeq,
        JSON.stringify(headers),
        JSON.stringify(body ?? null),
        this.now(),
      ],
    );
  }

  response(workspace: string, correlation: string): Response | null {
    const row = this.db
      .query("SELECT * FROM responses WHERE workspace=? AND correlation=?")
      .get(workspace, correlation) as
      | {
          workspace: string;
          correlation: string;
          message_seq: number;
          headers: string;
          body: string | null;
          created_at: number;
        }
      | null;
    return row
      ? {
          workspace: row.workspace,
          correlation: row.correlation,
          messageSeq: row.message_seq,
          headers: parse<Headers>(row.headers, {}),
          body: parse<Json>(row.body, null),
          createdAt: row.created_at,
        }
      : null;
  }

  // ------------------------------------------------------------ consumers

  private touchConsumer(workspace: string, id: string) {
    this.db.run(
      "UPDATE consumers SET last_seen=? WHERE id=? AND workspace=?",
      [this.now(), id, workspace],
    );
  }

  register(workspace: string, input: RegisterConsumer): Consumer {
    const existing = this.db
      .query("SELECT data FROM consumers WHERE id=? AND workspace=?")
      .get(input.id, workspace) as { data: string } | null;
    const consumer: Consumer = {
      id: input.id,
      workspace,
      name: input.name,
      host: input.host,
      subscriptions: input.subscriptions,
      labels: input.labels ?? {},
      paused: existing ? (JSON.parse(existing.data) as Consumer).paused : false,
      registeredAt: existing
        ? (JSON.parse(existing.data) as Consumer).registeredAt
        : this.now(),
      lastSeen: this.now(),
    };
    this.db.run(
      `INSERT INTO consumers (id, workspace, last_seen, data) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, data=excluded.data`,
      [consumer.id, workspace, consumer.lastSeen, JSON.stringify(consumer)],
    );
    return consumer;
  }

  consumer(workspace: string, id: string): Consumer {
    const row = this.db
      .query("SELECT data FROM consumers WHERE id=? AND workspace=?")
      .get(id, workspace) as { data: string } | null;
    if (!row) throw new BusError("consumer not registered", 404);
    return JSON.parse(row.data) as Consumer;
  }

  pauseConsumer(workspace: string, id: string, paused: boolean): Consumer {
    const consumer = { ...this.consumer(workspace, id), paused };
    this.db.run("UPDATE consumers SET data=? WHERE id=? AND workspace=?", [
      JSON.stringify(consumer),
      id,
      workspace,
    ]);
    return consumer;
  }

  consumers(workspace: string): Consumer[] {
    return (
      this.db
        .query(
          "SELECT data FROM consumers WHERE workspace=? ORDER BY last_seen DESC",
        )
        .all(workspace) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Consumer);
  }

  /**
   * How many consumers have checked in recently. Readiness is a property of the
   * install, not of one tenant, so `workspace` is optional here — an install
   * with consumers in some other workspace is still able to run work.
   */
  liveConsumers(workspace?: string, withinMs = 60_000): number {
    const since = this.now() - withinMs;
    const row = (
      workspace === undefined
        ? this.db
            .query("SELECT COUNT(*) AS n FROM consumers WHERE last_seen > ?")
            .get(since)
        : this.db
            .query(
              "SELECT COUNT(*) AS n FROM consumers WHERE workspace=? AND last_seen > ?",
            )
            .get(workspace, since)
    ) as { n: number };
    return row.n;
  }

  // ----------------------------------------------------------- operations

  stats(workspace: string): Stats {
    const lastSeq = this.lastSeq();
    const subscriptions: SubscriptionStats[] = this.subscriptions(workspace).map(
      (subscription) => {
        const counts = this.db
          .query(
            "SELECT status, COUNT(*) AS n FROM deliveries WHERE subscription_id=? GROUP BY status",
          )
          .all(subscription.id) as { status: DeliveryStatus; n: number }[];
        const of = (status: DeliveryStatus) =>
          counts.find((row) => row.status === status)?.n ?? 0;
        return {
          ...subscription,
          pending: of("pending"),
          leased: of("leased"),
          acked: of("acked"),
          dead: of("dead"),
          cancelled: of("cancelled"),
          lag: Math.max(0, lastSeq - subscription.cursorSeq),
          // Age of the oldest thing still waiting. Depth says how much is
          // queued; this says how long the front of the queue has been there,
          // which is the number an alert should actually fire on.
          oldestPendingAgeMs: (() => {
            const row = this.db
              .query(
                "SELECT MIN(created_at) AS at FROM deliveries WHERE subscription_id=? AND status='pending'",
              )
              .get(subscription.id) as { at: number | null };
            return row.at === null ? 0 : Math.max(0, this.now() - row.at);
          })(),
        };
      },
    );
    const messages = this.db
      .query("SELECT COUNT(*) AS n FROM messages WHERE workspace=?")
      .get(workspace) as { n: number };
    return {
      workspace,
      subscriptions,
      consumers: this.consumers(workspace),
      messages: messages.n,
      lastSeq,
      now: this.now(),
    };
  }

  /**
   * Every workspace this install has a subscription in.
   *
   * Tenancy is normally a filter the caller supplies, but a metrics scrape and
   * an operator listing are properties of the *install*, so they need the list.
   */
  workspaces(): string[] {
    return (
      this.db
        .query(
          "SELECT DISTINCT workspace FROM subscriptions UNION SELECT DISTINCT workspace FROM messages",
        )
        .all() as { workspace: string }[]
    ).map((row) => row.workspace);
  }

  /**
   * Write a consistent copy of the database to `path`.
   *
   * `VACUUM INTO` rather than copying the file: it is SQLite's supported online
   * backup, it is consistent under WAL without stopping writes, and it needs no
   * `sqlite3` binary on the host. Copying `bus.db` alone while a WAL exists is
   * the classic way to restore a database that is missing its last few minutes.
   */
  backup(path: string): void {
    // A bound parameter, not string interpolation: `VACUUM INTO` takes an
    // expression, so the path never has to be quoted or escaped by hand.
    this.db.run("VACUUM INTO ?", [path]);
  }

  /**
   * Roll the log back to a chosen point.
   *
   * Snapshot plus "replay to here" is what point-in-time recovery means in
   * practice: restore last night's backup, then cut off just before the batch
   * that went wrong. Deliveries cascade from `messages`, so a truncated
   * message takes its unfinished deliveries with it and every subscription
   * cursor is pulled back to the new head — a cursor past the end of the log
   * would silently skip everything published afterwards.
   *
   * What this is **not**: replay from an archive of shipped log segments. The
   * log after a snapshot lives on whatever was following the leader at the
   * time, and `bql-bus follow` is how it gets there.
   */
  truncateAfter(seq: number): { removed: number; lastSeq: number } {
    this.assertWritable();
    return this.db.transaction(() => {
      // Counted before the delete: `changes` after a cascading delete includes
      // the delivery rows that went with the messages, which would report a
      // number an operator has no way to interpret.
      const removed = (
        this.db
          .query("SELECT COUNT(*) AS n FROM messages WHERE seq > ?")
          .get(seq) as { n: number }
      ).n;
      this.db.run("DELETE FROM messages WHERE seq > ?", [seq]);
      this.db.run(
        "UPDATE subscriptions SET cursor_seq=?, updated_at=? WHERE cursor_seq > ?",
        [seq, this.now(), seq],
      );
      this.db.run("UPDATE cluster SET applied_seq=? WHERE applied_seq > ?", [
        seq,
        seq,
      ]);
      return { removed, lastSeq: this.lastSeq() };
    })();
  }

  /** The highest sequence number published at or before `at`. 0 if none. */
  seqAt(at: number): number {
    const row = this.db
      .query("SELECT MAX(seq) AS seq FROM messages WHERE published_at <= ?")
      .get(at) as { seq: number | null };
    return row.seq ?? 0;
  }

  /**
   * Delete blobs no message references any more.
   *
   * Kept off `sweep` because it is the one part that touches a filesystem, and
   * the sweep runs every second on the same thread as every claim. A dead
   * letter shares its original's handle, so "no message references it" is the
   * only safe test — reference counting a two-row relationship is not worth a
   * table.
   */
  async collectBlobs(): Promise<number> {
    if (!this.blobs) return 0;
    const orphans = this.db
      .query(
        `SELECT handle FROM blobs
          WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.body_blob = blobs.handle)`,
      )
      .all() as { handle: string }[];
    for (const { handle } of orphans) {
      await this.blobs.delete(handle);
      this.db.run("DELETE FROM blobs WHERE handle = ?", [handle]);
    }
    return orphans.length;
  }

  /**
   * The reverse pass: a committed message whose blob is gone.
   *
   * `collectBlobs` finds files no message references. Nothing found the other
   * direction, so a message pointing at a missing file failed every claim of it
   * forever — a subscription stalled behind one unreadable body with no
   * indication of why. Run at startup, where a crash between the blob write and
   * the row commit would have shown up.
   *
   * A message with no delivery yet is left alone: the claim path dead-letters
   * it when it gets there, and marking the log would be rewriting history for a
   * message nobody has asked for.
   */
  async reconcileBlobs(): Promise<{ missing: number; deadLettered: number }> {
    if (!this.blobs) return { missing: 0, deadLettered: 0 };
    const referenced = this.db
      .query(
        "SELECT DISTINCT body_blob AS handle FROM messages WHERE body_blob IS NOT NULL",
      )
      .all() as { handle: string }[];
    let missing = 0;
    let deadLettered = 0;
    for (const { handle } of referenced) {
      if (await this.blobs.has(handle)) continue;
      missing++;
      const rows = this.db
        .query(
          `SELECT d.* FROM deliveries d
             JOIN messages m ON m.seq = d.message_seq
            WHERE m.body_blob = ? AND d.status IN ('pending','leased')`,
        )
        .all(handle) as DeliveryRow[];
      for (const row of rows) {
        const subscription = this.db
          .query("SELECT * FROM subscriptions WHERE id=?")
          .get(row.subscription_id) as SubscriptionRow;
        this.db.transaction(() =>
          this.deadLetter(
            row,
            subscription,
            `blob '${handle}' is missing from the blob store`,
            { dropBody: true },
          ),
        )();
        deadLettered++;
      }
    }
    this.metrics.gauge("bql-bus.blobs.missing", missing);
    return { missing, deadLettered };
  }

  // ------------------------------------------------------- schema registry

  /**
   * Register a new version of a schema.
   *
   * Two refusals, both loud on purpose. An unsupported keyword is rejected
   * here rather than ignored at validation time, so a constraint can never
   * silently not be enforced. And a version that breaks the declared
   * compatibility mode is a 409 naming the pointer — a registry that records a
   * mode and never checks it is paperwork.
   */
  registerSchema(
    workspace: string,
    name: string,
    source: Json,
    compat: CompatMode,
  ): SchemaVersion {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name))
      throw new BusError("invalid schema name", 400);
    try {
      compile(source);
    } catch (error) {
      if (error instanceof SchemaError)
        throw new BusError(
          `${error.message}${error.pointer ? ` at ${error.pointer}` : ""}`,
          400,
        );
      throw error;
    }
    return this.db.transaction(() => {
      const latest = this.latestSchema(workspace, name);
      if (latest) {
        const changes = breaking(compare(latest.source, source), compat);
        if (changes.length > 0)
          throw new BusError(
            `this version breaks '${compat}' compatibility with version ${latest.version}: ${changes
              .slice(0, 5)
              .map((change) => `${change.pointer || "/"} ${change.detail}`)
              .join("; ")}`,
            409,
          );
      }
      const text = JSON.stringify(source);
      const version = (latest?.version ?? 0) + 1;
      const hash = sha256Hex(text);
      this.db.run(
        `INSERT INTO schemas (workspace, name, version, source, hash, compat, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [workspace, name, version, text, hash, compat, this.now()],
      );
      this.metrics.counter("bql-bus.schemas.registered", 1, { workspace });
      return { workspace, name, version, source, hash, compat, createdAt: this.now() };
    })();
  }

  /** A dry run of `registerSchema`: what would change, and what would break. */
  checkSchema(
    workspace: string,
    name: string,
    source: Json,
    compat: CompatMode,
  ): { changes: CompatChange[]; breaking: CompatChange[]; against: number | null } {
    compile(source);
    const latest = this.latestSchema(workspace, name);
    if (!latest) return { changes: [], breaking: [], against: null };
    const changes = compare(latest.source, source);
    return { changes, breaking: breaking(changes, compat), against: latest.version };
  }

  latestSchema(workspace: string, name: string): SchemaVersion | null {
    const row = this.db
      .query(
        "SELECT * FROM schemas WHERE workspace=? AND name=? ORDER BY version DESC LIMIT 1",
      )
      .get(workspace, name) as SchemaRow | null;
    return row ? toSchemaVersion(row) : null;
  }

  schemaVersions(workspace: string, name?: string): SchemaVersion[] {
    const rows = (
      name === undefined
        ? this.db
            .query("SELECT * FROM schemas WHERE workspace=? ORDER BY name, version")
            .all(workspace)
        : this.db
            .query(
              "SELECT * FROM schemas WHERE workspace=? AND name=? ORDER BY version",
            )
            .all(workspace, name)
    ) as SchemaRow[];
    return rows.map(toSchemaVersion);
  }

  /** Bind a subject pattern to a schema. One binding per pattern. */
  bindSchema(
    workspace: string,
    pattern: string,
    name: string,
    mode: SchemaMode,
  ): SchemaBinding {
    assertPattern(pattern);
    if (!this.latestSchema(workspace, name))
      throw new BusError(`no schema '${name}' is registered`, 404);
    this.db.run(
      `INSERT INTO schema_bindings (workspace, subject_pattern, schema_name, mode, created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(workspace, subject_pattern) DO UPDATE SET
         schema_name=excluded.schema_name, mode=excluded.mode`,
      [workspace, pattern, name, mode, this.now()],
    );
    this.bindingGeneration++;
    return { workspace, pattern, schema: name, mode };
  }

  unbindSchema(workspace: string, pattern: string): { removed: number } {
    const result = this.db.run(
      "DELETE FROM schema_bindings WHERE workspace=? AND subject_pattern=?",
      [workspace, pattern],
    );
    this.bindingGeneration++;
    return { removed: result.changes };
  }

  schemaBindings(workspace: string): SchemaBinding[] {
    return (
      this.db
        .query(
          "SELECT * FROM schema_bindings WHERE workspace=? ORDER BY subject_pattern",
        )
        .all(workspace) as {
        workspace: string;
        subject_pattern: string;
        schema_name: string;
        mode: string;
      }[]
    ).map((row) => ({
      workspace: row.workspace,
      pattern: row.subject_pattern,
      schema: row.schema_name,
      mode: row.mode as SchemaMode,
    }));
  }

  /**
   * The binding that governs a subject, if any.
   *
   * Cached per workspace and invalidated by a counter rather than a TTL: a
   * binding change has to take effect on the next publish, and a stale cache
   * here means a message is validated against a schema nobody is using any
   * more.
   */
  private bindingFor(workspace: string, subject: string): SchemaBinding | null {
    if (this.bindingCache?.generation !== this.bindingGeneration)
      this.bindingCache = { generation: this.bindingGeneration, byWorkspace: new Map() };
    let list = this.bindingCache.byWorkspace.get(workspace);
    if (list === undefined) {
      list = this.schemaBindings(workspace);
      this.bindingCache.byWorkspace.set(workspace, list);
    }
    // Longest literal prefix wins, so `orders.eu.>` beats `orders.>` rather
    // than whichever the index happened to return first.
    let best: SchemaBinding | null = null;
    let bestScore = -1;
    for (const binding of list) {
      if (!matches(binding.pattern, subject)) continue;
      const score = binding.pattern.split(".").filter((token) => token !== "*" && token !== ">").length;
      if (score > bestScore) {
        best = binding;
        bestScore = score;
      }
    }
    return best;
  }

  /** Has this workspace any binding at all? Skips the delivery-time check. */
  private hasBindings(workspace: string): boolean {
    if (this.bindingCache?.generation !== this.bindingGeneration)
      this.bindingCache = { generation: this.bindingGeneration, byWorkspace: new Map() };
    let list = this.bindingCache.byWorkspace.get(workspace);
    if (list === undefined) {
      list = this.schemaBindings(workspace);
      this.bindingCache.byWorkspace.set(workspace, list);
    }
    return list.length > 0;
  }

  private validatorFor(row: SchemaVersion): Validator {
    const cached = this.validators.get(row.hash);
    if (cached) return cached;
    const compiled = compile(row.source);
    this.validators.set(row.hash, compiled);
    return compiled;
  }

  /**
   * Validate a body against whatever schema governs its subject.
   *
   * `null` when nothing is bound — the overwhelmingly common case, and one
   * cheap map lookup.
   */
  validateAgainstSchema(
    workspace: string,
    subject: string,
    body: Json,
  ): {
    mode: SchemaMode;
    schema: string;
    version: number;
    violations: Violation[];
  } | null {
    const binding = this.bindingFor(workspace, subject);
    if (!binding || binding.mode === "off") return null;
    const latest = this.latestSchema(workspace, binding.schema);
    if (!latest) return null;
    return {
      mode: binding.mode,
      schema: latest.name,
      version: latest.version,
      violations: this.validatorFor(latest)(body),
    };
  }

  // ------------------------------------------------------------ schedules

  private scheduleRow(workspace: string, name: string): ScheduleRow {
    const row = this.db
      .query("SELECT * FROM schedules WHERE workspace=? AND name=?")
      .get(workspace, name) as ScheduleRow | null;
    if (!row) throw new BusError(`no such schedule '${name}'`, 404);
    return row;
  }

  /** `nextFire`, with a bad expression or zone as a 400 rather than a 500. */
  private nextFireOf(cron: string, tz: string, afterMs: number): number {
    try {
      return nextFire(cron, tz, afterMs);
    } catch (error) {
      if (error instanceof CronError) throw new BusError(error.message, 400);
      throw error;
    }
  }

  /**
   * Create or replace a schedule.
   *
   * Changing the expression or zone recomputes the next fire from now;
   * rewriting only the payload keeps it, so an edit does not skip a fire that
   * was about to happen.
   */
  upsertSchedule(workspace: string, request: ScheduleRequest): Schedule {
    this.assertWritable();
    if (!SCHEDULE_NAME.test(request.name))
      throw new BusError(`invalid schedule name '${request.name}'`, 400);
    const tz = request.tz ?? "UTC";
    try {
      parseCron(request.cron);
      assertTimeZone(tz);
    } catch (error) {
      if (error instanceof CronError) throw new BusError(error.message, 400);
      throw error;
    }
    assertSubject(request.subject);
    const catchUp = request.catchUp ?? "latest";
    if (catchUp !== "latest" && catchUp !== "none")
      throw new BusError("catchUp must be latest or none", 400);
    const body = JSON.stringify(request.body ?? null);
    if (body.length > this.inlineMaxBytes)
      throw new BusError(
        `a schedule body is stored inline and may be at most ${this.inlineMaxBytes} bytes`,
        413,
      );
    const now = this.now();
    const paused = request.paused === true;
    // Validates that the expression can fire at all, before anything is written.
    const computed = this.nextFireOf(request.cron, tz, now);
    this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM schedules WHERE workspace=? AND name=?")
        .get(workspace, request.name) as ScheduleRow | null;
      const keep =
        existing &&
        !paused &&
        existing.paused === 0 &&
        existing.cron === request.cron.trim() &&
        existing.tz === tz;
      this.db.run(
        `INSERT INTO schedules (workspace, name, cron, tz, subject, body, headers, next_at, last_at, catch_up, paused, last_error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
         ON CONFLICT(workspace, name) DO UPDATE SET
           cron=excluded.cron, tz=excluded.tz, subject=excluded.subject,
           body=excluded.body, headers=excluded.headers, next_at=excluded.next_at,
           catch_up=excluded.catch_up, paused=excluded.paused,
           retry_at=NULL, failures=0, updated_at=excluded.updated_at`,
        [
          workspace,
          request.name,
          request.cron.trim(),
          tz,
          request.subject,
          body,
          JSON.stringify(request.headers ?? {}),
          paused ? null : keep ? existing.next_at : computed,
          existing?.last_at ?? null,
          catchUp,
          paused ? 1 : 0,
          existing?.created_at ?? now,
          now,
        ],
      );
    })();
    return this.schedule(workspace, request.name);
  }

  schedule(workspace: string, name: string): Schedule {
    return toSchedule(this.scheduleRow(workspace, name));
  }

  schedules(workspace: string): Schedule[] {
    return (
      this.db
        .query("SELECT * FROM schedules WHERE workspace=? ORDER BY name")
        .all(workspace) as ScheduleRow[]
    ).map(toSchedule);
  }

  deleteSchedule(workspace: string, name: string): { deleted: string } {
    this.assertWritable();
    this.scheduleRow(workspace, name);
    this.db.run("DELETE FROM schedules WHERE workspace=? AND name=?", [
      workspace,
      name,
    ]);
    return { deleted: name };
  }

  /**
   * Pause or resume.
   *
   * Resuming computes the next fire from now: the fires a pause skipped were
   * skipped on purpose, so they are not caught up.
   */
  pauseSchedule(workspace: string, name: string, paused: boolean): Schedule {
    this.assertWritable();
    const row = this.scheduleRow(workspace, name);
    const now = this.now();
    this.db.run(
      "UPDATE schedules SET paused=?, next_at=?, retry_at=NULL, failures=0, updated_at=? WHERE workspace=? AND name=?",
      [
        paused ? 1 : 0,
        paused ? null : this.nextFireOf(row.cron, row.tz, now),
        now,
        workspace,
        name,
      ],
    );
    return this.schedule(workspace, name);
  }

  /** Headers every fire carries, on top of the schedule's own. */
  private scheduleHeaders(row: ScheduleRow, fireAt: number): Headers {
    return {
      ...parse<Headers>(row.headers, {}),
      "schedule-name": row.name,
      "schedule-at": new Date(fireAt).toISOString(),
    };
  }

  /**
   * Fire a schedule now, outside its cadence.
   *
   * Not deduplicated and does not move `nextAt`: "run it now" is a manual
   * action, and it should neither swallow nor be swallowed by the next
   * scheduled fire.
   */
  async runSchedule(workspace: string, name: string): Promise<PublishResult> {
    const row = this.scheduleRow(workspace, name);
    return this.publish(workspace, {
      subject: row.subject,
      body: JSON.parse(row.body) as Json,
      headers: { ...this.scheduleHeaders(row, this.now()), "schedule-manual": "true" },
    });
  }

  /**
   * The most recent fire at or before `now`, for `catchUp: "latest"`.
   *
   * Widening windows rather than stepping from `next_at`: a minutely schedule
   * back from a week of downtime would otherwise walk ten thousand fires to
   * find the one it keeps.
   */
  private latestFire(row: ScheduleRow, now: number): number {
    const from = row.next_at!;
    for (const span of [3_600_000, 86_400_000, 31 * 86_400_000, 366 * 86_400_000, Infinity]) {
      let fire = nextFire(row.cron, row.tz, Math.max(from - 1, now - span));
      if (fire > now) continue;
      for (;;) {
        const next = nextFire(row.cron, row.tz, fire);
        if (next > now) return fire;
        fire = next;
      }
    }
    return from;
  }

  /**
   * Publish every schedule that is due. Runs from the sweep.
   *
   * On the leader only: a follower is read-only, and so is a leader that has
   * been fenced out. Each fire is a publish whose dedupe key is the schedule
   * and its scheduled instant, committed in one transaction with the move to
   * the next fire — so a double sweep finds nothing due, and a promoted
   * follower whose schedule row lags the log it replicated re-derives the same
   * key and gets the existing message back rather than a second one.
   */
  fireSchedules(): Promise<number> {
    this.firing ??= this.fireDue().finally(() => {
      this.firing = null;
    });
    return this.firing;
  }

  private async fireDue(): Promise<number> {
    if (this.readOnly || this.cluster().role !== "leader") return 0;
    const now = this.now();
    let fired = 0;
    // Batches until nothing is due. Every row a batch touches leaves the due
    // set — its `next_at` moves past now, or a failure parks it behind
    // `retry_at` — so a hundred failing schedules cannot hold a healthy one
    // behind them by always sorting first. The batch count is a backstop.
    for (let batch = 0; batch < 1000; batch++) {
      const due = this.db
        .query(
          `SELECT * FROM schedules
            WHERE paused = 0 AND next_at IS NOT NULL AND next_at <= ?1
              AND (retry_at IS NULL OR retry_at <= ?1)
            ORDER BY next_at LIMIT 100`,
        )
        .all(now) as ScheduleRow[];
      if (due.length === 0) break;
      fired += await this.fireBatch(due, now);
    }
    return fired;
  }

  private async fireBatch(due: ScheduleRow[], now: number): Promise<number> {
    let fired = 0;
    for (const row of due) {
      const labels = { workspace: row.workspace };
      let fireAt: number | null;
      let next: number;
      try {
        fireAt =
          row.catch_up === "none"
            ? now - row.next_at! <= ON_TIME_MS
              ? row.next_at!
              : null
            : this.latestFire(row, now);
        next = nextFire(row.cron, row.tz, now);
      } catch (error) {
        // An expression that stopped being able to fire: park it with the
        // reason rather than re-reading it every second.
        this.db.run(
          "UPDATE schedules SET next_at=NULL, retry_at=NULL, last_error=? WHERE workspace=? AND name=?",
          [String(error instanceof Error ? error.message : error), row.workspace, row.name],
        );
        continue;
      }
      if (fireAt === null) {
        this.metrics.counter("bql-bus.schedules.skipped", 1, labels);
        this.db.run(
          "UPDATE schedules SET next_at=?, retry_at=NULL, failures=0 WHERE workspace=? AND name=? AND next_at=?",
          [next, row.workspace, row.name, row.next_at],
        );
        continue;
      }
      try {
        const prepared = await this.prepare(row.workspace, {
          subject: row.subject,
          body: JSON.parse(row.body) as Json,
          headers: this.scheduleHeaders(row, fireAt),
          dedupeKey: `schedule:${row.name}:${fireAt}`,
        });
        const published = this.db.transaction(() => {
          // The row may have been paused, edited or deleted while the body was
          // being written; only the version that was read gets fired.
          const moved = this.db.run(
            `UPDATE schedules SET next_at=?, last_at=?, last_error=NULL, retry_at=NULL, failures=0
              WHERE workspace=? AND name=? AND paused=0 AND next_at=?`,
            [next, fireAt, row.workspace, row.name, row.next_at],
          );
          if (moved.changes === 0) return null;
          return this.insert(row.workspace, prepared, null);
        })();
        if (published && !published.duplicate) {
          fired++;
          this.metrics.counter("bql-bus.schedules.fired", 1, labels);
        }
      } catch (error) {
        // Quota, disk, an enforced schema: the fire stays due, is retried
        // with backoff, and the reason is on the schedule where an operator
        // will look for it.
        this.metrics.counter("bql-bus.schedules.failed", 1, labels);
        this.db.run(
          "UPDATE schedules SET last_error=?, failures=failures+1, retry_at=? WHERE workspace=? AND name=?",
          [
            String(error instanceof Error ? error.message : error).slice(0, 500),
            now + retryDelayMs(row.failures + 1),
            row.workspace,
            row.name,
          ],
        );
      }
    }
    return fired;
  }

  /**
   * Mirror the upstream's schedules for one workspace.
   *
   * Replicated like cursors: the row, not the fires. A promoted follower fires
   * from the `next_at` it last saw, and the dedupe key makes any fire the old
   * leader already published a no-op.
   */
  applySchedules(workspace: string, schedules: Schedule[]): void {
    // The follower calls this every poll; an unchanged list is the common
    // case and should not cost a write transaction.
    if (JSON.stringify(this.schedules(workspace)) === JSON.stringify(schedules))
      return;
    this.db.transaction(() => {
      const names = new Set(schedules.map((schedule) => schedule.name));
      for (const { name } of this.db
        .query("SELECT name FROM schedules WHERE workspace=?")
        .all(workspace) as { name: string }[])
        if (!names.has(name))
          this.db.run("DELETE FROM schedules WHERE workspace=? AND name=?", [
            workspace,
            name,
          ]);
      for (const schedule of schedules)
        this.db.run(
          `INSERT OR REPLACE INTO schedules (workspace, name, cron, tz, subject, body, headers, next_at, last_at, catch_up, paused, last_error, retry_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            workspace,
            schedule.name,
            schedule.cron,
            schedule.tz,
            schedule.subject,
            JSON.stringify(schedule.body ?? null),
            JSON.stringify(schedule.headers ?? {}),
            schedule.nextAt,
            schedule.lastAt,
            schedule.catchUp,
            schedule.paused ? 1 : 0,
            schedule.lastError,
            schedule.retryAt ?? null,
            schedule.createdAt,
            schedule.updatedAt,
          ],
        );
    })();
  }

  // ------------------------------------------------------------ cluster

  cluster(): ClusterState {
    const row = this.db.query("SELECT * FROM cluster WHERE id=1").get() as {
      epoch: number;
      role: string;
      upstream: string | null;
      applied_seq: number;
    } | null;
    return {
      epoch: row?.epoch ?? 0,
      role: (row?.role as "leader" | "follower") ?? "leader",
      upstream: row?.upstream ?? null,
      appliedSeq: row?.applied_seq ?? 0,
      readOnly: this.readOnly,
    };
  }

  /**
   * Take the leader role at a given epoch.
   *
   * The epoch comes from a lease acquired in shared storage, not from here:
   * this only records what was won. Split brain is prevented by the fence, not
   * by hoping the old leader is dead.
   */
  promote(epoch: number): ClusterState {
    const current = this.cluster();
    if (epoch <= current.epoch)
      throw new BusError(
        `epoch ${epoch} does not advance past ${current.epoch}`,
        409,
      );
    this.db.run(
      "UPDATE cluster SET epoch=?, role='leader', upstream=NULL, updated_at=? WHERE id=1",
      [epoch, this.now()],
    );
    this.readOnly = false;
    return this.cluster();
  }

  /** Become a follower of `upstream`. Writes from clients are refused. */
  demote(upstream: string): ClusterState {
    this.db.run(
      "UPDATE cluster SET role='follower', upstream=?, updated_at=? WHERE id=1",
      [upstream, this.now()],
    );
    this.readOnly = true;
    return this.cluster();
  }

  /**
   * Stop accepting writes.
   *
   * Set when a follower is serving reads, and when a leader discovers the
   * shared lease has moved past its epoch — the old leader refusing to write
   * is the second half of the fence, and without it the first half is a
   * suggestion.
   */
  setReadOnly(readOnly: boolean, reason = "read-only"): void {
    this.readOnly = readOnly;
    this.readOnlyReason = reason;
  }

  private assertWritable(): void {
    if (!this.readOnly) return;
    throw new BusError(
      `this bus is not accepting writes: ${this.readOnlyReason}`,
      409,
    );
  }

  /**
   * Apply messages shipped from an upstream, keeping their sequence numbers.
   *
   * The **bus log** is what is replicated, not the SQLite WAL. The bus already
   * is a log with a monotonic `seq`, so a follower rebuilds by reading it —
   * which survives schema changes, needs no frame parsing, and is a hundred
   * lines rather than a project. Delivery and lease rows are deliberately not
   * replicated: leases are ephemeral, and a promoted follower re-materializes
   * deliveries from cursors through the same code path a cold start uses.
   */
  async applyReplicated(messages: Message[]): Promise<number> {
    let applied = this.cluster().appliedSeq;
    for (const message of messages) {
      const { inline, blob, sha256, bytes } = await this.writeBody(message.body);
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO messages (seq, id, workspace, subject, key, headers, body, body_blob, published_at, expires_at, dedupe_key, publisher, body_sha256, body_bytes, priority, available_at, cancelled_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(seq) DO NOTHING`,
          [
            message.seq,
            message.id,
            message.workspace,
            message.subject,
            message.key,
            JSON.stringify(message.headers),
            inline,
            blob,
            message.publishedAt,
            message.expiresAt,
            message.dedupeKey,
            message.publisher,
            sha256,
            bytes,
            message.priority,
            message.availableAt,
            message.cancelledAt,
          ],
        );
      })();
      applied = Math.max(applied, message.seq);
    }
    this.db.run("UPDATE cluster SET applied_seq=?, updated_at=? WHERE id=1", [
      applied,
      this.now(),
    ]);
    return applied;
  }

  /**
   * Mirror the upstream's subscriptions and cursors.
   *
   * The cursor is the only piece of consumer state a follower needs: given the
   * log and the cursors, every delivery can be recreated. Copying leases would
   * replicate the one thing that is meaningless on another machine.
   */
  applyCursors(subscriptions: Subscription[]): void {
    this.db.transaction(() => {
      for (const subscription of subscriptions) {
        const existing = this.db
          .query("SELECT id FROM subscriptions WHERE workspace=? AND name=?")
          .get(subscription.workspace, subscription.name) as { id: string } | null;
        if (existing) {
          this.db.run(
            `UPDATE subscriptions SET cursor_seq=?, ack_wait_ms=?, max_attempts=?, ordered=?,
               dlq_subject=?, paused=?, updated_at=? WHERE id=?`,
            [
              subscription.cursorSeq,
              subscription.ackWaitMs,
              subscription.maxAttempts,
              subscription.ordered ? 1 : 0,
              subscription.dlqSubject,
              subscription.paused ? 1 : 0,
              this.now(),
              existing.id,
            ],
          );
          continue;
        }
        this.db.run(
          `INSERT INTO subscriptions (id, workspace, name, pattern, cursor_seq, ack_wait_ms, max_attempts, ordered, dlq_subject, paused, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            subscription.id,
            subscription.workspace,
            subscription.name,
            subscription.pattern,
            subscription.cursorSeq,
            subscription.ackWaitMs,
            subscription.maxAttempts,
            subscription.ordered ? 1 : 0,
            subscription.dlqSubject,
            subscription.paused ? 1 : 0,
            subscription.createdAt,
            subscription.updatedAt,
          ],
        );
      }
    })();
  }

  // -------------------------------------------------- tenancy and audit

  /**
   * Record an operator action.
   *
   * Append-only, and there is no method that rewrites or removes a row: an
   * audit log that the audited party can edit is a log of what they wanted you
   * to see.
   */
  audit(entry: {
    workspace: string;
    actor: string;
    scope: string;
    action: string;
    target?: string | null;
  }): void {
    this.db.run(
      "INSERT INTO audit (workspace, actor, scope, action, target, at) VALUES (?,?,?,?,?,?)",
      [
        entry.workspace,
        entry.actor,
        entry.scope,
        entry.action,
        entry.target ?? null,
        this.now(),
      ],
    );
  }

  auditLog(workspace: string, limit = 100): AuditEntry[] {
    return (
      this.db
        .query(
          "SELECT * FROM audit WHERE workspace=? ORDER BY id DESC LIMIT ?",
        )
        .all(workspace, Math.min(1000, limit)) as {
        id: number;
        workspace: string;
        actor: string;
        scope: string;
        action: string;
        target: string | null;
        at: number;
      }[]
    ).map((row) => ({
      id: row.id,
      workspace: row.workspace,
      actor: row.actor,
      scope: row.scope,
      action: row.action,
      target: row.target,
      at: row.at,
    }));
  }

  /**
   * Revoke a token by its `jti`.
   *
   * `notAfter` is the token's own expiry: once it has passed, the row is dead
   * weight and the sweep drops it. A revocation list that only grows is a
   * revocation list nobody keeps.
   */
  revoke(jti: string, notAfter: number): void {
    this.db.run(
      "INSERT INTO revocations (jti, not_after, revoked_at) VALUES (?,?,?) ON CONFLICT(jti) DO NOTHING",
      [jti, notAfter, this.now()],
    );
    this.revoked = null;
  }

  /** Every live revocation, cached in memory — the check is on the hot path. */
  isRevoked(jti: string): boolean {
    if (this.revoked === null)
      this.revoked = new Set(
        (
          this.db
            .query("SELECT jti FROM revocations WHERE not_after = 0 OR not_after > ?")
            .all(this.now()) as { jti: string }[]
        ).map((row) => row.jti),
      );
    return this.revoked.has(jti);
  }

  revocations(): { jti: string; notAfter: number; revokedAt: number }[] {
    return (
      this.db.query("SELECT * FROM revocations ORDER BY revoked_at DESC").all() as {
        jti: string;
        not_after: number;
        revoked_at: number;
      }[]
    ).map((row) => ({
      jti: row.jti,
      notAfter: row.not_after,
      revokedAt: row.revoked_at,
    }));
  }

  setQuota(workspace: string, quota: Partial<Quota>): Quota {
    const current = this.quota(workspace);
    const next: Quota = { ...current, ...quota };
    this.db.run(
      `INSERT INTO quotas (workspace, max_messages, max_bytes, max_subscriptions, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(workspace) DO UPDATE SET
         max_messages=excluded.max_messages,
         max_bytes=excluded.max_bytes,
         max_subscriptions=excluded.max_subscriptions,
         updated_at=excluded.updated_at`,
      [
        workspace,
        next.maxMessages,
        next.maxBytes,
        next.maxSubscriptions,
        this.now(),
      ],
    );
    this.quotaCache.delete(workspace);
    return next;
  }

  quota(workspace: string): Quota {
    const cached = this.quotaCache.get(workspace);
    if (cached) return cached;
    const row = this.db
      .query("SELECT * FROM quotas WHERE workspace=?")
      .get(workspace) as
      | {
          max_messages: number;
          max_bytes: number;
          max_subscriptions: number;
        }
      | null;
    const quota: Quota = {
      maxMessages: row?.max_messages ?? 0,
      maxBytes: row?.max_bytes ?? 0,
      maxSubscriptions: row?.max_subscriptions ?? 0,
    };
    this.quotaCache.set(workspace, quota);
    return quota;
  }

  /** What a workspace is actually using, for the quota check and for gauges. */
  usage(workspace: string): { messages: number; bytes: number; subscriptions: number } {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS messages, COALESCE(SUM(body_bytes),0) AS bytes FROM messages WHERE workspace=?",
      )
      .get(workspace) as { messages: number; bytes: number };
    const subscriptions = (
      this.db
        .query("SELECT COUNT(*) AS n FROM subscriptions WHERE workspace=?")
        .get(workspace) as { n: number }
    ).n;
    return {
      messages: row.messages,
      bytes: Number(row.bytes),
      subscriptions,
    };
  }

  /**
   * Refuse a publish that would put a workspace over its quota.
   *
   * Checked against usage read fresh rather than a counter: a counter and a
   * retention sweep disagree the moment anything is deleted, and a quota that
   * drifts upward is not a quota.
   */
  assertWithinQuota(workspace: string, incomingBytes: number): void {
    const quota = this.quota(workspace);
    if (quota.maxMessages === 0 && quota.maxBytes === 0) return;
    const used = this.usage(workspace);
    if (quota.maxMessages > 0 && used.messages >= quota.maxMessages)
      throw new BusError(
        `workspace '${workspace}' is at its message quota (${quota.maxMessages})`,
        429,
      );
    if (quota.maxBytes > 0 && used.bytes + incomingBytes > quota.maxBytes)
      throw new BusError(
        `workspace '${workspace}' is at its byte quota (${quota.maxBytes})`,
        429,
      );
  }

  // ------------------------------------------------------------- capacity

  /** Bytes of the database file, its WAL, and free space on the filesystem. */
  sizes(): { dbBytes: number; walBytes: number; freeBytes: number } {
    const size = (path: string) => {
      try {
        return Bun.file(path).size;
      } catch {
        return 0;
      }
    };
    return {
      dbBytes: this.path === ":memory:" ? 0 : size(this.path),
      walBytes: this.path === ":memory:" ? 0 : size(`${this.path}-wal`),
      freeBytes: this.freeBytes(0),
    };
  }

  /** Free bytes on the database's filesystem, cached for `maxAgeMs`. */
  private freeBytes(maxAgeMs = 1000): number {
    if (this.path === ":memory:") return Number.MAX_SAFE_INTEGER;
    const now = this.now();
    if (this.freeSpace && now - this.freeSpace.at < maxAgeMs)
      return this.freeSpace.bytes;
    let bytes = Number.MAX_SAFE_INTEGER;
    try {
      const stats = statfsSync(this.path);
      bytes = Number(stats.bsize) * Number(stats.bavail);
    } catch {
      // A filesystem that will not answer is not evidence of a full one.
    }
    this.freeSpace = { bytes, at: now };
    return bytes;
  }

  /**
   * Whether there is room to accept a write.
   *
   * Refusing loudly beats `SQLITE_FULL`, which arrives as a 500 from whichever
   * statement happened to need a page — and leaves the bus still accepting
   * publishes it cannot keep. Claims, acks and nacks deliberately do not
   * consult this: a full disk is exactly when consumers need to drain.
   */
  capacity(): { ok: boolean; freeBytes: number; minFreeBytes: number } {
    const freeBytes = this.freeBytes();
    return {
      ok: freeBytes >= this.minFreeBytes,
      freeBytes,
      minFreeBytes: this.minFreeBytes,
    };
  }

  /**
   * Truncate the WAL once it grows past the configured ceiling.
   *
   * `TRUNCATE` rather than `PASSIVE` because the point is to give the space
   * back, and best-effort because a long-lived reader will block it — that
   * reader is the whole reason the file grew, and blocking *it* to reclaim
   * space would trade a disk problem for a correctness-shaped one.
   */
  private checkpoint(): void {
    if (this.walCheckpointBytes <= 0 || this.path === ":memory:") return;
    if (this.sizes().walBytes < this.walCheckpointBytes) return;
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
  }

  /**
   * Expire leases, drop expired messages, prune history.
   *
   * Both deletions are guarded by the same predicate, for the same reason:
   * `deliveries` cascades from `messages`, so removing a message removes any
   * unfinished delivery of it. A cursor being past a message means it was
   * *examined*, not that anyone finished it — so "every subscription has moved
   * past it" is not enough on its own.
   */
  sweep() {
    this.reclaim();
    const now = this.now();
    const notLeased = `NOT EXISTS (
      SELECT 1 FROM deliveries d
       WHERE d.message_seq = messages.seq AND d.status = 'leased')`;
    const unfinished = `NOT EXISTS (
      SELECT 1 FROM deliveries d
       WHERE d.message_seq = messages.seq AND d.status IN ('pending','leased'))`;

    // TTL and retention guard differently, because they mean different things.
    // A TTL says the message stopped being relevant, so an undelivered copy of
    // it should go — guarding that on `pending` would mean a message nobody
    // ever consumed outlived its own expiry indefinitely. What it must not do
    // is take a message away from a handler already running: that leaves the
    // consumer acking a delivery that no longer exists.
    this.db.run(
      `DELETE FROM messages
        WHERE expires_at IS NOT NULL AND expires_at <= ? AND ${notLeased}`,
      [now],
    );
    if (this.retentionMs > 0)
      this.db.run(
        `DELETE FROM messages
          WHERE published_at < ?
            AND seq <= COALESCE((SELECT MIN(cursor_seq) FROM subscriptions), 0)
            AND ${unfinished}`,
        [now - this.retentionMs],
      );
    this.db.run("DELETE FROM revocations WHERE not_after > 0 AND not_after <= ?", [
      now,
    ]);
    this.revoked = null;
    this.checkpoint();
    // Async because a fire is a publish; the sweep's timer does not wait on
    // it, and a pass still running when the next tick lands is shared.
    void this.fireSchedules().catch(() => {});
  }
}
