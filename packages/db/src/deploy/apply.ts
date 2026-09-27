import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { ContextStore, configDirectory, readJson } from "../context/store.ts"
import { planDeployment, type DeploymentConfig, type DeploymentPlan } from "./config.ts"
import { readDeploymentState, withDeploymentJournal, journalDirectory } from "./journal.ts"
import { stageDeployment } from "./templates.ts"
import { authenticateProvider } from "./providers.ts"
import { saveDeploymentEndpoint, type DeploymentConnection, type DeploymentProfile } from "./profiles.ts"
import { runNative, type NativeRunner } from "./runner.ts"
import type { DriverContext } from "./driver.ts"
import { deployFly } from "./fly.ts"
import { deployCloudflare, type R2Credentials } from "./cloudflare.ts"
import { deployVercel } from "./vercel.ts"
import { probeDeployment, verifyDeployment } from "./smoke.ts"

export interface DeploymentResult {
  endpoint: string
  profile: DeploymentProfile
  resources: Record<string, string>
  capabilities: string[]
}
export interface ApplyOptions {
  configDir?: string
  runner?: NativeRunner
  credentials?: R2Credentials
  /** Injection boundaries for deterministic tests, never CLI flags. */
  driver?: (context: DriverContext) => Promise<string>
  verify?: (config: DeploymentConfig, connection: DeploymentConnection) => Promise<void>
}

async function stageRelease(config: DeploymentConfig, directory: string) {
  const releases = join(directory, "releases")
  await mkdir(releases, { recursive: true, mode: 0o700 })
  const temporary = join(releases, `staging-${crypto.randomUUID()}`)
  try {
    await stageDeployment(config, temporary)
    const hash = createHash("sha256")
    async function visit(path: string, relative: string) {
      for (const name of (await readdir(path)).sort()) {
        const file = join(path, name), key = `${relative}/${name}`, stat = await lstat(file)
        if (stat.isSymbolicLink()) throw new Error("Deployment package contains a symbolic link")
        if (stat.isDirectory()) await visit(file, key)
        else { hash.update(key + "\0"); hash.update(await readFile(file)); hash.update("\0") }
      }
    }
    await visit(temporary, "")
    const release = hash.digest("hex").slice(0, 24), appDir = join(releases, release)
    try { await lstat(appDir) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await rename(temporary, appDir)
    }
    return { release, appDir }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function applyDeployment(plan: DeploymentPlan, options: ApplyOptions = {}): Promise<DeploymentResult> {
  const config = plan.config
  planDeployment(config) // Validate again at the mutation boundary.
  const directory = configDirectory({ configDir: options.configDir }), runner = options.runner ?? runNative
  return withDeploymentJournal(config, directory, async journal => {
    try {
      const session = await authenticateProvider(config, journal.directory, runner)
      const scope = session.scope ?? (config.provider === "fly" ? "personal" : undefined)
      if (journal.state.scope && journal.state.scope !== scope) throw new Error("The native CLI account selection changed; restore the original scope before applying")
      if (scope) { journal.state.scope = scope; await journal.save() }
      const staged = await stageRelease(config, journal.directory)
      const context = { config, journal, runner, ...staged }
      const driver = options.driver ?? (config.provider === "fly" ? deployFly : config.provider === "vercel" ? deployVercel : (context: DriverContext) => deployCloudflare(context, { credentials: options.credentials }))
      const endpoint = await driver(context)
      const connection = { url: endpoint, token: journal.secrets.BQL_ADMIN_KEY!, ...(journal.secrets.VERCEL_AUTOMATION_BYPASS_SECRET ? { bypass: journal.secrets.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) }
      await (options.verify ?? verifyDeployment)(config, connection)
      const profile = await saveDeploymentEndpoint(config, connection, new ContextStore(directory))
      await journal.recordEndpoint(endpoint, profile)
      return {
        endpoint, profile, resources: { ...journal.state.resources },
        capabilities: config.provider === "fly" ? ["sql", "catalog", "transactions", "realtime", "persistent-disk"] : ["sql", "atomic-batch", "catalog", "durable-request-results", "remote-durability"],
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : "Deployment failed"
      for (const value of Object.values(journal.secrets)) if (value.length >= 4) message = message.replaceAll(value, "[redacted]")
      const resources = Object.entries(journal.state.resources).map(([kind, id]) => `${kind}=${id}`).join(", ")
      throw new Error(`${message}${resources ? `. Resources retained: ${resources}` : ""}. Run bql deploy status, then retry bql deploy apply; no resources were deleted`)
    }
  })
}

export async function statusDeployment(config: DeploymentConfig, options: { configDir?: string; probe?: typeof probeDeployment } = {}) {
  const directory = configDirectory({ configDir: options.configDir })
  const state = await readDeploymentState(config, directory)
  let ready: boolean | null = null
  if (state?.endpoint) {
    const secrets = await readJson(join(journalDirectory(config, directory), "secrets.json")) as Record<string, string> | undefined
    ready = await (options.probe ?? probeDeployment)({ url: state.endpoint, token: "", bypass: secrets?.VERCEL_AUTOMATION_BYPASS_SECRET })
  }
  return { provider: config.provider, deploymentId: config.deploymentId, endpoint: state?.endpoint, profile: state?.profile, resources: state?.resources ?? {}, steps: state?.steps ?? {}, currentRelease: state?.currentRelease, pendingRelease: state?.pendingRelease, ready }
}
