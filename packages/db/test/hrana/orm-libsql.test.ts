// The ORMs over their *own* libsql drivers, not over `bql/drizzle` and `bql/kysely`. That is
// the point of the Hrana layer: a project already on `drizzle-orm/libsql` or `kysely-libsql`
// changes a URL and nothing else. `test/orm/` covers our own adapters; this file covers the
// compatibility claim.
//
// Both drivers build a `@libsql/client` from the URL, so the trailing slash on a path-mounted
// base URL applies here too — see the header of `./libsql-client.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Kysely, type Generated } from "kysely"
import { LibsqlDialect } from "kysely-libsql"
import { startHrana, stopAllHrana, type TestHrana } from "./harness.ts"

const SCHEMA = "create table people (id integer primary key, name text not null, age integer)"

let server: TestHrana

beforeAll(async () => {
  server = await startHrana({ limits: { txIdleTimeoutMs: 15_000 } })
})

afterAll(async () => {
  await stopAllHrana()
})

function urlFor(db: string): string {
  // The trailing slash is load-bearing; without it the client resolves `v2/pipeline` one segment
  // too high and 404s.
  return `${server.url}/v1/db/${db}/`
}

// ── drizzle-orm/libsql ─────────────────────────────────────────────────────────────────────────

const people = sqliteTable("people", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  age: integer("age"),
})

describe("drizzle-orm/libsql", () => {
  let db: LibSQLDatabase<Record<string, never>> & { $client: { close(): void } }

  beforeAll(async () => {
    await server.createDb("drizzle_db", SCHEMA)
    db = drizzle({ connection: { url: urlFor("drizzle_db"), authToken: server.adminKey } })
  })

  afterAll(() => {
    db.$client.close()
  })

  test("insert, select, update and delete inside one transaction", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(people).values([
        { name: "ada", age: 36 },
        { name: "grace", age: 45 },
      ])
      const inside = await tx.select().from(people).orderBy(people.name)
      expect(inside).toEqual([
        { id: 1, name: "ada", age: 36 },
        { id: 2, name: "grace", age: 45 },
      ])
      await tx.update(people).set({ age: 37 }).where(eq(people.name, "ada"))
      await tx.delete(people).where(eq(people.name, "grace"))
    })
    expect(await db.select().from(people)).toEqual([{ id: 1, name: "ada", age: 37 }])
  })

  test("a throw inside the transaction rolls the whole thing back", async () => {
    const before = await db.select().from(people)
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(people).values({ name: "temp", age: 1 })
        throw new Error("no thanks")
      }),
    ).rejects.toThrow("no thanks")
    expect(await db.select().from(people)).toEqual(before)
  })

  test("returning gives back the inserted row", async () => {
    const returned = await db.insert(people).values({ name: "alan", age: 41 }).returning()
    expect(returned).toEqual([{ id: returned[0]?.id as number, name: "alan", age: 41 }])
    expect(typeof returned[0]?.id).toBe("number")
  })

  test("a constraint failure reaches the caller with its LibsqlError code intact", async () => {
    // Drizzle wraps a driver failure in a `DrizzleQueryError` whose message is the SQL; the
    // `LibsqlError` our layer produced is its `cause`, and that is where the code lives.
    let caught: { cause?: { code?: string; message?: string } } | null = null
    try {
      await db.insert(people).values({ name: null as never, age: 1 })
    } catch (err) {
      caught = err as { cause?: { code?: string; message?: string } }
    }
    expect(caught?.cause?.code).toBe("SQLITE_CONSTRAINT_NOTNULL")
    expect(caught?.cause?.message).toContain("NOT NULL constraint failed: people.name")
  })
})

// ── kysely-libsql ──────────────────────────────────────────────────────────────────────────────

interface KyselySchema {
  people: { id: Generated<number>; name: string; age: number | null }
}

describe("kysely-libsql", () => {
  let db: Kysely<KyselySchema>

  beforeAll(async () => {
    await server.createDb("kysely_db", SCHEMA)
    db = new Kysely<KyselySchema>({
      dialect: new LibsqlDialect({ url: urlFor("kysely_db"), authToken: server.adminKey }),
    })
  })

  afterAll(async () => {
    await db.destroy()
  })

  test("insert, select and update inside one transaction", async () => {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("people")
        .values([
          { name: "linus", age: 54 },
          { name: "ken", age: 81 },
        ])
        .execute()
      const inside = await trx.selectFrom("people").selectAll().orderBy("name").execute()
      expect(inside.map((row) => row.name)).toEqual(["ken", "linus"])
      await trx.updateTable("people").set({ age: 55 }).where("name", "=", "linus").execute()
    })
    const after = await db.selectFrom("people").selectAll().orderBy("name").execute()
    expect(after).toEqual([
      { id: 2, name: "ken", age: 81 },
      { id: 1, name: "linus", age: 55 },
    ])
  })

  test("a throw inside the transaction rolls it back", async () => {
    const before = await db.selectFrom("people").selectAll().execute()
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("people").values({ name: "temp", age: 1 }).execute()
        throw new Error("no thanks")
      }),
    ).rejects.toThrow("no thanks")
    expect(await db.selectFrom("people").selectAll().execute()).toEqual(before)
  })

  test("delete reports how many rows went", async () => {
    const deleted = await db.deleteFrom("people").where("name", "=", "linus").executeTakeFirst()
    expect(deleted.numDeletedRows).toBe(1n)
    expect((await db.selectFrom("people").selectAll().execute()).length).toBe(1)
  })
})
