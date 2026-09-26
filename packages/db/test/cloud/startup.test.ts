import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import { loadConfig } from "../../src/server/config.ts"
import { createRuntime } from "../../src/server/app.ts"
import { AuthKeys } from "../../src/server/auth.ts"
import { initializeObjectServer, startObjectServer } from "../../src/cloud/startup.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { cleanup, tempDir } from "../storage/harness.ts"

afterEach(cleanup)
async function config() {
  return loadConfig({ env: {}, overrides: { server: { host: "127.0.0.1", port: 0 }, data: { dir: tempDir(), storageMode: "object", deploymentId: "startup-test" }, auth: { adminKey: "test-admin", jwtKey: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64") }, s3: { bucket: "test" } } })
}

test("object mode is explicit and never enables the asynchronous backup shipper", () => {
  const config = loadConfig({ env: { BQL_DATA_STORAGE_MODE: "object", BQL_DATA_DEPLOYMENT_ID: "preview", BQL_S3_BUCKET: "test" } })
  expect(config.data.storageMode).toBe("object")
  expect(config.data.deploymentId).toBe("preview")
  expect(config.s3.enabled).toBe(false)
  expect(() => loadConfig({ env: { BQL_DATA_STORAGE_MODE: "typo" } })).toThrow()
  expect(() => loadConfig({ env: { BQL_DATA_STORAGE_MODE: "object", BQL_DATA_DEPLOYMENT_ID: "../prod" } })).toThrow()
  expect(loadConfig({ env: {} }).data.storageMode).toBe("disk")
})

test("startup requires explicit initialization and cannot open cloud mode as an embedded local runtime", async () => {
  const cfg = await config()
  const store = new FakeObjectStore()
  await expect(startObjectServer(cfg, { store })).rejects.toMatchObject({ code: "CLOUD_NOT_INITIALIZED" })
  expect(store.objects.size).toBe(0)
  await expect(createRuntime(cfg)).rejects.toThrow("object")
  await initializeObjectServer(cfg, { store })
  const handle = await startObjectServer(cfg, { store })
  try { expect((await fetch(`${handle.url}/readyz`)).status).toBe(200) }
  finally { await handle.close() }
  await expect(initializeObjectServer(cfg, { store })).rejects.toThrow()
})

test("cloud startup never generates missing provider signing or admin secrets", async () => {
  const cfg = await config()
  cfg.auth.jwtKey = null
  const store = new FakeObjectStore()
  await expect(initializeObjectServer(cfg, { store })).rejects.toThrow("stable")
  expect(store.objects.size).toBe(0)
  expect(fs.existsSync(cfg.auth.keysFile!)).toBe(false)
})
