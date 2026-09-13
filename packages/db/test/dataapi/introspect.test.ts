// What the catalog says about a realistic schema, and what that becomes as core schemas. The
// assertions that matter are the ones about affinity: SQLite's declared types are advisory, so a
// test that only checked `VARCHAR(20)` maps to a string would pass while `UNSIGNED BIG INT`
// silently became one too.

import { afterAll, describe, expect, test } from "bun:test"
import { toJsonSchema } from "../../src/core/index.ts"
import {
  affinityOf,
  columnOf,
  schemaForColumn,
  tableOf,
  type TenantSchema,
} from "../../src/dataapi/index.ts"
import { dataApiFixture, type DataApiFixture } from "./harness.ts"
import { stopAll } from "../server/harness.ts"

const SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email VARCHAR(200),
    avatar BLOB,
    score REAL,
    balance UNSIGNED BIG INT NOT NULL DEFAULT 0,
    weight DECIMAL(8,2),
    anything,
    created_at TEXT NOT NULL DEFAULT 'epoch',
    shout TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    total NUMERIC
  );
  CREATE TABLE logs (message TEXT, level INT);
  CREATE TABLE settings (k TEXT NOT NULL, scope TEXT NOT NULL, v TEXT, PRIMARY KEY (scope, k)) WITHOUT ROWID;
  CREATE VIEW recent AS SELECT id, name FROM users;
  CREATE UNIQUE INDEX users_email ON users (email)`

let fixture: DataApiFixture
let schema: TenantSchema

async function setup(): Promise<TenantSchema> {
  if (!schema) {
    fixture = await dataApiFixture("intro", SCHEMA)
    schema = fixture.entry.schema
  }
  return schema
}

afterAll(async () => {
  await stopAll()
})

describe("affinity", () => {
  test("follows SQLite's own five rules, not the type name", () => {
    expect(affinityOf("INTEGER")).toBe("INTEGER")
    expect(affinityOf("UNSIGNED BIG INT")).toBe("INTEGER")
    // "INT" wins over "POINT" containing "INT" being a coincidence — SQLite has the same rule.
    expect(affinityOf("POINT")).toBe("INTEGER")
    expect(affinityOf("VARCHAR(200)")).toBe("TEXT")
    expect(affinityOf("NATIVE CHARACTER")).toBe("TEXT")
    expect(affinityOf("CLOB")).toBe("TEXT")
    expect(affinityOf("BLOB")).toBe("BLOB")
    expect(affinityOf("")).toBe("BLOB")
    expect(affinityOf("DOUBLE PRECISION")).toBe("REAL")
    expect(affinityOf("FLOAT")).toBe("REAL")
    expect(affinityOf("DECIMAL(8,2)")).toBe("NUMERIC")
    expect(affinityOf("BOOLEAN")).toBe("NUMERIC")
    expect(affinityOf("DATETIME")).toBe("NUMERIC")
  })
})

describe("introspection", () => {
  test("reads every table and view, sorted, and skips SQLite's own", async () => {
    const got = await setup()
    expect(got.db).toBe("intro")
    expect(got.schemaVersion).toBeGreaterThan(0)
    expect(got.tables.map((table) => table.name)).toEqual([
      "logs",
      "orders",
      "recent",
      "settings",
      "users",
    ])
  })

  test("maps each column to its affinity and its core schema", async () => {
    const users = tableOf(await setup(), "users")
    if (!users) throw new Error("users is missing")
    const affinities = Object.fromEntries(
      users.columns.map((column) => [column.name, column.affinity]),
    )
    expect(affinities).toEqual({
      id: "INTEGER",
      name: "TEXT",
      email: "TEXT",
      avatar: "BLOB",
      score: "REAL",
      balance: "INTEGER",
      weight: "NUMERIC",
      anything: "BLOB",
      created_at: "TEXT",
      shout: "TEXT",
    })
    // An INTEGER column is a 64-bit integer, never `s.int()`: the tagged form has to be published
    // or a generated client narrows a rowid past 2^53 to a double.
    const id = toJsonSchema(schemaForColumn(columnOf(users, "id") as never))
    expect(id.anyOf).toEqual([
      { type: "integer" },
      {
        type: "object",
        properties: { $i: { type: "string", pattern: "^[+-]?[0-9]+$" } },
        required: ["$i"],
        additionalProperties: false,
      },
    ])
    // A nullable BLOB is the blob branch beside a null one, not a widened type: core's validator
    // reads the codec mark before the type list, so `.nullable()` alone would refuse the null.
    const avatar = toJsonSchema(schemaForColumn(columnOf(users, "avatar") as never))
    expect((avatar.anyOf ?? []).map((branch) => branch.type)).toEqual(["object", "null"])
    expect((avatar.anyOf ?? [])[0]?.properties).toHaveProperty("$b")
    // A column declared with no type has BLOB affinity, which in SQLite means *no* affinity: it
    // converts nothing, so any storage class can be in there.
    // `s.sqliteValue()` already carries a null branch, so a nullable untyped column is it,
    // unchanged: null, number, string, boolean and the three tagged forms.
    expect(
      (toJsonSchema(schemaForColumn(columnOf(users, "anything") as never)).anyOf ?? []).map(
        (branch) => Object.keys(branch.properties ?? {})[0] ?? branch.type,
      ),
    ).toEqual(["null", "number", "string", "boolean", "$i", "$b", "$f"])
  })

  test("nullability, defaults and what may be left out of an insert", async () => {
    const users = tableOf(await setup(), "users")
    if (!users) throw new Error("users is missing")
    const column = (name: string) => columnOf(users, name) as never as Record<string, unknown>

    // `INTEGER PRIMARY KEY` reports notnull=0 and still cannot be null: it is the rowid.
    expect(column("id").notNull).toBe(false)
    expect(column("id").rowidAlias).toBe(true)
    expect(column("id").nullable).toBe(false)
    expect(column("id").optionalOnInsert).toBe(true)

    expect(column("name").nullable).toBe(false)
    expect(column("name").optionalOnInsert).toBe(false)
    expect(column("email").nullable).toBe(true)
    expect(column("email").optionalOnInsert).toBe(true)
    // NOT NULL with a DEFAULT: required by SQLite, optional to a caller.
    expect(column("created_at").nullable).toBe(false)
    expect(column("created_at").defaultExpression).toBe("'epoch'")
    expect(column("created_at").optionalOnInsert).toBe(true)
  })

  test("a generated column is readable and never writable", async () => {
    const users = tableOf(await setup(), "users")
    const shout = columnOf(users as never, "shout")
    expect(shout?.generated).toBe(true)
    expect(shout?.writable).toBe(false)
  })

  test("a foreign key and a unique index", async () => {
    const orders = tableOf(await setup(), "orders")
    expect(orders?.foreignKeys).toEqual([
      { columns: ["user_id"], table: "users", references: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
    ])
    const users = tableOf(await setup(), "users")
    expect(users?.indexes).toEqual([
      { name: "users_email", unique: true, partial: false, origin: "c", columns: ["email"] },
    ])
  })

  test("a table with no primary key is addressed by its rowid", async () => {
    const logs = tableOf(await setup(), "logs")
    expect(logs?.key).toEqual(["rowid"])
    const rowid = columnOf(logs as never, "rowid")
    expect(rowid?.synthetic).toBe(true)
    expect(rowid?.writable).toBe(false)
    expect(rowid?.affinity).toBe("INTEGER")
  })

  test("a WITHOUT ROWID table keeps its composite key in key order", async () => {
    const settings = tableOf(await setup(), "settings")
    expect(settings?.withoutRowid).toBe(true)
    expect(settings?.key).toEqual(["scope", "k"])
    // A PRIMARY KEY column of a WITHOUT ROWID table is implicitly NOT NULL.
    expect(columnOf(settings as never, "k")?.nullable).toBe(false)
    expect(columnOf(settings as never, "v")?.nullable).toBe(true)
  })

  test("a view is read-only and addresses no row", async () => {
    const recent = tableOf(await setup(), "recent")
    expect(recent?.kind).toBe("view")
    expect(recent?.readOnly).toBe(true)
    expect(recent?.key).toEqual([])
    expect(recent?.columns.every((column) => !column.writable)).toBe(true)
  })

  test("the cache re-introspects only when schema_version moves", async () => {
    const fresh = await dataApiFixture("cached", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    try {
      const { DataApiCache } = await import("../../src/dataapi/index.ts")
      let calls = 0
      const counted = (statement: { sql: string; args: readonly never[] }) => {
        calls++
        return fresh.admin(statement)
      }
      const cache = new DataApiCache()
      const first = await cache.for("cached", counted as never)
      const after = calls
      const second = await cache.for("cached", counted as never)
      // One pragma to check the version, and nothing else.
      expect(calls - after).toBe(1)
      expect(second.schema).toBe(first.schema)

      fresh.admin({ sql: "CREATE TABLE b (id INTEGER PRIMARY KEY)", args: [] })
      const third = await cache.for("cached", counted as never)
      expect(third.schema).not.toBe(first.schema)
      expect(third.schema.tables.map((table) => table.name)).toEqual(["a", "b"])
    } finally {
      await fresh.close()
    }
  })
})
