// Invariant: everything this SDK throws is a `BunQLClientError`, so a caller writes one catch
// clause and reads `code` rather than matching on messages. The code is the server's own
// (design §6.6) — `SQLITE_CONSTRAINT_UNIQUE`, `DB_NOT_FOUND`, `TXID_NOT_AVAILABLE` — plus the two
// this side can raise on its own: `NETWORK` and `CLIENT`.

import type { BunQLErrorCode, ErrorBody, ErrorInfo, ErrorProblem } from "./protocol.ts"

export interface ClientErrorInit {
  code: BunQLErrorCode
  message: string
  /** HTTP status, or 0 for a failure that never reached the server. */
  status?: number
  txid?: number
  failedIndex?: number
  primary?: string
  /** Every schema problem the server found, for a `BAD_REQUEST` core refused. */
  problems?: ErrorProblem[]
  cause?: unknown
}

export class BunQLClientError extends Error {
  readonly code: BunQLErrorCode
  readonly status: number
  readonly txid?: number
  /** Index of the failing statement, for a batch. */
  readonly failedIndex?: number
  /** Where to go instead, for `NOT_PRIMARY`. */
  readonly primary?: string
  /**
   * Every way the request failed the schema the route publishes, not only the first. Present when
   * the server's validator refused it; a caller can point at each field rather than re-guess.
   */
  readonly problems?: readonly ErrorProblem[]

  constructor(init: ClientErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = "BunQLClientError"
    this.code = init.code
    this.status = init.status ?? 0
    if (init.txid !== undefined) this.txid = init.txid
    if (init.failedIndex !== undefined) this.failedIndex = init.failedIndex
    if (init.primary !== undefined) this.primary = init.primary
    if (init.problems !== undefined) this.problems = init.problems
  }

  /** The error shape of design §6.6, from a response body or a WebSocket reply. */
  static fromInfo(info: ErrorInfo, status?: number): BunQLClientError {
    return new BunQLClientError({
      code: info.code,
      message: info.message,
      status: status ?? info.status ?? 0,
      ...(info.txid !== undefined ? { txid: info.txid } : {}),
      ...(info.failedIndex !== undefined ? { failedIndex: info.failedIndex } : {}),
      ...(info.primary !== undefined ? { primary: info.primary } : {}),
      ...(info.problems !== undefined ? { problems: info.problems } : {}),
    })
  }

  /** A response that failed, whatever its body turned out to be. */
  static fromBody(body: unknown, status: number, fallback: string): BunQLClientError {
    const info = (body as ErrorBody | null)?.error
    if (info && typeof info.code === "string" && typeof info.message === "string") {
      return BunQLClientError.fromInfo(info, status)
    }
    return new BunQLClientError({ code: "INTERNAL", message: fallback, status })
  }

  /** The request never got an answer: no socket, a refused connection, an aborted stream. */
  static network(message: string, cause?: unknown): BunQLClientError {
    return new BunQLClientError({ code: "NETWORK", message, status: 0, cause })
  }

  /** The caller asked for something this SDK cannot do; nothing was sent. */
  static client(message: string, cause?: unknown): BunQLClientError {
    return new BunQLClientError({ code: "CLIENT", message, status: 0, cause })
  }
}

/** Anything thrown on the client path, as the error a caller is promised. */
export function asClientError(err: unknown, context: string): BunQLClientError {
  if (err instanceof BunQLClientError) return err
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return new BunQLClientError({ code: "ABORTED", message: err.message, status: 0, cause: err })
    }
    if (err.name === "ValueError") return BunQLClientError.client(err.message, err)
    return BunQLClientError.network(`${context}: ${err.message}`, err)
  }
  return BunQLClientError.network(`${context}: ${String(err)}`)
}
