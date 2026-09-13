import { afterAll, describe, expect, test } from "bun:test"
import { Catalog } from "../../src/tenant/index.ts"
import type { RecorderPosition } from "../../src/wal/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

function position(txid: bigint): RecorderPosition {
  return {
    txid,
    epoch: 3,
    // Above 2^63, which is why the column is TEXT.
    checksum: 0xf0e1d2c3b4a59687n,
    dbSizePages: 42,
    wal: { salt1: 0x11223344, salt2: 0x55667788, frame: 17 },
  }
}

describe("catalog", () => {
  test("creates, lists and tombstones tenants", () => {
    const catalog = Catalog.open(tempDir())
    catalog.createTenant({ name: "acme", pageSize: 4096, quotaBytes: 1_000_000 })
    catalog.createTenant({ name: "beta", pageSize: 8192 })

    expect(catalog.listTenants().map((row) => row.name)).toEqual(["acme", "beta"])
    const acme = catalog.getTenant("acme")
    expect(acme?.pageSize).toBe(4096)
    expect(acme?.quotaBytes).toBe(1_000_000)
    expect(acme?.txid).toBe(0n)
    expect(() => catalog.createTenant({ name: "acme", pageSize: 4096 })).toThrow(/already exists/)

    expect(catalog.deleteTenant("acme")).toBe(true)
    expect(catalog.getTenant("acme")).toBeNull()
    expect(catalog.getTenant("acme", { includeDeleted: true })?.deletedAtMs).toBeNumber()
    expect(catalog.listTenants().map((row) => row.name)).toEqual(["beta"])

    // A tombstoned name is free again.
    catalog.createTenant({ name: "acme", pageSize: 4096 })
    expect(catalog.getTenant("acme")?.deletedAtMs).toBeNull()
    catalog.close()
  })

  test("round-trips a recorder position, including a checksum above 2^63", () => {
    const dir = tempDir()
    const catalog = Catalog.open(dir)
    catalog.createTenant({ name: "acme", pageSize: 4096 })
    catalog.savePosition("acme", position(9n))
    catalog.close()

    const reopened = Catalog.open(dir)
    expect(reopened.loadPosition("acme")).toEqual(position(9n))
    expect(reopened.getTenant("acme")?.clean).toBe(false)

    reopened.savePosition("acme", position(10n), true)
    expect(reopened.getTenant("acme")?.clean).toBe(true)
    reopened.markOpen("acme")
    expect(reopened.getTenant("acme")?.clean).toBe(false)
    reopened.close()
  })

  test("records snapshots per database", () => {
    const catalog = Catalog.open(tempDir())
    catalog.createTenant({ name: "acme", pageSize: 4096 })
    expect(catalog.lastSnapshotTxid("acme")).toBeNull()
    catalog.recordSnapshot("acme", 4n, "/snapshots/4.db")
    catalog.recordSnapshot("acme", 12n, "/snapshots/12.db")
    catalog.recordSnapshot("beta", 7n, "/other/7.db")

    expect(catalog.listSnapshotRows("acme").map((row) => row.txid)).toEqual([4n, 12n])
    expect(catalog.lastSnapshotTxid("acme")).toBe(12n)
    catalog.removeSnapshotRow("acme", 12n)
    expect(catalog.lastSnapshotTxid("acme")).toBe(4n)
    catalog.close()
  })

  test("is the revocation list the server's authenticator expects", () => {
    const dir = tempDir()
    const catalog = Catalog.open(dir)
    catalog.putToken({ jti: "t1", claims: { p: { ro: { ns: ["acme"] } } }, expiresAtSec: 10 })
    expect(catalog.isRevoked("t1")).toBe(false)

    catalog.revokeToken("t1")
    expect(catalog.isRevoked("t1")).toBe(true)
    // A token this node never minted can still be revoked.
    catalog.revokeToken("unknown")
    expect(catalog.isRevoked("unknown")).toBe(true)
    expect(catalog.getToken("t1")?.claims).toEqual({ p: { ro: { ns: ["acme"] } } })
    catalog.close()

    // Revocations survive a restart, which is the point of storing them.
    const reopened = Catalog.open(dir)
    expect(reopened.isRevoked("t1")).toBe(true)
    expect(reopened.revokedCount).toBe(2)
    reopened.restoreToken("t1")
    expect(reopened.isRevoked("t1")).toBe(false)
    expect(reopened.purgeExpiredTokens(20)).toBe(1)
    expect(reopened.getToken("t1")).toBeNull()
    reopened.close()
  })
})
