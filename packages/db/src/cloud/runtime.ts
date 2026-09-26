import fs from "node:fs"
import path from "node:path"
import type { ObjectStore } from "../storage/object-store.ts"
import type { ServerConfig } from "../server/config.ts"
import { createRuntime } from "../server/app.ts"
import type { ServerRuntime } from "../server/runtime.ts"
import { requireScope } from "../server/auth.ts"
import * as routes from "../server/routes.ts"
import { tenantDir } from "../tenant/tenant.ts"
import { BqlError } from "../server/errors.ts"
import { captureCatalog, namespaceStore, readCloudState, stageDatabase, type CloudState } from "./state.ts"
import { encodeCatalog, installCatalog, type CloudCatalog } from "./catalog.ts"
import { encodeJSON, sha256, writeObject } from "./format.ts"
import { deploymentPrefix, initializeRoot, readRoot } from "./root.ts"
import { publishCommit, REQUEST_RETENTION_MS, resolveRequest } from "./commit.ts"
import { restoreCloudDatabase } from "./restore.ts"
import { CloudError } from "./errors.ts"
import { cloudStatementBoundary } from "./sql.ts"

export const CLOUD_OPERATIONS = ["query", "batch", "createDatabase", "listDatabases", "statDatabase", "updateDatabase", "deleteDatabase", "mintToken", "revokeToken"] as const
export type CloudOperationKind = typeof CLOUD_OPERATIONS[number]
export interface CloudOperation { kind: CloudOperationKind; db?: string; jti?: string; body?: Record<string, unknown> }
export interface CloudRequestContext { request: Request; readBody?: (signal: AbortSignal) => Promise<Record<string, unknown>> }
export interface CloudRuntimeOptions { store: ObjectStore; deploymentId: string; config: ServerConfig; maxPending?: number; requestTimeoutMs?: number }
const HANDLERS: Record<CloudOperationKind, routes.Handler> = {
  query: routes.query, batch: routes.batch, createDatabase: routes.createDb,
  listDatabases: routes.listDbs, statDatabase: routes.statDb, updateDatabase: routes.updateDb,
  deleteDatabase: routes.deleteDb, mintToken: routes.mintToken, revokeToken: routes.revokeToken,
}
export const CLOUD_CAPABILITIES = { storageMode: "object", durability: "remote", requestRetentionMs: REQUEST_RETENTION_MS, operations: CLOUD_OPERATIONS, interactiveTransactions: false, realtime: false, replication: false }
function validateConfiguration(config: ServerConfig) {
  if (!config.auth.adminKey || !config.auth.jwtKey) throw new CloudError("CLOUD_CONFIG", "Cloud mode requires stable admin and JWT signing keys")
  if (config.server.workers !== 1 || config.cluster.enabled || config.replication.role !== "primary" || config.replication.secret || config.s3.enabled) throw new CloudError("CLOUD_UNSUPPORTED", "Cloud mode requires one worker, no replication/cluster, and no asynchronous backup shipper")
}
export async function initializeCloud(store: ObjectStore, deploymentId: string, config: ServerConfig): Promise<void> {
  validateConfiguration(config)
  const scoped = namespaceStore(store, deploymentId)
  const prefix = `${deploymentPrefix(deploymentId)}objects/${crypto.randomUUID()}`
  const catalog: CloudCatalog = { formatVersion: 1, settings: { foreignKeys: config.sqlite.foreignKeys }, tenants: [], tokens: [] }
  const catalogRef = await writeObject(scoped, `${prefix}/catalog.json`, encodeCatalog(catalog))
  const headsRef = await writeObject(scoped, `${prefix}/heads.json`, encodeJSON({ formatVersion: 1, heads: {} }))
  await initializeRoot(scoped, deploymentId, { catalogRef, headsRef })
}
interface SavedResponse { status: number; body: string; headers: [string, string][] }

async function beforeDeadline<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try { return await Promise.race([work(), cancelled]) }
  finally { signal.removeEventListener("abort", abort) }
}


/** One instance-local admission gate surrounds origin refresh, authentication,
 * local execution, immutable uploads, publication and response release. No
 * caller can reach the tentative ServerRuntime or install arbitrary callbacks. */
export class CloudRuntime {
  readonly #options: CloudRuntimeOptions
  readonly #store: ObjectStore
  #state: CloudState | null = null
  #local: ServerRuntime | null = null
  #dir: string | null = null
  #loaded = new Set<string>()
  #tail: Promise<void> = Promise.resolve()
  #pending = 0
  #closing = false
  #shutdown = new AbortController()
  #phase: "starting" | "restoring" | "ready" | "draining" | "stopped" | "failed" = "starting"

  private constructor(options: CloudRuntimeOptions) {
    validateConfiguration(options.config)
    this.#options = options
    this.#store = namespaceStore(options.store, options.deploymentId)
  }
  static async open(options: CloudRuntimeOptions): Promise<CloudRuntime> {
    const runtime = new CloudRuntime(options)
    try { await runtime.#refresh(); return runtime }
    catch (error) { runtime.#discard(); runtime.#phase = "failed"; throw error }
  }
  get phase() { return this.#phase }
  get capabilities() { return CLOUD_CAPABILITIES }

  async run(context: CloudRequestContext, operation: CloudOperation): Promise<Response> {
    if (this.#closing) throw new CloudError("CLOUD_DRAINING", "Cloud runtime is draining")
    if (!CLOUD_OPERATIONS.includes(operation.kind)) throw new CloudError("CLOUD_UNSUPPORTED", "Operation is not supported in cloud mode")
    if (this.#pending >= (this.#options.maxPending ?? 64)) throw new CloudError("CLOUD_BACKPRESSURE", "Cloud request queue is full")
    this.#pending++
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    const signal = AbortSignal.any([context.request.signal, this.#shutdown.signal, AbortSignal.timeout(this.#options.requestTimeoutMs ?? 30000)])
    let requestId: string | undefined
    try {
      await previous
      signal.throwIfAborted()
      await this.#refresh(signal)
      const local = this.#local!
      const state = this.#state!
      const principal = await local.auth.authenticate(context.request)
      if (operation.db) requireScope(principal, operation.db, "ro")
      if (!["query", "batch"].includes(operation.kind) && principal.kind !== "admin") throw BqlError.notAuthorized("this route needs the admin key")
      const body = operation.body ?? (context.readBody ? await beforeDeadline(signal, () => context.readBody!(signal)) : {})
      signal.throwIfAborted()
      const ack = body.ack ?? context.request.headers.get("bql-ack")
      if (ack === "replica" || ack === "quorum" || (operation.kind === "batch" && body.atomic === false) || (operation.kind === "createDatabase" && body.from !== undefined)) throw new CloudError("CLOUD_UNSUPPORTED", "Requested operation is not supported in cloud mode")
      const key = context.request.headers.get("idempotency-key") ?? crypto.randomUUID()
      requestId = key
      const identity = { principal: principal.kind === "admin" ? "admin" : `token:${principal.claims.jti}`, key, digest: sha256(encodeJSON({ ...operation, body, ack })) }
      const resolution = await resolveRequest(this.#store, this.#options.deploymentId, identity, () => true, Date.now(), signal)
      if (resolution.status === "unknown") throw new CloudError("COMMIT_UNKNOWN", "Cannot resolve the request against remote storage")
      if (resolution.status === "committed") {
        const saved = resolution.result as SavedResponse
        return new Response(saved.body, { status: saved.status, headers: [...saved.headers, ["BQL-Revision", resolution.revision], ["BQL-Request-ID", key]] })
      }
      const expectedGeneration = context.request.headers.get("bql-min-generation")
      if (operation.db && expectedGeneration && state.heads[operation.db]?.incarnation !== expectedGeneration) throw new CloudError("GENERATION_CHANGED", "The database was replaced; explicitly read the current generation before continuing")
      const minTxid = context.request.headers.get("bql-min-txid")
      if (operation.db && minTxid !== null) {
        if (!/^\d+$/.test(minTxid)) throw BqlError.badRequest("BQL-Min-Txid must be a nonnegative integer")
        const have = state.heads[operation.db]?.txid ?? "0"
        if (BigInt(minTxid) > BigInt(have)) throw new CloudError("TXID_NOT_AVAILABLE", "Requested position is not available in the committed database generation")
      }
      if (operation.db) await this.#ensureDatabase(operation.db, signal)
      const params: Record<string, string> = {}
      if (operation.db) params.db = operation.db
      if (operation.jti) params.jti = operation.jti
      const ctx: routes.RouteContext = { runtime: local, request: new Request(context.request.url, { method: context.request.method, headers: context.request.headers, signal }), url: new URL(context.request.url), params, body: async () => body, server: { timeout() {} } as routes.RouteContext["server"] }
      const response = await HANDLERS[operation.kind](ctx)
      if (!response.ok) { this.#discard(); return response }
      const responseBody = await response.text()
      if (ctx.txid !== undefined) response.headers.set("BQL-Txid", String(ctx.txid))
      const catalog = captureCatalog(local.registry.catalog, state.catalog)
      const heads: CloudState["heads"] = Object.assign(Object.create(null), state.heads)
      const liveNames = new Set(catalog.tenants.filter(t => t.deletedAtMs === null).map(t => t.name))
      let changed = sha256(encodeCatalog(catalog)) !== sha256(encodeCatalog(state.catalog))
      for (const name of Object.keys(heads)) if (!liveNames.has(name)) { delete heads[name]; changed = true }
      const commitId = crypto.randomUUID()
      const prefix = `${deploymentPrefix(this.#options.deploymentId)}objects/${commitId}`
      for (const tenant of catalog.tenants) {
        if (tenant.deletedAtMs !== null || !local.registry.openNames.includes(tenant.name)) continue
        const current = local.tenant(tenant.name)
        const old = heads[tenant.name]
        if (!old || old.incarnation !== tenant.incarnation || old.txid !== String(current.txid)) {
          heads[tenant.name] = await stageDatabase(this.#store, current, tenant.incarnation, `${prefix}/db/${tenant.incarnation}`, old?.incarnation === tenant.incarnation ? old : undefined, signal)
          this.#loaded.add(tenant.name)
          changed = true
        }
      }
      response.headers.set("BQL-Durability", "remote")
      if (operation.db && heads[operation.db]) response.headers.set("BQL-Generation", heads[operation.db]!.incarnation)
      if (changed || context.request.headers.has("idempotency-key")) {
        const catalogRef = await writeObject(this.#store, `${prefix}/catalog.json`, encodeCatalog(catalog), signal)
        const headsRef = await writeObject(this.#store, `${prefix}/heads.json`, encodeJSON({ formatVersion: 1, heads }), signal)
        const saved: SavedResponse = { status: response.status, body: responseBody, headers: [...response.headers] }
        const resultRef = await writeObject(this.#store, `${prefix}/response.json`, encodeJSON(saved), signal)
        const published = await publishCommit(this.#store, state, { commitId, catalogRef, headsRef, request: { ...identity, resultRef, expiresAt: Date.now() + REQUEST_RETENTION_MS } }, signal)
        this.#state = { ...published, catalog, heads }
      }
      response.headers.set("BQL-Revision", this.#state!.root.revision)
      response.headers.set("BQL-Request-ID", key)
      response.headers.set("BQL-Durability", "remote")
      if (operation.db && heads[operation.db]) response.headers.set("BQL-Generation", heads[operation.db]!.incarnation)
      return new Response(responseBody, { status: response.status, headers: response.headers })
    } catch (error) {
      this.#discard()
      if (error instanceof CloudError && error.code === "COMMIT_UNKNOWN") throw new CloudError(error.code, error.message, requestId)
      if (signal.aborted) throw new CloudError("CLOUD_TIMEOUT", "Cloud request cancelled or deadline exceeded")
      throw error
    } finally { this.#pending--; release() }
  }

  async close(deadline = Date.now() + 30000): Promise<void> {
    if (this.#phase === "stopped") return
    this.#closing = true
    this.#phase = "draining"
    const timer = setTimeout(() => this.#shutdown.abort(), Math.max(0, deadline - Date.now()))
    try { await this.#tail }
    finally { clearTimeout(timer); this.#discard(); this.#phase = "stopped" }
  }
  async #refresh(signal?: AbortSignal) {
    const base = await readRoot(this.#store, this.#options.deploymentId, signal)
    if (this.#local && this.#state?.version === base.version) return
    this.#discard()
    this.#phase = "restoring"
    const state = await readCloudState(this.#store, base, signal)
    fs.mkdirSync(this.#options.config.data.dir, { recursive: true })
    this.#dir = fs.mkdtempSync(path.join(this.#options.config.data.dir, "cloud-cache-"))
    const catalog = installCatalog(state.catalog, this.#dir)
    try {
      for (const [name, head] of Object.entries(state.heads)) catalog.savePosition(name, { txid: BigInt(head.txid), epoch: 0, checksum: 0n, dbSizePages: 0, wal: { salt1: 0, salt2: 0, frame: 0 } }, false)
    } finally { catalog.close() }
    const config: ServerConfig = { ...this.#options.config, data: { ...this.#options.config.data, storageMode: "disk", dir: this.#dir }, sqlite: { ...this.#options.config.sqlite, foreignKeys: state.catalog.settings.foreignKeys }, durability: { ...this.#options.config.durability, retention: "0", sweepIntervalMs: 0 }, limits: { ...this.#options.config.limits, groupCommit: false } }
    this.#local = (await createRuntime(config, { statementBoundary: cloudStatementBoundary })).runtime
    this.#state = state
    if (!this.#closing) this.#phase = "ready"
  }
  async #ensureDatabase(name: string, signal?: AbortSignal) {
    if (this.#loaded.has(name)) return
    const head = this.#state!.heads[name]
    if (!head) return // Handler will produce the ordinary authorized DB_NOT_FOUND.
    const restored = await restoreCloudDatabase(this.#store, head, path.join(this.#dir!, "_restore"), signal)
    const target = tenantDir(this.#dir!, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(restored.dir, target)
    this.#local!.registry.catalog.savePosition(name, { txid: restored.txid, epoch: restored.epoch, checksum: restored.checksum, dbSizePages: restored.pages, wal: { salt1: 0, salt2: 0, frame: 0 } }, true)
    this.#loaded.add(name)
  }
  #discard() {
    if (!this.#closing) this.#phase = "restoring"
    this.#local?.close()
    this.#local = null
    this.#state = null
    this.#loaded.clear()
    if (this.#dir) fs.rmSync(this.#dir, { recursive: true, force: true })
    this.#dir = null
  }
}
