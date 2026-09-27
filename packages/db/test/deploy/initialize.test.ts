import { afterEach, expect, test } from "bun:test"
import { loadConfig } from "../../src/server/config.ts"
import { AuthKeys } from "../../src/server/auth.ts"
import { rootKey } from "../../src/cloud/root.ts"
import { FakeObjectStore } from "../cloud/fake-store.ts"
import { cleanup, tempDir } from "../storage/harness.ts"
import { ensureInitialized } from "../../src/deploy/initialize.ts"
import { initializeObjectDeployment } from "../../src/deploy/driver.ts"
import { withDeploymentJournal } from "../../src/deploy/journal.ts"
import { initDeployment } from "../../src/deploy/config.ts"

afterEach(cleanup)
test("container initialization keeps secrets out of argv and refuses to recreate a lost committed root", async () => {
  const dir = tempDir(), config = await initDeployment("cloudflare", dir)
  const store = new FakeObjectStore()
  await withDeploymentJournal(config, dir, async journal => {
    const initialize = () => initializeObjectDeployment({ config, journal, appDir: dir, release: "test", runner: async command => {
      expect(command.executable).toBe("docker")
      expect(command.args.join(" ")).not.toContain(journal.secrets.BQL_ADMIN_KEY!)
      if (command.args[0] === "run") {
        const serverConfig = loadConfig({ env: command.env, overrides: { data: { dir: tempDir() } } })
        await ensureInitialized(store, serverConfig, !command.args.includes("--existing"))
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    } }, {})
    await initialize()
    expect(journal.state.resources.root).toBe(config.deploymentId)
    store.objects.delete(rootKey(config.deploymentId))
    const count = store.objects.size
    await expect(initialize()).rejects.toMatchObject({ code: "CLOUD_NOT_INITIALIZED" })
    expect(store.objects.size).toBe(count)
  })
})

test("provisioning resumes initialization but never replaces corrupt or previously initialized state", async () => {
  const config = loadConfig({ env: {}, overrides: {
    data: { storageMode: "object", deploymentId: "preview-test", dir: tempDir() },
    auth: { adminKey: "stable", jwtKey: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64") },
  } })
  const store = new FakeObjectStore()
  await expect(ensureInitialized(store, config, false)).rejects.toMatchObject({ code: "CLOUD_NOT_INITIALIZED" })
  expect(store.objects.size).toBe(0)
  await ensureInitialized(store, config, true)
  const writes = store.operations.filter(op => op.op !== "get").length
  await ensureInitialized(store, config, true)
  expect(store.operations.filter(op => op.op !== "get").length).toBe(writes)
  const key = rootKey(config.data.deploymentId), root = store.objects.get(key)!
  store.objects.set(key, { ...root, body: new TextEncoder().encode("corrupt") })
  await expect(ensureInitialized(store, config, true)).rejects.toThrow()
  expect(store.operations.filter(op => op.op !== "get").length).toBe(writes)
  store.objects.delete(key)
  await expect(ensureInitialized(store, config, false)).rejects.toMatchObject({ code: "CLOUD_NOT_INITIALIZED" })
  expect(store.operations.filter(op => op.op !== "get").length).toBe(writes)
})
