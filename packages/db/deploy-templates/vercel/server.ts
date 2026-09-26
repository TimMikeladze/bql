import { loadConfig } from "../../packages/db/src/server/config.ts"
import { CloudError } from "../../packages/db/src/cloud/errors.ts"
import { initializeObjectServer, serveObjectProcess } from "../../packages/db/src/cloud/startup.ts"
import { BlobObjectStore } from "./blob-store.ts"

export function vercelConfig(env: Record<string, string | undefined> = process.env) {
  const port = Number(env.PORT ?? "80")
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CloudError("CLOUD_CONFIG", "PORT must be a valid TCP port")
  if (!env.BQL_DEPLOYMENT_ENV || !["preview", "production", "development"].includes(env.BQL_DEPLOYMENT_ENV)) throw new CloudError("CLOUD_CONFIG", "Set BQL_DEPLOYMENT_ENV for this isolated deployment")
  if (env.VERCEL_ENV && env.VERCEL_ENV !== env.BQL_DEPLOYMENT_ENV) throw new CloudError("CLOUD_CONFIG", "Deployment environment does not match its storage configuration")
  return loadConfig({ env: { ...env, BQL_DATA_STORAGE_MODE: "object", BQL_DATA_DIR: "/tmp/bql", BQL_SERVER_HOST: "0.0.0.0", BQL_SERVER_PORT: String(port) } })
}
export function vercelStore(env: Record<string, string | undefined> = process.env) {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new CloudError("CLOUD_CONFIG", "Set a private BLOB_READ_WRITE_TOKEN for this deployment")
  if (env.VERCEL_BLOB_RETRIES !== "0") throw new CloudError("CLOUD_CONFIG", "VERCEL_BLOB_RETRIES must be 0")
  return new BlobObjectStore(env.BLOB_READ_WRITE_TOKEN)
}
if (import.meta.main) {
  const config = vercelConfig()
  const options = { store: vercelStore() }
  if (Bun.argv[2] === "init") {
    await initializeObjectServer(config, options)
    console.log(`bql: initialized ${config.data.deploymentId}`)
  } else if (Bun.argv[2] === undefined) {
    await serveObjectProcess(config, options)
  } else throw new CloudError("CLOUD_CONFIG", "Usage: server.ts [init]")
}
