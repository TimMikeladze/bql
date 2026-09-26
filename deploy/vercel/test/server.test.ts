import { expect, test } from "bun:test"
import { vercelConfig, vercelStore } from "../server.ts"
test("container startup uses PORT, disposable disk and explicit environment isolation", () => {
  const env = { PORT: "8080", BQL_DATA_DEPLOYMENT_ID: "preview-test", BQL_DEPLOYMENT_ENV: "preview", VERCEL_ENV: "preview", BQL_DATA_STORAGE_MODE: "disk" }
  const config = vercelConfig(env)
  expect(config.server.port).toBe(8080)
  expect(config.server.host).toBe("0.0.0.0")
  expect(config.data.storageMode).toBe("object")
  expect(config.data.dir).toBe("/tmp/bql")
  expect(() => vercelConfig({ ...env, VERCEL_ENV: "production" })).toThrow("environment")
  expect(() => vercelConfig({ ...env, PORT: "oops" })).toThrow("PORT")
  expect(() => vercelStore({})).toThrow("BLOB_READ_WRITE_TOKEN")
  expect(() => vercelStore({ BLOB_READ_WRITE_TOKEN: "test" })).toThrow("RETRIES")
})
