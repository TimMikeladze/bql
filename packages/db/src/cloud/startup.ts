import type { ServerConfig } from "../server/config.ts"
import type { ObjectStore } from "../storage/object-store.ts"
import { S3ObjectStore } from "../storage/s3-object-store.ts"
import { CloudError } from "./errors.ts"
import { initializeCloud } from "./runtime.ts"
import { startCloudServer } from "./server.ts"

export interface ObjectStartupOptions {
  /** Provider packages inject Blob or another qualified adapter here. */
  store?: ObjectStore
}
export function configuredObjectStore(config: ServerConfig): ObjectStore {
  if (!config.s3.bucket) throw new CloudError("CLOUD_CONFIG", "Object mode requires an S3/R2 bucket, or an injected provider object store")
  const { bucket, region, endpoint, accessKeyId, secretAccessKey, sessionToken, virtualHostedStyle } = config.s3
  return new S3ObjectStore({ bucket, virtualHostedStyle, ...(region ? { region } : {}), ...(endpoint ? { endpoint } : {}), ...(accessKeyId ? { accessKeyId } : {}), ...(secretAccessKey ? { secretAccessKey } : {}), ...(sessionToken ? { sessionToken } : {}) })
}
function requireObjectMode(config: ServerConfig) {
  if (config.data.storageMode !== "object") throw new CloudError("CLOUD_CONFIG", "Object startup requires data.storageMode=object")
}
/** Provisioning command only. Never invoked by startObjectServer. */
export async function initializeObjectServer(config: ServerConfig, options: ObjectStartupOptions = {}): Promise<void> {
  requireObjectMode(config)
  await initializeCloud(options.store ?? configuredObjectStore(config), config.data.deploymentId, config)
}
export async function startObjectServer(config: ServerConfig, options: ObjectStartupOptions = {}) {
  requireObjectMode(config)
  const handle = await startCloudServer({ store: options.store ?? configuredObjectStore(config), deploymentId: config.data.deploymentId, config })
  const host = ["0.0.0.0", "::"].includes(config.server.host) ? "127.0.0.1" : config.server.host
  return { ...handle, url: `http://${host.includes(":") ? `[${host}]` : host}:${handle.server.port}` }
}
/** Used by both executable entrypoints; no key material is printed. */
export async function serveObjectProcess(config: ServerConfig, options: ObjectStartupOptions = {}): Promise<void> {
  const handle = await startObjectServer(config, options)
  console.log(`bql ${handle.url}  storage=object  deployment=${config.data.deploymentId}  ack=remote`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void handle.close(Date.now() + 25000).then(() => process.exit(0), () => process.exit(1))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}
