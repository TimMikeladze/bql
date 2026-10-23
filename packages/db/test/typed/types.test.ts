// A type-level test: `bun run typecheck` is the assertion. Each `exact` compiles only when the
// row or argument type the parser infers from the SQL string is the one written next to it, and
// each `@ts-expect-error` only when the parser rejects the statement. runtime.test.ts runs the
// same shapes against SQLite to check the claims are true.

import { expect, test } from "bun:test"
import type { JsRow, JsValue } from "../../src/client/values.ts"
import type { Param } from "../../src/typed/index.ts"
import { schema, type Executor, type Row as RowType, type Table } from "../../src/typed/index.ts"
import { app } from "./schema.ts"

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
function exact<A, B>(_assertion: Exact<A, B>): void {}

// Never called: every query below is only type-checked.
const executor: Executor = {
  execute: () => {
    throw new Error("not run")
  },
}
const db = app.typed(executor)
type Row<Q> = Q extends { then(onfulfilled?: ((value: infer R) => unknown) | null): unknown } ? (R extends (infer X)[] ? X : never) : never

// columns, aliases, nullability
exact<Row<ReturnType<typeof db.query<"select id, Name, email from users">>>, { id: number; Name: string; email: string | null }>(true)
// An unaliased column reports its declared name, whatever case the query wrote it in.
exact<Row<ReturnType<typeof db.query<"select NAME from users">>>, { Name: string }>(true)
exact<Row<ReturnType<typeof db.query<"select u.email as mail, u.id uid from users u">>>, { mail: string | null; uid: number }>(true)
exact<Row<ReturnType<typeof db.query<"select created, avatar, meta from users">>>, { created: string | null; avatar: Uint8Array | null; meta: JsValue }>(true)

// primary keys: only the rowid and STRICT/WITHOUT ROWID keys refuse NULL
exact<Row<ReturnType<typeof db.query<"select k from tags">>>, { k: string }>(true)
exact<Row<ReturnType<typeof db.query<"select k, v from loose_pk">>>, { k: number | null; v: string | null }>(true)

// joins
exact<
  Row<ReturnType<typeof db.query<"select p.id, p.title, u.Name from posts p left join users u on u.id = p.user_id">>>,
  { id: number; title: string; Name: string | null }
>(true)
exact<
  Row<ReturnType<typeof db.query<"select p.title, u.Name from posts p right join users u on u.id = p.user_id">>>,
  { title: string | null; Name: string }
>(true)
exact<Row<ReturnType<typeof db.query<"select * from tags">>>, { k: string; v: string | null }>(true)
exact<Row<ReturnType<typeof db.query<"select t.* from posts p join tags t on t.k = p.title">>>, { k: string; v: string | null }>(true)
exact<Row<ReturnType<typeof db.query<"select views from posts">>>, { views: number }>(true)

// expressions
exact<
  Row<ReturnType<typeof db.query<"select count(*) as n, max(score) as top, sum(views) as v from posts">>>,
  { n: number; top: number | null; v: number | null }
>(true)
// With group by every group has a row, so an aggregate of a non-null column is non-null.
exact<
  Row<ReturnType<typeof db.query<"select user_id, max(views) as top, group_concat(title) as titles from posts group by user_id">>>,
  { user_id: number; top: number; titles: string }
>(true)
exact<
  Row<ReturnType<typeof db.query<"select coalesce(email, Name) as contact, upper(email) as up, cast(id as text) as sid, id + 1 as next from users">>>,
  { contact: string; up: string | null; sid: string; next: number }
>(true)
exact<
  Row<ReturnType<typeof db.query<"select case when score > 1 then 'hi' else 'lo' end as band, case when score > 1 then title end as t from posts">>>,
  { band: string; t: string | null }
>(true)
exact<
  Row<ReturnType<typeof db.query<"select title || ' by ' || user_id as label, email is null as noemail, 1 as one, null as nothing, json_group_array(posts.id) as ids from posts, users">>>,
  { label: string; noemail: number; one: number; nothing: null; ids: string }
>(true)
exact<
  Row<ReturnType<typeof db.query<"select u.id, (select count(*) from posts p where p.user_id = u.id) as posts from users u">>>,
  { id: number; posts: number | null }
>(true)

// with, union, views, fts
exact<
  Row<ReturnType<typeof db.query<"with top as (select user_id, max(score) as best from posts group by user_id) select u.Name, t.best from users u join top t on t.user_id = u.id">>>,
  { Name: string; best: number | null }
>(true)
exact<Row<ReturnType<typeof db.query<"select id, email as x from users union all select id, null from posts">>>, { id: number; x: string | null }>(true)
exact<Row<ReturnType<typeof db.query<"select title, author from titles">>>, { title: string; author: string }>(true)
exact<Row<ReturnType<typeof db.query<"select title, rowid from docs where docs match :q">>>, { title: string | null; rowid: number }>(true)

// writes
exact<Row<ReturnType<typeof db.query<"insert into posts(user_id, title) values (:u, :t)">>>, {}>(true)
exact<
  Row<ReturnType<typeof db.query<"insert into posts(user_id, title) values (:u, :t) returning id, views">>>,
  { id: number; views: number }
>(true)
exact<Row<ReturnType<typeof db.query<"update users set email = :e where id = :id returning *">>>, {
  id: number
  Name: string
  email: string | null
  created: string | null
  avatar: Uint8Array | null
  meta: JsValue
}>(true)
exact<Row<ReturnType<typeof db.query<"delete from tags where k = ? returning v">>>, { v: string | null }>(true)

// parameters
type Args<Q extends string> = Parameters<typeof db.query<Q>>[1]
type Num = number | bigint | boolean
exact<Args<"select * from users where id = :id and Name like :pat">, { id: Num; pat: string }>(true)
exact<Args<"select * from posts where score between :lo and :hi limit :n">, { lo: Num; hi: Num; n: number }>(true)
exact<Args<"select * from users where id in (:a, :b)">, { a: Num; b: Num }>(true)
exact<Args<"select * from users where :name = Name">, { name: string }>(true)
// An insert or a `set` can write NULL into a nullable column; a comparison wants a value.
exact<Args<"insert into users(Name, email) values (:name, :email)">, { name: string; email: string | null }>(true)
exact<Args<"update users set email = :email where email = :old">, { email: string | null; old: string }>(true)
exact<Args<"select * from tags where k = ? and v = ?">, [string, string]>(true)
exact<Args<"insert into tags values (?, ?)">, [string, string | null]>(true)
// A placeholder the parser can't place is any bindable value.
exact<Args<"select abs(:x) as a">, { x: Param }>(true)
exact<Parameters<typeof db.query<"select * from users">>, ["select * from users"]>(true)

// What gets rejected, with SQLite's own wording.
// Wrapped in a function so the calls are type-checked and never run.
export function rejected(): void {
  // @ts-expect-error bql: no such column: nme
  db.query("select nme from users")
  // @ts-expect-error bql: no such table: user
  db.query("select id from user")
  // @ts-expect-error bql: ambiguous column name: id
  db.query("select id from posts p join users u on u.id = p.user_id")
  // @ts-expect-error bql: no such column: nope
  db.query("insert into posts(user_id, title) values (1, 'x') returning nope")
  // A dropped table is gone, and a string may hold more than one statement.
  const dropped = schema("create table gone(x); create table kept(y)", "drop table gone").typed(executor)
  // @ts-expect-error bql: no such table: gone
  dropped.query("select * from gone")
  exact<Row<ReturnType<typeof dropped.query<"select y from kept">>>, { y: JsValue }>(true)
  // @ts-expect-error the named parameter is required
  db.query("select * from users where id = :id")
  // @ts-expect-error a text column doesn't take a number
  db.query("select * from users where Name = :n", { n: 1 })
}

// alter table keeps up: a renamed table and column, a dropped column.
const altered = schema(
    "create table t(a integer not null, b text, c real)",
    "alter table t rename column b to bee",
    "alter table t drop column c",
    "alter table t rename to t2",
  ).typed(executor)
exact<Row<ReturnType<typeof altered.query<"select * from t2">>>, { a: number; bee: string | null }>(true)
export function alteredRejects(): void {
  // @ts-expect-error bql: no such column: c
  altered.query("select c from t2")
  // @ts-expect-error bql: no such table: t
  altered.query("select a from t")
}
exact<Args<"select * from users where id = @id or Name = $name">, { id: Num; name: string }>(true)

// Completions: the editor offers the literal types in the parameter, so these are what it lists.
type Offered<Q extends string> = Exclude<Parameters<typeof db.query<Q>>[0], Q | `bql: ${string}`>
exact<Offered<"select * from u">, "select * from users">(true)
exact<Offered<"select na from users">, "select Name from users">(true)
exact<Offered<"select * from users u where u.em">, "select * from users u where u.email">(true)
exact<
  Offered<"select id from posts p join users u on u.id = p.user_id">,
  "select p.id from posts p join users u on u.id = p.user_id" | "select u.id from posts p join users u on u.id = p.user_id"
>(true)
exact<Offered<"select * from tags where ">, "select * from tags where k" | "select * from tags where v">(true)
// A query that checks and ends on a whole word offers nothing.
exact<Offered<"select k, v from tags where k = :k">, never>(true)

// Named types for a table's row and a query's row, to pass around.
exact<Table<typeof app, "users">, { id: number; Name: string; email: string | null; created: string | null; avatar: Uint8Array | null; meta: JsValue }>(true)
exact<RowType<typeof app, "select id, Name from users">, { id: number; Name: string }>(true)

// What degrades to untyped instead of failing.
exact<Row<ReturnType<typeof db.query<"pragma table_info(users)">>>, JsRow>(true)
exact<Row<ReturnType<typeof db.query<"select key, value from json_each(:j)">>>, { key: JsValue; value: JsValue }>(true)
const sql: string = "select 1"
exact<Row<ReturnType<typeof db.query<typeof sql>>>, JsRow>(true)

test("the type assertions above are checked by `bun run typecheck`", () => {
  expect(app.ddl.length).toBe(7)
})
