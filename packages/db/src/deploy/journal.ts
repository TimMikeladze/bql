import { Database } from "bun:sqlite"
import { chmod, mkdir, open } from "node:fs/promises"
import { join } from "node:path"
import { AuthKeys } from "../server/auth.ts"
import { atomicJson, readJson } from "../context/store.ts"
import { serviceUrl } from "../context/model.ts"
import { validateDeployment, type DeploymentConfig } from "./config.ts"
import type { DeploymentProfile } from "./profiles.ts"

export interface DeploymentState {
  version: 1
  config: DeploymentConfig
  resources: Record<string, string>
  steps: Record<string, { status: "started" | "complete" }>
  endpoint?: string
  profile?: DeploymentProfile
  scope?: string
  currentRelease?: string
  pendingRelease?: string
}

const fingerprint = (config: DeploymentConfig) => JSON.stringify([config.version, config.provider, config.name, config.deploymentId, config.environment, config.region, config.scope ?? null])
const ownName = (name: string) => {
  if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name)) throw new Error("Invalid deployment checkpoint name")
}
const releaseName = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(value)) throw new Error("Invalid deployment release identity")
}

export class DeploymentJournal {
  constructor(readonly directory: string, readonly state: DeploymentState, readonly secrets: Record<string, string>) {}
  async save() { await atomicJson(join(this.directory, "state.json"), this.state) }
  async setSecrets(values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof value !== "string" || !value || /[\r\n\0]/.test(value)) throw new Error("Invalid deployment secret")
    }
    await atomicJson(join(this.directory, "secrets.json"), { ...this.secrets, ...values })
    Object.assign(this.secrets, values)
  }
  async recordResource(name: string, id: string) {
    ownName(name)
    if (!id || id.length > 512 || /[\r\n\0]/.test(id)) throw new Error("Invalid deployment resource ID")
    if (this.state.resources[name] && this.state.resources[name] !== id) throw new Error("Refusing to replace an owned deployment resource")
    this.state.resources[name] = id
    await this.save()
  }
  async recordEndpoint(url: string, profile?: DeploymentProfile) {
    this.state.endpoint = serviceUrl(url)
    if (profile) this.state.profile = profile
    await this.save()
  }
  /** A started step runs its provider reconciliation again; completed steps are not repeated. */
  async step(name: string, action: () => Promise<void>) {
    ownName(name)
    if (this.state.steps[name]?.status === "complete") return
    this.state.steps[name] = { status: "started" }
    await this.save()
    await action()
    this.state.steps[name] = { status: "complete" }
    await this.save()
  }
  /** Historical success is not the current remote release. A pending publish
   * can have succeeded remotely even if its local acknowledgement was lost. */
  async publishRelease(release: string, action: () => Promise<void>) {
    releaseName(release)
    if (this.state.currentRelease === release && !this.state.pendingRelease) return
    const name = `release_${release}`
    this.state.pendingRelease = release
    this.state.steps[name] = { status: "started" }
    await this.save()
    await action()
    this.state.currentRelease = release
    delete this.state.pendingRelease
    this.state.steps[name] = { status: "complete" }
    await this.save()
  }
}

function stateFrom(value: unknown, config: DeploymentConfig): DeploymentState {
  if (!value || typeof value !== "object") throw new Error("Invalid deployment journal")
  const state = value as DeploymentState
  if (state.version !== 1 || !state.config || !state.resources || !state.steps || Array.isArray(state.resources) || Array.isArray(state.steps)) throw new Error("Invalid deployment journal")
  validateDeployment(state.config)
  if (fingerprint(state.config) !== fingerprint(config)) throw new Error("Deployment configuration changed after provisioning began; restore it or initialize a separate deployment")
  for (const [name, id] of Object.entries(state.resources)) { ownName(name); if (typeof id !== "string" || !id) throw new Error("Invalid deployment resource") }
  for (const [name, step] of Object.entries(state.steps)) { ownName(name); if (!step || !["started", "complete"].includes(step.status)) throw new Error("Invalid deployment checkpoint") }
  if (state.endpoint) serviceUrl(state.endpoint)
  for (const release of [state.currentRelease, state.pendingRelease]) if (release !== undefined) {
    if (typeof release !== "string") throw new Error("Invalid deployment release identity")
    releaseName(release)
  }
  return state
}

export const journalDirectory = (config: DeploymentConfig, configDir: string) => join(configDir, "deployments", config.deploymentId)

export async function readDeploymentState(config: DeploymentConfig, configDir: string): Promise<DeploymentState | undefined> {
  validateDeployment(config)
  const raw = await readJson(join(journalDirectory(config, configDir), "state.json"))
  return raw === undefined ? undefined : stateFrom(raw, config)
}

/** SQLite is only an OS-released workstation lock; deployed data uses the pinned database engine. */
export async function withDeploymentJournal<T>(config: DeploymentConfig, configDir: string, run: (journal: DeploymentJournal) => Promise<T>): Promise<T> {
  validateDeployment(config)
  const directory = journalDirectory(config, configDir)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const lockPath = join(directory, "lock.sqlite")
  const file = await open(lockPath, "a", 0o600)
  await file.close()
  const lock = new Database(lockPath)
  try {
    try { lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE") }
    catch { throw new Error("A deployment apply is already running for this deployment") }
    const state = await readDeploymentState(config, configDir) ?? { version: 1 as const, config: { ...config }, resources: {}, steps: {} }
    const rawSecrets = await readJson(join(directory, "secrets.json"))
    const secrets = rawSecrets ?? {
      BQL_ADMIN_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
      BQL_JWT_ED25519: Buffer.from(await (await AuthKeys.generate()).exportPkcs8()).toString("base64"),
    }
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets) || !Object.values(secrets).every(v => typeof v === "string") || !(secrets as Record<string, string>).BQL_ADMIN_KEY || !(secrets as Record<string, string>).BQL_JWT_ED25519) throw new Error("Invalid saved deployment secrets; refusing to rotate them automatically")
    // If remote resources exist, absence of credentials cannot safely mean a fresh deployment.
    if (rawSecrets === undefined && (Object.keys(state.resources).length || Object.keys(state.steps).length)) throw new Error("Saved deployment secrets are missing; recover them before applying")
    const journal = new DeploymentJournal(directory, state, secrets as Record<string, string>)
    if (rawSecrets === undefined) await journal.setSecrets(journal.secrets)
    await journal.save()
    return await run(journal)
  } finally { lock.close() }
}
