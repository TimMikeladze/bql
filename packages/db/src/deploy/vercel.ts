import { chmod, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { initializeObjectDeployment, parseNativeJson, type DriverContext } from "./driver.ts"

interface Project { id: string; name: string; accountId: string; protectionBypass?: Record<string, { scope: string }> }
interface Store { id: string; name: string; region: string; access?: string }

/** Provider authentication and API calls stay inside the user's Vercel CLI. */
export async function deployVercel(context: DriverContext): Promise<string> {
  const { config, journal, runner, appDir, release } = context
  const scope = journal.state.scope ?? config.scope
  if (!scope) throw new Error("Select a Vercel team with --scope during deploy init")
  const call = (args: string[], input?: string) => runner({ executable: "vercel", args: [...args, "--scope", scope], cwd: appDir, ...(input === undefined ? {} : { input }) })
  const api = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const result = await call(["api", path, "--method", method, "--raw", ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body))
    // Successful connection mutations return HTTP 204 with no JSON body.
    if (method !== "GET" && !result.stdout.trim()) return undefined as T
    return parseNativeJson<T>(result.stdout, "vercel api")
  }
  const projects = async () => {
    const result = await api<{ projects: Project[]; pagination?: { next?: number | null } }>(`/v9/projects?search=${encodeURIComponent(config.name)}&limit=100`)
    if (!Array.isArray(result.projects) || result.pagination?.next) throw new Error("Cannot establish an unambiguous Vercel project inventory")
    return result.projects
  }
  await journal.step("project", async () => {
    const existing = (await projects()).find(project => project.name === config.name)
    if (existing && existing.id !== journal.state.resources.project) throw new Error(`Vercel project ${config.name} already exists and is not owned by this deployment`)
    if (!existing) {
      if (journal.state.resources.project) throw new Error("The recorded Vercel project is missing")
      const created = await api<Project>("/v10/projects", "POST", { name: config.name })
      await journal.recordResource("project", created.id)
      await journal.recordResource("account", created.accountId)
    }
  })
  const projectId = journal.state.resources.project!
  const project = await api<Project>(`/v9/projects/${encodeURIComponent(projectId)}`)
  if (project.id !== projectId || project.name !== config.name || project.accountId !== journal.state.resources.account) throw new Error("The recorded Vercel project has changed ownership or identity")
  // Each staged release has its own native link, never the user's working directory.
  await call(["link", "--yes", "--project", projectId])
  const stores = async () => {
    const result = await api<{ stores: Store[] }>("/v1/storage/stores")
    if (!Array.isArray(result.stores)) throw new Error("Vercel returned an invalid Blob inventory")
    return result.stores
  }
  await journal.step("blob", async () => {
    const existing = (await stores()).find(store => store.name === config.name)
    if (existing && existing.id !== journal.state.resources.blob) throw new Error(`Blob store ${config.name} already exists and is not owned by this deployment`)
    if (!existing) {
      if (journal.state.resources.blob) throw new Error("The recorded Blob store is missing; recover its data before applying")
      const { store } = await api<{ store: Store }>("/v1/storage/stores/blob", "POST", { name: config.name, region: config.region, access: "private" })
      await journal.recordResource("blob", store.id)
    }
  })
  const store = (await stores()).find(store => store.id === journal.state.resources.blob)
  if (!store) throw new Error("The recorded Blob store is missing; recover its data before applying")
  if (store.name !== config.name || store.region !== config.region || store.access !== "private") throw new Error("The recorded Blob store is not private or differs from the deployment plan")
  await journal.step("blobConnection", async () => {
    const path = `/v1/storage/stores/${encodeURIComponent(store.id)}/connections`
    const { connections } = await api<{ connections: { projectId: string; envVarEnvironments: string[] }[] }>(path)
    if (!Array.isArray(connections)) throw new Error("Vercel returned invalid Blob connections")
    const existing = connections.find(connection => connection.projectId === projectId)
    if (existing) {
      if (existing.envVarEnvironments?.length !== 1 || existing.envVarEnvironments[0] !== config.environment) throw new Error("Blob connection crosses deployment environments")
    } else await api(path, "POST", { projectId, envVarEnvironments: [config.environment], type: "integration" })
  })
  if (!journal.secrets.BLOB_READ_WRITE_TOKEN) {
    // Pull outside the build tree. Never evaluate dotenv as a shell program.
    const file = join(journal.directory, `blob-${crypto.randomUUID()}.env`)
    try {
      await call(["env", "pull", file, "--environment", config.environment, "--yes"])
      await chmod(file, 0o600)
      const content = await readFile(file, "utf8")
      const matches = [...content.matchAll(/^BLOB_READ_WRITE_TOKEN=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s'"\r\n]+))\r?$/gm)]
      if (matches.length !== 1) throw new Error("Could not retrieve the linked private Blob token")
      const token = matches[0]![1] ?? matches[0]![2] ?? matches[0]![3]!
      if (!/^[a-zA-Z0-9_-]+$/.test(token)) throw new Error("Vercel returned an invalid Blob credential")
      await journal.setSecrets({ BLOB_READ_WRITE_TOKEN: token })
    } finally { await rm(file, { force: true }) }
  }
  await initializeObjectDeployment(context, { BLOB_READ_WRITE_TOKEN: journal.secrets.BLOB_READ_WRITE_TOKEN!, VERCEL_BLOB_RETRIES: "0" })
  await journal.step("environment", async () => {
    const values = {
      BQL_ADMIN_KEY: journal.secrets.BQL_ADMIN_KEY!, BQL_JWT_ED25519: journal.secrets.BQL_JWT_ED25519!,
      BQL_DATA_DEPLOYMENT_ID: config.deploymentId, BQL_DEPLOYMENT_ENV: config.environment, VERCEL_BLOB_RETRIES: "0",
    }
    for (const [key, value] of Object.entries(values)) await call(["env", "add", key, config.environment, key === "BQL_ADMIN_KEY" || key === "BQL_JWT_ED25519" ? "--sensitive" : "--no-sensitive", "--yes", "--force"], value)
  })
  // Re-read on every apply so a revoked automation credential is not silently reused.
  let bypasses = project.protectionBypass
  if (!Object.values(bypasses ?? {}).some(value => value.scope === "automation-bypass")) bypasses = (await api<Project>(`/v1/projects/${encodeURIComponent(projectId)}/protection-bypass`, "PATCH", {})).protectionBypass
  const bypass = Object.keys(bypasses ?? {}).find(key => bypasses![key]?.scope === "automation-bypass")
  if (!bypass) throw new Error("Create a Vercel Protection Bypass for Automation secret for this project, then retry")
  await journal.setSecrets({ VERCEL_AUTOMATION_BYPASS_SECRET: bypass })
  await journal.step(`release_${release}`, async () => {
    const result = await call(["deploy", "--yes", "--json", "--target", config.environment])
    type Release = { url: string; target: string | null; readyState: string }
    const output = parseNativeJson<Release | { deployment: Release }>(result.stdout, "vercel deploy")
    const deployed = "deployment" in output ? output.deployment : output
    if (!deployed || typeof deployed.url !== "string" || !/^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(deployed.url) || deployed.readyState !== "READY") throw new Error("Vercel did not return a ready deployment; inspect its status before retrying")
    if ((deployed.target === "production") !== (config.environment === "production")) throw new Error("Vercel published to a different environment; inspect the deployment before using it")
    await journal.recordEndpoint(deployed.url)
  })
  if (!journal.state.endpoint) throw new Error("The saved Vercel release URL is missing")
  return journal.state.endpoint
}
