// The types in types.test.ts are claims about what SQLite returns. This runs the same shapes
// against an embedded database and checks the claims: the keys a row really has, which values come
// back NULL, and that `query` binds named and positional placeholders the way `execute` does.

import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bql } from "../../src/embedded.ts"
import { removeTempDir } from "../tmpdir.ts"
import { app } from "./schema.ts"

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
function exact<A, B>(_assertion: Exact<A, B>): void {}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-typed-"))
const bq = await Bql.open({ dir })
const raw = await bq.create("app")
const db = app.typed(raw)   // the first query creates the tables

afterAll(async () => {
  await bq.close()
  removeTempDir(dir)
})

test("aggregates are NULL on an empty table, and count is not", async () => {
  const [row] = await db.query("select count(*) as n, max(score) as top, sum(views) as v from posts")
  exact<typeof row, { n: number; top: number | null; v: number | null } | undefined>(true)
  expect(row).toEqual({ n: 0, top: null, v: null })
})

test("named placeholders bind, and an insert returns the columns it names", async () => {
  const [user] = await db.query("insert into users(Name, email) values (:name, :email) returning id, Name", {
    name: "ada",
    email: null,
  })
  exact<typeof user, { id: number; Name: string } | undefined>(true)
  expect(user).toEqual({ id: 1, Name: "ada" })

  await db.query("insert into posts(user_id, title, score) values (:u, :t, :s)", { u: 1, t: "first", s: 2.5 }).run()
  await db.query("insert into posts(user_id, title) values (:u, :t)", { u: 2, t: "orphan" }).run()
})

test("a row has the keys the type says, with SQLite's spelling of each column", async () => {
  const rows = await db.query("select NAME, u.email as mail, created from users u where id = :id", { id: 1 })
  expect(rows.map((r) => Object.keys(r).sort())).toEqual([["Name", "created", "mail"]])
  const [row] = rows
  expect(row?.Name).toBe("ada")
  expect(row?.mail).toBeNull()
  // datetime is NUMERIC affinity, but current_timestamp can't be converted, so it is stored as text.
  expect(typeof row?.created).toBe("string")
})

test("the right side of a left join is NULL when nothing matches", async () => {
  const rows = await db.query(
    "select p.title, u.Name from posts p left join users u on u.id = p.user_id order by p.id",
  )
  exact<(typeof rows)[number], { title: string; Name: string | null }>(true)
  expect([...rows]).toEqual([
    { title: "first", Name: "ada" },
    { title: "orphan", Name: null },
  ])
})

test("group by, a scalar subquery, a CTE and a view", async () => {
  const grouped = await db.query("select user_id, max(views) as top, group_concat(title) as titles from posts group by user_id order by user_id")
  expect([...grouped]).toEqual([
    { user_id: 1, top: 0, titles: "first" },
    { user_id: 2, top: 0, titles: "orphan" },
  ])

  const counted = await db.query("select u.id, (select count(*) from posts p where p.user_id = u.id) as posts from users u")
  expect([...counted]).toEqual([{ id: 1, posts: 1 }])

  const best = await db.query(
    "with top as (select user_id, max(score) as best from posts group by user_id) select u.Name, t.best from users u join top t on t.user_id = u.id",
  )
  expect([...best]).toEqual([{ Name: "ada", best: 2.5 }])

  expect([...(await db.query("select title, author from titles"))]).toEqual([{ title: "first", author: "ada" }])
})

test("positional placeholders, and a text primary key that accepts NULL", async () => {
  await db.query("insert into tags values (?, ?)", ["color", null]).run()
  const [tag] = await db.query("select k, v from tags where k = ?", ["color"])
  expect(tag).toEqual({ k: "color", v: null })

  // Not STRICT and not the rowid, so SQLite stores the NULL.
  await db.query("insert into loose_pk(v) values (:v)", { v: "x" }).run()
  const [pk] = await db.query("select k, v from loose_pk")
  exact<typeof pk, { k: number | null; v: string | null } | undefined>(true)
  expect(pk).toEqual({ k: null, v: "x" })
})

test("fts5 columns and the implicit rowid", async () => {
  await db.query("insert into docs(title, body) values (:t, :b)", { t: "typed sql", b: "no generator" }).run()
  const rows = await db.query("select title, rowid from docs where docs match :q", { q: "generator" })
  expect([...rows]).toEqual([{ title: "typed sql", rowid: 1 }])
})

test("update and delete with returning", async () => {
  const updated = await db.query("update users set email = :email where id = :id returning email", { email: "a@b.c", id: 1 })
  expect([...updated]).toEqual([{ email: "a@b.c" }])
  const deleted = await db.query("delete from tags where k = ? returning v", ["color"])
  expect([...deleted]).toEqual([{ v: null }])
})

test("@name and $name bind under the bare name, like :name", async () => {
  const rows = await db.query("select id from users where id = @id or Name = $name", { id: 99, name: "ada" })
  expect([...rows]).toEqual([{ id: 1 }])
})

test("transaction hands the callback a typed tx", async () => {
  const name = await db.transaction(async (tx) => {
    await tx.query("update users set Name = :n where id = :id", { n: "ada l", id: 1 }).run()
    const [row] = await tx.query("select Name from users where id = :id", { id: 1 })
    return row?.Name
  })
  exact<typeof name, string | undefined>(true)
  expect(name).toBe("ada l")
})

test("live takes the SQL string and named arguments, and its rows are typed", async () => {
  const live = db.live("select id, Name from users where id = :id", { id: 1 })
  const rows = await new Promise<{ id: number; Name: string }[]>((resolve) => live.on("rows", (e) => resolve(e.rows)))
  live.close()
  expect(rows).toEqual([{ id: 1, Name: "ada l" }])
})
