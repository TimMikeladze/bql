/** Kept free of Worker globals so routing and secret boundaries run under Bun tests. */
export type DeploymentEnvironment = Record<string, unknown>
const required = [
  "BQL_DEPLOYMENT_ENV", "BQL_DATA_DEPLOYMENT_ID", "BQL_STORAGE_DEPLOYMENT_ID",
  "BQL_ADMIN_KEY", "BQL_JWT_ED25519", "BQL_S3_BUCKET", "BQL_S3_ENDPOINT",
  "BQL_S3_ACCESS_KEY_ID", "BQL_S3_SECRET_ACCESS_KEY",
] as const

export function containerEnvironment(env: DeploymentEnvironment): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of required) {
    const value = env[key]
    if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${key}`)
    result[key] = value
  }
  if (!["preview", "production", "development"].includes(result.BQL_DEPLOYMENT_ENV!)) throw new Error("Invalid deployment environment")
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result.BQL_DATA_DEPLOYMENT_ID!)) throw new Error("Invalid deployment identity")
  // This secret is provisioned alongside the bucket credentials, separately from Worker vars.
  if (result.BQL_DATA_DEPLOYMENT_ID !== result.BQL_STORAGE_DEPLOYMENT_ID) throw new Error("Storage identity does not match deployment identity")
  const endpoint = new URL(result.BQL_S3_ENDPOINT!)
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Storage endpoint must be a private HTTPS API endpoint")
  return { ...result, BQL_S3_REGION: "auto", BQL_DATA_STORAGE_MODE: "object", BQL_DATA_DIR: "/tmp/bql", BQL_SERVER_HOST: "0.0.0.0", BQL_SERVER_PORT: "8080" }
}

export interface ContainerNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> }
}

export async function routeRequest(request: Request, env: DeploymentEnvironment & { DATABASE: ContainerNamespace }): Promise<Response> {
  let settings: Record<string, string>
  try { settings = containerEnvironment(env) }
  catch { return Response.json({ error: "Cloud deployment is not configured" }, { status: 503 }) }
  // Neither the URL nor a caller header can select another container/root.
  return env.DATABASE.getByName(`${settings.BQL_DEPLOYMENT_ENV}:${settings.BQL_DATA_DEPLOYMENT_ID}`).fetch(request)
}
