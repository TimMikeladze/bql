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
  | "QUERY_TIMEOUT"
  | "TXID_NOT_AVAILABLE"
  | "NOT_PRIMARY"
  | "RESET_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "BUSY"
  | "INTERNAL"
  // Any `SQLITE_*` extended result code name also travels in this field.
  | (string & {})

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
