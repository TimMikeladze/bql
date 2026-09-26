// Invariant: this module is the only description of the Hrana wire format inside bql.sh, and it
// carries no behaviour at all. Field names are Hrana's — `snake_case`, `last_insert_rowid` as a
// string, integers as decimal text — and nothing here is allowed to drift towards bql.sh's own
// spelling, because both shapes exist in this process and a rename that type-checks would be a
// silent protocol break.
//
// Transcribed from the Hrana 3 specification and cross-checked against the decoders in
// `@libsql/hrana-client@0.7.0` (`shared/json_decode.js`, `http/json_decode.js`,
// `ws/json_decode.js`), which are stricter than the prose: `Value.float` must be a JSON number,
// `Col.name` may be null, `last_insert_rowid` is a string or absent.

/** One SQLite value on the Hrana wire. Integers are decimal text; blobs are base64. */
export type HranaValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string }

export interface HranaError {
  message: string
  code?: string | null
}

export interface HranaCol {
  name: string | null
  decltype: string | null
}

export interface HranaNamedArg {
  name: string
  value: HranaValue
}

export interface HranaStmt {
  sql?: string | null
  sql_id?: number | null
  args?: HranaValue[]
  named_args?: HranaNamedArg[]
  want_rows?: boolean
}

export interface HranaStmtResult {
  cols: HranaCol[]
  rows: HranaValue[][]
  affected_row_count: number
  last_insert_rowid: string | null
  rows_read: number
  rows_written: number
  query_duration_ms: number
  /** libsql's extension, and design §6.7's one mapping: our txid as decimal text. */
  replication_index?: string | null
}

export type HranaBatchCond =
  | { type: "ok"; step: number }
  | { type: "error"; step: number }
  | { type: "not"; cond: HranaBatchCond }
  | { type: "and"; conds: HranaBatchCond[] }
  | { type: "or"; conds: HranaBatchCond[] }
  | { type: "is_autocommit" }

export interface HranaBatchStep {
  condition?: HranaBatchCond | null
  stmt: HranaStmt
}

export interface HranaBatch {
  steps: HranaBatchStep[]
}

export interface HranaBatchResult {
  step_results: (HranaStmtResult | null)[]
  step_errors: (HranaError | null)[]
}

export interface HranaDescribeResult {
  params: { name: string | null }[]
  cols: { name: string; decltype: string | null }[]
  is_explain: boolean
  is_readonly: boolean
}

// ── stream requests, shared by the pipeline and the socket ──────────────────────────────────────

export type StreamRequest =
  | { type: "close" }
  | { type: "execute"; stmt: HranaStmt }
  | { type: "batch"; batch: HranaBatch }
  | { type: "sequence"; sql?: string | null; sql_id?: number | null }
  | { type: "describe"; sql?: string | null; sql_id?: number | null }
  | { type: "store_sql"; sql_id: number; sql: string }
  | { type: "close_sql"; sql_id: number }
  | { type: "get_autocommit" }

export type StreamResponse =
  | { type: "close" }
  | { type: "execute"; result: HranaStmtResult }
  | { type: "batch"; result: HranaBatchResult }
  | { type: "sequence" }
  | { type: "describe"; result: HranaDescribeResult }
  | { type: "store_sql" }
  | { type: "close_sql" }
  | { type: "get_autocommit"; is_autocommit: boolean }

export type StreamResult =
  | { type: "ok"; response: StreamResponse }
  | { type: "error"; error: HranaError }

export interface PipelineReqBody {
  baton?: string | null
  requests: StreamRequest[]
}

export interface PipelineRespBody {
  baton: string | null
  base_url: string | null
  results: StreamResult[]
}

export interface CursorReqBody {
  baton?: string | null
  batch: HranaBatch
}

export type CursorEntry =
  | { type: "step_begin"; step: number; cols: HranaCol[] }
  | { type: "step_end"; affected_row_count: number; last_insert_rowid: string | null }
  | { type: "step_error"; step: number; error: HranaError }
  | { type: "row"; row: HranaValue[] }
  | { type: "error"; error: HranaError }

// ── WebSocket ───────────────────────────────────────────────────────────────────────────────────

/** Subprotocols we can speak, best first. `hrana3-protobuf` is deliberately absent. */
export const WS_SUBPROTOCOLS = ["hrana3", "hrana2"] as const
export type WsSubprotocol = (typeof WS_SUBPROTOCOLS)[number]

/** Hrana version behind a subprotocol; cursors need 3. */
export const SUBPROTOCOL_VERSION: Readonly<Record<WsSubprotocol, number>> = {
  hrana3: 3,
  hrana2: 2,
}

export type WsRequest =
  | { type: "open_stream"; stream_id: number }
  | { type: "close_stream"; stream_id: number }
  | { type: "execute"; stream_id: number; stmt: HranaStmt }
  | { type: "batch"; stream_id: number; batch: HranaBatch }
  | { type: "open_cursor"; stream_id: number; cursor_id: number; batch: HranaBatch }
  | { type: "close_cursor"; cursor_id: number }
  | { type: "fetch_cursor"; cursor_id: number; max_count: number }
  | { type: "sequence"; stream_id: number; sql?: string | null; sql_id?: number | null }
  | { type: "describe"; stream_id: number; sql?: string | null; sql_id?: number | null }
  | { type: "store_sql"; sql_id: number; sql: string }
  | { type: "close_sql"; sql_id: number }
  | { type: "get_autocommit"; stream_id: number }

export type WsResponse =
  | { type: "open_stream" }
  | { type: "close_stream" }
  | { type: "execute"; result: HranaStmtResult }
  | { type: "batch"; result: HranaBatchResult }
  | { type: "open_cursor" }
  | { type: "close_cursor" }
  | { type: "fetch_cursor"; entries: CursorEntry[]; done: boolean }
  | { type: "sequence" }
  | { type: "describe"; result: HranaDescribeResult }
  | { type: "store_sql" }
  | { type: "close_sql" }
  | { type: "get_autocommit"; is_autocommit: boolean }

export type ClientMsg =
  | { type: "hello"; jwt?: string | null }
  | { type: "request"; request_id: number; request: WsRequest }

export type ServerMsg =
  | { type: "hello_ok" }
  | { type: "hello_error"; error: HranaError }
  | { type: "response_ok"; request_id: number; response: WsResponse }
  | { type: "response_error"; request_id: number; error: HranaError }
