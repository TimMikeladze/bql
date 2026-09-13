// The five operations against real rows, and the two properties that only hold because of where
// the work is done: a 64-bit integer survives because `src/server/exec.ts` encodes it, and a
// token scoped to one table cannot read another because `exec.ts` applies the ACL — neither is
// reimplemented here, so a test that passes is a test that the wiring did not lose them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ADMIN } from "../../src/server/auth.ts"
import { buildDocument } from "../../src/openapi/index.ts"
import { dataApiRegistry, introspect } from "../../src/dataapi/index.ts"
import type { Dispatcher } from "../../src/http/index.ts"
import { dataApiFixture, type DataApiFixture, read } from "./harness.ts"
import { stopAll } from "../server/harness.ts"

const SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    joined TEXT NOT NULL DEFAULT 'epoch',
    shout TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    total REAL
  );
  CREATE TABLE notes (body TEXT);
  CREATE TABLE shadowed (rowid TEXT, _rowid_ TEXT, oid TEXT);
  CREATE VIEW loud AS SELECT id, shout FROM users;
  INSERT INTO users (id, name, email) VALUES (1, 'ann', 'ann@example.com');
  INSERT INTO users (id, name) VALUES (9007199254740993, 'big');
  INSERT INTO orders (id, user_id, total) VALUES (1, 1, 12.5)`

let fixture: DataApiFixture
let dispatch: Dispatcher

beforeAll(async () => {
  fixture = await dataApiFixture("ops", SCHEMA)
  dispatch = fixture.dispatchAs(ADMIN)
})

afterAll(async () => {
  await stopAll()
})

const json = (method: string, path: string, body?: unknown): Promise<Response> =>
  dispatch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })

describe("the generated operations", () => {
  test("the route table a schema produces", () => {
    const routes = fixture.entry.registry
      .operations()
      .map((operation) => `${operation.id} ${operation.method.toUpperCase()} ${operation.path}`)
    expect(routes).toEqual([
      "listLoud GET /v1/db/:db/api/loud",
      "listNotes GET /v1/db/:db/api/notes",
      "getNote GET /v1/db/:db/api/notes/:rowid",
      "createNote POST /v1/db/:db/api/notes",
      "updateNote PATCH /v1/db/:db/api/notes/:rowid",
      "deleteNote DELETE /v1/db/:db/api/notes/:rowid",
      "listOrders GET /v1/db/:db/api/orders",
      "getOrder GET /v1/db/:db/api/orders/:id",
      "createOrder POST /v1/db/:db/api/orders",
      "updateOrder PATCH /v1/db/:db/api/orders/:id",
      "deleteOrder DELETE /v1/db/:db/api/orders/:id",
      // No primary key and every spelling of rowid shadowed: the collection routes and no more.
      "listShadowed GET /v1/db/:db/api/shadowed",
      "createShadowed POST /v1/db/:db/api/shadowed",
      "listUsers GET /v1/db/:db/api/users",
      "getUser GET /v1/db/:db/api/users/:id",
      "createUser POST /v1/db/:db/api/users",
      "updateUser PATCH /v1/db/:db/api/users/:id",
      "deleteUser DELETE /v1/db/:db/api/users/:id",
    ])
  })

  test("a view gets a list and nothing else", () => {
    const ids = fixture.entry.registry.operations().map((operation) => operation.id)
    expect(ids).toContain("listLoud")
    expect(ids).not.toContain("createLoud")
    expect(ids).not.toContain("getLoud")
  })

  test("list", async () => {
    const { status, body } = await read<Record<string, unknown>[]>(
      await json("GET", "/v1/db/ops/api/users?order=id.asc"),
    )
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    expect(body[0]).toEqual({
      id: 1,
      name: "ann",
      email: "ann@example.com",
      joined: "epoch",
      shout: "ANN",
    })
  })

  test("an INTEGER above 2^53 survives as {\"$i\"}, in a row and in a key", async () => {
    const listed = await read<Record<string, unknown>[]>(
      await json("GET", "/v1/db/ops/api/users?id=eq.9007199254740993"),
    )
    expect(listed.body[0]?.id).toEqual({ $i: "9007199254740993" })
    const one = await read<Record<string, unknown>>(
      await json("GET", "/v1/db/ops/api/users/9007199254740993"),
    )
    expect(one.status).toBe(200)
    expect(one.body.name).toBe("big")
    // The last digit is the whole point: a double would have rounded it to …92.
    expect(one.body.id).toEqual({ $i: "9007199254740993" })
  })

  test("get, and a key that matches nothing is a 404", async () => {
    expect((await read(await json("GET", "/v1/db/ops/api/orders/1"))).body).toEqual({
      id: 1,
      user_id: 1,
      total: 12.5,
    })
    const missing = await read<{ error: { code: string; message: string } }>(
      await json("GET", "/v1/db/ops/api/orders/404"),
    )
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("NOT_FOUND")
    expect(missing.body.error.message).toBe("no row of orders with id=404")
  })

  test("insert one row, and the columns SQLite filled in come back", async () => {
    const { status, body } = await read<Record<string, unknown>[]>(
      await json("POST", "/v1/db/ops/api/users", { name: "cat" }),
    )
    expect(status).toBe(201)
    expect(body).toHaveLength(1)
    expect(body[0]?.name).toBe("cat")
    expect(body[0]?.joined).toBe("epoch")
    expect(body[0]?.shout).toBe("CAT")
    expect(body[0]?.id).toBeDefined()
  })

  test("insert an array of rows", async () => {
    const { status, body } = await read<Record<string, unknown>[]>(
      await json("POST", "/v1/db/ops/api/orders", [
        { user_id: 1, total: 1 },
        { user_id: 1, total: 2 },
      ]),
    )
    expect(status).toBe(201)
    expect(body.map((row) => row.total).sort()).toEqual([1, 2])
  })

  test("a bulk insert whose rows name different columns is refused", async () => {
    const { status, body } = await read<{ error: { message: string } }>(
      await json("POST", "/v1/db/ops/api/orders", [{ user_id: 1, total: 1 }, { user_id: 1 }]),
    )
    expect(status).toBe(400)
    expect(body.error.message).toContain("must name the same columns")
  })

  test("a generated column is readable and refused on the way in", async () => {
    const { status } = await read(
      await json("POST", "/v1/db/ops/api/users", { name: "dee", shout: "DEE" }),
    )
    expect(status).toBe(400)
  })

  test("a NOT NULL column with no default is required", async () => {
    expect((await read(await json("POST", "/v1/db/ops/api/users", { email: "x" }))).status).toBe(400)
  })

  test("update, and an update that matches nothing is a 404", async () => {
    const patched = await read<Record<string, unknown>>(
      await json("PATCH", "/v1/db/ops/api/users/1", { email: "ann@bunql.dev" }),
    )
    expect(patched.status).toBe(200)
    expect(patched.body).toMatchObject({ id: 1, name: "ann", email: "ann@bunql.dev" })
    expect(
      (await read(await json("PATCH", "/v1/db/ops/api/users/404", { email: "x" }))).status,
    ).toBe(404)
    expect((await read(await json("PATCH", "/v1/db/ops/api/users/1", {}))).status).toBe(400)
  })

  test("delete answers with the row that went, and 404 when there was none", async () => {
    const { status, body } = await read<Record<string, unknown>>(
      await json("DELETE", "/v1/db/ops/api/orders/1"),
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({ id: 1, user_id: 1 })
    expect((await read(await json("DELETE", "/v1/db/ops/api/orders/1"))).status).toBe(404)
  })

  test("a table with no primary key is addressed by its rowid", async () => {
    const created = await read<Record<string, unknown>[]>(
      await json("POST", "/v1/db/ops/api/notes", { body: "a note" }),
    )
    expect(created.status).toBe(201)
    const rowid = created.body[0]?.rowid
    expect(typeof rowid).toBe("number")
    const one = await read<Record<string, unknown>>(await json("GET", `/v1/db/ops/api/notes/${rowid}`))
    expect(one.body).toEqual({ rowid: rowid as number, body: "a note" })
    // The rowid is not writable.
    expect((await read(await json("POST", "/v1/db/ops/api/notes", { rowid: 9, body: "x" }))).status).toBe(400)
    expect((await read(await json("DELETE", `/v1/db/ops/api/notes/${rowid}`))).status).toBe(200)
  })

  test("a constraint violation keeps its SQLite code and its 409", async () => {
    const row = { id: 500, user_id: 1, total: 1 }
    expect((await read(await json("POST", "/v1/db/ops/api/orders", row))).status).toBe(201)
    const again = await read<{ error: { code: string } }>(
      await json("POST", "/v1/db/ops/api/orders", row),
    )
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY")

    // A NOT NULL a caller cannot satisfy is the other half of the write errors the document
    // lists. A foreign key is *not* checked here: nothing in BunQL turns `PRAGMA foreign_keys`
    // on, so a reference to a row that does not exist is written — see `docs/h4-dataapi.md`.
    const orphan = await read(await json("POST", "/v1/db/ops/api/orders", { user_id: 987654 }))
    expect(orphan.status).toBe(201)
  })

  test("a request for another database is refused rather than served from this one", async () => {
    const { status, body } = await read<{ error: { message: string } }>(
      await json("GET", "/v1/db/elsewhere/api/users"),
    )
    expect(status).toBe(400)
    expect(body.error.message).toContain("cannot serve")
  })
})

describe("the ACL comes from exec.ts", () => {
  test("a token scoped to one table cannot read another through the data API", async () => {
    const scoped = fixture.dispatchAs(fixture.token({ users: "rw" }))
    const allowed = await read(await scoped("/v1/db/ops/api/users"))
    expect(allowed.status).toBe(200)

    const refused = await read<{ error: { code: string } }>(await scoped("/v1/db/ops/api/orders"))
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe("NOT_AUTHORIZED")

    const written = await read<{ error: { code: string } }>(
      await scoped("/v1/db/ops/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: 1, total: 3 }),
      }),
    )
    expect(written.status).toBe(403)
  })

  test("a read-only table in the ACL cannot be written through the data API", async () => {
    const scoped = fixture.dispatchAs(fixture.token({ users: "r" }))
    expect((await read(await scoped("/v1/db/ops/api/users"))).status).toBe(200)
    const written = await read<{ error: { code: string } }>(
      await scoped("/v1/db/ops/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "nope" }),
      }),
    )
    expect(written.status).toBe(403)
  })
})

describe("the OpenAPI document", () => {
  test("has a path per table and resolves", () => {
    const document = buildDocument(fixture.entry.registry, {
      servers: [{ url: "https://sql.example.com" }],
    })
    expect(Object.keys(document.paths)).toEqual([
      "/v1/db/{db}/api/loud",
      "/v1/db/{db}/api/notes",
      "/v1/db/{db}/api/notes/{rowid}",
      "/v1/db/{db}/api/orders",
      "/v1/db/{db}/api/orders/{id}",
      "/v1/db/{db}/api/shadowed",
      "/v1/db/{db}/api/users",
      "/v1/db/{db}/api/users/{id}",
    ])
    const schemas = Object.keys(document.components?.schemas ?? {})
    expect(schemas).toContain("User")
    expect(schemas).toContain("NewUser")
    expect(schemas).toContain("UserPatch")
    // `buildDocument` throws on a `$ref` that resolves to nothing, so reaching here is the proof
    // that every one of them does. This pins the pointer shape as well.
    const list = document.paths["/v1/db/{db}/api/users"]?.get
    expect(list?.operationId).toBe("listUsers")
    expect(list?.responses["200"]?.content?.["application/json"]?.schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    })
    // The row itself, not a union with null: a key that matches nothing is a 404 now, which the
    // same operation documents under its own status.
    const one = document.paths["/v1/db/{db}/api/users/{id}"]?.get
    expect(one?.responses["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/User",
    })
    expect(one?.responses["404"]).toBeDefined()
  })

  test("documents every filter as a query parameter, and the errors under their real statuses", () => {
    const document = buildDocument(fixture.entry.registry)
    const list = document.paths["/v1/db/{db}/api/users"]?.get
    const names = (list?.parameters ?? []).map((parameter) => (parameter as { name: string }).name)
    expect(names).toEqual(["db", "id", "name", "email", "joined", "shout", "select", "order", "limit", "offset"])
    const create = document.paths["/v1/db/{db}/api/users"]?.post
    expect(Object.keys(create?.responses ?? {}).sort()).toEqual([
      "201",
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "413",
      "503",
      "507",
    ])
    expect(create?.responses["409"]?.description).toContain("SQLITE_CONSTRAINT_UNIQUE")
  })

  test("a per-tenant document strips the prefix, which is what the GraphQL baseUrl pairs with", () => {
    const document = buildDocument(fixture.entry.registry, {
      basePath: "/v1/db/{db}/api",
      servers: [{ url: "https://sql.example.com/v1/db/ops/api" }],
    })
    expect(Object.keys(document.paths)).toContain("/users/{id}")
  })
})

describe("names", () => {
  test("a table whose name is not a GraphQL name still produces one", async () => {
    const odd = await dataApiFixture(
      "odd",
      `CREATE TABLE "order-items" (id INTEGER PRIMARY KEY);
       CREATE TABLE "2fa codes" (id INTEGER PRIMARY KEY);
       CREATE TABLE "user" (id INTEGER PRIMARY KEY);
       CREATE TABLE "users" (id INTEGER PRIMARY KEY)`,
    )
    try {
      const ids = odd.entry.registry.operations().map((operation) => operation.id)
      expect(ids).toContain("listOrderItems")
      expect(ids).toContain("getOrderItem")
      expect(ids).toContain("list_2faCodes")
      // `user` and `users` both want `User`; the second keeps its plural so nothing collides.
      expect(ids).toContain("getUser")
      expect(ids).toContain("getUsers")
      const one = odd.dispatchAs(ADMIN)
      const created = await read(
        await one(`/v1/db/odd/api/${encodeURIComponent("order-items")}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      )
      expect(created.status).toBe(201)
      // And the document it produces is buildable, which is what a GraphQL name has to survive.
      expect(Object.keys(buildDocument(odd.entry.registry).paths)).toContain(
        "/v1/db/{db}/api/order-items",
      )
    } finally {
      await odd.close()
    }
  })

  test("an override replaces the guessed English", async () => {
    const people = await dataApiFixture("people", "CREATE TABLE people (id INTEGER PRIMARY KEY)", {
      names: { people: { singular: "person" } },
    })
    try {
      const ids = people.entry.registry.operations().map((operation) => operation.id)
      expect(ids).toEqual(["listPeople", "getPerson", "createPerson", "updatePerson", "deletePerson"])
    } finally {
      await people.close()
    }
  })
})

describe("the registry a schema produces is a plain one", () => {
  test("it can be merged and re-introspected without the cache", async () => {
    const schema = await introspect("ops", fixture.admin)
    const registry = dataApiRegistry(schema, { prefix: "/api" })
    expect(registry.get("listUsers")?.path).toBe("/api/users")
    expect(registry.size).toBe(fixture.entry.registry.size)
  })
})
