import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { BunQLError } from "../../src/server/errors.ts"
import { assertValidName, TenantError, TenantRegistry, tenantDir } from "../../src/tenant/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

describe("tenant registry", () => {
  test("validates names before they reach the filesystem", () => {
    for (const name of ["a", "acme", "acme-prod_2", "0", "a".repeat(64)]) {
      expect(() => assertValidName(name)).not.toThrow()
    }
    for (const name of ["", "-acme", "Acme", "acme/evil", "../etc", "a".repeat(65), "_system"]) {
      expect(() => assertValidName(name)).toThrow(BunQLError)
    }
  })

  test("creates, opens, lists and deletes", async () => {
    const dir = tempDir()
    const reg = TenantRegistry.open({ dir })

    const tenant = await reg.create("acme", { pageSize: 4096, quotaBytes: 500_000 })
    expect(tenant.dir).toBe(tenantDir(dir, "acme"))
    expect(fs.existsSync(path.join(tenant.dir, "main.db"))).toBe(true)
    expect(reg.has("acme")).toBe(true)
    expect(reg.open("acme")).toBe(tenant)
    await expect(reg.create("acme")).rejects.toThrow(TenantError)
    expect(() => reg.open("nope")).toThrow(BunQLError)

    await reg.create("beta")
    expect(reg.list().map((row) => row.name)).toEqual(["acme", "beta"])
    expect(reg.stats().open).toBe(2)

    tenant.write((db) => db.exec("create table t(v integer)"))
    const segments = tenant.log.segmentPaths.map((one) => path.basename(one))
    expect(segments.length).toBeGreaterThan(0)

    const trash = reg.delete("acme")
    expect(reg.has("acme")).toBe(false)
    expect(fs.existsSync(tenant.dir)).toBe(false)
    // Design §6.5: a deleted database keeps its log and snapshots; nothing is removed. The
    // invariant is that every segment the log held is still there under `trash/`, not how many
    // files the directory has — the log also writes a sidecar index beside each segment.
    expect(trash.startsWith(path.join(dir, "trash"))).toBe(true)
    expect(fs.existsSync(path.join(trash, "main.db"))).toBe(true)
    const kept = fs.readdirSync(path.join(trash, "log"))
    for (const segment of segments) expect(kept).toContain(segment)
    expect(reg.list().map((row) => row.name)).toEqual(["beta"])

    // The name is free again after a delete.
    const again = await reg.create("acme")
    expect(again.txid).toBe(0n)
    reg.close()
  })

  test("warns when maxOpen outruns the file-descriptor limit", () => {
    const warnings: string[] = []
    const reg = TenantRegistry.open({
      dir: tempDir(),
      maxOpen: 10_000_000,
      warn: (message) => warnings.push(message),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("file descriptors")
    reg.close()
  })

  test("evicts idle tenants and reopens them, never evicting one in flight", async () => {
    const dir = tempDir()
    const reg = TenantRegistry.open({ dir, maxOpen: 50, readers: 1 })
    // Ten times `maxOpen`, which is what the test is about — the LRU has to evict nine tenants
    // out of ten and reopen any of them intact. It was 2000, and 2000 is 24x slower on Windows
    // than on macOS (creating a file and opening SQLite on it are both far dearer there), which
    // put this one test over a two-minute limit while proving nothing extra. `maxOpen` is the
    // number that matters; `count` only has to comfortably exceed it.
    const count = 500

    for (let i = 0; i < count; i++) {
      const tenant = await reg.create(`t${i}`)
      tenant.write((db) => {
        db.exec("create table t(v integer)")
        db.run("insert into t values (?)", [i])
      })
      expect(reg.openNames.length).toBeLessThanOrEqual(50)
    }
    expect(reg.list()).toHaveLength(count)
    expect(reg.stats().evictions).toBeGreaterThan(count - 60)

    // Every evicted tenant reopens with its own state intact.
    for (const i of [0, 1, 7, count >> 2, count >> 1, count - 1]) {
      const tenant = reg.open(`t${i}`)
      expect(tenant.txid).toBe(1n)
      expect(tenant.readSync((db) => db.prepare("select v from t").get())).toEqual({ v: i })
    }

    // A tenant holding a reader lease is skipped by the sweep rather than closed underneath it.
    const held = reg.open("t42")
    const lease = held.acquireReader()
    for (let i = 0; i < 60; i++) reg.open(`t${i}`)
    expect(reg.openNames).toContain("t42")
    expect(held.closed).toBe(false)
    expect(lease.db.prepare("select v from t").get()).toEqual({ v: 42 })
    held.releaseReader(lease)

    reg.close()

    // And the whole catalog survives a restart of the process.
    const reopened = TenantRegistry.open({ dir, maxOpen: 8 })
    expect(reopened.list()).toHaveLength(count)
    const last = count - 66
    const tenant = reopened.open(`t${last}`)
    expect(tenant.readSync((db) => db.prepare("select v from t").get())).toEqual({ v: last })
    expect(tenant.write((db) => db.run("insert into t values (0)")).txid).toBe(2n)
    reopened.close()
  }, 180_000)
})
