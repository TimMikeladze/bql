// Invariant: the GraphQL schema is generated from **the same OpenAPI document the tenant's REST
// surface publishes**, not from a second description of the same tables. `src/openapi/` builds it
// out of H4's registry; this module only pins it to one tenant — a base path, a server URL, and
// the one edit below — so a field that exists in GraphQL is an operation that exists in REST, by
// construction rather than by review.
//
// The one edit: `basePath` strips `/v1/db/{db}/api` from every path key, because the base URL
// carries it (`docs/h3-openapi.md`). That leaves each operation declaring a `{db}` **path**
// parameter its own path no longer has. The generator would turn it into a required `db: String!`
// argument on every field — noise at best, and `buildRequest` would have nowhere to put it — so a
// path parameter the emitted path key does not mention is dropped here. Nothing else is touched:
// a query, header or cookie parameter is left exactly as published, and so is every schema.

import { buildDocument, templatePath } from "../openapi/index.ts"
import type {
  InfoObject,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ServerObject,
} from "../openapi/index.ts"
import type { Registry } from "../core/index.ts"

/** Where the data API is mounted, in `Bun.serve` syntax, as `src/dataapi/` generates it. */
export const DEFAULT_API_PREFIX = "/v1/db/:db/api"

/**
 * The origin an in-process request carries. It never reaches a socket — `createDispatcher`
 * resolves against its own `origin` and hands the `Request` to a function — but `buildRequest`
 * builds `new URL(baseUrl + path)`, which needs an absolute one.
 */
export const INTERNAL_ORIGIN = "http://bunql.internal"

const METHODS = ["get", "put", "post", "delete", "patch"] as const

export interface TenantDocumentOptions {
  /** Where `src/dataapi/` mounted this tenant's operations. Default `/v1/db/:db/api`. */
  apiPrefix?: string
  /** Origin of the server URL the document publishes. Default `http://bunql.internal`. */
  origin?: string
  /** Merged over the registry's own title, version and description. */
  info?: Partial<InfoObject>
}

/** `/v1/db/:db/api` + `acme` → `/v1/db/acme/api`, with the name percent-encoded as a segment. */
export function tenantPrefix(db: string, apiPrefix: string = DEFAULT_API_PREFIX): string {
  return apiPrefix
    .split("/")
    .map((segment) => (segment === ":db" ? encodeURIComponent(db) : segment))
    .join("/")
}

/** The absolute base URL a generated resolver dispatches against. */
export function tenantBaseUrl(
  db: string,
  apiPrefix: string = DEFAULT_API_PREFIX,
  origin: string = INTERNAL_ORIGIN,
): string {
  return `${origin.replace(/\/+$/, "")}${tenantPrefix(db, apiPrefix)}`
}

/**
 * One tenant's OpenAPI document, ready for `createGraphQLSchema`: paths relative to the tenant's
 * own prefix, one server URL carrying that prefix, and no `{db}` argument on every field.
 */
export function tenantDocument(
  db: string,
  registry: Registry<any>,
  options: TenantDocumentOptions = {},
): OpenApiDocument {
  const prefix = options.apiPrefix ?? DEFAULT_API_PREFIX
  const server: ServerObject = { url: tenantBaseUrl(db, prefix, options.origin) }
  const document = buildDocument(registry, {
    basePath: templatePath(prefix),
    servers: [server],
    ...(options.info ? { info: options.info } : {}),
  })
  for (const [key, item] of Object.entries(document.paths ?? {})) {
    dropAbsentPathParameters(key, item)
  }
  return document
}

/** A `path` parameter the emitted key does not mention is not a parameter of this document. */
function dropAbsentPathParameters(key: string, item: PathItemObject): void {
  const present = new Set(Array.from(key.matchAll(/\{([^}]+)\}/g), (found) => found[1] as string))
  const keep = (parameter: ParameterObject): boolean =>
    parameter.in !== "path" || present.has(parameter.name)
  for (const method of METHODS) {
    const operation = item[method] as OperationObject | undefined
    if (!operation?.parameters) continue
    operation.parameters = operation.parameters.filter(keep)
    if (operation.parameters.length === 0) delete operation.parameters
  }
  if (item.parameters) {
    item.parameters = item.parameters.filter(keep)
    if (item.parameters.length === 0) delete item.parameters
  }
}
