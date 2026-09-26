/** Workstation-only connection metadata. Credentials are opaque references, never values. */
export type Environment = Record<string, string | undefined>
export type Credential = { env: string } | { key: string }
export interface ServiceConnection {
  url: string
  token?: Credential
  bypass?: Credential
}
export interface Endpoint {
  id: string
  name: string
  database: ServiceConnection
  bus?: ServiceConnection
}
export interface Project {
  id: string
  name: string
  endpoints: Endpoint[]
  defaultEndpoint?: string
}
export interface Organization {
  id: string
  name: string
  projects: Project[]
}
export interface Registry {
  version: 1
  organizations: Organization[]
  selection: { org?: string; project?: string }
}
export type Credentials = Record<string, string>
export interface ProjectLink {
  version: 1
  org: string
  project: string
  endpoint?: string
}
export const emptyRegistry = (): Registry => ({
  version: 1,
  organizations: [],
  selection: {},
})
export function slug(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))
    throw new Error(
      "Names must start with a letter or digit and contain only letters, digits, _ or -",
    )
  return value
}
export function serviceUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Endpoint URL must be an absolute HTTP(S) URL")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  )
    throw new Error(
      "Endpoint URL must use HTTP(S), without credentials, query or fragment",
    )
  return url.toString().replace(/\/+$/, "")
}
function object(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid configuration object")
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw new Error("Unknown configuration field")
}
function text(v: unknown): asserts v is string {
  if (typeof v !== "string" || !v)
    throw new Error("Invalid configuration identifier")
}
function credential(v: unknown) {
  object(v)
  keys(v, ["env", "key"])
  if ("env" in v === "key" in v) throw new Error("Invalid credential reference")
  if ("env" in v) {
    text(v.env)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.env))
      throw new Error("Invalid credential environment variable")
  } else text(v.key)
}
function service(v: unknown) {
  object(v)
  keys(v, ["url", "token", "bypass"])
  text(v.url)
  serviceUrl(v.url)
  if (v.token !== undefined) credential(v.token)
  if (v.bypass !== undefined) credential(v.bypass)
}
export function validateRegistry(value: unknown): asserts value is Registry {
  object(value)
  if (value.version !== 1)
    throw new Error("Unsupported BQL config version (expected 1)")
  keys(value, ["version", "organizations", "selection"])
  object(value.selection)
  keys(value.selection, ["org", "project"])
  for (const v of Object.values(value.selection)) text(v)
  const ids = new Set<string>()
  function records(
    v: unknown,
    fields: string[],
    visit: (r: Record<string, unknown>) => void,
  ) {
    if (!Array.isArray(v)) throw new Error("Invalid configuration records")
    const names = new Set<string>()
    for (const r of v) {
      object(r)
      keys(r, ["id", "name", ...fields])
      text(r.id)
      text(r.name)
      slug(r.name)
      if (ids.has(r.id) || names.has(r.name))
        throw new Error(
          "Configuration has duplicate identifiers or sibling names",
        )
      ids.add(r.id)
      names.add(r.name)
      visit(r)
    }
  }
  records(value.organizations, ["projects"], (o) =>
    records(o.projects, ["endpoints", "defaultEndpoint"], (p) => {
      if (p.defaultEndpoint !== undefined) text(p.defaultEndpoint)
      records(p.endpoints, ["database", "bus"], (e) => {
        service(e.database)
        if (e.bus !== undefined) service(e.bus)
      })
    }),
  )
}
export function validateCredentials(v: unknown): asserts v is Credentials {
  object(v)
  if (
    Object.values(v).some(
      (s) => typeof s !== "string" || !s || /[^\x20-\x7e]/.test(s),
    )
  )
    throw new Error("Invalid credential store")
}
export function validateLink(v: unknown): asserts v is ProjectLink {
  object(v)
  keys(v, ["version", "org", "project", "endpoint"])
  if (v.version !== 1) throw new Error("Unsupported BQL project link version")
  text(v.org)
  text(v.project)
  if (v.endpoint !== undefined) text(v.endpoint)
}

/** Reject values before runtime header errors can echo a secret to stderr. */
export function validateHttpCredential(value: string | undefined): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || /[^\x20-\x7e]/.test(value))
  )
    throw new Error(
      "Invalid credential: use printable ASCII without control characters",
    )
}
