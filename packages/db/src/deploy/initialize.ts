import { pathToFileURL } from "node:url"
import type { ObjectStore } from "../storage/object-store.ts"
import { loadConfig, type ServerConfig } from "../server/config.ts"
import { configuredObjectStore, initializeObjectServer } from "../cloud/startup.ts"
import { CloudError } from "../cloud/errors.ts"
import { readRoot } from "../cloud/root.ts"
import { CloudRuntime } from "../cloud/runtime.ts"

/** Provisioning only. A completed initialization checkpoint disables creating missing roots. */
export async function ensureInitialized(store: ObjectStore, config: ServerConfig, canInitialize: boolean): Promise<void> {
  try { await readRoot(store, config.data.deploymentId) }
  catch (error) {
    if (!canInitialize || !(error instanceof CloudError) || error.code !== "CLOUD_NOT_INITIALIZED") throw error
    await initializeObjectServer(config, { store })
  }
  // A root's presence alone is insufficient: validate its referenced committed metadata.
  const runtime = await CloudRuntime.open({ store, deploymentId: config.data.deploymentId, config })
  await runtime.close()
}

if (import.meta.main) {
  const provider = Bun.argv[2]
  if (provider !== "cloudflare" && provider !== "vercel") throw new Error("Usage: initialize.ts cloudflare|vercel [--existing] [adapter-path]")
  const config = loadConfig()
  if (config.data.storageMode !== "object") throw new Error("Deployment initialization requires object mode")
  let store: ObjectStore
  if (provider === "vercel") {
    const adapter = Bun.argv.find((arg, i) => i > 2 && arg !== "--existing")
    if (!adapter || !process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_RETRIES !== "0") throw new Error("Private Blob adapter/token and disabled retries are required")
    const { BlobObjectStore } = await import(pathToFileURL(adapter).href)
    store = new BlobObjectStore(process.env.BLOB_READ_WRITE_TOKEN)
  } else store = configuredObjectStore(config)
  await ensureInitialized(store, config, !Bun.argv.includes("--existing"))
  console.log("Cloud storage initialization verified")
}
