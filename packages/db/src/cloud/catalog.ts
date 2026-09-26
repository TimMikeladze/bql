import fs from "node:fs"
import path from "node:path"
import { Catalog, type AckWithoutReplicas, type TokenRow } from "../tenant/catalog.ts"
import { assertValidName } from "../tenant/tenant.ts"
import { CloudFormatError, decodeJSON, encodeJSON, record } from "./format.ts"

/** Logical metadata only. Physical positions come from committed database heads;
 * signing keys come from stable provider secrets, never this document. */
export interface CloudTenant {
  name: string
  incarnation: string
  createdAtMs: number
  deletedAtMs: number | null
  pageSize: number
  quotaBytes: number
  foreignKeys: boolean | null
  ackWithoutReplicas: AckWithoutReplicas | null
}
export interface CloudCatalog {
  formatVersion: 1
  settings: { foreignKeys: boolean }
  tenants: CloudTenant[]
  tokens: TokenRow[]
}
export function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CloudFormatError("Expected nonnegative safe integer")
  return value as number
}
export function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new CloudFormatError("Invalid identity")
  return value
}
export function pageSize(value: unknown): number {
  const size = nonnegative(value)
  if (size < 512 || size > 65536 || (size & (size - 1)) !== 0) throw new CloudFormatError("Invalid SQLite page size")
  return size
}
function nullableTime(value: unknown) { return value === null ? null : nonnegative(value) }
export function decodeCatalog(body: Uint8Array): CloudCatalog {
  const data = record(decodeJSON(body))
  const settings = record(data.settings)
  if (data.formatVersion !== 1 || typeof settings.foreignKeys !== "boolean" || !Array.isArray(data.tenants) || !Array.isArray(data.tokens)) throw new CloudFormatError("Invalid cloud catalog")
  const incarnations = new Set<string>()
  const live = new Set<string>()
  const tenants = data.tenants.map((raw): CloudTenant => {
    const row = record(raw)
    const name = identity(row.name)
    assertValidName(name)
    const incarnation = identity(row.incarnation)
    const deletedAtMs = nullableTime(row.deletedAtMs)
    if (incarnations.has(incarnation) || (deletedAtMs === null && live.has(name))) throw new CloudFormatError("Duplicate tenant identity")
    incarnations.add(incarnation)
    if (deletedAtMs === null) live.add(name)
    if (row.foreignKeys !== null && typeof row.foreignKeys !== "boolean") throw new CloudFormatError("Invalid foreign key setting")
    if (row.ackWithoutReplicas !== null && row.ackWithoutReplicas !== "error" && row.ackWithoutReplicas !== "allow") throw new CloudFormatError("Invalid acknowledgement setting")
    return { name, incarnation, createdAtMs: nonnegative(row.createdAtMs), deletedAtMs, pageSize: pageSize(row.pageSize), quotaBytes: nonnegative(row.quotaBytes), foreignKeys: row.foreignKeys, ackWithoutReplicas: row.ackWithoutReplicas }
  })
  const seenTokens = new Set<string>()
  const tokens = data.tokens.map(raw => {
    const row = record(raw)
    const jti = identity(row.jti)
    if (seenTokens.has(jti)) throw new CloudFormatError("Duplicate token identity")
    seenTokens.add(jti)
    return { jti, createdAtMs: nonnegative(row.createdAtMs), expiresAtSec: nullableTime(row.expiresAtSec), revokedAtMs: nullableTime(row.revokedAtMs), claims: row.claims ?? null }
  })
  return { formatVersion: 1, settings: { foreignKeys: settings.foreignKeys }, tenants, tokens }
}
export function encodeCatalog(catalog: CloudCatalog): Uint8Array {
  // Reconstruct only allowed fields so local paths/keys cannot leak via extra properties.
  return encodeJSON(decodeCatalog(encodeJSON(catalog)))
}

/** Install only in a new staging directory. Caller installs the directory after
 * database restore succeeds; the authoritative document retains all tombstones. */
export function installCatalog(document: CloudCatalog, dir: string): Catalog {
  const data = decodeCatalog(encodeCatalog(document))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "_system.db")
  const fd = fs.openSync(file, "wx", 0o600)
  fs.closeSync(fd)
  let catalog: Catalog | undefined
  try {
    catalog = Catalog.open(dir)
    // Local catalog has one row/name. Preserve the latest tombstone unless a live
    // incarnation exists; history remains in the immutable cloud document.
    const selected = new Map<string, CloudTenant>()
    for (const tenant of data.tenants) {
      const old = selected.get(tenant.name)
      if (!old || (old.deletedAtMs !== null && (tenant.deletedAtMs === null || tenant.createdAtMs > old.createdAtMs))) selected.set(tenant.name, tenant)
    }
    for (const tenant of selected.values()) {
      catalog.createTenant(tenant)
      if (tenant.deletedAtMs !== null) catalog.deleteTenant(tenant.name, tenant.deletedAtMs)
    }
    for (const token of data.tokens) {
      catalog.putToken(token)
      if (token.revokedAtMs !== null) catalog.revokeToken(token.jti, token.revokedAtMs)
    }
    return catalog
  } catch (error) {
    catalog?.close()
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true })
    throw error
  }
}
