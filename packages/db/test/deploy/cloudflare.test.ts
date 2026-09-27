import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initDeployment } from "../../src/deploy/config.ts"
import { withDeploymentJournal } from "../../src/deploy/journal.ts"
import { stageDeployment } from "../../src/deploy/templates.ts"
import { deployCloudflare } from "../../src/deploy/cloudflare.ts"
import { CloudflareApiError, type CloudflareApi } from "../../src/deploy/cloudflare-api.ts"
import type { NativeCommand, NativeRunner } from "../../src/deploy/runner.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
test("Cloudflare checks eligibility before resources and resumes after bucket credential setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-cf-")); dirs.push(dir)
  const config = await initDeployment("cloudflare", dir, { scope: "a".repeat(32) })
  const appDir = join(dir, "app"); await stageDeployment(config, appDir)
  let paid = false, bucket = false, worker = false
  const calls: NativeCommand[] = []
  const api: CloudflareApi = async <T>(path: string): Promise<T> => {
    if (path === "/containers/me") { if (!paid) throw new CloudflareApiError(401); return {} as T }
    if (path === "/r2/buckets") return { buckets: bucket ? [{ name: config.name }] : [] } as T
    if (path === "/workers/scripts") return (worker ? [{ id: config.name }] : []) as T
    if (path === "/workers/subdomain") return { subdomain: "test-account" } as T
    throw new Error(`Unexpected path ${path}`)
  }
  const runner: NativeRunner = async command => {
    calls.push(command)
    if (command.args.slice(0, 3).join(" ") === "r2 bucket create") bucket = true
    if (command.args.slice(0, 2).join(" ") === "secret bulk") {
      worker = true
      const secrets = JSON.parse(command.input!)
      expect(secrets.BQL_S3_SECRET_ACCESS_KEY).toBe("private-secret")
      expect(secrets.BQL_STORAGE_DEPLOYMENT_ID).toBe(config.deploymentId)
    }
    expect(command.args.join(" ")).not.toContain("private-secret")
    return { stdout: "", stderr: "", exitCode: 0 }
  }
  let release = "test"
  const apply = (credentials?: { accessKeyId: string; secretAccessKey: string }) => withDeploymentJournal(config, dir, journal => deployCloudflare({ config, journal, appDir, runner, release }, { api, credentials }))
  await expect(apply()).rejects.toThrow("Workers Paid")
  expect(calls).toHaveLength(0)
  paid = true
  await expect(apply()).rejects.toThrow("--r2-credentials")
  expect(bucket).toBe(true)
  expect(worker).toBe(false)
  const credentials = { accessKeyId: "private-access", secretAccessKey: "private-secret" }
  expect(await apply(credentials)).toBe(`https://${config.name}.test-account.workers.dev`)
  expect(await apply()).toBe(`https://${config.name}.test-account.workers.dev`)
  expect(calls.filter(c => c.args.slice(0, 3).join(" ") === "r2 bucket create")).toHaveLength(1)
  expect(calls.filter(c => c.args.slice(0, 2).join(" ") === "secret bulk")).toHaveLength(1)
  expect(calls.some(c => c.executable === "docker" && c.args.includes("--existing"))).toBe(true)
  release = "new-release"; await apply()
  release = "test"; await apply()
  expect(calls.filter(command => command.args[0] === "deploy")).toHaveLength(3)
  bucket = false
  await expect(apply()).rejects.toThrow("bucket is missing")
  expect(calls.filter(c => c.args.slice(0, 3).join(" ") === "r2 bucket create")).toHaveLength(1)
})
