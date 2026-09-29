// `.github/actions/bql-branch`: the composite step's own script, lifted out of action.yml and run
// with bash and curl against a real server — the only way to know what it does before a pull
// request finds out. `docs/x2-branching.md`.

import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startTestServer, stopAll, type TestServer } from "../server/harness.ts"
import { removeTempDir } from "../tmpdir.ts"

const ACTION = path.join(import.meta.dir, "..", "..", "..", "..", ".github", "actions", "bql-branch", "action.yml")

let server: TestServer
let dir: string
let script: string

beforeAll(async () => {
  server = await startTestServer()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-action-"))
  // The `run: |` block, de-indented. Everything after it in the file is that block.
  const yaml = fs.readFileSync(ACTION, "utf8")
  const body = yaml.slice(yaml.indexOf("      run: |\n") + "      run: |\n".length)
  script = path.join(dir, "action.sh")
  fs.writeFileSync(script, body.split("\n").map((line) => line.slice(8)).join("\n"))
  for (const name of ["main", "scratch"]) {
    await fetch(`${server.url}/v1/db`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
  }
})
afterAll(async () => {
  await stopAll()
  removeTempDir(dir)
})

async function run(env: Record<string, string>): Promise<{ code: number; out: string; log: string }> {
  const output = path.join(dir, `out-${Math.random()}`)
  fs.writeFileSync(output, "")
  const child = Bun.spawn(["bash", script], {
    env: {
      PATH: process.env.PATH ?? "",
      BQL_URL: server.url,
      BQL_TOKEN: server.adminKey,
      BQL_SOURCE: "main",
      BQL_BRANCH: "",
      BQL_ACTION: "create",
      BQL_ON_EXISTS: "keep",
      PR_NUMBER: "",
      REF_NAME: "",
      GITHUB_OUTPUT: output,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, out: fs.readFileSync(output, "utf8"), log: stdout + stderr }
}

async function exists(name: string): Promise<boolean> {
  const response = await fetch(`${server.url}/v1/db/${name}`, {
    headers: { authorization: `Bearer ${server.adminKey}` },
  })
  return response.status === 200
}

test("creates pr-<n>, keeps or resets it, and deletes it once", async () => {
  const created = await run({ PR_NUMBER: "7" })
  expect(created.code).toBe(0)
  expect(created.out).toContain("name=pr-7")
  expect(created.out).toContain("created=true")
  expect((await run({ PR_NUMBER: "7" })).out).toContain("created=false")
  expect((await run({ PR_NUMBER: "7", BQL_ON_EXISTS: "reset" })).log).toContain("reset pr-7")

  expect((await run({ PR_NUMBER: "7", BQL_ACTION: "delete" })).code).toBe(0)
  expect(await exists("pr-7")).toBe(false)
  const again = await run({ PR_NUMBER: "7", BQL_ACTION: "delete" })
  expect(again.code).toBe(0)
  expect(again.log).toContain("nothing to delete")
})

test("a ref is sanitised to a database name", async () => {
  const ran = await run({ REF_NAME: "Feature/Add_Login!!" })
  expect(ran.code).toBe(0)
  expect(ran.out).toContain("name=feature-add_login")
})

test("never deletes the source, or a database that is not a branch", async () => {
  // A push to main, outside a pull request: the ref fallback names the source itself.
  const onMain = await run({ REF_NAME: "main", BQL_ACTION: "delete" })
  expect(onMain.code).toBe(1)
  expect(onMain.log).toContain("is the source database")
  expect(await exists("main")).toBe(true)

  const notBranch = await run({ BQL_BRANCH: "scratch", BQL_ACTION: "delete" })
  expect(notBranch.code).toBe(1)
  expect(notBranch.log).toContain("not a branch")
  expect(await exists("scratch")).toBe(true)
})
