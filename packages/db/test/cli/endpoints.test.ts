import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ContextStore } from "../../src/context/store.ts"
import { startTestServer, stopAll, type TestServer } from "../server/harness.ts"
const CLI = resolve(import.meta.dir, "../../src/cli.ts")
let a: TestServer, b: TestServer, dir: string, configDir: string
beforeAll(async () => {
  a = await startTestServer()
  b = await startTestServer()
  dir = await mkdtemp(join(tmpdir(), "bql-endpoints-"))
  configDir = join(dir, "config")
  await new ContextStore(configDir).mutate((r, c) => {
    r.organizations = [
      {
        id: "o",
        name: "personal",
        projects: [
          {
            id: "p",
            name: "app",
            defaultEndpoint: "a",
            endpoints: [
              {
                id: "a",
                name: "dev",
                database: { url: a.url, token: { key: "a" } },
              },
              {
                id: "b",
                name: "prod",
                database: { url: b.url, token: { key: "b" } },
              },
            ],
          },
        ],
      },
    ]
    r.selection = { org: "o", project: "p" }
    c.a = a.adminKey
    c.b = b.adminKey
  })
})
afterAll(async () => {
  await stopAll()
  await rm(dir, { recursive: true, force: true })
})
async function run(...args: string[]) {
  const child = Bun.spawn(["bun", CLI, ...args, "--config-dir", configDir], {
    cwd: dir,
    env: {
      ...process.env,
      BQL_URL: "",
      BQL_TOKEN: "",
      BQL_ADMIN_KEY: "",
      BQL_ORG: "",
      BQL_PROJECT: "",
      BQL_ENDPOINT: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, out, err }
}
test("named endpoints isolate data and credentials across two real servers", async () => {
  for (const ep of ["dev", "prod"]) {
    expect((await run("db", "create", "same", "--endpoint", ep)).code).toBe(0)
    expect(
      (
        await run(
          "exec",
          "same",
          "--endpoint",
          ep,
          "--sql",
          "CREATE TABLE t (value TEXT)",
        )
      ).code,
    ).toBe(0)
    expect(
      (
        await run(
          "exec",
          "same",
          "--endpoint",
          ep,
          "--sql",
          `INSERT INTO t VALUES ('${ep}')`,
        )
      ).code,
    ).toBe(0)
  }
  expect(
    JSON.parse(
      (
        await run(
          "exec",
          "same",
          "--endpoint",
          "dev",
          "--sql",
          "SELECT * FROM t",
          "--json",
        )
      ).out,
    ),
  ).toEqual([{ value: "dev" }])
  expect(
    JSON.parse(
      (
        await run(
          "exec",
          "same",
          "--endpoint",
          "prod",
          "--sql",
          "SELECT * FROM t",
          "--json",
        )
      ).out,
    ),
  ).toEqual([{ value: "prod" }])
})
test("protected endpoints carry both credentials; direct URL and redirects do not leak saved auth", async () => {
  let received = 0,
    leaks = 0
  const destination = Bun.serve({
    port: 0,
    fetch() {
      leaks++
      return Response.json({ databases: [] })
    },
  })
  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      received++
      if (
        req.headers.get("x-vercel-protection-bypass") !== "bypass" ||
        req.headers.get("authorization") !== `Bearer ${a.adminKey}`
      )
        return new Response("blocked", { status: 401 })
      const url = new URL(req.url)
      if (url.pathname.startsWith("/redirect"))
        return Response.redirect(destination.url.toString(), 307)
      return fetch(`${a.url}${url.pathname}`, {
        headers: req.headers,
        redirect: "error",
      })
    },
  })
  try {
    await new ContextStore(configDir).mutate((r, c) => {
      r.organizations[0]!.projects[0]!.endpoints.push(
        {
          id: "protected",
          name: "protected",
          database: {
            url: proxy.url.toString(),
            token: { key: "a" },
            bypass: { key: "bypass" },
          },
        },
        {
          id: "redirect",
          name: "redirect",
          database: {
            url: proxy.url + "redirect",
            token: { key: "a" },
            bypass: { key: "bypass" },
          },
        },
      )
      c.bypass = "bypass"
    })
    expect(
      (await run("db", "list", "--endpoint", "protected", "--json")).code,
    ).toBe(0)
    expect((await run("db", "list", "--url", proxy.url.toString())).code).toBe(
      1,
    )
    expect((await run("db", "list", "--endpoint", "redirect")).code).toBe(1)
    expect(received).toBe(3)
    expect(leaks).toBe(0)
  } finally {
    proxy.stop(true)
    destination.stop(true)
  }
})
test("primary movement cannot send a saved endpoint token to another origin", async () => {
  let leaks = 0
  const target = Bun.serve({
    port: 0,
    fetch() {
      leaks++
      return Response.json({})
    },
  })
  const moved = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(
        { error: { code: "NOT_PRIMARY", message: "moved" } },
        { status: 503, headers: { "BQL-Primary": target.url.toString() } },
      )
    },
  })
  try {
    await new ContextStore(configDir).mutate((r) => {
      r.organizations[0]!.projects[0]!.endpoints.push({
        id: "moved",
        name: "moved",
        database: { url: moved.url.toString(), token: { key: "a" } },
      })
    })
    expect(
      (await run("exec", "same", "--endpoint", "moved", "--sql", "SELECT 1"))
        .code,
    ).toBe(1)
    expect(leaks).toBe(0)
  } finally {
    target.stop(true)
    moved.stop(true)
  }
})
