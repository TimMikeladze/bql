import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initDeployment, planDeployment } from "../../src/deploy/config.ts"
import { applyDeployment, statusDeployment } from "../../src/deploy/apply.ts"
import { readDeploymentState } from "../../src/deploy/journal.ts"
import { resolveContext } from "../../src/context/index.ts"
import type { DriverContext } from "../../src/deploy/driver.ts"
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
test("apply checkpoints ownership, verifies endpoint, saves existing context profile and returns no secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-apply-")); dirs.push(dir)
  const config = await initDeployment("fly", dir)
  const configDir = join(dir, "config")
  let fail = true, token = "", firstRelease = "", firstDir = "", checks = 0
  const driver = async ({ journal, appDir, release }: DriverContext) => {
    if (firstDir) { expect(appDir).toBe(firstDir); expect(release).toBe(firstRelease); expect(journal.secrets.BQL_ADMIN_KEY).toBe(token) }
    firstDir = appDir; firstRelease = release; token = journal.secrets.BQL_ADMIN_KEY!
    await journal.recordResource("app", config.name)
    if (fail) { fail = false; throw new Error("native deploy failed") }
    await journal.recordEndpoint("https://example.fly.dev")
    return "https://example.fly.dev"
  }
  const options = { configDir, driver, runner: async () => ({ stdout: '{"email":"test@example.test"}', stderr: "", exitCode: 0 }), verify: async () => { checks++ } }
  await expect(applyDeployment(planDeployment(config), options)).rejects.toThrow("Resources retained: app=")
  expect((await readDeploymentState(config, configDir))?.resources.app).toBe(config.name)
  const result = await applyDeployment(planDeployment(config), options)
  expect(checks).toBe(1)
  expect(JSON.stringify(result)).not.toContain(token)
  const connection = await resolveContext({ ...result.profile, configDir, cwd: dir, env: {} })
  expect(connection.token).toBe(token)
  const status = await statusDeployment(config, { configDir, probe: async () => true })
  expect(status.ready).toBe(true)
  expect(status.resources.app).toBe(config.name)
  expect(JSON.stringify(status)).not.toContain(token)
})
