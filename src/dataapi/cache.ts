// Invariant: a cached schema is only ever served for the `PRAGMA schema_version` it was read at.
// That counter is SQLite's own, incremented by every DDL statement on the database, so a
// `CREATE TABLE`, an `ALTER TABLE` or a `DROP` invalidates the cache by itself and nothing else
// in BunQL has to remember to. The check costs one pragma per request — a prepared read on a
// pooled connection — against re-reading `table_list`, `table_xinfo`, `foreign_key_list`,
// `index_list` and `index_info` for every table.
//
// `invalidate` is here for the `schema` event `src/realtime/` already emits on DDL, which lets a
// caller drop the entry eagerly rather than at the next request. It is an optimisation, never the
// correctness story: the version check is.
//
// Introspection runs with the *server's* rights and its result is shared by every caller of that
// database, so nothing in a cached entry may depend on who asked. Per-request authority lives
// where it belongs, on the data statements, inside `src/server/exec.ts`.

import type { Registry } from "../core/index.ts"
import type { DataApiContext, Execute } from "./context.ts"
import { introspect, type IntrospectOptions, type TenantSchema } from "./introspect.ts"
import { dataApiRegistry, type DataApiOptions } from "./operations.ts"

export interface DataApiEntry {
  schema: TenantSchema
  registry: Registry<DataApiContext>
}

export interface DataApiCacheOptions extends DataApiOptions {
  introspect?: IntrospectOptions
}

interface Cached extends DataApiEntry {
  schemaVersion: number
}

/** A tenant's generated API, introspected once per schema version. */
export class DataApiCache {
  readonly #options: DataApiCacheOptions
  readonly #entries = new Map<string, Cached>()
  readonly #inflight = new Map<string, Promise<DataApiEntry>>()

  constructor(options: DataApiCacheOptions = {}) {
    this.#options = options
  }

  get size(): number {
    return this.#entries.size
  }

  /**
   * The schema and registry for `db`, re-introspected only when the database's schema has
   * changed. `exec` must carry the server's own rights — see the module header.
   */
  async for(db: string, exec: Execute): Promise<DataApiEntry> {
    const version = await schemaVersion(exec)
    const cached = this.#entries.get(db)
    if (cached && cached.schemaVersion === version) return cached
    // Two requests arriving on a cold cache introspect once between them, not once each.
    const pending = this.#inflight.get(db)
    if (pending) return pending
    const building = this.#build(db, exec, version)
    this.#inflight.set(db, building)
    try {
      return await building
    } finally {
      this.#inflight.delete(db)
    }
  }

  async #build(db: string, exec: Execute, version: number): Promise<DataApiEntry> {
    const schema = await introspect(db, exec, this.#options.introspect ?? {})
    const registry = dataApiRegistry(schema, this.#options)
    // `introspect` reads the version itself, and that read is the authoritative one: a DDL
    // statement between the check above and the read below would otherwise be cached under the
    // version it superseded.
    this.#entries.set(db, { schema, registry, schemaVersion: schema.schemaVersion })
    void version
    return { schema, registry }
  }

  invalidate(db: string): void {
    this.#entries.delete(db)
  }

  clear(): void {
    this.#entries.clear()
  }
}

/** `PRAGMA schema_version`, which SQLite bumps on every DDL statement. */
export async function schemaVersion(exec: Execute): Promise<number> {
  const result = await exec({ sql: "PRAGMA schema_version", args: [] })
  const row = result.rows[0]
  const value = Array.isArray(row) ? row[0] : (row as Record<string, unknown> | undefined)?.schema_version
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (value !== null && typeof value === "object" && typeof (value as { $i?: string }).$i === "string") {
    return Number((value as { $i: string }).$i)
  }
  return 0
}
