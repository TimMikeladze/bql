// Invariant: nothing a client sees comes from a stack trace. Every failure leaves this module as
// a `{status, body}` pair whose `message` is either a SQLite diagnostic (safe: it names SQL
// objects the caller already sent) or a string this file wrote. Unrecognised throws become a
// bare 500 with no detail at all.

import { SqliteError } from "../sqlite/errors.ts"
import { HEADERS, type BunQLErrorCode, type ErrorBody, type ErrorInfo } from "../client/protocol.ts"

/** Default HTTP status for each BunQL error code (design §6.6). */
export const ERROR_STATUS: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  NOT_AUTHORIZED: 403,
  DB_NOT_FOUND: 404,
  QUERY_TIMEOUT: 408,
  CONFLICT: 409,
  RESET_REQUIRED: 409,
  TX_BUSY: 409,
  TX_NOT_FOUND: 404,
  TOO_MANY_ROWS: 400,
  PAYLOAD_TOO_LARGE: 413,
  TXID_NOT_AVAILABLE: 425,
  TOO_MANY_REQUESTS: 429,
  BUSY: 503,
  NOT_PRIMARY: 503,
  REPLICATION_DISABLED: 403,
  QUOTA_EXCEEDED: 507,
  INTERNAL: 500,
}

export interface ErrorDetails {
  /** Last txid of the database as the failing request saw it. */
  txid?: number
  /** Index of the failing statement in a batch. */
  failedIndex?: number
  /** Where the client should go instead, for `NOT_PRIMARY`. */
  primary?: string
}

/** An error the server raises itself, as opposed to one SQLite raised. */
export class BunQLError extends Error {
  readonly code: BunQLErrorCode
  readonly status: number
  readonly details?: ErrorDetails

  constructor(code: BunQLErrorCode, message: string, status?: number, details?: ErrorDetails) {
    super(message)
    this.name = "BunQLError"
    this.code = code
    this.status = status ?? ERROR_STATUS[code] ?? 500
    if (details) this.details = details
  }

  static badRequest(message: string, details?: ErrorDetails): BunQLError {
    return new BunQLError("BAD_REQUEST", message, 400, details)
  }

  static unauthenticated(message = "missing or invalid token"): BunQLError {
    return new BunQLError("UNAUTHENTICATED", message, 401)
  }

  static notAuthorized(message = "not authorized"): BunQLError {
    return new BunQLError("NOT_AUTHORIZED", message, 403)
  }

  static dbNotFound(db: string): BunQLError {
    return new BunQLError("DB_NOT_FOUND", `no such database: ${db}`, 404)
  }

  static queryTimeout(timeoutMs?: number): BunQLError {
    const suffix = timeoutMs === undefined ? "" : ` after ${timeoutMs}ms`
    return new BunQLError("QUERY_TIMEOUT", `query cancelled${suffix}`, 408)
  }

  static txidNotAvailable(minTxid: number, have: number): BunQLError {
    return new BunQLError(
      "TXID_NOT_AVAILABLE",
      `this node is at txid ${have} and cannot serve minTxid ${minTxid}`,
      425,
      { txid: have },
    )
  }

  static notPrimary(primary?: string): BunQLError {
    return new BunQLError("NOT_PRIMARY", "this node is not the primary for this database", 503, {
      primary,
    })
  }

  static resetRequired(message = "the change ring no longer holds that position"): BunQLError {
    return new BunQLError("RESET_REQUIRED", message, 409)
  }

  static quotaExceeded(message = "database is full"): BunQLError {
    return new BunQLError("QUOTA_EXCEEDED", message, 507)
  }

  static busy(message = "database is busy"): BunQLError {
    return new BunQLError("BUSY", message, 503)
  }

  /** More rows than the request's `maxRows` allowed (design §6, "common request options"). */
  static tooManyRows(maxRows: number): BunQLError {
    return new BunQLError(
      "TOO_MANY_ROWS",
      `the result has more than the ${maxRows} rows this request allowed`,
      400,
    )
  }
}

/** True for the errors whose message is safe to hand back verbatim as a 400. */
function isClientInputError(err: unknown): err is Error {
  return err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError
}

/**
 * Status and BunQL code for a SQLite result code name. Codes §6.6 renames keep the BunQL name;
 * everything else travels under its own `SQLITE_*` name so clients can switch on the exact cause.
 */
function fromSqlite(code: string): { status: number; code: string } {
  if (code.startsWith("SQLITE_CONSTRAINT")) return { status: 409, code }
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return { status: 503, code: "BUSY" }
  }
  if (code.startsWith("SQLITE_READONLY")) return { status: 403, code: "NOT_AUTHORIZED" }
  if (code.startsWith("SQLITE_AUTH")) return { status: 403, code: "NOT_AUTHORIZED" }
  if (code.startsWith("SQLITE_IOERR")) return { status: 500, code }
  if (code.startsWith("SQLITE_CORRUPT")) return { status: 500, code }
  if (code.startsWith("SQLITE_CANTOPEN")) return { status: 500, code }
  switch (code) {
    case "SQLITE_INTERRUPT":
      return { status: 408, code: "QUERY_TIMEOUT" }
    case "SQLITE_FULL":
      return { status: 507, code: "QUOTA_EXCEEDED" }
    case "SQLITE_ERROR":
    case "SQLITE_MISUSE":
    case "SQLITE_RANGE":
    case "SQLITE_MISMATCH":
    case "SQLITE_SCHEMA":
    case "SQLITE_TOOBIG":
    case "SQLITE_NOTADB":
    case "SQLITE_FORMAT":
    case "SQLITE_EMPTY":
    case "SQLITE_WARNING":
    case "SQLITE_NOTICE":
      return { status: 400, code }
    default:
      return { status: 500, code }
  }
}

/**
 * Turns anything thrown on the request path into the HTTP status and response body of §6.6.
 * `details` fills in fields the thrower did not know, such as the txid the database was at.
 */
export function mapError(err: unknown, details?: ErrorDetails): { status: number; body: ErrorBody } {
  let status: number
  let code: string
  let message: string
  let own: ErrorDetails | undefined

  if (err instanceof BunQLError) {
    status = err.status
    code = err.code
    message = err.message
    own = err.details
  } else if (err instanceof SqliteError) {
    const mapped = fromSqlite(err.code)
    status = mapped.status
    code = mapped.code
    message = err.message
  } else if (isClientInputError(err)) {
    status = 400
    code = "BAD_REQUEST"
    message = err.message
  } else {
    status = 500
    code = "INTERNAL"
    message = "internal error"
  }

  const error: ErrorInfo = { code, message, status }
  const txid = details?.txid ?? own?.txid
  const failedIndex = details?.failedIndex ?? own?.failedIndex
  const primary = details?.primary ?? own?.primary
  if (txid !== undefined) error.txid = txid
  if (failedIndex !== undefined) error.failedIndex = failedIndex
  if (primary !== undefined) error.primary = primary
  return { status, body: { error } }
}

/** The same mapping as an HTTP response, with the headers §6.6 asks for. */
export function errorResponse(err: unknown, details?: ErrorDetails, extra?: Bun.HeadersInit): Response {
  const { status, body } = mapError(err, details)
  const headers = new Headers(extra)
  headers.set("content-type", "application/json; charset=utf-8")
  if (body.error.txid !== undefined) headers.set(HEADERS.txid, String(body.error.txid))
  if (body.error.primary !== undefined) headers.set(HEADERS.primary, body.error.primary)
  return new Response(JSON.stringify(body), { status, headers })
}
