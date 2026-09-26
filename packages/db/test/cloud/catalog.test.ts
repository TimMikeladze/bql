import { afterEach, expect, test } from "bun:test"
import { Catalog } from "../../src/tenant/catalog.ts"
import { decodeCatalog, encodeCatalog, installCatalog, type CloudCatalog } from "../../src/cloud/catalog.ts"
import { cleanup, tempDir } from "../storage/harness.ts"

afterEach(cleanup)
const catalog: CloudCatalog = {
  formatVersion: 1,
  settings: { foreignKeys: true },
  tenants: [
    { name: "acme", incarnation: "old", createdAtMs: 1, deletedAtMs: 2, pageSize: 4096, quotaBytes: 10000, foreignKeys: false, ackWithoutReplicas: null },
    { name: "acme", incarnation: "new", createdAtMs: 3, deletedAtMs: null, pageSize: 4096, quotaBytes: 20000, foreignKeys: null, ackWithoutReplicas: "error" },
  ],
  tokens: [ { jti: "revoked", createdAtMs: 1, expiresAtSec: 100, revokedAtMs: 2, claims: { sub: "user", db: "acme" } }, { jti: "active", createdAtMs: 1, expiresAtSec: null, revokedAtMs: null, claims: null } ],
}

test("logical catalog roundtrip retains incarnation tombstones, settings, quotas and token audit", () => {
  const roundtrip = decodeCatalog(encodeCatalog(catalog))
  expect(roundtrip).toEqual(catalog)
  const installed = installCatalog(roundtrip, tempDir())
  try {
    expect(installed.listTenants()).toHaveLength(1)
    expect(installed.getTenant("acme")?.quotaBytes).toBe(20000)
    expect(installed.getTenant("acme")?.foreignKeys).toBeNull()
    expect(installed.getTenant("acme")?.ackWithoutReplicas).toBe("error")
    expect(installed.isRevoked("revoked")).toBe(true)
    expect(installed.getToken("revoked")).toEqual(catalog.tokens[0]!)
    expect(installed.isRevoked("active")).toBe(false)
  } finally { installed.close() }
})

test("corrupt catalogs and duplicate live identities cannot install", () => {
  for (const bad of [
    { ...catalog, formatVersion: 2 },
    { ...catalog, tenants: [catalog.tenants[1], catalog.tenants[1]] },
    { ...catalog, tokens: [catalog.tokens[0], catalog.tokens[0]] },
    { ...catalog, tenants: [{ ...catalog.tenants[1], quotaBytes: -1 }] },
    { ...catalog, tenants: [{ ...catalog.tenants[1], name: "../elsewhere" }] },
    { ...catalog, settings: { foreignKeys: "yes" } },
  ]) expect(() => decodeCatalog(new TextEncoder().encode(JSON.stringify(bad)))).toThrow()
})

test("catalog installation refuses to overwrite an existing local catalog", () => {
  const dir = tempDir()
  const existing = Catalog.open(dir)
  existing.createTenant({ name: "keep", pageSize: 4096 })
  existing.close()
  expect(() => installCatalog(catalog, dir)).toThrow()
  const reopened = Catalog.open(dir)
  try { expect(reopened.getTenant("keep")).not.toBeNull() } finally { reopened.close() }
})
