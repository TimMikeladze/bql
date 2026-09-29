// Points and radius queries over an R*Tree, with bql.sh's C geo functions doing the exact part.
//
// Invariant: the R*Tree is a prefilter, never the answer. It stores coordinates as float32 and
// rounds each box outward, and its box around a circle is a superset of the circle; `near`
// always finishes with `bql_haversine` on the exact coordinates, kept beside each box as R*Tree
// auxiliary columns, so a point is returned exactly when its great-circle distance is within the
// radius.

import { BqlClientError } from "../client/errors.ts"
import { ident, positiveInt, requireFeatures, run, runAll, type SearchDb } from "./run.ts"

export interface GeoIndexOptions {
  /** The R*Tree virtual table. */
  table: string
  /**
   * A table with latitude/longitude columns to index. Triggers keep the index in step; a row
   * with either coordinate NULL is simply not in it.
   */
  source?: string
  /** Default `"lat"`. */
  lat?: string
  /** Default `"lon"`. */
  lon?: string
  /** The source's integer key, which becomes the point's id. Default `"rowid"`. */
  sourceKey?: string
}

export interface BoundingBox {
  minLat: number
  maxLat: number
  /** A box with `minLon > maxLon` crosses the antimeridian. */
  minLon: number
  maxLon: number
}

export interface GeoPoint {
  id: number
  lat: number
  lon: number
}

export interface GeoNear extends GeoPoint {
  /** Metres, great-circle. */
  distance: number
}

export class GeoIndex {
  readonly table: string
  readonly source: string | null
  readonly #db: SearchDb
  readonly #t: string
  readonly #lat: string
  readonly #lon: string
  readonly #key: string

  constructor(db: SearchDb, options: GeoIndexOptions) {
    this.#db = db
    this.#t = ident(options.table, "table")
    this.table = options.table
    this.source = options.source ?? null
    if (this.source !== null) ident(this.source, "source table")
    this.#lat = ident(options.lat ?? "lat", "lat column")
    this.#lon = ident(options.lon ?? "lon", "lon column")
    const key = options.sourceKey ?? "rowid"
    this.#key = key === "rowid" ? "rowid" : ident(key, "sourceKey")
  }

  get ddl(): string[] {
    const out = [
      `create virtual table if not exists ${this.#t} using rtree(id, minLat, maxLat, minLon, maxLon, +lat, +lon)`,
    ]
    if (this.source === null) return out
    const src = ident(this.source)
    const add = (row: "new") =>
      `insert into ${this.#t}(id, minLat, maxLat, minLon, maxLon, lat, lon) ` +
      `select ${row}.${this.#key}, ${row}.${this.#lat}, ${row}.${this.#lat}, ${row}.${this.#lon}, ` +
      `${row}.${this.#lon}, ${row}.${this.#lat}, ${row}.${this.#lon} ` +
      `where ${row}.${this.#lat} is not null and ${row}.${this.#lon} is not null;`
    const remove = `delete from ${this.#t} where id = old.${this.#key};`
    const trigger = (suffix: string) => ident(`${this.table}_${suffix}`, "trigger")
    const keyed = this.#key === "rowid" ? "" : `${this.#key}, `
    out.push(
      `create trigger if not exists ${trigger("ai")} after insert on ${src} begin ${add("new")} end`,
      `create trigger if not exists ${trigger("ad")} after delete on ${src} begin ${remove} end`,
      `create trigger if not exists ${trigger("au")} after update of ${keyed}${this.#lat}, ${this.#lon} ` +
        `on ${src} begin ${remove} ${add("new")} end`,
    )
    return out
  }

  /** Creates the index; with `source`, filled from the source's existing rows the first time. */
  async create(): Promise<void> {
    await requireFeatures(this.#db, "rtree", "geo")
    const statements = this.ddl.map((sql) => ({ sql }))
    if (this.source !== null) {
      const exists = await run(this.#db, "select 1 from sqlite_schema where type = 'table' and name = ?", [
        this.table,
      ])
      if (exists.length === 0) statements.push({ sql: this.#fillSql() })
    }
    await runAll(this.#db, statements)
  }

  async drop(): Promise<void> {
    const statements = [{ sql: `drop table if exists ${this.#t}` }]
    if (this.source !== null) {
      for (const suffix of ["ai", "ad", "au"]) {
        statements.push({ sql: `drop trigger if exists ${ident(`${this.table}_${suffix}`)}` })
      }
    }
    await runAll(this.#db, statements)
  }

  /** Empties the index and refills it from the source table. */
  async rebuild(): Promise<void> {
    if (this.source === null) throw BqlClientError.client(`${this.table} has no source to rebuild from`)
    await runAll(this.#db, [{ sql: `delete from ${this.#t}` }, { sql: this.#fillSql() }])
  }

  /** Adds or moves a point. Only for an index without `source`; that one follows its table. */
  async upsert(id: number, lat: number, lon: number): Promise<void> {
    this.#standalone("upsert")
    checkPoint(lat, lon)
    const key = this.#id(id)
    await runAll(this.#db, [
      { sql: `delete from ${this.#t} where id = ?`, args: [key] },
      {
        sql: `insert into ${this.#t}(id, minLat, maxLat, minLon, maxLon, lat, lon) values (?, ?, ?, ?, ?, ?, ?)`,
        args: [key, lat, lat, lon, lon, lat, lon],
      },
    ])
  }

  async delete(id: number): Promise<void> {
    this.#standalone("delete")
    await run(this.#db, `delete from ${this.#t} where id = ?`, [this.#id(id)])
  }

  /** Every point inside the box. */
  async within(box: BoundingBox, options: { limit?: number } = {}): Promise<GeoPoint[]> {
    const { minLat, maxLat, minLon, maxLon } = box
    for (const [name, v] of Object.entries({ minLat, maxLat, minLon, maxLon })) {
      if (typeof v !== "number" || !Number.isFinite(v)) throw BqlClientError.client(`${name} must be a finite number`)
    }
    const limit = positiveInt(options.limit ?? 1000, "limit", 1_000_000)
    // An antimeridian box is two longitude ranges. R*Tree cannot use an OR, so that one query
    // scans the latitude band — correct, and rare enough not to be worth two statements.
    const lon =
      minLon <= maxLon ? "maxLon >= ?3 and minLon <= ?4" : "(maxLon >= ?3 or minLon <= ?4)"
    const rows = await run(
      this.#db,
      `select id, lat, lon from ${this.#t} where maxLat >= ?1 and minLat <= ?2 and ${lon} limit ?5`,
      [minLat, maxLat, minLon, maxLon, limit],
    )
    return rows as unknown as GeoPoint[]
  }

  /** Points within `radiusM` metres of (lat, lon), nearest first. */
  async near(lat: number, lon: number, radiusM: number, options: { limit?: number } = {}): Promise<GeoNear[]> {
    checkPoint(lat, lon)
    if (typeof radiusM !== "number" || !Number.isFinite(radiusM) || radiusM < 0) {
      throw BqlClientError.client("radius must be a finite number of metres, >= 0")
    }
    const limit = positiveInt(options.limit ?? 100, "limit", 1_000_000)
    const rows = await run(
      this.#db,
      `select id, lat, lon, distance from (
         select id, lat, lon, bql_haversine(?1, ?2, lat, lon) as distance from ${this.#t}
         where maxLat >= bql_bbox_min_lat(?1, ?2, ?3) and minLat <= bql_bbox_max_lat(?1, ?2, ?3)
           and maxLon >= bql_bbox_min_lon(?1, ?2, ?3) and minLon <= bql_bbox_max_lon(?1, ?2, ?3)
       ) where distance <= ?3 order by distance, id limit ?4`,
      [lat, lon, radiusM, limit],
    )
    return rows as unknown as GeoNear[]
  }

  #fillSql(): string {
    const src = ident(this.source as string)
    const [k, la, lo] = [this.#key, this.#lat, this.#lon]
    return (
      `insert into ${this.#t}(id, minLat, maxLat, minLon, maxLon, lat, lon) ` +
      `select ${k}, ${la}, ${la}, ${lo}, ${lo}, ${la}, ${lo} from ${src} ` +
      `where ${la} is not null and ${lo} is not null`
    )
  }

  #standalone(what: string): void {
    if (this.source !== null) {
      throw BqlClientError.client(
        `${this.table} follows ${this.source} through triggers; write to ${this.source} instead of calling ${what}()`,
      )
    }
  }

  #id(id: number): number {
    if (!Number.isSafeInteger(id)) throw BqlClientError.client(`id must be an integer, got ${id}`)
    return id
  }
}

export function geoIndex(db: SearchDb, options: GeoIndexOptions): GeoIndex {
  return new GeoIndex(db, options)
}

function checkPoint(lat: number, lon: number): void {
  if (typeof lat !== "number" || !(lat >= -90 && lat <= 90)) {
    throw BqlClientError.client(`latitude must be within [-90, 90], got ${lat}`)
  }
  if (typeof lon !== "number" || !(lon >= -180 && lon <= 180)) {
    throw BqlClientError.client(`longitude must be within [-180, 180], got ${lon}`)
  }
}
