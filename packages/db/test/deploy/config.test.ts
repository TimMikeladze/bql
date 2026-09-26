import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initDeployment, planDeployment, readDeployment } from "../../src/deploy/config.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function directory() { const dir = await mkdtemp(join(tmpdir(), "bql-deploy-")); dirs.push(dir); return dir }

test("init preserves an existing deployment and unrelated provider configuration", async () => {
  const dir = await directory()
  await writeFile(join(dir, "fly.toml"), 'app = "existing"\n')
  const first = await initDeployment("fly", dir, { name: "example", environment: "production" })
  expect(await initDeployment("fly", dir)).toEqual(first)
  expect(await readDeployment(dir)).toEqual(first)
  expect(await readFile(join(dir, "fly.toml"), "utf8")).toBe('app = "existing"\n')
  await expect(initDeployment("vercel", dir)).rejects.toThrow("already")
  await expect(initDeployment("fly", dir, { name: "replacement" })).rejects.toThrow("already")
})

test("plans are offline, secret-free, environment-isolated and describe all three providers", async () => {
  for (const provider of ["vercel", "cloudflare", "fly"] as const) {
    const dir = await directory()
    const config = await initDeployment(provider, dir)
    const before = await readdir(dir, { recursive: true })
    const plan = planDeployment(config)
    expect(plan.provider).toBe(provider)
    expect(plan.nativeCli).toBe(provider === "cloudflare" ? "wrangler" : provider)
    expect(plan.resources.length).toBeGreaterThan(0)
    expect(plan.limits.length).toBeGreaterThan(0)
    expect(plan.costs).toContain("billable")
    expect(plan.deploymentId).toStartWith("preview-")
    expect(await readdir(dir, { recursive: true })).toEqual(before)
    const other = await initDeployment(provider, await directory(), { environment: "production" })
    expect(other.deploymentId).not.toBe(config.deploymentId)
    expect(other.name).not.toBe(config.name)
  }
})

test("invalid or corrupt configuration is rejected rather than silently replaced", async () => {
  const dir = await directory()
  await expect(initDeployment("vercel", dir, { name: "--evil" })).rejects.toThrow("name")
  await initDeployment("vercel", dir)
  const path = join(dir, ".bql", "deployment.json")
  const content = await readFile(path, "utf8")
  await writeFile(path, content.replace('"version": 1', '"version": 99'))
  await expect(readDeployment(dir)).rejects.toThrow("version")
  await expect(initDeployment("vercel", dir)).rejects.toThrow("version")
})
