// Invariant: this module owns no copy of the code→status mapping. `src/server/errors.ts` is the
// authority — `docs/plan-surfaces.md` says the surfaces reuse it rather than defining a second
// error vocabulary — and core deliberately does not import it, so this is where the two meet.
//
// Asking it is not quite a table lookup, because the mapping has two halves. `ERROR_STATUS` covers
// bql.sh's own codes. The `SQLITE_*` names do not appear there at all: `fromSqlite()` maps them by
// prefix (`SQLITE_CONSTRAINT*` → 409, `SQLITE_BUSY*` → 503, `SQLITE_FULL` → 507) and it is not
// exported. So rather than restate those rules — the drift this repo exists to avoid — a
// `SQLITE_*` name is turned back into its numeric result code by inverting `RESULT_CODE_NAMES`,
// and the real `mapError()` is *run* on a real `SqliteError`. If `fromSqlite` changes, the next
// document build follows it.
//
// A code that is in neither half throws, naming the operation. `ErrorCode` is a bare `string` in
// core, so a typo is otherwise indistinguishable from an intended 500, and a document that
// promises the wrong status is worse than one that refuses to build.

import { s, type Schema } from "../core/index.ts"
import { RESULT_CODE_NAMES } from "../sqlite/constants.ts"
import { SqliteError } from "../sqlite/errors.ts"
import { ERROR_STATUS, mapError } from "../server/errors.ts"

/** `RESULT_CODE_NAMES` read the other way, built once. */
const RESULT_CODES: ReadonlyMap<string, number> = (() => {
  const out = new Map<string, number>()
  for (const key of Object.keys(RESULT_CODE_NAMES)) {
    const rc = Number(key)
    const name = RESULT_CODE_NAMES[rc] as string
    if (!out.has(name)) out.set(name, rc)
  }
  return out
})()

/**
 * The HTTP status `src/server/errors.ts` would answer for a bql.sh error code, or `undefined` when
 * it has never heard of it.
 */
export function statusForCode(code: string): number | undefined {
  const own = ERROR_STATUS[code]
  if (own !== undefined) return own
  const rc = RESULT_CODES.get(code)
  if (rc === undefined) return undefined
  return mapError(new SqliteError("", rc)).status
}

/**
 * The reason phrase a response description opens with. Only the statuses bql.sh can actually
 * produce are named; anything else falls back to a phrase that is still true.
 */
const REASON: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No content",
  400: "Bad request",
  401: "Unauthenticated",
  403: "Forbidden",
  404: "Not found",
  408: "Request timeout",
  409: "Conflict",
  413: "Payload too large",
  425: "Too early",
  429: "Too many requests",
  500: "Internal server error",
  503: "Service unavailable",
  504: "Gateway timeout",
  507: "Insufficient storage",
}

export function reasonPhrase(status: number): string {
  const known = REASON[status]
  if (known !== undefined) return known
  if (status >= 200 && status < 300) return "Success"
  return "Error"
}

/**
 * The body every failure leaves `src/server/errors.ts` as (`ErrorInfo` in
 * `src/client/protocol.ts`), named so it becomes one component every error response `$ref`s.
 *
 * `acks` and `needed` are here because `mapError` really does attach them for `ACK_TIMEOUT` —
 * "how close did it get" is the one thing an operator wants from that body — even though
 * `ErrorInfo` does not name them. `problems` is here because every route's request is validated
 * against the schemas this document publishes, and a refusal lists all of them.
 *
 * Not `.strict()`: a client must tolerate a field a later version adds.
 */
export function errorBodySchema(name: string): Schema {
  return s
    .object({
      error: s
        .object({
          code: s
            .string()
            .describe("The bql.sh error code, or the SQLite extended result code name.")
            .example("SQLITE_CONSTRAINT_UNIQUE"),
          message: s.string().describe("A diagnostic safe to show a caller; never a stack trace."),
          status: s.int().describe("The HTTP status, repeated in the body."),
          txid: s
            .int()
            .optional()
            .describe("Last txid of the database as the failing request saw it."),
          failedIndex: s.int().optional().describe("Index of the failing statement in a batch."),
          primary: s.string().optional().describe("Where to go instead, for NOT_PRIMARY."),
          acks: s
            .int()
            .optional()
            .describe("Distinct replicas that acked in time, for ACK_TIMEOUT."),
          needed: s.int().optional().describe("How many were needed, for ACK_TIMEOUT."),
          problems: s
            .array(
              s.object({
                path: s.string().describe('Where it is, as "body.sql"; empty for the whole value.'),
                message: s.string(),
              }),
            )
            .optional()
            .describe("Every way the request failed this operation's schema, not only the first."),
        })
        .describe("What went wrong."),
    })
    .describe("The error body of design §6.6.")
    .id(name)
}
