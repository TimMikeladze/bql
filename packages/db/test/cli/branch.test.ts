// X2's commands as an operator runs them: `bql db branch|branches|diff|reset` spawned against a
// server this test started (`docs/x2-branching.md`).

import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { startTestServer, stopAll, type TestServer } from "../server/harness.ts"

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts")

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})
afterAll(stopAll)

async function bql(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, BQL_URL: server.url, BQL_ADMIN_KEY: server.adminKey, BQL_TOKEN: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

test("branch, branches, diff and reset", async () => {
  expect((await bql("db", "create", "app")).code).toBe(0)
  await bql("exec", "app", "--sql", "create table t(id integer primary key, v text)")
  await bql("exec", "app", "--sql", "insert into t(v) values ('one')")

  const branched = await bql("db", "branch", "app-pr-1", "--from", "app")
  expect(branched.code).toBe(0)
  expect(branched.stdout).toContain("branched app into app-pr-1")

  const branches = await bql("db", "branches", "app", "--json")
  expect(JSON.parse(branches.stdout).databases).toEqual([
    expect.objectContaining({ name: "app-pr-1", parent: "app", parentDeleted: false }),
  ])
  expect((await bql("db", "branches")).stdout).toContain("app-pr-1")

  await bql("exec", "app-pr-1", "--sql", "alter table t add column w integer")
  await bql("exec", "app-pr-1", "--sql", "insert into t(v) values ('two')")
  const diff = await bql("db", "diff", "app", "app-pr-1")
  expect(diff.code).toBe(0)
  expect(diff.stdout).toContain("~ t")
  expect(diff.stdout).toContain("+ w INTEGER")
  expect(diff.stdout).toContain("1 → 2 (+1)")
  const json = JSON.parse((await bql("db", "diff", "app", "app-pr-1", "--json")).stdout)
  expect(json.sameSchema).toBe(false)

  const reset = await bql("db", "reset", "app-pr-1")
  expect(reset.code).toBe(0)
  expect(reset.stdout).toContain("reset app-pr-1 to app")
  const after = await bql("db", "diff", "app", "app-pr-1")
  expect(after.stdout).toContain("no differences")

  const refused = await bql("db", "reset", "app")
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("no parent")
})
