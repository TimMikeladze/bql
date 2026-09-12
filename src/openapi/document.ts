// Invariant: the document is a faithful rendering of the registry and nothing else — every
// operation appears exactly once, every schema it names appears as a component, and every error
// code it declares appears under the status `src/server/errors.ts` would really answer with. There
// is no `default` response, no `unknown`-typed hole and no field invented here that the registry
// does not state.
//
// **This is the input to a code generator, not documentation for a human.** H5 does not read the
// registry; it reads this document and hands it to `openapi-x-graphql`, which turns `operationId`
// into a field name, a component name into a type name and a `description` into a field
// description. So the parts that look cosmetic are the load-bearing ones, and a shortcut here
// becomes a missing or mis-named field in a generated client.
//
// `Operation.path` is stored in Bun.serve's syntax (`/v1/db/:db/api/:table`) because `src/http/`
// hands it to Bun unchanged. `templatePath` converts it to OpenAPI's `{db}` on the way out.
// **Nobody converts the other way.**
//
// Pure: a registry in, a JSON document out. No I/O, no Bun API, no `node:` import, and no route —
// `GET /v1/openapi.json` lives in `src/server/routes.ts`, which H6 owns.

import { keyword, type Operation, type Registry, type Schema } from "../core/index.ts"
import { errorBodySchema, reasonPhrase, statusForCode } from "./errors.ts"
import { Components, plain } from "./schemas.ts"
import type {
  ExternalDocumentationObject,
  HeaderObject,
  InfoObject,
  OpenApiDocument,
  OperationObject,
  ParameterLocation,
  ParameterObject,
  PathItemObject,
  PathsObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from "./types.ts"

/** The EdDSA JWT of design §6. */
export const BEARER_SCHEME = "bearerAuth"
/** The configured admin key, for the lifecycle routes of design §6.5. */
export const ADMIN_SCHEME = "adminKey"

const SECURITY_SCHEMES: Readonly<Record<string, SecuritySchemeObject>> = {
  [BEARER_SCHEME]: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "An Ed25519 (EdDSA) JWT minted by `POST /v1/tokens` (design §6). Its claims carry database " +
      "name globs in `p.ro` and `p.rw` and a per-table ACL in `t`, so what a token may do is " +
      "decided when it is minted and enforced by SQLite's own authorizer — never by anything the " +
      "request body says. `jti` allows revocation and `kid` key rotation.",
  },
  [ADMIN_SCHEME]: {
    type: "http",
    scheme: "bearer",
    description:
      "The node's configured admin key, presented as a bearer token, for the database lifecycle " +
      "routes of design §6.5. `Authenticator.authenticateToken` compares it before trying the " +
      "JWT key ring.",
  },
}

/**
 * Header parameters OpenAPI says "SHALL be ignored" when declared in `parameters`. `Authorization`
 * is what the security schemes describe; the other two are the content negotiation the media type
 * keys already state.
 */
const IGNORED_HEADERS = new Set(["authorization", "content-type", "accept"])

const DEFAULT_CONTENT_TYPE = "application/json"

export interface DocumentOptions {
  /** Default `"3.1.0"`. */
  openapi?: string
  /** Merged over `registry.info`'s title, version and description. */
  info?: Partial<InfoObject>
  /** Overrides `registry.info.servers`. */
  servers?: ServerObject[]
  /**
   * A prefix every path shares and the server URLs already carry, **removed** from the emitted
   * path keys — `Operation.path` is already absolute, so there is never a prefix to add. Given in
   * the emitted form: `basePath: "/v1/db/acme/api"` turns `/v1/db/acme/api/users` into `/users`,
   * which is what pairs with `createGraphQLSchema`'s `baseUrl`. An operation whose path does not
   * start with it is an error.
   */
  basePath?: string
  /** Descriptions for tags the operations use; any tag not named here is still emitted. */
  tags?: TagObject[]
  externalDocs?: ExternalDocumentationObject
  /** The component name for the error body. Default `"Error"`. */
  errorSchemaName?: string
}

/** `/v1/db/:db/api/:table` → `/v1/db/{db}/api/{table}`. The only conversion, and it is one-way. */
export function templatePath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      const found = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(segment)
      return found ? `{${found[1] as string}}` : segment
    })
    .join("/")
}

/** One OpenAPI 3.1 document describing every operation in `registry`. */
export function buildDocument(
  registry: Registry<any>,
  options: DocumentOptions = {},
): OpenApiDocument {
  const operations = registry.operations()
  const errorName = options.errorSchemaName ?? "Error"
  const components = new Components(errorName)

  const wantsErrors = operations.some((operation) => (operation.errors?.length ?? 0) > 0)
  if (wantsErrors) components.collect(errorBodySchema(errorName), "the error body")
  for (const operation of operations) {
    const origin = `operation "${operation.id}"`
    for (const root of rootsOf(operation)) components.collect(root, origin)
  }
  components.seal()

  const schemes = new Set<string>()
  const paths: PathsObject = {}
  for (const operation of operations) {
    const key = pathKey(operation, options.basePath)
    const item: PathItemObject = paths[key] ?? (paths[key] = {})
    item[operation.method] = operationObject(operation, components, errorName, wantsErrors, schemes)
  }

  const document: OpenApiDocument = {
    openapi: options.openapi ?? "3.1.0",
    info: infoObject(registry, options),
    paths,
  }

  const servers = options.servers ?? registry.info.servers?.map((one) => ({ ...one }))
  if (servers && servers.length > 0) document.servers = servers

  const tags = tagObjects(operations, options.tags)
  if (tags.length > 0) document.tags = tags
  if (options.externalDocs) document.externalDocs = { ...options.externalDocs }

  const schemas = components.definitions()
  const securitySchemes = schemeObjects(schemes)
  if (schemas || securitySchemes) {
    document.components = {}
    if (schemas) document.components.schemas = schemas
    if (securitySchemes) document.components.securitySchemes = securitySchemes
  }
  return document
}

function rootsOf(operation: Operation<any, any, any>): Schema[] {
  const out: Schema[] = []
  const { params, body, response } = operation
  if (params?.path) out.push(params.path)
  if (params?.query) out.push(params.query)
  if (params?.headers) out.push(params.headers)
  if (body?.schema) out.push(body.schema)
  out.push(response.schema)
  if (response.headers) out.push(response.headers)
  return out
}

function infoObject(registry: Registry<any>, options: DocumentOptions): InfoObject {
  const info: InfoObject = { title: registry.info.title, version: registry.info.version }
  if (registry.info.description) info.description = registry.info.description
  return { ...info, ...options.info }
}

function pathKey(operation: Operation<any, any, any>, basePath?: string): string {
  const templated = templatePath(operation.path)
  if (!basePath || basePath === "/") return templated
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath
  if (templated !== prefix && !templated.startsWith(`${prefix}/`)) {
    throw new Error(
      `openapi: operation "${operation.id}": "${templated}" does not start with the basePath ` +
        `"${prefix}"`,
    )
  }
  const rest = templated.slice(prefix.length)
  return rest.length === 0 ? "/" : rest
}

function operationObject(
  operation: Operation<any, any, any>,
  components: Components,
  errorName: string,
  wantsErrors: boolean,
  schemes: Set<string>,
): OperationObject {
  const out: OperationObject = { operationId: operation.id, responses: {} }
  if (operation.tags && operation.tags.length > 0) out.tags = [...operation.tags]
  if (operation.summary) out.summary = operation.summary
  if (operation.description) out.description = operation.description

  const parameters = parametersOf(operation, components)
  if (parameters.length > 0) out.parameters = parameters

  if (operation.body) {
    const contentType = operation.body.contentType ?? DEFAULT_CONTENT_TYPE
    const body: RequestBodyObject = {
      // A declared body is required unless the operation says otherwise: a generator turns that
      // into a non-null input argument, and "optional by default" would weaken every mutation.
      required: operation.body.required ?? true,
      content: { [contentType]: { schema: components.convert(operation.body.schema) } },
    }
    const description = keyword<string>(operation.body.schema, "description")
    if (description) body.description = description
    out.requestBody = body
  }

  out.responses = responsesOf(operation, components, errorName, wantsErrors)

  const security = securityOf(operation, schemes)
  if (security !== undefined) out.security = security
  return out
}

function parametersOf(
  operation: Operation<any, any, any>,
  components: Components,
): ParameterObject[] {
  const out: ParameterObject[] = []
  const { params } = operation
  if (!params) return out
  if (params.path) out.push(...parametersFrom(params.path, "path", components))
  if (params.query) out.push(...parametersFrom(params.query, "query", components))
  if (params.headers) out.push(...parametersFrom(params.headers, "header", components))
  return out
}

function parametersFrom(
  schema: Schema,
  where: ParameterLocation,
  components: Components,
): ParameterObject[] {
  const out: ParameterObject[] = []
  const properties = keyword<Record<string, Schema>>(schema, "properties")
  if (!properties) return out
  const required = keyword<string[]>(schema, "required") ?? []
  for (const name of Object.keys(properties)) {
    if (where === "header" && IGNORED_HEADERS.has(name.toLowerCase())) continue
    const child = properties[name] as Schema
    const parameter: ParameterObject = {
      name,
      in: where,
      // A path parameter cannot be absent; core's `Registry.add` already refuses one that is
      // optional, so this is the emitter agreeing rather than deciding.
      required: where === "path" ? true : required.includes(name),
      schema: components.convert(child),
    }
    decorate(parameter, child)
    out.push(parameter)
  }
  return out
}

/** Lifts the annotations a parameter or header object carries in its own right. */
function decorate(target: HeaderObject, schema: Schema): void {
  const description = keyword<string>(schema, "description")
  if (description) target.description = description
  if (keyword<boolean>(schema, "deprecated") === true) target.deprecated = true
  const examples = keyword<unknown[]>(schema, "examples")
  if (Array.isArray(examples) && examples.length === 1) target.example = plain(examples[0])
}

function responsesOf(
  operation: Operation<any, any, any>,
  components: Components,
  errorName: string,
  wantsErrors: boolean,
): ResponsesObject {
  const responses: ResponsesObject = {}
  const status = operation.response.status ?? 200
  const description =
    keyword<string>(operation.response.schema, "description") ?? reasonPhrase(status)
  const success: ResponseObject = { description }
  if (status !== 204) {
    const contentType = operation.response.contentType ?? DEFAULT_CONTENT_TYPE
    success.content = { [contentType]: { schema: components.convert(operation.response.schema) } }
  }
  if (operation.response.headers) {
    const headers = headersFrom(operation.response.headers, components)
    if (Object.keys(headers).length > 0) success.headers = headers
  }
  responses[String(status)] = success

  // Several codes share a status — 409 is `CONFLICT`, `RESET_REQUIRED`, `TX_BUSY` and every
  // `SQLITE_CONSTRAINT*` — and a responses object is keyed by status, so they collect into one
  // response that names all of them rather than fighting over the key.
  const byStatus = new Map<number, string[]>()
  for (const code of operation.errors ?? []) {
    const mapped = statusForCode(code)
    if (mapped === undefined) {
      throw new Error(
        `openapi: operation "${operation.id}": "${code}" is neither a BunQL error code in ` +
          `ERROR_STATUS nor a SQLite result code name, so src/server/errors.ts cannot say what ` +
          `status it answers with`,
      )
    }
    // A success response already owns that key; it is the stronger statement, so it stays.
    if (mapped === status) continue
    const codes = byStatus.get(mapped)
    if (codes === undefined) byStatus.set(mapped, [code])
    else if (!codes.includes(code)) codes.push(code)
  }
  if (byStatus.size > 0 && wantsErrors) {
    const body = components.reference(errorName)
    for (const mapped of [...byStatus.keys()].sort((a, b) => a - b)) {
      const codes = byStatus.get(mapped) as string[]
      responses[String(mapped)] = {
        description: `${reasonPhrase(mapped)}. \`error.code\` is ${nameList(codes)}.`,
        content: { [DEFAULT_CONTENT_TYPE]: { schema: body } },
      }
    }
  }
  return responses
}

function headersFrom(schema: Schema, components: Components): Record<string, HeaderObject> {
  const out: Record<string, HeaderObject> = {}
  const properties = keyword<Record<string, Schema>>(schema, "properties")
  if (!properties) return out
  const required = keyword<string[]>(schema, "required") ?? []
  for (const name of Object.keys(properties)) {
    if (name.toLowerCase() === "content-type") continue
    const child = properties[name] as Schema
    const header: HeaderObject = { required: required.includes(name), schema: components.convert(child) }
    decorate(header, child)
    out[name] = header
  }
  return out
}

function nameList(codes: string[]): string {
  const quoted = codes.map((code) => `\`${code}\``)
  if (quoted.length === 1) return quoted[0] as string
  return `one of ${quoted.join(", ")}`
}

/**
 * `undefined` when the operation says nothing, which is not the same statement as `"none"`:
 * `security: []` explicitly says this operation takes no credential, and a generated client is
 * entitled to believe it.
 */
function securityOf(
  operation: Operation<any, any, any>,
  schemes: Set<string>,
): SecurityRequirementObject[] | undefined {
  switch (operation.security) {
    case "bearer":
      schemes.add(BEARER_SCHEME)
      return [{ [BEARER_SCHEME]: [] }]
    case "admin":
      schemes.add(ADMIN_SCHEME)
      return [{ [ADMIN_SCHEME]: [] }]
    case "none":
      return []
    default:
      return undefined
  }
}

function schemeObjects(used: Set<string>): Record<string, SecuritySchemeObject> | undefined {
  if (used.size === 0) return undefined
  const out: Record<string, SecuritySchemeObject> = {}
  for (const name of [BEARER_SCHEME, ADMIN_SCHEME]) {
    if (used.has(name)) out[name] = { ...(SECURITY_SCHEMES[name] as SecuritySchemeObject) }
  }
  return out
}

function tagObjects(
  operations: Operation<any, any, any>[],
  described: TagObject[] | undefined,
): TagObject[] {
  const out: TagObject[] = []
  const seen = new Set<string>()
  for (const tag of described ?? []) {
    if (seen.has(tag.name)) continue
    seen.add(tag.name)
    out.push({ ...tag })
  }
  for (const operation of operations) {
    for (const name of operation.tags ?? []) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name })
    }
  }
  return out
}
