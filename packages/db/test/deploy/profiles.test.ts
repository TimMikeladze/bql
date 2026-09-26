import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ContextStore } from "../../src/context/store.ts"
import { resolveContext } from "../../src/context/index.ts"
import { initDeployment } from "../../src/deploy/config.ts"
import { saveDeploymentEndpoint } from "../../src/deploy/profiles.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

test("deployment endpoints use the existing registry and private credential store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-profile-")); dirs.push(dir)
  const config = await initDeployment("vercel", dir)
  const store = new ContextStore(join(dir, "config"))
  const profile = await saveDeploymentEndpoint(config, { url: "https://example.vercel.app", token: "private-admin", bypass: "private-bypass" }, store)
  const connection = await resolveContext({ ...profile, configDir: store.directory, cwd: dir, env: {} })
  expect(connection.url).toBe("https://example.vercel.app")
  expect(connection.token).toBe("private-admin")
  expect(connection.headers["x-vercel-protection-bypass"]).toBe("private-bypass")
  expect(await readFile(join(store.directory, "config.json"), "utf8")).not.toContain("private-")
  expect((await stat(join(store.directory, "credentials.json"))).mode & 0o777).toBe(0o600)
  await saveDeploymentEndpoint(config, { url: "https://updated.vercel.app", token: "private-admin", bypass: "private-bypass" }, store)
  const registry = await store.read()
  expect(registry.organizations[0]!.projects[0]!.endpoints.length).toBe(1)
  expect(registry.selection).toEqual({})
})

test("a different deployment cannot overwrite an existing named endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bql-profile-")); dirs.push(dir)
  const config = await initDeployment("fly", dir, { name: "existing" })
  const store = new ContextStore(join(dir, "config"))
  await saveDeploymentEndpoint(config, { url: "https://first.fly.dev", token: "first" }, store)
  await expect(saveDeploymentEndpoint({ ...config, deploymentId: "preview-another" }, { url: "https://other.fly.dev", token: "other" }, store)).rejects.toThrow("different deployment")
  const registry = JSON.stringify(await store.read())
  expect(registry).toContain("first.fly.dev")
  expect(registry).not.toContain("other.fly.dev")
})
