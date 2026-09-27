import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { ParsedArgs } from "../cli.ts"
import { configDirectory } from "../context/store.ts"
import type { Environment } from "../context/model.ts"
import { initDeployment, planDeployment, readDeployment, type Provider } from "./config.ts"
import { applyDeployment, statusDeployment } from "./apply.ts"
import type { R2Credentials } from "./cloudflare.ts"

export const DEPLOY_HELP = `Deployment (uses your installed provider CLI):
  bql deploy init --provider vercel|cloudflare|fly [--name NAME]
                  [--environment preview|production] [--region REGION] [--scope ACCOUNT]
  bql deploy plan [--json]          offline resource and cost plan
  bql deploy apply [--r2-credentials FILE] [--json]
  bql deploy status [--json]        saved resources and current readiness
  --dir DIR                        deployment configuration directory (default: cwd)
  --config-dir DIR                 private workstation state and connection registry

Apply creates billable resources. Sign in with vercel login, wrangler login,
or fly auth login first. Vercel/Cloudflare require Docker and Bun locally.
Cloudflare requires Workers Paid and bucket-scoped R2 S3 credentials.
Preview and production use separate deployment directories and resources.`

export async function readR2Credentials(file: string): Promise<R2Credentials> {
  const info = await stat(file)
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("R2 credentials must be a private file; run chmod 600 on the file")
  if (info.size > 8192) throw new Error("Invalid R2 credentials file")
  const values: Record<string, string> = {}
  for (const raw of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(BQL_S3_ACCESS_KEY_ID|BQL_S3_SECRET_ACCESS_KEY)=(?:"([a-zA-Z0-9_+/=-]+)"|'([a-zA-Z0-9_+/=-]+)'|([a-zA-Z0-9_+/=-]+))$/.exec(line)
    if (!match || values[match[1]!]) throw new Error("Invalid R2 credentials file; expected BQL_S3_ACCESS_KEY_ID and BQL_S3_SECRET_ACCESS_KEY")
    values[match[1]!] = match[2] ?? match[3] ?? match[4]!
  }
  if (!values.BQL_S3_ACCESS_KEY_ID || !values.BQL_S3_SECRET_ACCESS_KEY) throw new Error("Invalid R2 credentials file; both credential entries are required")
  return { accessKeyId: values.BQL_S3_ACCESS_KEY_ID, secretAccessKey: values.BQL_S3_SECRET_ACCESS_KEY }
}

export async function runDeployCommand(args: ParsedArgs, options: { cwd: string; env: Environment; print?: (value: unknown) => void }): Promise<boolean> {
  if (args.positional[0] !== "deploy") return false
  const print = options.print ?? console.log
  const action = args.positional[1]
  if (!action || action === "help" || args.flags.help) { print(DEPLOY_HELP); return true }
  if (!["init", "plan", "apply", "status"].includes(action) || args.positional.length !== 2) throw new Error("Usage: bql deploy init|plan|apply|status")
  const allowed = new Set(["dir", "config-dir", "json", ...(action === "init" ? ["provider", "name", "environment", "region", "scope"] : action === "apply" ? ["r2-credentials"] : [])])
  for (const key of Object.keys(args.flags)) if (!allowed.has(key)) throw new Error(`Unknown deploy option --${key}`)
  const string = (key: string) => {
    const value = args.flags[key]
    if (value !== undefined && typeof value !== "string") throw new Error(`--${key} requires a value`)
    return value as string | undefined
  }
  const dir = resolve(options.cwd, string("dir") ?? ".")
  const configDir = configDirectory({ configDir: string("config-dir"), env: options.env })
  let result: unknown
  if (action === "init") {
    const provider = string("provider")
    if (!provider || !["vercel", "cloudflare", "fly"].includes(provider)) throw new Error("Set --provider vercel|cloudflare|fly")
    const environment = string("environment")
    if (environment !== undefined && environment !== "preview" && environment !== "production") throw new Error("Set --environment preview|production")
    result = await initDeployment(provider as Provider, dir, { name: string("name"), environment, region: string("region"), scope: string("scope") })
  } else {
    const config = await readDeployment(dir)
    if (action === "plan") result = planDeployment(config)
    else if (action === "status") result = await statusDeployment(config, { configDir })
    else {
      const file = string("r2-credentials")
      if (file && config.provider !== "cloudflare") throw new Error("--r2-credentials only applies to Cloudflare")
      result = await applyDeployment(planDeployment(config), { configDir, credentials: file ? await readR2Credentials(resolve(options.cwd, file)) : undefined })
    }
  }
  print(JSON.stringify(result, null, 2))
  return true
}
