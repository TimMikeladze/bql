// Invariant: **one error vocabulary.** A refusal that reaches a resolver keeps the code
// `src/server/errors.ts` gave it — `NOT_AUTHORIZED`, `SQLITE_CONSTRAINT_UNIQUE`, `NOT_PRIMARY` —
// all the way to the GraphQL error's `extensions`, so a client handles a GraphQL failure with the
// same switch it already has for REST. `docs/plan-surfaces.md` forbids a second vocabulary and
// this is where one would otherwise appear.
//
// Where the loss would happen: a generated resolver dispatches, gets a non-2xx back and throws a
// `GraphQLError` of its own — message `"GET /users failed with 403 Forbidden"`, extensions
// `{code: "OPENAPI_REQUEST_FAILED", status, body}`. The bql.sh error is in there, parsed, under
// `body.error`; left alone it reads to a client as one opaque generic failure whatever went wrong.
// So the body is unwrapped: its `message` becomes the error's message and every field of
// `body.error` — `code`, `status`, and the `txid`, `primary`, `problems`, `failedIndex`, `acks`
// and `needed` that `mapError` attaches — becomes an extension.
//
// Nothing else is rewritten. An error the generator did not raise, or one whose body is not a
// bql.sh error body, is passed through exactly as GraphQL formatted it.
//
// One refusal is not lifted but *unmade*: `NOT_FOUND`. A `/{pk}` route answers `404` when the key
// matches nothing (`docs/h8-validated-requests.md`), which is right for REST and wrong for
// GraphQL, where a missing row is `null` and not an error. `nullOnNotFound` wraps the dispatch the
// resolvers run through and turns that one status back into a `200` with a `null` body, so both
// surfaces read idiomatically from one handler. Every other 4xx and 5xx travels untouched.

/** A GraphQL error as `GraphQLError.toJSON()` writes it. */
export interface FormattedGraphQLError {
  message: string
  locations?: readonly { line: number; column: number }[]
  path?: readonly (string | number)[]
  extensions?: Record<string, unknown>
}

/** The extensions key the generator marks a failed REST call with. */
export const REQUEST_FAILED = "OPENAPI_REQUEST_FAILED"

/** The `{error: {...}}` body every bql.sh refusal carries (`src/server/errors.ts`). */
interface BqlErrorBody {
  error: { code: string; message: string; status?: number } & Record<string, unknown>
}

function isErrorBody(value: unknown): value is BqlErrorBody {
  if (typeof value !== "object" || value === null) return false
  const error = (value as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  return typeof code === "string" && typeof message === "string"
}

/**
 * The same error, with a bql.sh refusal lifted out of the generator's wrapper. Anything else is
 * returned unchanged.
 */
export function liftBqlError(formatted: FormattedGraphQLError): FormattedGraphQLError {
  const extensions = formatted.extensions
  if (!extensions || extensions.code !== REQUEST_FAILED) return formatted
  if (!isErrorBody(extensions.body)) return formatted

  const { message, ...rest } = extensions.body.error
  const lifted: Record<string, unknown> = { ...rest }
  if (typeof extensions.operationId === "string") lifted.operationId = extensions.operationId
  if (lifted.status === undefined && typeof extensions.status === "number") {
    lifted.status = extensions.status
  }
  return {
    ...formatted,
    message,
    extensions: lifted,
  }
}

/**
 * The dispatch a generated resolver runs through, with `404 NOT_FOUND` answered as `null`. Only
 * that code: a `DB_NOT_FOUND`, which is also a 404, is a real error in either surface and is left
 * alone.
 */
export function nullOnNotFound(dispatch: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const response = await dispatch(request)
    if (response.status !== 404) return response
    const body = await response.clone().json().catch(() => undefined)
    if (!isErrorBody(body) || body.error.code !== "NOT_FOUND") return response
    return new Response("null", {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  }
}
