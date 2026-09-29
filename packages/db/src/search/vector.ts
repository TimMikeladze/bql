// Vector search over sqlite-vec's `vec0`, and hybrid search that fuses it with FTS5.
//
// Invariant: a vector crosses every boundary as vec0's own wire format — float32, little-endian,
// packed — whatever the host's byte order. `toVector` is the only place a JavaScript array becomes
// those bytes, so a vector written from a browser and one written from the embedded API are the
// same blob.

import { BqlClientError } from "../client/errors.ts"
import type { JsRow, JsValue } from "../client/values.ts"
import type { FtsIndex } from "./fts.ts"
import { ident, positiveInt, requireFeatures, run, runAll, type SearchDb } from "./run.ts"

/** vec0 refuses a larger `k`. */
const MAX_K = 4096

/** A vector as the helpers accept one. */
export type VectorInput = readonly number[] | Float32Array

/** Float32 little-endian, the vec0 wire format. */
export function toVector(values: VectorInput): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw BqlClientError.client(`vector component ${i} is ${v}, not a finite number`)
    }
    view.setFloat32(i * 4, v, true)
  }
  return out
}

/** The inverse of `toVector`. */
export function fromVector(blob: Uint8Array | ArrayBuffer): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  if (bytes.byteLength % 4 !== 0) {
    throw BqlClientError.client(`a float32 vector is a multiple of 4 bytes; got ${bytes.byteLength}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

export type VectorMetric = "cosine" | "l2" | "l1"
export type MetadataType = "integer" | "float" | "text" | "boolean"
export type MetadataValue = string | number | boolean | null

/** A filter on one metadata column: a value means equality. Runs inside the KNN, not after it. */
export type MetadataFilter =
  | MetadataValue
  | { ne?: MetadataValue; gt?: number | string; gte?: number | string; lt?: number | string; lte?: number | string }

export interface VectorIndexOptions {
  /** The vec0 virtual table. */
  table: string
  dimensions: number
  /** Default `"cosine"`. */
  metric?: VectorMetric
  /** vec0 metadata columns: filterable inside the KNN. */
  metadata?: Record<string, MetadataType>
  /** The key column's type. Default `"integer"`, which is what `hybridSearch` joins on. */
  id?: "integer" | "text"
}

export interface VectorSearchOptions {
  /** Neighbours to return. Default 10, at most 4096. */
  k?: number
  where?: Record<string, MetadataFilter>
}

/** One neighbour: its id, its distance under the index's metric, and its metadata columns. */
export type VectorMatch = { id: number | string; distance: number } & Record<string, JsValue>

const METRIC: Record<VectorMetric, string> = { cosine: "cosine", l2: "L2", l1: "L1" }
const OPS = { ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const

export class VectorIndex {
  readonly table: string
  readonly dimensions: number
  readonly metric: VectorMetric
  readonly idType: "integer" | "text"
  readonly metadata: Readonly<Record<string, MetadataType>>
  readonly #db: SearchDb
  readonly #t: string

  constructor(db: SearchDb, options: VectorIndexOptions) {
    this.#db = db
    this.#t = ident(options.table, "table")
    this.table = options.table
    this.dimensions = positiveInt(options.dimensions, "dimensions", 8192)
    this.metric = options.metric ?? "cosine"
    if (!(this.metric in METRIC)) {
      throw BqlClientError.client(`metric must be one of ${Object.keys(METRIC).join(", ")}`)
    }
    this.idType = options.id ?? "integer"
    if (this.idType !== "integer" && this.idType !== "text") {
      throw BqlClientError.client('id must be "integer" or "text"')
    }
    const metadata: Record<string, MetadataType> = {}
    for (const [name, type] of Object.entries(options.metadata ?? {})) {
      ident(name, "metadata column")
      if (["id", "embedding", "distance", "k"].includes(name.toLowerCase())) {
        throw BqlClientError.client(`metadata column ${JSON.stringify(name)} collides with a vec0 column`)
      }
      if (!["integer", "float", "text", "boolean"].includes(type)) {
        throw BqlClientError.client(`metadata column ${name} has unknown type ${JSON.stringify(type)}`)
      }
      metadata[name] = type
    }
    this.metadata = metadata
  }

  /** The `CREATE VIRTUAL TABLE` this index is. */
  get ddl(): string {
    const columns = [
      `id ${this.idType} primary key`,
      `embedding float[${this.dimensions}] distance_metric=${METRIC[this.metric]}`,
      // vec0 parses its column list itself and does not accept a quoted name; `ident` has
      // already held each to a plain identifier.
      ...Object.entries(this.metadata).map(([name, type]) => `${name} ${type}`),
    ]
    return `create virtual table if not exists ${this.#t} using vec0(${columns.join(", ")})`
  }

  async create(): Promise<void> {
    await requireFeatures(this.#db, "vec")
    await run(this.#db, this.ddl)
  }

  async drop(): Promise<void> {
    await run(this.#db, `drop table if exists ${this.#t}`)
  }

  /**
   * Inserts or replaces one vector. vec0 has no upsert, so this is a delete and an insert in one
   * batch — atomic on anything with `batch`.
   */
  async upsert(id: number | string, vector: VectorInput, metadata: Record<string, MetadataValue> = {}): Promise<void> {
    const key = this.#key(id)
    const names = Object.keys(metadata)
    for (const name of names) this.#column(name)
    const columns = ["id", "embedding", ...names.map((n) => ident(n))]
    const values = [key, this.#vector(vector), ...names.map((n) => bindable(metadata[n] ?? null))]
    await runAll(this.#db, [
      { sql: `delete from ${this.#t} where id = ?`, args: [key] },
      {
        sql: `insert into ${this.#t}(${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
        args: values,
      },
    ])
  }

  async delete(id: number | string): Promise<void> {
    await run(this.#db, `delete from ${this.#t} where id = ?`, [this.#key(id)])
  }

  /** The `k` nearest neighbours of `vector`, nearest first. */
  async search(vector: VectorInput, options: VectorSearchOptions = {}): Promise<VectorMatch[]> {
    const k = positiveInt(options.k ?? 10, "k", MAX_K)
    const args: unknown[] = [this.#vector(vector), k]
    const where = ["embedding match ?", "k = ?"]
    for (const [name, filter] of Object.entries(options.where ?? {})) {
      const column = this.#column(name)
      if (filter !== null && typeof filter === "object") {
        for (const [op, value] of Object.entries(filter)) {
          const sqlOp = OPS[op as keyof typeof OPS]
          if (!sqlOp) throw BqlClientError.client(`unknown filter operator ${JSON.stringify(op)} on ${name}`)
          where.push(`${column} ${sqlOp} ?`)
          args.push(bindable(value as MetadataValue))
        }
      } else {
        where.push(`${column} = ?`)
        args.push(bindable(filter))
      }
    }
    const metadata = Object.keys(this.metadata).map((n) => `, ${ident(n)}`).join("")
    const rows = await run(
      this.#db,
      `select id, distance${metadata} from ${this.#t} where ${where.join(" and ")} order by distance`,
      args,
    )
    return rows as VectorMatch[]
  }

  #vector(vector: VectorInput): Uint8Array {
    if (vector.length !== this.dimensions) {
      throw BqlClientError.client(
        `${this.table} holds ${this.dimensions}-dimensional vectors; got ${vector.length}`,
      )
    }
    return toVector(vector)
  }

  #key(id: number | string): number | string {
    if (this.idType === "integer" ? Number.isSafeInteger(id) : typeof id === "string") return id
    throw BqlClientError.client(`${this.table} is keyed by ${this.idType}; got ${JSON.stringify(id)}`)
  }

  #column(name: string): string {
    if (!Object.hasOwn(this.metadata, name)) {
      throw BqlClientError.client(`${this.table} has no metadata column ${JSON.stringify(name)}`)
    }
    return ident(name)
  }
}

export function vectorIndex(db: SearchDb, options: VectorIndexOptions): VectorIndex {
  return new VectorIndex(db, options)
}

function bindable(value: MetadataValue | undefined): string | number | null {
  if (value === undefined || value === null) return null
  if (typeof value === "boolean") return value ? 1 : 0
  return value
}

// ── hybrid ─────────────────────────────────────────────────────────────────────────────────────

export interface HybridSearchOptions {
  /** The FTS5 index, or its table name. Its rowids must be the vector index's ids. */
  fts: FtsIndex | string
  /** The vec0 index (integer ids), or its table name. */
  vector: VectorIndex | string
  /** An FTS5 query. Untrusted text goes through `ftsQuote` first. */
  query: string
  embedding: VectorInput
  /** Results to return. Default 10. */
  k?: number
  /**
   * How many of each leg's best go into the fusion. Default `4 * k`, at most 4096. A document
   * outside both legs' candidates cannot be returned, however well it would have fused.
   */
  candidates?: number
  /** Multipliers on each leg's reciprocal rank. Default 1 and 1. */
  weights?: { fts?: number; vector?: number }
}

export interface HybridMatch {
  id: number
  /** Σ weight / (60 + rank) over the legs that found it. Higher is better. */
  score: number
  /** 1-based position in the FTS leg, or null when that leg did not return it. */
  ftsRank: number | null
  vectorRank: number | null
  /** FTS5's bm25 (lower is better), when the FTS leg found it. */
  bm25: number | null
  /** Distance under the vector index's metric, when the vector leg found it. */
  distance: number | null
}

/** The reciprocal-rank-fusion constant from Cormack et al. (2009); every hybrid engine uses 60. */
const RRF_K = 60

/**
 * One statement: an FTS5 leg ranked by bm25 and a vec0 KNN leg ranked by distance, fused by
 * reciprocal rank. A document found by both legs outranks one found by either alone, and neither
 * leg's raw scores have to be comparable — which is why RRF rather than a weighted sum.
 */
export async function hybridSearch(db: SearchDb, options: HybridSearchOptions): Promise<HybridMatch[]> {
  const k = positiveInt(options.k ?? 10, "k", MAX_K)
  const candidates = positiveInt(options.candidates ?? Math.min(MAX_K, k * 4), "candidates", MAX_K)
  const fts = ident(typeof options.fts === "string" ? options.fts : options.fts.table, "fts table")
  const vec = options.vector
  if (typeof vec !== "string" && vec.idType !== "integer") {
    throw BqlClientError.client("hybridSearch joins on integer ids; this vector index is keyed by text")
  }
  const vectorTable = ident(typeof vec === "string" ? vec : vec.table, "vector table")
  if (typeof vec !== "string" && options.embedding.length !== vec.dimensions) {
    throw BqlClientError.client(
      `${vec.table} holds ${vec.dimensions}-dimensional vectors; got ${options.embedding.length}`,
    )
  }
  const weight = (w: number | undefined, name: string) => {
    const value = w ?? 1
    if (!Number.isFinite(value) || value < 0) throw BqlClientError.client(`weights.${name} must be >= 0`)
    return value
  }
  const sql = `with
  f as (
    select rowid as id, rank as bm25, row_number() over (order by rank) as r
    from ${fts} where ${fts} match ?1 order by rank limit ?3
  ),
  v as (
    select id, distance, row_number() over (order by distance) as r
    from ${vectorTable} where embedding match ?2 and k = ?3
  ),
  u as (
    select id, ?4 / (${RRF_K}.0 + r) as s, r as fr, null as vr, bm25, null as distance from f
    union all
    select id, ?5 / (${RRF_K}.0 + r), null, r, null, distance from v
  )
select id, sum(s) as score, max(fr) as ftsRank, max(vr) as vectorRank,
       max(bm25) as bm25, max(distance) as distance
from u group by id order by score desc, id limit ?6`
  const rows: JsRow[] = await run(db, sql, [
    options.query,
    toVector(options.embedding),
    candidates,
    weight(options.weights?.fts, "fts"),
    weight(options.weights?.vector, "vector"),
    k,
  ])
  return rows as unknown as HybridMatch[]
}
