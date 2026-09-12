// Invariant: an operation is the only description of itself. The router executes it, the OpenAPI
// emitter describes it and the GraphQL schema is generated from that document, so there is one
// truth and nothing to keep in sync (`docs/plan-surfaces.md`).
//
// `path` is stored in **Bun.serve's own syntax** — `/v1/db/:db/api/:table` — because that is what
// `src/http/` hands to Bun unchanged, so path matching stays Bun's and nothing is added to the hot
// path. `src/openapi/` converts it to `{db}` when it emits the document; nobody converts the other
// way.
//
// The context is a type parameter defaulting to `unknown`, so this module owes nothing to the rest
// of BunQL: the server instantiates `Registry<RouteContext>` and core stays a piece another
// project could take whole.
//
// `Registry.add` refuses a malformed operation by throwing. These are programmer errors found at
// startup, not request errors, and the one that matters most is the path binding: a `:param` that
// nothing declares, or a declared parameter that is not in the path, is the single most likely
// mistake in this design, and it turns into a handler reading `undefined` rather than into a
// failure anyone notices. It is cheaper to make it impossible to register.

import type { Schema } from "./schema.ts"

/** The methods `src/http/` compiles into a `Bun.serve` routes table. */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete"

/**
 * A BunQL error code, such as `"NOT_PRIMARY"` or `"SQLITE_CONSTRAINT_UNIQUE"`.
 * `src/client/protocol.ts` owns the list; core does not import it, and `src/openapi/` maps a code
 * to a status with the table in `src/server/errors.ts`.
 */
export type ErrorCode = string

export interface OperationParams {
  /** One object schema whose properties are exactly the `:param` segments of `path`. */
  path?: Schema
  query?: Schema
  headers?: Schema
}

export interface OperationBody {
  schema: Schema
  /** Default `"application/json"`. */
  contentType?: string
  required?: boolean
}

export interface OperationResponse {
  /** Default 200. */
  status?: number
  schema: Schema
  contentType?: string
  headers?: Schema
}

/** `"bearer"` is the EdDSA JWT of `src/server/auth.ts`; `"admin"` is the admin key. */
export type Security = "bearer" | "admin" | "none"

/** How an operation renders in GraphQL. `"none"` keeps it out of the schema entirely. */
export interface GraphqlBinding {
  kind: "query" | "mutation" | "subscription" | "none"
  field?: string
}

export interface Operation<TIn = unknown, TOut = unknown, Ctx = unknown> {
  /** The `operationId`, and the GraphQL field name, so it has to be a GraphQL name. */
  id: string
  method: HttpMethod
  /** Bun.serve syntax, e.g. `/v1/db/:db/api/:table/:id`. */
  path: string
  summary?: string
  description?: string
  tags?: string[]
  params?: OperationParams
  body?: OperationBody
  response: OperationResponse
  /** Error statuses this operation can produce, by BunQL error code. */
  errors?: ErrorCode[]
  security?: Security
  graphql?: GraphqlBinding
  handler: (input: TIn, ctx: Ctx) => Promise<TOut> | TOut
}

export interface ServerInfo {
  url: string
  description?: string
}

export interface RegistryInfo {
  title: string
  version: string
  description?: string
  servers?: ServerInfo[]
}

/** Identity, but it lets TypeScript infer an operation's types from the literal. */
export function defineOperation<TIn, TOut, Ctx>(
  operation: Operation<TIn, TOut, Ctx>,
): Operation<TIn, TOut, Ctx> {
  return operation
}

const METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"]
/** The id becomes a GraphQL field name, and GraphQL names are this. */
const GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PATH_PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/

/** The `:param` names a Bun route binds, in the order they appear. */
export function pathParameters(path: string): string[] {
  const out: string[] = []
  for (const segment of path.split("/")) {
    const found = PATH_PARAM.exec(segment)
    if (found) out.push(found[1] as string)
  }
  return out
}

/** An ordered set of operations, and the only thing the three surfaces consume. */
export class Registry<Ctx = unknown> {
  readonly info: RegistryInfo
  readonly #operations = new Map<string, Operation<any, any, Ctx>>()
  readonly #routes = new Map<string, string>()

  constructor(info: RegistryInfo) {
    this.info = info
  }

  get size(): number {
    return this.#operations.size
  }

  /** Registers an operation, throwing on anything that could only be a mistake in the source. */
  add<TIn, TOut>(operation: Operation<TIn, TOut, Ctx>): this {
    check(operation)
    if (this.#operations.has(operation.id)) {
      throw new Error(`operation "${operation.id}": an operation with that id is already registered`)
    }
    const route = `${operation.method} ${operation.path}`
    const owner = this.#routes.get(route)
    if (owner !== undefined) {
      throw new Error(`operation "${operation.id}": ${route} is already served by "${owner}"`)
    }
    this.#operations.set(operation.id, operation as Operation<any, any, Ctx>)
    this.#routes.set(route, operation.id)
    return this
  }

  /** In registration order, which is the order the document and the routes table follow. */
  operations(): Operation<any, any, Ctx>[] {
    return [...this.#operations.values()]
  }

  get(id: string): Operation<any, any, Ctx> | undefined {
    return this.#operations.get(id)
  }

  /** Folds another registry in — a tenant's generated data API into the server's own. */
  merge(other: Registry<Ctx>): this {
    for (const operation of other.operations()) this.add(operation)
    return this
  }
}

function check(operation: Operation<any, any, any>): void {
  const { id } = operation
  const name = `operation "${id}"`
  if (typeof id !== "string" || !GRAPHQL_NAME.test(id)) {
    throw new Error(
      `${name}: the id is the GraphQL field name, so it must match ${GRAPHQL_NAME.source}`,
    )
  }
  if (!METHODS.includes(operation.method)) {
    throw new Error(`${name}: "${operation.method}" is not one of ${METHODS.join(", ")}`)
  }
  if (typeof operation.path !== "string" || !operation.path.startsWith("/")) {
    throw new Error(`${name}: the path must start with "/"`)
  }
  if (operation.body && (operation.method === "get" || operation.method === "delete")) {
    throw new Error(`${name}: a ${operation.method} operation cannot have a body`)
  }
  if (typeof operation.handler !== "function") {
    throw new Error(`${name}: the handler must be a function`)
  }
  if (!operation.response || !operation.response.schema) {
    throw new Error(`${name}: the response needs a schema`)
  }
  checkPathParams(operation, name)
}

function checkPathParams(operation: Operation<any, any, any>, name: string): void {
  const bound = pathParameters(operation.path)
  const schema = operation.params?.path
  if (!schema) {
    if (bound.length === 0) return
    throw new Error(
      `${name}: the path binds :${bound.join(", :")}, which params.path does not declare`,
    )
  }
  if (schema.type !== "object" || !Object.hasOwn(schema, "properties")) {
    throw new Error(`${name}: params.path must be an object schema`)
  }
  const properties = schema.properties as Record<string, Schema>
  const declared = Object.keys(properties)
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  for (const parameter of bound) {
    if (!declared.includes(parameter)) {
      throw new Error(
        `${name}: the path binds :${parameter}, which params.path does not declare`,
      )
    }
  }
  for (const parameter of declared) {
    if (!bound.includes(parameter)) {
      throw new Error(
        `${name}: params.path declares "${parameter}", which the path "${operation.path}" does not contain`,
      )
    }
    if (!required.includes(parameter)) {
      throw new Error(
        `${name}: params.path.${parameter} is optional, and a path parameter cannot be absent`,
      )
    }
  }
}
