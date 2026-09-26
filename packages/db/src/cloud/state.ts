import fs from "node:fs"
import type { ObjectStore } from "../storage/object-store.ts"
import { sqlite } from "../sqlite/index.ts"
import type { Catalog } from "../tenant/catalog.ts"
import type { Tenant } from "../tenant/tenant.ts"
import { encode, decodeHeader, RECORD_HEADER_SIZE } from "../wal/record.ts"
import { decodeCatalog, encodeCatalog, identity, type CloudCatalog } from "./catalog.ts"
import { CloudFormatError, decimalU64, decodeJSON, encodeJSON, objectRef, readObject, record, writeObject, type DatabaseHead } from "./format.ts"
import { deploymentPrefix, MAX_CLOUD_METADATA_BYTES, scopedRef, type VersionedRoot } from "./root.ts"
import { decodeLogIndex, inspectCloudDatabase, type RestoreLimits, type CloudSnapshot, type CloudLogIndex } from "./restore.ts"

/** Defense at the transport boundary, including transitive snapshot/log refs.
 * Native provider credentials should also be isolated per environment. */
export function namespaceStore(store: ObjectStore, deploymentId: string): ObjectStore {
  const prefix = deploymentPrefix(deploymentId)
  function check(key: string) {
    objectRef({ key, sha256: "0".repeat(64), bytes: 0 })
    if (!key.startsWith(prefix)) throw new CloudFormatError("Object key crosses deployment namespace")
  }
  return {
    async get(key, signal) { check(key); return store.get(key, signal) },
    async create(key, body, signal) { check(key); return store.create(key, body, signal) },
    async replace(key, version, body, signal) { check(key); return store.replace(key, version, body, signal) },
  }
}
export interface CloudState extends VersionedRoot { catalog: CloudCatalog; heads: Record<string, DatabaseHead> }
export async function readCloudState(store: ObjectStore, base: VersionedRoot, signal?: AbortSignal): Promise<CloudState> {
  const id = base.root.deploymentId
  const catalog = decodeCatalog(await readObject(store, scopedRef(id, base.root.catalogRef), { maxBytes: MAX_CLOUD_METADATA_BYTES, signal }))
  const document = record(decodeJSON(await readObject(store, scopedRef(id, base.root.headsRef), { maxBytes: MAX_CLOUD_METADATA_BYTES, signal })))
  if (document.formatVersion !== 1) throw new CloudFormatError("Incompatible database head inventory")
  const rawHeads = record(document.heads)
  const heads: Record<string, DatabaseHead> = Object.create(null)
  const live = catalog.tenants.filter(t => t.deletedAtMs === null)
  if (Object.keys(rawHeads).length !== live.length) throw new CloudFormatError("Database head inventory differs from catalog")
  for (const tenant of live) {
    const raw = record(rawHeads[tenant.name])
    if (raw.incarnation !== tenant.incarnation) throw new CloudFormatError("Database head incarnation differs from catalog")
    heads[tenant.name] = { incarnation: tenant.incarnation, txid: decimalU64(raw.txid), snapshotRef: scopedRef(id, objectRef(raw.snapshotRef)), logIndexRef: scopedRef(id, objectRef(raw.logIndexRef)) }
  }
  return { ...base, catalog, heads }
}

/** Only logical metadata is captured; machine paths, keys, WAL coordinates and
 * local maintenance state do not belong in the authoritative cloud catalog. */
export function captureCatalog(catalog: Catalog, previous: CloudCatalog): CloudCatalog {
  const tenants = previous.tenants.map(tenant => ({ ...tenant }))
  for (const row of catalog.listTenants({ includeDeleted: true })) {
    let index = tenants.findIndex(tenant => tenant.name === row.name && tenant.deletedAtMs === null)
    if (index < 0) index = tenants.findIndex(tenant => tenant.name === row.name && tenant.createdAtMs === row.createdAtMs && tenant.deletedAtMs === row.deletedAtMs)
    const incarnation = index < 0 ? crypto.randomUUID() : tenants[index]!.incarnation
    const tenant = { name: row.name, incarnation, createdAtMs: row.createdAtMs, deletedAtMs: row.deletedAtMs, pageSize: row.pageSize, quotaBytes: row.quotaBytes, foreignKeys: row.foreignKeys, ackWithoutReplicas: row.ackWithoutReplicas }
    if (index < 0) tenants.push(tenant)
    else tenants[index] = tenant
  }
  const tokens = catalog.db.prepare("select jti from tokens order by jti").all().map(row => catalog.getToken(String(row.jti))!)
  return decodeCatalog(encodeCatalog({ formatVersion: 1, settings: previous.settings, tenants, tokens }))
}

/** Caller owns the cloud request gate. Reuse the committed base snapshot and
 * append new transaction records, compacting into a snapshot after bounded log
 * growth. All keys are attempt-qualified and create-only. */
export async function stageDatabase(store: ObjectStore, tenant: Tenant, incarnation: string, attemptPrefix: string, previous?: DatabaseHead, signal?: AbortSignal, limits: RestoreLimits = {}): Promise<DatabaseHead> {
  identity(incarnation)
  if (previous && (previous.incarnation !== incarnation || BigInt(previous.txid) > tenant.txid)) throw new CloudFormatError("Local database is behind or from another incarnation")
  if (previous && BigInt(previous.txid) === tenant.txid) return previous
  let index: CloudLogIndex = { formatVersion: 1, incarnation, segments: [] }
  if (previous) index = decodeLogIndex(await readObject(store, previous.logIndexRef, { maxBytes: MAX_CLOUD_METADATA_BYTES, signal }), incarnation)
  if (!previous || index.segments.length >= 128 || index.segments.reduce((sum, segment) => sum + segment.plainBytes, 0) >= 8 * 1024 * 1024) {
    const snapshot = await tenant.snapshot()
    if (signal?.aborted) throw new CloudFormatError("Snapshot publication aborted")
    const dataRef = await writeObject(store, `${attemptPrefix}/snapshot.db`, new Uint8Array(fs.readFileSync(snapshot.path)), signal)
    const descriptor: CloudSnapshot = { formatVersion: 1, engine: sqlite().version, incarnation, txid: snapshot.txid, epoch: snapshot.epoch, pages: snapshot.pages, pageSize: snapshot.pageSize, checksum: snapshot.checksum, dataRef }
    const snapshotRef = await writeObject(store, `${attemptPrefix}/snapshot.json`, encodeJSON(descriptor), signal)
    const logIndexRef = await writeObject(store, `${attemptPrefix}/logs.json`, encodeJSON({ formatVersion: 1, incarnation, segments: [] }), signal)
    const head = { incarnation, txid: snapshot.txid, snapshotRef, logIndexRef }
    await inspectCloudDatabase(store, head, signal, limits)
    return head
  }
  const segments = [...index.segments]
  let next = BigInt(previous.txid) + 1n
  const target = tenant.txid
  for (const transaction of tenant.log.iterate(next)) {
    if (transaction.txid > target) break
    if (transaction.txid !== next) throw new CloudFormatError("Local log has a gap after committed head")
    const body = encode(transaction)
    const header = decodeHeader(body)!.header
    const ref = await writeObject(store, `${attemptPrefix}/transaction-${next}`, body, signal)
    segments.push({ ...ref, startTxid: String(next), endTxid: String(next), records: 1, plainBytes: RECORD_HEADER_SIZE + header.bodyPlainLength, maxDatabaseBytes: header.commitSizePages * header.pageSize })
    next++
  }
  if (next - 1n !== target) throw new CloudFormatError("Local log does not reach candidate position")
  const logIndexRef = await writeObject(store, `${attemptPrefix}/logs.json`, encodeJSON({ formatVersion: 1, incarnation, segments }), signal)
  const head = { incarnation, txid: String(target), snapshotRef: previous.snapshotRef, logIndexRef }
  await inspectCloudDatabase(store, head, signal, limits)
  return head
}
