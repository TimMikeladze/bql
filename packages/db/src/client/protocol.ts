// Invariant: this module is the only description of the BunQL wire format, and it carries no
// behaviour beyond frozen name tables. Client and server both import it, so a field cannot be
// renamed on one side without breaking the other at type-check time.
//
// Value encoding (design §6.1): ordinary rows are plain JSON. Only values JSON cannot carry
// faithfully are tagged — integers outside the double-safe range, blobs, and non-finite doubles.

/** An integer that does not survive a JSON `number`, as its decimal text. */
export interface IntValue {
  $i: string
}

/** A BLOB, base64 (standard alphabet, padded). */
export interface BlobValue {
  $b: string
}

/** A double JSON cannot represent. */
export interface FloatValue {
  $f: "inf" | "-inf" | "nan"
}

/** One SQLite value on the wire. */
export type Value = null | number | string | boolean | IntValue | BlobValue | FloatValue

/** Positional parameters, or named ones (`:id`, `@id`, `$id`, or the bare name). */
export type Args = readonly Value[] | Readonly<Record<string, Value>>

/** Rows as arrays in column order (default, compact) or as objects keyed by column name. */
export type RowsMode = "array" | "object"

export type ArrayRow = Value[]
export type ObjectRow = Record<string, Value>
export type ResultRows = ArrayRow[] | ObjectRow[]

/** Durability required before a write is answered (design §5.4). */
export type Ack = "local" | "fsync" | "replica" | "quorum"

/**
 * `"primary"` forces the primary, `"any"` accepts any replica state, `"ryw"` (client default)
 * sends the last txid the client saw as `minTxid`.
 */
export type Consistency = "primary" | "any" | "ryw"

export type TxMode = "deferred" | "immediate" | "exclusive"

/** Options every statement-bearing request accepts, as body fields or headers (design §6). */
export interface RequestOptions {
  ack?: Ack
  /** Refuse to serve from a replica that has not reached this txid. */
  minTxid?: number
  consistency?: Consistency
  timeoutMs?: number
  rows?: RowsMode
  /** Cap on rows in the response; more than this fails the request. */
  maxRows?: number
}

export interface StatementRequest {
  sql: string
  args?: Args
}

export interface QueryRequest extends StatementRequest, RequestOptions {}

export interface QueryResult {
  columns: string[]
  /** Declared column types, upper-cased; storage class of the first non-null value otherwise. */
  types: string[]
  rows: ResultRows
  rowsAffected: number
  lastInsertRowid: number | IntValue | null
  txid: number
  durationUs: number
  /** `sqlite3_stmt_status(SQLITE_STMTSTATUS_VM_STEP)`: the cost unit for quotas and billing. */
  vmSteps: number
}

export interface BatchRequest extends RequestOptions {
  /** One write transaction that rolls back as a whole. Default true. */
  atomic?: boolean
  statements: StatementRequest[]
}

export interface BatchResult {
  results: QueryResult[]
  txid: number
}

export interface TxBeginRequest extends RequestOptions {
  mode?: TxMode
}

export interface TxBeginResult {
  /** Baton identifying the open transaction. */
  tx: string
  expiresInMs: number
}

export interface TxResult {
  txid: number
}

export type ChangeOp = "insert" | "update" | "delete"

/**
 * How much of each row a change subscriber wants. The capture level is per database and the engine
 * runs at the highest level any subscriber asked for, so this is a floor rather than a filter.
 */
export type IncludeLevel = "none" | "pk" | "row" | "row+old"

export interface RowChange {
  table: string
  op: ChangeOp
  rowid: number | IntValue | null
  /** Primary key of the row; always present for `WITHOUT ROWID` tables. */
  pk?: ObjectRow
  /** New row, when the tenant has `changes.includeRows` on. */
  row?: ObjectRow
  /** Previous row, for updates and deletes, when row capture is on. */
  old?: ObjectRow
}

export interface ChangeEvent {
  txid: number
  /**
   * L8: which statement of the transaction this event is, from 0. Group commit folds concurrent
   * writes into one transaction, so `txid` alone does not identify an event — `(txid, seq)` does,
   * and it stays the same across a replay, which is what a durable downstream consumer dedupes on.
   *
   * A transaction that ran one statement has exactly one event, with `seq: 0`. Absent on a
   * replica's txid-only events, which have no statements to number.
   */
  seq?: number
  changes: RowChange[]
}

export type SchemaOp = "create" | "alter" | "drop"
export type SchemaObject = "table" | "index" | "view" | "trigger"

export interface SchemaChange {
  op: SchemaOp
  object: SchemaObject
  name: string
  temp?: boolean
}

export interface SchemaEvent {
  txid: number
  changes: SchemaChange[]
}

/** Full result of a live query: sent on subscribe and whenever the result changes. */
export interface LiveRowsEvent {
  txid: number
  columns: string[]
  types: string[]
  rows: ResultRows
  /** The result hit the subscription's `maxRows` and what follows was dropped. */
  truncated?: boolean
}

/** Sent instead of `rows` when the subscription named a `key` column. */
export interface LiveDiffEvent {
  txid: number
  added: ResultRows
  /** Key values of the rows that left the result. */
  removed: ResultRows
  updated: ResultRows
  /** The result hit the subscription's `maxRows`, so the diff covers only the rows kept. */
  truncated?: boolean
}

/** The change ring could not serve the requested `since`; the client must re-query. */
export interface ResetEvent {
  txid: number
  reason: string
}

export type BunQLErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "NOT_AUTHORIZED"
  | "DB_NOT_FOUND"
  | "NOT_FOUND"
  | "QUERY_TIMEOUT"
  | "TOO_MANY_ROWS"
  /** One result reached `[limits] maxResultBytes` while it was being built. */
  | "RESULT_TOO_LARGE"
  /** The database's write queue is at `[limits] maxQueuedWrites` or `maxQueuedWriteBytes`. */
  | "WRITE_QUEUE_FULL"
  /** Queued past `[limits] queueWaitMs` without reaching the writer. */
  | "WRITE_QUEUE_TIMEOUT"
  /** This principal already holds `[limits] maxPinnedPerPrincipal` databases open. */
  | "PIN_LIMIT"
  /** The node is at `[data] maxOpen` and every open database is pinned by a subscription. */
  | "TOO_MANY_OPEN"
  | "TXID_NOT_AVAILABLE"
  | "NOT_PRIMARY"
  | "RESET_REQUIRED"
  /** P9: this feed's primary does not record row changes, so it cannot deliver them. */
  | "LOGICAL_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "BUSY"
  | "INTERNAL"
  // Any `SQLITE_*` extended result code name also travels in this field.
  | (string & {})

/** One thing wrong with a request, as core's validator reports it. */
export interface ErrorProblem {
  /** Where it is, as `body.sql` or `query.limit`. Empty for the value as a whole. */
  path: string
  message: string
}

export interface ErrorInfo {
  code: BunQLErrorCode
  message: string
  status: number
  /** Last txid of the database as the failing request saw it. */
  txid?: number
  /** Index of the failing statement in a batch. */
  failedIndex?: number
  /** Where to go instead, for `NOT_PRIMARY`. */
  primary?: string
  /**
   * Seconds to wait before retrying, for a refusal that can say — `WRITE_QUEUE_FULL` derives it
   * from the database's measured drain rate. Mirrors the `Retry-After` header, and is how a
   * WebSocket client, which has no headers, receives the same hint.
   */
  retryAfterSec?: number
  /**
   * Every way the request failed the schema this route publishes, not only the first — a client
   * fixing three of them should be told about three. Present on a `BAD_REQUEST` core refused.
   */
  problems?: ErrorProblem[]
}

export interface ErrorBody {
  error: ErrorInfo
}

// ── WebSocket envelopes (design §7) ────────────────────────────────────────────────────────────
//
// One socket, many databases, pipelined. Every client message carries `id` and every reply
// echoes it; server-initiated messages carry `sub` (or an `event` with no `id`).

export const WS_PROTOCOL = "bunql.v1"

/** First message when the token cannot travel in a header, as in a browser. */
export interface WsHelloRequest {
  id?: number
  op: "hello"
  token?: string
  protocol?: string
}

export interface WsQueryRequest extends RequestOptions {
  id: number
  op: "query"
  /** Omitted when the statement runs inside `tx`. */
  db?: string
  tx?: string
  sql: string
  args?: Args
}

export interface WsBatchRequest extends RequestOptions {
  id: number
  op: "batch"
  db?: string
  tx?: string
  atomic?: boolean
  statements: StatementRequest[]
}

export interface WsTxBeginRequest {
  id: number
  op: "tx.begin"
  db: string
  mode?: TxMode
}

export interface WsTxCommitRequest {
  id: number
  op: "tx.commit"
  tx: string
}

export interface WsTxRollbackRequest {
  id: number
  op: "tx.rollback"
  tx: string
}

export interface WsChangesSubscribeRequest {
  id: number
  op: "subscribe"
  db: string
  kind: "changes"
  tables?: string[]
  since?: number
  include?: "row" | "pk"
}

export interface WsLiveSubscribeRequest extends Pick<RequestOptions, "rows" | "maxRows"> {
  id: number
  op: "subscribe"
  db: string
  kind: "live"
  sql: string
  args?: Args
  /** Column that identifies a row, which switches the feed from `rows` to `diff`. */
  key?: string
}

export type WsSubscribeRequest = WsChangesSubscribeRequest | WsLiveSubscribeRequest

export interface WsUnsubscribeRequest {
  id: number
  op: "unsubscribe"
  sub: string
}

/**
 * Application-level liveness, for clients that cannot see WebSocket control frames. The protocol
 * ping of design §7 is the control frame; this is the same question asked in JSON.
 */
export interface WsPingRequest {
  id?: number
  op: "ping"
}

export type WsRequest =
  | WsHelloRequest
  | WsQueryRequest
  | WsBatchRequest
  | WsTxBeginRequest
  | WsTxCommitRequest
  | WsTxRollbackRequest
  | WsSubscribeRequest
  | WsUnsubscribeRequest
  | WsPingRequest

export type WsOp = WsRequest["op"]

export interface WsQueryReply {
  id: number
  ok: true
  result: QueryResult
}

export interface WsBatchReply {
  id: number
  ok: true
  result: BatchResult
}

export interface WsTxBeginReply {
  id: number
  ok: true
  tx: string
  expiresInMs: number
}

export interface WsTxEndReply {
  id: number
  ok: true
  txid: number
}

export interface WsSubscribeReply {
  id: number
  ok: true
  sub: string
}

export interface WsAckReply {
  id: number
  ok: true
}

export interface WsErrorReply {
  /** Absent when the failure cannot be attributed to one request. */
  id?: number
  ok: false
  error: ErrorInfo
}

export type WsReply =
  | WsQueryReply
  | WsBatchReply
  | WsTxBeginReply
  | WsTxEndReply
  | WsSubscribeReply
  | WsAckReply
  | WsErrorReply

/** Server greeting, sent once the socket is authenticated. */
export interface WsHelloEvent {
  event: "hello"
  protocol: string
  node: string
  role: "primary" | "replica"
}

/** This database moved after a failover; reconnect to `primary`. */
export interface WsMovedEvent {
  event: "moved"
  db: string
  primary: string
}

export type WsPushEvent = "change" | "schema" | "rows" | "diff" | "reset"

/** Answer to a `ping` that carried no `id`. */
export interface WsPongEvent {
  event: "pong"
}

export interface WsPush<D = ChangeEvent | SchemaEvent | LiveRowsEvent | LiveDiffEvent | ResetEvent> {
  sub: string
  event: WsPushEvent
  data: D
}

export type WsServerMessage = WsReply | WsPush | WsHelloEvent | WsMovedEvent | WsPongEvent

/** Response and request headers that carry the same information as the body fields above. */
export const HEADERS = {
  txid: "BunQL-Txid",
  minTxid: "BunQL-Min-Txid",
  ack: "BunQL-Ack",
  node: "BunQL-Node",
  role: "BunQL-Role",
  durationUs: "BunQL-Duration-Us",
  primary: "BunQL-Primary",
} as const

// ── Admin routes (design §6.5) ─────────────────────────────────────────────────────────────────
//
// The bodies of the lifecycle, replication, backup and token routes. `src/server/registry.ts` is
// where they are declared and enforced; these are the same shapes as the client reads them, and
// `src/client/admin.ts` is the only thing that asks for them.

/** One row of `GET /v1/db`. */
export interface DatabaseInfo {
  name: string
  txid: number
  epoch: number
  role: string
  pageSize: number
  quotaBytes: number
  createdAtMs: number
  /** Whether this node has the database open right now. */
  open: boolean
}

/** One replica attached to a primary, as `GET /v1/db/{db}` reports it. */
export interface ReplicaPosition {
  node: string
  txid: number
  lag: number
}

/** `GET /v1/db/{db}`, and the answer to every route that creates a database. */
export interface DatabaseStats {
  name: string
  role: string
  sizeBytes: number
  walBytes: number
  logBytes: number
  txid: number
  epoch: number
  /** The rolling database checksum, as a decimal string. */
  checksum: string
  openConns: number
  liveQueries: number
  subscribers: number
  lastSnapshotTxid: number | null
  /** This database's own `PRAGMA foreign_keys`, or null when it follows `[sqlite] foreignKeys`. */
  foreignKeys: boolean | null
  /** Null when it follows `[replication] ackWithoutReplicas`. */
  ackWithoutReplicas: "error" | "allow" | null
  /** Replicas only: the apply mechanism actually running. */
  apply?: string
  replicas: ReplicaPosition[]
}

/** A point in a database's history: a txid, or an ISO-8601 instant the server resolves. */
export type Revision = number | string

export interface CreateDatabaseOptions {
  pageSize?: number
  quotaBytes?: number
  /** Fork of an existing database, optionally as of a txid or an instant. */
  from?: { db: string; at?: Revision }
}

/** `PATCH /v1/db/{db}`. Null clears the override and follows the node's config again. */
export interface DatabaseSettings {
  foreignKeys?: boolean | null
  ackWithoutReplicas?: "error" | "allow" | null
}

export interface DeleteResult {
  name: string
  deleted: boolean
  /** Where the files went; `[durability] retention` sweeps it. */
  trash: string
}

export interface SnapshotInfo {
  snapshotId: string
  txid: number
  bytes: number
  checksum: string
  createdAtMs: number
}

export interface RestoreOptions {
  /** The point to restore to. Omitted, it means the newest the source holds. */
  at?: Revision
  /** Name of the database to create. Default `<db>-restore-<txid>`. */
  into?: string
  /** `"s3"` restores from the bucket rather than the local log. */
  from?: "s3"
  /** Override the node's own `[s3]` bucket, prefix and timeline. Credentials stay the node's. */
  bucket?: string
  prefix?: string
  generation?: string
}

/** A restore from the local log. */
export interface LocalRestoreResult {
  name: string
  from: string
  txid: number
  at: number
}

/** A restore from the backup bucket. */
export interface S3RestoreResult {
  name: string
  from: string
  source: "s3"
  bucket: string
  prefix: string
  generation: string
  txid: number
  /** The snapshot the replay started from. */
  fromTxid: number
  /** Records replayed on top of it. */
  applied: number
  objects: number
  bytes: number
}

export type RestoreResult = LocalRestoreResult | S3RestoreResult

export type CheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"

export interface CheckpointResult {
  mode: CheckpointMode
  /** Whether SQLite found the WAL busy; a `PASSIVE` checkpoint then moves nothing. */
  busy: boolean
  /** Frames in the WAL, and frames moved into the database. */
  log: number
  checkpointed: number
  walBytes: number
  txid: number
}

/** `GET /v1/db/{db}/dump`: the file, and the txid it is consistent at. */
export interface DatabaseDump {
  txid: number
  /** `Content-Length`, or null when the server did not send one. */
  bytes: number | null
  stream: ReadableStream<Uint8Array>
}

/** What every `GET /v1/db/{db}/replication` carries, whatever the role. */
export interface ReplicationCommon {
  db: string
  txid: number
  epoch: number
  checksum: string
  lastSnapshot: { txid: number; bytes: number; at: number } | null
  s3: ShipperState | null
}

export interface PrimaryReplication extends ReplicationCommon {
  role: "primary"
  replicas: {
    node: string
    stream: number
    txid: number
    lag: number
    ackedAt: number
    fsynced: boolean
  }[]
}

export interface ReplicaReplication extends ReplicationCommon {
  role: "replica"
  primary: string
  connected: boolean
  applied: number
  lagTxid: number
  bootstrapping: boolean
  lastError: string | null
}

export type ReplicationStatus = PrimaryReplication | ReplicaReplication

/** The S3 shipper's own view, without touching the bucket. */
export interface ShipperState {
  db: string
  bucket: string
  prefix: string
  endpoint: string | null
  generation: string | null
  /** Highest txid in the bucket. */
  shippedTxid: number
  /** Records committed since `shippedTxid`. */
  pendingRecords: number
  pendingBytes: number
  /** True once the queue overflowed or an upload failed and the bucket is behind the tenant. */
  behind: boolean
  lastError: string | null
  /** How long the last successful drain took, in milliseconds. */
  lastShipMs: number
  lastShipAtMs: number | null
  bytesShipped: number
  errors: number
  snapshots: number
  segments: number
  lastSnapshotTxid: number | null
}

export interface PromoteResult {
  db: string
  promoted: boolean
  role: string
  epoch: number
  txid: number
  /** Why it was accepted, or refused. */
  why: string
}

/** `GET /v1/db/{db}/backup`. */
export interface BackupStatus {
  db: string
  enabled: boolean
  bucket: string | null
  prefix: string | null
  retention?: string
  shipper: ShipperState | null
  manifest: {
    generation: string
    shippedTxid: number
    snapshots: number
    segments: number
  } | null
  error: string | null
}

export interface VerifyBackupOptions {
  at?: Revision
  bucket?: string
  prefix?: string
  generation?: string
}

/** `POST /v1/db/{db}/backup/verify`. Writes nothing. */
export interface BackupVerification {
  ok: boolean
  db: string
  at: number
  latest: number
  generation: string
  segments: number
  records: number
  bytes: number
  /** The objects a restore to `at` would need and the bucket does not hold. */
  missing: string[]
}

/** One timeline in the bucket. `firstTxid` and `lastTxid` are decimal strings. */
export interface GenerationInfo {
  id: string
  startedAtMs: number
  firstTxid: string
  lastTxid: string
}

export interface BackupGenerations {
  db: string
  bucket: string
  prefix: string
  generations: GenerationInfo[]
}

/** One node in the control plane's view of itself. */
export interface ClusterNode {
  id: string
  advertise: string
  zone: string
  status: string
  reachable: boolean
}

/** Where one database is placed, and who holds its lease. */
export interface ClusterPlacement {
  db: string
  primary: string | null
  replicas: string[]
  epoch: number
  /** `until` is the leader's wall clock, so read it against the view's own `nowMs`. */
  lease: { node: string; until: number } | null
  acked: Record<string, string>
  generation: string | null
  leaseHeldHere: boolean
}

/** `GET /v1/cluster`. */
export interface ClusterView {
  id: string
  role: string
  term: number
  leader: string | null
  commitIndex: number
  appliedIndex: number
  voters: string[]
  learners: string[]
  nowMs: number
  nodes: ClusterNode[]
  dbs: ClusterPlacement[]
}

/** Per-table narrowing of a token, beyond its database scope. */
export type TableScope = "r" | "rw"

export interface TokenOptions {
  /** Database globs. `db` is the one-database spelling of the same thing. */
  dbs?: string[]
  db?: string
  scope?: "ro" | "rw"
  tables?: Record<string, TableScope>
  /** Default `[auth] defaultTokenTtlMs`. */
  ttlMs?: number
  /** Subject claim, for an audit trail. */
  sub?: string
}

export interface MintedToken {
  token: string
  jti: string
  /** JWT `exp`: expiry in epoch **seconds**, or null for a token that does not expire. */
  exp: number | null
}

export interface RevokedToken {
  jti: string
  revoked: boolean
}
