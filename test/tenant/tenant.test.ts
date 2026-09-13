import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { BunQLError } from "../../src/server/errors.ts"
import { type CommitEvent, TenantRegistry } from "../../src/tenant/index.ts"
import { computeFull } from "../../src/wal/index.ts"
import {
  cleanupTempDirs,
  crashKeeper,
  dump,
  dumpFile,
  integrityOk,
  loggedTxids,
  replayLog,
  tempDir,
  truncateLogAfter,
} from "./tmp.ts"

afterAll(cleanupTempDirs)

function registry(options: Partial<Parameters<typeof TenantRegistry.open>[0]> = {}) {
  const dir = tempDir()
  return { dir, registry: TenantRegistry.open({ dir, ...options }) }
}

describe("tenant write and read path", () => {
  test("assigns monotonic txids that survive close and reopen", async () => {
    const { dir, registry: reg } = registry()
    const tenant = await reg.create("acme")

    const created = tenant.write((db) => {
      db.exec("create table users(id integer primary key, name text)")
      return db.run("insert into users(name) values (?)", ["ann"])
    })
    expect(created.txid).toBe(1n)
    expect(created.result.lastInsertRowid).toBe(1)
    expect(tenant.write((db) => db.run("insert into users(name) values ('bob')")).txid).toBe(2n)

    // A transaction that writes no pages produces no record and does not advance the txid —
    // including one whose statements are writes that happen to match no rows.
    expect(tenant.write((db) => db.prepare("select count(*) c from users").get()).txid).toBe(2n)
    const missed = tenant.write((db) => db.run("update users set name = 'x' where id = -1"))
    expect(missed.txid).toBe(2n)
    expect(missed.result.changes).toBe(0)
    expect(tenant.write((db) => db.run("delete from users where 1 = 0")).txid).toBe(2n)
    expect(tenant.log.lastTxid).toBe(2n)
    expect(tenant.readSync((db) => db.prepare("select count(*) c from users").get())).toEqual({
      c: 2,
    })

    expect(tenant.readSync((db) => db.prepare("select name from users order by id").values())).toEqual(
      [["ann"], ["bob"]],
    )

    reg.release("acme")
    const reopened = reg.open("acme")
    expect(reopened.reconciled).toBe("clean")
    expect(reopened.txid).toBe(2n)
    expect(reopened.write((db) => db.run("insert into users(name) values ('cy')")).txid).toBe(3n)
    expect(reopened.readSync((db) => db.prepare("select count(*) c from users").get())).toEqual({
      c: 3,
    })
    expect(loggedTxids(reopened.dir)).toEqual([1n, 2n, 3n])

    const stats = reopened.stats()
    expect(stats.txid).toBe(3n)
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.logBytes).toBeGreaterThan(0)
    expect(stats.openReaders).toBe(1)

    const dbPath = reopened.dbPath
    reg.close()
    expect(integrityOk(dbPath)).toBe(true)
    expect(dumpFile(dbPath)).toBe('## users\n[1,"ann"]\n[2,"bob"]\n[3,"cy"]')
    expect(dir).toContain("bunql-tenant-")
  })

  test("ack: fsync commits through the same path", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v integer)"), { ack: "fsync" })
    const second = tenant.write((db) => db.run("insert into t values (7)"), { ack: "fsync" })
    expect(second.txid).toBe(2n)
    expect(tenant.readSync((db) => db.prepare("select v from t").get())).toEqual({ v: 7 })
    reg.close()
  })

  test("publishes durable commits to hooks", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    const seen: CommitEvent[] = []
    const off = tenant.onCommit((event) => seen.push(event))

    tenant.write((db) => db.exec("create table t(v integer)"))
    tenant.write((db) => db.run("insert into t values (1)"))
    expect(seen.map((event) => event.txid)).toEqual([1n, 2n])
    // The record is durable by the time the hook sees it (design §4.3, step 5).
    expect(tenant.log.lastTxid).toBe(2n)
    expect(seen[1]?.record.prevTxid).toBe(1n)
    expect(seen[1]?.bytes.byteLength).toBeGreaterThan(0)

    off()
    tenant.write((db) => db.run("insert into t values (2)"))
    expect(seen).toHaveLength(2)
    reg.close()
  })

  test("a quota exceeded is QUOTA_EXCEEDED, not a raw SQLite error", async () => {
    const { registry: reg } = registry()
    // 24 pages of 4 KB: enough for a schema and some rows, not for a megabyte of them.
    const tenant = await reg.create("small", { pageSize: 4096, quotaBytes: 24 * 4096 })
    tenant.write((db) => db.exec("create table blobs(id integer primary key, body blob)"))

    const body = new Uint8Array(8192).fill(7)
    let thrown: unknown = null
    for (let i = 0; i < 200 && thrown === null; i++) {
      try {
        tenant.write((db) => db.run("insert into blobs(body) values (?)", [body]))
      } catch (err) {
        thrown = err
      }
    }
    expect(thrown).toBeInstanceOf(BunQLError)
    expect((thrown as BunQLError).code).toBe("QUOTA_EXCEEDED")
    expect((thrown as BunQLError).status).toBe(507)

    // The failed transaction rolled back, so the tenant is still usable and still consistent.
    const txid = tenant.txid
    expect(tenant.readSync((db) => db.prepare("select count(*) c from blobs").get())).toBeDefined()
    expect(tenant.txid).toBe(txid)
    expect(loggedTxids(tenant.dir).at(-1)).toBe(txid)
    reg.close()
  })
})

describe("read-your-writes", () => {
  test("waits for a txid that a later write delivers", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v integer)"))

    const pending = tenant.read((db) => db.prepare("select count(*) c from t").get(), {
      minTxid: 3n,
      waitMs: 1000,
    })
    tenant.write((db) => db.run("insert into t values (1)")) // txid 2, still not enough
    tenant.write((db) => db.run("insert into t values (2)")) // txid 3
    expect(await pending).toEqual({ c: 2 })
    reg.close()
  })

  test("gives up with TXID_NOT_AVAILABLE", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v integer)"))

    const failure = tenant
      .read((db) => db.prepare("select 1").get(), { minTxid: 99n, waitMs: 30 })
      .then(() => null)
      .catch((err: unknown) => err)
    const err = (await failure) as BunQLError
    expect(err).toBeInstanceOf(BunQLError)
    expect(err.code).toBe("TXID_NOT_AVAILABLE")
    expect(err.status).toBe(425)

    // The synchronous path does not wait at all.
    expect(() => tenant.readSync((db) => db.prepare("select 1").get(), { minTxid: 99n })).toThrow(
      /cannot serve minTxid 99/,
    )
    reg.close()
  })
})

describe("checkpoint policy", () => {
  test("bounds the WAL without losing a transaction from the log", async () => {
    const { dir, registry: reg } = registry({ idleCheckpointMs: 50 })
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table blobs(id integer primary key, body blob)"))

    // 16 KB a row: about five 4 KB pages per transaction, so ~5 MB of WAL over the run.
    const body = new Uint8Array(16 * 1024).fill(3)
    for (let i = 0; i < 260; i++) {
      tenant.write((db) => db.run("insert into blobs(body) values (?)", [body]))
    }
    const txid = tenant.txid
    expect(txid).toBe(261n)
    // The PASSIVE checkpoint kept the WAL near its threshold rather than letting it track the
    // database; without it this would be the whole 4+ MB of pages.
    expect(tenant.walBytes).toBeLessThan(tenant.checkpointWalBytes * 2)
    expect(tenant.sizeBytes + tenant.walBytes).toBeGreaterThan(4_000_000)

    // Idle for longer than the policy allows: TRUNCATE empties the file.
    tenant.maintain(Date.now() + 60_000)
    expect(tenant.walBytes).toBe(0)

    const expected = tenant.readSync((db) => dump(db))
    expect(loggedTxids(tenant.dir)).toEqual(
      Array.from({ length: Number(txid) }, (_, i) => BigInt(i + 1)),
    )
    // Everything the checkpoints moved into the database file is still in the log: a replica
    // rebuilt from records alone is byte-for-byte the same database.
    const replica = replayLog(tenant.dir, path.join(dir, "replica"))
    expect(integrityOk(replica)).toBe(true)
    expect(dumpFile(replica)).toBe(expected)

    // And the tenant keeps going across the checkpoint boundary.
    expect(tenant.write((db) => db.run("insert into blobs(body) values (?)", [body])).txid).toBe(
      txid + 1n,
    )
    reg.close()
  }, 30_000)

  test("a manual TRUNCATE refuses to run under an open reader lease", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v integer)"))
    const lease = tenant.acquireReader()
    try {
      expect(() => tenant.checkpoint("TRUNCATE")).toThrow(/holds a transaction/)
    } finally {
      tenant.releaseReader(lease)
    }
    expect(tenant.checkpoint("TRUNCATE").busy).toBe(false)
    expect(tenant.walBytes).toBe(0)
    reg.close()
  })
})

describe("a database at txid 0", () => {
  test("stands at zero pages and checksum zero even after SQLite has opened its file", async () => {
    // The trap the whole tree keeps warning about, on the one path that did not guard against it.
    // SQLite writes a header page when it first opens a database in WAL mode, and that page
    // belongs to no transaction — so a database created, closed and reopened without a write has
    // a file `computeFull` scores as one page and a non-zero checksum, while the database itself
    // has no history at all. `openRecorder` used to let the file decide, and record 1 then carried
    // that checksum as its `preChecksum`. A replica bootstrapping from nothing refuses such a
    // record — correctly, and with the checksum in the message:
    //
    //   ChecksumMismatch: pre-transaction checksum mismatch at txid 1:
    //     expected 80adc3c53d5dd66b, computed 0
    //
    // Which is how it showed up: a sharded cluster test failing on CI roughly one run in three,
    // depending on whether a worker happened to open the tenant before its first write.
    const { dir } = registry()
    let reg = TenantRegistry.open({ dir })
    await reg.create("acme")
    reg.close()

    reg = TenantRegistry.open({ dir })
    const tenant = reg.open("acme")
    // The file says otherwise, and the file is not the position.
    expect(computeFull(tenant.dbPath).pages).toBeGreaterThan(0)
    expect(tenant.position.txid).toBe(0n)
    expect(tenant.position.checksum).toBe(0n)
    expect(tenant.position.dbSizePages).toBe(0)

    tenant.write((db) => db.exec("create table t(v text)"))
    tenant.flushPending()
    const first = tenant.log.read(1n)
    // What a replica starting from nothing has to be able to apply.
    expect(first?.txid).toBe(1n)
    expect(first?.preChecksum).toBe(0n)
    reg.close()
  })
})

describe("crash reconcile", () => {
  test("tails transactions the log never got (database ahead of log)", async () => {
    const { dir, registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v text)"))
    tenant.write((db) => db.run("insert into t values ('a')"))
    tenant.write((db) => db.run("insert into t values ('b')"))
    const atThree = tenant.position
    expect(atThree.txid).toBe(3n)

    tenant.write((db) => db.run("insert into t values ('c')"))
    tenant.write((db) => db.run("insert into t values ('d')"))
    const expected = tenant.readSync((db) => dump(db))
    const tenantPath = tenant.dir

    // A crash: the WAL keeps the frames of 4 and 5, the log and the catalog never heard of them.
    const keeper = crashKeeper(tenant.dbPath)
    reg.abandon("acme")
    reg.catalog.savePosition("acme", atThree)
    expect(truncateLogAfter(tenantPath, 3n)).toBe(2)
    expect(loggedTxids(tenantPath)).toEqual([1n, 2n, 3n])

    const reopened = reg.open("acme")
    expect(reopened.reconciled).toBe("tailed")
    expect(reopened.txid).toBe(5n)
    expect(loggedTxids(tenantPath)).toEqual([1n, 2n, 3n, 4n, 5n])
    keeper.close()

    expect(reopened.write((db) => db.run("insert into t values ('e')")).txid).toBe(6n)
    const after = reopened.readSync((db) => dump(db))
    expect(after.startsWith(expected)).toBe(true)

    const replica = replayLog(tenantPath, path.join(dir, "replica"))
    expect(dumpFile(replica)).toBe(after)
    reg.close()
  })

  test("applies a record the database lost (log ahead of database)", async () => {
    const { dir, registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v text)"))
    tenant.write((db) => db.run("insert into t values ('a')"))
    const tenantPath = tenant.dir
    const dbPath = tenant.dbPath

    // Back the files up mid-flight, the way a restored snapshot or a bad copy would.
    const backup = path.join(dir, "backup")
    fs.mkdirSync(backup, { recursive: true })
    let keeper = crashKeeper(dbPath)
    reg.abandon("acme")
    fs.copyFileSync(dbPath, path.join(backup, "main.db"))
    fs.copyFileSync(`${dbPath}-wal`, path.join(backup, "main.db-wal"))
    keeper.close()

    const again = reg.open("acme")
    again.write((db) => db.run("insert into t values ('b')"))
    expect(again.txid).toBe(3n)
    keeper = crashKeeper(dbPath)
    reg.abandon("acme")
    keeper.close()

    // Roll the database back to txid 2 while the log still holds record 3.
    fs.copyFileSync(path.join(backup, "main.db"), dbPath)
    fs.copyFileSync(path.join(backup, "main.db-wal"), `${dbPath}-wal`)
    fs.rmSync(`${dbPath}-shm`, { force: true })

    const reopened = reg.open("acme")
    expect(reopened.reconciled).toBe("applied")
    expect(reopened.txid).toBe(3n)
    expect(reopened.readSync((db) => db.prepare("select v from t order by rowid").values())).toEqual(
      [["a"], ["b"]],
    )
    expect(loggedTxids(tenantPath)).toEqual([1n, 2n, 3n])

    // The repaired database is a working primary again.
    expect(reopened.write((db) => db.run("insert into t values ('c')")).txid).toBe(4n)
    const replica = replayLog(tenantPath, path.join(dir, "replica"))
    expect(dumpFile(replica)).toBe(reopened.readSync((db) => dump(db)))
    reg.close()
  })
})

describe("snapshot and fork", () => {
  test("a fork at a txid is the database as it was at that txid", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme", { quotaBytes: 1_000_000 })
    tenant.write((db) => db.exec("create table t(v text)"))
    tenant.write((db) => db.run("insert into t values ('a')"))
    tenant.write((db) => db.run("insert into t values ('b')"))
    const atThree = tenant.readSync((db) => dump(db))

    const ref = await tenant.snapshot()
    expect(BigInt(ref.txid)).toBe(3n)
    expect(reg.catalog.lastSnapshotTxid("acme")).toBe(3n)
    // The snapshot file is the database at that txid, and taking it again is a no-op.
    expect(dumpFile(ref.path)).toBe(atThree)
    expect((await tenant.snapshot()).path).toBe(ref.path)

    tenant.write((db) => db.run("insert into t values ('c')"))
    const now = tenant.readSync((db) => dump(db))

    const past = await reg.create("acme-at-3", { from: { db: "acme", at: 3n } })
    expect(past.txid).toBe(3n)
    expect(past.readSync((db) => dump(db))).toBe(atThree)
    expect(integrityOk(past.dbPath)).toBe(true)
    // The fork's database file is the whole state: the frames the restore left in its WAL were
    // folded in, so the checksum it was filed under is the checksum of the file.
    expect(past.walBytes).toBe(0)
    expect(past.stats().checksum).toBe(computeFull(past.dbPath, { includeWal: false }).checksum)

    const latest = await reg.create("acme-now", { from: { db: "acme" } })
    expect(latest.txid).toBe(tenant.txid)
    expect(latest.readSync((db) => dump(db))).toBe(now)

    // A fork is a tenant in its own right: writable, with its own log starting after the fork.
    const write = latest.write((db) => db.run("insert into t values ('own')"))
    expect(write.txid).toBe(tenant.txid + 1n)
    expect(latest.log.lastTxid).toBe(write.txid)
    expect(tenant.readSync((db) => dump(db))).toBe(now)
    expect(reg.list().map((row) => row.name).sort()).toEqual(["acme", "acme-at-3", "acme-now"])

    await expect(
      reg.create("acme-future", { from: { db: "acme", at: 99n } }),
    ).rejects.toThrow(/cannot fork/)

    // Reopening a fork agrees with what it was forked at.
    reg.release("acme-at-3")
    const reopened = reg.open("acme-at-3")
    expect(reopened.reconciled).toBe("clean")
    expect(reopened.txid).toBe(3n)
    expect(reopened.write((db) => db.run("insert into t values ('z')")).txid).toBe(4n)
    reg.close()
  })

  test("forks a young tenant with no snapshot from the log alone", async () => {
    const { registry: reg } = registry()
    const tenant = await reg.create("acme")
    tenant.write((db) => db.exec("create table t(v text)"))
    tenant.write((db) => db.run("insert into t values ('a')"))
    const atTwo = tenant.readSync((db) => dump(db))
    tenant.write((db) => db.run("insert into t values ('b')"))

    const past = await reg.create("acme-at-2", { from: { db: "acme", at: 2n } })
    expect(past.txid).toBe(2n)
    expect(past.readSync((db) => dump(db))).toBe(atTwo)
    reg.close()
  })
})
