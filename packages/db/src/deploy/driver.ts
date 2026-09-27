import type { DeploymentConfig } from "./config.ts"
import type { DeploymentJournal } from "./journal.ts"
import type { NativeRunner } from "./runner.ts"

export interface DriverContext {
  config: DeploymentConfig
  journal: DeploymentJournal
  runner: NativeRunner
  appDir: string
  /** Content identity of the staged release. A new source version gets its own checkpoint. */
  release: string
}

export function parseNativeJson<T>(text: string, name: string): T {
  try { return JSON.parse(text) as T }
  catch { throw new Error(`${name} returned invalid JSON; upgrade the native CLI and retry`) }
}

export function nativeArray<T>(text: string, name: string): T[] {
  const result = parseNativeJson<unknown>(text, name)
  if (!Array.isArray(result)) throw new Error(`${name} returned an unexpected response`)
  return result as T[]
}

/** Use the hosted Linux image for initialization, avoiding a local C compiler.
 * Secret values stay in the child environment; only their names appear in argv. */
export async function initializeObjectDeployment(context: DriverContext, storage: Record<string, string>): Promise<void> {
  const { config, journal, runner, appDir, release } = context
  if (config.provider === "fly") throw new Error("Fly uses its persistent volume")
  const image = `bql-${config.deploymentId}:${release}`
  await runner({ executable: "docker", args: ["build", "--platform", "linux/amd64", "-f", config.provider === "vercel" ? "Dockerfile.vercel" : "Dockerfile", "-t", image, "."], cwd: appDir })
  const env = {
    ...storage, BQL_ADMIN_KEY: journal.secrets.BQL_ADMIN_KEY!, BQL_JWT_ED25519: journal.secrets.BQL_JWT_ED25519!,
    BQL_DATA_STORAGE_MODE: "object", BQL_DATA_DIR: "/tmp/bql", BQL_DATA_DEPLOYMENT_ID: config.deploymentId,
    BQL_DEPLOYMENT_ENV: config.environment,
  }
  const initialize = async (existing: boolean) => {
    await runner({ executable: "docker", cwd: appDir, env, args: [
      "run", "--rm", "--platform", "linux/amd64", ...Object.keys(env).flatMap(key => ["--env", key]), image,
      "bun", "run", "packages/db/src/deploy/initialize.ts", config.provider,
      ...(existing ? ["--existing"] : []), ...(config.provider === "vercel" ? ["/app/deploy/vercel/blob-store.ts"] : []),
    ] })
    await journal.recordResource("root", config.deploymentId)
  }
  if (journal.state.steps.initialize?.status === "complete") await initialize(true)
  else await journal.step("initialize", () => initialize(false))
}
