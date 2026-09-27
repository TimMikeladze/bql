import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cloudflareApi, CloudflareApiError, type CloudflareApi } from "./cloudflare-api.ts"
import { initializeObjectDeployment, type DriverContext } from "./driver.ts"

export interface R2Credentials { accessKeyId: string; secretAccessKey: string }

export async function deployCloudflare(context: DriverContext, options: { api?: CloudflareApi; credentials?: R2Credentials } = {}): Promise<string> {
  const { config, journal, runner, appDir, release } = context
  const account = journal.state.scope ?? config.scope
  if (!account || !/^[a-f0-9]{32}$/.test(account)) throw new Error("Select a Cloudflare account with --scope ACCOUNT_ID")
  const api = options.api ?? cloudflareApi({ account, cwd: appDir, runner })
  try { await api("/containers/me") }
  catch (error) {
    if (error instanceof CloudflareApiError && [401, 403].includes(error.status)) throw new Error("Cloudflare Containers requires Workers Paid and an authorized native login. Check https://dash.cloudflare.com/?to=/:account/workers/plans before applying")
    throw error
  }
  const scripts = await api<{ id: string }[]>("/workers/scripts")
  if (!Array.isArray(scripts)) throw new Error("Cloudflare returned an invalid Worker inventory")
  const worker = scripts.find(script => script.id === config.name)
  if (worker && journal.state.resources.worker !== config.name) throw new Error(`Worker ${config.name} already exists and is not owned by this deployment`)
  if (!worker && journal.state.resources.worker) throw new Error("The recorded Cloudflare Worker is missing; inspect its deployment before applying")
  const buckets = async () => {
    const result = await api<{ buckets: { name: string }[] }>("/r2/buckets")
    if (!Array.isArray(result?.buckets)) throw new Error("Cloudflare returned an invalid bucket inventory")
    return result.buckets
  }
  await journal.step("bucket", async () => {
    const existing = (await buckets()).find(bucket => bucket.name === config.name)
    if (existing && journal.state.resources.bucket !== config.name) throw new Error(`R2 bucket ${config.name} already exists and is not owned by this deployment`)
    if (!existing) {
      if (journal.state.resources.bucket) throw new Error("The recorded R2 bucket is missing; recover its data before applying")
      await runner({ executable: "wrangler", args: ["r2", "bucket", "create", config.name, "--location", config.region, "--update-config=false"], cwd: appDir, env: { CLOUDFLARE_ACCOUNT_ID: account } })
    }
    await journal.recordResource("bucket", config.name)
  })
  if (!(await buckets()).some(bucket => bucket.name === journal.state.resources.bucket)) throw new Error("The recorded R2 bucket is missing; recover its data before applying")
  if (options.credentials) {
    const values = { BQL_S3_ACCESS_KEY_ID: options.credentials.accessKeyId, BQL_S3_SECRET_ACCESS_KEY: options.credentials.secretAccessKey }
    if (Object.entries(values).some(([key, value]) => journal.secrets[key] && journal.secrets[key] !== value)) throw new Error("R2 credentials differ from the saved deployment; rotate credentials explicitly before applying")
    await journal.setSecrets(values)
  }
  if (!journal.secrets.BQL_S3_ACCESS_KEY_ID || !journal.secrets.BQL_S3_SECRET_ACCESS_KEY) throw new Error(`R2 bucket ${config.name} is ready. Create Object Read & Write credentials limited to this bucket at https://dash.cloudflare.com/${account}/r2/api-tokens, save BQL_S3_ACCESS_KEY_ID and BQL_S3_SECRET_ACCESS_KEY in a private env file, then run bql deploy apply --r2-credentials /path/to/file. Wrangler OAuth cannot create these S3 credentials`)
  const endpoint = `https://${account}.r2.cloudflarestorage.com`
  const configPath = join(appDir, "wrangler.jsonc")
  const wrangler = JSON.parse(await readFile(configPath, "utf8"))
  wrangler.account_id = account
  wrangler.vars.BQL_S3_ENDPOINT = endpoint
  wrangler.workers_dev = true
  wrangler.preview_urls = false
  await writeFile(configPath, JSON.stringify(wrangler, null, 2) + "\n")
  const storage = {
    BQL_S3_BUCKET: config.name, BQL_S3_ENDPOINT: endpoint, BQL_S3_REGION: "auto",
    BQL_S3_ACCESS_KEY_ID: journal.secrets.BQL_S3_ACCESS_KEY_ID, BQL_S3_SECRET_ACCESS_KEY: journal.secrets.BQL_S3_SECRET_ACCESS_KEY,
  }
  await initializeObjectDeployment(context, storage)
  await journal.step("workerSecrets", async () => {
    await runner({ executable: "wrangler", args: ["secret", "bulk"], cwd: appDir, env: { CLOUDFLARE_ACCOUNT_ID: account }, input: JSON.stringify({
      BQL_ADMIN_KEY: journal.secrets.BQL_ADMIN_KEY, BQL_JWT_ED25519: journal.secrets.BQL_JWT_ED25519,
      BQL_STORAGE_DEPLOYMENT_ID: config.deploymentId,
      BQL_S3_ACCESS_KEY_ID: journal.secrets.BQL_S3_ACCESS_KEY_ID, BQL_S3_SECRET_ACCESS_KEY: journal.secrets.BQL_S3_SECRET_ACCESS_KEY,
    }) })
    await journal.recordResource("worker", config.name)
  })
  await journal.step(`release_${release}`, async () => {
    await runner({ executable: "bun", args: ["install", "--cwd", "deploy/cloudflare", "--frozen-lockfile", "--production"], cwd: appDir })
    await runner({ executable: "wrangler", args: ["deploy", "--tag", config.deploymentId], cwd: appDir, env: { CLOUDFLARE_ACCOUNT_ID: account } })
  })
  const { subdomain } = await api<{ subdomain: string }>("/workers/subdomain")
  if (typeof subdomain !== "string" || !/^[a-z0-9-]+$/.test(subdomain)) throw new Error("Cloudflare workers.dev subdomain is not configured")
  const url = `https://${config.name}.${subdomain}.workers.dev`
  await journal.recordEndpoint(url)
  return url
}
