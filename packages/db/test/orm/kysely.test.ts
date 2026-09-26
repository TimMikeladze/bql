// `bql/kysely` against a real server, and against the embedded engine. Everything here is the
// public Kysely API — the dialect is only ever reached through it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Kysely, sql, type Generated } from "kysely"
import { Migrator, type Migration } from "kysely/migration"
import { BqlDialect, bqlDialect } from "../../src/kysely.ts"
import {
  anotherDb,
  failure,
  startEmbedded,
  startOrmFixture,
  stopAll,
  type OrmFixture,
} from "./harness.ts"

interface AuthorTable {
  id: Generated<number>
  name: string
  born: number | null
}

interface BookTable {
  id: Generated<number>
  author_id: number
  title: string
  pages: number
  cover: Uint8Array | null
}

interface DB {
  author: AuthorTable
  book: BookTable
}

/** The schema both legs of this suite run against. */
async function migrate(db: Kysely<DB>): Promise<void> {
  await db.schema
    .createTable("author")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("born", "integer")
    .execute()
  await db.schema
    .createTable("book")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("author_id", "integer", (col) => col.notNull().references("author.id"))
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("pages", "integer", (col) => col.notNull())
    .addColumn("cover", "blob")
    .execute()
}

let fixture: OrmFixture
let db: Kysely<DB>

beforeAll(async () => {
  fixture = await startOrmFixture("kysely")
  db = new Kysely<DB>({ dialect: new BqlDialect(fixture.db) })
  await migrate(db)
})

afterAll(async () => {
  await db.destroy()
  await stopAll()
})

describe("statements", () => {
  test("insert returns the row it wrote, and the insertId", async () => {
    const written = await db
      .insertInto("author")
      .values({ name: "Ursula K. Le Guin", born: 1929 })
      .returningAll()
      .executeTakeFirstOrThrow()
    expect(written.name).toBe("Ursula K. Le Guin")
    expect(written.born).toBe(1929)
    expect(written.id).toBeGreaterThan(0)

    const plain = await db.insertInto("author").values({ name: "Iain M. Banks", born: 1954 }).executeTakeFirstOrThrow()
    expect(plain.insertId).toBe(BigInt(written.id + 1))
    expect(plain.numInsertedOrUpdatedRows).toBe(1n)
  })

  test("select with where, join, order and limit", async () => {
    const author = await db
      .selectFrom("author")
      .select("id")
      .where("name", "=", "Ursula K. Le Guin")
      .executeTakeFirstOrThrow()
    await db
      .insertInto("book")
      .values([
        { author_id: author.id, title: "The Dispossessed", pages: 341 },
        { author_id: author.id, title: "A Wizard of Earthsea", pages: 183 },
        { author_id: author.id, title: "The Left Hand of Darkness", pages: 304 },
      ])
      .execute()

    const rows = await db
      .selectFrom("book")
      .innerJoin("author", "author.id", "book.author_id")
      .select(["book.title", "book.pages", "author.name"])
      .where("book.pages", ">", 200)
      .orderBy("book.pages", "desc")
      .limit(1)
      .execute()
    expect(rows).toEqual([
      { title: "The Dispossessed", pages: 341, name: "Ursula K. Le Guin" },
    ])
  })

  test("update and delete report how many rows they touched", async () => {
    const updated = await db
      .updateTable("book")
      .set({ pages: 184 })
      .where("title", "=", "A Wizard of Earthsea")
      .executeTakeFirstOrThrow()
    expect(updated.numUpdatedRows).toBe(1n)
    expect(
      await db.selectFrom("book").select("pages").where("title", "=", "A Wizard of Earthsea").executeTakeFirst(),
    ).toEqual({ pages: 184 })

    await db.insertInto("author").values({ name: "temporary", born: null }).execute()
    const deleted = await db.deleteFrom("author").where("name", "=", "temporary").executeTakeFirstOrThrow()
    expect(deleted.numDeletedRows).toBe(1n)
  })

  test("a constraint violation arrives as an error naming the constraint", async () => {
    const err = await failure(db.insertInto("author").values({ name: "Iain M. Banks", born: 1954 }).execute())
    expect(String(err.code)).toStartWith("SQLITE_CONSTRAINT")
    expect(err.message).toContain("author.name")
  })
})

describe("transactions", () => {
  test("a transaction that returns commits everything in it", async () => {
    const titles = await db.transaction().execute(async (trx) => {
      const author = await trx
        .insertInto("author")
        .values({ name: "Ted Chiang", born: 1967 })
        .returning("id")
        .executeTakeFirstOrThrow()
      await trx
        .insertInto("book")
        .values({ author_id: author.id, title: "Exhalation", pages: 350 })
        .execute()
      return trx.selectFrom("book").select("title").where("author_id", "=", author.id).execute()
    })
    expect(titles).toEqual([{ title: "Exhalation" }])
    expect(
      await db.selectFrom("author").select("name").where("name", "=", "Ted Chiang").executeTakeFirst(),
    ).toEqual({ name: "Ted Chiang" })
  })

  test("a transaction that throws rolls everything back", async () => {
    const err = await failure(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("author").values({ name: "ghost", born: null }).execute()
        throw new Error("changed my mind")
      }),
    )
    expect(err.message).toBe("changed my mind")
    expect(await db.selectFrom("author").select("id").where("name", "=", "ghost").execute()).toEqual([])
  })

  test("a controlled transaction rolls back to a savepoint and keeps the rest", async () => {
    const trx = await db.startTransaction().execute()
    try {
      await trx.insertInto("author").values({ name: "kept", born: null }).execute()
      const after = await trx.savepoint("after_kept").execute()
      await after.insertInto("author").values({ name: "dropped", born: null }).execute()
      await after.rollbackToSavepoint("after_kept").execute()
      await trx.commit().execute()
    } catch (err) {
      await trx.rollback().execute()
      throw err
    }
    const names = await db
      .selectFrom("author")
      .select("name")
      .where("name", "in", ["kept", "dropped"])
      .execute()
    expect(names).toEqual([{ name: "kept" }])
  })

  test("the HTTP baton carries a transaction when the socket is not wanted", async () => {
    const overHttp = new Kysely<DB>({
      dialect: bqlDialect({ db: fixture.db, transaction: { via: "http" } }),
    })
    try {
      await overHttp.transaction().execute(async (trx) => {
        await trx.insertInto("author").values({ name: "over http", born: null }).execute()
      })
      expect(
        await overHttp.selectFrom("author").select("name").where("name", "=", "over http").execute(),
      ).toEqual([{ name: "over http" }])
      const err = await failure(
        overHttp.transaction().execute(async (trx) => {
          await trx.insertInto("author").values({ name: "over http, undone" }).execute()
          throw new Error("undo it")
        }),
      )
      expect(err.message).toBe("undo it")
      expect(
        await overHttp.selectFrom("author").select("id").where("name", "=", "over http, undone").execute(),
      ).toEqual([])
    } finally {
      await overHttp.destroy()
    }
  })

  test("writes outside the transaction are not swept up by it", async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("author").values({ name: "inside", born: null }).execute()
    })
    await db.insertInto("author").values({ name: "outside", born: null }).execute()
    const both = await db
      .selectFrom("author")
      .select("name")
      .where("name", "in", ["inside", "outside"])
      .orderBy("name")
      .execute()
    expect(both).toEqual([{ name: "inside" }, { name: "outside" }])
  })
})

describe("values", () => {
  test("a blob round-trips as the bytes that went in", async () => {
    const cover = new Uint8Array([0, 1, 2, 250, 251, 252])
    const author = await db.selectFrom("author").select("id").orderBy("id").executeTakeFirstOrThrow()
    await db
      .insertInto("book")
      .values({ author_id: author.id, title: "with a cover", pages: 10, cover })
      .execute()
    const row = await db
      .selectFrom("book")
      .select("cover")
      .where("title", "=", "with a cover")
      .executeTakeFirstOrThrow()
    expect(row.cover).toBeInstanceOf(Uint8Array)
    expect(Array.from(row.cover as Uint8Array)).toEqual([0, 1, 2, 250, 251, 252])
  })

  test("an integer past 2^53 round-trips as a bigint", async () => {
    await sql`create table if not exists ledger(id integer primary key, amount integer)`.execute(db)
    const big = 9007199254740993n
    await sql`insert into ledger(id, amount) values (1, ${big})`.execute(db)
    const read = await sql<{ amount: bigint }>`select amount from ledger where id = 1`.execute(db)
    expect(read.rows[0]?.amount).toBe(big)
  })
})

describe("introspection", () => {
  test("the introspector lists the tables and their columns", async () => {
    const tables = await db.introspection.getTables()
    const names = tables.map((table) => table.name).sort()
    expect(names).toContain("author")
    expect(names).toContain("book")
    const author = tables.find((table) => table.name === "author")
    expect(author?.columns.map((column) => column.name).sort()).toEqual(["born", "id", "name"])
    const id = author?.columns.find((column) => column.name === "id")
    expect(id?.isAutoIncrementing).toBe(true)
    expect(id?.dataType.toLowerCase()).toBe("integer")
  })
})

describe("the embedded engine", () => {
  test("the same dialect drives Bql.open()'s Db", async () => {
    const embedded = new Kysely<DB>({ dialect: bqlDialect({ db: await startEmbedded("kysely") }) })
    try {
      await migrate(embedded)
      const author = await embedded
        .insertInto("author")
        .values({ name: "in process", born: 2026 })
        .returningAll()
        .executeTakeFirstOrThrow()
      expect(author.id).toBe(1)

      await embedded.transaction().execute(async (trx) => {
        await trx
          .insertInto("book")
          .values({ author_id: author.id, title: "no HTTP at all", pages: 1 })
          .execute()
      })
      const rows = await embedded
        .selectFrom("book")
        .innerJoin("author", "author.id", "book.author_id")
        .select(["book.title", "author.name"])
        .execute()
      expect(rows).toEqual([{ title: "no HTTP at all", name: "in process" }])

      const err = await failure(
        embedded.transaction().execute(async (trx) => {
          await trx.insertInto("author").values({ name: "rolled back", born: null }).execute()
          throw new Error("nope")
        }),
      )
      expect(err.message).toBe("nope")
      expect(await embedded.selectFrom("author").select("id").where("name", "=", "rolled back").execute()).toEqual([])
    } finally {
      await embedded.destroy()
    }
  })
})

describe("migrations", () => {
  test("Kysely's migrator runs migrations and records them", async () => {
    const migrations = new Kysely<DB>({ dialect: bqlDialect(await anotherDb(fixture, "kyselymig")) })
    try {
      const migrator = new Migrator({
        db: migrations,
        provider: {
          async getMigrations(): Promise<Record<string, Migration>> {
            return {
              "001_todos": {
                async up(target) {
                  await target.schema
                    .createTable("todos")
                    .addColumn("id", "integer", (col) => col.primaryKey())
                    .addColumn("title", "text")
                    .execute()
                },
              },
              "002_seed": {
                async up(target) {
                  await sql`insert into todos(id, title) values (1, 'migrated')`.execute(target)
                },
              },
            }
          },
        },
      })
      const { error, results } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
      expect(results?.map((one) => `${one.migrationName}:${one.status}`)).toEqual([
        "001_todos:Success",
        "002_seed:Success",
      ])
      const rows = await sql<{ title: string }>`select title from todos`.execute(migrations)
      expect(rows.rows).toEqual([{ title: "migrated" }])
    } finally {
      await migrations.destroy()
    }
  })
})

describe("building the client", () => {
  test("{url, token, db} opens a client the dialect owns and closes", async () => {
    const standalone = new Kysely<DB>({
      dialect: new BqlDialect({
        url: fixture.server.url,
        token: fixture.server.adminKey,
        db: "kysely",
      }),
    })
    const rows = await standalone.selectFrom("author").select("name").orderBy("id").limit(1).execute()
    expect(rows).toEqual([{ name: "Ursula K. Le Guin" }])
    // `destroy()` closes the client this dialect opened; a `Db` handed in is left alone.
    await standalone.destroy()
  })
})

describe("what the dialect does not do", () => {
  test("streamQuery says so rather than pretending", async () => {
    const err = await failure(
      (async () => {
        for await (const _row of db.selectFrom("author").selectAll().stream()) {
          // unreachable
        }
      })(),
    )
    expect(err.message).toContain("does not support streamQuery")
  })
})
