// What the generator makes of a real tenant's document, and when the schema is rebuilt. The cache
// key is `src/dataapi/`'s `PRAGMA schema_version` and nothing else, so the two tests that matter
// are: nothing changed, same schema object; a `CREATE TABLE`, a new one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { loadPeers, SchemaCache } from "../../src/graphql/index.ts"
import { graphqlFixture, type GraphQLFixture } from "./harness.ts"
import { stopAll } from "../server/harness.ts"

const SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, total REAL);
  INSERT INTO users (id, name, email) VALUES (1, 'ann', 'ann@example.com')`

let fixture: GraphQLFixture
let schemas: SchemaCache

beforeAll(async () => {
  fixture = await graphqlFixture("gqlschema", SCHEMA)
  schemas = new SchemaCache({ introspect: () => fixture.data.admin })
})

afterAll(async () => {
  await stopAll()
})

describe("the generated schema", () => {
  test("one field per generated operation, and the generator dropped nothing", async () => {
    const tenant = await schemas.for(fixture.db)
    expect(tenant.warnings).toEqual([])
    const query = Object.keys(tenant.schema.getQueryType()?.getFields() ?? {})
    const mutation = Object.keys(tenant.schema.getMutationType()?.getFields() ?? {})
    expect(query).toEqual(
      expect.arrayContaining(["listOrders", "getOrder", "listUsers", "getUser"]),
    )
    expect(mutation.sort()).toEqual([
      "createOrder",
      "createUser",
      "deleteOrder",
      "deleteUser",
      "updateOrder",
      "updateUser",
    ])
  })

  test("the tenant is in the base URL, so no field takes a `db` argument", async () => {
    const tenant = await schemas.for(fixture.db)
    const fields = tenant.schema.getQueryType()?.getFields() ?? {}
    for (const field of Object.values(fields)) {
      expect(field.args.map((arg) => `${field.name}.${arg.name}`)).not.toContain(`${field.name}.db`)
    }
    // And the document it was generated from says the same: the path key carries no `{db}`.
    expect(Object.keys(tenant.document.paths)).toEqual(
      expect.arrayContaining(["/users", "/users/{id}"]),
    )
    for (const item of Object.values(tenant.document.paths)) {
      const declared = (item.get?.parameters ?? []).map((parameter) => parameter.name)
      expect(declared).not.toContain("db")
    }
  })

  test("an int64 column keeps its tagged form rather than becoming Int", async () => {
    const tenant = await schemas.for(fixture.db)
    const sdl = (await loadPeers()).graphql.printSchema(tenant.schema)
    expect(sdl).toContain("type User {")
    // `s.int64()` publishes `anyOf: [integer, {"$i"}]`, which has no fixed shape — so the
    // generator uses its catch-all scalar and `{"$i": "…"}` survives to the client.
    expect(/id: JSON/.test(sdl)).toBe(true)
  })

  test("the same schema is served while `PRAGMA schema_version` stands still", async () => {
    const first = await schemas.for(fixture.db)
    const second = await schemas.for(fixture.db)
    expect(second).toBe(first)
    expect(second.schema).toBe(first.schema)
    expect(schemas.size).toBe(1)
  })

  test("DDL rebuilds it, because the version key is SQLite's own", async () => {
    const before = await schemas.for(fixture.db)
    await fixture.data.admin({ sql: "CREATE TABLE notes (body TEXT)", args: [] })
    const after = await schemas.for(fixture.db)
    expect(after.schemaVersion).toBeGreaterThan(before.schemaVersion)
    expect(after.schema).not.toBe(before.schema)
    expect(Object.keys(after.schema.getQueryType()?.getFields() ?? {})).toContain("listNotes")
  })

  test("a database that was deleted keeps no schema alive", async () => {
    await schemas.for(fixture.db)
    expect(schemas.size).toBe(1)
    schemas.invalidate(fixture.db)
    expect(schemas.size).toBe(0)
    // And it builds again from scratch rather than serving the dropped one.
    const rebuilt = await schemas.for(fixture.db)
    expect(rebuilt.schema).toBeDefined()
    expect(schemas.size).toBe(1)
  })

  test("two concurrent cold requests generate one schema between them", async () => {
    const cold = new SchemaCache({ introspect: () => fixture.data.admin })
    const [left, right] = await Promise.all([cold.for(fixture.db), cold.for(fixture.db)])
    expect(left).toBe(right)
    expect(cold.size).toBe(1)
  })
})
