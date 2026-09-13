// `DELETE /v1/db/{db}` moves a tenant aside instead of removing it, so `<dataDir>/trash/` is the
// one directory on a node that grows without a bound of its own. These are the rules the sweep
// has to keep: old goes, new stays, anything it did not name stays, and "keep for ever" is a
// real setting rather than an accident.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { sweepTrash, TenantRegistry, trashDir } from "../../src/tenant/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

const DAY = 86_400_000

/** A trashed database with `bytes` of content in it, filed as though it were deleted at `at`. */
function trashed(dir: string, name: string, at: number, bytes = 0): string {
  const full = path.join(trashDir(dir), `${name}-${at}`)
  fs.mkdirSync(path.join(full, "log"), { recursive: true })
  if (bytes > 0) fs.writeFileSync(path.join(full, "main.db"), new Uint8Array(bytes))
  return full
}

describe("trash sweep", () => {
  test("removes what is past the retention and keeps what is not", () => {
    const dir = tempDir("bunql-trash-")
    const now = 1_800_000_000_000
    const old = trashed(dir, "acme", now - 8 * DAY, 4096)
    const recent = trashed(dir, "beta", now - 1 * DAY, 4096)

    const swept = sweepTrash(dir, 7 * DAY, now)

    expect(swept.removed).toEqual([old])
    expect(swept.bytes).toBe(4096)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(recent)).toBe(true)
  })

  test("leaves an entry whose name carries no timestamp alone", () => {
    const dir = tempDir("bunql-trash-")
    const now = 1_800_000_000_000
    // Three shapes the sweep must not guess at, all older than any retention would allow.
    const root = trashDir(dir)
    for (const name of ["acme", "acme-", "acme-notatimestamp"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
    }
    // A name that contains dashes of its own still sweeps: the suffix is what counts.
    const dashed = trashed(dir, "acme-prod-eu", now - 30 * DAY)

    const swept = sweepTrash(dir, 7 * DAY, now)

    expect(swept.removed).toEqual([dashed])
    for (const name of ["acme", "acme-", "acme-notatimestamp"]) {
      expect(fs.existsSync(path.join(root, name))).toBe(true)
    }
  })

  test("retentionMs <= 0 keeps everything, and an empty trash is not a failure", () => {
    const dir = tempDir("bunql-trash-")
    const now = 1_800_000_000_000
    const ancient = trashed(dir, "acme", now - 3650 * DAY, 512)

    for (const retention of [0, -1]) {
      expect(sweepTrash(dir, retention, now)).toEqual({ removed: [], bytes: 0 })
      expect(fs.existsSync(ancient)).toBe(true)
    }

    // A node that has never deleted anything has no trash directory at all.
    expect(sweepTrash(tempDir("bunql-trash-"), 7 * DAY, now)).toEqual({ removed: [], bytes: 0 })
  })

  test("sweeps what the registry actually trashed", async () => {
    const dir = tempDir("bunql-trash-")
    const reg = TenantRegistry.open({ dir })
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v integer)"))
    const trash = reg.delete("acme")
    expect(fs.existsSync(trash)).toBe(true)

    // The entry is stamped with `Date.now()`, so a retention of 0 ms past its own timestamp is
    // what makes it old; a day's retention keeps it.
    expect(reg.sweepTrash(DAY).removed).toEqual([])
    const swept = reg.sweepTrash(1, Date.now() + 1000)
    expect(swept.removed).toEqual([trash])
    expect(swept.bytes).toBeGreaterThan(0)
    expect(fs.existsSync(trash)).toBe(false)
    reg.close()
  })
})
