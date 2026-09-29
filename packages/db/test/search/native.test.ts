// `scripts/native/ext.c`: registered on every connection, and the geo functions it adds are right.
//
// `docs/x1-search.md`.

import { describe, expect, test } from "bun:test"
import { Database, sqlite } from "../../src/sqlite/index.ts"

const features = sqlite().features

describe.if(features.vec && features.geo)("ext.c", () => {
  test("every new connection has sqlite-vec and the geo functions without loading anything", () => {
    const db = Database.open(":memory:")
    const row = db.prepare("select vec_version() as v, bql_haversine(0, 0, 0, 0) as d").get()
    expect(String(row?.v)).toStartWith("v0.")
    expect(row?.d).toBe(0)
    db.close()
  })

  test("haversine gives the textbook distance and NULL for an unknown", () => {
    const db = Database.open(":memory:")
    // Big Ben to the Statue of Liberty: 5,574.8 km on the mean-radius sphere.
    const far = db.prepare("select bql_haversine(51.5007, -0.1246, 40.6892, -74.0445) as d").get()
    expect(Number(far?.d) / 1000).toBeCloseTo(5574.8, 0)
    // One degree of latitude is 111.195 km on that sphere.
    const degree = db.prepare("select bql_haversine(0, 0, 1, 0) as d").get()
    expect(Number(degree?.d)).toBeCloseTo(111_195.08, 0)
    // Antipodes: rounding must not push asin past its domain into NaN.
    const antipodal = db.prepare("select bql_haversine(0, 0, 0, 180) as d").get()
    expect(Number(antipodal?.d)).toBeCloseTo(Math.PI * 6_371_008.8, 0)
    expect(db.prepare("select bql_haversine(null, 0, 0, 0) as d").get()?.d).toBeNull()
    db.close()
  })

  test("the bbox contains the circle, and gives up the longitude range at a pole or the antimeridian", () => {
    const db = Database.open(":memory:")
    const box = (lat: number, lon: number, r: number) =>
      db
        .prepare(
          "select bql_bbox_min_lat(?1, ?2, ?3) a, bql_bbox_max_lat(?1, ?2, ?3) b, " +
            "bql_bbox_min_lon(?1, ?2, ?3) c, bql_bbox_max_lon(?1, ?2, ?3) d",
        )
        .get(lat, lon, r) as { a: number; b: number; c: number; d: number }

    const london = box(51.5, -0.12, 10_000)
    // The four edge midpoints of a 10 km circle are each 10 km away, so they sit on the box.
    const edge = (lat: number, lon: number) =>
      Number(db.prepare("select bql_haversine(51.5, -0.12, ?, ?) as d").get(lat, lon)?.d)
    expect(edge(london.a, -0.12)).toBeCloseTo(10_000, 0)
    expect(edge(london.b, -0.12)).toBeCloseTo(10_000, 0)
    // At the longitude edge the circle's tangent point is at a slightly different latitude, so
    // the edge at the centre's latitude is at least the radius away — never inside the circle.
    expect(edge(51.5, london.c)).toBeGreaterThanOrEqual(9_999)
    expect(london.d - -0.12).toBeCloseTo(-0.12 - london.c, 9)

    expect(box(89.99, 10, 5_000)).toMatchObject({ b: 90, c: -180, d: 180 })
    expect(box(0, 179.99, 5_000)).toMatchObject({ c: -180, d: 180 })
    db.close()
  })
})
