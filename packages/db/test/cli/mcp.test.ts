// `bql mcp`: the tools against a real server, and the stdio transport through the real CLI.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { handle, tools } from "../../src/cli/mcp.ts"
import { createClient, type Client } from "../../src/client/index.ts"
import { startTestServer, stopAll, type TestServer } from "../server/harness.ts"

let server: TestServer
let client: Client

beforeAll(async () => {
  server = await startTestServer()
  client = createClient({ url: server.url, token: server.adminKey })
})
afterAll(async () => {
  client.close()
  await stopAll()
})

async function call(name: string, args: Record<string, unknown>) {
  const answer = (await handle(tools(client, server.url), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "test")) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return { text: answer.result.content[0]?.text ?? "", isError: answer.result.isError === true }
}

describe("tools", () => {
  test("create an app, a shared table and an action, then get the snippet", async () => {
    const made = await call("create_app", { id: "mcp-app" })
    expect(made.text).toContain("Created mcp-app")
    expect(made.text).toMatch(/connect\("pk_[A-Za-z0-9_-]{32}"/)

    expect((await call("create_shared_table", { app: "mcp-app", table: "posts", mode: "rw" })).text).toContain("app-mcp-app-shared.posts")
    expect((await call("create_shared_table", { app: "mcp-app", table: "signups", form: true })).text).toContain("/v1/forms/mcp-app/signups")

    const config = await call("update_app_config", {
      app: "mcp-app",
      config: { actions: { hello: { input: { name: { type: "text" } }, run: [{ sql: "select :name as hi" }] } } },
    })
    expect(JSON.parse(config.text).actions.hello.run[0].sql).toBe("select :name as hi")
    // Merging kept the tables the earlier calls added.
    expect(Object.keys(JSON.parse(config.text).tables).sort()).toEqual(["posts", "signups"])

    const rows = await call("run_sql", { db: "app-mcp-app-shared", sql: "select name from sqlite_schema where type = 'table' order by name" })
    expect(JSON.parse(rows.text).map((r: { name: string }) => r.name)).toEqual(["posts", "signups"])
    expect((await call("get_snippet", { app: "mcp-app" })).text).toContain(`url: "${server.url}"`)
  })

  test("a failing tool is a result the model reads, not a protocol error", async () => {
    const missing = await call("get_snippet", { app: "nope" })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain("NOT_FOUND")
    expect((await call("create_app", {})).isError).toBe(true)
  })

  test("notifications get no answer; unknown methods get -32601", async () => {
    const list = tools(client, server.url)
    expect(await handle(list, { jsonrpc: "2.0", method: "notifications/initialized" }, "test")).toBeNull()
    const unknown = (await handle(list, { jsonrpc: "2.0", id: 9, method: "nope" }, "test")) as { error: { code: number } }
    expect(unknown.error.code).toBe(-32601)
  })
})

describe("stdio", () => {
  test("bql mcp answers initialize, tools/list and a tool call, one JSON line each", async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "mcp"], {
      env: { ...process.env, BQL_URL: server.url, BQL_ADMIN_KEY: server.adminKey, BQL_TOKEN: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_apps", arguments: {} } })
    await child.stdin.end()
    const lines = (await new Response(child.stdout).text()).trim().split("\n").map((line) => JSON.parse(line))
    await child.exited
    expect(lines.map((line) => line.id)).toEqual([1, 2, 3])
    expect(lines[0].result.serverInfo.name).toBe("bql")
    expect(lines[1].result.tools.map((t: { name: string }) => t.name)).toContain("create_app")
    expect(lines[2].result.content[0].type).toBe("text")
  })
})
