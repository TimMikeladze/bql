// `bql.sh/web` against a real server: `connect()` with a `pk_` key, `table()` reads, writes and
// live lists, and a session refresh carrying a live list across to new tokens.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { connect, type Row, type WebDb } from "../../src/web/index.ts"
import { compareRows, selectSql, sharedTableSql, uuidv7, type SharedRow } from "../../src/web/table.ts"
import { startTestServer, stopAll, type TestServer } from "../server/harness.ts"

const ORIGIN = "https://page.test"
let server: TestServer
let key: string
const open: WebDb[] = []

/** Bun's fetch sends no `Origin`; a browser always does. `spoil` makes the next query a 401. */
let spoil = false
const pageFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set("origin", ORIGIN)
  if (spoil && String(input).endsWith("/query")) {
    spoil = false
    headers.set("authorization", "Bearer spoiled")
  }
  return fetch(input, { ...init, headers })
}) as typeof fetch

let n = 0
async function visit(visitor = `visitor-${String(++n).padStart(16, "0")}`): Promise<WebDb> {
  const db = await connect(key, { url: server.url, visitor, fetch: pageFetch })
  open.push(db)
  return db
}

/** Resolves with the first list `live()` delivers that passes `check`. */
function waitFor<T>(subscribe: (cb: (rows: T[]) => void) => () => void, check: (rows: T[]) => boolean): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("live list never matched")), 4000)
    const stop = subscribe((rows) => {
      if (!check(rows)) return
      clearTimeout(timer)
      queueMicrotask(() => stop())
      resolve(rows)
    })
  })
}

interface Todo extends Record<string, unknown> {
  title: string
  done: boolean
  rank?: number
}

beforeAll(async () => {
  server = await startTestServer()
  const app = await server.json<{ key: string; sharedDb: string }>("/v1/apps", {
    method: "POST",
    body: JSON.stringify({ id: "page", config: {
        origins: [ORIGIN],
        tables: { guestbook: { mode: "a" }, posts: { mode: "rw" } },
        actions: {
          sign: {
            input: { message: { type: "text", maxLength: 40 } },
            run: [
              { sql: "insert into guestbook(message) select :message where length(:message) > 0", expect: 1, error: "say something" },
              { sql: "select count(*) as n from guestbook" },
            ],
          },
        },
        // Every test is a new visitor from 127.0.0.1; the default 10 a minute would refuse them.
        session: { newVisitorsPerMinute: 1000 },
      } }),
  })
  key = app.key
  await server.fetch(`/v1/db/${app.sharedDb}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "create table guestbook(id integer primary key, message text)" }),
  })
  await server.fetch(`/v1/db/${app.sharedDb}/batch`, {
    method: "POST",
    body: JSON.stringify({ statements: sharedTableSql("posts").map((sql) => ({ sql })) }),
  })
})
afterAll(async () => {
  for (const db of open) db.close()
  await stopAll()
})

describe("connect", () => {
  test("the same visitor gets the same database back", async () => {
    const first = await visit("same-visitor-0000000000")
    await first.table<Todo>("todos").insert({ title: "write it", done: false })
    const again = await visit("same-visitor-0000000000")
    expect(again.db).toBe(first.db)
    expect((await again.table<Todo>("todos").list()).map((t) => t.title)).toEqual(["write it"])
  })

  test("an origin the app does not list is refused with the server's code", async () => {
    const otherFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set("origin", "https://evil.test")
      return fetch(input, { ...init, headers })
    }) as typeof fetch
    const err = await connect(key, { url: server.url, visitor: "v".repeat(22), fetch: otherFetch }).catch((e) => e)
    expect(err.code).toBe("NOT_AUTHORIZED")
  })
})

describe("table", () => {
  test("insert, get, update and delete", async () => {
    const todos = (await visit()).table<Todo>("todos")
    const made = await todos.insert({ title: "ship it", done: false })
    expect(made.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(made.createdAt).toBeGreaterThan(0)
    expect(await todos.get(made.id)).toEqual(made)

    const updated = await todos.update(made.id, { done: true })
    expect(updated?.done).toBe(true)
    expect(updated?.title).toBe("ship it")
    expect(await todos.update("missing", { done: true })).toBeNull()

    expect(await todos.delete(made.id)).toBe(true)
    expect(await todos.delete(made.id)).toBe(false)
    expect(await todos.get(made.id)).toBeNull()
  })

  test("where, orderBy and limit", async () => {
    const todos = (await visit()).table<Todo>("todos")
    for (const [title, done, rank] of [["c", false, 3], ["a", true, 1], ["b", false, 2], ["d", false, null]] as const) {
      await todos.insert({ title, done, ...(rank === null ? {} : { rank }) })
    }
    const open = await todos.where({ done: false }).orderBy("rank", "desc").list()
    expect(open.map((t) => t.title)).toEqual(["c", "b", "d"])
    expect((await todos.orderBy("title").limit(2).list()).map((t) => t.title)).toEqual(["a", "b"])
    expect((await todos.where({ rank: null }).list()).map((t) => t.title)).toEqual(["d"])
  })

  test("field names and values never reach the SQL text", async () => {
    const todos = (await visit()).table<Todo>("todos")
    expect(() => todos.where({ "done') or 1=1 --": true })).toThrow(TypeError)
    const odd = await todos.insert({ title: "'); drop table todos; --", done: false })
    expect((await todos.get(odd.id))?.title).toBe("'); drop table todos; --")
    const { strings } = selectSql("todos", { where: [["title", "x"]], order: [["rank", "asc"]], limit: 5 })
    expect(strings.join("?")).not.toContain("title")
  })

  test("a table name that is not an identifier is refused", async () => {
    const db = await visit()
    expect(() => db.table('todos"; drop')).toThrow(TypeError)
  })
})

describe("live", () => {
  test("delivers the list, then the list after each change, in order", async () => {
    const todos = (await visit()).table<Todo>("todos")
    const first = await todos.insert({ title: "b", done: false })
    const view = todos.where({ done: false }).orderBy("title")
    const seen: string[][] = []
    const stop = view.live((rows) => seen.push(rows.map((r) => r.title)))
    await waitFor<Row<Todo>>((cb) => view.live(cb), (rows) => rows.length === 1)

    await todos.insert({ title: "a", done: false })
    await todos.update(first.id, { done: true })
    await waitFor<Row<Todo>>((cb) => view.live(cb), (rows) => rows.length === 1 && rows[0]?.title === "a")
    await Bun.sleep(100)
    stop()
    expect(seen[0]).toEqual(["b"])
    expect(seen).toContainEqual(["a", "b"])
    expect(seen.at(-1)).toEqual(["a"])
  })

  test("keeps going across a session refresh", async () => {
    const db = await visit()
    const todos = db.table<Todo>("todos")
    const lists: number[] = []
    const stop = todos.live((rows) => lists.push(rows.length))
    await waitFor<Row<Todo>>((cb) => todos.live(cb), () => true)
    await db.refresh()
    await todos.insert({ title: "after refresh", done: false })
    await waitFor<Row<Todo>>((cb) => todos.live(cb), (rows) => rows.length === 1)
    await Bun.sleep(150)
    stop()
    expect(lists.at(-1)).toBe(1)
  })
})

describe("db.live", () => {
  /** Resolves with the first event that passes `check`. */
  function next<T>(on: (fn: (value: T) => void) => void, check: (value: T) => boolean): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no matching event")), 4000)
      on((value) => {
        if (!check(value)) return
        clearTimeout(timer)
        resolve(value)
      })
    })
  }

  test("without a key, every change delivers the whole result", async () => {
    const db = await visit()
    await db.sql`create table notes(id integer primary key, body text)`
    const live = db.live<{ body: string }>`select body from notes order by id`
    const lists: string[][] = []
    const two = next<{ body: string }[]>((fn) => live.on("rows", (rows) => { lists.push(rows.map((r) => r.body)); fn(rows) }), (rows) => rows.length === 2)
    await next<{ body: string }[]>((fn) => live.on("rows", fn), () => true)
    await db.sql`insert into notes(body) values (${"one"})`
    await db.sql`insert into notes(body) values (${"two"})`
    await two
    live.close()
    expect(lists[0]).toEqual([])
    expect(lists.at(-1)).toEqual(["one", "two"])
  })

  test("with a key, changes arrive as diffs", async () => {
    const db = await visit()
    await db.sql`create table notes(id integer primary key, body text)`
    await db.sql`insert into notes(body) values (${"one"})`
    const live = db.live<{ id: number; body: string }>`select id, body from notes`.key("id")
    await next((fn) => live.on("rows", fn), (rows: unknown[]) => rows.length === 1)
    const diff = next<{ added: { body: string }[]; removed: { id: number }[]; updated: unknown[] }>(
      (fn) => live.on("diff", fn as never),
      (d) => d.added.length > 0,
    )
    await db.sql`insert into notes(body) values (${"two"})`
    expect((await diff).added.map((r) => r.body)).toEqual(["two"])
    const removed = next<{ removed: { id: number }[] }>((fn) => live.on("diff", fn as never), (d) => d.removed.length > 0)
    await db.sql`delete from notes where id = ${1}`
    expect((await removed).removed).toEqual([{ id: 1 }])
    live.close()
  })

  test("re-subscribes across a session refresh, starting with the full rows", async () => {
    const db = await visit()
    await db.sql`create table notes(id integer primary key, body text)`
    const live = db.live<{ body: string }>`select body from notes`
    await next((fn) => live.on("rows", fn), () => true)
    await db.refresh()
    const after = next<{ body: string }[]>((fn) => live.on("rows", fn), (rows) => rows.length === 1)
    await db.sql`insert into notes(body) values (${"after refresh"})`
    expect((await after).map((r) => r.body)).toEqual(["after refresh"])
    live.close()
  })

  test("shared.live reads the shared tables the token can see", async () => {
    const db = await visit()
    if (!db.shared) throw new Error("expected shared tables")
    const live = db.shared.live<{ message: string }>`select message from guestbook where message = ${"live hello"}`
    const seen = next<{ message: string }[]>((fn) => live.on("rows", fn), (rows) => rows.length === 1)
    await Bun.sleep(50)
    await db.shared.sql`insert into guestbook(message) values (${"live hello"})`
    expect((await seen)[0]?.message).toBe("live hello")
    live.close()
  })
})

describe("tokens", () => {
  test("a 401 refreshes the session and retries once", async () => {
    const todos = (await visit()).table<Todo>("todos")
    await todos.list()
    spoil = true
    await todos.insert({ title: "after a 401", done: false })
    expect(spoil).toBe(false)
    expect((await todos.list()).map((t) => t.title)).toEqual(["after a 401"])
  })

  test("the shared database takes the app's modes", async () => {
    const db = await visit()
    if (!db.shared) throw new Error("expected shared tables")
    await db.shared.sql`insert into guestbook(message) values (${"hello"})`
    const err = await db.shared.sql`update guestbook set message = ${"edited"}`.catch((e) => e)
    expect(err.code).toBe("NOT_AUTHORIZED")
  })
})

describe("shared.table", () => {
  interface Post extends Record<string, unknown> {
    text: string
  }

  test("rows carry their author; only the author changes them", async () => {
    const ann = await visit()
    const bob = await visit()
    if (!ann.shared || !bob.shared) throw new Error("expected shared tables")
    const annPosts = ann.shared.table<Post>("posts")
    const bobPosts = bob.shared.table<Post>("posts")

    const post = (await annPosts.insert({ text: "hello", author: "forged" } as Post)) as SharedRow<Post>
    expect(post.author).toBe(ann.author)
    expect(post.author).not.toBe(bob.author)

    expect(((await bobPosts.get(post.id)) as SharedRow<Post> | null)?.author).toBe(ann.author)
    const refused = await bobPosts.update(post.id, { text: "edited by bob" }).catch((err) => err)
    expect(refused.code).toBe("SQLITE_CONSTRAINT_TRIGGER")
    expect((await bobPosts.delete(post.id).catch((err) => err)).code).toBe("SQLITE_CONSTRAINT_TRIGGER")

    expect((await annPosts.update(post.id, { text: "edited" }))?.text).toBe("edited")
    const mine = (await bobPosts.where({ author: ann.author }).list()) as SharedRow<Post>[]
    expect(mine.map((p) => p.text)).toContain("edited")
  })

  test("a live list sees another visitor's post", async () => {
    const ann = await visit()
    const bob = await visit()
    if (!ann.shared || !bob.shared) throw new Error("expected shared tables")
    const text = `from bob ${Date.now()}`
    const seen = waitFor<Row<Post>>((cb) => ann.shared!.table<Post>("posts").where({ text }).live(cb), (rows) => rows.length === 1)
    await Bun.sleep(50)
    await bob.shared.table<Post>("posts").insert({ text })
    expect(((await seen)[0] as SharedRow<Post>).author).toBe(bob.author)
  })
})

describe("db.action", () => {
  test("runs an action and returns each statement's rows", async () => {
    const db = await visit()
    const done = await db.action<{ n: number }>("sign", { message: "via an action" })
    expect(done.results[0]?.rowsAffected).toBe(1)
    expect(done.results[1]?.rows[0]?.n).toBeGreaterThan(0)
  })

  test("rejects with the server's code and the action's error", async () => {
    const db = await visit()
    const failed = await db.action("sign", { message: "" }).catch((err) => err)
    expect(failed.code).toBe("CONFLICT")
    expect(failed.message).toBe("say something")
    expect((await db.action("sign", { message: "x".repeat(41) }).catch((err) => err)).code).toBe("BAD_REQUEST")
  })
})

describe("db.state", () => {
  type Todo = { title: string; done: boolean }
  const defaults = { todos: [] as Todo[], theme: "dark", prefs: { size: 14 } }

  async function stored(db: WebDb, key: string): Promise<unknown> {
    const [row] = await db.sql<{ value: string }>`select value from bql_state where key = ${key}`
    return row ? JSON.parse(row.value) : undefined
  }

  test("mutations persist, and defaults fill what was never written", async () => {
    const v = "state-visitor-00000000001"
    const db = await visit(v)
    const app = await db.state(defaults)
    expect(app.theme).toBe("dark")
    app.todos.push({ title: "write it", done: false })
    app.todos[0]!.done = true
    app.prefs.size = 16
    await app.$saved

    const again = await (await visit(v)).state(defaults)
    expect(again.todos).toEqual([{ title: "write it", done: true }])
    expect(again.prefs).toEqual({ size: 16 })
    expect(again.theme).toBe("dark")
    expect(await stored(db, "theme")).toBeUndefined()
  })

  test("two tabs pushing at once both land", async () => {
    const v = "state-visitor-00000000002"
    const one = await (await visit(v)).state(defaults)
    const two = await (await visit(v)).state(defaults)
    one.todos.push({ title: "from one", done: false })
    two.todos.push({ title: "from two", done: false })
    await Promise.all([one.$saved, two.$saved])
    const db = await visit(v)
    const titles = ((await stored(db, "todos")) as Todo[]).map((t) => t.title).sort()
    expect(titles).toEqual(["from one", "from two"])
  })

  test("splice writes the array whole; delete removes a field", async () => {
    const db = await visit()
    const app = await db.state(defaults)
    app.todos.push({ title: "a", done: false }, { title: "b", done: false }, { title: "c", done: false })
    await app.$saved
    app.todos.splice(1, 1)
    delete (app.prefs as { size?: number }).size
    await app.$saved
    expect(((await stored(db, "todos")) as Todo[]).map((t) => t.title)).toEqual(["a", "c"])
    expect(await stored(db, "prefs")).toEqual({})
  })

  test("a change in one tab reaches the other, with a change event", async () => {
    const v = "state-visitor-00000000003"
    const one = await (await visit(v)).state(defaults)
    const two = await (await visit(v)).state(defaults)
    const seen = new Promise<string>((resolve) => {
      two.$on("change", (state) => {
        if (state.theme === "light") resolve(state.theme)
      })
    })
    await Bun.sleep(50)
    one.theme = "light"
    expect(await Promise.race([seen, Bun.sleep(3000).then(() => "no change event")])).toBe("light")
  })

  test("a root key may not start with $", async () => {
    const app = await (await visit()).state(defaults)
    expect(() => {
      ;(app as unknown as Record<string, unknown>).$hidden = 1
    }).toThrow(TypeError)
  })
})

describe("helpers", () => {
  test("uuidv7 ids sort by time", () => {
    expect(uuidv7(1000) < uuidv7(2000)).toBe(true)
  })

  test("compareRows orders null first, then numbers, then text, ties by creation", () => {
    const row = (id: string, createdAt: number, v: unknown) => ({ id, createdAt, updatedAt: createdAt, v }) as Row
    const rows = [row("a", 3, "x"), row("b", 2, 5), row("c", 1, null), row("d", 0, 5)]
    expect(rows.sort(compareRows([["v", "asc"]])).map((r) => r.id)).toEqual(["c", "d", "b", "a"])
  })
})
