import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { captureCatalog, readCloudState, stageDatabase, namespaceStore } from "../../src/cloud/state.ts"
import { restoreCloudDatabase } from "../../src/cloud/restore.ts"
import { initializeRoot } from "../../src/cloud/root.ts"
import { encodeCatalog, type CloudCatalog } from "../../src/cloud/catalog.ts"
import { decodeJSON, encodeJSON, readObject, writeObject } from "../../src/cloud/format.ts"
import { FakeObjectStore } from "./fake-store.ts"
import { cleanup, openRegistry, openTenant, writeRows, dumpFile, tempDir } from "../storage/harness.ts"

afterEach(cleanup)
const empty: CloudCatalog = { formatVersion: 1, settings: { foreignKeys: true }, tenants: [], tokens: [] }

test("catalog capture preserves incarnations across writes, and history across delete/recreate", async () => {
  const registry = openRegistry()
  const tenant = await openTenant(registry)
  registry.catalog.putToken({ jti: "test-token", claims: { sub: "user" }, createdAtMs: 1 })
  registry.catalog.revokeToken("test-token", 2)
  const first = captureCatalog(registry.catalog, empty)
  const incarnation = first.tenants[0]!.incarnation
  writeRows(tenant, 1, 1)
  expect(captureCatalog(registry.catalog, first).tenants[0]!.incarnation).toBe(incarnation)
  registry.catalog.deleteTenant("acme", 3)
  const deleted = captureCatalog(registry.catalog, first)
  registry.catalog.createTenant({ name: "acme", pageSize: 4096, quotaBytes: 1234 })
  const recreated = captureCatalog(registry.catalog, deleted)
  expect(recreated.tenants).toHaveLength(2)
  expect(recreated.tenants.find(t => t.deletedAtMs === null)!.incarnation).not.toBe(incarnation)
  expect(recreated.tenants.find(t => t.incarnation === incarnation)!.deletedAtMs).toBe(3)
  expect(recreated.tokens[0]!.revokedAtMs).toBe(2)
  expect(recreated.tenants.find(t => t.deletedAtMs === null)!.quotaBytes).toBe(1234)
})

test("database staging reuses a snapshot and appends a recoverable transaction inventory", async () => {
  const store = namespaceStore(new FakeObjectStore(), "test")
  const tenant = await openTenant(openRegistry())
  const first = await stageDatabase(store, tenant, "incarnation", "cloud/v1/test/objects/first")
  writeRows(tenant, 1, 3)
  const next = await stageDatabase(store, tenant, "incarnation", "cloud/v1/test/objects/next", first)
  expect(next.snapshotRef).toEqual(first.snapshotRef)
  const index = decodeJSON(await readObject(store, next.logIndexRef, { maxBytes: 100000 })) as { segments: unknown[] }
  expect(index.segments.length).toBeGreaterThan(0)
  const restored = await restoreCloudDatabase(store, next, tempDir())
  expect(dumpFile(path.join(restored.dir, "main.db"))).toBe(dumpFile(tenant.dbPath))
  expect(await stageDatabase(store, tenant, "incarnation", "cloud/v1/test/objects/unchanged", next)).toEqual(next)
})

test("deployment-scoped storage rejects root, metadata and nested-data namespace escapes", async () => {
  const remote = new FakeObjectStore()
  const store = namespaceStore(remote, "preview")
  for (const key of ["cloud/v1/production/root.json", "cloud/v1/preview/../production/root.json", "cloud/v1/previewed/root.json"]) {
    await expect(store.get(key)).rejects.toThrow()
    await expect(store.create(key, new Uint8Array())).rejects.toThrow()
    await expect(store.replace(key, "version", new Uint8Array())).rejects.toThrow()
  }
  expect(remote.operations).toHaveLength(0)
})

test("state loading fails closed for live tenants with missing or mismatched database heads", async () => {
  const store = namespaceStore(new FakeObjectStore(), "test")
  const registry = openRegistry()
  await openTenant(registry)
  const catalog = captureCatalog(registry.catalog, empty)
  const catalogRef = await writeObject(store, "cloud/v1/test/objects/initial/catalog", encodeCatalog(catalog))
  const headsRef = await writeObject(store, "cloud/v1/test/objects/initial/heads", encodeJSON({ formatVersion: 1, heads: {} }))
  const base = await initializeRoot(store, "test", { catalogRef, headsRef })
  await expect(readCloudState(store, base)).rejects.toThrow()
})

test("staging refuses a candidate that a fresh container could not restore within its budget", async () => {
  const store = namespaceStore(new FakeObjectStore(), "test")
  const tenant = await openTenant(openRegistry())
  await expect(stageDatabase(store, tenant, "incarnation", "cloud/v1/test/objects/too-large", undefined, undefined, { maxBytes: 1 })).rejects.toThrow("budget")
})
