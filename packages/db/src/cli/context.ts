import { resolve } from "node:path"
import { configDirectory, ContextStore } from "../context/store.ts"
import { findLink, unlinkProject, writeLink } from "../context/link.ts"
import {
  lookup,
  redactContext,
  resolveContext,
  selectRecords,
  type ResolveOptions,
} from "../context/index.ts"
import {
  serviceUrl,
  slug,
  type Credential,
  type Credentials,
  type Endpoint,
  type Environment,
  type Organization,
  type Project,
  type Registry,
  type ServiceConnection,
} from "../context/model.ts"
import { choose, promptLine } from "./prompt.ts"
import type { ParsedArgs } from "../cli.ts"

export const CONTEXT_HELP = `Connection management:
  bql org add|list|inspect|update|remove [name] [--name NEW] [--recursive]
  bql switch <org>
  bql project add|list|inspect|update|remove|use [name] [--org ORG]
  bql endpoint add|list|inspect|update|remove|use [name] [--org ORG --project PROJECT]
  bql endpoint use <name> [--default]  update checkout link or project default
  bql link [--org ORG --project PROJECT --endpoint ENDPOINT]
  bql unlink
  bql context [--service database|bus] [--json]

Endpoint add/update:
  --url URL                         database service URL
  --bus-url URL                     optional bus service URL
  --token-env VAR                   database token environment reference
  --vercel-bypass-env VAR           database Vercel bypass environment reference
  --bus-token-env VAR               bus token environment reference
  --bus-vercel-bypass-env VAR       bus Vercel bypass environment reference
  --prompt-token / --prompt-vercel-bypass / --prompt-bus-token / --prompt-bus-vercel-bypass
                                    save credentials from a hidden terminal prompt
  --clear-token / --clear-vercel-bypass / --clear-bus-token / --clear-bus-vercel-bypass
  --clear-bus                       remove optional bus connection
  --name NEW                       rename a record, preserving checkout links

Selection: --org ORG --project PROJECT --endpoint ENDPOINT (or BQL_ORG/PROJECT/ENDPOINT)
  --cwd DIR                        project lookup directory
  --config-dir DIR                 private registry directory (or BQL_CONFIG_DIR)
  --vercel-bypass SECRET            per-command protection bypass override
  --json                           machine-readable output; never prints saved secrets
Named connections ignore legacy URL/token environment variables. Explicit --url is direct mode.
`
export function contextOptions(
  args: ParsedArgs,
  env: Environment = process.env,
): ResolveOptions {
  const get = (key: string): string | undefined => {
    const value = args.flags[key]
    if (value === true) throw new Error(`--${key} needs a value`)
    return typeof value === "string" ? value : undefined
  }
  const service = get("service")
  if (service && service !== "database" && service !== "bus")
    throw new Error("--service must be database or bus")
  return {
    env,
    cwd: resolve(get("cwd") ?? process.cwd()),
    configDir: get("config-dir"),
    org: get("org"),
    project: get("project"),
    endpoint: get("endpoint"),
    url: get("url"),
    token: get("token"),
    vercelBypass: get("vercel-bypass"),
    ...(service ? { service: service as "database" | "bus" } : {}),
  }
}
function references(r: Registry): Set<string> {
  const keys = new Set<string>()
  for (const o of r.organizations)
    for (const p of o.projects)
      for (const e of p.endpoints)
        for (const s of [e.database, e.bus])
          for (const ref of [s?.token, s?.bypass])
            if (ref && "key" in ref) keys.add(ref.key)
  return keys
}
function cleanCredentials(r: Registry, c: Credentials) {
  const keep = references(r)
  for (const key of Object.keys(c)) if (!keep.has(key)) delete c[key]
}
function view(record: Organization | Project | Endpoint): unknown {
  if ("projects" in record)
    return {
      id: record.id,
      name: record.name,
      projects: record.projects.map(view),
    }
  if ("endpoints" in record)
    return {
      id: record.id,
      name: record.name,
      defaultEndpoint: record.defaultEndpoint,
      endpoints: record.endpoints.map(view),
    }
  const service = (s: ServiceConnection | undefined) =>
    s
      ? {
          url: s.url,
          authenticated: Boolean(s.token),
          vercelProtectionBypass: Boolean(s.bypass),
          tokenEnv: s.token && "env" in s.token ? s.token.env : undefined,
          bypassEnv: s.bypass && "env" in s.bypass ? s.bypass.env : undefined,
        }
      : undefined
  return {
    id: record.id,
    name: record.name,
    database: service(record.database),
    bus: service(record.bus),
  }
}
export async function runContextCommand(
  args: ParsedArgs,
  options: { cwd: string; env: Environment },
): Promise<boolean> {
  const [command, action, name] = args.positional
  if (
    !command ||
    ![
      "org",
      "project",
      "endpoint",
      "switch",
      "link",
      "unlink",
      "context",
    ].includes(command)
  )
    return false
  const get = (key: string): string | undefined => {
    const v = args.flags[key]
    if (v === true) throw new Error(`--${key} needs a value`)
    return typeof v === "string" ? v : undefined
  }
  const output = (value: unknown) =>
    console.log(
      args.flags.json === true
        ? JSON.stringify(value, null, 2)
        : typeof value === "string"
          ? value
          : Bun.inspect(value, { colors: false, depth: 6 }),
    )
  if (
    args.flags.help ||
    (!action && ["org", "project", "endpoint"].includes(command))
  ) {
    console.log(CONTEXT_HELP)
    return true
  }
  const opts = {
    ...contextOptions(args, options.env),
    cwd: resolve(get("cwd") ?? options.cwd),
  }
  const store = new ContextStore(
    configDirectory({ configDir: opts.configDir, env: opts.env }),
  )
  if (command === "context") {
    output(redactContext(await resolveContext(opts)))
    return true
  }
  if (command === "unlink") {
    await unlinkProject(opts.cwd)
    output("Unlinked BQL project")
    return true
  }
  const link = await findLink(opts.cwd)
  // Management flags such as --url configure a record, not the management command's transport.
  const selection = {
    ...opts,
    url: undefined,
    token: undefined,
    vercelBypass: undefined,
  }
  if (command === "link") {
    const r = await store.read()
    if (
      !selection.org &&
      !options.env.BQL_ORG &&
      !link?.org &&
      !r.selection.org
    )
      selection.org = await choose("Organization", r.organizations)
    const org = selectRecords(r, selection, link, "org").org
    if (
      !selection.project &&
      !options.env.BQL_PROJECT &&
      !(link?.org === org.id) &&
      !(r.selection.org === org.id && r.selection.project)
    )
      selection.project = await choose("Project", org.projects)
    const project = selectRecords(r, selection, link, "project").project!
    if (
      !selection.endpoint &&
      !options.env.BQL_ENDPOINT &&
      !(link?.org === org.id && link.project === project.id && link.endpoint) &&
      !project.defaultEndpoint
    )
      selection.endpoint = await choose("Endpoint", project.endpoints)
    const selected = selectRecords(r, selection, link)
    await writeLink(opts.cwd, {
      version: 1,
      org: org.id,
      project: project.id,
      endpoint: selected.endpoint!.id,
    })
    output({
      org: org.name,
      project: project.name,
      endpoint: selected.endpoint!.name,
    })
    return true
  }
  if (command === "switch") {
    const target =
      action ??
      (await choose("Organization", (await store.read()).organizations))
    let selectedName = ""
    await store.mutate((r) => {
      const org = lookup(r.organizations, target, "org")
      r.selection = { org: org.id }
      selectedName = org.name
    })
    output({ org: selectedName })
    return true
  }
  if (
    !action ||
    !["add", "list", "inspect", "update", "remove", "use"].includes(action)
  )
    throw new Error(`Unknown ${command} operation; run bql ${command} --help`)
  if (action !== "list" && !name)
    throw new Error(`${command} ${action} needs a name`)
  const records = (r: Registry): (Organization | Project | Endpoint)[] => {
    if (command === "org") return r.organizations
    const s = selectRecords(
      r,
      selection,
      link,
      command === "project" ? "org" : "project",
    )
    return command === "project" ? s.org.projects : s.project!.endpoints
  }
  if (action === "list" || action === "inspect") {
    const rows = records(await store.read())
    if (action === "list" && args.flags.json !== true) {
      if (!rows.length) console.log(`No ${command} records`)
      else
        console.log(
          Bun.inspect.table(
            rows.map((record) => ({
              name: record.name,
              id: record.id,
              ...("projects" in record
                ? { projects: record.projects.length }
                : "endpoints" in record
                  ? { endpoints: record.endpoints.length }
                  : {
                      database: record.database.url,
                      bus: record.bus?.url ?? "-",
                    }),
            })),
          ),
        )
    } else
      output(
        action === "list" ? rows.map(view) : view(lookup(rows, name, command)),
      )
    return true
  }
  if (
    action === "use" &&
    command === "endpoint" &&
    args.flags.default !== true
  ) {
    if (!link)
      throw new Error("No linked project; run bql link or use --default")
    const r = await store.read(),
      s = selectRecords(r, { ...selection, endpoint: name }, link)
    if (s.org.id !== link.org || s.project!.id !== link.project)
      throw new Error(
        "Selection differs from linked project; run bql link to change projects",
      )
    await writeLink(link.directory, {
      version: 1,
      org: link.org,
      project: link.project,
      endpoint: s.endpoint!.id,
    })
    output({ endpoint: s.endpoint!.name })
    return true
  }
  const saved: Record<string, string> = {}
  if (command === "endpoint" && ["add", "update"].includes(action)) {
    if (args.flags.token || args.flags["vercel-bypass"])
      throw new Error(
        "Use --token-env / --vercel-bypass-env or hidden --prompt-* options to save credentials",
      )
    for (const field of [
      "token",
      "vercel-bypass",
      "bus-token",
      "bus-vercel-bypass",
    ]) {
      const modes = [
        get(`${field}-env`),
        args.flags[`prompt-${field}`],
        args.flags[`clear-${field}`],
      ].filter(Boolean)
      if (modes.length > 1)
        throw new Error(`Choose only one credential source for ${field}`)
      if (args.flags[`prompt-${field}`]) {
        const value = await promptLine(field, true)
        if (!value) throw new Error("Credential cannot be empty")
        saved[field] = value
      }
    }
  }
  let result: unknown
  await store.mutate((r, c) => {
    const rows = records(r)
    if (action === "add") {
      slug(name!)
      if (rows.some((row) => row.name === name))
        throw new Error(`A ${command} with that name already exists`)
      const base = { id: crypto.randomUUID(), name: name! }
      if (command === "org") rows.push({ ...base, projects: [] })
      else if (command === "project") rows.push({ ...base, endpoints: [] })
      else {
        const endpoint: Endpoint = {
          ...base,
          database: { url: serviceUrl(get("url") ?? "") },
        }
        configureEndpoint(endpoint, c)
        rows.push(endpoint)
        const p = selectRecords(r, selection, link, "project").project!
        if (rows.length === 1) p.defaultEndpoint = endpoint.id
      }
      result = view(rows.at(-1)!)
    } else {
      const record = lookup(rows, name, command)
      if (action === "remove") {
        const children =
          "projects" in record
            ? record.projects
            : "endpoints" in record
              ? record.endpoints
              : []
        if (children.length && args.flags.recursive !== true)
          throw new Error(
            "Nonempty record; use --recursive to remove its local connection records",
          )
        rows.splice(rows.indexOf(record), 1)
        result = { removed: record.name }
      } else if (action === "update") {
        const rename = get("name")
        if (rename) {
          slug(rename)
          if (rows.some((row) => row !== record && row.name === rename))
            throw new Error("Duplicate sibling name")
          record.name = rename
        }
        if (command === "endpoint") configureEndpoint(record as Endpoint, c)
        result = view(record)
      } else if (action === "use") {
        if (command === "org") throw new Error("Use bql switch <org>")
        const selected = selectRecords(
          r,
          selection,
          link,
          command === "project" ? "org" : "project",
        )
        if (command === "project")
          r.selection = { org: selected.org.id, project: record.id }
        else selected.project!.defaultEndpoint = record.id
        result = { selected: record.name }
      }
    }
    cleanCredentials(r, c)
  })
  output(result)
  return true

  function configureEndpoint(endpoint: Endpoint, c: Credentials) {
    for (const service of ["database", "bus"] as const) {
      const prefix = service === "bus" ? "bus-" : "",
        url = get(service === "bus" ? "bus-url" : "url")
      if (service === "bus" && args.flags["clear-bus"]) {
        if (url) throw new Error("Cannot combine --clear-bus and --bus-url")
        delete endpoint.bus
        continue
      }
      let connection = endpoint[service]
      if (url) {
        const normalized = serviceUrl(url)
        if (!connection || connection.url !== normalized)
          connection = { url: normalized }
      }
      const credentialFields = [`${prefix}token`, `${prefix}vercel-bypass`]
      const hasCredential = credentialFields.some(
        (field) =>
          get(`${field}-env`) || saved[field] || args.flags[`clear-${field}`],
      )
      if (!connection) {
        if (hasCredential)
          throw new Error(`Configure a ${service} URL before credentials`)
        continue
      }
      for (const [index, field] of credentialFields.entries()) {
        const property = index === 0 ? "token" : "bypass",
          env = get(`${field}-env`)
        let ref: Credential | undefined
        if (env) ref = { env }
        if (saved[field]) {
          const key = crypto.randomUUID()
          c[key] = saved[field]!
          ref = { key }
        }
        if (ref) connection[property] = ref
        if (args.flags[`clear-${field}`]) delete connection[property]
      }
      endpoint[service] = connection
    }
  }
}
