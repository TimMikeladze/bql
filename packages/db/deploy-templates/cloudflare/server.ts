import { loadConfig } from "../../packages/db/src/server/config.ts"
import { initializeObjectServer, serveObjectProcess } from "../../packages/db/src/cloud/startup.ts"
import { containerEnvironment } from "./src/routing.ts"

export function cloudflareConfig(env: Record<string, string | undefined> = process.env) {
  return loadConfig({ env: containerEnvironment(env) })
}

if (import.meta.main) {
  const config = cloudflareConfig()
  if (Bun.argv[2] === "init") {
    await initializeObjectServer(config)
    console.log(`bql: initialized ${config.data.deploymentId}`)
  } else if (Bun.argv[2] === undefined) {
    await serveObjectProcess(config)
  } else throw new Error("Usage: server.ts [init]")
}
