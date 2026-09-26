/** Bun/Node workstation context. The portable client never imports this module. */
import { configDirectory, ContextStore } from "./store.ts"
import { findLink, type FoundLink } from "./link.ts"
import {
  serviceUrl,
  validateHttpCredential,
  type Credential,
  type Credentials,
  type Endpoint,
  type Environment,
  type Organization,
  type Project,
  type Registry,
} from "./model.ts"
export type { Registry, ProjectLink, ServiceConnection } from "./model.ts"
export interface ResolveOptions {
  cwd?: string
  configDir?: string
  env?: Environment
  org?: string
  project?: string
  endpoint?: string
  url?: string
  token?: string
  vercelBypass?: string
  service?: "database" | "bus"
}
export interface ResolvedContext {
  mode: "named" | "direct" | "local"
  source: string
  service: "database" | "bus"
  org?: { id: string; name: string }
  project?: { id: string; name: string }
  endpoint?: { id: string; name: string }
  url: string
  token?: string
  headers: Record<string, string>
}
export const nonempty = (s: string | undefined): string | undefined =>
  s || undefined
export function lookup<T extends { id: string; name: string }>(
  rows: T[],
  value: string | undefined,
  kind: string,
  idOnly = false,
): T {
  if (!value)
    throw new Error(`No ${kind} selected; specify --${kind} or run bql link`)
  const matches = rows.filter(
    (r) => r.id === value || (!idOnly && r.name === value),
  )
  if (matches.length > 1)
    throw new Error(
      `Ambiguous ${kind} name/ID; rename the colliding record using its unique ID`,
    )
  const found = matches[0]
  if (!found)
    throw new Error(
      `Unknown or removed ${kind}; inspect bql ${kind} list and select it again`,
    )
  return found
}
export function selectRecords(
  r: Registry,
  o: ResolveOptions,
  link: FoundLink | null,
  level: "org" | "project" | "endpoint" = "endpoint",
): {
  org: Organization
  project?: Project
  endpoint?: Endpoint
  source: string
} {
  const env = o.env ?? process.env
  const orgSelector = o.org || nonempty(env.BQL_ORG)
  const org = lookup(
    r.organizations,
    orgSelector || link?.org || r.selection.org,
    "org",
    !orgSelector,
  )
  if (level === "org") return { org, source: "selection" }
  const envOrgCompatible =
    !o.org ||
    !nonempty(env.BQL_ORG) ||
    env.BQL_ORG === org.id ||
    env.BQL_ORG === org.name
  const projectSelector =
    o.project || (envOrgCompatible ? nonempty(env.BQL_PROJECT) : undefined)
  const project = lookup(
    org.projects,
    projectSelector ||
      (link?.org === org.id ? link.project : undefined) ||
      (r.selection.org === org.id ? r.selection.project : undefined),
    "project",
    !projectSelector,
  )
  if (level === "project") return { org, project, source: "selection" }
  const envProjectCompatible =
    envOrgCompatible &&
    (!o.project ||
      !nonempty(env.BQL_PROJECT) ||
      env.BQL_PROJECT === project.id ||
      env.BQL_PROJECT === project.name)
  const endpointSelector =
    o.endpoint ||
    (envProjectCompatible ? nonempty(env.BQL_ENDPOINT) : undefined)
  const endpoint = lookup(
    project.endpoints,
    endpointSelector ||
      (link?.org === org.id && link.project === project.id
        ? link.endpoint
        : undefined) ||
      project.defaultEndpoint,
    "endpoint",
    !endpointSelector,
  )
  const source =
    o.org || o.project || o.endpoint
      ? "flags"
      : env.BQL_ORG || env.BQL_PROJECT || env.BQL_ENDPOINT
        ? "environment"
        : link?.org === org.id && link.project === project.id
          ? "project link"
          : "global selection"
  return { org, project, endpoint, source }
}
function secret(
  ref: Credential | undefined,
  secrets: Credentials,
  env: Environment,
): string | undefined {
  if (!ref) return undefined
  const value =
    "env" in ref
      ? nonempty(env[ref.env])
      : Object.hasOwn(secrets, ref.key)
        ? secrets[ref.key]
        : undefined
  if (!value)
    throw new Error(
      "env" in ref
        ? `Missing credential environment variable ${ref.env}`
        : "Missing saved credential; update the endpoint credentials",
    )
  validateHttpCredential(value)
  return value
}
export async function resolveContext(
  options: ResolveOptions = {},
): Promise<ResolvedContext> {
  for (const field of ["url", "org", "project", "endpoint"] as const) {
    if (options[field] !== undefined && !options[field]?.trim())
      throw new Error(`Explicit ${field} cannot be empty`)
  }
  const env = options.env ?? process.env,
    service = options.service ?? "database"
  const explicit = Boolean(options.org || options.project || options.endpoint)
  const envSelection = Boolean(
    nonempty(env.BQL_ORG) ||
    nonempty(env.BQL_PROJECT) ||
    nonempty(env.BQL_ENDPOINT),
  )
  if (options.url && explicit)
    throw new Error("Cannot combine --url with --org, --project or --endpoint")
  const legacyUrl = nonempty(service === "bus" ? env.BUS_URL : env.BQL_URL)
  const direct =
    options.url || (!explicit && !envSelection ? legacyUrl : undefined)
  function legacy(url: string, mode: "direct" | "local"): ResolvedContext {
    const token =
      options.token ??
      nonempty(service === "bus" ? env.BUS_TOKEN : env.BQL_TOKEN) ??
      (service === "database" ? nonempty(env.BQL_ADMIN_KEY) : undefined)
    const bypass =
      options.vercelBypass ??
      nonempty(
        service === "bus" ? env.BUS_VERCEL_BYPASS : env.BQL_VERCEL_BYPASS,
      )
    validateHttpCredential(token)
    validateHttpCredential(bypass)
    return {
      mode,
      source: options.url ? "flags" : legacyUrl ? "environment" : "localhost",
      service,
      url: serviceUrl(url),
      ...(token ? { token } : {}),
      headers: bypass ? { "x-vercel-protection-bypass": bypass } : {},
    }
  }
  if (direct) return legacy(direct, "direct")
  const store = new ContextStore(
      configDirectory({ configDir: options.configDir, env }),
    ),
    registry = await store.read()
  const link = await findLink(options.cwd ?? process.cwd())
  if (
    !explicit &&
    !envSelection &&
    !link &&
    !registry.selection.org &&
    !registry.selection.project
  )
    return legacy(
      service === "bus" ? "http://127.0.0.1:4317" : "http://127.0.0.1:4321",
      "local",
    )
  const selected = selectRecords(registry, { ...options, env }, link),
    endpoint = selected.endpoint!
  const connection = endpoint[service]
  if (!connection)
    throw new Error(
      `Selected endpoint has no ${service} connection; update it before using ${service} commands`,
    )
  const secrets = await store.readCredentials()
  const token = options.token ?? secret(connection.token, secrets, env),
    bypass = options.vercelBypass ?? secret(connection.bypass, secrets, env)
  validateHttpCredential(token)
  validateHttpCredential(bypass)
  const identity = (r: { id: string; name: string }) => ({
    id: r.id,
    name: r.name,
  })
  return {
    mode: "named",
    source: selected.source,
    service,
    org: identity(selected.org),
    project: identity(selected.project!),
    endpoint: identity(endpoint),
    url: serviceUrl(connection.url),
    ...(token ? { token } : {}),
    headers: bypass ? { "x-vercel-protection-bypass": bypass } : {},
  }
}
export function redactContext(c: ResolvedContext) {
  return {
    mode: c.mode,
    source: c.source,
    service: c.service,
    org: c.org,
    project: c.project,
    endpoint: c.endpoint,
    url: c.url,
    authenticated: Boolean(c.token),
    vercelProtectionBypass: Boolean(c.headers["x-vercel-protection-bypass"]),
  }
}
