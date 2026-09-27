import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initDeployment } from "../../src/deploy/config.ts"
import { withDeploymentJournal } from "../../src/deploy/journal.ts"
import { deployFly } from "../../src/deploy/fly.ts"
import type { NativeCommand, NativeRunner } from "../../src/deploy/runner.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

test("Fly resumes after a deploy failure without duplicating its app, volume, or IPs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-fly-")); dirs.push(dir)
  const config = await initDeployment("fly", dir)
  const calls: NativeCommand[] = []
  let app = false, volume = false, ipv6 = false, ipv4 = false, fail = true
  const runner: NativeRunner = async command => {
    calls.push(command)
    const action = command.args.slice(0, 2).join(" ")
    let result: unknown = {}
    if (action === "apps list") result = app ? [{ Name: config.name, Organization: { Slug: "personal" } }] : []
    else if (action === "apps create") app = true
    else if (action === "volumes list") result = volume ? [{ id: "vol-test", name: "bql_data", region: "sjc" }] : []
    else if (action === "volumes create") { volume = true; result = { id: "vol-test" } }
    else if (action === "ips list") result = [...(ipv6 ? [{ Type: "v6" }] : []), ...(ipv4 ? [{ Type: "shared_v4" }] : [])]
    else if (action === "ips allocate-v6") ipv6 = true
    else if (action === "ips allocate-v4") ipv4 = true
    else if (action === "secrets import") {
      expect(command.input).toContain("BQL_ADMIN_KEY=")
      expect(command.args).toContain("--stage")
      expect(command.args.join(" ")).not.toContain("BQL_ADMIN_KEY=")
    } else if (command.args[0] === "deploy") { if (fail) { fail = false; throw new Error("simulated deployment interruption") } }
    else throw new Error(`Unexpected command ${action}`)
    return { stdout: JSON.stringify(result), stderr: "", exitCode: 0 }
  }
  let release = "test-release"
  const apply = () => withDeploymentJournal(config, dir, journal => deployFly({ config, journal, runner, appDir: dir, release }))
  await expect(apply()).rejects.toThrow("interruption")
  expect(await apply()).toBe(`https://${config.name}.fly.dev`)
  expect(await apply()).toBe(`https://${config.name}.fly.dev`)
  for (const action of ["apps create", "volumes create", "ips allocate-v6", "ips allocate-v4", "secrets import"]) {
    expect(calls.filter(command => command.args.slice(0, 2).join(" ") === action).length).toBe(1)
  }
  expect(calls.some(command => command.args.includes("delete") || command.args.includes("destroy"))).toBe(false)
  release = "new-release"; await apply()
  release = "test-release"; await apply()
  expect(calls.filter(command => command.args[0] === "deploy")).toHaveLength(4)
  // An interrupted newer publish might have reached the provider. Returning to
  // the last confirmed release must publish it again, not trust that old marker.
  release = "new-release"; fail = true
  await expect(apply()).rejects.toThrow("interruption")
  release = "test-release"; await apply()
  expect(calls.filter(command => command.args[0] === "deploy")).toHaveLength(6)
  volume = false
  await expect(apply()).rejects.toThrow("recorded Fly volume is missing")
  expect(calls.filter(command => command.args.slice(0, 2).join(" ") === "volumes create").length).toBe(1)
})

test("Fly refuses an existing app without a recorded ownership checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-fly-")); dirs.push(dir)
  const config = await initDeployment("fly", dir, { name: "existing" })
  const runner: NativeRunner = async command => {
    expect(command.args).toEqual(["apps", "list", "--json"])
    return { stdout: JSON.stringify([{ Name: "existing", Organization: { Slug: "personal" } }]), stderr: "", exitCode: 0 }
  }
  await expect(withDeploymentJournal(config, dir, journal => deployFly({ config, journal, runner, appDir: dir, release: "test-release" }))).rejects.toThrow("not owned")
})
