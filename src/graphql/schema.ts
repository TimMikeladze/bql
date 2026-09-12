// Invariant: one schema per tenant per `PRAGMA schema_version`, and **nothing cached here knows
// who asked.** The schema, its resolvers and the dispatcher behind them are shared by every caller
// of a database; the caller's rights arrive through `src/graphql/ambient.ts` on each dispatch. See
// that module for why a captured token would be a privilege escalation rather than an
// optimisation.
//
// The version key is `src/dataapi/`'s, not a second one: `DataApiCache.for` already reads
// `PRAGMA schema_version` and re-introspects when it moved, so this cache asks it for the entry
// and reuses its schema's version as the key. A `CREATE TABLE`, an `ALTER TABLE` or a `DROP`
// therefore rebuilds the GraphQL schema by itself, and there is no second idea anywhere in BunQL
// of when a tenant's schema changed. Pass the server's own `DataApiCache` and one introspection
// serves REST, OpenAPI and GraphQL between them.
//
// Bounded: `maxSchemas` tenants, least recently used dropped, and `invalidate(db)` for a database
// that was deleted or closed — a generated schema holds its tenant's registry and dispatcher
// alive, so an unbounded map would be a leak the size of the catalog.

import type { Registry } from "../core/index.ts"
import type { DataApiContext, Execute } from "../dataapi/index.ts"
import { DataApiCache } from "../dataapi/index.ts"
import { createDispatcher, type Dispatcher } from "../http/index.ts"
import type { InfoObject, OpenApiDocument } from "../openapi/index.ts"
import type { GraphQLSchema } from "graphql"
import type { CreateSchemaOptions, OpenApiSource } from "openapi-x-graphql"
import { currentCall } from "./ambient.ts"
import { nullOnNotFound } from "./errors.ts"
import {
  DEFAULT_API_PREFIX,
  INTERNAL_ORIGIN,
  tenantBaseUrl,
  tenantDocument,
} from "./document.ts"
import { loadPeers, type PeerLoaders } from "./peers.ts"

/** Tenants whose schema is kept. */
export const DEFAULT_MAX_SCHEMAS = 64

export interface SchemaOptions {
  /**
   * An `Execute` with the **server's own rights**, for introspection only. Its result is cached
   * and shared by every caller of that database, so it must not be the caller's — see the header
   * of `src/dataapi/cache.ts`.
   */
  introspect: (db: string) => Execute | Promise<Execute>
  /** The data API cache to share with the REST surface. One is created per `SchemaCache` if absent. */
  cache?: DataApiCache
  /** Where the data API is mounted, in `Bun.serve` syntax. Must match the cache's own prefix. */
  apiPrefix?: string
  /** Origin an in-process request carries. Never reaches a socket. */
  origin?: string
  /** Merged over the generated document's title, version and description. */
  info?: Partial<InfoObject>
  /** Tenants kept. Default 64, least recently used dropped. */
  maxSchemas?: number
  /** How `graphql` and `openapi-x-graphql` are resolved. Default `import()`. */
  peers?: PeerLoaders
  /** Passed to `createGraphQLSchema`. `baseUrl` and `fetch` are this module's and are not taken. */
  generator?: Omit<CreateSchemaOptions, "baseUrl" | "fetch">
  /** Reports a dispatch failure the client was told nothing about. Default `console.error`. */
  onError?: (err: unknown) => void
}

/** One tenant's generated GraphQL, and the pieces it was generated from. */
export interface TenantGraphQL {
  readonly db: string
  /** `PRAGMA schema_version` this was built at. */
  readonly schemaVersion: number
  readonly schema: GraphQLSchema
  /** The OpenAPI document it was generated from — the same one the REST surface publishes. */
  readonly document: OpenApiDocument
  /** The in-process `fetch` its resolvers dispatch through. */
  readonly dispatch: Dispatcher
  /** What the generator could not represent. Empty for a document `src/openapi/` built. */
  readonly warnings: readonly string[]
}

/** A tenant's GraphQL schema, generated once per schema version. */
export class SchemaCache {
  readonly #options: SchemaOptions
  readonly #data: DataApiCache
  readonly #tenants = new Map<string, TenantGraphQL>()
  readonly #inflight = new Map<string, Promise<TenantGraphQL>>()
  readonly #max: number

  constructor(options: SchemaOptions) {
    this.#options = options
    this.#data =
      options.cache ?? new DataApiCache({ prefix: options.apiPrefix ?? DEFAULT_API_PREFIX })
    this.#max = Math.max(1, options.maxSchemas ?? DEFAULT_MAX_SCHEMAS)
  }

  get size(): number {
    return this.#tenants.size
  }

  /** The schema for `db`, rebuilt only when that database's `PRAGMA schema_version` has moved. */
  async for(db: string): Promise<TenantGraphQL> {
    const exec = await this.#options.introspect(db)
    const entry = await this.#data.for(db, exec)
    const version = entry.schema.schemaVersion
    const cached = this.#tenants.get(db)
    if (cached && cached.schemaVersion === version) {
      // Most recently used, so the eviction below drops a tenant nobody is asking for.
      this.#tenants.delete(db)
      this.#tenants.set(db, cached)
      return cached
    }
    // Two requests arriving on a cold cache generate one schema between them, not one each.
    const pending = this.#inflight.get(db)
    if (pending) return pending
    const building = this.#build(db, entry.registry, version)
    this.#inflight.set(db, building)
    try {
      return await building
    } finally {
      this.#inflight.delete(db)
    }
  }

  async #build(
    db: string,
    registry: Registry<DataApiContext>,
    version: number,
  ): Promise<TenantGraphQL> {
    const peers = await loadPeers(this.#options.peers)
    const prefix = this.#options.apiPrefix ?? DEFAULT_API_PREFIX
    const origin = this.#options.origin ?? INTERNAL_ORIGIN
    const document = tenantDocument(db, registry, {
      apiPrefix: prefix,
      origin,
      ...(this.#options.info ? { info: this.#options.info } : {}),
    })
    const onError = this.#options.onError
    const dispatch = createDispatcher(registry, () => contextFor(db), {
      origin,
      ...(onError ? { onError: (err: unknown) => onError(err) } : {}),
    })
    const { schema, warnings } = await peers.openapi.createGraphQLSchema(
      document as unknown as OpenApiSource,
      {
        ...this.#options.generator,
        baseUrl: tenantBaseUrl(db, prefix, origin),
        // Bun's `typeof fetch` also carries `preconnect`, which a dispatcher has no use for and
        // the generator never reaches for: `executeOperation` calls the function and nothing else.
        // `nullOnNotFound` is the one edit: a missing row is `null` in GraphQL, not an error.
        fetch: nullOnNotFound(dispatch) as unknown as typeof globalThis.fetch,
      },
    )
    const built: TenantGraphQL = { db, schemaVersion: version, schema, document, dispatch, warnings }
    this.#tenants.delete(db)
    this.#tenants.set(db, built)
    while (this.#tenants.size > this.#max) {
      const oldest = this.#tenants.keys().next()
      if (oldest.done) break
      this.#tenants.delete(oldest.value)
    }
    return built
  }

  /** Drops a tenant — a database that was deleted or closed keeps nothing alive. */
  invalidate(db: string): void {
    this.#tenants.delete(db)
    this.#data.invalidate(db)
  }

  clear(): void {
    this.#tenants.clear()
    this.#data.clear()
  }
}

/**
 * The context one dispatch runs in: **read** from the ambient store, never captured. A dispatch
 * for the wrong database means a cached dispatcher was reached from another tenant's call, which
 * would be a rights mix-up rather than a routing mistake — so it is refused loudly.
 */
function contextFor(db: string): DataApiContext {
  const call = currentCall()
  if (call.db !== db) {
    throw new Error(
      `bunql/graphql: a resolver for database ${JSON.stringify(db)} dispatched inside a request ` +
        `for ${JSON.stringify(call.db)}`,
    )
  }
  return call.context
}

/**
 * One tenant's schema, built now. `graphqlHandler` caches; this is for a tool or a test that wants
 * the SDL, and for a server that means to build a schema eagerly.
 */
export async function schemaFor(db: string, options: SchemaOptions): Promise<GraphQLSchema> {
  return (await new SchemaCache(options).for(db)).schema
}
