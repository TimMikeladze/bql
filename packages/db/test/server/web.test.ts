// Apps, `pk_` keys and `/v1/session` (docs/plan-web.md), end to end: the tokens a session hands
// out are used against a real listener, because the claim is about what SQLite then lets them do.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
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
    expect(() => parseAppConfig({ actions: {} })).toThrow(/actions is not supported yet/)
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
