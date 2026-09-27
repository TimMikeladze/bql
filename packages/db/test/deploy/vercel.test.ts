import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initDeployment } from "../../src/deploy/config.ts"
import { withDeploymentJournal } from "../../src/deploy/journal.ts"
import { deployVercel } from "../../src/deploy/vercel.ts"
import type { NativeCommand, NativeRunner } from "../../src/deploy/runner.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
test("Vercel provisions isolated private storage, keeps credentials off argv, and resumes failed releases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-vc-")); dirs.push(dir)
  const config = await initDeployment("vercel", dir, { scope: "team_test" })
  const calls: NativeCommand[] = []
  let project: any, store: any, failRelease = true
  const runner: NativeRunner = async command => {
    calls.push(command)
    expect(command.args.join(" ")).not.toContain("secret-token")
    expect(command.args.join(" ")).not.toContain("bypass-secret")
    let result: any = {}
    if (command.executable === "vercel") {
      const [action, path] = command.args
      const method = command.args[command.args.indexOf("--method") + 1]
      if (action === "api") {
        if (path?.startsWith("/v9/projects?")) result = { projects: project ? [project] : [] }
        else if (path === "/v10/projects") { project = { id: "prj_test", accountId: "team_test", name: config.name }; result = project }
        else if (path === "/v9/projects/prj_test") result = { ...project, protectionBypass: { "bypass-secret": { scope: "automation-bypass" } } }
        else if (path === "/v1/storage/stores") result = { stores: store ? [store] : [] }
        else if (path === "/v1/storage/stores/blob") { store = { id: "store_test", name: config.name, region: config.region, access: "private" }; result = { store } }
        else if (path === "/v1/storage/stores/store_test/connections") {
          if (method === "GET") result = { connections: [] }
          else {
            expect(JSON.parse(command.input!)).toMatchObject({ projectId: "prj_test", envVarEnvironments: ["preview"] })
            return { stdout: "", stderr: "", exitCode: 0 } // The live connection endpoint returns 204.
          }
        } else throw new Error(`Unexpected API ${path}`)
      } else if (action === "env" && path === "pull") {
        await writeFile(command.args[2]!, 'BLOB_READ_WRITE_TOKEN="secret-token"\n')
      } else if (action === "env" && path === "add") {
        expect(command.args[3]).toBe("preview")
        expect(command.input).toBeTruthy()
      } else if (action === "deploy") {
        expect(command.args).toContain("--json")
        expect(command.args[command.args.indexOf("--target") + 1]).toBe("preview")
        if (failRelease) { failRelease = false; throw new Error("interrupted release") }
        return { stdout: JSON.stringify({ status: "ok", deployment: { url: "https://bql-preview.vercel.app", target: null, readyState: "READY" } }), stderr: "", exitCode: 0 }
      } else if (action !== "link") throw new Error(`Unexpected command ${action}`)
    }
    return { stdout: JSON.stringify(result), stderr: "", exitCode: 0 }
  }
  let release = "test"
  const apply = () => withDeploymentJournal(config, dir, journal => deployVercel({ config, journal, runner, appDir: dir, release }))
  await expect(apply()).rejects.toThrow("interrupted release")
  expect(await apply()).toBe("https://bql-preview.vercel.app")
  expect(await apply()).toBe("https://bql-preview.vercel.app")
  expect(calls.filter(c => c.args[1] === "/v10/projects")).toHaveLength(1)
  expect(calls.filter(c => c.args[1] === "/v1/storage/stores/blob")).toHaveLength(1)
  expect(calls.filter(c => c.args[0] === "deploy")).toHaveLength(2)
  await withDeploymentJournal(config, dir, async journal => {
    expect(journal.secrets.BLOB_READ_WRITE_TOKEN).toBe("secret-token")
    expect(journal.secrets.VERCEL_AUTOMATION_BYPASS_SECRET).toBe("bypass-secret")
    expect(JSON.stringify(journal.state)).not.toContain("secret-token")
  })
  release = "new-release"; await apply()
  release = "test"; await apply()
  expect(calls.filter(command => command.args[0] === "deploy")).toHaveLength(4)
  store = undefined
  await expect(apply()).rejects.toThrow("Blob store is missing")
  expect(calls.filter(c => c.args[1] === "/v1/storage/stores/blob")).toHaveLength(1)
})
