// The `[sqlite]` section of `docs/p1-pragmas.md`: the values a served connection carries, read off
// the connection itself through `onConnection` rather than from a second connection opened beside
// it. Most of these are per-connection, so a second one would answer for itself.

import { afterAll, describe, expect, test } from "bun:test"
import type { Database } from "../../src/sqlite/index.ts"
import { TenantRegistry } from "../../src/tenant/index.ts"
import type { SqlitePragmas } from "../../src/tenant/tenant.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

/** Opens a tenant, exercises both roles, and returns what each connection reported. */
async function pragmasFor(
  sqlite: SqlitePragmas | undefined,
  names: readonly string[],
): Promise<{ writer: Record<string, number>; reader: Record<string, number> }> {
  const seen: Record<"writer" | "reader", Record<string, number>> = { writer: {}, reader: {} }
  const read = (db: Database, role: "writer" | "reader") => {
    if (Object.keys(seen[role]).length > 0) return
    for (const name of names) {
      const row = db.prepare(`pragma ${name}`).get() as Record<string, number> | null
      seen[role][name] = row ? (Object.values(row)[0] as number) : Number.NaN
    }
  }
  const reg = TenantRegistry.open({
    dir: tempDir(),
    ...(sqlite ? { sqlite } : {}),
    onConnection: read,
  })
  const tenant = await reg.create("acme")
  tenant.write((db) => db.exec("create table t(id integer primary key, v text)"))
  await tenant.read((db) => db.prepare("select * from t").all())
  reg.close()
  return seen
}

describe("[sqlite] pragmas", () => {
  test("a cache size in bytes becomes the negative KiB form SQLite wants", async () => {
    const seen = await pragmasFor(
      { writerCacheBytes: 8_388_608, readerCacheBytes: 2_097_152 },
      ["cache_size"],
    )
    // Negative is KiB, and it is what makes the value independent of the page size — and of which
    // libsqlite3 loaded, since Apple's default is in pages.
    expect(seen.writer.cache_size).toBe(-8192)
    expect(seen.reader.cache_size).toBe(-2048)
  })

  test("mmap_size is a reader setting, and off unless asked for", async () => {
    const on = await pragmasFor({ readerMmapBytes: 268_435_456 }, ["mmap_size"])
    expect(on.reader.mmap_size).toBe(268_435_456)
    // The writer measured no gain from it, so it never gets one.
    expect(on.writer.mmap_size).toBe(0)

    const off = await pragmasFor({ readerMmapBytes: 0 }, ["mmap_size"])
    expect(off.reader.mmap_size).toBe(0)
  })

  test("foreign keys reach every connection, both ways", async () => {
    const on = await pragmasFor({ foreignKeys: true }, ["foreign_keys"])
    expect(on.writer.foreign_keys).toBe(1)
    expect(on.reader.foreign_keys).toBe(1)

    const off = await pragmasFor({ foreignKeys: false }, ["foreign_keys"])
    expect(off.writer.foreign_keys).toBe(0)
  })

  test("a foreign key is enforced only when the setting is on", async () => {
    const reg = TenantRegistry.open({ dir: tempDir(), sqlite: { foreignKeys: true } })
    const tenant = await reg.create("acme")
    tenant.write((db) => {
      db.exec("create table parent(id integer primary key)")
      db.exec("create table child(id integer primary key, parent_id integer references parent(id))")
    })
    expect(() =>
      tenant.write((db) => db.run("insert into child(parent_id) values (404)")),
    ).toThrow(/FOREIGN KEY|constraint/i)
    reg.close()

    const loose = TenantRegistry.open({ dir: tempDir() })
    const other = await loose.create("acme")
    other.write((db) => {
      db.exec("create table parent(id integer primary key)")
      db.exec("create table child(id integer primary key, parent_id integer references parent(id))")
    })
    // The default, and the thing `docs/next.md` recorded: the declaration is decoration.
    expect(other.write((db) => db.run("insert into child(parent_id) values (404)")).txid).toBe(2n)
    loose.close()
  })

  test("hardening pragmas are applied when asked for", async () => {
    const seen = await pragmasFor({ trustedSchema: false, cellSizeCheck: true }, [
      "trusted_schema",
      "cell_size_check",
    ])
    expect(seen.writer.trusted_schema).toBe(0)
    expect(seen.writer.cell_size_check).toBe(1)
    expect(seen.reader.trusted_schema).toBe(0)
  })

  test("an unset section leaves the library's own defaults in place", async () => {
    const seen = await pragmasFor(undefined, ["foreign_keys", "mmap_size", "trusted_schema"])
    expect(seen.writer.foreign_keys).toBe(0)
    expect(seen.writer.mmap_size).toBe(0)
    expect(seen.writer.trusted_schema).toBe(1)
  })

  test("the settings bql.sh has always owned are unchanged by all this", async () => {
    const seen = await pragmasFor({ writerCacheBytes: 8_388_608 }, [
      "journal_mode",
      "synchronous",
      "wal_autocheckpoint",
    ])
    // The tailer's invariant: nothing checkpoints but us.
    expect(seen.writer.wal_autocheckpoint).toBe(0)
    expect(String(seen.writer.journal_mode)).toBe("wal")
    expect(seen.writer.synchronous).toBe(1)
  })
})
