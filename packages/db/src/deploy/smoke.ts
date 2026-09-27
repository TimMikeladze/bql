import { createHash } from "node:crypto"
import { createClient } from "../client/index.ts"
import { endpointFetch } from "../cli/transport.ts"
import type { DeploymentConfig } from "./config.ts"
import type { DeploymentConnection } from "./profiles.ts"

export async function probeDeployment(connection: DeploymentConnection): Promise<boolean> {
  try {
    const response = await endpointFetch(connection.url)(`${connection.url}/readyz`, {
      headers: connection.bypass ? { "x-vercel-protection-bypass": connection.bypass } : {}, signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json() as { ok?: boolean; ready?: boolean }
    return response.status === 200 && (body.ok === true || body.ready === true)
  } catch { return false }
}

/** One small, deployment-owned database makes interrupted smoke checks safe to rerun. */
export async function verifyDeployment(config: DeploymentConfig, connection: DeploymentConnection): Promise<void> {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await probeDeployment(connection)) { ready = true; break }
    await Bun.sleep(2_000)
  }
  if (!ready) throw new Error("Deployment is not ready yet; resources are retained for inspection")
  const client = createClient({ url: connection.url, token: connection.token, headers: connection.bypass ? { "x-vercel-protection-bypass": connection.bypass } : {}, fetch: endpointFetch(connection.url) })
  const identity = createHash("sha256").update(config.deploymentId).digest("hex").slice(0, 24)
  const database = `bql_deploy_${identity}`
  try {
    if (!(await client.admin.list()).some(db => db.name === database)) await client.admin.create(database)
    const statements = [{ sql: "CREATE TABLE IF NOT EXISTS deployment_check (id INTEGER PRIMARY KEY, identity TEXT NOT NULL)" }, { sql: "INSERT OR IGNORE INTO deployment_check VALUES (1, ?)", args: [config.deploymentId] }]
    await client.db(database).batch(statements, { idempotencyKey: `deploy-${identity}` })
    const rows = await client.db(database).execute("SELECT identity FROM deployment_check WHERE id = 1")
    if (rows.length !== 1 || rows[0]?.identity !== config.deploymentId) throw new Error("Deployment smoke data does not match its identity")
  } finally { client.close() }
}
