// PostgREST's URL grammar, one test per operator, against real rows. The operators are not
// interesting one at a time — they are interesting because the value on the right has to be bound
// as the thing its column stores, which is what a string comparison against an INTEGER column
// would silently get wrong.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ADMIN } from "../../src/server/auth.ts"
import type { Dispatcher } from "../../src/http/index.ts"
import { dataApiFixture, type DataApiFixture, read } from "./harness.ts"
import { stopAll } from "../server/harness.ts"

const SCHEMA = `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT,
    price REAL,
    stock INTEGER,
    tag BLOB
  );
  INSERT INTO items (id, name, tier, price, stock) VALUES (1, 'anvil', 'gold', 9.5, 3);
  INSERT INTO items (id, name, tier, price, stock) VALUES (2, 'Bolt', 'silver', 1.25, 40);
  INSERT INTO items (id, name, tier, price, stock) VALUES (3, 'crate', NULL, 20.0, 0);
  INSERT INTO items (id, name, tier, price, stock) VALUES (4, 'drum', 'gold', 4.0, 7)`

let fixture: DataApiFixture
let dispatch: Dispatcher

beforeAll(async () => {
  fixture = await dataApiFixture("filters", SCHEMA)
  dispatch = fixture.dispatchAs(ADMIN)
})

afterAll(async () => {
  await stopAll()
})

async function ids(query: string): Promise<number[]> {
  const response = await dispatch(`/v1/db/filters/api/items?${query}`)
  const { status, body } = await read<{ id: number }[]>(response)
  expect({ query, status }).toEqual({ query, status: 200 })
  return body.map((row) => row.id)
}

async function refuse(query: string): Promise<string> {
  const response = await dispatch(`/v1/db/filters/api/items?${query}`)
  const { status, body } = await read<{ error: { message: string } }>(response)
  expect({ query, status }).toEqual({ query, status: 400 })
  return body.error.message
}

describe("operators", () => {
  test("eq", async () => {
    expect(await ids("id=eq.2")).toEqual([2])
    expect(await ids("name=eq.anvil")).toEqual([1])
  })

  test("ne", async () => {
    expect(await ids("tier=ne.gold&select=id")).toEqual([2])
  })

  test("gt and gte", async () => {
    expect(await ids("stock=gt.7")).toEqual([2])
    expect(await ids("stock=gte.7")).toEqual([2, 4])
  })

  test("lt and lte", async () => {
    expect(await ids("price=lt.4")).toEqual([2])
    expect(await ids("price=lte.4")).toEqual([2, 4])
  })

  test("like, with * for %", async () => {
    expect(await ids("name=like.a*")).toEqual([1])
    expect(await ids("name=like.*r*")).toEqual([3, 4])
  })

  test("ilike, which SQLite's LIKE already is over ASCII", async () => {
    expect(await ids("name=ilike.b*")).toEqual([2])
    expect(await ids("name=like.b*")).toEqual([2])
  })

  test("in, with and without parentheses and with a quoted member", async () => {
    expect(await ids("id=in.(1,3)")).toEqual([1, 3])
    expect(await ids("id=in.2,4")).toEqual([2, 4])
    expect(await ids('tier=in.("gold")')).toEqual([1, 4])
  })

  test("is", async () => {
    expect(await ids("tier=is.null")).toEqual([3])
    expect(await ids("tier=is.not_null")).toEqual([1, 2, 4])
  })

  test("two filters are ANDed", async () => {
    expect(await ids("tier=eq.gold&stock=gt.5")).toEqual([4])
  })
})

describe("select, order, limit and offset", () => {
  test("select projects and rejects an unknown name", async () => {
    const response = await dispatch("/v1/db/filters/api/items?select=id,name&id=eq.1")
    const { body } = await read<Record<string, unknown>[]>(response)
    expect(body).toEqual([{ id: 1, name: "anvil" }])
    expect(await refuse("select=id,nope")).toContain("no column")
  })

  test("order, with direction and NULL placement", async () => {
    expect(await ids("order=price.desc")).toEqual([3, 1, 4, 2])
    expect(await ids("order=tier.asc.nullslast,id.asc")).toEqual([1, 4, 2, 3])
    expect(await ids("order=tier.asc.nullsfirst,id.asc")).toEqual([3, 1, 4, 2])
  })

  test("limit and offset", async () => {
    expect(await ids("order=id.asc&limit=2")).toEqual([1, 2])
    expect(await ids("order=id.asc&limit=2&offset=2")).toEqual([3, 4])
  })

  test("a limit above the maximum is a 400, and the document says what the maximum is", async () => {
    const small = await dataApiFixture("smalllimit", "CREATE TABLE t (id INTEGER PRIMARY KEY)", {
      maxLimit: 5,
      defaultLimit: 2,
    })
    try {
      const one = small.dispatchAs(ADMIN)
      expect((await read(await one("/v1/db/smalllimit/api/t?limit=6"))).status).toBe(400)
      expect((await read(await one("/v1/db/smalllimit/api/t?limit=5"))).status).toBe(200)
      expect((await read(await one("/v1/db/smalllimit/api/t?limit=0"))).status).toBe(400)
    } finally {
      await small.close()
    }
  })
})

describe("what the grammar refuses", () => {
  test("a value that cannot be what its column stores", async () => {
    expect(await refuse("id=gt.abc")).toContain("holds integers")
    expect(await refuse("price=lt.cheap")).toContain("holds numbers")
  })

  test("a BLOB column, which a URL has no honest spelling for", async () => {
    expect(await refuse("tag=eq.beef")).toContain("BLOB")
    // …except for the one question a URL can ask about bytes.
    expect(await ids("tag=is.null")).toEqual([1, 2, 3, 4])
  })

  test("an unknown operator names the ones it knows", async () => {
    expect(await refuse("name=contains.a")).toContain("eq, ne, gt, gte, lt, lte, like, ilike, in, is")
  })

  test("an is with something that is not null, not_null, true or false", async () => {
    expect(await refuse("tier=is.something")).toContain("is.null")
  })

  test("an empty in list", async () => {
    expect(await refuse("id=in.()")).toContain("names no values")
  })

  test("a column repeated in one query, which the declared parameter refuses", async () => {
    expect(await refuse("id=gt.1&id=lt.4")).toContain("expected a string, got an array")
  })

  test("an unknown query parameter on a single-row read", async () => {
    const response = await dispatch("/v1/db/filters/api/items/1?nope=1")
    expect((await read(response)).status).toBe(400)
  })
})
