// Invariant: **the caller's rights are established before the first field resolves, and they are
// ambient for exactly one request.** Everything else here is protocol.
//
// The order is load-bearing, so it is stated once and followed: read the database out of the
// request, build the caller's context from *this* request, fetch or generate that tenant's schema
// (which knows nothing about the caller), parse, validate, measure against the limits, and only
// then enter `runInCall` and execute. Nothing dispatches before the store is entered, and the
// store is gone when the response is built — see `src/graphql/ambient.ts` for why a token held
// anywhere else would be a privilege escalation.
//
// An operation refused by `validate` or by the limits runs **nothing**: no dispatch, no statement,
// no row. That is what makes the depth limit a defence rather than a warning.
//
// Protocol, matching what `openapi-x-graphql`'s own handler does so GraphiQL and every client
// behave the same against either: `POST` with a JSON body `{query, variables, operationName}`;
// `GET` with the same in query parameters, restricted to `query` operations; `GET` from a browser
// renders GraphiQL, which the package draws. CORS is not written here — `src/server/app.ts` owns
// it for every route on this server, and a second set of headers would fight it.
//
// Errors keep BunQL's vocabulary all the way out (`src/graphql/errors.ts`). A protocol refusal —
// an unparseable query, a limit — is an HTTP `400` whose body is the GraphQL `{errors: [...]}`
// shape with `extensions.code` set to `BAD_REQUEST`, because a GraphQL client reads errors from
// the body and a `{error: {...}}` body would be invisible to it. An operation that *ran* is a
// `200` whose errors are per field, which is GraphQL's own rule.

import type { DataApiContext } from "../dataapi/index.ts"
import type { DocumentNode, ExecutionResult, GraphQLError, GraphQLSchema } from "graphql"
import { type FormattedGraphQLError, liftBunQLError } from "./errors.ts"
import { runInCall } from "./ambient.ts"
import {
  checkLimits,
  DEFAULT_MAX_COMPLEXITY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_ROWS,
  type LimitProblem,
} from "./limits.ts"
import { loadPeers, type Peers } from "./peers.ts"
import { SchemaCache, type SchemaOptions } from "./schema.ts"

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const

export interface GraphQLHandlerOptions extends SchemaOptions {
  /**
   * The caller's own rights for this request, built from the request the way `src/server/` builds
   * every other context: authenticate the token, then close an `exec` over `src/server/exec.ts`
   * as that principal. Called **once per request**, and what it returns is ambient for that
   * request only.
   */
  context: (request: Request, db: string) => DataApiContext | Promise<DataApiContext>
  /**
   * Which database the request addressed. The default reads `{db}` out of a
   * `/v1/db/{db}/graphql` path, which is where `src/server/routes.ts` mounts this.
   */
  database?: (request: Request) => string | undefined
  /** GraphiQL on a browser's `GET`. Default true (`[graphql] graphiql`). */
  graphiql?: boolean
  /** Title of the GraphiQL page. Default the database's name. */
  title?: string
  /** `[graphql] maxDepth`. Default 12. */
  maxDepth?: number
  /** `[graphql] maxComplexity`. Default 10000. */
  maxComplexity?: number
  /** Rows a list field is counted at when nothing says otherwise. Default 100, `[api] defaultLimit`. */
  defaultRows?: number
}

/** The handler, with the schema cache it uses — a deleted database is `schemas.invalidate(db)`. */
export interface GraphQLHandler {
  (request: Request): Promise<Response>
  readonly schemas: SchemaCache
}

interface Payload {
  query?: string
  variables?: Record<string, unknown> | null
  operationName?: string | null
}

/**
 * A GraphQL endpoint for one server's databases: `POST /v1/db/{db}/graphql`, GraphiQL on `GET`.
 *
 * Throws `MissingPeersError` — it does not answer with one — when `graphql` and
 * `openapi-x-graphql` are absent, so a server can refuse to mount the route rather than serve a
 * confusing 500. `graphqlAvailable()` is the check to mount behind.
 */
export function graphqlHandler(options: GraphQLHandlerOptions): GraphQLHandler {
  const schemas = new SchemaCache(options)
  const readDatabase = options.database ?? databaseFromPath

  const handler = async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase()
    if (method !== "GET" && method !== "POST") {
      return refusal(`method ${method} is not supported; GraphQL is POST, or GET for a query`, 405)
    }
    const db = readDatabase(request)
    if (!db) return refusal("no database in the request path", 400)

    const url = new URL(request.url)
    const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false
    const peers = await loadPeers(options.peers)
    if (method !== "POST" && wantsHtml && options.graphiql !== false && !url.searchParams.has("query")) {
      return new Response(
        peers.openapi.renderGraphiQL({
          endpoint: url.pathname,
          title: options.title ?? `${db} — BunQL GraphQL`,
        }),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      )
    }

    let payload: Payload
    try {
      payload = method === "POST" ? await payloadFromBody(request) : payloadFromUrl(url)
    } catch (err) {
      return refusal(`invalid request body: ${(err as Error).message}`, 400)
    }
    if (!payload.query) return refusal('missing "query" in the request', 400)

    // The context is built from *this* request, before anything is generated or executed.
    const context = await options.context(request, db)
    const tenant = await schemas.for(db)

    const prepared = prepareDocument(peers, tenant.schema, payload.query, {
      variables: payload.variables ?? null,
      operationName: payload.operationName ?? null,
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      ...(options.maxComplexity !== undefined ? { maxComplexity: options.maxComplexity } : {}),
      ...(options.defaultRows !== undefined ? { defaultRows: options.defaultRows } : {}),
    })
    if (prepared.problems) return errors(prepared.problems, 400)
    const document = prepared.document

    const operation = peers.graphql.getOperationAST(document, payload.operationName ?? undefined)
    if (method !== "POST" && operation?.operation !== "query") {
      return refusal("only query operations are allowed over GET", 405)
    }

    const result: ExecutionResult = await runInCall({ db, context }, () =>
      peers.graphql.execute({
        schema: tenant.schema,
        document,
        ...(payload.variables ? { variableValues: payload.variables } : {}),
        ...(payload.operationName ? { operationName: payload.operationName } : {}),
      }),
    )

    const body = JSON.stringify({
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.errors
        ? { errors: result.errors.map((error) => liftBunQLError(formatted(error))) }
        : {}),
    })
    return new Response(body, { headers: JSON_HEADERS })
  }

  return Object.assign(handler, { schemas })
}

/**
 * Parse, validate, and measure against the limits — the three things that must happen to a
 * document before anything dispatches, in that order.
 *
 * Shared by the HTTP handler above and by `src/graphql/ws.ts`, so a socket and a request refuse
 * the same documents for the same reasons. H7's rule: one execution path, one set of limits
 * (`docs/h7-subscriptions.md` §5). The two callers differ only in how they render a refusal — an
 * HTTP `400` with a GraphQL error body, or an `error` message on the socket — which is why this
 * returns the problems rather than a `Response`.
 */
export function prepareDocument(
  peers: Peers,
  schema: GraphQLSchema,
  query: string,
  options: {
    variables?: Record<string, unknown> | null
    operationName?: string | null
    maxDepth?: number
    maxComplexity?: number
    defaultRows?: number
  } = {},
): { document: DocumentNode; problems?: undefined } | { document?: undefined; problems: FormattedGraphQLError[] } {
  let document: DocumentNode
  try {
    document = peers.graphql.parse(query)
  } catch (err) {
    return { problems: [formatted(err as GraphQLError)] }
  }
  const invalid = peers.graphql.validate(schema, document, peers.graphql.specifiedRules)
  if (invalid.length > 0) return { problems: invalid.map((error) => formatted(error)) }

  const limits = checkLimits(peers.graphql, schema, document, {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxComplexity: options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY,
    defaultRows: options.defaultRows ?? DEFAULT_ROWS,
    variables: options.variables ?? null,
    operationName: options.operationName ?? null,
  })
  if (limits.problems.length > 0) return { problems: limits.problems.map(refused) }
  return { document }
}

/** `/v1/db/acme/graphql` → `acme`. */
export function databaseFromPath(request: Request): string | undefined {
  const segments = new URL(request.url).pathname.split("/")
  const at = segments.lastIndexOf("db")
  const name = at >= 0 ? segments[at + 1] : undefined
  if (name === undefined || name.length === 0) return undefined
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

async function payloadFromBody(request: Request): Promise<Payload> {
  const type = request.headers.get("content-type") ?? ""
  if (type.includes("application/graphql")) return { query: await request.text() }
  const text = await request.text()
  if (text.length === 0) return {}
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== "object" || parsed === null) throw new TypeError("body is not an object")
  return parsed as Payload
}

function payloadFromUrl(url: URL): Payload {
  const variables = url.searchParams.get("variables")
  return {
    ...(url.searchParams.has("query") ? { query: url.searchParams.get("query") as string } : {}),
    ...(url.searchParams.has("operationName")
      ? { operationName: url.searchParams.get("operationName") }
      : {}),
    ...(variables ? { variables: JSON.parse(variables) as Record<string, unknown> } : {}),
  }
}

/** `GraphQLError.toJSON()`, which is the shape a GraphQL response carries. */
function formatted(error: GraphQLError): FormattedGraphQLError {
  return error.toJSON() as FormattedGraphQLError
}

/** A limit refusal, in `src/server/errors.ts`'s vocabulary. */
function refused(problem: LimitProblem): FormattedGraphQLError {
  return {
    message: problem.message,
    extensions: {
      code: "BAD_REQUEST",
      status: 400,
      limit: problem.limit,
      max: problem.max,
      actual: problem.actual,
    },
  }
}

/** A protocol refusal: the GraphQL error shape a client reads, under a real HTTP status. */
function refusal(message: string, status: number): Response {
  return errors([{ message, extensions: { code: "BAD_REQUEST", status } }], status)
}

function errors(list: FormattedGraphQLError[], status: number): Response {
  return new Response(JSON.stringify({ errors: list }), { status, headers: JSON_HEADERS })
}
