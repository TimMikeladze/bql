// `bunql/drizzle` against a real server. Everything here is the public Drizzle API — the libsql
// shim underneath it is only ever reached through Drizzle itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { desc, eq, gt, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/libsql/migrator"
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BunQLClientError } from "../../src/client/errors.ts"
import { drizzle, libsqlClient, type BunQLDatabase } from "../../src/drizzle.ts"
import { anotherDb, failure, startOrmFixture, stopAll, type OrmFixture } from "./harness.ts"

const authors = sqliteTable("authors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  born: integer("born"),
})

const books = sqliteTable("books", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorId: integer("author_id").notNull(),
  title: text("title").notNull(),
  pages: integer("pages").notNull(),
  cover: blob("cover", { mode: "buffer" }),
  royalties: blob("royalties", { mode: "bigint" }),
})

const schema = { authors, books }

let fixture: OrmFixture
let db: BunQLDatabase<typeof schema>

beforeAll(async () => {
  fixture = await startOrmFixture("drizzle")
  db = drizzle(fixture.db, { schema })
  await db.run(
    sql`create table authors(id integer primary key autoincrement, name text not null unique, born integer)`,
  )
  await db.run(
    sql`create table books(id integer primary key autoincrement, author_id integer not null references authors(id), title text not null, pages integer not null, cover blob, royalties blob)`,
  )
})

afterAll(stopAll)

describe("statements", () => {
  test("insert returns the rows it wrote", async () => {
    const written = await db
      .insert(authors)
      .values([
        { name: "Ursula K. Le Guin", born: 1929 },
        { name: "Iain M. Banks", born: 1954 },
      ])
      .returning()
    expect(written.map((row) => row.name)).toEqual(["Ursula K. Le Guin", "Iain M. Banks"])
    expect(written[0]?.id).toBe(1)
    expect(written[0]?.born).toBe(1929)

    const plain = await db.insert(authors).values({ name: "Ted Chiang", born: 1967 })
    expect(plain.rowsAffected).toBe(1)
    expect(plain.lastInsertRowid).toBe(3n)
  })

  test("select with where, join, order and limit", async () => {
    await db.insert(books).values([
      { authorId: 1, title: "The Dispossessed", pages: 341 },
      { authorId: 1, title: "A Wizard of Earthsea", pages: 183 },
      { authorId: 2, title: "Use of Weapons", pages: 411 },
    ])

    const rows = await db
      .select({ title: books.title, pages: books.pages, author: authors.name })
      .from(books)
      .innerJoin(authors, eq(authors.id, books.authorId))
      .where(gt(books.pages, 200))
      .orderBy(desc(books.pages))
      .limit(1)
    expect(rows).toEqual([{ title: "Use of Weapons", pages: 411, author: "Iain M. Banks" }])
  })

  test("update and delete", async () => {
    const updated = await db
      .update(books)
      .set({ pages: 184 })
      .where(eq(books.title, "A Wizard of Earthsea"))
      .returning({ pages: books.pages })
    expect(updated).toEqual([{ pages: 184 }])

    await db.insert(authors).values({ name: "temporary" })
    const deleted = await db.delete(authors).where(eq(authors.name, "temporary"))
    expect(deleted.rowsAffected).toBe(1)
    expect(await db.select().from(authors).where(eq(authors.name, "temporary"))).toEqual([])
  })

  test("a constraint violation arrives as an error naming the constraint", async () => {
    // Drizzle wraps whatever the driver threw in a `DrizzleQueryError`, so BunQL's own error —
    // with its `code` — is the `cause`.
    const err = await failure(db.insert(authors).values({ name: "Ted Chiang", born: 1967 }))
    expect(err.message).toContain("Failed query")
    const cause = err.cause as BunQLClientError
    expect(cause).toBeInstanceOf(BunQLClientError)
    expect(String(cause.code)).toStartWith("SQLITE_CONSTRAINT")
    expect(cause.message).toContain("authors.name")
  })

  test("the relational query builder reads through the same session", async () => {
    const found = await db.query.authors.findFirst({ where: eq(authors.name, "Ted Chiang") })
    expect(found).toEqual({ id: 3, name: "Ted Chiang", born: 1967 })
  })
})

describe("transactions", () => {
  test("a transaction that returns commits everything in it", async () => {
    const titles = await db.transaction(async (tx) => {
      const [author] = await tx.insert(authors).values({ name: "Ann Leckie", born: 1966 }).returning()
      await tx.insert(books).values({ authorId: author?.id ?? 0, title: "Ancillary Justice", pages: 409 })
      return tx.select({ title: books.title }).from(books).where(eq(books.authorId, author?.id ?? 0))
    })
    expect(titles).toEqual([{ title: "Ancillary Justice" }])
    expect(await db.select({ n: authors.name }).from(authors).where(eq(authors.name, "Ann Leckie"))).toEqual([
      { n: "Ann Leckie" },
    ])
  })

  test("a transaction that throws rolls everything back", async () => {
    const err = await failure(
      db.transaction(async (tx) => {
        await tx.insert(authors).values({ name: "ghost" })
        throw new Error("changed my mind")
      }),
    )
    expect(err.message).toBe("changed my mind")
    expect(await db.select().from(authors).where(eq(authors.name, "ghost"))).toEqual([])
  })

  test("tx.rollback() rolls back too", async () => {
    await failure(
      db.transaction(async (tx) => {
        await tx.insert(authors).values({ name: "phantom" })
        tx.rollback()
      }),
    )
    expect(await db.select().from(authors).where(eq(authors.name, "phantom"))).toEqual([])
  })

  test("a nested transaction is a savepoint inside the outer one", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(authors).values({ name: "kept" })
      await failure(
        tx.transaction(async (inner) => {
          await inner.insert(authors).values({ name: "dropped" })
          throw new Error("no")
        }),
      )
    })
    const names = await db
      .select({ name: authors.name })
      .from(authors)
      .where(sql`${authors.name} in ('kept', 'dropped')`)
    expect(names).toEqual([{ name: "kept" }])
  })

  test("concurrent transactions queue instead of colliding with TX_BUSY", async () => {
    const slow = db.transaction(async (tx) => {
      await tx.insert(authors).values({ name: "first in" })
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const quick = db.transaction(async (tx) => {
      await tx.insert(authors).values({ name: "second in" })
    })
    await Promise.all([slow, quick])
    const names = await db
      .select({ name: authors.name })
      .from(authors)
      .where(sql`${authors.name} in ('first in', 'second in')`)
      .orderBy(authors.id)
    expect(names).toEqual([{ name: "first in" }, { name: "second in" }])
  })

  test("a transaction opened from inside another on the same handle gives up and says why", async () => {
    const impatient = drizzle(fixture.db, { transactionWaitMs: 50 })
    const err = await failure(
      impatient.transaction(async () => {
        // The mistake this message is about: `impatient`, not the `tx` the callback was handed.
        await impatient.transaction(async (inner) => {
          await inner.insert(authors).values({ name: "never written" })
        })
      }),
    )
    expect(String(err.cause ?? err.message)).toContain("cannot be opened from inside another")
    expect(await db.select().from(authors).where(eq(authors.name, "never written"))).toEqual([])
  })
})

describe("batch", () => {
  test("db.batch runs every statement and answers each in order", async () => {
    const results = await db.batch([
      db.insert(authors).values({ name: "Becky Chambers", born: 1985 }).returning({ id: authors.id }),
      db.select({ n: sql<number>`count(*)` }).from(authors),
      db.update(authors).set({ born: 1986 }).where(eq(authors.name, "Becky Chambers")),
    ])
    expect(results[0]?.[0]?.id).toBeGreaterThan(0)
    expect(Number(results[1]?.[0]?.n)).toBeGreaterThan(1)
    expect(results[2]?.rowsAffected).toBe(1)
    expect(
      await db.select({ born: authors.born }).from(authors).where(eq(authors.name, "Becky Chambers")),
    ).toEqual([{ born: 1986 }])
  })

  test("a batch is one transaction: a failure in it writes nothing", async () => {
    await failure(
      db.batch([
        db.insert(authors).values({ name: "half written" }),
        db.insert(authors).values({ name: "Ted Chiang" }),
      ]),
    )
    expect(await db.select().from(authors).where(eq(authors.name, "half written"))).toEqual([])
  })
})

describe("values", () => {
  test("a blob column round-trips as the bytes that went in", async () => {
    const cover = Buffer.from([0, 1, 2, 250, 251, 252])
    await db.insert(books).values({ authorId: 1, title: "with a cover", pages: 10, cover })
    const [row] = await db
      .select({ cover: books.cover })
      .from(books)
      .where(eq(books.title, "with a cover"))
    expect(Array.from(row?.cover ?? [])).toEqual([0, 1, 2, 250, 251, 252])
  })

  test("a bigint blob column round-trips past 2^53", async () => {
    const royalties = 9007199254740993n
    await db.insert(books).values({ authorId: 1, title: "well paid", pages: 1, royalties })
    const [row] = await db
      .select({ royalties: books.royalties })
      .from(books)
      .where(eq(books.title, "well paid"))
    expect(row?.royalties).toBe(royalties)
  })

  test("an integer past 2^53 comes back as a bigint", async () => {
    await db.run(sql`create table ledger(id integer primary key, amount integer)`)
    await db.run(sql`insert into ledger(id, amount) values (1, ${9007199254740993n})`)
    const read = await db.get<{ amount: bigint }>(sql`select amount from ledger where id = 1`)
    expect(read?.amount).toBe(9007199254740993n)
  })
})

describe("migrations", () => {
  test("drizzle-orm/libsql's migrator runs a folder and is a no-op the second time", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-drizzle-migrations-"))
    try {
      fs.mkdirSync(path.join(folder, "meta"))
      fs.writeFileSync(
        path.join(folder, "0000_init.sql"),
        "CREATE TABLE `notes` (`id` integer PRIMARY KEY NOT NULL, `body` text NOT NULL);\n" +
          "--> statement-breakpoint\n" +
          "INSERT INTO `notes` (`id`, `body`) VALUES (1, 'migrated');\n",
      )
      fs.writeFileSync(
        path.join(folder, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "sqlite",
          entries: [
            { idx: 0, version: "6", when: 1_757_600_000_000, tag: "0000_init", breakpoints: true },
          ],
        }),
      )
      const target = drizzle(await anotherDb(fixture, "drizzlemig"))
      await migrate(target, { migrationsFolder: folder })
      expect(await target.all(sql`select body from notes`)).toEqual([{ body: "migrated" }])
      await migrate(target, { migrationsFolder: folder })
      expect(await target.all(sql`select count(*) as n from notes`)).toEqual([{ n: 1 }])
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("the client underneath", () => {
  test("$client is the libsql-shaped shim, and it carries the BunQL Db", async () => {
    const client = db.$client
    expect(client.protocol).toBe("bunql")
    expect(client.bunql.name).toBe("drizzle")
    const result = await client.execute({ sql: "select name from authors where id = ?", args: [1] })
    expect(result.columns).toEqual(["name"])
    expect(result.rows[0]?.name).toBe("Ursula K. Le Guin")
    // A libsql row is array-like as well as keyed, which is what Drizzle reads it as.
    expect(Array.prototype.slice.call(result.rows[0] as object)).toEqual(["Ursula K. Le Guin"])
  })

  test("a client built from {url, token, db} works the same way", async () => {
    const standalone = drizzle({ url: fixture.server.url, token: fixture.server.adminKey, db: "drizzle" })
    const rows = await standalone.all<{ name: string }>(sql`select name from authors order by id limit 1`)
    expect(rows).toEqual([{ name: "Ursula K. Le Guin" }])
    standalone.$client.close()
  })

  test("libsqlClient batches straight off a BunQL Db", async () => {
    const client = libsqlClient(fixture.db)
    const results = await client.batch([
      { sql: "insert into authors(name) values (?)", args: ["from the shim"] },
      { sql: "select count(*) as n from authors" },
    ])
    expect(results[0]?.rowsAffected).toBe(1)
    expect(Number(results[1]?.rows[0]?.n)).toBeGreaterThan(0)
  })
})
