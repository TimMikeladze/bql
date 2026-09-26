import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AuthKeys } from "../../src/server/auth.ts"
import { serveFakeObjectStore } from "./fake-http-store.ts"
const cli = path.resolve(import.meta.dir, "../../src/cli.ts")

test("CLI explicitly initializes cloud storage and recovers after SIGKILL with empty local disk", async () => {
  const remote = serveFakeObjectStore()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-cloud-cli-"))
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, BQL_AUTH_ADMIN_KEY: "cli-admin", BQL_AUTH_JWT_KEY: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64"), BQL_S3_BUCKET: "test", BQL_S3_ENDPOINT: remote.endpoint, BQL_S3_ACCESS_KEY_ID: "test", BQL_S3_SECRET_ACCESS_KEY: "test" }
  const spawn = (args: string[], extra: Record<string, string> = {}) => Bun.spawn([process.execPath, cli, ...args], { cwd: dir, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" })
  const children: ReturnType<typeof spawn>[] = []
  async function listen(data: string) {
    const child = spawn(["serve", "--storage-mode", "object", "--deployment-id", "cli-test", "--dir", data, "--port", "0", "--host", "127.0.0.1"], { BQL_DATA_STORAGE_MODE: "disk", BQL_DATA_DEPLOYMENT_ID: "wrong" })
    children.push(child)
    let log = ""
    for await (const chunk of child.stdout) {
      log += new TextDecoder().decode(chunk)
      const match = /bql (http:\/\/127\.0\.0\.1:\d+)/.exec(log)
      if (match) return { child, url: match[1]! }
    }
    throw new Error(`Server exited without listening: ${await new Response(child.stderr).text()}`)
  }
  const request = async (url: string, route: string, body?: unknown) => {
    const response = await fetch(`${url}${route}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer cli-admin", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    expect(response.ok).toBe(true)
    return response.json() as Promise<{ rows: unknown[] }>
  }
  try {
    const init = spawn(["cloud", "init", "--deployment-id", "cli-test", "--dir", path.join(dir, "init")])
    expect(await init.exited).toBe(0)
    const first = await listen(path.join(dir, "first"))
    await request(first.url, "/v1/db", { name: "acme" })
    await request(first.url, "/v1/db/acme/batch", { atomic: true, statements: [{ sql: "create table items (id integer)" }, { sql: "insert into items values (7)" }] })
    first.child.kill("SIGKILL")
    await first.child.exited
    fs.rmSync(path.join(dir, "first"), { recursive: true, force: true })
    const second = await listen(path.join(dir, "second"))
    expect((await request(second.url, "/v1/db/acme/query", { sql: "select id from items" })).rows).toEqual([[7]])
    second.child.kill("SIGTERM")
    expect(await second.child.exited).toBe(0)
  } finally {
    for (const child of children) { child.kill(); await child.exited }
    remote.server.stop(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
