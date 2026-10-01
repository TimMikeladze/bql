// X2: lineage in the catalog and `reset` (`docs/x2-branching.md`). The registry directly, so a
// restart is a close and a reopen of the same data directory.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { TenantRegistry, trashDir } from "../../src/tenant/index.ts"
import { computeFull } from "../../src/wal/index.ts"
import { cleanupTempDirs, tempDir } from "./tmp.ts"

afterAll(cleanupTempDirs)

function values(reg: TenantRegistry, name: string): string[] {
  return reg
    .open(name)
    .readSync((db) => db.prepare("select v from t order by rowid").all())
    .map((row) => row.v as string)
}

function insert(reg: TenantRegistry, name: string, v: string): void {
  reg.open(name).write((db) => db.run("insert into t(v) values (?)", [v]))
}

describe("branching", () => {
  test("a fork records its parent and txid, and both survive a restart", async () => {
    const dir = tempDir()
    let reg = TenantRegistry.open({ dir })
    const main = await reg.create("main")
    main.write((db) => db.exec("create table t(v text)"))
    insert(reg, "main", "one")
    const at = reg.open("main").txid
    insert(reg, "main", "two")

    await reg.create("pr-1", { from: { db: "main", at } })
    await reg.create("pr-2", { from: { db: "main" } })
    const row = reg.catalog.getTenant("pr-1")
    expect(row?.parent).toBe("main")
    expect(row?.forkedAt).toBe(at)
    expect(reg.catalog.getTenant("pr-2")?.forkedAt).toBe(reg.open("main").txid)
    expect(reg.catalog.getTenant("main")?.parent).toBeNull()

    reg.close()
    reg = TenantRegistry.open({ dir })
    expect(reg.catalog.getTenant("pr-1")).toMatchObject({ parent: "main", forkedAt: at })
    expect(values(reg, "pr-1")).toEqual(["one"])
    reg.close()
  })

  test("a fork keeps its parent's foreign keys and ack override, and enforces them", async () => {
    const dir = tempDir()
    const reg = TenantRegistry.open({ dir })
    await reg.create("main")
    reg.setForeignKeys("main", true)
    reg.setAckWithoutReplicas("main", "allow")
    reg.open("main").write((db) =>
      db.exec("create table p(id integer primary key); create table c(p integer references p(id))"),
    )
    const at = reg.open("main").txid

    await reg.create("pr-1", { from: { db: "main" } })
    await reg.create("pr-2", { from: { db: "main", at } })
    await reg.create("plain")
    for (const name of ["pr-1", "pr-2"]) {
      expect(reg.catalog.getTenant(name)).toMatchObject({
        foreignKeys: true,
        ackWithoutReplicas: "allow",
      })
      expect(reg.ackWithoutReplicasOf(name)).toBe("allow")
      expect(() => reg.open(name).write((db) => db.run("insert into c(p) values (1)"))).toThrow(
        /FOREIGN KEY/,
      )
    }
    // A database created from nothing still follows the node.
    expect(reg.catalog.getTenant("plain")).toMatchObject({
      foreignKeys: null,
      ackWithoutReplicas: null,
    })
    reg.close()
  })

  test("a catalog from before lineage migrates to nulls", () => {
    const dir = tempDir()
    let reg = TenantRegistry.open({ dir })
    reg.catalog.db.exec("alter table tenants drop column parent")
    reg.catalog.db.exec("alter table tenants drop column forked_at")
    reg.catalog.db.exec("insert into tenants (name, created_at, page_size) values ('old', 0, 4096)")
    reg.close()
    reg = TenantRegistry.open({ dir })
    expect(reg.catalog.getTenant("old")).toMatchObject({ parent: null, forkedAt: null })
    reg.close()
  })

  test("deleting a parent leaves the child whole, with a dangling parent", async () => {
    const dir = tempDir()
    const reg = TenantRegistry.open({ dir })
    const main = await reg.create("main")
    main.write((db) => db.exec("create table t(v text)"))
    insert(reg, "main", "one")
    await reg.create("child", { from: { db: "main" } })
    reg.delete("main")

    expect(reg.catalog.getTenant("child")?.parent).toBe("main")
    expect(values(reg, "child")).toEqual(["one"])
    await expect(reg.reset("child")).rejects.toThrow(/parent main has been deleted/)
    reg.close()
  })

  test("reset puts a branch back at its parent's head, and survives a restart", async () => {
    const dir = tempDir()
    let reg = TenantRegistry.open({ dir })
    const main = await reg.create("main")
    main.write((db) => db.exec("create table t(v text)"))
    insert(reg, "main", "one")
    await reg.create("pr", { from: { db: "main" } })
    const createdAtMs = reg.catalog.getTenant("pr")?.createdAtMs

    // The branch diverges; the parent moves on.
    insert(reg, "pr", "branch-only")
    reg.open("pr").write((db) => db.exec("create table extra(x)"))
    insert(reg, "main", "two")
    const head = reg.open("main").txid

    const before = fs.existsSync(trashDir(dir)) ? fs.readdirSync(trashDir(dir)) : []
    const tenant = await reg.reset("pr")
    expect(tenant.txid).toBe(head)
    expect(values(reg, "pr")).toEqual(["one", "two"])
    const tables = reg
      .open("pr")
      .readSync((db) => db.prepare("select name from sqlite_schema where name = 'extra'").all())
    expect(tables).toEqual([])
    const row = reg.catalog.getTenant("pr")
    expect(row).toMatchObject({ parent: "main", forkedAt: head, createdAtMs })
    // The old files went to the trash; the staging directory did not stay behind.
    const trashed = fs.readdirSync(trashDir(dir)).filter((entry) => !before.includes(entry))
    expect(trashed.some((entry) => entry.startsWith("pr-reset-"))).toBe(true)
    expect(trashed.some((entry) => entry.includes("staging"))).toBe(false)

    // The branch is writable again, and a restart reopens it where the reset left it.
    insert(reg, "pr", "after")
    reg.close()
    reg = TenantRegistry.open({ dir })
    expect(values(reg, "pr")).toEqual(["one", "two", "after"])
    expect(reg.catalog.getTenant("pr")?.forkedAt).toBe(head)
    reg.close()
  })

  test("reset refuses a database that was never forked", async () => {
    const dir = tempDir()
    const reg = TenantRegistry.open({ dir })
    await reg.create("solo")
    await expect(reg.reset("solo")).rejects.toMatchObject({ code: "NO_PARENT" })
    await expect(reg.reset("nope")).rejects.toMatchObject({ code: "DB_NOT_FOUND" })
    reg.close()
  })

  // Review finding 6: a crash between any two steps of the swap must leave a database whose file
  // and catalog position agree when it next opens — otherwise the recorder chains new records
  // onto a checksum the file does not have.
  for (const [crashAt, expected] of [
    ["marked", ["one", "branch"]],
    ["moved", ["one", "two"]],
    ["swapped", ["one", "two"]],
  ] as const) {
    test(`a crash after "${crashAt}" is finished or undone at the next open`, async () => {
      const dir = tempDir()
      let reg = TenantRegistry.open({ dir, warn: () => {} })
      const main = await reg.create("main")
      main.write((db) => db.exec("create table t(v text)"))
      insert(reg, "main", "one")
      await reg.create("pr", { from: { db: "main" } })
      insert(reg, "pr", "branch")
      insert(reg, "main", "two")
      const branchTxid = reg.open("pr").txid
      const head = reg.open("main").txid

      await expect(reg.reset("pr", { crashAt })).rejects.toThrow("simulated crash")
      expect(reg.catalog.pendingReset("pr")).not.toBeNull()
      reg.close()

      reg = TenantRegistry.open({ dir, warn: () => {} })
      const tenant = reg.open("pr")
      expect(reg.catalog.pendingReset("pr")).toBeNull()
      expect(values(reg, "pr")).toEqual([...expected])
      expect(tenant.txid).toBe(crashAt === "marked" ? branchTxid : head)
      // The position the recorder resumes from is the file's own.
      const file = computeFull(path.join(tenant.dir, "main.db"))
      expect(tenant.position.checksum).toBe(file.checksum)
      const staged = fs.readdirSync(trashDir(dir)).filter((entry) => entry.includes("staging"))
      expect(staged).toEqual([])

      // It keeps working across a restart.
      insert(reg, "pr", "after")
      reg.close()
      reg = TenantRegistry.open({ dir })
      expect(values(reg, "pr")).toEqual([...expected, "after"])
      reg.close()
    })
  }
})
