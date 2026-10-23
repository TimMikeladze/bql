// Apps, `pk_` keys and `/v1/session` (docs/plan-web.md), end to end: the tokens a session hands
// out are used against a real listener, because the claim is about what SQLite then lets them do.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ActionVerifyError, verifyAction } from "../../src/actions/index.ts"
import { createClient } from "../../src/client/index.ts"
import type { RouteContext } from "../../src/server/routes.ts"
import {
  NewVisitorLimiter,
  originAllowed,
  parseAppConfig,
  sweepUnusedVisitors,
  UNUSED_VISITOR_MS,
  visitorDbOf,
} from "../../src/server/web.ts"
import { createTableSql, sharedTableSql } from "../../src/web/table.ts"
import { startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer
const ORIGIN = "https://acme.test"

interface App {
  id: string
  key: string
  sharedDb: string
}
interface Session {
  private: { db: string; token: string }
  shared: { db: string; token: string } | null
  exp: number
}

function visitor(n: number): string {
  return `visitor-${String(n).padStart(16, "0")}`
}

function run(db: string, sql: string, token?: string | null): Promise<Response> {
  return server.fetch(`/v1/db/${db}/query`, { method: "POST", token, body: JSON.stringify({ sql }) })
}

function session(key: string, who: string, origin: string | null = ORIGIN): Promise<Response> {
  return server.fetch("/v1/session", {
    method: "POST",
    token: null,
    headers: origin === null ? {} : { origin },
    body: JSON.stringify({ key, visitor: who }),
  })
}

async function createApp(id: string, config: unknown): Promise<App> {
  const response = await server.fetch("/v1/apps", { method: "POST", body: JSON.stringify({ id, config }) })
  if (response.status !== 201) throw new Error(`create app failed: ${await response.text()}`)
  return (await response.json()) as App
}

let app: App

beforeAll(async () => {
  server = await startTestServer()
  app = await createApp("acme", {
    origins: [ORIGIN],
    tables: {
      scores: { mode: "a" },
      best: { mode: "r" },
      signups: { mode: "a", read: false },
    },
  })
  for (const sql of [
    "create table scores(id integer primary key, player text, score integer)",
    "create table best(player text primary key, score integer)",
    "create table signups(id integer primary key, email text)",
    `create trigger keep_best after insert on scores begin
       insert into best values (new.player, new.score)
         on conflict(player) do update set score = max(score, excluded.score);
     end`,
  ]) {
    expect((await run(app.sharedDb, sql)).status).toBe(200)
  }
})
afterAll(stopAll)

describe("app config", () => {
  test("defaults allow localhost and a one-hour session", () => {
    const config = parseAppConfig()
    expect(config.origins).toEqual(["http://localhost:*", "http://127.0.0.1:*"])
    expect(config.session).toEqual({ ttlMs: 3_600_000, newVisitorsPerMinute: 10 })
  })

  test("unknown keys and bad modes are refused, and planned keys say so", () => {
    expect(() => parseAppConfig({ forms: {} })).toThrow(/forms is not supported/)
    expect(() => parseAppConfig({ tables: { t: { mode: "w" } } })).toThrow(/mode must be/)
    expect(() => parseAppConfig({ origins: ["acme.test"] })).toThrow(/must look like/)
  })

  test("origins match exactly, by subdomain wildcard, or by any port", () => {
    expect(originAllowed(["https://acme.test"], "https://acme.test")).toBe(true)
    expect(originAllowed(["https://acme.test"], "https://evil.test")).toBe(false)
    expect(originAllowed(["https://*.acme.test"], "https://pr-4.acme.test")).toBe(true)
    expect(originAllowed(["https://*.acme.test"], "https://acme.test.evil.test")).toBe(false)
    expect(originAllowed(["http://localhost:*"], "http://localhost:5173")).toBe(true)
    expect(originAllowed(["http://localhost:*"], "http://localhost")).toBe(true)
    expect(originAllowed(["*"], null)).toBe(false)
  })
})

describe("apps", () => {
  test("an app gets a pk_ key and a shared database", async () => {
    expect(app.key).toMatch(/^pk_[A-Za-z0-9_-]{32}$/)
    expect(app.sharedDb).toBe("app-acme-shared")
    const listed = await server.json<{ apps: App[] }>("/v1/apps")
    expect(listed.apps.map((one) => one.id)).toContain("acme")
  })

  test("only the admin manages apps", async () => {
    const { token } = await server.token({ dbs: ["*"], scope: "rw" })
    expect((await server.fetch("/v1/apps", { token })).status).toBe(403)
    expect((await server.fetch("/v1/apps", { token: null })).status).toBe(401)
  })

  test("client.admin manages apps", async () => {
    const client = createClient({ url: server.url, token: server.adminKey })
    try {
      const made = await client.admin.createApp("viaclient", { tables: { posts: { mode: "a" } } })
      expect(made.config.tables).toEqual({ posts: { mode: "a", read: true } })
      const pushed = await client.admin.updateApp("viaclient", { origins: ["https://acme.test"] })
      expect(pushed.config.origins).toEqual(["https://acme.test"])
      expect(pushed.config.tables).toEqual({})
      expect((await client.admin.deleteApp("viaclient")).deleted).toBe(true)
      expect((await client.admin.apps()).map((one) => one.id)).not.toContain("viaclient")
    } finally {
      client.close()
    }
  })

  test("an id that is taken is a conflict", async () => {
    const response = await server.fetch("/v1/apps", { method: "POST", body: JSON.stringify({ id: "acme" }) })
    expect(response.status).toBe(409)
  })
})

describe("sessions", () => {
  test("a visitor gets their own database, and the same one when they come back", async () => {
    const first = (await (await session(app.key, visitor(1))).json()) as Session
    expect(first.private.db).toBe(visitorDbOf("acme", visitor(1)).db)
    const token = first.private.token
    expect((await run(first.private.db, "create table todos(id integer primary key, title text)", token)).status).toBe(200)
    expect((await run(first.private.db, "insert into todos(title) values ('write it')", token)).status).toBe(200)

    const again = (await (await session(app.key, visitor(1))).json()) as Session
    expect(again.private.db).toBe(first.private.db)
    const rows = await run(again.private.db, "select title from todos", again.private.token)
    expect(((await rows.json()) as { rows: unknown[][] }).rows).toEqual([["write it"]])
  })

  test("a visitor's token reaches no other visitor's database", async () => {
    const one = (await (await session(app.key, visitor(2))).json()) as Session
    const two = (await (await session(app.key, visitor(3))).json()) as Session
    expect((await run(two.private.db, "select 1", one.private.token)).status).toBe(403)
    expect((await run(app.sharedDb, "select 1", one.private.token)).status).toBe(403)
  })

  test("the shared token carries the app's table modes", async () => {
    const { shared } = (await (await session(app.key, visitor(4))).json()) as Session
    if (!shared) throw new Error("expected a shared token")
    const status = async (sql: string) => (await run(shared.db, sql, shared.token)).status
    expect(await status("insert into scores(player, score) values ('ann', 10)")).toBe(200)
    expect(await status("update scores set score = 99")).toBe(403)
    expect(await status("insert into best values ('eve', 1)")).toBe(403)
    // `best` is read-only to the visitor, and the trigger kept it anyway.
    const best = await run(shared.db, "select player, score from best", shared.token)
    expect(((await best.json()) as { rows: unknown[][] }).rows).toEqual([["ann", 10]])
    // `read: false` leaves the table out of the token altogether.
    expect(await status("select * from signups")).toBe(403)
    expect(await status("insert into signups(email) values ('x@y.z')")).toBe(403)
  })

  test("an app with no visible tables hands out no shared token", async () => {
    const bare = await createApp("bare", { origins: [ORIGIN] })
    const body = (await (await session(bare.key, visitor(5))).json()) as Session
    expect(body.shared).toBeNull()
  })

  test("the origin, the key and the visitor id are all checked", async () => {
    expect((await session(app.key, visitor(6), "https://evil.test")).status).toBe(403)
    expect((await session(app.key, visitor(6), null)).status).toBe(403)
    expect((await session("pk_nope", visitor(6))).status).toBe(401)
    expect((await session(app.key, "short")).status).toBe(400)
  })

  test("rotating the key stops new sessions on the old one", async () => {
    const id = "rotating"
    const before = await createApp(id, { origins: [ORIGIN] })
    const after = await server.json<App>(`/v1/apps/${id}/rotate`, { method: "POST" })
    expect(after.key).not.toBe(before.key)
    expect((await session(before.key, visitor(7))).status).toBe(401)
    expect((await session(after.key, visitor(7))).status).toBe(201)
  })

  test("new visitors are limited per IP; a returning visitor is not", async () => {
    const limited = await createApp("limited", { origins: [ORIGIN], session: { newVisitorsPerMinute: 2 } })
    expect((await session(limited.key, visitor(10))).status).toBe(201)
    expect((await session(limited.key, visitor(11))).status).toBe(201)
    const refused = await session(limited.key, visitor(12))
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0)
    expect((await session(limited.key, visitor(10))).status).toBe(201)
  })
})

describe("the author column", () => {
  test("bql_sub() fills, checks and guards a shared table's author", async () => {
    const own = await createApp("authors", {
      origins: [ORIGIN],
      tables: { msgs: { mode: "rw" } },
      session: { newVisitorsPerMinute: 100 },
    })
    const ddl = await server.fetch(`/v1/db/${own.sharedDb}/batch`, {
      method: "POST",
      body: JSON.stringify({ statements: sharedTableSql("msgs").map((sql) => ({ sql })) }),
    })
    expect(ddl.status).toBe(200)
    const a = (await (await session(own.key, visitor(30))).json()) as Session
    const b = (await (await session(own.key, visitor(31))).json()) as Session
    const as = async (who: Session, sql: string) => {
      const response = await run(own.sharedDb, sql, who.shared?.token)
      return { status: response.status, body: (await response.json()) as { rows?: unknown[][]; error?: { code: string } } }
    }

    const made = await as(a, "insert into msgs(id, data) values ('m1', '{}') returning author")
    expect(made.status).toBe(200)
    const author = made.body.rows?.[0]?.[0]
    expect(author).toBe(visitorDbOf("authors", visitor(30)).sub)
    expect((await as(a, "select bql_sub()")).body.rows?.[0]?.[0]).toBe(author)

    expect((await as(a, "insert into msgs(id, author, data) values ('m2', 'someone', '{}')")).body.error?.code).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    )
    for (const sql of [
      "update msgs set data = '{\"x\":1}' where id = 'm1'",
      "update msgs set author = bql_sub() where id = 'm1'",
      "delete from msgs where id = 'm1'",
      "insert into msgs(id, data) values ('m1', '{}') on conflict(id) do update set data = excluded.data",
    ]) {
      expect((await as(b, sql)).body.error?.code).toBe("SQLITE_CONSTRAINT_TRIGGER")
    }
    // REPLACE would skip the DELETE trigger, so a token may not use it on this table at all.
    expect((await as(b, "insert or replace into msgs(id, data) values ('m1', '{}')")).status).toBe(403)
    expect((await as(b, "insert into msgs(id, data) values ('b1', '{}')")).status).toBe(200)
    expect((await as(b, "update or replace msgs set id = 'm1' where id = 'b1'")).body.error?.code).toBe(
      "SQLITE_CONSTRAINT_TRIGGER",
    )

    expect((await as(a, "update msgs set data = '{\"x\":2}' where id = 'm1'")).status).toBe(200)
    const kept = await as(a, "select author, data from msgs where id = 'm1'")
    expect(kept.body.rows).toEqual([[author, '{"x":2}']])
    // The admin is NULL to bql_sub(), passes every check, and names the author itself.
    expect((await run(own.sharedDb, "insert into msgs(id, author, data) values ('m3', 'owner', '{}')")).status).toBe(200)
  })
})

describe("actions", () => {
  const actions = {
    submitScore: {
      input: { score: { type: "int", min: 0, max: 1_000_000 }, name: { type: "text", minLength: 1, maxLength: 20 } },
      run: [
        {
          // One score a visitor; the check and the write are one statement, so they cannot race.
          sql: "insert into scores(user, name, score) select :user, :name, :score where not exists (select 1 from scores where user = :user)",
          expect: 1,
          error: "you already have a score",
        },
        { sql: "select count(*) as n from scores" },
      ],
    },
    note: { db: "private", input: { text: { type: "text" } }, run: [{ sql: "insert into notes(text) values (:text) returning id" }] },
    post: { input: { text: { type: "text" } }, run: [{ sql: "insert into msgs(id, data) values (lower(hex(randomblob(8))), json_object('text', :text)) returning author" }] },
  }
  let game: App

  async function act(key: string, token: string | undefined, name: string, input: unknown) {
    const response = await server.fetch("/v1/session/action", {
      method: "POST",
      token: token ?? null,
      headers: { origin: ORIGIN },
      body: JSON.stringify({ key, name, input }),
    })
    return { status: response.status, body: (await response.json()) as { results?: { rows: Record<string, unknown>[]; rowsAffected: number }[]; error?: { code: string; message: string } } }
  }

  beforeAll(async () => {
    game = await createApp("game", {
      origins: [ORIGIN],
      tables: { scores: { mode: "r" }, msgs: { mode: "r" } },
      actions,
      session: { newVisitorsPerMinute: 100 },
    })
    expect((await run(game.sharedDb, "create table scores(user text, name text, score integer)")).status).toBe(200)
    await server.fetch(`/v1/db/${game.sharedDb}/batch`, {
      method: "POST",
      body: JSON.stringify({ statements: sharedTableSql("msgs").map((sql) => ({ sql })) }),
    })
  })

  test("runs the owner's statements with the server's rights, as the caller", async () => {
    const who = (await (await session(game.key, visitor(40))).json()) as Session
    // The token alone may only read `scores`.
    expect((await run(game.sharedDb, "insert into scores values ('x', 'x', 1)", who.shared?.token)).status).toBe(403)

    const first = await act(game.key, who.private.token, "submitScore", { score: 4200, name: "ann" })
    expect(first.status).toBe(200)
    expect(first.body.results?.[0]?.rowsAffected).toBe(1)
    expect(first.body.results?.[1]?.rows).toEqual([{ n: 1 }])
    const stored = await run(game.sharedDb, "select user, name, score from scores", who.shared?.token)
    expect(((await stored.json()) as { rows: unknown[][] }).rows).toEqual([[visitorDbOf("game", visitor(40)).sub, "ann", 4200]])
  })

  test("an expect that does not match rolls the whole action back with its error", async () => {
    const who = (await (await session(game.key, visitor(41))).json()) as Session
    expect((await act(game.key, who.private.token, "submitScore", { score: 1, name: "bob" })).status).toBe(200)
    const again = await act(game.key, who.private.token, "submitScore", { score: 2, name: "bob" })
    expect(again.status).toBe(409)
    expect(again.body.error?.message).toBe("you already have a score")
    const count = await run(game.sharedDb, "select count(*) from scores where name = 'bob'")
    expect(((await count.json()) as { rows: unknown[][] }).rows).toEqual([[1]])
  })

  test("input is checked against the schema before anything runs", async () => {
    const who = (await (await session(game.key, visitor(42))).json()) as Session
    for (const input of [
      { score: -1, name: "x" },
      { score: 1.5, name: "x" },
      { score: 1, name: "" },
      { score: 1, name: "x".repeat(21) },
      { score: 1 },
      { score: 1, name: "x", user: "someone else" },
    ]) {
      expect((await act(game.key, who.private.token, "submitScore", input)).status).toBe(400)
    }
    expect((await act(game.key, who.private.token, "nope", {})).status).toBe(404)
  })

  test("the caller is proved by a session token of this app", async () => {
    const who = (await (await session(game.key, visitor(43))).json()) as Session
    expect((await act(game.key, undefined, "submitScore", { score: 1, name: "x" })).status).toBe(401)
    const other = (await (await session(app.key, visitor(43))).json()) as Session
    expect((await act(game.key, other.private.token, "submitScore", { score: 1, name: "x" })).status).toBe(403)
    // The shared token is not `rw` on the visitor's database, so it does not identify a caller.
    expect((await act(game.key, who.shared?.token, "submitScore", { score: 1, name: "x" })).status).toBe(403)
  })

  test("a private action runs on the caller's own database", async () => {
    const who = (await (await session(game.key, visitor(44))).json()) as Session
    expect((await run(who.private.db, "create table notes(id integer primary key, text text)", who.private.token)).status).toBe(200)
    const done = await act(game.key, who.private.token, "note", { text: "mine" })
    expect(done.body.results?.[0]?.rows).toEqual([{ id: 1 }])
  })

  test("bql_sub() is the caller inside an action, so the author column holds", async () => {
    const who = (await (await session(game.key, visitor(45))).json()) as Session
    const posted = await act(game.key, who.private.token, "post", { text: "via an action" })
    expect(posted.body.results?.[0]?.rows).toEqual([{ author: visitorDbOf("game", visitor(45)).sub }])
  })

  test("the config refuses schema changes and a :user input", () => {
    expect(() => parseAppConfig({ actions: { bad: { run: [{ sql: "drop table scores" }] } } })).toThrow(/must be one insert/)
    expect(() => parseAppConfig({ actions: { bad: { run: [{ sql: "attach 'x' as y" }] } } })).toThrow(/must be one insert/)
    expect(() => parseAppConfig({ actions: { bad: { input: { user: { type: "text" } }, run: [{ sql: "select 1" }] } } })).toThrow(/reserved/)
  })
})

describe("url actions", () => {
  let fn: ReturnType<typeof Bun.serve>
  let fnUrl: string
  let proxied: App
  const seen: { path: string; call?: unknown; error?: string }[] = []

  beforeAll(async () => {
    fn = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/slow") {
          await Bun.sleep(1000)
          return Response.json({ late: true })
        }
        if (path === "/text") return new Response("not json")
        try {
          const call = await verifyAction(request, { bql: server.url, url: `${fnUrl}${path}` })
          seen.push({ path, call })
          if (path === "/refuse") return Response.json({ error: { message: "sold out" } }, { status: 409 })
          // The function writes as the caller, with the token it was given.
          const client = createClient({ url: server.url, token: call.token })
          const [row] = await client.db(call.dbs.shared).sql`insert into posts(id, data) values (${call.nonce}, ${JSON.stringify({ text: call.input.text })}) returning author`
          client.close()
          return Response.json({ ok: true, author: row?.author, input: call.input })
        } catch (err) {
          seen.push({ path, error: String(err) })
          return Response.json({ error: String(err) }, { status: err instanceof ActionVerifyError ? 401 : 500 })
        }
      },
    })
    fnUrl = `http://127.0.0.1:${fn.port}`
    proxied = await createApp("proxied", {
      origins: [ORIGIN],
      tables: { posts: { mode: "r" } },
      actions: {
        post: { input: { text: { type: "text", maxLength: 40 } }, url: `${fnUrl}/post` },
        refuse: { url: `${fnUrl}/refuse` },
        slow: { url: `${fnUrl}/slow`, timeoutMs: 200 },
        text: { url: `${fnUrl}/text` },
      },
      session: { newVisitorsPerMinute: 100 },
    })
    await server.fetch(`/v1/db/${proxied.sharedDb}/batch`, {
      method: "POST",
      body: JSON.stringify({ statements: sharedTableSql("posts").map((sql) => ({ sql })) }),
    })
  })
  afterAll(() => fn.stop(true))

  async function call(token: string, name: string, input: unknown = {}) {
    const response = await server.fetch("/v1/session/action", {
      method: "POST",
      token,
      headers: { origin: ORIGIN },
      body: JSON.stringify({ key: proxied.key, name, input }),
    })
    return { status: response.status, body: (await response.json()) as { result?: Record<string, unknown>; error?: { code: string; message: string } } }
  }

  test("the function gets checked input, the caller and a token, and its answer comes back", async () => {
    const who = (await (await session(proxied.key, visitor(50))).json()) as Session
    const done = await call(who.private.token, "post", { text: "via my function" })
    expect(done.status).toBe(200)
    const sub = visitorDbOf("proxied", visitor(50)).sub
    // The token's sub is the caller, so the author column took them, not the function.
    expect(done.body.result).toEqual({ ok: true, author: sub, input: { text: "via my function" } })
    expect((await call(who.private.token, "post", { text: "x".repeat(41) })).status).toBe(400)
  })

  test("a refusal keeps its status and message; a slow or non-JSON function is a 502", async () => {
    const who = (await (await session(proxied.key, visitor(51))).json()) as Session
    const refused = await call(who.private.token, "refuse")
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatchObject({ code: "ACTION_FAILED", message: "sold out" })
    expect((await call(who.private.token, "slow")).status).toBe(502)
    expect((await call(who.private.token, "text")).status).toBe(502)
  })

  test("verifyAction refuses a tampered body, another URL and an expired call", async () => {
    // An echo function keeps the signed request bql.sh sent it, to replay against verifyAction.
    let headers: Record<string, string> = {}
    let body = ""
    const echo = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        headers = { "bql-signature": request.headers.get("bql-signature") ?? "", "bql-key-id": request.headers.get("bql-key-id") ?? "" }
        body = await request.text()
        return Response.json({})
      },
    })
    const echoUrl = `http://127.0.0.1:${echo.port}/echo`
    const echoApp = await createApp("echo", { origins: [ORIGIN], actions: { echo: { url: echoUrl } }, session: { newVisitorsPerMinute: 100 } })
    const who = (await (await session(echoApp.key, visitor(53))).json()) as Session
    await server.fetch("/v1/session/action", {
      method: "POST",
      token: who.private.token,
      headers: { origin: ORIGIN },
      body: JSON.stringify({ key: echoApp.key, name: "echo", input: {} }),
    })
    echo.stop(true)

    const check = (sent: string, url = echoUrl, now?: number) =>
      verifyAction(new Request(url, { method: "POST", headers, body: sent }), { bql: server.url, url, ...(now ? { now } : {}) }).then(
        (call) => `ok ${call.action}`,
        (err) => (err as Error).message,
      )
    expect(await check(body)).toBe("ok echo")
    expect(await check(body.replace('"action":"echo"', '"action":"other"'))).toContain("signature does not match")
    expect(await check(body, `${fnUrl}/post`)).toContain("signed for")
    expect(await check(body, echoUrl, Math.floor(Date.now() / 1000) + 3600)).toContain("expired")
    const unsigned = new Request(echoUrl, { method: "POST", body })
    expect(await verifyAction(unsigned, { bql: server.url }).catch((err) => err)).toBeInstanceOf(ActionVerifyError)
    expect((await server.json<{ keys: unknown[] }>("/.well-known/jwks.json", { token: null })).keys.length).toBeGreaterThan(0)
  })

  test("parsing a parsed config gives it back unchanged, since that is what the catalog stores", () => {
    const config = {
      origins: [ORIGIN],
      tables: { posts: { mode: "rw" }, signups: { mode: "a", form: { fields: { email: { type: "email" } } } } },
      actions: {
        sql: { input: { n: { type: "int", min: 0 } }, run: [{ sql: "select :n", expect: 0, error: "x" }] },
        fn: { input: { text: { type: "text" } }, url: "https://fn.acme.app/x", timeoutMs: 500 },
      },
      session: { ttlMs: 120_000 },
    }
    const once = parseAppConfig(config)
    expect(parseAppConfig(once)).toEqual(once)
  })

  test("the config takes run or url, and url is https or this machine", () => {
    expect(() => parseAppConfig({ actions: { a: { url: "https://fn.acme.app/x", run: [{ sql: "select 1" }] } } })).toThrow(/one or the other/)
    expect(() => parseAppConfig({ actions: { a: { url: "http://fn.acme.app/x" } } })).toThrow(/https/)
    expect(parseAppConfig({ actions: { a: { url: "https://fn.acme.app/x" } } }).actions.a?.timeoutMs).toBe(10_000)
  })
})

describe("forms", () => {
  let site: App
  const PAGE = `${ORIGIN}/join.html`

  function post(table: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return fetch(`${server.url}/v1/forms/forms/${table}`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ORIGIN, referer: PAGE, "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    })
  }

  async function rows(table: string): Promise<Record<string, unknown>[]> {
    const response = await run(site.sharedDb, `select data from ${table} order by created_at`)
    return ((await response.json()) as { rows: string[][] }).rows.map(([data]) => JSON.parse(data as string))
  }

  beforeAll(async () => {
    site = await createApp("forms", {
      origins: [ORIGIN],
      tables: {
        signups: {
          mode: "a",
          form: { fields: { email: { type: "email" }, plan: { type: "text", optional: true, maxLength: 20 }, news: { type: "bool" } }, perMinute: 5 },
        },
        notes: { mode: "a", form: true },
      },
    })
    for (const table of ["signups", "notes"]) {
      expect((await run(site.sharedDb, createTableSql(table))).status).toBe(200)
    }
  })

  test("a post becomes a row and the visitor goes back with ?bql=ok", async () => {
    const response = await post("signups", { email: "ann@example.com", news: "on", ignored: "x" })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${PAGE}?bql=ok`)
    expect((await rows("signups")).at(-1)).toEqual({ email: "ann@example.com", news: true })
  })

  test("a bad field goes back with its name, and nothing is stored", async () => {
    const before = (await rows("signups")).length
    const response = await post("signups", { email: "not an email" })
    expect(response.headers.get("location")).toBe(`${PAGE}?bql=error&reason=email`)
    expect((await rows("signups")).length).toBe(before)
  })

  test("Accept: application/json answers JSON instead", async () => {
    const ok = await post("signups", { email: "bob@example.com" }, { accept: "application/json" })
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/)
    const bad = await post("signups", { email: "x" }, { accept: "application/json" })
    expect(bad.status).toBe(400)
  })

  test("_next is followed only to an allowed origin", async () => {
    const own = await post("notes", { text: "hi", _next: `${ORIGIN}/thanks.html` })
    expect(own.headers.get("location")).toBe(`${ORIGIN}/thanks.html?bql=ok`)
    const elsewhere = await post("notes", { text: "hi", _next: "https://evil.test/phish" })
    expect(elsewhere.headers.get("location")).toBe(`${PAGE}?bql=ok`)
    const nowhere = await post("notes", { text: "hi", _next: "https://evil.test/" }, { referer: "https://evil.test/" })
    expect(nowhere.status).toBe(200)
  })

  test("a table with form: true keeps any plain text field, minus the _ ones", async () => {
    await post("notes", { text: "kept", _gotcha: "", _next: PAGE })
    expect((await rows("notes")).at(-1)).toEqual({ text: "kept" })
  })

  test("a filled honeypot is answered ok and stored nowhere", async () => {
    const before = (await rows("notes")).length
    const response = await post("notes", { text: "spam", _gotcha: "bot" })
    expect(response.headers.get("location")).toBe(`${PAGE}?bql=ok`)
    expect((await rows("notes")).length).toBe(before)
  })

  test("the origin is checked, and a table without form takes no posts", async () => {
    expect((await post("notes", { text: "x" }, { origin: "https://evil.test" })).status).toBe(403)
    expect((await post("scores", { text: "x" })).status).toBe(404)
  })

  test("posts are limited per IP and table", async () => {
    const limited = await createApp("formlimit", { origins: [ORIGIN], tables: { t: { mode: "a", form: { perMinute: 2 } } } })
    await run(limited.sharedDb, createTableSql("t"))
    const send = () =>
      fetch(`${server.url}/v1/forms/formlimit/t`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: ORIGIN, referer: PAGE, "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      })
    expect((await send()).status).toBe(303)
    expect((await send()).status).toBe(303)
    expect((await send()).headers.get("location")).toBe(`${PAGE}?bql=error&reason=rate`)
  })

  test("a form table stays out of visitor tokens unless read is set", async () => {
    const config = parseAppConfig({ tables: { signups: { mode: "a", form: true }, guestbook: { mode: "a", form: true, read: true } } })
    expect(config.tables.signups?.read).toBe(false)
    expect(config.tables.guestbook?.read).toBe(true)
    expect(() => parseAppConfig({ tables: { t: { mode: "rw", form: true } } })).toThrow(/must be mode "a"/)
  })
})

describe("the unused-visitor sweep", () => {
  test("deletes a visitor database nothing wrote to, and keeps one that was written", async () => {
    const swept = await createApp("swept", { origins: [ORIGIN] })
    const idle = (await (await session(swept.key, visitor(20))).json()) as Session
    const used = (await (await session(swept.key, visitor(21))).json()) as Session
    expect((await run(used.private.db, "create table t(x)", used.private.token)).status).toBe(200)

    const ctx = { runtime: server.handle.runtime } as unknown as RouteContext
    expect(sweepUnusedVisitors(ctx, "swept", Date.now())).toBe(0) // too young
    expect(sweepUnusedVisitors(ctx, "swept", Date.now() + UNUSED_VISITOR_MS + 1000)).toBe(1)
    expect(server.handle.runtime.registry.has(idle.private.db)).toBe(false)
    expect(server.handle.runtime.registry.has(used.private.db)).toBe(true)
  })
})

describe("NewVisitorLimiter", () => {
  test("a window resets after a minute", () => {
    const limiter = new NewVisitorLimiter()
    expect(limiter.take("k", 1, 0)).toBe(0)
    expect(limiter.take("k", 1, 30_000)).toBe(30)
    expect(limiter.take("k", 1, 60_000)).toBe(0)
  })
})
