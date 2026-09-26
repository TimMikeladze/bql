import { ContextStore } from "../context/store.ts"
import { serviceUrl, validateHttpCredential } from "../context/model.ts"
import { validateDeployment, type DeploymentConfig } from "./config.ts"

export interface DeploymentConnection { url: string; token: string; bypass?: string }
export interface DeploymentProfile { org: string; project: string; endpoint: string }

/** Save into the existing workstation registry without changing the user's selection. */
export async function saveDeploymentEndpoint(config: DeploymentConfig, connection: DeploymentConnection, store = new ContextStore()): Promise<DeploymentProfile> {
  validateDeployment(config)
  const url = serviceUrl(connection.url)
  if (!connection.token) throw new Error("Deployment endpoint needs its admin credential")
  validateHttpCredential(connection.token)
  validateHttpCredential(connection.bypass)
  const profile = { org: `deploy-${config.provider}`, project: config.name, endpoint: config.environment }
  const id = `deployment-${config.deploymentId}`
  await store.mutate((registry, secrets) => {
    let org = registry.organizations.find(org => org.id === profile.org)
    if (!org) {
      if (registry.organizations.some(org => org.name === profile.org)) throw new Error("Deployment organization name is already in use")
      org = { id: profile.org, name: profile.org, projects: [] }
      registry.organizations.push(org)
    }
    let project = org.projects.find(project => project.name === profile.project)
    if (!project) {
      project = { id: crypto.randomUUID(), name: profile.project, endpoints: [] }
      org.projects.push(project)
    }
    let endpoint = project.endpoints.find(endpoint => endpoint.name === profile.endpoint)
    if (endpoint && endpoint.id !== id) throw new Error("This endpoint belongs to a different deployment")
    if (!endpoint) {
      endpoint = { id, name: profile.endpoint, database: { url } }
      project.endpoints.push(endpoint)
      project.defaultEndpoint ??= id
    }
    const previous = endpoint.database
    const tokenKey = crypto.randomUUID()
    secrets[tokenKey] = connection.token
    endpoint.database = { url, token: { key: tokenKey } }
    if (connection.bypass) {
      const bypassKey = crypto.randomUUID()
      secrets[bypassKey] = connection.bypass
      endpoint.database.bypass = { key: bypassKey }
    }
    // Credentials may be shared with manually configured endpoints: retain only referenced keys.
    const referenced = new Set<string>()
    for (const o of registry.organizations) for (const p of o.projects) for (const e of p.endpoints) {
      for (const service of [e.database, e.bus]) for (const credential of [service?.token, service?.bypass]) {
        if (credential && "key" in credential) referenced.add(credential.key)
      }
    }
    for (const credential of [previous.token, previous.bypass]) if (credential && "key" in credential && !referenced.has(credential.key)) delete secrets[credential.key]
  })
  return profile
}
