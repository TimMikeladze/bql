// Invariant: a failure leaves the Hrana surface in exactly one of two shapes and never in bql.sh's
// own. A failure that belongs to one request inside a pipeline is a `{"type":"error"}` entry in a
// 200 body; a failure that means the whole request could not be understood is a non-2xx body that
// is *bare* `{message, code}` — not wrapped in `{"error": …}` the way §6.6 wraps ours.
//
// That second shape has an exact content type. `@libsql/hrana-client` reads an error body only
// when `resp.headers.get("content-type") === "application/json"` by string equality, so a
// `; charset=utf-8` suffix turns a useful `LibsqlError` into "Server returned HTTP status 400".

import { mapError } from "../errors.ts"
import type { HranaError } from "./proto.ts"

/**
 * Anything thrown on the Hrana path as a Hrana error. `code` is bql.sh's own code — the same
 * strings design §6.6 uses, and the `SQLITE_*` names for anything SQLite raised — so
 * `LibsqlError.code` means something a client can switch on.
 */
export function toHranaError(err: unknown): HranaError {
  const { body } = mapError(err)
  return { message: body.error.message, code: body.error.code }
}

/** HTTP status for a failure that ends the whole request rather than one entry in it. */
export function hranaStatus(err: unknown): number {
  return mapError(err).status
}

/** A non-2xx Hrana error response, in the one content type the client will parse. */
export function hranaErrorResponse(err: unknown, extra?: Record<string, string>): Response {
  const { status, body } = mapError(err)
  return new Response(
    JSON.stringify({ message: body.error.message, code: body.error.code }),
    {
      status,
      // Exactly `application/json`: see the module header.
      headers: { "content-type": "application/json", ...extra },
    },
  )
}
