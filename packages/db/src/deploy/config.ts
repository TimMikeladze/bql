import { mkdir, open, readFile } from "node:fs/promises"
import { join } from "node:path"

export type Provider = "vercel" | "cloudflare" | "fly"
export interface DeploymentConfig {
  version: 1
  provider: Provider
  name: string
  deploymentId: string
  environment: "preview" | "production"
  region: string
  scope?: string
}
export type InitOptions = Partial<Pick<DeploymentConfig, "name" | "environment" | "region" | "scope">>
export interface DeploymentPlan {
  provider: Provider
  nativeCli: "vercel" | "wrangler" | "fly"
  deploymentId: string
  config: DeploymentConfig
  resources: string[]
  limits: string[]
  costs: string
}
export const deploymentPath = (dir: string) => join(dir, ".bql", "deployment.json")

export function validateDeployment(value: unknown): asserts value is DeploymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid deployment configuration")
  const v = value as Record<string, unknown>
  if (v.version !== 1) throw new Error("Unsupported deployment configuration version")
  if (!["vercel", "cloudflare", "fly"].includes(String(v.provider))) throw new Error("Unknown deployment provider")
  if (!["preview", "production"].includes(String(v.environment))) throw new Error("Invalid deployment environment")
  if (typeof v.name !== "string" || !/^[a-z][a-z0-9-]{2,47}$/.test(v.name)) throw new Error("Deployment name must be 3–48 lowercase letters, digits or hyphens, starting with a letter")
  if (typeof v.deploymentId !== "string" || !new RegExp(`^${v.environment}-[a-z0-9-]{1,110}$`).test(v.deploymentId)) throw new Error("Invalid deployment identity")
  if (typeof v.region !== "string" || !/^[a-z][a-z0-9-]{1,23}$/.test(v.region)) throw new Error("Invalid deployment region")
  if (v.scope !== undefined && (typeof v.scope !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_@.+-]{0,127}$/.test(v.scope))) throw new Error("Invalid provider scope")
  if (Object.keys(v).some(key => !["version", "provider", "name", "deploymentId", "environment", "region", "scope"].includes(key))) throw new Error("Unknown deployment configuration field")
}

export async function readDeployment(dir: string): Promise<DeploymentConfig> {
  let raw: string
  try { raw = await readFile(deploymentPath(dir), "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No deployment configured; run bql deploy init --provider vercel|cloudflare|fly")
    throw new Error("Cannot read deployment configuration")
  }
  let config: unknown
  try { config = JSON.parse(raw) } catch { throw new Error("Invalid deployment configuration JSON") }
  validateDeployment(config)
  return config
}

/** Create-only: an interrupted/rerun init never changes resource identity. No provider calls. */
export async function initDeployment(provider: Provider, dir: string, options: InitOptions = {}): Promise<DeploymentConfig> {
  const environment = options.environment ?? "preview"
  const id = crypto.randomUUID()
  const config: DeploymentConfig = {
    version: 1, provider, name: options.name ?? `bql-${environment}-${id.slice(0, 8)}`,
    deploymentId: `${environment}-${id}`, environment,
    region: options.region ?? ({ vercel: "iad1", cloudflare: "wnam", fly: "sjc" }[provider]),
    ...(options.scope ? { scope: options.scope } : {}),
  }
  validateDeployment(config)
  await mkdir(join(dir, ".bql"), { recursive: true, mode: 0o700 })
  let file
  try { file = await open(deploymentPath(dir), "wx", 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await readDeployment(dir)
    if (existing.provider !== provider || Object.entries(options).some(([key, value]) => value !== undefined && existing[key as keyof DeploymentConfig] !== value)) throw new Error("A different deployment is already configured in this directory")
    return existing
  }
  try { await file.writeFile(JSON.stringify(config, null, 2) + "\n"); await file.sync() }
  finally { await file.close() }
  return config
}

/** Pure, offline and secret-free. Applying the plan is a separate operation. */
export function planDeployment(config: DeploymentConfig): DeploymentPlan {
  validateDeployment(config)
  const objectMode = config.provider !== "fly"
  return {
    provider: config.provider, nativeCli: config.provider === "cloudflare" ? "wrangler" : config.provider,
    deploymentId: config.deploymentId, config: { ...config },
    resources: config.provider === "vercel"
      ? [`Vercel project ${config.name}`, `Private Blob store ${config.name} in ${config.region}`, `${config.environment} container and stable auth secrets`]
      : config.provider === "cloudflare"
        ? ["Workers Paid account required (native login alone does not enable Containers)", `Worker and named container ${config.name}`, `Private R2 bucket ${config.name} (${config.region} location hint)`, "Bucket-scoped S3 credentials and stable auth secrets"]
        : [`Fly app ${config.name} in ${config.region}`, "One 1 GB persistent volume mounted at /data", "One machine and stable auth secrets"],
    limits: objectMode
      ? ["Experimental: provider qualification is incomplete", "One deployment root serializes writes; concurrent writers may conflict", "Request-result retry retention: 24 hours", "No automatic object deletion", "No interactive transactions or realtime"]
      : ["One machine with persistent disk; no automatic multi-region replication", "Volume snapshots are provider-managed; configure backups separately"],
    costs: "Applying creates billable compute and storage resources. Provider rates, usage and retained data determine charges; plan performs no provisioning.",
  }
}
