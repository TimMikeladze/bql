import { expect, test } from "bun:test"
import { cloudflareConfig } from "../server.ts"

test("Cloudflare startup pins disposable object mode and rejects crossed storage identity", () => {
  const env = {
    BQL_DEPLOYMENT_ENV: "preview", BQL_DATA_DEPLOYMENT_ID: "preview-demo", BQL_STORAGE_DEPLOYMENT_ID: "preview-demo",
    BQL_ADMIN_KEY: "admin", BQL_JWT_ED25519: "key", BQL_S3_BUCKET: "test",
    BQL_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com", BQL_S3_ACCESS_KEY_ID: "access", BQL_S3_SECRET_ACCESS_KEY: "secret",
    BQL_DATA_DIR: "/data", BQL_DATA_STORAGE_MODE: "disk",
  }
  const config = cloudflareConfig(env)
  expect(config.server.port).toBe(8080)
  expect(config.data.storageMode).toBe("object")
  expect(config.data.dir).toBe("/tmp/bql")
  expect(config.s3.enabled).toBe(false)
  expect(config.s3.region).toBe("auto")
  expect(() => cloudflareConfig({ ...env, BQL_STORAGE_DEPLOYMENT_ID: "production-demo" })).toThrow("identity")
})
